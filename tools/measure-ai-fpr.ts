import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import {
  AI_MINIMUM_WORDS, AI_MODEL_DTYPE, AI_MODEL_ID, AI_MODEL_MAX_TOKENS,
  AI_CONTENT_TOKENS, AI_INPUT_CONTRACT_VERSION, AI_TOKEN_STRIDE, AI_MODEL_TEMPERATURE, AI_MODEL_VERSION, AI_OFFICIAL_PASSAGE_THRESHOLD, buildAiTokenChunks,
  calculateAiLogOddsDiagnostics, calculateTopKMeanLogOdds, logOddsFromProbability,
  eligibleAiWordCount, machineLogOddsFromLogits, probabilityFromLogOdds,
} from "../lib/ai-core";
import { loadCorpus, wilson, type WriterPopulation } from "./calibration-utils";

const negatives = loadCorpus("ai-negative");
const MINIMUM_NEGATIVE_DOCUMENTS = 80;
const MINIMUM_POPULATION_COMPARISON_DOCUMENTS = 30;
const TARGET_FPR_UPPER_BOUND = 0.05;
const EXPERIMENTAL_PASSAGE_THRESHOLD = AI_OFFICIAL_PASSAGE_THRESHOLD;
const SCORE_CACHE_PATH = "corpus/ai-score-cache.json";
const SCORE_CACHE_VERSION = 4;
const BENCHMARK_REPORT_PATH = "corpus/ai-benchmark-model-report.json";
const EXTRACTION_PARITY_REPORT_PATH = "corpus/ai-extraction-parity-report.json";
const CALIBRATION_BATCH_SIZE = 24;
console.log(`AI-negative set: ${negatives.length} verified pre-2022 English papers`);

type PassageScore = { wordStart: number; wordEnd: number; probability: number; logOdds: number };
type CachedDocument = { textSha256: string; passages: PassageScore[] };
type ScoreCache = {
  schema: "turnitplus-ai-score-cache";
  version: number;
  model: string;
  documents: Record<string, CachedDocument>;
};

const emptyCache: ScoreCache = {
  schema: "turnitplus-ai-score-cache",
  version: SCORE_CACHE_VERSION,
  model: AI_MODEL_VERSION,
  documents: {},
};
const parsedCache = existsSync(SCORE_CACHE_PATH)
  ? JSON.parse(readFileSync(SCORE_CACHE_PATH, "utf8")) as Partial<ScoreCache>
  : null;
const scoreCache: ScoreCache = parsedCache?.schema === emptyCache.schema
  && parsedCache.version === SCORE_CACHE_VERSION
  && parsedCache.model === AI_MODEL_VERSION
  && parsedCache.documents && typeof parsedCache.documents === "object"
  ? { ...emptyCache, documents: parsedCache.documents }
  : emptyCache;

let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>> | null = null;
async function getTokenizer() {
  tokenizer ??= await AutoTokenizer.from_pretrained(AI_MODEL_ID);
  return tokenizer;
}
async function classifyBatch(texts: string[]) {
  const activeTokenizer = await getTokenizer();
  model ??= await AutoModelForSequenceClassification.from_pretrained(AI_MODEL_ID, { device: "cpu", dtype: AI_MODEL_DTYPE });
  const inputs = activeTokenizer(texts, { padding: true, truncation: false });
  if ((inputs.input_ids.dims.at(-1) ?? 0) > AI_MODEL_MAX_TOKENS) {
    throw new Error(`Calibration token window exceeded ${AI_MODEL_MAX_TOKENS} tokens.`);
  }
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

type ScoredDocument = { id: string; population: WriterPopulation; passages: PassageScore[] };
const scoredDocuments: ScoredDocument[] = [];
let reusedDocuments = 0;
let newlyScoredDocuments = 0;
for (const document of negatives) {
  if (eligibleAiWordCount(document.text) < AI_MINIMUM_WORDS) continue;
  const chunks = buildAiTokenChunks(document.text, await getTokenizer());
  const textSha256 = String(document.provenance.sha256);
  const cached = scoreCache.documents[document.id];
  let passages: PassageScore[];
  if (cached?.textSha256 === textSha256 && Array.isArray(cached.passages)) {
    passages = cached.passages.map(withLogOdds);
    scoreCache.documents[document.id] = { textSha256, passages };
    reusedDocuments += 1;
    process.stdout.write("c");
  } else {
    passages = [];
    for (let index = 0; index < chunks.length; index += CALIBRATION_BATCH_SIZE) {
      const batch = chunks.slice(index, index + CALIBRATION_BATCH_SIZE);
      const signals = await classifyBatch(batch.map((chunk) => chunk.text));
      batch.forEach((chunk, batchIndex) => passages.push({
        wordStart: chunk.wordStart,
        wordEnd: chunk.wordEnd,
        probability: signals[batchIndex].probability,
        logOdds: signals[batchIndex].logOdds,
      }));
    }
    scoreCache.documents[document.id] = { textSha256, passages };
    writeFileSync(SCORE_CACHE_PATH, `${JSON.stringify(scoreCache, null, 2)}\n`);
    newlyScoredDocuments += 1;
    process.stdout.write(".");
  }
  scoredDocuments.push({ id: document.id, population: document.writerPopulation as WriterPopulation, passages });
}
writeFileSync(SCORE_CACHE_PATH, `${JSON.stringify(scoreCache, null, 2)}\n`);
console.log(`\nscored ${scoredDocuments.length} documents (${reusedDocuments} cached, ${newlyScoredDocuments} new)`);
if (!scoredDocuments.length) throw new Error("No eligible verified AI-negative documents were scored.");

function passageCurveFor(documents: ScoredDocument[]) {
  const logOddsValues = documents.flatMap((result) => result.passages.map((passage) => passage.logOdds));
  return Array.from({ length: 101 }, (_, index) => {
    const threshold = index / 100;
    const logOddsThreshold = logOddsFromProbability(threshold);
    const flagged = logOddsValues.filter((logOdds) => logOdds >= logOddsThreshold).length;
    const ci95 = wilson(flagged, logOddsValues.length);
    return {
      threshold,
      logOddsThreshold: Number.isFinite(logOddsThreshold) ? logOddsThreshold : null,
      fpr: Number((flagged / Math.max(1, logOddsValues.length)).toFixed(4)),
      ci95: ci95.map((x) => Number(x.toFixed(4))),
      flagged,
    };
  });
}

function measuredLogOddsThresholdFor(documents: ScoredDocument[]) {
  const values = [...new Set(documents.flatMap((document) => document.passages.map((passage) => passage.logOdds)))]
    .sort((a, b) => a - b);
  return values.find((threshold) => {
    const flagged = documents.reduce((total, document) => total
      + document.passages.filter((passage) => passage.logOdds >= threshold).length, 0);
    const passageCount = documents.reduce((total, document) => total + document.passages.length, 0);
    return wilson(flagged, passageCount)[1] <= TARGET_FPR_UPPER_BOUND;
  }) ?? null;
}

function quantile(values: number[], q: number) {
  if (!values.length) throw new Error("Cannot compute a quantile from an empty sample.");
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
}

const l2Documents = scoredDocuments.filter((document) => document.population === "L2-algerian");
if (!l2Documents.length) throw new Error("The conservative calibration requires at least one L2-algerian AI-negative document.");
const l2PassageCurve = passageCurveFor(l2Documents);
const measuredPassageLogOddsThreshold = measuredLogOddsThresholdFor(l2Documents);
const measuredPassageThreshold = measuredPassageLogOddsThreshold === null
  ? null
  : probabilityFromLogOdds(measuredPassageLogOddsThreshold);
const scoringPassageLogOddsThreshold = measuredPassageLogOddsThreshold
  ?? logOddsFromProbability(EXPERIMENTAL_PASSAGE_THRESHOLD);
const reviewPassagePercentile = 90;
const reviewPassageLogOddsThreshold = quantile(
  scoredDocuments.flatMap((document) => document.passages.map((passage) => passage.logOdds)),
  reviewPassagePercentile / 100,
);
const reviewPassageThreshold = probabilityFromLogOdds(reviewPassageLogOddsThreshold);
const scored = scoredDocuments.map(({ id, population, passages }) => ({
  id,
  population,
  // Retained as a diagnostic only. The website headline is the document-median
  // position within the verified-human distribution, not this coverage value.
  docScore: calculateAiLogOddsDiagnostics(passages, reviewPassageLogOddsThreshold).percentFlagged,
  conservativeDocScore: calculateAiLogOddsDiagnostics(passages, scoringPassageLogOddsThreshold).percentFlagged,
  medianLogOdds: quantile(passages.map((passage) => passage.logOdds), 0.5),
  top3MeanLogOdds: calculateTopKMeanLogOdds(passages, 3),
  passageCount: passages.length,
}));

function documentCurveFor(rows: typeof scored) {
  return Array.from({ length: 101 }, (_, band) => {
    const flagged = rows.filter((result) => result.docScore >= band).length;
    const ci95 = wilson(flagged, rows.length);
    return { band, fpr: Number((flagged / Math.max(1, rows.length)).toFixed(4)), ci95: ci95.map((x) => Number(x.toFixed(4))), flagged };
  });
}

const byPopulation = Object.fromEntries((["L2-algerian", "native-english"] as const).map((population) => {
  const rows = scored.filter((row) => row.population === population);
  return [population, {
    n: rows.length,
    passageCount: rows.reduce((total, row) => total + row.passageCount, 0),
    documentFprCurve: documentCurveFor(rows),
  }];
})) as Record<WriterPopulation, { n: number; passageCount: number; documentFprCurve: ReturnType<typeof documentCurveFor> }>;
const combinedCurve = documentCurveFor(scored);
const l2Curve = byPopulation["L2-algerian"].documentFprCurve;
const nativeCurve = byPopulation["native-english"].documentFprCurve;
const negativeControlFailed = l2Curve[30].ci95[0] > TARGET_FPR_UPPER_BOUND;
const measuredSuppressBelow = l2Curve.find((row) => row.ci95[1] <= TARGET_FPR_UPPER_BOUND)?.band ?? null;
const extractionParity = existsSync(EXTRACTION_PARITY_REPORT_PATH)
  ? JSON.parse(readFileSync(EXTRACTION_PARITY_REPORT_PATH, "utf8")) as {
      status?: string;
      coverageDifferencePoints?: number;
      finding?: string;
      requiredAction?: string;
    }
  : null;
const extractionParityReady = extractionParity?.status === "passed";
const humanCalibrationReady = l2Documents.length >= MINIMUM_NEGATIVE_DOCUMENTS
  && !negativeControlFailed
  && extractionParityReady
  && measuredPassageThreshold !== null
  && measuredSuppressBelow !== null;
// False-positive measurement proves only the human side of the trade-off.
// The website stays gated until a controlled positive set also establishes
// held-out recall and AUC through tools/evaluate-ai-detector.ts.
const calibrated = false;
const suppressBelow = humanCalibrationReady ? (measuredSuppressBelow ?? 0) : 0;
const passageThreshold = humanCalibrationReady ? (measuredPassageThreshold ?? EXPERIMENTAL_PASSAGE_THRESHOLD) : EXPERIMENTAL_PASSAGE_THRESHOLD;
const populationComparisonReady = byPopulation["native-english"].n >= MINIMUM_POPULATION_COMPARISON_DOCUMENTS
  && byPopulation["L2-algerian"].n >= MINIMUM_POPULATION_COMPARISON_DOCUMENTS;
const gap = (band: number) => !populationComparisonReady
  ? null
  : Number((l2Curve[band].fpr - nativeCurve[band].fpr).toFixed(4));
const benchmarkReport = existsSync(BENCHMARK_REPORT_PATH)
  ? JSON.parse(readFileSync(BENCHMARK_REPORT_PATH, "utf8")) as {
      model?: string;
      benchmarkStatus?: string;
      warning?: string;
      documentCount?: number;
      comparisonDocumentCount?: number;
      dateIneligibleDocumentCount?: number;
      percentFlaggedDistribution?: { minimum?: number; median?: number; maximum?: number };
      proxyFlagRateAtBand?: Record<string, { proxyFlagRate?: number; flagged?: number }>;
    }
  : null;
const output = {
  schema: "turnitplus-ai-calibration",
  version: 9,
  calibrated,
  humanCalibrationReady,
  generatedBy: "tools/measure-ai-fpr.ts",
  generatedAt: new Date().toISOString(),
  model: AI_MODEL_VERSION,
  modelId: AI_MODEL_ID,
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
    publishedPassageThreshold: AI_OFFICIAL_PASSAGE_THRESHOLD,
  },
  population: "role-isolated verified pre-2022 English academic papers",
  conservativeDecision: "passageThreshold and suppressBelow are derived from L2-algerian human papers to protect the population expected to be more affected by false positives",
  calibrationStatus: humanCalibrationReady
    ? "positive-control-required"
    : negativeControlFailed
      ? "model-failed-negative-control"
      : !extractionParityReady
        ? "input-extraction-parity-required"
      : "insufficient-verified-human-sample",
  negativeControlFailed,
  negativeControlDecision: "The model fails when the lower bound of the verified L2-human document FPR interval at the 30% displayed-coverage band is above the provisional 5% target. Displayed coverage and this control use the same reviewPassageLogOddsThreshold.",
  calibrationConfidence: "provisional; the 95% Wilson upper-bound target is 5% because fewer than 381 verified negatives cannot support a 1% upper bound even with zero false positives",
  extractionParityReady,
  extractionParity: extractionParity ? {
    status: extractionParity.status ?? "unknown",
    coverageDifferencePoints: extractionParity.coverageDifferencePoints ?? null,
    finding: extractionParity.finding ?? null,
    requiredAction: extractionParity.requiredAction ?? null,
  } : null,
  calibrationMinimumNegativeDocuments: MINIMUM_NEGATIVE_DOCUMENTS,
  targetFprUpperBound: TARGET_FPR_UPPER_BOUND,
  populationComparisonMinimum: MINIMUM_POPULATION_COMPARISON_DOCUMENTS,
  populationComparisonReady,
  measuredPassageThresholdCandidate: measuredPassageThreshold,
  measuredPassageLogOddsThresholdCandidate: measuredPassageLogOddsThreshold,
  reviewPassagePercentile,
  reviewPassageThreshold,
  reviewPassageLogOddsThreshold,
  documentCoverageLogOddsThreshold: reviewPassageLogOddsThreshold,
  documentCoverageThresholdBasis: "Diagnostic percentage of analyzed tokens above reviewPassageLogOddsThreshold; the website headline uses the document-median human-reference percentile band instead.",
  reviewThresholdPopulation: "all 88 role-isolated verified English human papers",
  publishedModelPassageThreshold: EXPERIMENTAL_PASSAGE_THRESHOLD,
  measuredSuppressBelowCandidate: measuredSuppressBelow,
  negativeSetSize: scored.length,
  positiveSetSize: 0,
  recall: null,
  auc: null,
  passageCount: scored.reduce((total, row) => total + row.passageCount, 0),
  suppressBelow,
  passageThreshold,
  populations: byPopulation,
  combinedDocumentFprCurve: combinedCurve,
  l2PassageFprCurve: l2PassageCurve,
  fprGapAtBand: { "15": gap(15), "30": gap(30) },
  humanReferenceBenchmark: benchmarkReport?.model === AI_MODEL_VERSION ? {
    status: benchmarkReport.benchmarkStatus ?? "human-reference-proxy",
    documentCount: benchmarkReport.comparisonDocumentCount ?? 0,
    totalScoredDocumentCount: benchmarkReport.documentCount ?? 0,
    dateIneligibleDocumentCount: benchmarkReport.dateIneligibleDocumentCount ?? 0,
    percentFlaggedDistribution: benchmarkReport.percentFlaggedDistribution ?? null,
    proxyFlagRateAtBand: benchmarkReport.proxyFlagRateAtBand ?? null,
    decisionUse: "Supporting pre-November-2022 English-reference evidence only; not verified FPR or accuracy ground truth.",
    warning: benchmarkReport.warning ?? null,
  } : null,
  perDocument: scored.map(({ id, population, docScore, conservativeDocScore, medianLogOdds, top3MeanLogOdds }) => ({
    id,
    population,
    docScore,
    conservativeDocScore,
    medianLogOdds,
    top3MeanLogOdds,
  })),
};
mkdirSync("public/data", { recursive: true });
writeFileSync("public/data/ai-calibration.json", JSON.stringify(output, null, 2));
console.log(`\nL2 suppress below: ${suppressBelow}%`);
console.log(`L2 passage threshold: ${passageThreshold}`);
console.log(`90th-percentile review threshold: ${reviewPassageLogOddsThreshold} log-odds (${reviewPassageThreshold})`);
console.log(`Human calibration status: ${humanCalibrationReady ? "ready" : "not ready"} (${l2Documents.length}/${MINIMUM_NEGATIVE_DOCUMENTS} L2 negatives)`);
console.log(`Overall calibration status: ${output.calibrationStatus}`);
console.log(`FPR gap at 15: ${output.fprGapAtBand["15"] ?? `unavailable (need ${MINIMUM_POPULATION_COMPARISON_DOCUMENTS} documents per population)`}`);
console.log(`FPR gap at 30: ${output.fprGapAtBand["30"] ?? `unavailable (need ${MINIMUM_POPULATION_COMPARISON_DOCUMENTS} documents per population)`}`);
