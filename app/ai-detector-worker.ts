import { AutoModelForSequenceClassification, AutoTokenizer, env } from "@huggingface/transformers";
import {
  AI_MINIMUM_WORDS,
  AI_MODEL_ID,
  AI_MODEL_DTYPE,
  AI_MODEL_MAX_TOKENS,
  AI_MODEL_VERSION,
  AI_PASSAGE_LOG_ODDS_THRESHOLD,
  AI_PASSAGE_THRESHOLD,
  AI_SCORING_VERSION,
  buildAiTokenChunks,
  calculateAiLogOddsDiagnostics,
  calculateTopKMeanLogOdds,
  calibratedHumanMedianPercentile,
  eligibleAiWordCount,
  isAiPassageFlagged,
  machineLogOddsFromLogits,
  medianLogOdds,
  probabilityFromLogOdds,
  type AiScoredChunk,
} from "@/lib/ai-core";
import {
  AiModelProgressTracker,
  aiPrepDetailLabel,
  isModelWeightsCached,
  type AiDownloadProgress,
  type AiPrepStage,
  type RawModelProgressEvent,
} from "@/lib/ai-model-prep";
import type { DetectedLanguage } from "@/lib/similarity-core";

type WorkerRequest = {
  id: number;
  text: string;
  detectedLanguage: DetectedLanguage;
};

type ModelSignal = { probability: number; logOdds: number };
type TextClassifier = (texts: string[]) => Promise<ModelSignal[]>;

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
let classifierPromise: Promise<{ classify: TextClassifier; tokenizer: Tokenizer; engine: "WebGPU" | "CPU" }> | null = null;

function postPrep(stage: AiPrepStage, cached: boolean, progress: AiDownloadProgress) {
  self.postMessage({
    type: "prep",
    stage,
    label: aiPrepDetailLabel({ stage, cached, progress }),
    cached,
    progress,
  });
}

async function loadClassifier(device: "webgpu" | "wasm", cached: boolean) {
  const tracker = new AiModelProgressTracker();
  const handleModelProgress = (rawProgress: unknown) => {
    if (!rawProgress || typeof rawProgress !== "object") return;
    const transition = tracker.handle(rawProgress as RawModelProgressEvent);
    if (transition) postPrep(transition.stage, cached, transition.progress);
  };
  const tokenizer = await AutoTokenizer.from_pretrained(AI_MODEL_ID, {
    progress_callback: handleModelProgress,
  });
  const model = await AutoModelForSequenceClassification.from_pretrained(AI_MODEL_ID, {
    device,
    dtype: AI_MODEL_DTYPE,
    progress_callback: handleModelProgress,
    // "start the two fixes now" TASK 4: the fp16 ONNX graph for this model
    // fails to initialize under onnxruntime-node's CPU backend with the
    // default graph-optimization pass enabled (a SimplifiedLayerNormFusion
    // graph_utils error, confirmed via tools/validate-ai-fp16.ts before this
    // option was added). Disabling graph optimization is the standard fix
    // for that class of fp16 fusion bug and was confirmed to load and score
    // correctly there; applied here for both device paths defensively,
    // since the equivalent WebGPU/WASM backends could not be verified
    // directly in this environment (no headless-browser tooling available)
    // and this option can only make loading more conservative, never less
    // correct.
    session_options: { graphOptimizationLevel: "disabled" },
  });
  const classify: TextClassifier = async (texts) => {
    const inputs = tokenizer(texts, {
      padding: true,
      truncation: false,
    });
    const sequenceLength = inputs.input_ids.dims.at(-1) ?? 0;
    if (sequenceLength > AI_MODEL_MAX_TOKENS) {
      throw new Error(`Token window exceeded the ${AI_MODEL_MAX_TOKENS}-token model limit.`);
    }
    const output = await model(inputs);
    return texts.map((_, index) => {
      const logOdds = machineLogOddsFromLogits(output.logits.data.slice(index * 2, index * 2 + 2));
      return { logOdds, probability: probabilityFromLogOdds(logOdds) };
    });
  };
  return { classify, tokenizer };
}

async function checkCached() {
  return isModelWeightsCached(
    typeof caches === "undefined" ? undefined : caches,
    env.cacheKey,
    AI_MODEL_ID,
  );
}

async function createClassifier() {
  postPrep("preparing", await checkCached(), null);
  if ("gpu" in self.navigator) {
    try {
      return { ...(await loadClassifier("webgpu", await checkCached())), engine: "WebGPU" as const };
    } catch {
      // Fall through to the CPU/WASM engine below. Re-check cache state: a
      // WebGPU session failure after a successful download would otherwise
      // report this retry as an uncached first-run download when it isn't.
    }
  }
  return { ...(await loadClassifier("wasm", await checkCached())), engine: "CPU" as const };
}

function getClassifier() {
  classifierPromise ??= createClassifier().catch((error) => {
    classifierPromise = null;
    throw error;
  });
  return classifierPromise;
}

async function analyze(request: WorkerRequest) {
  const eligibleWordCount = eligibleAiWordCount(request.text);
  if (request.detectedLanguage !== "English" || eligibleWordCount < AI_MINIMUM_WORDS) {
    return {
      status: "unsupported" as const,
      scoringVersion: AI_SCORING_VERSION,
      score: null,
      model: AI_MODEL_VERSION,
      engine: null,
      threshold: AI_PASSAGE_THRESHOLD,
      thresholdLogOdds: AI_PASSAGE_LOG_ODDS_THRESHOLD,
      eligibleWordCount,
      analyzedWordCount: 0,
      passages: [],
    };
  }

  const { classify, tokenizer, engine } = await getClassifier();
  const chunks = buildAiTokenChunks(request.text, tokenizer);
  const passages: AiScoredChunk[] = [];
  const batchSize = 4;
  for (let index = 0; index < chunks.length; index += batchSize) {
    const batch = chunks.slice(index, index + batchSize);
    self.postMessage({
      type: "progress",
      id: request.id,
      label: `Checking AI passages ${index + 1}–${Math.min(index + batch.length, chunks.length)} of ${chunks.length}`,
    });
    const signals = await classify(batch.map((chunk) => chunk.text));
    batch.forEach((chunk, batchIndex) => passages.push({
      ...chunk,
      probability: Math.max(0, Math.min(1, signals[batchIndex].probability)),
      logOdds: signals[batchIndex].logOdds,
    }));
  }

  const diagnostics = calculateAiLogOddsDiagnostics(passages, AI_PASSAGE_LOG_ODDS_THRESHOLD);
  const documentMedianLogOdds = medianLogOdds(passages);
  const populationPercentile = documentMedianLogOdds === null
    ? null
    : calibratedHumanMedianPercentile(documentMedianLogOdds);
  const flaggedPassageCount = passages.filter((passage) => (
    isAiPassageFlagged(passage.logOdds, AI_PASSAGE_LOG_ODDS_THRESHOLD)
  )).length;
  if ((diagnostics.flaggedWords === 0) !== (flaggedPassageCount === 0)) {
    throw new Error("AI report consistency check failed.");
  }
  return {
    status: "complete" as const,
    scoringVersion: AI_SCORING_VERSION,
    score: populationPercentile,
    coveragePercent: diagnostics.percentFlagged,
    medianLogOdds: documentMedianLogOdds,
    meanProbability: diagnostics.meanProbability,
    maxProbability: diagnostics.maxProbability,
    top3MeanLogOdds: calculateTopKMeanLogOdds(passages, 3),
    flaggedWordCount: diagnostics.flaggedWords,
    flaggedPassageCount,
    populationPercentile,
    model: AI_MODEL_VERSION,
    engine,
    threshold: AI_PASSAGE_THRESHOLD,
    thresholdLogOdds: AI_PASSAGE_LOG_ODDS_THRESHOLD,
    eligibleWordCount,
    analyzedWordCount: eligibleWordCount,
    analyzedTokenCount: diagnostics.totalWords,
    flaggedTokenCount: diagnostics.flaggedWords,
    truncatedPassageCount: passages.filter((passage) => passage.wasTruncated).length,
    passages: passages.map((passage) => ({
      ...passage,
      probability: Math.round(passage.probability * 100000) / 100000,
      logOdds: Math.round(passage.logOdds * 10000) / 10000,
      flagged: isAiPassageFlagged(passage.logOdds, AI_PASSAGE_LOG_ODDS_THRESHOLD),
    })),
  };
}

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  try {
    const result = await analyze(event.data);
    self.postMessage({ id: event.data.id, ok: true, result });
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : "Local AI analysis failed.",
    });
  }
});

export {};
