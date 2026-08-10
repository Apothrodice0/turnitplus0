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

type SearchIndex = {
  schema: "tplus-search-index";
  version: 3;
  shingleSize: number;
  corpusVersion: string;
  maximumDocumentFrequency: number;
  articles: Array<{ id: string; uniqueShingleCount: number }>;
  invertedIndex: Record<string, number[]>;
};
type DuplicateClusters = {
  schema: "turnitplus-duplicate-clusters";
  version: 1;
  corpusVersion: string;
  exclusionMap: Record<string, string[]>;
};
type BaseParameters = { minimumMatchedWords: number; maximumDocumentFrequency: number };
type Parameters = BaseParameters & SourceAggregationParameters;
type Prediction = { id: string; actual: number; score: number; group: string };
type Evidence = { totalWords: number; sources: SimilaritySourceEvidence[] };

const search = JSON.parse(gunzipSync(readFileSync("public/data/document-index.json.gz")).toString("utf8")) as SearchIndex;
const duplicateClusters = JSON.parse(readFileSync("corpus/duplicate-clusters.json", "utf8")) as DuplicateClusters;
if (search.schema !== "tplus-search-index" || search.version !== 3) throw new Error("Unsupported similarity index schema.");
if (duplicateClusters.schema !== "turnitplus-duplicate-clusters" || duplicateClusters.version !== 1) throw new Error("Unsupported duplicate-cluster schema.");
if (duplicateClusters.corpusVersion !== search.corpusVersion) throw new Error("Duplicate clusters are stale.");

const allDocuments = loadCorpus("similarity-calibration");
const documents = allDocuments.filter((document) => document.calibrationIndependent !== false);
const sourceById = new Map(search.articles.map((article, index) => [article.id, index]));
const revisionMembers = new Map<string, string[]>();
for (const document of allDocuments) {
  const group = document.revisionGroupId ?? document.id;
  revisionMembers.set(group, [...(revisionMembers.get(group) ?? []), document.id]);
}

function documentEvidence(document: (typeof documents)[number], parameters: BaseParameters): Evidence {
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
    const postings = (search.invertedIndex[gramHash(gram)] ?? []).filter((index) => !excluded.has(index));
    if (!postings.length || postings.length > parameters.maximumDocumentFrequency) return;
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
  const { spansBySource } = acceptedSimilaritySpans(matchedBySource, parameters.minimumMatchedWords);
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

function evaluate(predictions: Prediction[]) {
  const auc = rocAuc(predictions.map((row) => ({ score: row.score, positive: row.actual >= 15 })));
  const errors = predictions.map((row) => row.score - row.actual);
  const meanError = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const mae = errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length;
  const rmse = Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length);
  const candidates = Array.from({ length: 101 }, (_, cutoff) => {
    const tp = predictions.filter((row) => row.score >= cutoff && row.actual >= 15).length;
    const fp = predictions.filter((row) => row.score >= cutoff && row.actual < 15).length;
    const fn = predictions.filter((row) => row.score < cutoff && row.actual >= 15).length;
    const tn = predictions.length - tp - fp - fn;
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    const f2 = (5 * precision * recall) / Math.max(Number.EPSILON, 4 * precision + recall);
    return { cutoff, tp, fp, fn, tn, precision, recall, f2 };
  });
  const rank = (left: (typeof candidates)[number], right: (typeof candidates)[number]) =>
    right.f2 - left.f2 || right.recall - left.recall || right.precision - left.precision || right.cutoff - left.cutoff;
  const operatingPoint = candidates.filter((candidate) => candidate.tp + candidate.fp > 0 && candidate.precision >= 0.45).sort(rank)[0];
  if (!operatingPoint) throw new Error("No cutoff satisfies the precision floor.");
  return {
    auc: Number(auc.toFixed(4)),
    meanError: Number(meanError.toFixed(4)),
    mae: Number(mae.toFixed(4)),
    rmse: Number(rmse.toFixed(4)),
    operatingPoint: {
      ...operatingPoint,
      precision: Number(operatingPoint.precision.toFixed(4)),
      recall: Number(operatingPoint.recall.toFixed(4)),
      f2: Number(operatingPoint.f2.toFixed(4)),
    },
  };
}

function select<T extends { auc: number; mae: number; meanError: number; operatingPoint: { precision: number } }>(results: T[]) {
  const bestAuc = Math.max(...results.map((result) => result.auc));
  return [...results.filter((result) => result.auc >= bestAuc - 0.005)].sort((left, right) =>
    left.mae - right.mae
    || Math.abs(left.meanError) - Math.abs(right.meanError)
    || right.operatingPoint.precision - left.operatingPoint.precision
  )[0];
}

const minimumMatchedWords = [5, 8, 12, 16, 20, 25, 30];
const maximumDocumentFrequencies = [4, 6, 8, 12].filter((value) => value <= search.maximumDocumentFrequency);
const baseResults = [];
for (const maximumDocumentFrequency of maximumDocumentFrequencies) {
  for (const minimumWords of minimumMatchedWords) {
    const parameters = { minimumMatchedWords: minimumWords, maximumDocumentFrequency };
    process.stderr.write(`scoring base min=${minimumWords}, df=${maximumDocumentFrequency}\n`);
    const predictions = documents.map((document) => {
      const evidence = documentEvidence(document, parameters);
      return {
        id: document.id,
        actual: Number(document.turnitinScore),
        score: aggregateSimilaritySources(evidence.sources, evidence.totalWords).score,
        group: document.revisionGroupId ?? document.id,
      };
    });
    baseResults.push({ parameters, ...evaluate(predictions) });
  }
}
const selectedBase = select(baseResults);
const fixedEvidence = new Map(documents.map((document) => [document.id, documentEvidence(document, selectedBase.parameters)]));
const minimumSourceContributions = [0, 0.25, 0.5, 1, 1.5, 2];
const maximumContributingSources: Array<number | null> = [null, 20, 10, 5, 3];
const sourceWeightings = ["raw", "containment"] as const;
const sourceResults = [];
for (const sourceWeighting of sourceWeightings) {
  for (const maximumSources of maximumContributingSources) {
    for (const minimumSourceContribution of minimumSourceContributions) {
      const aggregation: SourceAggregationParameters = {
        minimumSourceContribution,
        maximumContributingSources: maximumSources,
        sourceWeighting,
      };
      const parameters: Parameters = { ...selectedBase.parameters, ...aggregation };
      const predictions = documents.map((document) => {
        const evidence = fixedEvidence.get(document.id)!;
        return {
          id: document.id,
          actual: Number(document.turnitinScore),
          score: aggregateSimilaritySources(evidence.sources, evidence.totalWords, aggregation).score,
          group: document.revisionGroupId ?? document.id,
        };
      });
      sourceResults.push({ parameters, ...evaluate(predictions) });
    }
  }
}
const selected = select(sourceResults);
const output = {
  schema: "turnitplus-similarity-parameter-sweep",
  version: 2,
  generatedBy: "tools/sweep-similarity-parameters.ts",
  generatedAt: new Date().toISOString(),
  corpusVersion: search.corpusVersion,
  sampleSize: documents.length,
  positiveDefinition: ">= 15",
  selectionIsolation: "All matching and source-aggregation parameters were selected on the 284 independent calibration rows. The held-out original-document regression set was not read.",
  selectionPolicy: "Choose the base span/DF configuration first. Then, among source-aggregation configurations within 0.005 AUC of the maximum, select the lowest MAE, smallest absolute mean error, then higher precision.",
  searchSpace: {
    minimumMatchedWords,
    maximumDocumentFrequencies,
    minimumSourceContributions,
    maximumContributingSources,
    sourceWeightings,
  },
  selectedBase,
  selected,
  baseResults,
  sourceResults,
};
mkdirSync("corpus/audit", { recursive: true });
writeFileSync("corpus/audit/similarity-parameter-sweep.json", JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
