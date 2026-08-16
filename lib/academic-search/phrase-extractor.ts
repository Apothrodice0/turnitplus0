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
  /**
   * Phase 5 addition: how many of the top sentence-scored candidates also
   * get a companion KEYWORD query (see extractKeywordQueries below) — a
   * bounded, separate addition to maxQueries, not a replacement for the
   * sentence-based queries above.
   */
  keywordQueryCount: number;
  /** How many whole-document topic-frequency terms are prepended to every keyword query. */
  keywordTopicTermCount: number;
  /** Caps how many of a single candidate sentence's own informative words feed a keyword query (longest-first, after excluding likely verbs/adverbs) — live testing found an uncapped/longer bag reliably diluted relevance rather than improving it. */
  keywordMaxSentenceWords: number;
};

export const DEFAULT_PHRASE_EXTRACTION_CONFIG: PhraseExtractionConfig = {
  minQueries: 5,
  maxQueries: 20,
  minWordsPerPhrase: 6,
  maxWordsPerPhrase: 24,
  minInformativeWords: 4,
  longWordThreshold: 9,
  keywordQueryCount: 3,
  keywordTopicTermCount: 3,
  keywordMaxSentenceWords: 6,
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

function isInformativeWord(word: string): boolean {
  return word.length >= 4 && !COMMON_WORDS.has(word);
}

/**
 * Phase 5: the whole document's own recurring subject terms — informative
 * words appearing 2+ times anywhere in the document, ranked by frequency
 * (ties broken by length, then alphabetically, for determinism). Cheap,
 * corpus-free proxy for "what this document is actually about," reused as
 * the anchor for every keyword query below (see extractKeywordQueries).
 */
function extractTopicTerms(canonical: string, count: number): string[] {
  const freq = new Map<string, number>();
  for (const word of tokens(canonical)) {
    if (!isInformativeWord(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([word]) => word);
}

// Verb/adverb/past-participle suffixes — cheap, POS-tagger-free proxy for
// "grammatically cannot be the head noun of a technical term" (see
// extractKeywordQueries's own comment for why this matters). Deliberately a
// small, explicit, auditable list, matching this project's established
// convention (lib/retrieval-safety.ts's own IP-range comment) over a
// broader but opaque heuristic.
const LIKELY_VERB_OR_ADVERB_SUFFIX = /(?:ing|ly|ed)$/;

/**
 * Phase 5 finding: a paraphrased submission's own full sentences can fail to
 * surface their real source at all in a keyword-relevance search (confirmed
 * live against OpenAIRE/Europe PMC — see this phase's own final report),
 * because a rewritten sentence's function words and phrasing dilute the few
 * domain-specific terms a search engine's own ranking actually keys on.
 * Live experimentation on the confirmed failing case (documented in this
 * phase's own final report) found that a short query combining the whole
 * document's own recurring topic terms with ONE candidate sentence's own
 * longest, non-verb/adverb informative words materially improved discovery
 * (Europe PMC: not found -> rank 0) without any hand-picked, document-
 * specific word list — reusing the EXISTING sentence ranking below (no
 * second "which sentence is best" heuristic), just a bounded, generically-
 * applicable re-packaging of words that ranking already surfaced.
 *
 * This is evaluated honestly as a measurable improvement, not a guaranteed
 * fix — an automatic keyword-selection heuristic without real part-of-
 * speech tagging cannot perfectly replicate a hand-picked query every time;
 * see this phase's own final report for the full before/after evidence.
 *
 * Deliberately does not change the sentence-based candidates or their
 * scoring at all — this only adds a bounded number of ADDITIONAL queries,
 * built from candidates already selected by the existing algorithm.
 */
function extractKeywordQueries(
  canonical: string,
  sentenceCandidates: ScoredCandidate[],
  config: PhraseExtractionConfig,
): AcademicSearchQuery[] {
  if (config.keywordQueryCount <= 0) return [];
  const topicTerms = extractTopicTerms(canonical, config.keywordTopicTermCount);

  const queries: AcademicSearchQuery[] = [];
  const seenBags = new Set<string>();
  for (const candidate of sentenceCandidates.slice(0, config.keywordQueryCount)) {
    // tokens(), not a raw whitespace split — candidate.text still carries the
    // sentence's own punctuation (canonicalizeText does not strip it), and a
    // trailing comma glued onto a word (e.g. "verbally,") would otherwise
    // silently defeat the COMMON_WORDS check and reach the query unclean.
    const sentenceWords = tokens(candidate.text)
      .filter(isInformativeWord)
      .filter((word) => !LIKELY_VERB_OR_ADVERB_SUFFIX.test(word))
      .sort((a, b) => b.length - a.length)
      .slice(0, config.keywordMaxSentenceWords);
    const bagWords = [...new Set([...topicTerms, ...sentenceWords])];
    if (bagWords.length < config.minInformativeWords) continue; // too little real signal to bother searching
    const bagText = bagWords.join(" ");
    const key = bagText.toLowerCase();
    if (seenBags.has(key)) continue; // e.g. a short document whose topic terms already cover a whole sentence
    seenBags.add(key);
    queries.push({ queryText: bagText, rank: 0, sourcePassage: candidate.text, queryType: "keyword" });
  }
  return queries;
}

/**
 * Extracts approximately minQueries-maxQueries distinctive, search-worthy
 * phrases from submission text, prioritizing longer meaningful phrases,
 * uncommon word combinations, and lexically unique/academic-sounding
 * sentences over generic ones. Never searches every sentence — a document
 * with 200 sentences still yields at most config.maxQueries candidates.
 *
 * Returns the existing sentence-based queries first, then up to
 * config.keywordQueryCount companion keyword queries (Phase 5) — a bounded,
 * additive supplement for candidate discovery under heavy paraphrasing, see
 * extractKeywordQueries above.
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

  const sentenceQueries = candidates.slice(0, config.maxQueries).map((candidate, index) => ({
    queryText: candidate.text,
    rank: index,
    sourcePassage: candidate.text,
    queryType: "sentence" as const,
  }));
  const keywordQueries = extractKeywordQueries(canonical, candidates, config);

  return [...sentenceQueries, ...keywordQueries].map((query, index) => ({ ...query, rank: index }));
}
