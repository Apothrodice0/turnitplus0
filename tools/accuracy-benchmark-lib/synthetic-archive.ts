// Accuracy & Coverage Benchmark — synthetic archive lane.
//
// The real production archive index (public/data/document-index.*) is a
// privacy-preserving shingle-hash index only — no raw text is retrievable
// from it (confirmed: corpus/index-source/, the raw text that built it, does
// not exist on this machine). There is therefore no way to construct
// exact/partial copies of real archive-corpus documents with known ground
// truth.
//
// This module gives the benchmark real exact/partial-copy detection numbers
// for the ARCHIVE-MATCHING ALGORITHM anyway, by building a small in-memory
// index out of documents the benchmark itself controls (the same 6 domain
// source papers used for the live-academic lane), using the exact same
// unmodified primitives tools/build-index.ts and
// scripts/validation/real-archive-analyze.mjs already use from
// lib/similarity-core.ts. Nothing here is written to disk — no file under
// public/data/ or data/document-index.json is ever touched — so the real
// production index is completely unaffected.
//
// This measures whether the matching algorithm itself correctly detects
// exact/50/25/10%/few-sentence copies of a document it has indexed — NOT
// whether the real 230-document production corpus has coverage of any
// particular topic. Results from this lane must be reported as "synthetic
// test-corpus" numbers, never conflated with production archive coverage.
import {
  acceptedSimilaritySpans,
  aggregateSimilaritySources,
  containment,
  DEFAULT_SOURCE_AGGREGATION,
  gramHash,
  grams,
  informativeGram,
  tokens,
} from "../../lib/similarity-core";

const SHINGLE_SIZE = 5;
const MINIMUM_MATCHED_WORDS = SHINGLE_SIZE;
/** Same self-matching-document exclusion real-archive-analyze.mjs uses — a document that IS itself the source shouldn't be treated as "containing" itself for scoring purposes when submitted verbatim; kept anyway for parity with production behavior. */
const SELF_EXCLUSION_CONTAINMENT = 0.75;

export type SyntheticArchiveDocument = { id: string; title: string; text: string };

export type SyntheticArchiveIndex = {
  documents: { id: string; title: string; wordCount: number; uniqueShingleCount: number }[];
  postings: Map<string, number[]>;
  maximumDocumentFrequency: number;
};

/** Mirrors tools/build-index.ts's own maximumDocumentFrequency formula exactly. */
export function buildSyntheticArchiveIndex(documents: SyntheticArchiveDocument[]): SyntheticArchiveIndex {
  const tokenized = documents.map((document) => tokens(document.text));
  const rawPostings = new Map<string, number[]>();
  tokenized.forEach((words, documentIndex) => {
    new Set(grams(words, SHINGLE_SIZE)).forEach((gram) => {
      const key = gramHash(gram);
      const sourceIndexes = rawPostings.get(key) ?? [];
      sourceIndexes.push(documentIndex);
      rawPostings.set(key, sourceIndexes);
    });
  });

  const maximumDocumentFrequency = Math.max(2, Math.min(12, Math.ceil(Math.sqrt(Math.max(1, documents.length)))));
  const postings = new Map<string, number[]>();
  for (const [key, sourceIndexes] of rawPostings) {
    if (sourceIndexes.length <= maximumDocumentFrequency) postings.set(key, sourceIndexes);
  }
  const searchableCounts = documents.map(() => 0);
  for (const sourceIndexes of postings.values()) {
    for (const index of sourceIndexes) searchableCounts[index] += 1;
  }

  return {
    documents: documents.map((document, index) => ({
      id: document.id,
      title: document.title,
      wordCount: tokenized[index].length,
      uniqueShingleCount: searchableCounts[index],
    })),
    postings,
    maximumDocumentFrequency,
  };
}

export type SyntheticArchiveSourceMatch = { id: string; title: string; matchedWords: number; percent: number };

export type SyntheticArchiveResult = {
  wordCount: number;
  matchedWordCount: number;
  archiveMatchedPositions: number[];
  score: number;
  sources: SyntheticArchiveSourceMatch[];
};

/** Faithful port of scripts/validation/real-archive-analyze.mjs's realArchiveAnalyze() against an in-memory index instead of the packed binary files — same algorithm, same lib/similarity-core.ts primitives, no risk-calibration file (uses the library's own DEFAULT_SOURCE_AGGREGATION and a fixed minimumMatchedWords = shingleSize, matching that file's own fallback when no calibration override is present). */
export function analyzeSyntheticArchive(text: string, index: SyntheticArchiveIndex): SyntheticArchiveResult {
  const words = tokens(text);
  const documentGrams = grams(words, SHINGLE_SIZE);
  const uniqueDocumentGrams = new Set(documentGrams);
  const sharedBySource = new Map<number, number>();
  uniqueDocumentGrams.forEach((gram) => {
    const sourceIndexes = index.postings.get(gramHash(gram)) ?? [];
    sourceIndexes.forEach((sourceIndex) => {
      sharedBySource.set(sourceIndex, (sharedBySource.get(sourceIndex) ?? 0) + 1);
    });
  });

  const excluded = new Set<number>();
  index.documents.forEach((document, sourceIndex) => {
    const shared = sharedBySource.get(sourceIndex) ?? 0;
    if (containment(shared, uniqueDocumentGrams.size, document.uniqueShingleCount) >= SELF_EXCLUSION_CONTAINMENT) {
      excluded.add(sourceIndex);
    }
  });

  const eligibleCount = index.documents.length - excluded.size;
  const positionScores = new Map<number, Map<number, number>>();
  documentGrams.forEach((gram, start) => {
    const sourceIndexes = (index.postings.get(gramHash(gram)) ?? []).filter((sourceIndex) => !excluded.has(sourceIndex));
    if (sourceIndexes.length === 0 || sourceIndexes.length > index.maximumDocumentFrequency || !informativeGram(gram)) return;
    const idf = Math.log((eligibleCount + 1) / (sourceIndexes.length + 1)) + 1;
    sourceIndexes.forEach((sourceIndex) => {
      for (let position = start; position < start + SHINGLE_SIZE; position += 1) {
        const scores = positionScores.get(position) ?? new Map<number, number>();
        scores.set(sourceIndex, (scores.get(sourceIndex) ?? 0) + idf);
        positionScores.set(position, scores);
      }
    });
  });

  const matchedBySource = new Map<number, Set<number>>();
  positionScores.forEach((scores, position) => {
    const best = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0];
    if (best === undefined) return;
    const positions = matchedBySource.get(best) ?? new Set<number>();
    positions.add(position);
    matchedBySource.set(best, positions);
  });

  const { spansBySource } = acceptedSimilaritySpans(matchedBySource, MINIMUM_MATCHED_WORDS);
  const evidence = [...spansBySource.entries()].map(([sourceIndex, spans]) => {
    const positions = new Set<number>();
    spans.forEach(([start, end]) => {
      for (let position = start; position <= end; position += 1) positions.add(position);
    });
    return {
      sourceIndex,
      positions,
      containment: containment(sharedBySource.get(sourceIndex) ?? 0, uniqueDocumentGrams.size, index.documents[sourceIndex].uniqueShingleCount),
    };
  });
  const aggregation = aggregateSimilaritySources(evidence, words.length, DEFAULT_SOURCE_AGGREGATION);
  const acceptedSourceIndexes = new Set(aggregation.sourceContributions.map((source) => source.sourceIndex));

  const sources: SyntheticArchiveSourceMatch[] = [...matchedBySource.entries()]
    .filter(([sourceIndex]) => acceptedSourceIndexes.has(sourceIndex))
    .map(([sourceIndex]) => {
      const validSpans = spansBySource.get(sourceIndex) ?? [];
      const positions = new Set<number>();
      validSpans.forEach(([start, end]) => {
        for (let position = start; position <= end; position += 1) positions.add(position);
      });
      return {
        id: index.documents[sourceIndex].id,
        title: index.documents[sourceIndex].title,
        matchedWords: positions.size,
        percent: Math.floor((positions.size / Math.max(words.length, 1)) * 100),
      };
    })
    .filter((source) => source.matchedWords > 0)
    .sort((left, right) => right.percent - left.percent);

  return {
    wordCount: words.length,
    matchedWordCount: aggregation.acceptedPositions.size,
    archiveMatchedPositions: [...aggregation.acceptedPositions].sort((left, right) => left - right),
    score: aggregation.score,
    sources,
  };
}
