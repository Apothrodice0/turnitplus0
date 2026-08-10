import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  acceptedSimilaritySpans,
  aggregateSimilaritySources,
  containment,
  gramHash,
  grams,
  informativeGram,
  tokens,
  type SourceAggregationParameters,
} from "../lib/similarity-core";

type Parameters = { minimumMatchedWords: number; maximumDocumentFrequency: number } & SourceAggregationParameters;
type SearchIndex = {
  schema: "tplus-search-index"; version: 3; shingleSize: number; corpusVersion: string;
  maximumDocumentFrequency: number;
  articles: Array<{ id: string; title: string; uniqueShingleCount: number }>;
  invertedIndex: Record<string, number[]>;
};
type RegressionManifest = {
  schema: "turnitplus-similarity-heldout-regression"; version: 1;
  documents: Array<{
    id: string; title: string; textPath: string; textSha256: string; turnitinScore: number;
    previousTurnitPlusScore: number; wordCount: number;
  }>;
};

const index = JSON.parse(gunzipSync(readFileSync("public/data/document-index.json.gz")).toString("utf8")) as SearchIndex;
const calibration = JSON.parse(readFileSync("public/data/risk-calibration.json", "utf8")) as {
  schema: string; version: number; corpusVersion: string; matchingParameters: Parameters;
};
const manifest = JSON.parse(readFileSync("corpus/similarity-regression/manifest.json", "utf8")) as RegressionManifest;
if (index.schema !== "tplus-search-index" || index.version !== 3) throw new Error("Unsupported search index.");
if (calibration.schema !== "turnitplus-risk-calibration" || calibration.version !== 8 || calibration.corpusVersion !== index.corpusVersion) {
  throw new Error("Generate the version 8 risk calibration before evaluating the held-out originals.");
}
if (manifest.schema !== "turnitplus-similarity-heldout-regression" || manifest.version !== 1 || manifest.documents.length !== 8) {
  throw new Error("Expected exactly eight held-out regression documents.");
}

function score(text: string, parameters: Parameters) {
  const words = tokens(text);
  const documentGrams = grams(words, index.shingleSize);
  const uniqueDocumentGrams = new Set(documentGrams);
  const sharedBySource = new Map<number, number>();
  uniqueDocumentGrams.forEach((gram) => {
    for (const sourceIndex of index.invertedIndex[gramHash(gram)] ?? []) {
      sharedBySource.set(sourceIndex, (sharedBySource.get(sourceIndex) ?? 0) + 1);
    }
  });
  const excluded = new Set<number>();
  index.articles.forEach((article, sourceIndex) => {
    if (containment(sharedBySource.get(sourceIndex) ?? 0, uniqueDocumentGrams.size, article.uniqueShingleCount) >= 0.75) {
      excluded.add(sourceIndex);
    }
  });
  const positionScores = new Map<number, Map<number, number>>();
  const eligibleCount = index.articles.length - excluded.size;
  documentGrams.forEach((gram, start) => {
    if (!informativeGram(gram)) return;
    const postings = (index.invertedIndex[gramHash(gram)] ?? []).filter((sourceIndex) => !excluded.has(sourceIndex));
    if (!postings.length || postings.length > parameters.maximumDocumentFrequency) return;
    const idf = Math.log((eligibleCount + 1) / (postings.length + 1)) + 1;
    postings.forEach((sourceIndex) => {
      for (let position = start; position < start + index.shingleSize; position += 1) {
        const scores = positionScores.get(position) ?? new Map<number, number>();
        scores.set(sourceIndex, (scores.get(sourceIndex) ?? 0) + idf);
        positionScores.set(position, scores);
      }
    });
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
  const evidence = [...spansBySource.entries()].map(([sourceIndex, spans]) => {
    const positions = new Set<number>();
    spans.forEach(([start, end]) => {
      for (let position = start; position <= end; position += 1) positions.add(position);
    });
    return {
      sourceIndex,
      positions,
      containment: containment(sharedBySource.get(sourceIndex) ?? 0, uniqueDocumentGrams.size, index.articles[sourceIndex].uniqueShingleCount),
    };
  });
  const aggregation = aggregateSimilaritySources(evidence, words.length, parameters);
  return {
    score: aggregation.score,
    excludedSelfMatches: excluded.size,
    retainedSources: aggregation.sourceContributions.length,
    topSources: aggregation.sourceContributions.slice(0, 5).map((source) => ({
      title: index.articles[source.sourceIndex].title,
      contribution: Number(source.rawContribution.toFixed(3)),
      containment: Number(source.containment.toFixed(4)),
    })),
  };
}

function metrics(rows: Array<{ turnitinScore: number; score: number }>) {
  const errors = rows.map((row) => row.score - row.turnitinScore);
  return {
    n: rows.length,
    meanError: Number((errors.reduce((sum, value) => sum + value, 0) / errors.length).toFixed(4)),
    mae: Number((errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length).toFixed(4)),
    rmse: Number(Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length).toFixed(4)),
  };
}

const baselineParameters: Parameters = {
  minimumMatchedWords: 5,
  maximumDocumentFrequency: 6,
  minimumSourceContribution: 0,
  maximumContributingSources: null,
  sourceWeighting: "raw",
};
const perDocument = manifest.documents.map((document) => {
  const bytes = readFileSync(join("corpus/similarity-regression", document.textPath));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== document.textSha256) throw new Error(`${document.id}: held-out text hash mismatch.`);
  const text = bytes.toString("utf8");
  const baseline = score(text, baselineParameters);
  const selected = score(text, calibration.matchingParameters);
  return {
    id: document.id,
    title: document.title,
    turnitinScore: document.turnitinScore,
    previousObservedV98Score: document.previousTurnitPlusScore,
    v99ExactOriginalScore: baseline.score,
    selectedScore: selected.score,
    selectedError: selected.score - document.turnitinScore,
    v99Error: baseline.score - document.turnitinScore,
    retainedSources: selected.retainedSources,
    excludedSelfMatches: selected.excludedSelfMatches,
    topSources: selected.topSources,
  };
});
const output = {
  schema: "turnitplus-similarity-heldout-regression-evaluation",
  version: 1,
  generatedBy: "tools/evaluate-similarity-regression.ts",
  generatedAt: new Date().toISOString(),
  corpusVersion: index.corpusVersion,
  selectionIsolation: "The selected parameters were locked using only the 284 independent calibration rows before this held-out set was scored.",
  decisionRule: "Publish the selected source aggregation only if held-out MAE improves over the v99 exact-original baseline without materially degrading calibration AUC.",
  selectedParameters: calibration.matchingParameters,
  previousObservedV98: metrics(perDocument.map((row) => ({ turnitinScore: row.turnitinScore, score: row.previousObservedV98Score }))),
  v99ExactOriginalBaseline: metrics(perDocument.map((row) => ({ turnitinScore: row.turnitinScore, score: row.v99ExactOriginalScore }))),
  selectedHeldout: metrics(perDocument.map((row) => ({ turnitinScore: row.turnitinScore, score: row.selectedScore }))),
  perDocument,
};
mkdirSync("corpus/audit", { recursive: true });
writeFileSync("corpus/audit/similarity-heldout-regression.json", JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
