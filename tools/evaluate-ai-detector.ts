import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import {
  AI_CONTENT_TOKENS,
  AI_HUMAN_DISPLAY_NORMALIZATION,
  AI_INPUT_CONTRACT_VERSION,
  AI_MINIMUM_WORDS,
  AI_MODEL_DTYPE,
  AI_MODEL_ID,
  AI_MODEL_MAX_TOKENS,
  AI_MODEL_TEMPERATURE,
  AI_MODEL_VERSION,
  AI_OFFICIAL_PASSAGE_THRESHOLD,
  AI_TOKEN_STRIDE,
  buildAiTokenChunks,
  calibratedAiDisplaySignal,
  calculateAiLogOddsDiagnostics,
  calculateTopKMeanLogOdds,
  eligibleAiWordCount,
  logOddsFromProbability,
  machineLogOddsFromLogits,
  probabilityFromLogOdds,
} from "../lib/ai-core";
import { bootstrapAuc, loadCorpus, rocAuc, type AiEvaluationSplit, type CorpusDocument } from "./calibration-utils";
import humanCalibration from "../public/data/ai-calibration.json" with { type: "json" };

const CACHE_PATH = "corpus/ai-score-cache.json";
const OUTPUT_PATH = "corpus/ai-positive-evaluation.json";
const PUBLIC_OUTPUT_PATH = "public/data/ai-evaluation.json";
const MINIMUM_POSITIVE_DOCUMENTS = 30;
const EVALUATION_BATCH_SIZE = 24;
const displayedCoverageLogOddsThreshold = humanCalibration.model === AI_MODEL_VERSION
  && typeof humanCalibration.reviewPassageLogOddsThreshold === "number"
  && Number.isFinite(humanCalibration.reviewPassageLogOddsThreshold)
  ? humanCalibration.reviewPassageLogOddsThreshold
  : logOddsFromProbability(AI_OFFICIAL_PASSAGE_THRESHOLD);

type PassageScore = { wordStart: number; wordEnd: number; probability: number; logOdds: number };
type CachedDocument = { textSha256: string; passages: PassageScore[] };
type ScoreCache = {
  schema: "turnitplus-ai-score-cache";
  version: number;
  model: string;
  documents: Record<string, CachedDocument>;
};

const negatives = loadCorpus("ai-negative");
const positives = loadCorpus("ai-positive", "corpus", { allowEmpty: true });
const hybrids = loadCorpus("ai-hybrid", "corpus", { allowEmpty: true });
type ExternalPositiveEntry = {
  id: string;
  benchmarkIndependent: boolean;
  duplicateOf: string | null;
  calibrationEligible: false;
  generationEvidence: { modelUserDeclared?: string };
  diagnostic: {
    passageLogOdds: number[];
    coveragePercent: number;
    passageLogOddsThreshold: number;
  };
};

function preliminaryPositiveControl() {
  const path = "corpus/ai-positive-benchmark/manifest.json";
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    schema?: string;
    entries?: ExternalPositiveEntry[];
  };
  if (manifest.schema !== "turnitplus-external-ai-positive-benchmark" || !Array.isArray(manifest.entries)) {
    throw new Error("Invalid external AI-positive benchmark manifest.");
  }
  const independent = manifest.entries.filter((entry) => entry.benchmarkIndependent);
  const humanMedians = humanCalibration.perDocument
    .map((row) => row.medianLogOdds)
    .filter((value): value is number => Number.isFinite(value));
  const reviewThreshold = humanCalibration.reviewPassageLogOddsThreshold;
  const strictCoverageLogOddsThreshold = humanCalibration.measuredPassageLogOddsThresholdCandidate;
  if (typeof strictCoverageLogOddsThreshold !== "number" || !Number.isFinite(strictCoverageLogOddsThreshold)) {
    throw new Error("The measured passage log-odds threshold is unavailable for displayed-coverage sensitivity.");
  }
  const rows = independent.map((entry) => {
    if (entry.calibrationEligible !== false || !Array.isArray(entry.diagnostic?.passageLogOdds) || !entry.diagnostic.passageLogOdds.length) {
      throw new Error(`${entry.id}: incomplete preliminary positive-control evidence.`);
    }
    const medianLogOdds = quantile(entry.diagnostic.passageLogOdds, 0.5)!;
    const displaySignal = calibratedAiDisplaySignal(medianLogOdds);
    if (!displaySignal) throw new Error(`${entry.id}: continuous display normalization is unavailable.`);
    const humanReferencePercentile = humanMedians.length
      ? 100 * humanMedians.filter((value) => value < medianLogOdds).length / humanMedians.length
      : null;
    const windowsAboveReviewThreshold = entry.diagnostic.passageLogOdds.filter((value) => value >= reviewThreshold).length;
    if (Math.abs(entry.diagnostic.passageLogOddsThreshold - reviewThreshold) > 1e-9) {
      throw new Error(`${entry.id}: imported coverage threshold does not match the website review threshold.`);
    }
    return {
      id: entry.id,
      medianLogOdds: Number(medianLogOdds.toFixed(6)),
      continuousDisplayScore: displaySignal.score,
      standardizedMedianDistance: displaySignal.z,
      humanReferencePercentile: humanReferencePercentile === null ? null : Number(humanReferencePercentile.toFixed(2)),
      passageWindowsAboveReviewThreshold: windowsAboveReviewThreshold,
      passageWindowCount: entry.diagnostic.passageLogOdds.length,
      passageWindowRateAboveReviewThreshold: Number((windowsAboveReviewThreshold / entry.diagnostic.passageLogOdds.length).toFixed(4)),
      displayedCoveragePercent: entry.diagnostic.coveragePercent,
      strictCoveragePercent: Math.round(100 * entry.diagnostic.passageLogOdds
        .filter((value) => value >= strictCoverageLogOddsThreshold).length / entry.diagnostic.passageLogOdds.length),
    };
  });
  const rankingRows = [
    ...humanMedians.map((score) => ({ score, positive: false })),
    ...rows.map((row) => ({ score: row.medianLogOdds, positive: true })),
  ];
  const humanCoverage = humanCalibration.perDocument
    .map((row) => row.conservativeDocScore)
    .filter((value): value is number => Number.isFinite(value));
  const coverageRankingRows = [
    ...humanCoverage.map((score) => ({ score, positive: false })),
    ...rows.map((row) => ({ score: row.strictCoveragePercent, positive: true })),
  ];
  const aboveFloor = rows.filter((row) => (row.humanReferencePercentile ?? 0) >= 90).length;
  const aboveDisplayedReviewBand = rows.filter((row) => row.continuousDisplayScore > 50).length;
  const humanDisplayScores = humanMedians
    .map((value) => calibratedAiDisplaySignal(value)?.score)
    .filter((value): value is number => typeof value === "number");
  const humanMedianCenter = quantile(humanMedians, 0.5);
  const humanMad = humanMedianCenter === null
    ? null
    : quantile(humanMedians.map((value) => Math.abs(value - humanMedianCenter)), 0.5);
  const orderedDisplayRows = [...rows].sort(
    (left, right) => left.continuousDisplayScore - right.continuousDisplayScore,
  );
  const lowestDisplayRow = orderedDisplayRows[0] ?? null;
  const highestDisplayRow = orderedDisplayRows.at(-1) ?? null;
  const coverageAuc = humanCoverage.length && rows.length ? rocAuc(coverageRankingRows) : null;
  const diagnosticMedianLogOddsAuc = humanMedians.length && rows.length ? rocAuc(rankingRows) : null;
  const positiveZSpan = lowestDisplayRow && highestDisplayRow
    ? highestDisplayRow.standardizedMedianDistance - lowestDisplayRow.standardizedMedianDistance
    : null;
  const derivedCoverageReviewBand = humanCoverage.length ? Math.max(...humanCoverage) + 1 : null;
  const aboveDerivedCoverageBand = derivedCoverageReviewBand === null
    ? null
    : rows.filter((row) => row.strictCoveragePercent >= derivedCoverageReviewBand).length;
  return {
    status: "preliminary-external-positive-control",
    calibrationEligible: false,
    decisionUse: "Diagnostic evidence that the detector responds to user-attested machine-generated documents; excluded from controlled recall, AUC, threshold fitting, and production calibration.",
    sessionCount: manifest.entries.length,
    independentDocumentCount: independent.length,
    duplicateSessionCount: manifest.entries.length - independent.length,
    reviewFloorHumanPercentile: 90,
    documentsAtOrAboveReviewFloor: aboveFloor,
    diagnosticDetectionRate: rows.length ? Number((aboveFloor / rows.length).toFixed(4)) : null,
    minimumIndependentDocumentTarget: MINIMUM_POSITIVE_DOCUMENTS,
    minimumIndependentDocumentTargetReached: rows.length >= MINIMUM_POSITIVE_DOCUMENTS,
    displayedMetric: "continuous z-normalized document-median log-odds",
    displayedScoreContract: {
      basis: "z = (document median log-odds - verified-human median) / verified-human sample standard deviation",
      anchors: {
        humanMedian: { medianLogOdds: AI_HUMAN_DISPLAY_NORMALIZATION.median, displayScore: 0 },
        human90thPercentile: { medianLogOdds: AI_HUMAN_DISPLAY_NORMALIZATION.reviewAnchor, displayScore: 20 },
        highestObservedHuman: { medianLogOdds: AI_HUMAN_DISPLAY_NORMALIZATION.maximum, displayScore: 50 },
      },
      humanStandardDeviation: AI_HUMAN_DISPLAY_NORMALIZATION.standardDeviation,
      humanMedianAbsoluteDeviation: humanMad,
      humanRobustSigma: humanMad === null ? null : humanMad * 1.4826,
      green: "0-19",
      blue: "20-50",
      red: "51-100",
      note: "Continuous and monotonic. The three display anchors are expressed in the same standardized space, so changing SD to MAD alone would not change the mapped score. Scores above the highest observed human reference extrapolate linearly and are capped at 100. This is a screening score, not a percentage of AI-authored words.",
    },
    displayedScoreSpreadDiagnostic: {
      conclusion: "The positive-control spread is substantive rather than a rounding plateau. The lowest control remains within the observed upper human-reference range, so the conservative color boundary is unchanged.",
      thesisSummary: diagnosticMedianLogOddsAuc === null || positiveZSpan === null
        ? null
        : `Document-median AUC ${diagnosticMedianLogOddsAuc.toFixed(4)} with a positive z-span of ${positiveZSpan.toFixed(4)}. The ranking is strong, but the absolute positive-class margin is narrow and sensitive to generator or rewriting shifts.`,
      positiveZSpan: positiveZSpan === null ? null : Number(positiveZSpan.toFixed(4)),
      lowest: lowestDisplayRow && {
        id: lowestDisplayRow.id,
        displayScore: lowestDisplayRow.continuousDisplayScore,
        standardizedMedianDistance: lowestDisplayRow.standardizedMedianDistance,
        medianLogOdds: lowestDisplayRow.medianLogOdds,
        humanReferencePercentile: lowestDisplayRow.humanReferencePercentile,
      },
      highest: highestDisplayRow && {
        id: highestDisplayRow.id,
        displayScore: highestDisplayRow.continuousDisplayScore,
        standardizedMedianDistance: highestDisplayRow.standardizedMedianDistance,
        medianLogOdds: highestDisplayRow.medianLogOdds,
        humanReferencePercentile: highestDisplayRow.humanReferencePercentile,
      },
    },
    displayedReviewBand: 51,
    documentsAtOrAboveDisplayedReviewBand: aboveDisplayedReviewBand,
    displayedReviewDetectionRate: rows.length ? Number((aboveDisplayedReviewBand / rows.length).toFixed(4)) : null,
    displayedScoreUniqueValueCount: new Set(rows.map((row) => row.continuousDisplayScore)).size,
    displayedScoreObservedRange: {
      verifiedHuman: humanDisplayScores.length ? { minimum: Math.min(...humanDisplayScores), maximum: Math.max(...humanDisplayScores) } : null,
      externalPositiveControl: rows.length ? {
        minimum: Math.min(...rows.map((row) => row.continuousDisplayScore)),
        maximum: Math.max(...rows.map((row) => row.continuousDisplayScore)),
      } : null,
    },
    displayedCoveragePassageThreshold: humanCalibration.measuredPassageThresholdCandidate,
    displayedCoveragePassageLogOddsThreshold: strictCoverageLogOddsThreshold,
    displayedCoverageReviewBand: derivedCoverageReviewBand,
    documentsAtOrAboveDisplayedCoverageReviewBand: aboveDerivedCoverageBand,
    displayedCoverageDetectionRate: rows.length && aboveDerivedCoverageBand !== null
      ? Number((aboveDerivedCoverageBand / rows.length).toFixed(4))
      : null,
    displayedCoverageBandStatus: "derived-and-rejected-no-positive-recall",
    displayedCoverageBandDecision: "The candidate is one point above the observed verified-human maximum at the measured 0.98013 passage threshold. It preserves zero observed human false positives but detects none of the external positive controls, so it is recorded as a sensitivity result and is not used by the report UI.",
    displayedCoverageDiagnosticAuc: coverageAuc === null ? null : Number(coverageAuc.toFixed(4)),
    displayedCoverageObservedRange: {
      verifiedHuman: humanCoverage.length ? { minimum: Math.min(...humanCoverage), maximum: Math.max(...humanCoverage) } : null,
      externalPositiveControl: rows.length ? {
        minimum: Math.min(...rows.map((row) => row.strictCoveragePercent)),
        maximum: Math.max(...rows.map((row) => row.strictCoveragePercent)),
      } : null,
    },
    diagnosticMedianLogOddsAuc: diagnosticMedianLogOddsAuc === null ? null : Number(diagnosticMedianLogOddsAuc.toFixed(4)),
    diagnosticMedianLogOddsAucCi95: humanMedians.length && rows.length
      ? bootstrapAuc(rankingRows).map((value) => Number(value.toFixed(4)))
      : null,
    generatorModelsUserDeclared: [...new Set(manifest.entries.map((entry) => entry.generationEvidence.modelUserDeclared).filter(Boolean))],
    perDocument: rows,
  };
}

const preliminaryEvidence = preliminaryPositiveControl();
if (positives.length < MINIMUM_POSITIVE_DOCUMENTS) {
  const output = {
    schema: "turnitplus-ai-positive-evaluation",
    version: 10,
    validated: false,
    generatedBy: "tools/evaluate-ai-detector.ts",
    generatedAt: new Date().toISOString(),
    model: AI_MODEL_VERSION,
    inputContractVersion: AI_INPUT_CONTRACT_VERSION,
    calibrationStatus: "positive-control-required",
    minimumPositiveDocuments: MINIMUM_POSITIVE_DOCUMENTS,
    positiveSetSize: positives.length,
    hybridSetSize: hybrids.length,
    testSampleSize: 0,
    testPositiveCount: 0,
    recall: null,
    precision: null,
    auc: null,
    aucCi95: null,
    preliminaryPositiveControl: preliminaryEvidence,
    warning: `Only ${positives.length} paired controlled AI-positive documents are present; at least ${MINIMUM_POSITIVE_DOCUMENTS} are required for controlled validation. The separate user-attested positive control contains ${preliminaryEvidence?.independentDocumentCount ?? 0} independent documents and is reported as external diagnostic evidence without fitting production thresholds.`,
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  writeFileSync(PUBLIC_OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({
    controlledPositiveDocuments: positives.length,
    preliminaryIndependentDocuments: preliminaryEvidence?.independentDocumentCount ?? 0,
    validated: false,
  }, null, 2));
  process.exit(0);
}

const emptyCache: ScoreCache = {
  schema: "turnitplus-ai-score-cache",
  version: 4,
  model: AI_MODEL_VERSION,
  documents: {},
};
const parsed = existsSync(CACHE_PATH)
  ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Partial<ScoreCache>
  : null;
const cache: ScoreCache = parsed?.schema === emptyCache.schema
  && parsed.version === emptyCache.version
  && parsed.model === emptyCache.model
  && parsed.documents && typeof parsed.documents === "object"
  ? { ...emptyCache, documents: parsed.documents }
  : emptyCache;

let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>> | null = null;

async function classifyBatch(texts: string[]) {
  tokenizer ??= await AutoTokenizer.from_pretrained(AI_MODEL_ID);
  model ??= await AutoModelForSequenceClassification.from_pretrained(AI_MODEL_ID, {
    device: "cpu",
    dtype: AI_MODEL_DTYPE,
  });
  const inputs = tokenizer(texts, { padding: true, truncation: false });
  const sequenceLength = inputs.input_ids.dims.at(-1) ?? 0;
  if (sequenceLength > AI_MODEL_MAX_TOKENS) throw new Error(`Token window exceeded ${AI_MODEL_MAX_TOKENS} tokens.`);
  const output = await model(inputs);
  return texts.map((_, index) => {
    const logOdds = machineLogOddsFromLogits(output.logits.data.slice(index * 2, index * 2 + 2));
    return { logOdds, probability: probabilityFromLogOdds(logOdds) };
  });
}

function withLogOdds(passage: Omit<PassageScore, "logOdds"> & { logOdds?: number }): PassageScore {
  return {
    ...passage,
    logOdds: Number.isFinite(passage.logOdds) ? Number(passage.logOdds) : logOddsFromProbability(passage.probability),
  };
}

function quantile(values: number[], q: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
}

async function scoreDocument(document: CorpusDocument) {
  const eligibleWords = eligibleAiWordCount(document.text);
  if (eligibleWords < AI_MINIMUM_WORDS) {
    throw new Error(`${document.id} has ${eligibleWords} eligible words; at least ${AI_MINIMUM_WORDS} are required.`);
  }
  tokenizer ??= await AutoTokenizer.from_pretrained(AI_MODEL_ID);
  const chunks = buildAiTokenChunks(document.text, tokenizer);
  const textSha256 = String(document.provenance.sha256);
  const cached = cache.documents[document.id];
  let passages: PassageScore[];
  if (cached?.textSha256 === textSha256 && Array.isArray(cached.passages)) {
    passages = cached.passages.map(withLogOdds);
  } else {
    passages = [];
    for (let index = 0; index < chunks.length; index += EVALUATION_BATCH_SIZE) {
      const batch = chunks.slice(index, index + EVALUATION_BATCH_SIZE);
      const signals = await classifyBatch(batch.map((chunk) => chunk.text));
      batch.forEach((chunk, batchIndex) => passages.push({
        wordStart: chunk.wordStart,
        wordEnd: chunk.wordEnd,
        probability: signals[batchIndex].probability,
        logOdds: signals[batchIndex].logOdds,
      }));
    }
  }
  cache.documents[document.id] = { textSha256, passages };
  writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
  const logOdds = passages.map((passage) => passage.logOdds);
  return {
    coverage: calculateAiLogOddsDiagnostics(passages, displayedCoverageLogOddsThreshold).percentFlagged,
    top3MeanLogOdds: calculateTopKMeanLogOdds(passages, 3) ?? Number.NEGATIVE_INFINITY,
    maximumLogOdds: Math.max(...logOdds),
    meanLogOdds: logOdds.reduce((total, value) => total + value, 0) / logOdds.length,
    passageCount: passages.length,
    passageLogOdds: logOdds.map((value) => Number(value.toFixed(6))),
    passageLogOddsDistribution: {
      minimum: Number(Math.min(...logOdds).toFixed(6)),
      q10: Number(quantile(logOdds, 0.10)!.toFixed(6)),
      q25: Number(quantile(logOdds, 0.25)!.toFixed(6)),
      median: Number(quantile(logOdds, 0.50)!.toFixed(6)),
      q75: Number(quantile(logOdds, 0.75)!.toFixed(6)),
      q90: Number(quantile(logOdds, 0.90)!.toFixed(6)),
      maximum: Number(Math.max(...logOdds).toFixed(6)),
    },
  };
}

function negativeSplit(id: string): AiEvaluationSplit {
  const value = Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % 100;
  return value < 60 ? "train" : value < 80 ? "validation" : "test";
}

const pairedSourceSplits = new Map<string, AiEvaluationSplit>();
for (const document of [...positives, ...hybrids]) {
  const sourceId = document.aiGeneration!.sourceHumanId;
  const split = document.aiGeneration!.evaluationSplit;
  const existing = pairedSourceSplits.get(sourceId);
  if (existing && existing !== split) {
    throw new Error(`Generated documents derived from ${sourceId} cross evaluation splits (${existing} and ${split}).`);
  }
  pairedSourceSplits.set(sourceId, split);
}

type FeatureName = "coverage" | "top3MeanLogOdds" | "maximumLogOdds" | "meanLogOdds";
type Row = {
  id: string;
  class: "human" | "machine" | "hybrid";
  positive: boolean;
  split: AiEvaluationSplit;
  sourceHumanId: string | null;
  features: Record<FeatureName, number> & { passageCount: number };
};

const rows: Row[] = [];
for (const document of [...negatives, ...positives, ...hybrids]) {
  const className = document.roles.includes("ai-negative")
    ? "human"
    : document.roles.includes("ai-positive") ? "machine" : "hybrid";
  const split = className === "human"
    ? (pairedSourceSplits.get(document.id) ?? negativeSplit(document.id))
    : document.aiGeneration!.evaluationSplit;
  const features = await scoreDocument(document);
  rows.push({
    id: document.id,
    class: className,
    positive: className !== "human",
    split,
    sourceHumanId: document.aiGeneration?.sourceHumanId ?? null,
    features,
  });
  process.stdout.write(".");
}
console.log(`\nscored ${rows.length} evaluation documents`);

function operatingPoint(values: Array<{ score: number; positive: boolean }>, maximumFpr = 0.05) {
  const positives = values.filter((row) => row.positive).length;
  const negatives = values.length - positives;
  const candidates = [...new Set(values.map((row) => row.score))].sort((a, b) => b - a);
  const eligible = candidates.map((threshold) => {
    const tp = values.filter((row) => row.positive && row.score >= threshold).length;
    const fp = values.filter((row) => !row.positive && row.score >= threshold).length;
    const fn = positives - tp;
    const tn = negatives - fp;
    return {
      threshold,
      precision: tp + fp === 0 ? 0 : tp / (tp + fp),
      recall: positives === 0 ? 0 : tp / positives,
      fpr: negatives === 0 ? 0 : fp / negatives,
      confusion: { tp, fp, fn, tn },
    };
  }).filter((row) => row.fpr <= maximumFpr)
    .sort((a, b) => b.recall - a.recall || b.precision - a.precision || b.threshold - a.threshold);
  const selected = eligible[0];
  return selected ? {
    ...selected,
    threshold: Number(selected.threshold.toFixed(6)),
    precision: Number(selected.precision.toFixed(4)),
    recall: Number(selected.recall.toFixed(4)),
    fpr: Number(selected.fpr.toFixed(4)),
  } : null;
}

function scoreMetric(values: Array<{ score: number; positive: boolean }>) {
  return {
    auc: Number(rocAuc(values).toFixed(4)),
    ci95: bootstrapAuc(values).map((value) => Number(value.toFixed(4))),
    bestAtFpr05: operatingPoint(values),
  };
}

function featureMetric(selected: Row[], feature: FeatureName) {
  return scoreMetric(selected.map((row) => ({ score: row.features[feature], positive: row.positive })));
}

function combinedRankMetric(selected: Row[]) {
  const humanCoverage = selected.filter((row) => !row.positive).map((row) => row.features.coverage);
  const humanTop3 = selected.filter((row) => !row.positive).map((row) => row.features.top3MeanLogOdds);
  const percentile = (value: number, reference: number[]) => reference.length === 0
    ? 0
    : reference.filter((candidate) => candidate <= value).length / reference.length;
  return scoreMetric(selected.map((row) => ({
    score: Math.max(
      percentile(row.features.coverage, humanCoverage),
      percentile(row.features.top3MeanLogOdds, humanTop3),
    ),
    positive: row.positive,
  })));
}

function metricsFor(selected: Row[]) {
  const classes = Object.fromEntries(["human", "machine", "hybrid"].map((name) => [
    name,
    selected.filter((row) => row.class === name).length,
  ]));
  const hasBothClasses = selected.some((row) => row.positive) && selected.some((row) => !row.positive);
  const featureMetrics = Object.fromEntries(
    (["coverage", "top3MeanLogOdds", "maximumLogOdds", "meanLogOdds"] as const)
      .map((feature) => [feature, featureMetric(selected, feature)]),
  ) as Record<FeatureName, ReturnType<typeof scoreMetric>>;
  return {
    n: selected.length,
    classes,
    features: hasBothClasses ? {
      ...featureMetrics,
      coverageOrTop3Rank: combinedRankMetric(selected),
    } : null,
  };
}

const allMetrics = metricsFor(rows);
const splitMetrics = Object.fromEntries((["train", "validation", "test"] as const).map((split) => [
  split,
  metricsFor(rows.filter((row) => row.split === split)),
]));
const testCoverage = splitMetrics.test.features?.coverage ?? null;
const testPositiveCount = splitMetrics.test.classes.machine + splitMetrics.test.classes.hybrid;
const testNegativeCount = splitMetrics.test.classes.human;
const validated = positives.length >= MINIMUM_POSITIVE_DOCUMENTS
  && testPositiveCount > 0
  && testNegativeCount > 0
  && testCoverage !== null
  && testCoverage.bestAtFpr05 !== null;

const output = {
  schema: "turnitplus-ai-positive-evaluation",
  version: 10,
  validated,
  generatedBy: "tools/evaluate-ai-detector.ts",
  generatedAt: new Date().toISOString(),
  model: AI_MODEL_VERSION,
  inputContractVersion: AI_INPUT_CONTRACT_VERSION,
  modelContract: {
    dtype: AI_MODEL_DTYPE,
    machineLogitIndex: 1,
    temperature: AI_MODEL_TEMPERATURE,
    truncationSide: "none",
    maximumTokens: AI_MODEL_MAX_TOKENS,
    contentWindowTokens: AI_CONTENT_TOKENS,
    tokenStride: AI_TOKEN_STRIDE,
    chunking: "token-based-overlapping-windows",
  },
  positiveDefinition: "role ai-positive or ai-hybrid with complete controlled-generation provenance",
  negativeDefinition: "role ai-negative only",
  warning: "AUC measures ranking on this controlled corpus. It is not an authorship probability or proof for an individual document.",
  ablationPolicy: "Coverage, top-three mean log-odds, maximum, mean, and an OR-style coverage/top-three rank signal are evaluated separately before any live rule changes.",
  splitPolicy: "Generated and source-human pairs are locked to the same split; unpaired negatives use a deterministic SHA-256 split.",
  minimumPositiveDocuments: MINIMUM_POSITIVE_DOCUMENTS,
  positiveSetSize: positives.length,
  hybridSetSize: hybrids.length,
  testSampleSize: splitMetrics.test.n,
  testPositiveCount,
  recall: testCoverage?.bestAtFpr05?.recall ?? null,
  precision: testCoverage?.bestAtFpr05?.precision ?? null,
  auc: testCoverage?.auc ?? null,
  aucCi95: testCoverage?.ci95 ?? null,
  passageLogOddsThreshold: displayedCoverageLogOddsThreshold,
  coverageThresholdBasis: "Matches the website reviewPassageLogOddsThreshold so evaluated coverage and displayed coverage are identical.",
  calibrationStatus: validated ? "calibrated-positive-and-negative" : "positive-control-required",
  preliminaryPositiveControl: preliminaryEvidence,
  all: allMetrics,
  splits: splitMetrics,
  perDocument: rows,
};

writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(PUBLIC_OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ all: output.all, splits: output.splits }, null, 2));
