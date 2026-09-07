import type { CorpusAdmissionLimits, CorpusHardGateCode } from "./corpus-admission-types";

/**
 * Release-hardening audit finding WORKER-01 (correction): this logic used to
 * live inside lib/corpus-extraction-worker.ts and was imported by name from
 * there into lib/corpus-text-extraction.ts (which runs in the main server
 * process). That worker file is a `node:worker_threads` entry point — it has
 * a bottom-of-file `if (parentPort) {...}` bootstrap block and pulls in
 * worker-only parsing dependencies (mammoth, the pdfjs Node polyfill) at its
 * own top level. A plain value import from that file, even of an unrelated
 * named export, still evaluates that whole module, dragging worker-only
 * bootstrap code and dependencies into the main server bundle. This module
 * has no worker-thread awareness and no parser dependencies at all, so both
 * lib/corpus-extraction-worker.ts (the worker) and
 * lib/corpus-text-extraction.ts (the main-process orchestrator, which now
 * decodes validated txt candidates inline without spawning a worker) can
 * import it safely, regardless of which process either one runs in.
 */

export const PLAIN_TEXT_EXTRACTOR_VERSION = "plain-text-decode-v1";

export type CorpusExtractionFinalizeResult =
  | { ok: true; rawText: string; extractorVersion: string }
  | { ok: false; reasonCode: CorpusHardGateCode; detail: string };

/**
 * The shared tail every extraction path (the isolated worker's own
 * format-specific branches, and lib/corpus-text-extraction.ts's inline txt
 * bypass) must apply identically — the same empty-result and
 * oversized-content checks, in the same order, producing the same result
 * shape. Factored out so there is exactly one place this logic can drift,
 * rather than two hand-copies quietly diverging over time.
 */
export function finalizeExtractedText(
  rawText: string,
  extractorVersion: string,
  limits: CorpusAdmissionLimits,
): CorpusExtractionFinalizeResult {
  if (rawText.trim().length === 0) {
    return { ok: false, reasonCode: "EXTRACTION_EMPTY_RESULT", detail: "Extraction produced no text." };
  }
  if (rawText.length > limits.maxExtractedChars.value) {
    return { ok: false, reasonCode: "EXTRACTED_CONTENT_TOO_LARGE", detail: `Extracted text is ${rawText.length} characters, exceeding the ${limits.maxExtractedChars.value}-character cap.` };
  }
  return { ok: true, rawText, extractorVersion };
}
