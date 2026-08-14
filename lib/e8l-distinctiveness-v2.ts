import { grams, gramHash, informativeGram, tokens } from "./similarity-core";
import { documentShingleHashes } from "./document-family";
import {
  computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
  type DocumentCorrespondenceThresholds, type CorrespondencePassage,
} from "./document-correspondence";
import type { CorpusDocument } from "./e8l-calibration-corpus";

/**
 * Phase E8L: a redesigned, experimental passage-distinctiveness model
 * (V2), built and calibrated against a much larger (100+ document) local
 * corpus than E8K's 4-document version. This module is entirely additive —
 * lib/e8k-passage-evaluator.ts and lib/e8k-passage-acceptance.ts (the V1
 * baseline) are untouched and still importable unmodified for direct
 * comparison. Not imported by, and never imports, the production matcher
 * (lib/user-submission-matching.ts) or a DB client — pure functions only.
 *
 * Same reuse discipline as E8K: every shingle/passage mechanic comes from
 * computeDocumentCorrespondence (lib/document-correspondence.ts) — this
 * file adds new FEATURES computed from that same underlying data, not a
 * second shingling algorithm.
 */

// --- corpus frequency index (built once, queried many times) -----------------

export type CorpusFrequencyIndex = {
  totalDocuments: number;
  /** shingle hash -> number of corpus documents that contain it at least once. */
  shingleDocumentFrequency: Map<string, number>;
  /** shingle hash -> total occurrence count across the whole corpus (not deduplicated per document). */
  shingleTotalOccurrences: Map<string, number>;
  /** informative token (word, length >= 4) -> number of corpus documents that contain it at least once. */
  tokenDocumentFrequency: Map<string, number>;
  shingleSize: number;
};

/**
 * O(corpusSize * avgShingleCount) once. Every feature below then does O(query
 * shingles) hash-map lookups against this — no per-candidate rescan of the
 * corpus (this phase's own task description, section 17).
 */
export function buildCorpusFrequencyIndex(corpus: CorpusDocument[], shingleSize = 5): CorpusFrequencyIndex {
  const shingleDocumentFrequency = new Map<string, number>();
  const shingleTotalOccurrences = new Map<string, number>();
  const tokenDocumentFrequency = new Map<string, number>();

  for (const doc of corpus) {
    const shingleSet = documentShingleHashes(doc.canonicalText, shingleSize);
    for (const hash of shingleSet) shingleDocumentFrequency.set(hash, (shingleDocumentFrequency.get(hash) ?? 0) + 1);

    const words = tokens(doc.canonicalText);
    for (const gram of grams(words, shingleSize)) {
      if (!informativeGram(gram)) continue;
      const hash = gramHash(gram);
      shingleTotalOccurrences.set(hash, (shingleTotalOccurrences.get(hash) ?? 0) + 1);
    }

    const seenTokens = new Set<string>();
    for (const word of words) {
      if (word.length < 4 || seenTokens.has(word)) continue;
      seenTokens.add(word);
      tokenDocumentFrequency.set(word, (tokenDocumentFrequency.get(word) ?? 0) + 1);
    }
  }
  return { totalDocuments: corpus.length, shingleDocumentFrequency, shingleTotalOccurrences, tokenDocumentFrequency, shingleSize };
}

// --- per-comparison inputs shared by every feature ----------------------------

export type FeatureInputs = {
  /** The raw, un-normalized submitted text — needed for entity/numeric detection, which relies on capitalization the normalized token stream has already discarded. */
  rawSubmittedText: string;
  passages: CorrespondencePassage[];
  matchedWordCount: number;
  longestMatchWords: number;
  /** Every informative shingle shared between submitted and candidate text. */
  sharedShingles: Set<string>;
  /** The subset of sharedShingles that actually falls within an accepted passage (section 4E: RARE_MULTIWORD_SEQUENCE is deliberately narrower than plain CORPUS_FREQUENCY). */
  matchedPassageShingles: Set<string>;
  freqIndex: CorpusFrequencyIndex;
  shingleSize: number;
  /** True when the whole document matched exactly (lib/document-correspondence.ts's own canonical-hash short-circuit, which deliberately returns passages: [] — see rawPassageText() below for why raw-text features must not treat that as "no text to inspect"). */
  isExactCanonicalMatch: boolean;
};

/** Best-effort alignment between normalized token positions and raw-text word positions — tokens() and a plain whitespace split usually agree closely but not always (hyphenation, punctuation-adjacent words). Documented approximation, adequate for this phase's calibration purpose; never claimed to be exact. */
function rawWordsForPassage(rawSubmittedText: string, passage: CorrespondencePassage): string {
  const rawWords = rawSubmittedText.trim().split(/\s+/);
  return rawWords.slice(passage.submittedWordStart, passage.submittedWordEnd + 1).join(" ");
}

/**
 * The raw (non-normalized) text of every accepted passage, concatenated —
 * used by the entity/numeric-signal features, which need capitalization the
 * normalized token stream has already discarded. For an exact canonical
 * match, lib/document-correspondence.ts's own passages array is
 * deliberately empty (the whole document IS the match, nothing to
 * itemize) — treating that as "no text" would make F/G silently read as
 * zero for the single most obvious reuse case there is, so this falls back
 * to the full raw submitted text in that case specifically. Never returned
 * to any caller — internal to feature computation only, so it does not need
 * the same maxPassageWords bounding the public `passages` field has.
 */
function rawPassageText(inputs: FeatureInputs): string {
  if (inputs.isExactCanonicalMatch) return inputs.rawSubmittedText;
  return inputs.passages.map((p) => rawWordsForPassage(inputs.rawSubmittedText, p)).join(" ");
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

// --- A: CORPUS_FREQUENCY ------------------------------------------------------

/** 1 - average(documentFrequency / totalDocuments) over every shared shingle — high when the shared vocabulary is rare across the whole local corpus, low when it recurs in many documents (e.g. generic boilerplate). */
export function featureCorpusFrequency(inputs: FeatureInputs): number {
  const { sharedShingles, freqIndex } = inputs;
  if (sharedShingles.size === 0) return 0;
  let sum = 0;
  for (const hash of sharedShingles) sum += (freqIndex.shingleDocumentFrequency.get(hash) ?? 0) / Math.max(1, freqIndex.totalDocuments);
  return 1 - Math.min(1, sum / sharedShingles.size);
}

// --- B: SHINGLE_FREQUENCY -------------------------------------------------------

/** Like A, but using total occurrence COUNT across the corpus (not just document presence) — a shingle appearing 5 times each in 3 documents scores lower here than one appearing once each in 3 documents, even though A treats them identically. Normalized against a fixed reference occurrence count (20), not the corpus size. */
export function featureShingleFrequency(inputs: FeatureInputs, referenceOccurrences = 20): number {
  const { sharedShingles, freqIndex } = inputs;
  if (sharedShingles.size === 0) return 0;
  const avgOccurrences = average([...sharedShingles].map((hash) => freqIndex.shingleTotalOccurrences.get(hash) ?? 0));
  return 1 - Math.min(1, avgOccurrences / referenceOccurrences);
}

// --- C: PHRASE_LENGTH (raw, reported individually — see H for its normalized/combined form) ---

export function featurePhraseLength(inputs: FeatureInputs): number {
  return inputs.longestMatchWords;
}

// --- D: TOKEN_IDF-like weight ---------------------------------------------------

/** Average inverse-document-frequency-style score over the distinct informative tokens actually appearing in accepted passages, normalized against the maximum possible idf (a token present in zero corpus documents) so the result stays in [0,1]. Deliberately NOT claimed to be a calibrated probability — see this file's own header comment and this phase's own task description, section 4/7. */
export function featureTokenIdf(inputs: FeatureInputs): number {
  const words = new Set<string>();
  for (const p of inputs.passages) for (const w of p.submittedText.split(" ")) if (w.length >= 4) words.add(w);
  if (words.size === 0) return 0;
  const N = inputs.freqIndex.totalDocuments;
  const maxIdf = Math.log((N + 1) / 1);
  if (maxIdf === 0) return 0;
  const avgIdf = average([...words].map((w) => Math.log((N + 1) / ((inputs.freqIndex.tokenDocumentFrequency.get(w) ?? 0) + 1))));
  return Math.min(1, avgIdf / maxIdf);
}

// --- E: RARE_MULTIWORD_SEQUENCE --------------------------------------------------

/** Same formula as A, restricted to shingles that fall specifically within an ACCEPTED passage — the more targeted signal section 4E asks for ("reward uncommon multi-word sequences" that actually contributed to the match, not just any shared shingle). */
export function featureRareMultiword(inputs: FeatureInputs): number {
  const { matchedPassageShingles, freqIndex } = inputs;
  if (matchedPassageShingles.size === 0) return 0;
  let sum = 0;
  for (const hash of matchedPassageShingles) sum += (freqIndex.shingleDocumentFrequency.get(hash) ?? 0) / Math.max(1, freqIndex.totalDocuments);
  return 1 - Math.min(1, sum / matchedPassageShingles.size);
}

// --- F: ENTITY/NAMED-TERM SIGNAL -------------------------------------------------

/** Heuristic, not an NER model: counts capitalized multi-token sequences (e.g. "Meridian Analytics", "Protocol Kestrel-7") within the matched passages' RAW text — a deliberately simple proxy for invented names/organizations/codes, exactly the kind of high-information token this phase's own task description (section 4F) asks for. */
export function featureEntitySignal(inputs: FeatureInputs): number {
  const text = rawPassageText(inputs);
  if (!text) return 0;
  const matches = text.match(/\b[A-Z][a-zA-Z]*(?:[-\s][A-Z0-9][a-zA-Z0-9]*)+\b/g) ?? [];
  return Math.min(1, matches.length / 3);
}

// --- G: NUMERICAL/STRUCTURED SIGNAL ----------------------------------------------

/** Counts numeric tokens (measurements, identifiers, percentages) within the matched passages' RAW text. */
export function featureNumericSignal(inputs: FeatureInputs): number {
  const text = rawPassageText(inputs);
  if (!text) return 0;
  const matches = text.match(/\b\d[\d.,]*%?\b/g) ?? [];
  return Math.min(1, matches.length / 3);
}

// --- H: CONTIGUITY ----------------------------------------------------------------

/** Same definition as E8K's contiguityBonus — kept identical so V1/V2 stay comparable on this one dimension. Reported here as its own feature per section 6's "evaluate independently before combining." */
export function featureContiguity(inputs: FeatureInputs, referenceLengthWords = 150): number {
  return Math.min(1, inputs.longestMatchWords / referenceLengthWords);
}

// --- I: INTERNAL_REPETITION --------------------------------------------------------

/** Same formula as E8K's internalRepetitionScore — 1.0 means no shingle shared with the candidate recurs within the submission itself; drops toward 0 as shared shingles repeat internally (e.g. a disclaimer pasted several times). */
export function featureInternalRepetition(rawSubmittedText: string, sharedShingles: Set<string>, shingleSize: number): number {
  if (sharedShingles.size === 0) return 1;
  const words = tokens(rawSubmittedText);
  const counts = new Map<string, number>();
  for (const gram of grams(words, shingleSize)) {
    if (!informativeGram(gram)) continue;
    const hash = gramHash(gram);
    if (!sharedShingles.has(hash)) continue;
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  if (counts.size === 0) return 1;
  return Math.max(0, 1 - (average([...counts.values()]) - 1) / 3);
}

// --- bundling every feature for one comparison --------------------------------

export type FeatureScores = {
  corpusFrequency: number; // A
  shingleFrequency: number; // B
  phraseLengthWords: number; // C (raw word count, not normalized)
  tokenIdf: number; // D
  rareMultiword: number; // E
  entitySignal: number; // F
  numericSignal: number; // G
  contiguity: number; // H
  internalRepetition: number; // I
};

export type V2Diagnostics = {
  matchedWordCount: number;
  passageCount: number;
  longestMatchWords: number;
  wholeDocumentContainment: number;
  isExactCanonicalMatch: boolean;
  passages: CorrespondencePassage[];
  features: FeatureScores;
  distinctivenessV2: number;
};

export function computeFeatures(
  rawSubmittedText: string,
  candidateText: string,
  freqIndex: CorpusFrequencyIndex,
  thresholds: DocumentCorrespondenceThresholds = DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
): V2Diagnostics {
  const correspondence = computeDocumentCorrespondence(rawSubmittedText, candidateText, thresholds);
  const isExactCanonicalMatch = correspondence.exactCanonicalMatch;
  const passageCount = isExactCanonicalMatch ? 1 : correspondence.passages.length;

  const submittedShingles = documentShingleHashes(rawSubmittedText, thresholds.shingleSize);
  const candidateShingles = documentShingleHashes(candidateText, thresholds.shingleSize);
  const sharedShingles = new Set<string>();
  for (const hash of submittedShingles) if (candidateShingles.has(hash)) sharedShingles.add(hash);

  const matchedPassageShingles = new Set<string>();
  if (!isExactCanonicalMatch) {
    const words = tokens(rawSubmittedText);
    const submittedGrams = grams(words, thresholds.shingleSize);
    for (const p of correspondence.passages) {
      for (let i = p.submittedWordStart; i <= p.submittedWordEnd - thresholds.shingleSize + 1 && i < submittedGrams.length; i += 1) {
        const hash = gramHash(submittedGrams[i]);
        if (sharedShingles.has(hash)) matchedPassageShingles.add(hash);
      }
    }
  } else {
    // The whole document matched — every shared shingle is, by definition, "within the match."
    for (const hash of sharedShingles) matchedPassageShingles.add(hash);
  }

  const inputs: FeatureInputs = {
    rawSubmittedText,
    passages: correspondence.passages,
    matchedWordCount: correspondence.matchedWordCount,
    longestMatchWords: correspondence.longestMatchWords,
    sharedShingles,
    matchedPassageShingles,
    freqIndex,
    shingleSize: thresholds.shingleSize,
    isExactCanonicalMatch,
  };

  const features: FeatureScores = {
    corpusFrequency: featureCorpusFrequency(inputs),
    shingleFrequency: featureShingleFrequency(inputs),
    phraseLengthWords: featurePhraseLength(inputs),
    tokenIdf: featureTokenIdf(inputs),
    rareMultiword: featureRareMultiword(inputs),
    entitySignal: featureEntitySignal(inputs),
    numericSignal: featureNumericSignal(inputs),
    contiguity: featureContiguity(inputs),
    internalRepetition: featureInternalRepetition(rawSubmittedText, sharedShingles, thresholds.shingleSize),
  };

  return {
    matchedWordCount: correspondence.matchedWordCount,
    passageCount,
    longestMatchWords: correspondence.longestMatchWords,
    wholeDocumentContainment: correspondence.containment,
    isExactCanonicalMatch,
    passages: correspondence.passages,
    features,
    distinctivenessV2: isExactCanonicalMatch ? 1 : combineV2(features),
  };
}

// --- V2 weighted combination -------------------------------------------------------

/**
 * Explicit experimental weights — a starting point chosen by reasoning about
 * each feature's individual separation behavior (this phase's own task
 * description, section 6/7), NOT tuned against the hold-out set (section
 * 12) and NOT claimed to be a calibrated probability anywhere. B
 * (SHINGLE_FREQUENCY) and C (raw PHRASE_LENGTH) are reported individually
 * but deliberately excluded from the combination — B is highly correlated
 * with A/E, and C is subsumed by H's normalized form; including both would
 * double-count the same underlying signal.
 */
export const DISTINCTIVENESS_V2_WEIGHTS = {
  corpusFrequency: 0.15, // A
  tokenIdf: 0.15, // D
  rareMultiword: 0.25, // E — the most targeted signal, weighted highest
  entitySignal: 0.15, // F
  numericSignal: 0.10, // G
  contiguity: 0.20, // H
  internalRepetitionPenalty: 0.20, // I, subtracted
} as const;

export function combineV2(features: FeatureScores, weights = DISTINCTIVENESS_V2_WEIGHTS): number {
  const raw =
    weights.corpusFrequency * features.corpusFrequency +
    weights.tokenIdf * features.tokenIdf +
    weights.rareMultiword * features.rareMultiword +
    weights.entitySignal * features.entitySignal +
    weights.numericSignal * features.numericSignal +
    weights.contiguity * features.contiguity;
  const penalty = weights.internalRepetitionPenalty * (1 - features.internalRepetition);
  return Math.max(0, Math.min(1, raw - penalty));
}

export const DISTINCTIVENESS_MODEL_V2 = "e8l-distinctiveness-v2" as const;
