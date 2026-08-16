import { canonicalizeText } from "../canonical-text";
import { COMMON_WORDS, tokens } from "../similarity-core";
import type { AcademicSearchQuery } from "./types";

/**
 * Stage 1 of the pipeline (STEP 4): turns raw submission text into a small,
 * bounded set of search queries. Pure and deterministic — no I/O, no
 * randomness — and independently testable from every other stage.
 *
 * Unlike lib/discovery-signals.ts's extractDistinctivePassages (fixed-width
 * sliding windows over the whole document, scored only by informative-word
 * count), this extractor is sentence-anchored — the task specifically asks
 * for "sentences with high lexical uniqueness" as a search unit, which reads
 * far more naturally as an academic-search-engine query than an arbitrary
 * 10-word window. Overlong sentences are still chunked into bounded windows
 * (maxWordsPerPhrase) so a single run-on sentence can't produce a query too
 * long for a real search API to handle well.
 */

export type PhraseExtractionConfig = {
  /** Lower bound on how many queries to return, best-effort only — a short or repetitive document may legitimately produce fewer; this is never padded out with weak/generic queries just to hit the floor. */
  minQueries: number;
  maxQueries: number;
  minWordsPerPhrase: number;
  maxWordsPerPhrase: number;
  /** Minimum count of long (>=4 char), non-common words a candidate must contain to be considered at all — same mechanism as lib/discovery-signals.ts's minInformativeWordsPerPassage, applied to a sentence instead of a fixed window. */
  minInformativeWords: number;
  /** A word this long or longer counts as a proxy for domain/academic terminology (e.g. "photosynthesis," "epistemological") — a coarse but cheap signal, not an academic-vocabulary lookup table. */
  longWordThreshold: number;
};

export const DEFAULT_PHRASE_EXTRACTION_CONFIG: PhraseExtractionConfig = {
  minQueries: 5,
  maxQueries: 20,
  minWordsPerPhrase: 6,
  maxWordsPerPhrase: 24,
  minInformativeWords: 4,
  longWordThreshold: 9,
};

function splitSentences(canonical: string): string[] {
  const sentences: string[] = [];
  for (const paragraph of canonical.split(/\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    for (const part of trimmed.split(/(?<=[.!?])\s+(?=\S)/)) {
      const sentence = part.trim();
      if (sentence) sentences.push(sentence);
    }
  }
  return sentences;
}

/** Chunks an overlong sentence into non-overlapping windows of at most maxWords words each. A sentence at or under the limit is returned unchanged, as its own single-element array. */
function windowSentence(sentence: string, maxWords: number): string[] {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return [sentence];
  const windows: string[] = [];
  for (let start = 0; start < words.length; start += maxWords) {
    windows.push(words.slice(start, start + maxWords).join(" "));
  }
  return windows;
}

type ScoredCandidate = { text: string; position: number; score: number };

function scoreCandidate(text: string, config: PhraseExtractionConfig): number | null {
  const words = tokens(text);
  if (words.length === 0) return null;
  const informativeWords = words.filter((word) => word.length >= 4 && !COMMON_WORDS.has(word));
  if (informativeWords.length < config.minInformativeWords) return null;

  const uniqueRatio = new Set(words).size / words.length;
  const longWordCount = informativeWords.filter((word) => word.length >= config.longWordThreshold).length;
  return informativeWords.length + uniqueRatio * 3 + longWordCount * 1.5;
}

/**
 * Extracts approximately minQueries-maxQueries distinctive, search-worthy
 * phrases from submission text, prioritizing longer meaningful phrases,
 * uncommon word combinations, and lexically unique/academic-sounding
 * sentences over generic ones. Never searches every sentence — a document
 * with 200 sentences still yields at most config.maxQueries candidates.
 */
export function extractCandidatePhrases(
  rawText: string,
  config: PhraseExtractionConfig = DEFAULT_PHRASE_EXTRACTION_CONFIG,
): AcademicSearchQuery[] {
  const canonical = canonicalizeText(rawText);
  if (!canonical) return [];

  const candidates: ScoredCandidate[] = [];
  const seenText = new Set<string>();
  let position = 0;

  for (const sentence of splitSentences(canonical)) {
    for (const window of windowSentence(sentence, config.maxWordsPerPhrase)) {
      position += 1;
      const wordCount = window.split(/\s+/).filter(Boolean).length;
      if (wordCount < config.minWordsPerPhrase) continue;

      const key = window.toLowerCase();
      if (seenText.has(key)) continue;
      seenText.add(key);

      const score = scoreCandidate(window, config);
      if (score === null) continue;
      candidates.push({ text: window, position, score });
    }
  }

  // Highest-scoring first; original document position as a deterministic
  // tiebreaker so equal scores never depend on array iteration order.
  candidates.sort((a, b) => b.score - a.score || a.position - b.position);

  return candidates.slice(0, config.maxQueries).map((candidate, index) => ({
    queryText: candidate.text,
    rank: index,
    sourcePassage: candidate.text,
  }));
}
