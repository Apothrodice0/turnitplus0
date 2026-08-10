import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  acceptedSimilaritySpans,
  containment,
  gramHash,
  grams,
  informativeGram,
  tokens,
} from "../lib/similarity-core";
import { loadCorpus, rocAuc } from "./calibration-utils";
import { errorMetrics, regressionPredictedOnActual } from "./similarity-final-evaluation-core";
import { deterministicGroupFold, fitRidge, predictRidge } from "./ridge-regression-core";

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
type ModelRow = {
  id: string;
  title: string;
  group: string;
  fold: number;
  actual: number;
  features: number[];
};

const OUTPUT_PATH = "corpus/audit/similarity-multifeature-development.json";
const FEATURE_NAMES = [
  "archiveOverlap",
  "maxSingleSourceContainment",
  "longestMatchedSpan",
  "contributingSourceCount",
  "highDfShingleCount",
  "threeGramRepeatCount",
  "quotationDensity",
  "referenceRatio",
  "wordCount",
] as const;
const LAMBDAS = [0.01, 0.1, 1, 10, 100, 1000] as const;
const FOLDS = 5;
const TARGET_THRESHOLD = 15;
const BASE_PARAMETERS = { minimumMatchedWords: 5, maximumDocumentFrequency: 6 };

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

function quotationDensity(text: string, wordCount: number) {
  const quoted = [...text.matchAll(/“([^”]+)”|"([^"]+)"/gu)]
    .reduce((sum, match) => sum + tokens(match[1] ?? match[2] ?? "").length, 0);
  return quoted / Math.max(wordCount, 1);
}

function referenceRatio(text: string, wordCount: number) {
  const match = /(?:^|\n)\s*(?:references|bibliography|works cited)\s*(?:\n|$)/iu.exec(text);
  if (!match || match.index === undefined) return 0;
  return tokens(text.slice(match.index)).length / Math.max(wordCount, 1);
}

function extractFeatures(document: (typeof documents)[number]) {
  const groupIds = revisionMembers.get(document.revisionGroupId ?? document.id) ?? [document.id];
  const excludedIds = [...new Set([...groupIds, ...groupIds.flatMap((id) => duplicateClusters.exclusionMap[id] ?? [])])];
  const excluded = new Set(excludedIds.map((id) => sourceById.get(id)).filter((value): value is number => value !== undefined));
  const words = tokens(document.text);
  const documentGrams = grams(words, search.shingleSize);
  const uniqueDocumentGrams = new Set(documentGrams);
  const sharedBySource = new Map<number, number>();
  let highDfShingleCount = 0;
  uniqueDocumentGrams.forEach((gram) => {
    const postings = (search.invertedIndex[gramHash(gram)] ?? []).filter((sourceIndex) => !excluded.has(sourceIndex));
    if (postings.length > BASE_PARAMETERS.maximumDocumentFrequency) highDfShingleCount += 1;
    for (const sourceIndex of postings) sharedBySource.set(sourceIndex, (sharedBySource.get(sourceIndex) ?? 0) + 1);
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
  const acceptedPositions = new Set<number>();
  let longestMatchedSpan = 0;
  const contributingSources = new Set<number>();
  spansBySource.forEach((spans, sourceIndex) => {
    if (!spans.length) return;
    contributingSources.add(sourceIndex);
    spans.forEach(([start, end]) => {
      longestMatchedSpan = Math.max(longestMatchedSpan, end - start + 1);
      for (let position = start; position <= end; position += 1) acceptedPositions.add(position);
    });
  });
  const maxSingleSourceContainment = Math.max(0, ...[...sharedBySource.entries()].map(([sourceIndex, shared]) =>
    containment(shared, uniqueDocumentGrams.size, search.articles[sourceIndex].uniqueShingleCount)
  ));
  const threeGrams = grams(words, 3);
  const threeGramRepeatCount = Math.max(0, threeGrams.length - new Set(threeGrams).size);
  return [
    (acceptedPositions.size / Math.max(words.length, 1)) * 100,
    maxSingleSourceContainment,
    longestMatchedSpan,
    contributingSources.size,
    highDfShingleCount,
    threeGramRepeatCount,
    quotationDensity(document.text, words.length),
    referenceRatio(document.text, words.length),
    words.length,
  ];
}

function clip(value: number) {
  return Math.max(0, Math.min(100, value));
}

function project(row: ModelRow, indices: number[]) {
  return indices.map((index) => row.features[index]);
}

function predictSplit(train: ModelRow[], test: ModelRow[], indices: number[], lambda: number) {
  const model = fitRidge(train.map((row) => project(row, indices)), train.map((row) => row.actual), lambda);
  return test.map((row) => ({ row, predicted: clip(predictRidge(model, project(row, indices))) }));
}

function mae(predictions: Array<{ row: ModelRow; predicted: number }>) {
  return predictions.reduce((sum, prediction) => sum + Math.abs(prediction.predicted - prediction.row.actual), 0)
    / Math.max(predictions.length, 1);
}

function evaluatePredictions(predictions: Array<{ row: ModelRow; predicted: number }>) {
  const rows = predictions.map((prediction) => ({ actual: prediction.row.actual, predicted: prediction.predicted }));
  const values = rows.map((row) => row.predicted);
  const band = (predicate: (actual: number) => boolean) => errorMetrics(rows.filter((row) => predicate(row.actual)));
  const slope = regressionPredictedOnActual(rows);
  const auc = rocAuc(rows.map((row) => ({ score: row.predicted, positive: row.actual >= TARGET_THRESHOLD })));
  return {
    calibration: slope,
    predictedRange: {
      minimum: Number(Math.min(...values).toFixed(4)),
      maximum: Number(Math.max(...values).toFixed(4)),
    },
    auc: Number(auc.toFixed(4)),
    overall: errorMetrics(rows),
    bands: {
      below5: band((actual) => actual < 5),
      from5To14: band((actual) => actual >= 5 && actual < 15),
      atLeast15: band((actual) => actual >= 15),
    },
    targetCheck: {
      slopeAbovePoint5: slope.slope > 0.5,
      predictedMaximumAtLeast40: Math.max(...values) >= 40,
      aucAbovePoint75: auc > 0.75,
      lowBandMaeBelow3: band((actual) => actual < 5).mae < 3,
    },
  };
}

function nestedGroupedPredictions(rows: ModelRow[], indices: number[]) {
  const predictions: Array<{ row: ModelRow; predicted: number }> = [];
  const foldSelections: Array<{ outerFold: number; selectedLambda: number; innerMae: number }> = [];
  for (let outerFold = 0; outerFold < FOLDS; outerFold += 1) {
    const outerTrain = rows.filter((row) => row.fold !== outerFold);
    const outerTest = rows.filter((row) => row.fold === outerFold);
    if (!outerTest.length) throw new Error(`Outer fold ${outerFold} is empty.`);
    const candidates = LAMBDAS.map((lambda) => {
      const innerPredictions: Array<{ row: ModelRow; predicted: number }> = [];
      for (let innerFold = 0; innerFold < FOLDS; innerFold += 1) {
        if (innerFold === outerFold) continue;
        const innerTrain = outerTrain.filter((row) => row.fold !== innerFold);
        const innerTest = outerTrain.filter((row) => row.fold === innerFold);
        if (innerTest.length) innerPredictions.push(...predictSplit(innerTrain, innerTest, indices, lambda));
      }
      return { lambda, innerMae: mae(innerPredictions) };
    }).sort((left, right) => left.innerMae - right.innerMae || left.lambda - right.lambda);
    const selected = candidates[0];
    foldSelections.push({
      outerFold,
      selectedLambda: selected.lambda,
      innerMae: Number(selected.innerMae.toFixed(4)),
    });
    predictions.push(...predictSplit(outerTrain, outerTest, indices, selected.lambda));
  }
  predictions.sort((left, right) => left.row.id.localeCompare(right.row.id));
  return { predictions, foldSelections, metrics: evaluatePredictions(predictions) };
}

process.stderr.write(`Extracting nine predeclared features for ${documents.length} independent development rows.\n`);
const rows: ModelRow[] = documents.map((document) => {
  const group = document.revisionGroupId ?? document.id;
  return {
    id: document.id,
    title: document.title ?? document.id,
    group,
    fold: deterministicGroupFold(group, FOLDS),
    actual: Number(document.turnitinScore),
    features: extractFeatures(document),
  };
});
const allIndices = FEATURE_NAMES.map((_, index) => index);
const full = nestedGroupedPredictions(rows, allIndices);
const archiveOnly = nestedGroupedPredictions(rows, [0]);
const ablation = FEATURE_NAMES.map((feature, removedIndex) => {
  process.stderr.write(`Evaluating ablation without ${feature}.\n`);
  const result = nestedGroupedPredictions(rows, allIndices.filter((index) => index !== removedIndex));
  return {
    removedFeature: feature,
    auc: result.metrics.auc,
    slope: result.metrics.calibration.slope,
    mae: result.metrics.overall.mae,
    lowBandMae: result.metrics.bands.below5.mae,
    highBandMae: result.metrics.bands.atLeast15.mae,
    deltaAucVsFull: Number((result.metrics.auc - full.metrics.auc).toFixed(4)),
    deltaMaeVsFull: Number((result.metrics.overall.mae - full.metrics.overall.mae).toFixed(4)),
  };
});

const output = {
  schema: "turnitplus-similarity-multifeature-development",
  version: 1,
  generatedBy: "tools/evaluate-similarity-multifeature.ts",
  generatedAt: new Date().toISOString(),
  corpusVersion: search.corpusVersion,
  sampleSize: rows.length,
  positiveDefinition: ">= 15",
  isolation: "Nested five-fold validation on independent development calibration groups only. The opened 60-document final cohort is not read or used for fitting, selection, or reporting.",
  model: "L2-regularised linear regression on continuous Turnitin score, clipped to 0..100 only after prediction",
  validation: {
    outerFolds: FOLDS,
    innerSelection: "For each outer fold, lambda is selected by MAE across the remaining four group folds.",
    lambdas: LAMBDAS,
    grouping: "revisionGroupId, deterministically hashed before scoring",
    standardization: "training-fold mean and population standard deviation only",
  },
  featureNames: FEATURE_NAMES,
  recoveryGate: "slope > 0.5, predicted maximum >= 40, AUC > 0.75, and low-band MAE < 3 on nested out-of-fold predictions",
  archiveOnly: {
    metrics: archiveOnly.metrics,
    foldSelections: archiveOnly.foldSelections,
  },
  fullModel: {
    metrics: full.metrics,
    foldSelections: full.foldSelections,
    gatePassed: Object.values(full.metrics.targetCheck).every(Boolean),
  },
  ablation,
  perDocument: full.predictions.map((prediction) => ({
    id: prediction.row.id,
    title: prediction.row.title,
    group: prediction.row.group,
    fold: prediction.row.fold,
    actual: prediction.row.actual,
    predicted: Number(prediction.predicted.toFixed(4)),
    signedError: Number((prediction.predicted - prediction.row.actual).toFixed(4)),
    features: Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, Number(prediction.row.features[index].toFixed(6))])),
  })),
};

mkdirSync("corpus/audit", { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  artifact: OUTPUT_PATH,
  sampleSize: output.sampleSize,
  archiveOnly: output.archiveOnly.metrics,
  fullModel: output.fullModel,
  ablation: output.ablation,
}, null, 2));
