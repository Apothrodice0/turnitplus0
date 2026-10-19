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
import { DEFAULT_SOURCE_AGGREGATION, gramHash, grams, tokens } from "../../lib/similarity-core";
import { scoreAgainstArchive } from "../../lib/archive-similarity-scoring";

const SHINGLE_SIZE = 5;
const MINIMUM_MATCHED_WORDS = SHINGLE_SIZE;

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

/** scripts/validation/real-archive-analyze.mjs's realArchiveAnalyze() against an in-memory index instead of the packed binary files: the same lib/archive-similarity-scoring.ts scoreAgainstArchive the shipped worker calls, with no risk-calibration file (the library's own DEFAULT_SOURCE_AGGREGATION and a fixed minimumMatchedWords = shingleSize, matching that file's own fallback when no calibration override is present). */
export function analyzeSyntheticArchive(text: string, index: SyntheticArchiveIndex): SyntheticArchiveResult {
  const result = scoreAgainstArchive(
    text,
    {
      shingleSize: SHINGLE_SIZE,
      documentCount: index.documents.length,
      maximumDocumentFrequency: index.maximumDocumentFrequency,
      articles: index.documents.map((document) => ({
        title: document.title,
        sourceType: "Publication" as const,
        uniqueShingleCount: document.uniqueShingleCount,
      })),
      getPostings: (hash) => index.postings.get(hash) ?? [],
    },
    { minimumMatchedWords: MINIMUM_MATCHED_WORDS, ...DEFAULT_SOURCE_AGGREGATION },
  );

  return {
    wordCount: result.wordCount,
    matchedWordCount: result.matchedWordCount,
    archiveMatchedPositions: result.archiveMatchedPositions,
    score: result.score,
    sources: result.sources.map((source) => ({
      id: index.documents[source.sourceIndex].id,
      title: index.documents[source.sourceIndex].title,
      matchedWords: source.matchedWords,
      percent: source.percent,
    })),
  };
}
