import type { SpecifiedValue } from "./corpus-admission-types";
import type {
  CorpusArticleCompositionSignals,
  CorpusContaminationSignals,
  CorpusDocumentStructureSignals,
  CorpusExtractionIntegritySignals,
  CorpusFeatureVector,
  CorpusLinguisticQualitySignals,
  CorpusRedundancySignals,
} from "./corpus-quality-signals";

/**
 * Combines lib/corpus-quality-signals.ts's raw feature vector into 6
 * component scores (0-100, higher = better) and one overall qualityScore.
 * Pure — no I/O. Weights are SpecifiedValue<number>-typed, all
 * ENGINEERING_DEFAULT pending calibration against the 770-article
 * candidate set (spec section 6) — never presented as a scientifically
 * justified number.
 *
 * Deliberately avoids double-counting: reference-section proportion feeds
 * articleComposition only (not documentStructure); heading presence is
 * folded into documentStructure with intentionally low internal weight
 * (extraction loses formatting, so heading ABSENCE is barely penalized)
 * rather than given its own top-level weight; contamination and redundancy
 * stay separate signal families even though both can correlate with "junk"
 * text, because they measure different failure modes (foreign/leftover
 * markup vs. self-repetition).
 */

export const CORPUS_QUALITY_MODEL_VERSION = "corpus-quality-model-v1";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp100(value: number): number {
  return Math.max(0, Math.min(100, value));
}

// ============================================================================
// Component 1 — Extraction integrity
// ============================================================================

function scoreExtractionIntegrity(sig: CorpusExtractionIntegritySignals): number {
  const penalty = (1 - sig.validCharRatio) * 40 + sig.replacementCharRatio * 300 + sig.brokenWordRatio * 60;
  return clamp100(100 - penalty);
}

// ============================================================================
// Component 2 — Linguistic quality
// ============================================================================

function sentenceStructureQuality(meanLengthWords: number, lengthCv: number): number {
  if (meanLengthWords <= 0) return 0;
  let lengthScore: number;
  if (meanLengthWords < 3) lengthScore = 0.1;
  else if (meanLengthWords < 8) lengthScore = 0.5 + (0.5 * (meanLengthWords - 3)) / 5;
  else if (meanLengthWords <= 40) lengthScore = 1;
  else if (meanLengthWords <= 100) lengthScore = 1 - (0.7 * (meanLengthWords - 40)) / 60;
  else lengthScore = 0.1;
  // A near-zero coefficient of variation across sentence lengths is itself
  // a mild red flag (degenerate/repetitive punctuation), not a bonus.
  const uniformityPenalty = lengthCv < 0.05 ? 0.85 : 1;
  return clamp01(lengthScore * uniformityPenalty);
}

function scoreLinguisticQuality(sig: CorpusLinguisticQualitySignals): number {
  const structure = sentenceStructureQuality(sig.meanSentenceLengthWords, sig.sentenceLengthCv);
  const combined = 0.4 * structure + 0.3 * sig.languageConfidence + 0.3 * clamp01(sig.mattr);
  return clamp100(combined * 100);
}

// ============================================================================
// Component 3 — Document structure (headings intentionally low-weighted —
// extraction loses formatting, so a real article missing detectable
// headings should not be punished much).
// ============================================================================

function scoreDocumentStructure(sig: CorpusDocumentStructureSignals): number {
  if (sig.paragraphCount === 0) return 0;
  let paragraphScore: number;
  if (sig.meanParagraphLengthWords < 15) paragraphScore = 0.5;
  else if (sig.meanParagraphLengthWords <= 300) paragraphScore = 1;
  else paragraphScore = 0.5;
  const variancePenalty = sig.paragraphLengthCv > 3 ? 0.8 : 1;
  const headingBonus = sig.headingCount > 0 ? 0.05 : 0;
  return clamp100((paragraphScore * variancePenalty + headingBonus) * 100);
}

// ============================================================================
// Component 4 — Contamination (higher score = less contaminated)
// ============================================================================

function scoreContamination(sig: CorpusContaminationSignals): number {
  const penalty =
    sig.urlDensityPer1000Words * 2 +
    sig.markupTagDensityPer1000Words * 3 +
    sig.codeTokenDensityPer1000Words * 1 +
    sig.nonLinguisticSymbolRatio * 150;
  return clamp100(100 - penalty);
}

// ============================================================================
// Component 5 — Redundancy (higher score = less redundant)
// ============================================================================

function scoreRedundancy(sig: CorpusRedundancySignals): number {
  const longRunPenalty = sig.longestIdenticalRunChars > 200 ? 20 : sig.longestIdenticalRunChars / 10;
  const penalty =
    sig.repeatedParagraphRatio * 40 +
    sig.repeatedShingleRatio * 40 +
    sig.dominantTokenFrequencyRatio * 30 +
    longRunPenalty;
  return clamp100(100 - penalty);
}

// ============================================================================
// Component 6 — Article composition
// ============================================================================

function scoreArticleComposition(sig: CorpusArticleCompositionSignals): number {
  return clamp100(sig.bodyTextProportion * 100);
}

// ============================================================================
// Assembly
// ============================================================================

export type CorpusQualityComponentScores = {
  extractionIntegrity: number;
  linguisticQuality: number;
  documentStructure: number;
  contamination: number;
  redundancy: number;
  articleComposition: number;
};

export type CorpusQualityWeights = Record<keyof CorpusQualityComponentScores, SpecifiedValue<number>>;

export const CORPUS_QUALITY_WEIGHTS: CorpusQualityWeights = {
  extractionIntegrity: { value: 0.20, status: "ENGINEERING_DEFAULT", rationale: "Placeholder pending 770-article calibration (spec section 6) — extraction fidelity is important but should not alone dominate a document with genuinely strong prose." },
  linguisticQuality: { value: 0.25, status: "ENGINEERING_DEFAULT", rationale: "Largest single weight as a placeholder, reflecting that sentence structure/vocabulary/language-confidence are the most direct 'is this real, coherent prose' signal — not independently tuned yet." },
  documentStructure: { value: 0.10, status: "ENGINEERING_DEFAULT", rationale: "Deliberately small — extraction frequently loses paragraph/heading formatting for genuinely valid articles (spec's own guidance)." },
  contamination: { value: 0.15, status: "ENGINEERING_DEFAULT", rationale: "Placeholder; should lower, not zero out, a code-heavy/URL-heavy but otherwise legitimate article on its own." },
  redundancy: { value: 0.15, status: "ENGINEERING_DEFAULT", rationale: "Placeholder; catches padding/duplication without being the sole determinant." },
  articleComposition: { value: 0.15, status: "ENGINEERING_DEFAULT", rationale: "Placeholder; a bibliography-/table-heavy but otherwise legitimate paper should lose some, not all, of this component." },
};

export type CorpusQualityScoreResult = {
  componentScores: CorpusQualityComponentScores;
  qualityScore: number;
  qualityModelVersion: string;
};

export function computeCorpusQualityScore(
  vector: CorpusFeatureVector,
  weights: CorpusQualityWeights = CORPUS_QUALITY_WEIGHTS,
): CorpusQualityScoreResult {
  const componentScores: CorpusQualityComponentScores = {
    extractionIntegrity: scoreExtractionIntegrity(vector.extractionIntegrity),
    linguisticQuality: scoreLinguisticQuality(vector.linguisticQuality),
    documentStructure: scoreDocumentStructure(vector.documentStructure),
    contamination: scoreContamination(vector.contamination),
    redundancy: scoreRedundancy(vector.redundancy),
    articleComposition: scoreArticleComposition(vector.articleComposition),
  };

  const totalWeight = Object.values(weights).reduce((sum, w) => sum + w.value, 0) || 1;
  const qualityScore = clamp100(
    (Object.keys(componentScores) as Array<keyof CorpusQualityComponentScores>).reduce(
      (sum, key) => sum + componentScores[key] * weights[key].value,
      0,
    ) / totalWeight,
  );

  return { componentScores, qualityScore, qualityModelVersion: CORPUS_QUALITY_MODEL_VERSION };
}
