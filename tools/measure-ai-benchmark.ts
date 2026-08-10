import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import {
  AI_CONTENT_TOKENS, AI_INPUT_CONTRACT_VERSION, AI_MINIMUM_WORDS, AI_MODEL_DTYPE, AI_MODEL_ID, AI_MODEL_MAX_TOKENS, AI_TOKEN_STRIDE,
  AI_MODEL_TEMPERATURE, AI_MODEL_VERSION, AI_PASSAGE_THRESHOLD, buildAiTokenChunks,
  calculateAiLogOddsDiagnostics, calculateTopKMeanLogOdds, logOddsFromProbability,
  eligibleAiWordCount, machineLogOddsFromLogits, probabilityFromLogOdds,
} from "../lib/ai-core";
import { loadCorpus } from "./calibration-utils";

const documents = loadCorpus("ai-benchmark");
const PASSAGE_THRESHOLD = AI_PASSAGE_THRESHOLD;
const INFERENCE_BATCH_SIZE = 32;
const CACHE_ONLY = process.argv.includes("--cache-only");
const SCORE_CACHE_PATH = "corpus/ai-score-cache.json";
const OUTPUT_PATH = "corpus/ai-benchmark-model-report.json";

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
  version: 3,
  model: AI_MODEL_VERSION,
  documents: {},
};
const parsed = existsSync(SCORE_CACHE_PATH)
  ? JSON.parse(readFileSync(SCORE_CACHE_PATH, "utf8")) as Partial<ScoreCache>
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
  model ??= await AutoModelForSequenceClassification.from_pretrained(AI_MODEL_ID, { device: "cpu", dtype: AI_MODEL_DTYPE });
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

const results: Array<{
  id: string;
  referenceGroup: string;
  referenceStatus: "unverified-population-proxy" | "date-ineligible" | null;
  publishedYear: number | null;
  percentFlaggedAtExperimentalThreshold: number;
  meanModelSignal: number;
  maximumModelSignal: number;
  top3MeanLogOdds: number | null;
  passageCount: number;
}> = [];
let reused = 0;
let newlyScored = 0;
const unscored: string[] = [];

for (const [index, document] of documents.entries()) {
  if (eligibleAiWordCount(document.text) < AI_MINIMUM_WORDS) continue;
  tokenizer ??= await AutoTokenizer.from_pretrained(AI_MODEL_ID);
  const chunks = buildAiTokenChunks(document.text, tokenizer);
  const textSha256 = String(document.provenance.sha256);
  const cached = cache.documents[document.id];
  let passages: PassageScore[];
  if (cached?.textSha256 === textSha256 && Array.isArray(cached.passages)) {
    passages = cached.passages.map(withLogOdds);
    cache.documents[document.id] = { textSha256, passages };
    reused += 1;
  } else {
    if (CACHE_ONLY) {
      unscored.push(document.id);
      continue;
    }
    passages = [];
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += INFERENCE_BATCH_SIZE) {
      const batch = chunks.slice(chunkIndex, chunkIndex + INFERENCE_BATCH_SIZE);
      const signals = await classifyBatch(batch.map((chunk) => chunk.text));
      batch.forEach((chunk, batchIndex) => passages.push({
        wordStart: chunk.wordStart,
        wordEnd: chunk.wordEnd,
        probability: signals[batchIndex].probability,
        logOdds: signals[batchIndex].logOdds,
      }));
    }
    cache.documents[document.id] = { textSha256, passages };
    writeFileSync(SCORE_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
    newlyScored += 1;
  }
  const diagnostics = calculateAiLogOddsDiagnostics(passages, logOddsFromProbability(PASSAGE_THRESHOLD));
  results.push({
    id: document.id,
    referenceGroup: document.referenceGroup ?? "unassigned-reference-group",
    referenceStatus: document.referenceStatus ?? null,
    publishedYear: document.publishedYear,
    percentFlaggedAtExperimentalThreshold: diagnostics.percentFlagged,
    meanModelSignal: diagnostics.meanProbability,
    maximumModelSignal: diagnostics.maxProbability,
    top3MeanLogOdds: calculateTopKMeanLogOdds(passages, 3),
    passageCount: passages.length,
  });
  console.log(`[${String(index + 1).padStart(3, "0")}/${documents.length}] ${document.id}`);
}

const corpusGroups = new Map<string, typeof documents>();
for (const document of documents) {
  const group = document.referenceGroup ?? "unassigned-reference-group";
  corpusGroups.set(group, [...(corpusGroups.get(group) ?? []), document]);
}
const scoredGroups = new Map<string, typeof results>();
for (const row of results) scoredGroups.set(row.referenceGroup, [...(scoredGroups.get(row.referenceGroup) ?? []), row]);
const completeGroups = new Set([...corpusGroups.entries()]
  .filter(([group, rows]) => (scoredGroups.get(group)?.length ?? 0) === rows.length)
  .map(([group]) => group));
const comparisonEligibleRows = results.filter((row) => row.referenceStatus === "unverified-population-proxy");
const comparisonRows = comparisonEligibleRows.filter((row) => completeGroups.has(row.referenceGroup));
const dateIneligibleRows = results.filter((row) => row.referenceStatus === "date-ineligible");
const values = comparisonRows.map((row) => row.percentFlaggedAtExperimentalThreshold).sort((a, b) => a - b);
const proxyFlagCurve = Array.from({ length: 101 }, (_, band) => {
  const flagged = comparisonRows.filter((row) => row.percentFlaggedAtExperimentalThreshold >= band).length;
  return { band, proxyFlagRate: Number((flagged / Math.max(1, comparisonRows.length)).toFixed(4)), flagged };
});
const referenceGroups = Object.fromEntries([...new Set(comparisonRows.map((row) => row.referenceGroup))].sort().map((group) => {
  const rows = comparisonRows.filter((row) => row.referenceGroup === group);
  const groupValues = rows.map((row) => row.percentFlaggedAtExperimentalThreshold).sort((a, b) => a - b);
  const curve = Array.from({ length: 101 }, (_, band) => {
    const flagged = rows.filter((row) => row.percentFlaggedAtExperimentalThreshold >= band).length;
    return { band, proxyFlagRate: Number((flagged / Math.max(1, rows.length)).toFixed(4)), flagged };
  });
  return [group, {
    documentCount: rows.length,
    warning: "Exploratory reference-only result; not a false-positive or accuracy estimate.",
    percentFlaggedDistribution: {
      minimum: groupValues[0],
      median: groupValues[Math.floor(groupValues.length / 2)],
      maximum: groupValues[groupValues.length - 1],
    },
    proxyFlagRateAtBand: { "15": curve[15], "30": curve[30] },
    proxyFlagCurve: curve,
  }];
}));
const dateIneligibleGroups = Object.fromEntries([...new Set(dateIneligibleRows.map((row) => row.referenceGroup))].sort().map((group) => {
  const rows = dateIneligibleRows.filter((row) => row.referenceGroup === group);
  return [group, {
    documentCount: rows.length,
    decisionUse: "Scored diagnostics only; excluded from every human-reference comparison distribution.",
    publicationYears: Object.fromEntries([...new Set(rows.map((row) => row.publishedYear))].sort().map((year) => [String(year), rows.filter((row) => row.publishedYear === year).length])),
  }];
}));
const pendingReferenceGroups = Object.fromEntries([...corpusGroups.entries()]
  .filter(([group, rows]) => !completeGroups.has(group) && rows.some((row) => row.referenceStatus === "unverified-population-proxy"))
  .map(([group, rows]) => [group, {
    corpusDocumentCount: rows.length,
    scoredDocumentCount: scoredGroups.get(group)?.length ?? 0,
    missingDocumentCount: rows.length - (scoredGroups.get(group)?.length ?? 0),
    decisionUse: "Incomplete group; excluded from every comparison curve until all documents are scored.",
  }]));
const output = {
  schema: "turnitplus-ai-benchmark-model-report",
  version: 3,
  generatedBy: "tools/measure-ai-benchmark.ts",
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
  },
  benchmarkStatus: "mixed-reference-eligibility",
  benchmarkAssumption: documents[0]?.benchmarkAssumption,
  warning: "These rates are exploratory proxy results, not verified false-positive or accuracy estimates. Incomplete reference groups are excluded from every comparison curve.",
  corpusDocumentCount: documents.length,
  documentCount: results.length,
  unscoredDocumentCount: unscored.length,
  comparisonEligibleDocumentCount: documents.filter((document) => document.referenceStatus === "unverified-population-proxy").length,
  comparisonDocumentCount: comparisonRows.length,
  dateIneligibleDocumentCount: dateIneligibleRows.length,
  passageThreshold: PASSAGE_THRESHOLD,
  reusedDocuments: reused,
  newlyScoredDocuments: newlyScored,
  percentFlaggedDistribution: {
    minimum: values[0],
    median: values[Math.floor(values.length / 2)],
    maximum: values[values.length - 1],
  },
  proxyFlagRateAtBand: {
    "15": proxyFlagCurve[15],
    "30": proxyFlagCurve[30],
  },
  proxyFlagCurve,
  referenceGroups,
  dateIneligibleGroups,
  pendingReferenceGroups,
  perDocument: results,
};

writeFileSync(SCORE_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Scored ${results.length}/${documents.length} benchmark documents (${reused} cached, ${newlyScored} new, ${unscored.length} pending).`);
