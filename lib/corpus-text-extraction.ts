import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { CorpusAdmissionLimits, CorpusSupportedFormat } from "./corpus-admission-types";
import { DEFAULT_CORPUS_ADMISSION_LIMITS } from "./corpus-admission-types";
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

export async function extractCorpusCandidateText(
  format: CorpusSupportedFormat,
  bytes: Buffer,
  limits: CorpusAdmissionLimits = DEFAULT_CORPUS_ADMISSION_LIMITS,
): Promise<CorpusExtractionResult> {
  await acquireExtractionWorkerSlot(limits.extractionWorkerConcurrencyLimit.value);
  try {
    return await runExtractionWorker(format, bytes, limits);
  } finally {
    releaseExtractionWorkerSlot();
  }
}
