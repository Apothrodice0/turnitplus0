// Phase 6.5 validation harness — NOT part of the shipped app.
//
// Faithfully replicates app/similarity-worker.ts's own analyze() function
// so it can run in plain Node against the REAL 230-document packed archive
// index already shipped in public/data/, without a browser/Worker context.
// Every function called here (tokens/grams/gramHash/containment/
// acceptedSimilaritySpans/aggregateSimilaritySources/informativeGram) is
// imported unmodified from lib/similarity-core.ts — the exact same module
// app/similarity-worker.ts itself imports — so this is a faithful
// replication of production's own archive-matching logic, not a
// reimplementation, for real-world Phase 6.5 validation purposes only.
import fs from "node:fs";
import path from "node:path";
import {
  acceptedSimilaritySpans,
  aggregateSimilaritySources,
  containment,
  detectLanguage,
  gramHash,
  grams,
  informativeGram,
  normalize,
  tokens,
} from "../../lib/similarity-core.ts";

const DATA_DIR = path.resolve(import.meta.dirname, "../../public/data");

function loadIndex() {
  const metadata = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "document-index.meta.json"), "utf8"));
  if (metadata.schema !== "tplus-packed-search-index" || metadata.version !== 1) {
    throw new Error("unsupported index schema");
  }
  const hashBuffer = fs.readFileSync(path.join(DATA_DIR, metadata.assets.hashes));
  const offsetBuffer = fs.readFileSync(path.join(DATA_DIR, metadata.assets.offsets));
  const postingBuffer = fs.readFileSync(path.join(DATA_DIR, metadata.assets.postings));
  const hashes = new Uint32Array(hashBuffer.buffer, hashBuffer.byteOffset, hashBuffer.byteLength / 4);
  const offsets = new Uint32Array(offsetBuffer.buffer, offsetBuffer.byteOffset, offsetBuffer.byteLength / 4);
  const postings = new Uint32Array(postingBuffer.buffer, postingBuffer.byteOffset, postingBuffer.byteLength / 4);
  if (
    hashes.length !== metadata.keyCount * 2
    || offsets.length !== metadata.keyCount + 1
    || postings.length !== metadata.postingCount
    || offsets[offsets.length - 1] !== postings.length
  ) {
    throw new Error("packed index incomplete");
  }
  return { ...metadata, hashes, offsets, postings };
}

function loadRiskCalibration() {
  const value = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "risk-calibration.json"), "utf8"));
  if (value.schema !== "turnitplus-risk-calibration" || !Number.isInteger(value.version) || value.version < 1 || value.version > 8) {
    throw new Error("unsupported risk calibration schema");
  }
  return value;
}

function indexPostings(search, hash) {
  const first = Number.parseInt(hash.slice(0, 8), 16) >>> 0;
  const second = Number.parseInt(hash.slice(8, 16), 16) >>> 0;
  let low = 0;
  let high = search.keyCount - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const middleFirst = search.hashes[middle * 2];
    const middleSecond = search.hashes[middle * 2 + 1];
    if (middleFirst === first && middleSecond === second) {
      return search.postings.subarray(search.offsets[middle], search.offsets[middle + 1]);
    }
    if (middleFirst < first || (middleFirst === first && middleSecond < second)) low = middle + 1;
    else high = middle - 1;
  }
  return new Uint32Array(0);
}

const search = loadIndex();
const risk = loadRiskCalibration();
if (risk.corpusVersion !== search.corpusVersion) throw new Error("risk calibration does not match archive version");

export function realArchiveAnalyze(text) {
  const words = tokens(text);
  const documentGrams = grams(words, search.shingleSize);
  const uniqueDocumentGrams = new Set(documentGrams);
  const sharedBySource = new Map();
  let highFrequencyShingleCount = 0;

  uniqueDocumentGrams.forEach((gram) => {
    const sourceIndexes = indexPostings(search, gramHash(gram));
    if (sourceIndexes.length >= Math.max(3, Math.ceil(search.maximumDocumentFrequency * 0.75))) {
      highFrequencyShingleCount += 1;
    }
    sourceIndexes.forEach((sourceIndex) => {
      sharedBySource.set(sourceIndex, (sharedBySource.get(sourceIndex) ?? 0) + 1);
    });
  });

  const excluded = new Set();
  search.articles.forEach((article, sourceIndex) => {
    const shared = sharedBySource.get(sourceIndex) ?? 0;
    if (containment(shared, uniqueDocumentGrams.size, article.uniqueShingleCount) >= 0.75) {
      excluded.add(sourceIndex);
    }
  });

  const eligibleCount = search.documentCount - excluded.size;
  const minimumMatchedWords = risk.matchingParameters?.minimumMatchedWords ?? search.shingleSize;
  const runtimeMaximumDocumentFrequency = Math.min(
    search.maximumDocumentFrequency,
    risk.matchingParameters?.maximumDocumentFrequency ?? search.maximumDocumentFrequency,
  );
  const positionScores = new Map();
  documentGrams.forEach((gram, start) => {
    const sourceIndexes = indexPostings(search, gramHash(gram)).filter((sourceIndex) => !excluded.has(sourceIndex));
    if (sourceIndexes.length === 0 || sourceIndexes.length > runtimeMaximumDocumentFrequency || !informativeGram(gram)) return;
    const idf = Math.log((eligibleCount + 1) / (sourceIndexes.length + 1)) + 1;
    sourceIndexes.forEach((sourceIndex) => {
      for (let position = start; position < start + search.shingleSize; position += 1) {
        const scores = positionScores.get(position) ?? new Map();
        scores.set(sourceIndex, (scores.get(sourceIndex) ?? 0) + idf);
        positionScores.set(position, scores);
      }
    });
  });

  const matchedBySource = new Map();
  positionScores.forEach((scores, position) => {
    const best = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0];
    if (best === undefined) return;
    const positions = matchedBySource.get(best) ?? new Set();
    positions.add(position);
    matchedBySource.set(best, positions);
  });

  const { spansBySource } = acceptedSimilaritySpans(matchedBySource, minimumMatchedWords);
  const evidence = [...spansBySource.entries()].map(([sourceIndex, spans]) => {
    const positions = new Set();
    spans.forEach(([start, end]) => {
      for (let position = start; position <= end; position += 1) positions.add(position);
    });
    return {
      sourceIndex,
      positions,
      containment: containment(sharedBySource.get(sourceIndex) ?? 0, uniqueDocumentGrams.size, search.articles[sourceIndex].uniqueShingleCount),
    };
  });
  const aggregation = aggregateSimilaritySources(evidence, words.length, {
    minimumSourceContribution: risk.matchingParameters?.minimumSourceContribution ?? 0,
    maximumContributingSources: risk.matchingParameters?.maximumContributingSources ?? null,
    sourceWeighting: risk.matchingParameters?.sourceWeighting ?? "raw",
  });
  const acceptedSourceIndexes = new Set(aggregation.sourceContributions.map((source) => source.sourceIndex));
  const allMatchedPositions = aggregation.acceptedPositions;

  const sources = [...matchedBySource.entries()].filter(([sourceIndex]) => acceptedSourceIndexes.has(sourceIndex)).map(([sourceIndex]) => {
    const validSpans = spansBySource.get(sourceIndex) ?? [];
    const acceptedSourcePositions = new Set();
    validSpans.forEach(([start, end]) => {
      for (let position = start; position <= end; position += 1) acceptedSourcePositions.add(position);
    });
    return {
      name: search.articles[sourceIndex].title,
      matches: validSpans.length,
      matchedWords: acceptedSourcePositions.size,
      percent: Math.floor((acceptedSourcePositions.size / Math.max(words.length, 1)) * 100),
    };
  }).filter((source) => source.matches > 0).sort((left, right) => right.percent - left.percent || right.matches - left.matches).slice(0, 20);

  const score = aggregation.score;
  const scoreBand = search.scoreBands.find((candidate) => score >= candidate.minimum && score <= candidate.maximum)?.label ?? "High";
  const riskStatus = score >= risk.archiveCutoff ? "Elevated" : "Lower";

  return {
    wordCount: words.length,
    databaseSize: eligibleCount,
    excludedDocuments: excluded.size,
    matchedWordCount: allMatchedPositions.size,
    archiveMatchedPositions: [...allMatchedPositions].sort((left, right) => left - right),
    score,
    scoreBand,
    riskStatus,
    corpusVersion: search.corpusVersion,
    sources,
    highFrequencyShingleCount,
    detectedLanguage: detectLanguage(text),
  };
}

export const REAL_ARCHIVE_META = { corpusVersion: search.corpusVersion, documentCount: search.documentCount, riskCutoff: risk.archiveCutoff };
