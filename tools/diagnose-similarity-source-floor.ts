import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  acceptedSimilaritySpans,
  aggregateSimilaritySources,
  containment,
  gramHash,
  grams,
  informativeGram,
  tokens,
  type SimilaritySourceEvidence,
  type SourceAggregationParameters,
} from "../lib/similarity-core";
import { loadCorpus, rocAuc } from "./calibration-utils";
import { errorMetrics, regressionPredictedOnActual } from "./similarity-final-evaluation-core";

type SearchIndex = {
  schema: "tplus-search-index";
  version: 3;
  shingleSize: number;
  corpusVersion: string;
  articles: Array<{ id: string; uniqueShingleCount: number }>;
  invertedIndex: Record<string, number[]>;
};
type DuplicateClusters = {
  schema: "turnitplus-duplicate-clusters";
  version: 1;
  corpusVersion: string;
  exclusionMap: Record<string, string[]>;
};
type Evidence = { totalWords: number; sources: SimilaritySourceEvidence[] };
type Prediction = { id: string; actual: number; predicted: number };

const OUTPUT_PATH = "corpus/audit/similarity-source-floor-diagnostic.json";
const FLOORS = [0, 0.05, 0.1, 0.15, 0.25] as const;
const BASE_PARAMETERS = { minimumMatchedWords: 5, maximumDocumentFrequency: 6 };
const TARGET_THRESHOLD = 15;

const search = JSON.parse(gunzipSync(readFileSync("public/data/document-index.json.gz")).toString("utf8")) as SearchIndex;
const duplicateClusters = JSON.parse(readFileSync("corpus/duplicate-clusters.json", "utf8")) as DuplicateClusters;
if (search.schema !== "tplus-search-index" || search.version !== 3) throw new Error("Unsupported similarity index schema.");
if (duplicateClusters.schema !== "turnitplus-duplicate-clusters" || duplicateClusters.version !== 1) {
  throw new Error("Unsupported duplicate-cluster schema.");
}
if (duplicateClusters.corpusVersion !== search.corpusVersion) throw new Error("Duplicate clusters are stale.");

const allDocuments = loadCorpus("similarity-calibration");
const documents = allDocuments.filter((document) => document.calibrationIndependent !== false);
const sourceById = new Map(search.articles.map((article, index) => [article.id, index]));
const revisionMembers = new Map<string, string[]>();
for (const document of allDocuments) {
  const group = document.revisionGroupId ?? document.id;
  revisionMembers.set(group, [...(revisionMembers.get(group) ?? []), document.id]);
}

function documentEvidence(document: (typeof documents)[number]): Evidence {
  const groupIds = revisionMembers.get(document.revisionGroupId ?? document.id) ?? [document.id];
  const excludedIds = [...new Set([...groupIds, ...groupIds.flatMap((id) => duplicateClusters.exclusionMap[id] ?? [])])];
  const excluded = new Set(excludedIds.map((id) => sourceById.get(id)).filter((value): value is number => value !== undefined));
  const words = tokens(document.text);
  const documentGrams = grams(words, search.shingleSize);
  const uniqueDocumentGrams = new Set(documentGrams);
  const sharedBySource = new Map<number, number>();
  uniqueDocumentGrams.forEach((gram) => {
    for (const sourceIndex of search.invertedIndex[gramHash(gram)] ?? []) {
      if (!excluded.has(sourceIndex)) sharedBySource.set(sourceIndex, (sharedBySource.get(sourceIndex) ?? 0) + 1);
    }
  });
  const positionScores = new Map<number, Map<number, number>>();
  const eligibleCount = search.articles.length - excluded.size;
  documentGrams.forEach((gram, start) => {
    if (!informativeGram(gram)) return;
    const postings = (search.invertedIndex[gramHash(gram)] ?? []).filter((sourceIndex) => !excluded.has(sourceIndex));
    if (!postings.length || postings.length > BASE_PARAMETERS.maximumDocumentFrequency) return;
    const idf = Math.log((eligibleCount + 1) / (postings.length + 1)) + 1;
    for (const sourceIndex of postings) {
      for (let position = start; position < start + search.shingleSize; position += 1) {
        const scores = positionScores.get(position) ?? new Map<number, number>();
        scores.set(sourceIndex, (scores.get(sourceIndex) ?? 0) + idf);
        positionScores.set(position, scores);
      }
    }
  });
  const matchedBySource = new Map<number, Set<number>>();
  positionScores.forEach((scores, position) => {
    const sourceIndex = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0];
    if (sourceIndex === undefined) return;
    const positions = matchedBySource.get(sourceIndex) ?? new Set<number>();
    positions.add(position);
    matchedBySource.set(sourceIndex, positions);
  });
  const { spansBySource } = acceptedSimilaritySpans(matchedBySource, BASE_PARAMETERS.minimumMatchedWords);
  const sources = [...spansBySource.entries()].map(([sourceIndex, spans]) => {
    const positions = new Set<number>();
    spans.forEach(([start, end]) => {
      for (let position = start; position <= end; position += 1) positions.add(position);
    });
    return {
      sourceIndex,
      positions,
      containment: containment(
        sharedBySource.get(sourceIndex) ?? 0,
        uniqueDocumentGrams.size,
        search.articles[sourceIndex].uniqueShingleCount,
      ),
    };
  }).filter((source) => source.positions.size > 0);
  return { totalWords: words.length, sources };
}

function bandMetrics(predictions: Prediction[], predicate: (row: Prediction) => boolean) {
  const rows = predictions.filter(predicate).map((row) => ({ actual: row.actual, predicted: row.predicted }));
  return errorMetrics(rows);
}

function evaluate(floor: number, evidenceById: Map<string, Evidence>) {
  const aggregation: SourceAggregationParameters = {
    minimumSourceContribution: floor,
    maximumContributingSources: null,
    sourceWeighting: "raw",
  };
  const predictions = documents.map((document): Prediction => {
    const evidence = evidenceById.get(document.id)!;
    return {
      id: document.id,
      actual: Number(document.turnitinScore),
      predicted: aggregateSimilaritySources(evidence.sources, evidence.totalWords, aggregation).score,
    };
  });
  const rows = predictions.map((row) => ({ actual: row.actual, predicted: row.predicted }));
  const scores = predictions.map((row) => row.predicted);
  return {
    minimumSourceContribution: floor,
    calibration: regressionPredictedOnActual(rows),
    predictedRange: { minimum: Math.min(...scores), maximum: Math.max(...scores) },
    auc: Number(rocAuc(predictions.map((row) => ({ score: row.predicted, positive: row.actual >= TARGET_THRESHOLD }))).toFixed(4)),
    overall: errorMetrics(rows),
    bands: {
      below5: bandMetrics(predictions, (row) => row.actual < 5),
      from5To14: bandMetrics(predictions, (row) => row.actual >= 5 && row.actual < 15),
      atLeast15: bandMetrics(predictions, (row) => row.actual >= 15),
    },
    targetCheck: {
      slopeAbovePoint4: regressionPredictedOnActual(rows).slope > 0.4,
      slopeAbovePoint5: regressionPredictedOnActual(rows).slope > 0.5,
      lowBandMaeBelow3: bandMetrics(predictions, (row) => row.actual < 5).mae < 3,
      aucAbovePoint75: rocAuc(predictions.map((row) => ({ score: row.predicted, positive: row.actual >= TARGET_THRESHOLD }))) > 0.75,
      predictedMaximumAtLeast40: Math.max(...scores) >= 40,
    },
  };
}

process.stderr.write(`Extracting fixed evidence for ${documents.length} independent development rows.\n`);
const evidenceById = new Map(documents.map((document) => [document.id, documentEvidence(document)]));
const results = FLOORS.map((floor) => {
  process.stderr.write(`Evaluating minimum source contribution ${floor}.\n`);
  return evaluate(floor, evidenceById);
});

const output = {
  schema: "turnitplus-similarity-source-floor-diagnostic",
  version: 1,
  generatedBy: "tools/diagnose-similarity-source-floor.ts",
  generatedAt: new Date().toISOString(),
  corpusVersion: search.corpusVersion,
  sampleSize: documents.length,
  positiveDefinition: ">= 15",
  isolation: "Development calibration rows only. The opened 60-document final cohort is not read by this diagnostic.",
  fixedParameters: {
    ...BASE_PARAMETERS,
    maximumContributingSources: null,
    sourceWeighting: "raw",
  },
  floors: FLOORS,
  decisionRule: "A candidate floor must first achieve slope > 0.4 and low-band MAE < 3. Product recovery still requires slope > 0.5, AUC > 0.75, and a predicted maximum >= 40 on development data before a fresh sealed cohort may be opened.",
  results,
};

mkdirSync("corpus/audit", { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  artifact: OUTPUT_PATH,
  sampleSize: output.sampleSize,
  results: results.map((result) => ({
    floor: result.minimumSourceContribution,
    slope: result.calibration.slope,
    predictedRange: result.predictedRange,
    auc: result.auc,
    overallMae: result.overall.mae,
    lowBandMae: result.bands.below5.mae,
    midBandMae: result.bands.from5To14.mae,
    highBandMae: result.bands.atLeast15.mae,
    targetCheck: result.targetCheck,
  })),
}, null, 2));
