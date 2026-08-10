import calibration from "@/public/data/ai-calibration.json";
import evaluation from "@/public/data/ai-evaluation.json";

export type AiChunk = {
  start: number;
  end: number;
  wordStart: number;
  wordEnd: number;
  text: string;
  wordCount: number;
  tokenStart?: number;
  tokenEnd?: number;
  tokenCount?: number;
  wasTruncated?: boolean;
};

export type AiScoredChunk = AiChunk & {
  probability: number;
  logOdds: number;
};

export type SimilarityScoreBand = {
  key: "low" | "review" | "high";
  label: "Low" | "Moderate" | "High";
  range: "0–19%" | "20–40%" | "41–100%";
};

export type AiPercentileBand = {
  key: "low" | "review" | "high";
  label: "Below 90th percentile" | "90th–97th percentile" | "98th–100th percentile";
  range: "0–89th" | "90th–97th" | "98th–100th";
};

export type AiReferenceAssessment = {
  key: "consistent" | "within" | "above" | "well-above" | "inconclusive";
  label: "Consistent with human writing" | "Within human range" | "Above typical human range" | "Well above human range" | "Inconclusive";
  detail: string;
  percentile: number | null;
  showPercentile: boolean;
};

export type AiTokenizerAdapter = {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[];
  decode(tokenIds: number[], options?: { skip_special_tokens?: boolean; clean_up_tokenization_spaces?: boolean }): string;
};

const WORD_PATTERN = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;
const REFERENCE_HEADING = /(?:^|\n)\s*(?:references|bibliography|works cited)\s*(?:\n|$)/i;

export const AI_MINIMUM_WORDS = 300;
export const AI_MODEL_ID = "onnx-community/modernbert-ai-detection-raid-mage-ONNX";
export const AI_MODEL_DTYPE = "fp32" as const;
export const AI_MODEL_MAX_TOKENS = 256;
export const AI_CONTENT_TOKENS = 240;
export const AI_TOKEN_STRIDE = 120;
export const AI_INPUT_CONTRACT_VERSION = 3;
export const AI_SCORING_VERSION = 10;
export const AI_REFERENCE_BOUNDARY_MARGIN = 0.05;
export const AI_MODEL_TEMPERATURE = 1.3017339706420898;
export const AI_OFFICIAL_PASSAGE_THRESHOLD = 0.7493773102760315;
export const AI_MODEL_VERSION = "modernbert-raid-mage-onnx-fp32-official-v2";
export const AI_HUMAN_CALIBRATION_READY = Boolean(
  (calibration.humanCalibrationReady ?? calibration.calibrated)
  && calibration.model === AI_MODEL_VERSION,
);
export const AI_HUMAN_REFERENCE_AVAILABLE = Boolean(
  calibration.model === AI_MODEL_VERSION
  && (calibration as { inputContractVersion?: number }).inputContractVersion === AI_INPUT_CONTRACT_VERSION
  && typeof calibration.reviewPassageThreshold === "number"
  && Number.isFinite(calibration.reviewPassageThreshold)
  && typeof calibration.reviewPassageLogOddsThreshold === "number"
  && Number.isFinite(calibration.reviewPassageLogOddsThreshold)
  && (calibration.negativeSetSize ?? 0) > 0,
);
export const AI_POSITIVE_SET_SIZE = evaluation.positiveSetSize ?? 0;
export const AI_POSITIVE_RECALL = evaluation.recall ?? null;
export const AI_POSITIVE_AUC = evaluation.auc ?? null;
export const AI_POSITIVE_VALIDATION_READY = Boolean(
  evaluation.validated
  && evaluation.model === AI_MODEL_VERSION
  && (evaluation as { inputContractVersion?: number }).inputContractVersion === AI_INPUT_CONTRACT_VERSION
  && AI_POSITIVE_SET_SIZE >= evaluation.minimumPositiveDocuments
  && typeof AI_POSITIVE_RECALL === "number"
  && Number.isFinite(AI_POSITIVE_RECALL)
  && typeof AI_POSITIVE_AUC === "number"
  && Number.isFinite(AI_POSITIVE_AUC),
);
export const AI_CALIBRATED = AI_HUMAN_CALIBRATION_READY && AI_POSITIVE_VALIDATION_READY;
export const AI_EXPERIMENTAL = AI_HUMAN_REFERENCE_AVAILABLE && !AI_CALIBRATED;
export const AI_CALIBRATION_STATUS = !AI_HUMAN_CALIBRATION_READY
  ? calibration.calibrationStatus
  : !AI_POSITIVE_VALIDATION_READY
    ? "positive-control-required"
    : "calibrated-positive-and-negative";
export const AI_NEGATIVE_CONTROL_FAILED = AI_CALIBRATION_STATUS === "model-failed-negative-control";
export const AI_BENCHMARK_DOCUMENTS = calibration.humanReferenceBenchmark?.documentCount ?? 0;
export const AI_BENCHMARK_PROXY_RATE_AT_30 = calibration.humanReferenceBenchmark?.proxyFlagRateAtBand?.["30"]?.proxyFlagRate ?? null;
export const AI_REVIEW_PASSAGE_PERCENTILE = calibration.reviewPassagePercentile ?? 90;
export const AI_PASSAGE_THRESHOLD = AI_HUMAN_REFERENCE_AVAILABLE
  ? calibration.reviewPassageThreshold
  : AI_OFFICIAL_PASSAGE_THRESHOLD;
export const AI_PASSAGE_LOG_ODDS_THRESHOLD = AI_HUMAN_REFERENCE_AVAILABLE
  ? calibration.reviewPassageLogOddsThreshold
  : logOddsFromProbability(AI_PASSAGE_THRESHOLD);
export const AI_SUPPRESS_BELOW = calibration.measuredSuppressBelowCandidate ?? calibration.suppressBelow;
export const AI_PERCENTILE_REVIEW_FLOOR = 90;

function numericHumanMedians() {
  return (calibration.perDocument as Array<{ medianLogOdds?: number }>)
    .map((row) => row.medianLogOdds)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
}

function quantile(values: number[], percentile: number) {
  if (!values.length) return null;
  const position = (values.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] * (upper - position) + values[upper] * (position - lower);
}

export const AI_HUMAN_REFERENCE_COUNT = numericHumanMedians().length;
const HUMAN_MEDIANS = numericHumanMedians();
const HUMAN_MEDIAN_MEAN = HUMAN_MEDIANS.length
  ? HUMAN_MEDIANS.reduce((total, value) => total + value, 0) / HUMAN_MEDIANS.length
  : null;
const HUMAN_MEDIAN_STANDARD_DEVIATION = HUMAN_MEDIANS.length > 1 && HUMAN_MEDIAN_MEAN !== null
  ? Math.sqrt(HUMAN_MEDIANS.reduce(
    (total, value) => total + (value - HUMAN_MEDIAN_MEAN) ** 2,
    0,
  ) / (HUMAN_MEDIANS.length - 1))
  : null;
export const AI_HUMAN_REFERENCE_BOUNDARIES = {
  median: quantile(HUMAN_MEDIANS, 0.5),
  upperTypical: quantile(HUMAN_MEDIANS, 0.95),
  maximum: HUMAN_MEDIANS.length ? HUMAN_MEDIANS[HUMAN_MEDIANS.length - 1] : null,
};
export const AI_HUMAN_DISPLAY_NORMALIZATION = {
  median: AI_HUMAN_REFERENCE_BOUNDARIES.median,
  standardDeviation: HUMAN_MEDIAN_STANDARD_DEVIATION,
  reviewAnchor: quantile(HUMAN_MEDIANS, 0.9),
  maximum: AI_HUMAN_REFERENCE_BOUNDARIES.maximum,
};

export function shouldSuppressAiScore(score: number) {
  void score;
  return !AI_HUMAN_REFERENCE_AVAILABLE;
}

export function isAiBelowReviewFloor(score: number) {
  return AI_HUMAN_CALIBRATION_READY && !AI_NEGATIVE_CONTROL_FAILED && score < AI_PERCENTILE_REVIEW_FLOOR;
}

export function similarityScoreBand(score: number): SimilarityScoreBand | null {
  if (!Number.isFinite(score) || score < 0 || score > 100) return null;
  if (score < 20) return { key: "low", label: "Low", range: "0–19%" };
  if (score > 40) return { key: "high", label: "High", range: "41–100%" };
  return { key: "review", label: "Moderate", range: "20–40%" };
}

export function aiPercentileBand(percentile: number): AiPercentileBand | null {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) return null;
  if (percentile < 90) return { key: "low", label: "Below 90th percentile", range: "0–89th" };
  if (percentile < 98) return { key: "review", label: "90th–97th percentile", range: "90th–97th" };
  return { key: "high", label: "98th–100th percentile", range: "98th–100th" };
}

export function assessAiAgainstHumanReference(documentMedianLogOdds: number | null | undefined): AiReferenceAssessment | null {
  if (!AI_HUMAN_REFERENCE_AVAILABLE) return null;
  if (typeof documentMedianLogOdds !== "number" || !Number.isFinite(documentMedianLogOdds)) return null;
  const values = HUMAN_MEDIANS;
  if (!values.length) return null;
  const medianBoundary = AI_HUMAN_REFERENCE_BOUNDARIES.median!;
  const upperTypicalBoundary = AI_HUMAN_REFERENCE_BOUNDARIES.upperTypical!;
  const maximumBoundary = AI_HUMAN_REFERENCE_BOUNDARIES.maximum!;
  const nearBoundary = [medianBoundary, upperTypicalBoundary, maximumBoundary]
    .some((boundary) => Math.abs(documentMedianLogOdds - boundary) <= AI_REFERENCE_BOUNDARY_MARGIN);
  if (nearBoundary) {
    return {
      key: "inconclusive",
      label: "Inconclusive",
      detail: "The document signal is too close to a human-reference boundary for a reliable band.",
      percentile: null,
      showPercentile: false,
    };
  }
  const percentile = populationPercentile(documentMedianLogOdds, values);
  if (documentMedianLogOdds < medianBoundary) {
    return {
      key: "consistent",
      label: "Consistent with human writing",
      detail: "The document signal is below the median of the verified human-reference papers.",
      percentile: null,
      showPercentile: false,
    };
  }
  if (documentMedianLogOdds < upperTypicalBoundary) {
    return {
      key: "within",
      label: "Within human range",
      detail: "The document signal remains within the central human-reference range.",
      percentile: null,
      showPercentile: false,
    };
  }
  if (documentMedianLogOdds <= maximumBoundary) {
    return {
      key: "above",
      label: "Above typical human range",
      detail: "The document signal is elevated relative to the verified human-reference papers.",
      percentile,
      showPercentile: true,
    };
  }
  return {
    key: "well-above",
    label: "Well above human range",
    detail: `The document signal is above all ${values.length} verified human-reference papers.`,
    percentile: 100,
    showPercentile: true,
  };
}

export function formatHumanPercentile(percentile: number) {
  if (!Number.isFinite(percentile)) return "—";
  const rounded = Math.round(percentile * 10) / 10;
  const value = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${value}th`;
}

export function writingSignalEstimate(coveragePercent: number | null | undefined) {
  if (typeof coveragePercent !== "number" || !Number.isFinite(coveragePercent)) return null;
  const aiLike = Math.max(0, Math.min(100, Math.round(coveragePercent)));
  return { aiLike, humanLike: 100 - aiLike };
}

export function buildAiChunks(
  text: string,
  chunkWords = 180,
  maximumChunks = Number.POSITIVE_INFINITY,
  strideWords = Math.max(1, Math.floor(chunkWords / 2)),
): AiChunk[] {
  const referenceStart = text.search(REFERENCE_HEADING);
  const eligibleText = referenceStart >= 0 ? text.slice(0, referenceStart) : text;
  const words = [...eligibleText.matchAll(WORD_PATTERN)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));

  if (words.length === 0) return [];
  const finalStart = Math.max(0, words.length - chunkWords);
  const allStarts: number[] = [];
  for (let wordStart = 0; ; wordStart += strideWords) {
    const bounded = Math.min(wordStart, finalStart);
    allStarts.push(bounded);
    if (bounded >= finalStart) break;
  }
  const starts = allStarts.length <= maximumChunks
    ? allStarts
    : Array.from({ length: maximumChunks }, (_, index) => allStarts[Math.round(
      index * (allStarts.length - 1) / Math.max(1, maximumChunks - 1),
    )]);

  return [...new Set(starts)].map((wordStart) => {
    const wordEnd = Math.min(words.length, wordStart + chunkWords);
    const start = words[wordStart].start;
    const end = words[wordEnd - 1].end;
    return {
      start,
      end,
      wordStart,
      wordEnd,
      text: eligibleText.slice(start, end),
      wordCount: wordEnd - wordStart,
    };
  });
}

export function eligibleAiText(text: string) {
  const referenceStart = text.search(REFERENCE_HEADING);
  return referenceStart >= 0 ? text.slice(0, referenceStart) : text;
}

export function eligibleAiWordCount(text: string) {
  return [...eligibleAiText(text).matchAll(WORD_PATTERN)].length;
}

export function buildAiTokenChunks(
  text: string,
  tokenizer: AiTokenizerAdapter,
  chunkTokens = AI_CONTENT_TOKENS,
  maximumChunks = Number.POSITIVE_INFINITY,
  strideTokens = AI_TOKEN_STRIDE,
): AiChunk[] {
  if (!Number.isInteger(chunkTokens) || chunkTokens < 8 || chunkTokens > AI_MODEL_MAX_TOKENS - 2) {
    throw new Error(`Token chunks must contain between 8 and ${AI_MODEL_MAX_TOKENS - 2} content tokens.`);
  }
  if (!Number.isInteger(strideTokens) || strideTokens < 1 || strideTokens > chunkTokens) {
    throw new Error("Token stride must be a positive integer no larger than the token window.");
  }
  const eligibleText = eligibleAiText(text);
  const tokenIds = tokenizer.encode(eligibleText, { add_special_tokens: false });
  if (!tokenIds.length) return [];
  const finalStart = Math.max(0, tokenIds.length - chunkTokens);
  const allStarts: number[] = [];
  for (let tokenStart = 0; ; tokenStart += strideTokens) {
    const bounded = Math.min(tokenStart, finalStart);
    allStarts.push(bounded);
    if (bounded >= finalStart) break;
  }
  const starts = allStarts.length <= maximumChunks
    ? allStarts
    : Array.from({ length: maximumChunks }, (_, index) => allStarts[Math.round(
      index * (allStarts.length - 1) / Math.max(1, maximumChunks - 1),
    )]);
  return [...new Set(starts)].map((tokenStart) => {
    const tokenEnd = Math.min(tokenIds.length, tokenStart + chunkTokens);
    const chunkIds = tokenIds.slice(tokenStart, tokenEnd);
    const chunkText = tokenizer.decode(chunkIds, {
      skip_special_tokens: true,
      clean_up_tokenization_spaces: true,
    }).trim();
    return {
      start: tokenStart,
      end: tokenEnd,
      wordStart: tokenStart,
      wordEnd: tokenEnd,
      text: chunkText,
      wordCount: [...chunkText.matchAll(WORD_PATTERN)].length,
      tokenStart,
      tokenEnd,
      tokenCount: chunkIds.length,
      wasTruncated: false,
    };
  }).filter((chunk) => chunk.text.length > 0);
}

type AiProbabilityWindow = Pick<AiScoredChunk, "wordStart" | "wordEnd" | "probability">;
type AiLogOddsWindow = Pick<AiScoredChunk, "logOdds">;
type AiLogOddsPositionWindow = Pick<AiScoredChunk, "wordStart" | "wordEnd" | "logOdds">;

export function calculateAiDiagnostics(chunks: AiProbabilityWindow[], threshold = AI_PASSAGE_THRESHOLD) {
  const totalWords = Math.max(0, ...chunks.map((chunk) => chunk.wordEnd));
  const wordProbabilities = Array.from({ length: totalWords }, () => 0);
  chunks.forEach((chunk) => {
    for (let word = chunk.wordStart; word < chunk.wordEnd; word += 1) {
      wordProbabilities[word] = Math.max(wordProbabilities[word], chunk.probability);
    }
  });
  const flaggedWords = wordProbabilities.filter((probability) => probability >= threshold).length;
  const meanProbability = totalWords === 0
    ? 0
    : wordProbabilities.reduce((total, probability) => total + probability, 0) / totalWords;
  return {
    totalWords,
    flaggedWords,
    percentFlagged: totalWords === 0 ? 0 : Math.round((flaggedWords / totalWords) * 100),
    meanProbability: Math.round(meanProbability * 1000) / 1000,
    maxProbability: Math.round(Math.max(0, ...wordProbabilities) * 1000) / 1000,
  };
}

export function calculateAiPercentage(chunks: AiProbabilityWindow[], threshold = AI_PASSAGE_THRESHOLD) {
  return calculateAiDiagnostics(chunks, threshold).percentFlagged;
}

export function isAiPassageFlagged(
  logOdds: number,
  threshold = AI_PASSAGE_LOG_ODDS_THRESHOLD,
) {
  return Number.isFinite(logOdds) && logOdds >= threshold;
}

export function calculateAiLogOddsDiagnostics(
  chunks: AiLogOddsPositionWindow[],
  threshold = AI_PASSAGE_LOG_ODDS_THRESHOLD,
) {
  const totalWords = Math.max(0, ...chunks.map((chunk) => chunk.wordEnd));
  const wordLogOdds = Array.from({ length: totalWords }, () => Number.NEGATIVE_INFINITY);
  chunks.forEach((chunk) => {
    for (let word = chunk.wordStart; word < chunk.wordEnd; word += 1) {
      wordLogOdds[word] = Math.max(wordLogOdds[word], chunk.logOdds);
    }
  });
  const flaggedWords = wordLogOdds.filter((value) => isAiPassageFlagged(value, threshold)).length;
  const wordProbabilities = wordLogOdds.map((value) => Number.isFinite(value) ? probabilityFromLogOdds(value) : 0);
  const meanProbability = totalWords === 0
    ? 0
    : wordProbabilities.reduce((total, probability) => total + probability, 0) / totalWords;
  return {
    totalWords,
    flaggedWords,
    flaggedPassages: chunks.filter((chunk) => isAiPassageFlagged(chunk.logOdds, threshold)).length,
    percentFlagged: totalWords === 0 ? 0 : Math.round((flaggedWords / totalWords) * 100),
    meanProbability: Math.round(meanProbability * 1000) / 1000,
    maxProbability: Math.round(Math.max(0, ...wordProbabilities) * 1000) / 1000,
  };
}

export function calculateTopKMeanLogOdds(chunks: AiLogOddsWindow[], k = 3) {
  if (!Number.isInteger(k) || k <= 0) throw new Error("Top-k must be a positive integer.");
  if (chunks.length === 0) return null;
  const values = chunks
    .map((chunk) => chunk.logOdds)
    .filter(Number.isFinite)
    .sort((a, b) => b - a)
    .slice(0, k);
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function medianLogOdds(chunks: AiLogOddsWindow[]) {
  const values = chunks.map((chunk) => chunk.logOdds).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

export function populationPercentile(score: number, humanScores: number[]) {
  if (humanScores.length === 0) return null;
  const below = humanScores.filter((humanScore) => humanScore < score).length;
  return Math.round((below / humanScores.length) * 1000) / 10;
}

export function calibratedHumanMedianPercentile(documentMedianLogOdds: number) {
  if (!AI_HUMAN_REFERENCE_AVAILABLE) return null;
  return populationPercentile(documentMedianLogOdds, HUMAN_MEDIANS);
}

/**
 * Produces a continuous display score from the document-median log-odds.
 * The score is standardized against the verified-human distribution and uses
 * three observed anchors: human median -> 0, human 90th percentile -> 20, and
 * highest observed human -> 50. Values above every human reference continue
 * linearly to 100. It preserves the underlying ranking and avoids percentile
 * plateaus; it is not a percentage of AI-authored words.
 */
export function calibratedAiDisplaySignal(documentMedianLogOdds: number) {
  if (!AI_HUMAN_REFERENCE_AVAILABLE || !Number.isFinite(documentMedianLogOdds)) return null;
  const { median, standardDeviation, reviewAnchor, maximum } = AI_HUMAN_DISPLAY_NORMALIZATION;
  if (
    typeof median !== "number"
    || typeof standardDeviation !== "number"
    || standardDeviation <= 0
    || typeof reviewAnchor !== "number"
    || typeof maximum !== "number"
    || reviewAnchor <= median
    || maximum <= reviewAnchor
  ) return null;
  const z = (documentMedianLogOdds - median) / standardDeviation;
  const reviewZ = (reviewAnchor - median) / standardDeviation;
  const maximumZ = (maximum - median) / standardDeviation;
  const upperSpan = maximumZ - reviewZ;
  let score: number;
  if (z <= 0) score = 0;
  else if (z < reviewZ) score = Math.round(19 * z / reviewZ);
  else if (z <= maximumZ) score = Math.round(20 + 30 * (z - reviewZ) / upperSpan);
  else score = Math.min(100, 50 + Math.ceil(50 * (z - maximumZ) / upperSpan));
  return {
    score: Math.max(0, Math.min(100, score)),
    z: Math.round(z * 10000) / 10000,
    referencePercentile: populationPercentile(documentMedianLogOdds, HUMAN_MEDIANS),
  };
}

export function machineLogOddsFromLogits(
  logits: ArrayLike<number>,
  temperature = AI_MODEL_TEMPERATURE,
) {
  if (logits.length < 2) return 0;
  if (!Number.isFinite(temperature) || temperature <= 0) {
    throw new Error("AI model temperature must be a positive finite number.");
  }
  return (Number(logits[1]) - Number(logits[0])) / temperature;
}

export function probabilityFromLogOdds(logOdds: number) {
  if (logOdds >= 0) return 1 / (1 + Math.exp(-logOdds));
  const exp = Math.exp(logOdds);
  return exp / (1 + exp);
}

export function logOddsFromProbability(probability: number) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("Probability must be finite and between 0 and 1.");
  }
  if (probability === 0) return Number.NEGATIVE_INFINITY;
  if (probability === 1) return Number.POSITIVE_INFINITY;
  return Math.log(probability / (1 - probability));
}

export function machineProbabilityFromLogits(
  logits: ArrayLike<number>,
  temperature = AI_MODEL_TEMPERATURE,
) {
  return probabilityFromLogOdds(machineLogOddsFromLogits(logits, temperature));
}
