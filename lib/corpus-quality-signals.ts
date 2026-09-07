import { grams, gramHash, detectDominantLanguage, normalize, COMMON_WORDS } from "./similarity-core";
import { stripReferenceSection } from "./reference-section";
import { stripBoilerplateSections } from "./boilerplate-section";

/**
 * Pure feature-vector computation for the corpus-admission quality model.
 * Every function here is a raw MEASUREMENT, not a score/decision — scoring
 * lives in lib/corpus-quality-model.ts, decisions in
 * lib/corpus-admission-policy.ts. Nothing here does I/O.
 *
 * wordCount here is the single canonical, language-agnostic word count
 * reused by the hard-gate 3000-word minimum (lib/corpus-hard-gates.ts) and
 * by articleComposition below — deliberately NOT lib/similarity-core.ts's
 * tokens() (which strips the reference section and is intended for
 * shingling, not raw counting) and NOT lib/ai-core.ts's WORD_PATTERN
 * (Latin-script only, would undercount Arabic-script documents this
 * product's own detectLanguage explicitly supports).
 */

export const CORPUS_FEATURE_VECTOR_VERSION = "corpus-feature-vector-v1";

const REPLACEMENT_CHAR = "�";
const VALID_CHAR_PATTERN = /[\p{L}\p{N}\p{P}\p{Zs}\s]/u;
const WORD_TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const SENTENCE_SPLIT_PATTERN = /[^.!?]+[.!?]+|[^.!?]+$/g;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()[\]"']+/gi;
const MARKUP_TAG_PATTERN = /<\/?[a-zA-Z][^<>]{0,60}>|\\(?:begin|end)\{[^}]*\}|\$\$/g;
const CODE_TOKEN_PATTERN = /[{};]|=>|==|!=|\bfunction\b|\bdef\b|\bclass\b|\bimport\b|\breturn\b|\bconst\b|\blet\b|\bvar\b|\bpublic\b|\bprivate\b|\bvoid\b/g;
const NON_LINGUISTIC_SYMBOL_PATTERN = /[^\p{L}\p{N}\s.,;:!?'"()\-]/gu;
const HEADING_LINE_PATTERN = /^(?:[0-9]+(?:\.[0-9]+)*\.?\s+)?[A-Z][A-Za-z0-9 ,'&:-]{0,80}$/;

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function wordTokens(text: string): string[] {
  return (text.match(WORD_TOKEN_PATTERN) ?? []).map((w) => w.toLowerCase());
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  if (avg === 0) return 0;
  const variance = mean(values.map((v) => (v - avg) ** 2));
  return Math.sqrt(variance) / avg;
}

function paragraphsOf(text: string): string[] {
  return text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
}

// ============================================================================
// Extraction integrity
// ============================================================================

export type CorpusExtractionIntegritySignals = {
  totalChars: number;
  validCharRatio: number;
  replacementCharCount: number;
  replacementCharRatio: number;
  brokenWordRatio: number;
};

function computeExtractionIntegrity(text: string, words: string[]): CorpusExtractionIntegritySignals {
  const totalChars = text.length;
  const validChars = totalChars === 0 ? 0 : [...text].filter((ch) => VALID_CHAR_PATTERN.test(ch)).length;
  const replacementCharCount = (text.match(new RegExp(REPLACEMENT_CHAR, "g")) ?? []).length;

  const rawTokens = text.trim() ? text.trim().split(/\s+/) : [];
  const brokenTokens = rawTokens.filter((token) => {
    if (token.includes(REPLACEMENT_CHAR)) return true;
    return token.length > 1 && ![...token].some((ch) => /[\p{L}\p{N}]/u.test(ch));
  });

  return {
    totalChars,
    validCharRatio: totalChars === 0 ? 1 : validChars / totalChars,
    replacementCharCount,
    replacementCharRatio: totalChars === 0 ? 0 : replacementCharCount / totalChars,
    brokenWordRatio: rawTokens.length === 0 ? 0 : brokenTokens.length / rawTokens.length,
  };
}

// ============================================================================
// Linguistic quality
// ============================================================================

export type CorpusLinguisticQualitySignals = {
  wordCount: number;
  sentenceCount: number;
  meanSentenceLengthWords: number;
  sentenceLengthCv: number;
  detectedLanguage: ReturnType<typeof detectDominantLanguage>["language"];
  languageConfidence: number;
  mattr: number;
  mattrWindowSize: number;
};

const MATTR_WINDOW_SIZE = 50;

function movingAverageTypeTokenRatio(words: string[], windowSize: number): number {
  if (words.length === 0) return 0;
  if (words.length <= windowSize) return new Set(words).size / words.length;
  let sum = 0;
  let windows = 0;
  for (let start = 0; start + windowSize <= words.length; start += 1) {
    sum += new Set(words.slice(start, start + windowSize)).size / windowSize;
    windows += 1;
  }
  return windows === 0 ? 0 : sum / windows;
}

function computeLinguisticQuality(text: string, fullWordCount: number): CorpusLinguisticQualitySignals {
  const bodyText = stripReferenceSection(text);
  const bodyWords = wordTokens(bodyText);

  const sentences = (bodyText.match(SENTENCE_SPLIT_PATTERN) ?? []).map((s) => s.trim()).filter(Boolean);
  const sentenceLengths = sentences.map((s) => countWords(s)).filter((n) => n > 0);
  // Centralized: label AND confidence come from the SAME
  // lib/similarity-core.ts computation now (detectDominantLanguage) — this
  // module used to re-derive its own [0,1] confidence from a second,
  // separately-hand-maintained copy of the script-ratio/stopword signals
  // (languageConfidenceFor, removed), which is exactly the kind of drift
  // that let corpus admission and report/AI eligibility silently disagree.
  const { language: detectedLanguage, confidence: languageConfidence } = detectDominantLanguage(text);

  return {
    wordCount: fullWordCount,
    sentenceCount: sentences.length,
    meanSentenceLengthWords: mean(sentenceLengths),
    sentenceLengthCv: coefficientOfVariation(sentenceLengths),
    detectedLanguage,
    languageConfidence,
    mattr: movingAverageTypeTokenRatio(bodyWords, MATTR_WINDOW_SIZE),
    mattrWindowSize: MATTR_WINDOW_SIZE,
  };
}

// ============================================================================
// Document structure
// ============================================================================

export type CorpusDocumentStructureSignals = {
  paragraphCount: number;
  meanParagraphLengthWords: number;
  paragraphLengthCv: number;
  headingCount: number;
  headingDensityPer1000Words: number;
};

function isHeadingLike(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 90) return false;
  if (countWords(trimmed) > 12) return false;
  if (/[.!?]$/.test(trimmed)) return false;
  return HEADING_LINE_PATTERN.test(trimmed) || (trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed));
}

function computeDocumentStructure(text: string, fullWordCount: number): CorpusDocumentStructureSignals {
  const paragraphs = paragraphsOf(text);
  const paragraphLengths = paragraphs.map((p) => countWords(p));
  const headingCount = text.split("\n").filter(isHeadingLike).length;

  return {
    paragraphCount: paragraphs.length,
    meanParagraphLengthWords: mean(paragraphLengths),
    paragraphLengthCv: coefficientOfVariation(paragraphLengths),
    headingCount,
    headingDensityPer1000Words: fullWordCount === 0 ? 0 : (headingCount / fullWordCount) * 1000,
  };
}

// ============================================================================
// Contamination
// ============================================================================

export type CorpusContaminationSignals = {
  urlCount: number;
  urlDensityPer1000Words: number;
  markupTagCount: number;
  markupTagDensityPer1000Words: number;
  codeTokenDensityPer1000Words: number;
  nonLinguisticSymbolRatio: number;
};

function computeContamination(text: string, fullWordCount: number): CorpusContaminationSignals {
  const urlCount = (text.match(URL_PATTERN) ?? []).length;
  const markupTagCount = (text.match(MARKUP_TAG_PATTERN) ?? []).length;
  const codeTokenCount = (text.match(CODE_TOKEN_PATTERN) ?? []).length;
  const nonLinguisticSymbolCount = (text.match(NON_LINGUISTIC_SYMBOL_PATTERN) ?? []).length;
  const perThousand = fullWordCount === 0 ? 0 : 1000 / fullWordCount;

  return {
    urlCount,
    urlDensityPer1000Words: urlCount * perThousand,
    markupTagCount,
    markupTagDensityPer1000Words: markupTagCount * perThousand,
    codeTokenDensityPer1000Words: codeTokenCount * perThousand,
    nonLinguisticSymbolRatio: text.length === 0 ? 0 : nonLinguisticSymbolCount / text.length,
  };
}

// ============================================================================
// Redundancy
// ============================================================================

export type CorpusRedundancySignals = {
  repeatedParagraphRatio: number;
  repeatedShingleRatio: number;
  longestIdenticalRunChars: number;
  dominantTokenFrequencyRatio: number;
};

const SHINGLE_REDUNDANCY_SIZES = [5, 10];
const MIN_QUALIFYING_PARAGRAPH_WORDS = 5;

function repeatedParagraphRatio(paragraphs: string[]): number {
  const qualifying = paragraphs.filter((p) => countWords(p) >= MIN_QUALIFYING_PARAGRAPH_WORDS);
  if (qualifying.length === 0) return 0;
  const seen = new Set<string>();
  let repeated = 0;
  for (const paragraph of qualifying) {
    const key = normalize(paragraph);
    if (seen.has(key)) repeated += 1;
    else seen.add(key);
  }
  return repeated / qualifying.length;
}

function repeatedShingleRatio(words: string[]): number {
  let totalShingles = 0;
  let repeatedShingles = 0;
  for (const size of SHINGLE_REDUNDANCY_SIZES) {
    if (words.length < size) continue;
    const counts = new Map<string, number>();
    for (const gram of grams(words, size)) {
      const hash = gramHash(gram);
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      totalShingles += 1;
      if (count > 1) repeatedShingles += 1;
    }
  }
  return totalShingles === 0 ? 0 : repeatedShingles / totalShingles;
}

/**
 * O(n) rolling-hash sliding-window scan for a long identical character run
 * — deliberately NOT a true longest-common-substring computation (that is
 * O(n^2) in the naive case, unsafe against exactly the padded/duplicated
 * pathological documents this signal exists to catch). Trades "exact
 * longest run" for "any run at least windowSize long, extended outward up
 * to a bounded cap" — sufficient for a redundancy signal.
 */
function longestIdenticalRun(text: string, windowSize = 60, maxScanChars = 500_000, maxExtendChars = 5000): number {
  const scanText = text.length > maxScanChars ? text.slice(0, maxScanChars) : text;
  if (scanText.length < windowSize * 2) return 0;

  // BigInt(...) function calls, not `123n` literal syntax — this project's
  // tsconfig targets ES2017, which disallows BigInt literals even though
  // the BigInt global itself is available at runtime.
  const MOD = BigInt(1_000_000_007);
  const BASE = BigInt(257);
  let hash = BigInt(0);
  let power = BigInt(1);
  for (let i = 0; i < windowSize; i += 1) {
    hash = (hash * BASE + BigInt(scanText.charCodeAt(i))) % MOD;
    if (i < windowSize - 1) power = (power * BASE) % MOD;
  }

  const firstSeenAt = new Map<string, number>();
  firstSeenAt.set(hash.toString(), 0);
  let longest = 0;

  for (let start = 1; start + windowSize <= scanText.length; start += 1) {
    const outgoing = BigInt(scanText.charCodeAt(start - 1));
    const incoming = BigInt(scanText.charCodeAt(start + windowSize - 1));
    hash = (((hash - outgoing * power % MOD + MOD) % MOD) * BASE + incoming) % MOD;
    const key = hash.toString();
    const firstIndex = firstSeenAt.get(key);
    if (firstIndex === undefined) {
      firstSeenAt.set(key, start);
      continue;
    }
    if (scanText.slice(firstIndex, firstIndex + windowSize) !== scanText.slice(start, start + windowSize)) continue;

    let extended = windowSize;
    const maxExtend = Math.min(scanText.length - start, maxExtendChars);
    while (extended < maxExtend && scanText[firstIndex + extended] === scanText[start + extended]) extended += 1;
    longest = Math.max(longest, extended);
  }

  return longest;
}

function dominantTokenFrequencyRatio(words: string[]): number {
  const informative = words.filter((w) => w.length >= 4 && !COMMON_WORDS.has(w));
  if (informative.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of informative) counts.set(word, (counts.get(word) ?? 0) + 1);
  return Math.max(...counts.values()) / informative.length;
}

function computeRedundancy(text: string, words: string[], paragraphs: string[]): CorpusRedundancySignals {
  return {
    repeatedParagraphRatio: repeatedParagraphRatio(paragraphs),
    repeatedShingleRatio: repeatedShingleRatio(words),
    longestIdenticalRunChars: longestIdenticalRun(text),
    dominantTokenFrequencyRatio: dominantTokenFrequencyRatio(words),
  };
}

// ============================================================================
// Article composition
// ============================================================================

export type CorpusArticleCompositionSignals = {
  referenceSectionWordCount: number;
  referenceSectionProportion: number;
  tableProportion: number;
  boilerplateWordCount: number;
  bodyTextProportion: number;
};

function isTabularLine(line: string): boolean {
  if ((line.match(/\t/g) ?? []).length >= 3) return true;
  if ((line.match(/ {3,}/g) ?? []).length >= 2) return true;
  if ((line.match(/\|/g) ?? []).length >= 3) return true;
  const numericTokens = (line.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []).length;
  return numericTokens >= 4 && countWords(line) > 0 && numericTokens / countWords(line) >= 0.5;
}

function computeArticleComposition(text: string, fullWordCount: number): CorpusArticleCompositionSignals {
  const bodyBeforeReferences = stripReferenceSection(text);
  const referenceSectionWordCount = Math.max(0, fullWordCount - countWords(bodyBeforeReferences));
  const referenceSectionProportion = fullWordCount === 0 ? 0 : referenceSectionWordCount / fullWordCount;

  const tabularWordCount = text.split("\n").filter(isTabularLine).reduce((sum, line) => sum + countWords(line), 0);
  const tableProportion = fullWordCount === 0 ? 0 : Math.min(1, tabularWordCount / fullWordCount);

  const boilerplateStripped = stripBoilerplateSections(text);
  const boilerplateWordCount = Math.max(0, fullWordCount - countWords(boilerplateStripped));

  const bodyTextProportion = Math.max(0, Math.min(1, 1 - referenceSectionProportion - tableProportion - (fullWordCount === 0 ? 0 : boilerplateWordCount / fullWordCount)));

  return { referenceSectionWordCount, referenceSectionProportion, tableProportion, boilerplateWordCount, bodyTextProportion };
}

// ============================================================================
// Assembly
// ============================================================================

export type CorpusFeatureVector = {
  featureVectorVersion: string;
  extractionIntegrity: CorpusExtractionIntegritySignals;
  linguisticQuality: CorpusLinguisticQualitySignals;
  documentStructure: CorpusDocumentStructureSignals;
  contamination: CorpusContaminationSignals;
  redundancy: CorpusRedundancySignals;
  articleComposition: CorpusArticleCompositionSignals;
};

export function computeCorpusFeatureVector(text: string): CorpusFeatureVector {
  const fullWordCount = countWords(text);
  const words = wordTokens(text);
  const paragraphs = paragraphsOf(text);

  return {
    featureVectorVersion: CORPUS_FEATURE_VECTOR_VERSION,
    extractionIntegrity: computeExtractionIntegrity(text, words),
    linguisticQuality: computeLinguisticQuality(text, fullWordCount),
    documentStructure: computeDocumentStructure(text, fullWordCount),
    contamination: computeContamination(text, fullWordCount),
    redundancy: computeRedundancy(text, words, paragraphs),
    articleComposition: computeArticleComposition(text, fullWordCount),
  };
}
