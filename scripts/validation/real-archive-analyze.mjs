// Phase 6.5 validation harness — NOT part of the shipped app.
//
// Faithfully replicates app/similarity-worker.ts's own analyze() function
// so it can run in plain Node against the REAL packed archive index already
// shipped in public/data/, without a browser/Worker context. Scoring is
// lib/archive-similarity-scoring.ts's scoreAgainstArchive — the exact
// function the worker calls, with the same index adapter and matching
// parameters — so this harness always scores with the shipped contract and
// cannot drift from it.
import fs from "node:fs";
import path from "node:path";
import { detectLanguage } from "../../lib/similarity-core.ts";
import { scoreAgainstArchive } from "../../lib/archive-similarity-scoring.ts";

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
  if (value.schema !== "turnitplus-risk-calibration" || !Number.isInteger(value.version) || value.version < 1 || value.version > 9) {
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
  const result = scoreAgainstArchive(
    text,
    {
      shingleSize: search.shingleSize,
      documentCount: search.documentCount,
      maximumDocumentFrequency: search.maximumDocumentFrequency,
      articles: search.articles,
      getPostings: (hash) => indexPostings(search, hash),
    },
    {
      minimumMatchedWords: risk.matchingParameters?.minimumMatchedWords,
      maximumDocumentFrequency: risk.matchingParameters?.maximumDocumentFrequency,
      minimumSourceContribution: risk.matchingParameters?.minimumSourceContribution,
      maximumContributingSources: risk.matchingParameters?.maximumContributingSources,
      sourceWeighting: risk.matchingParameters?.sourceWeighting,
    },
  );

  const score = result.score;
  const scoreBand = search.scoreBands.find((candidate) => score >= candidate.minimum && score <= candidate.maximum)?.label ?? "High";
  const riskStatus = score >= risk.archiveCutoff ? "Elevated" : "Lower";

  return {
    wordCount: result.wordCount,
    databaseSize: result.databaseSize,
    excludedDocuments: result.excludedDocuments,
    matchedWordCount: result.matchedWordCount,
    archiveMatchedPositions: result.archiveMatchedPositions,
    score,
    scoreBand,
    riskStatus,
    corpusVersion: search.corpusVersion,
    sources: result.sources.map(({ name, matches, matchedWords, percent }) => ({ name, matches, matchedWords, percent })),
    highFrequencyShingleCount: result.highFrequencyShingleCount,
    detectedLanguage: detectLanguage(text),
  };
}

export const REAL_ARCHIVE_META = { corpusVersion: search.corpusVersion, documentCount: search.documentCount, riskCutoff: risk.archiveCutoff };
