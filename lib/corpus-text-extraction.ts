import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { CorpusAdmissionLimits, CorpusSupportedFormat } from "./corpus-admission-types";
import { DEFAULT_CORPUS_ADMISSION_LIMITS } from "./corpus-admission-types";
import { finalizeExtractedText, PLAIN_TEXT_EXTRACTOR_VERSION } from "./corpus-extraction-finalize";
import type { CorpusExtractionWorkerRequest, CorpusExtractionWorkerResult } from "./corpus-extraction-worker";

/**
 * Orchestrates lib/corpus-extraction-worker.ts inside an isolated
 * node:worker_threads Worker — this module no longer parses anything
 * itself (requirement 5). Confirmed empirically (a throwaway smoke test
 * during implementation, not assumed) that this project's Node version
 * (>=22.13.0 <23) together with its existing `node --import tsx` test/build
 * invocation propagates tsx's loader hook to Worker threads created
 * afterward, so the worker file loads as plain .ts exactly like every other
 * module in this codebase — and that worker.terminate() genuinely halts a
 * hard synchronous busy-loop worker (~5ms after being called), unlike a
 * same-thread Promise.race, which can only stop *waiting*, never stop the
 * abandoned computation itself.
 *
 * Library-level worker-concurrency limit (added after the verification
 * pass observed full-test-suite resource contention from unbounded
 * concurrent Worker creation): a module-level counting semaphore bounds
 * how many isolated extraction Workers may be alive at once, enforced here
 * regardless of caller — a test file, the CLI, or lib/corpus-admission-gate.ts
 * calling this directly all share the same real OS thread budget, so the
 * limit has to live where the Worker is actually spawned, not just in one
 * caller's own orchestration (tools/corpus-admission-dry-run.ts's
 * cliMaxConcurrency bounds end-to-end candidate processing, a different,
 * higher-level concern).
 */

export const CORPUS_TEXT_EXTRACTION_ORCHESTRATOR_VERSION = "corpus-text-extraction-orchestrator-v1";

export type CorpusExtractionResult = CorpusExtractionWorkerResult;

const WORKER_SCRIPT_PATH = fileURLToPath(new URL("./corpus-extraction-worker.ts", import.meta.url));

// --- library-level worker-concurrency semaphore -----------------------------

let activeWorkerCount = 0;
const waitQueue: Array<{ limit: number; resolve: () => void }> = [];

function drainWorkerQueue(): void {
  for (let i = 0; i < waitQueue.length; i += 1) {
    if (activeWorkerCount < waitQueue[i].limit) {
      const entry = waitQueue.splice(i, 1)[0];
      activeWorkerCount += 1;
      entry.resolve();
      i = -1; // state changed — rescan from the front (still-FIFO among satisfiable entries)
    }
  }
}

function acquireExtractionWorkerSlot(limit: number): Promise<void> {
  if (activeWorkerCount < limit) {
    activeWorkerCount += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push({ limit, resolve });
  });
}

function releaseExtractionWorkerSlot(): void {
  activeWorkerCount = Math.max(0, activeWorkerCount - 1);
  drainWorkerQueue();
}

/** Test-only introspection — the current number of live isolated extraction workers, to verify the configured limit is never exceeded under real concurrent load. */
export function _getActiveExtractionWorkerCountForTesting(): number {
  return activeWorkerCount;
}

// --- single-worker lifecycle (unchanged in spirit from before this limit was added) ---

async function runExtractionWorker(
  format: CorpusSupportedFormat,
  bytes: Buffer,
  limits: CorpusAdmissionLimits,
): Promise<CorpusExtractionResult> {
  return new Promise<CorpusExtractionResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (result: CorpusExtractionResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    // Never let this executor throw — a synchronous Worker-construction
    // failure (e.g. resource exhaustion under heavy concurrent load, such
    // as many test files spawning worker threads at once) would otherwise
    // make the returned promise REJECT instead of resolving with a
    // structured failure, breaking this function's "never throws"
    // contract and crashing callers that only expect a result object.
    try {
      const request: CorpusExtractionWorkerRequest = { format, bytes, limits };
      const worker = new Worker(WORKER_SCRIPT_PATH, {
        workerData: request,
        resourceLimits: {
          maxOldGenerationSizeMb: limits.extractionWorkerMaxOldGenerationMb.value,
          maxYoungGenerationSizeMb: limits.extractionWorkerMaxYoungGenerationMb.value,
        },
      });

      timer = setTimeout(() => {
        settle({ ok: false, reasonCode: "EXTRACTION_TIMEOUT", detail: `Extraction exceeded the ${limits.extractionTimeoutMs.value}ms hard timeout and was terminated.` });
        void worker.terminate();
      }, limits.extractionTimeoutMs.value);
      timer.unref();

      worker.once("message", (result: CorpusExtractionResult) => {
        settle(result);
        void worker.terminate();
      });
      worker.once("error", (err) => {
        settle({ ok: false, reasonCode: "EXTRACTION_WORKER_TERMINATED", detail: err instanceof Error ? err.message : String(err) });
      });
      worker.once("exit", (code) => {
        if (!settled && code !== 0) {
          settle({ ok: false, reasonCode: "EXTRACTION_WORKER_TERMINATED", detail: `Extraction worker exited with code ${code} before returning a result.` });
        }
      });
    } catch (err) {
      settle({ ok: false, reasonCode: "EXTRACTION_WORKER_TERMINATED", detail: `Failed to start the isolated extraction worker: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}

/**
 * Release-hardening audit finding WORKER-01: `new Worker(WORKER_SCRIPT_PATH,
 * ...)` above cannot load in a deployed Vercel serverless function — Next.js
 * copies the referenced file into the build as a static asset (recognizing
 * the `new Worker(new URL(...))` pattern) but copies it byte-for-byte as raw,
 * untranspiled TypeScript, which a bare Node runtime with no tsx loader
 * cannot parse. Confirmed live: Preview runtime logs for this exact bug show
 * `Failed to load the ES module: /var/task/.next/server/assets/
 * corpus-extraction-worker.<hash>.ts` — every format sharing that one
 * worker script fails identically, since it fails at the worker's own
 * top-level imports before any format-specific branch ever runs. This is a
 * bundling/runtime defect in how the WORKER FILE ITSELF loads — it says
 * nothing about whether pdfjs/mammoth are safe to import in the main
 * thread (they already are: lib/pdf-text-extraction.ts and
 * lib/docx-text-extraction.ts are imported directly by the ordinary,
 * non-corpus report-checking pipeline today).
 *
 * Correction: finalizeExtractedText/PLAIN_TEXT_EXTRACTOR_VERSION are
 * imported here from lib/corpus-extraction-finalize.ts, a small neutral
 * module with no worker-thread awareness and no parser dependencies — never
 * from lib/corpus-extraction-worker.ts directly. That file is itself a
 * `node:worker_threads` entry point (a bottom-of-file `if (parentPort)
 * {...}` bootstrap block, plus mammoth/pdfjs-node-polyfill imports at its
 * own top level); a plain value import of even one unrelated named export
 * from it would still evaluate that whole module and drag worker-only
 * bootstrap code and dependencies into this main-process module's bundle.
 * The `import type {...}` below, by contrast, is erased entirely at compile
 * time and pulls in nothing at runtime.
 *
 * `format` here is always the caller's already-validated classification
 * (lib/corpus-file-validation.ts's validateCorpusCandidateFile — magic-byte
 * signature checked, dangerous-signature blocklist checked, ZIP-disguised-
 * as-text checked), never a raw claimed filename/extension on its own — see
 * that file's own header comment. A `.txt`-labeled file that is actually an
 * executable or a disguised archive is rejected by that validator before
 * this function is ever called, exactly as it always was; this bypass only
 * ever runs for a candidate already proven to deserve `format === "txt"`.
 *
 * Only `txt` bypasses the worker. `runCorpusExtraction`'s own txt branch
 * (lib/corpus-extraction-worker.ts) is `bytes.toString("utf8")` — a decode,
 * not a parse, with no third-party library and nothing for OS-thread-level
 * worker isolation to contain — replicated here via the exact same shared
 * finalizeExtractedText tail, so the two can never diverge on the
 * empty-result/oversized-content checks or the result shape. PDF, DOCX, and
 * HTML still need genuine untrusted-parser isolation (pdfjs, mammoth, a
 * hand-rolled HTML stripper) and are UNCHANGED — they still go through
 * runExtractionWorker below, worker-bundling defect and all; fixing that is
 * a separate, larger change this fix deliberately does not attempt.
 */
export async function extractCorpusCandidateText(
  format: CorpusSupportedFormat,
  bytes: Buffer,
  limits: CorpusAdmissionLimits = DEFAULT_CORPUS_ADMISSION_LIMITS,
): Promise<CorpusExtractionResult> {
  if (format === "txt") {
    // Buffer.from(...) re-wrap (not bytes.toString(...) directly), matching
    // lib/corpus-extraction-worker.ts's own working `const bytes =
    // Buffer.from(request.bytes)` pattern — a pre-existing, project-wide
    // ambient-type quirk (unrelated to this fix's own logic; reproduced by
    // ANY file calling an explicitly `: Buffer`-annotated parameter's own
    // .toString(encoding) directly) otherwise resolves the encoding
    // overload incorrectly.
    const decoded = Buffer.from(bytes).toString("utf8");
    return finalizeExtractedText(decoded, PLAIN_TEXT_EXTRACTOR_VERSION, limits);
  }

  await acquireExtractionWorkerSlot(limits.extractionWorkerConcurrencyLimit.value);
  try {
    return await runExtractionWorker(format, bytes, limits);
  } finally {
    releaseExtractionWorkerSlot();
  }
}
