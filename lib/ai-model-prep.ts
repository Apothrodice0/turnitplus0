// Pure, worker-independent logic for the AI detector's first-run model-loading UX.
// Kept separate from app/ai-detector-worker.ts so it can be unit tested without a
// real Worker/browser Cache Storage environment (see tests/ai-model-prep.test.mjs).

export type AiPrepStage =
  | "preparing"
  | "downloading"
  | "preparing-detector"
  | "analyzing"
  | "generating-report"
  | "complete";

export type AiDownloadProgress = { loaded: number; total: number } | null;

export type AiPrepUpdate = {
  stage: AiPrepStage;
  label: string;
  cached: boolean;
  progress: AiDownloadProgress;
};

export const AI_MODEL_APPROX_SIZE_MB = 600;

// transformers.js reports real per-file byte progress (loaded/total) for every
// file it fetches, including small config/tokenizer JSON files. Below this size
// a "download" is over before a human could perceive it, so it's excluded from
// the download stage/progress UI entirely rather than flickering the panel.
export const AI_LARGE_FILE_THRESHOLD_BYTES = 5_000_000;

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function aiPrepStageLabel(stage: AiPrepStage): string {
  switch (stage) {
    case "preparing": return "Preparing AI detection";
    case "downloading": return "Downloading model";
    case "preparing-detector": return "Preparing detector";
    case "analyzing": return "Analyzing document";
    case "generating-report": return "Generating report";
    case "complete": return "Complete";
  }
}

// Shown only while stage is "preparing" or "downloading" and the model was not
// already cached on this device.
export function aiFirstRunExplainer(): string[] {
  return [
    "AI detection is being prepared for this browser.",
    `The detection model is approximately ${AI_MODEL_APPROX_SIZE_MB}MB.`,
    "This is a one-time download on this device.",
    "It will be cached so future checks start instantly.",
  ];
}

export function aiPrepDetailLabel(input: { stage: AiPrepStage; cached: boolean; progress: AiDownloadProgress }): string {
  switch (input.stage) {
    case "preparing":
      return input.cached
        ? "Preparing AI detection"
        : "Preparing AI detection — includes a one-time model download";
    case "downloading": {
      if (input.cached) return "Loading the cached AI model";
      if (!input.progress || input.progress.total <= 0) return "Downloading the AI detection model…";
      const percent = Math.max(0, Math.min(100, Math.round((input.progress.loaded / input.progress.total) * 100)));
      return `Downloading the AI detection model — ${percent}% (${formatMegabytes(input.progress.loaded)} of ${formatMegabytes(input.progress.total)})`;
    }
    case "preparing-detector":
      return "Preparing the AI detector";
    case "analyzing":
      return "Analyzing document";
    case "generating-report":
      return "Generating report";
    case "complete":
      return "Complete";
  }
}

// Raw shape of the object transformers.js passes to progress_callback. Field
// names (status/file/loaded/total) match @huggingface/transformers 4.2.0's
// dispatchCallback call sites in loadResourceFile/readResponse.
export type RawModelProgressEvent = {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
};

export type ModelProgressTransition =
  | { stage: "downloading"; progress: { loaded: number; total: number } | null }
  | { stage: "preparing-detector"; progress: null };

type FileTotalRecord = { lastTotal: number; trustworthy: boolean };

// transformers.js's "done" event carries no size info, so the tracker
// remembers which filename crossed the large-file threshold and treats *that*
// file's "done" as the true "download finished" signal. Small config/tokenizer
// files are otherwise ignored entirely (see AI_LARGE_FILE_THRESHOLD_BYTES).
export class AiModelProgressTracker {
  #largeFile: string | null = null;
  #fileTotals = new Map<string, FileTotalRecord>();

  handle(event: RawModelProgressEvent): ModelProgressTransition | null {
    if (event.status === "progress" && typeof event.file === "string") {
      const loaded = typeof event.loaded === "number" && Number.isFinite(event.loaded) && event.loaded >= 0
        ? event.loaded
        : 0;
      const trustedTotal = this.#trustedTotal(event.file, event.total, loaded);

      if (trustedTotal !== null && trustedTotal >= AI_LARGE_FILE_THRESHOLD_BYTES) {
        this.#largeFile = event.file;
        return { stage: "downloading", progress: { loaded, total: trustedTotal } };
      }
      // The total for this file is missing/invalid/unreliable, but `loaded`
      // is a real running byte count either way (it comes from bytes actually
      // read off the stream, never synthesized). Once that alone is large
      // enough to matter, still surface the stage — just without a percentage.
      if (loaded >= AI_LARGE_FILE_THRESHOLD_BYTES) {
        this.#largeFile = event.file;
        return { stage: "downloading", progress: null };
      }
      return null;
    }
    if (event.status === "done" && event.file === this.#largeFile) {
      this.#largeFile = null;
      this.#fileTotals.delete(event.file);
      return { stage: "preparing-detector", progress: null };
    }
    return null;
  }

  // Returns a trustworthy total for this file, or null. A total is untrusted
  // when it's missing/zero/non-finite/negative, when loaded exceeds it, or
  // when it changes between two events for the *same* file — a legitimate
  // Content-Length-based total is fixed for the life of one file's download,
  // so a change can only mean transformers.js's readResponse() fallback for
  // an unknown length, where `total` is silently reset to match `loaded` on
  // every single chunk (see node_modules/@huggingface/transformers's
  // readResponse). That fallback would otherwise render as a fabricated 100%
  // on every progress event instead of real progress. Once a file is caught
  // doing this, it stays untrusted for the rest of its download rather than
  // flip back to "trustworthy" if a later total happens to coincide.
  #trustedTotal(file: string, total: number | undefined, loaded: number): number | null {
    const previous = this.#fileTotals.get(file);
    const isValid = typeof total === "number" && Number.isFinite(total) && total > 0 && loaded <= total;

    if (!isValid) {
      this.#fileTotals.set(file, { lastTotal: previous?.lastTotal ?? 0, trustworthy: false });
      return null;
    }
    if (previous && (!previous.trustworthy || previous.lastTotal !== total)) {
      this.#fileTotals.set(file, { lastTotal: total, trustworthy: false });
      return null;
    }
    this.#fileTotals.set(file, { lastTotal: total, trustworthy: true });
    return total;
  }
}

export type CacheStorageLike = {
  open(name: string): Promise<{
    keys(): Promise<readonly { url: string }[]>;
    match(url: string): Promise<{ headers: { get(name: string): string | null } } | undefined>;
  }>;
};

// Pre-flight check run before any loading starts, so the UI can decide whether
// to show first-run download messaging at all (requirement: don't show it for
// a model that's already cached). Mirrors what transformers.js's own cache
// lookup does, without depending on its internals: same default cache name
// (env.cacheKey) and the same "does a response for this model exist" question,
// checked via Content-Length so a same-name-but-tiny cached file can't false-positive.
export async function isModelWeightsCached(
  cacheStorage: CacheStorageLike | undefined,
  cacheName: string,
  modelId: string,
  largeFileThresholdBytes: number = AI_LARGE_FILE_THRESHOLD_BYTES,
): Promise<boolean> {
  if (!cacheStorage) return false;
  try {
    const cache = await cacheStorage.open(cacheName);
    const keys = await cache.keys();
    const modelKeys = keys.filter((key) => key.url.includes(modelId));
    for (const key of modelKeys) {
      const response = await cache.match(key.url);
      const length = response?.headers.get("content-length");
      if (length && Number(length) >= largeFileThresholdBytes) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export class AiAnalysisCancelledError extends Error {
  constructor() {
    super("AI analysis was cancelled before it finished.");
    this.name = "AiAnalysisCancelledError";
  }
}

export function describeAiAnalysisError(error: unknown, lastStage: AiPrepStage | null): string {
  if (error instanceof AiAnalysisCancelledError) return error.message;
  if (lastStage === "preparing" || lastStage === "downloading") {
    return "The AI detection model could not be downloaded. Check your connection and try again.";
  }
  if (lastStage === "preparing-detector") {
    return "The AI detector could not be prepared on this device. Try again.";
  }
  if (lastStage === "analyzing") {
    return "The AI analysis could not be completed. Try again.";
  }
  return error instanceof Error ? error.message : "The local AI model could not be loaded.";
}
