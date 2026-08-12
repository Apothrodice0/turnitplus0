import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AI_LARGE_FILE_THRESHOLD_BYTES,
  AI_MODEL_APPROX_SIZE_MB,
  AiAnalysisCancelledError,
  AiModelProgressTracker,
  aiFirstRunExplainer,
  aiPrepDetailLabel,
  aiPrepStageLabel,
  describeAiAnalysisError,
  formatMegabytes,
  isModelWeightsCached,
} from "../lib/ai-model-prep.ts";

function fakeCacheStorage(entries) {
  return {
    async open() {
      return {
        async keys() {
          return entries.map((entry) => ({ url: entry.url }));
        },
        async match(url) {
          const entry = entries.find((candidate) => candidate.url === url);
          if (!entry) return undefined;
          return {
            headers: { get: (name) => (name === "content-length" ? entry.contentLength ?? null : null) },
          };
        },
      };
    },
  };
}

test("first-run model preparation state: stage order and honest labels when uncached", () => {
  assert.equal(aiPrepStageLabel("preparing"), "Preparing AI detection");
  assert.equal(aiPrepStageLabel("downloading"), "Downloading model");
  assert.equal(aiPrepStageLabel("preparing-detector"), "Preparing detector");
  assert.equal(aiPrepStageLabel("analyzing"), "Analyzing document");
  assert.equal(aiPrepStageLabel("generating-report"), "Generating report");
  assert.equal(aiPrepStageLabel("complete"), "Complete");

  const preparingDetail = aiPrepDetailLabel({ stage: "preparing", cached: false, progress: null });
  assert.match(preparingDetail, /one-time/);

  const explainer = aiFirstRunExplainer();
  assert.equal(explainer.length, 4);
  assert.ok(explainer.some((line) => line.includes(`${AI_MODEL_APPROX_SIZE_MB}MB`)));
  assert.ok(explainer.some((line) => /one-time/i.test(line)));
  assert.ok(explainer.some((line) => /cached/i.test(line)));
});

test("first-run model preparation state: tracker walks initiate -> download -> progress -> done", () => {
  const tracker = new AiModelProgressTracker();
  const largeTotal = AI_LARGE_FILE_THRESHOLD_BYTES * 10;

  assert.equal(tracker.handle({ status: "initiate", file: "onnx/model.onnx" }), null);
  assert.equal(tracker.handle({ status: "download", file: "onnx/model.onnx" }), null);

  const midway = tracker.handle({
    status: "progress",
    file: "onnx/model.onnx",
    loaded: largeTotal / 2,
    total: largeTotal,
  });
  assert.deepEqual(midway, { stage: "downloading", progress: { loaded: largeTotal / 2, total: largeTotal } });

  const finished = tracker.handle({
    status: "progress",
    file: "onnx/model.onnx",
    loaded: largeTotal,
    total: largeTotal,
  });
  assert.deepEqual(finished, { stage: "downloading", progress: { loaded: largeTotal, total: largeTotal } });

  const done = tracker.handle({ status: "done", file: "onnx/model.onnx" });
  assert.deepEqual(done, { stage: "preparing-detector", progress: null });
});

test("first-run model preparation state: small config/tokenizer files never trigger the downloading stage", () => {
  const tracker = new AiModelProgressTracker();
  assert.equal(tracker.handle({ status: "initiate", file: "tokenizer.json" }), null);
  assert.equal(tracker.handle({
    status: "progress",
    file: "tokenizer.json",
    loaded: 2048,
    total: 2048,
  }), null);
  // A "done" for a file that never crossed the large-file threshold must not
  // be mistaken for the model weights finishing.
  assert.equal(tracker.handle({ status: "done", file: "tokenizer.json" }), null);
});

test("no fabricated progress values: an unreliable total that tracks loaded is never reported as determinate", () => {
  const tracker = new AiModelProgressTracker();
  const file = "onnx/model.onnx";

  // This is exactly the shape of @huggingface/transformers' readResponse()
  // fallback when Content-Length is unavailable: `total` is reset to match
  // `loaded` on every single chunk, so it always looks like "100% done".
  const chunk = (loaded) => tracker.handle({ status: "progress", file, loaded, total: loaded });

  // First sighting can't be distinguished from a real, tiny, single-chunk
  // file, so it's trusted (and is below the large-file threshold anyway).
  assert.equal(chunk(65_536), null);

  // The total changed for the same file between two events — the tell-tale
  // sign of the fallback. From here on this file must never be reported as
  // determinate, even once cumulative bytes cross the large-file threshold.
  const midway = chunk(2_000_000);
  assert.equal(midway, null); // still below the large-file threshold

  const overThreshold = chunk(AI_LARGE_FILE_THRESHOLD_BYTES + 500_000);
  assert.deepEqual(overThreshold, { stage: "downloading", progress: null });

  const stillGrowing = chunk(AI_LARGE_FILE_THRESHOLD_BYTES + 20_000_000);
  assert.deepEqual(stillGrowing, { stage: "downloading", progress: null });

  // A later coincidental repeat of the same total must not be trusted again —
  // once caught lying about total, this file stays untrusted for its download.
  const total = AI_LARGE_FILE_THRESHOLD_BYTES + 20_000_000;
  const repeat = tracker.handle({ status: "progress", file, loaded: total, total });
  assert.deepEqual(repeat, { stage: "downloading", progress: null });

  // "done" still fires and still transitions the stage, using loaded (real
  // bytes received) to have identified this as the large file.
  assert.deepEqual(tracker.handle({ status: "done", file }), { stage: "preparing-detector", progress: null });
});

test("no fabricated progress values: missing, zero, negative, or corrupt totals are indeterminate, not 100%", () => {
  const bigLoaded = AI_LARGE_FILE_THRESHOLD_BYTES + 1_000_000;

  assert.deepEqual(
    new AiModelProgressTracker().handle({ status: "progress", file: "onnx/model.onnx", loaded: bigLoaded, total: undefined }),
    { stage: "downloading", progress: null },
  );
  assert.deepEqual(
    new AiModelProgressTracker().handle({ status: "progress", file: "onnx/model.onnx", loaded: bigLoaded, total: 0 }),
    { stage: "downloading", progress: null },
  );
  assert.deepEqual(
    new AiModelProgressTracker().handle({ status: "progress", file: "onnx/model.onnx", loaded: bigLoaded, total: -1 }),
    { stage: "downloading", progress: null },
  );
  assert.deepEqual(
    new AiModelProgressTracker().handle({ status: "progress", file: "onnx/model.onnx", loaded: bigLoaded, total: Number.NaN }),
    { stage: "downloading", progress: null },
  );
  // loaded exceeding total is physically impossible for a real response and
  // must not be trusted either.
  assert.deepEqual(
    new AiModelProgressTracker().handle({ status: "progress", file: "onnx/model.onnx", loaded: bigLoaded, total: bigLoaded - 1 }),
    { stage: "downloading", progress: null },
  );
});

test("no fabricated progress values: a single-event cache-hit total (e.g. Firefox) is still trusted as real determinate progress", () => {
  const tracker = new AiModelProgressTracker();
  const total = AI_LARGE_FILE_THRESHOLD_BYTES + 50_000_000;
  // transformers.js's Firefox-cache-hit path posts exactly one progress event
  // with loaded === total === the full cached buffer length. There is no
  // second event to compare against, and this genuinely is 100% complete, so
  // it must not be suppressed by the unreliable-total guard.
  const result = tracker.handle({ status: "progress", file: "onnx/model.onnx", loaded: total, total });
  assert.deepEqual(result, { stage: "downloading", progress: { loaded: total, total } });
});

test("cached model path: isModelWeightsCached only trusts a real content-length on a matching entry", async () => {
  const modelId = "onnx-community/modernbert-ai-detection-raid-mage-ONNX";

  assert.equal(await isModelWeightsCached(undefined, "transformers-cache", modelId), false);

  const noMatch = fakeCacheStorage([{ url: "https://huggingface.co/some-other-model/resolve/main/config.json", contentLength: "999999999" }]);
  assert.equal(await isModelWeightsCached(noMatch, "transformers-cache", modelId), false);

  const tooSmall = fakeCacheStorage([{ url: `https://huggingface.co/${modelId}/resolve/main/config.json`, contentLength: "512" }]);
  assert.equal(await isModelWeightsCached(tooSmall, "transformers-cache", modelId), false);

  const missingLength = fakeCacheStorage([{ url: `https://huggingface.co/${modelId}/resolve/main/onnx/model.onnx`, contentLength: null }]);
  assert.equal(await isModelWeightsCached(missingLength, "transformers-cache", modelId), false);

  const fullyCached = fakeCacheStorage([
    { url: `https://huggingface.co/${modelId}/resolve/main/tokenizer.json`, contentLength: "2048" },
    { url: `https://huggingface.co/${modelId}/resolve/main/onnx/model.onnx`, contentLength: String(AI_LARGE_FILE_THRESHOLD_BYTES * 20) },
  ]);
  assert.equal(await isModelWeightsCached(fullyCached, "transformers-cache", modelId), true);

  const throwsOnOpen = { open: async () => { throw new Error("cache unavailable"); } };
  assert.equal(await isModelWeightsCached(throwsOnOpen, "transformers-cache", modelId), false);
});

test("cached model path: detail labels drop first-run download messaging when cached", () => {
  const cachedPreparing = aiPrepDetailLabel({ stage: "preparing", cached: true, progress: null });
  assert.doesNotMatch(cachedPreparing, /one-time|download/i);

  const cachedDownloading = aiPrepDetailLabel({ stage: "downloading", cached: true, progress: { loaded: 1, total: 2 } });
  assert.equal(cachedDownloading, "Loading the cached AI model");
  assert.doesNotMatch(cachedDownloading, /%/);
});

test("no fabricated progress values: indeterminate wording used whenever byte totals are unknown or absent", () => {
  const noProgress = aiPrepDetailLabel({ stage: "downloading", cached: false, progress: null });
  assert.doesNotMatch(noProgress, /%/);
  assert.match(noProgress, /Downloading the AI detection model…/);

  const zeroTotal = aiPrepDetailLabel({ stage: "downloading", cached: false, progress: { loaded: 0, total: 0 } });
  assert.doesNotMatch(zeroTotal, /%/);
});

test("no fabricated progress values: real byte counts are surfaced verbatim, never invented", () => {
  const loaded = 314_572_800; // 300MB
  const total = 629_145_600; // 600MB
  const label = aiPrepDetailLabel({ stage: "downloading", cached: false, progress: { loaded, total } });
  assert.match(label, /50%/);
  assert.match(label, /300\.0MB/);
  assert.match(label, /600\.0MB/);
  assert.equal(formatMegabytes(1_048_576), "1.0MB");
});

test("download failure: error messages are honest and distinguish cancellation, download, detector, and analysis failures", () => {
  assert.equal(
    describeAiAnalysisError(new AiAnalysisCancelledError(), "downloading"),
    "AI analysis was cancelled before it finished.",
  );
  assert.match(describeAiAnalysisError(new Error("network down"), "preparing"), /could not be downloaded/);
  assert.match(describeAiAnalysisError(new Error("network down"), "downloading"), /could not be downloaded/);
  assert.match(describeAiAnalysisError(new Error("boom"), "preparing-detector"), /could not be prepared on this device/);
  assert.match(describeAiAnalysisError(new Error("boom"), "analyzing"), /analysis could not be completed/);
  assert.equal(describeAiAnalysisError(new Error("some other failure"), null), "some other failure");
  assert.equal(describeAiAnalysisError("not an error object", null), "The local AI model could not be loaded.");
});

test("existing analysis flow remains intact: worker still emits the untouched per-batch analysis progress and result shape", async () => {
  const worker = await readFile(new URL("../app/ai-detector-worker.ts", import.meta.url), "utf8");
  // Passage-batch progress messages (consumed as the "analyzing" stage by the
  // UI) are unchanged: same shape, same wording, still id-scoped per request.
  assert.match(worker, /type: "progress",\s*\n\s*id: request\.id,\s*\n\s*label: `Checking AI passages/);
  // The analysis result contract (status/score/passages/etc.) is untouched.
  assert.match(worker, /status: "complete" as const/);
  assert.match(worker, /status: "unsupported" as const/);
  assert.match(worker, /passages: passages\.map/);
});

test("cancellation and retry: analyzeAiText's cancellation plumbing survives in page.tsx for the live-generation flow", async () => {
  // The dedicated cancel/retry UI (cancelAiAnalysis, runAiAnalysis,
  // aiPrepState) moved out with the old in-app result view when saved
  // reports became a routable page (app/reports/[id]) that renders AI
  // results read-only from the stored payload. The underlying worker
  // cancellation mechanism analyzeAiText relies on stays in page.tsx,
  // still exercised by the live report-generation flow.
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /let pendingAiReject: \(\(error: Error\) => void\) \| null = null;/);
  assert.match(page, /pendingAiReject = reject;/);
  assert.doesNotMatch(page, /function cancelAiAnalysis\(\)/);
});

test("cancellation and retry: the extracted AiReport/AiPreparationPanel components still accept isRunning/prepState/onRetry/onCancel", async () => {
  // Verifies the capability itself (not just page.tsx wiring, which is
  // intentionally absent for this read-only phase — see the saved-report
  // detail page) is still present in the extracted component, ready for a
  // future phase to wire up live re-analysis on /reports/[id].
  const aiReport = await readFile(new URL("../components/report/ai-report.tsx", import.meta.url), "utf8");
  assert.match(aiReport, /isRunning\?: boolean;/);
  assert.match(aiReport, /prepState\?: AiPrepUpdate \| null;/);
  assert.match(aiReport, /onRetry\?: \(\) => void;/);
  assert.match(aiReport, /onCancel\?: \(\) => void;/);
  assert.match(aiReport, /\{isRunning && <AiPreparationPanel prepState=\{prepState\} onCancel=\{onCancel\} \/>\}/);
});

test("cancellation and retry: the saved-report detail page renders AI results read-only, without live re-analysis wiring", async () => {
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /<AiReport report=\{report\} \/>/);
  assert.doesNotMatch(shell, /isRunning=/);
  assert.doesNotMatch(shell, /onRetry=/);
  assert.doesNotMatch(shell, /onCancel=/);
});

test("accessible and reduced-motion: the preparation panel's animations are disabled under prefers-reduced-motion", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.ai-prep-panel \.ai-analysis-loading > span \{\s*animation: none;/);
  assert.match(css, /\.ai-prep-progress\.indeterminate span \{\s*animation: none;/);
});
