import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "./document-correspondence";
import { computeRobustCorrespondence, DEFAULT_ROBUST_CORRESPONDENCE_CONFIG, type RobustCorrespondenceConfig } from "./e8m-robust-correspondence";
import { evaluatePassages as evaluatePassagesV1, type LocalCorpusDocument } from "./e8k-passage-evaluator";
import {
  computeFeatures as computeFeaturesV2, combineV2,
  featureCorpusFrequency, featureShingleFrequency, featurePhraseLength, featureTokenIdf,
  featureRareMultiword, featureEntitySignal, featureNumericSignal, featureContiguity, featureInternalRepetition,
  type CorpusFrequencyIndex, type FeatureScores, type FeatureInputs,
} from "./e8l-distinctiveness-v2";
import { documentShingleHashes } from "./document-family";
import { grams, gramHash, informativeGram, tokens } from "./similarity-core";

/**
 * Phase E8N: the integration layer combining V0/E8M correspondence with
 * V1/V2 distinctiveness into 6 named pipeline variants. This module is
 * pure glue — every actual algorithm (V0's shingle matching, E8M's
 * anchor-and-extend, V1's/V2's distinctiveness formulas) is called via the
 * SAME exported functions lib/document-correspondence.ts,
 * lib/e8m-robust-correspondence.ts, lib/e8k-passage-evaluator.ts, and
 * lib/e8l-distinctiveness-v2.ts already ship — none of those files are
 * imported here for their internals, only their public API, and none are
 * modified.
 *
 * Two of the six variants (E: E8M+V1, F: E8M+V2) need distinctiveness
 * computed from E8M's correspondence data instead of V0's — something
 * neither lib/e8k-passage-evaluator.ts nor lib/e8l-distinctiveness-v2.ts
 * exposes directly, since both call computeDocumentCorrespondence (V0)
 * internally. F reuses V2's own exported per-feature functions unchanged,
 * only assembling a new FeatureInputs from E8M's passages — zero formula
 * duplication. E cannot do the same (lib/e8k-passage-evaluator.ts's
 * corpusRarity/internalRepetitionScore/contiguityBonus are private), so
 * this file duplicates that exact formula — verified byte-for-byte
 * numerically equivalent to lib/e8k-passage-evaluator.ts's own output when
 * both are fed V0 data (see tests/e8n-large-calibration.test.mjs test D) —
 * rather than touching E8K to export them, per this phase's own "keep
 * E8J/E8K/E8L/E8M baselines unchanged" instruction.
 */

export type PipelineVariant = "A_V0_ONLY" | "B_E8M_ONLY" | "C_V0_V1" | "D_V0_V2" | "E_E8M_V1" | "F_E8M_V2";

export const PIPELINE_VARIANTS: PipelineVariant[] = ["A_V0_ONLY", "B_E8M_ONLY", "C_V0_V1", "D_V0_V2", "E_E8M_V1", "F_E8M_V2"];

export type PipelinePassage = { submittedText: string; submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number };

export type PipelineEvaluation = {
  variant: PipelineVariant;
  matchedWordCount: number;
  longestMatchWords: number;
  passageCount: number;
  containment: number;
  passageDensity: number;
  /** null for the two correspondence-only variants (A, B) — no distinctiveness model applied. */
  distinctiveness: number | null;
  passages: PipelinePassage[];
};

const SHINGLE_SIZE = 5;

function computePassageDensity(passages: { submittedWordStart: number; submittedWordEnd: number }[], matchedWordCount: number, isExactCanonicalMatch: boolean): number {
  if (isExactCanonicalMatch) return 1;
  if (passages.length === 0) return 0;
  const start = Math.min(...passages.map((p) => p.submittedWordStart));
  const end = Math.max(...passages.map((p) => p.submittedWordEnd));
  return matchedWordCount / Math.max(1, end - start + 1);
}

function sharedShinglesOf(submittedText: string, candidateText: string, shingleSize = SHINGLE_SIZE): Set<string> {
  const submitted = documentShingleHashes(submittedText, shingleSize);
  const candidate = documentShingleHashes(candidateText, shingleSize);
  const shared = new Set<string>();
  for (const hash of submitted) if (candidate.has(hash)) shared.add(hash);
  return shared;
}

/**
 * Which of the standard 5-word shingles fall within the given passage
 * spans — used to feed V2's RARE_MULTIWORD_SEQUENCE feature regardless of
 * which correspondence engine produced the spans. Mirrors
 * lib/e8l-distinctiveness-v2.ts's own computeFeatures(): when the whole
 * document matched (empty passages, matchedWordCount > 0 — V0's
 * exact-match signature), every shared shingle counts as "within the
 * match" by definition, since there is no sub-region to exclude.
 */
function matchedPassageShinglesFor(submittedText: string, sharedShingles: Set<string>, passages: { submittedWordStart: number; submittedWordEnd: number }[], isExactCanonicalMatch: boolean, shingleSize = SHINGLE_SIZE): Set<string> {
  if (isExactCanonicalMatch) return new Set(sharedShingles);
  const result = new Set<string>();
  const words = tokens(submittedText);
  const submittedGrams = grams(words, shingleSize);
  for (const p of passages) {
    for (let i = p.submittedWordStart; i <= p.submittedWordEnd - shingleSize + 1 && i < submittedGrams.length; i += 1) {
      const hash = gramHash(submittedGrams[i]);
      if (sharedShingles.has(hash)) result.add(hash);
    }
  }
  return result;
}

// --- V1 formula, duplicated from lib/e8k-passage-evaluator.ts (private there) — see this file's own header comment ---

function v1CorpusRarity(sharedShingles: Set<string>, otherDocs: LocalCorpusDocument[], shingleSize: number): number {
  if (sharedShingles.size === 0) return 0;
  if (otherDocs.length === 0) return 1;
  const otherShingleSets = otherDocs.map((d) => documentShingleHashes(d.canonicalText, shingleSize));
  let totalOtherHits = 0;
  for (const hash of sharedShingles) totalOtherHits += otherShingleSets.filter((set) => set.has(hash)).length;
  const maxPossibleHits = sharedShingles.size * otherDocs.length;
  return maxPossibleHits === 0 ? 1 : 1 - totalOtherHits / maxPossibleHits;
}

function v1InternalRepetitionScore(submittedText: string, sharedShingles: Set<string>, shingleSize: number): number {
  if (sharedShingles.size === 0) return 1;
  const words = tokens(submittedText);
  const counts = new Map<string, number>();
  for (const gram of grams(words, shingleSize)) {
    if (!informativeGram(gram)) continue;
    const hash = gramHash(gram);
    if (!sharedShingles.has(hash)) continue;
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  if (counts.size === 0) return 1;
  const avgOccurrences = [...counts.values()].reduce((a, b) => a + b, 0) / counts.size;
  return Math.max(0, 1 - (avgOccurrences - 1) / 3);
}

function v1ContiguityBonus(longestMatchWords: number, referenceLengthWords = 150): number {
  return Math.min(1, longestMatchWords / referenceLengthWords);
}

/** V1 distinctiveness, computed from an arbitrary correspondence engine's output (matchedWordCount/longestMatchWords/passageCount) rather than always V0's. Exported so tests can verify it reproduces lib/e8k-passage-evaluator.ts's own numbers exactly when fed V0 data. */
export function v1DistinctivenessFromCorrespondence(
  submittedText: string,
  candidateText: string,
  correspondence: { matchedWordCount: number; longestMatchWords: number; passageCount: number },
  localCorpusContext: LocalCorpusDocument[],
): number {
  if (correspondence.passageCount === 0) return 0;
  const sharedShingles = sharedShinglesOf(submittedText, candidateText);
  const otherDocs = localCorpusContext.filter((d) => d.canonicalText !== candidateText);
  const rarity = v1CorpusRarity(sharedShingles, otherDocs, SHINGLE_SIZE);
  const repetition = v1InternalRepetitionScore(submittedText, sharedShingles, SHINGLE_SIZE);
  const contiguity = v1ContiguityBonus(correspondence.longestMatchWords);
  return (rarity + repetition + contiguity) / 3;
}

/**
 * V2 distinctiveness, computed from an arbitrary correspondence engine's
 * passages — reuses lib/e8l-distinctiveness-v2.ts's own exported
 * per-feature functions and combineV2() unchanged; only the FeatureInputs
 * assembly is new.
 *
 * isExactCanonicalMatch is inferred, not assumed false: V0's own
 * exactCanonicalMatch short-circuit (lib/document-correspondence.ts)
 * deliberately returns passages: [] even though matchedWordCount is
 * correctly the full document length (the same quirk E8L's own
 * computeFeatures() already special-cases — see that file's header
 * comment). A correspondence result with matchedWordCount > 0 but zero
 * passages is that exact signature regardless of which engine produced it,
 * so it is treated the same way here: entity/numeric signal falls back to
 * scanning the full submitted text rather than reading an empty passage
 * list and silently reporting zero.
 */
export function v2DistinctivenessFromCorrespondence(
  submittedText: string,
  candidateText: string,
  correspondence: { matchedWordCount: number; longestMatchWords: number; passages: { submittedText: string; submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }[] },
  freqIndex: CorpusFrequencyIndex,
): { distinctiveness: number; features: FeatureScores } {
  const isExactCanonicalMatch = correspondence.matchedWordCount > 0 && correspondence.passages.length === 0;
  const sharedShingles = sharedShinglesOf(submittedText, candidateText);
  const matchedPassageShingles = matchedPassageShinglesFor(submittedText, sharedShingles, correspondence.passages, isExactCanonicalMatch);
  const inputs: FeatureInputs = {
    rawSubmittedText: submittedText,
    passages: correspondence.passages.map((p) => ({ ...p, externalWordStart: null })),
    matchedWordCount: correspondence.matchedWordCount,
    longestMatchWords: correspondence.longestMatchWords,
    sharedShingles,
    matchedPassageShingles,
    freqIndex,
    shingleSize: SHINGLE_SIZE,
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
    internalRepetition: featureInternalRepetition(submittedText, sharedShingles, SHINGLE_SIZE),
  };
  return { distinctiveness: correspondence.matchedWordCount === 0 ? 0 : combineV2(features), features };
}

export type EvaluateVariantOptions = {
  freqIndex: CorpusFrequencyIndex;
  localCorpusContext: LocalCorpusDocument[];
  e8mConfig?: RobustCorrespondenceConfig;
};

export function evaluateVariant(variant: PipelineVariant, submittedText: string, candidateText: string, options: EvaluateVariantOptions): PipelineEvaluation {
  const e8mConfig = options.e8mConfig ?? DEFAULT_ROBUST_CORRESPONDENCE_CONFIG;

  switch (variant) {
    case "A_V0_ONLY": {
      const v1 = evaluatePassagesV1(submittedText, candidateText, { localCorpusContext: [] });
      return { variant, matchedWordCount: v1.matchedWordCount, longestMatchWords: v1.longestMatchWords, passageCount: v1.passageCount, containment: v1.wholeDocumentContainment, passageDensity: v1.passageDensity, distinctiveness: null, passages: v1.passages.map((p) => ({ submittedText: p.submittedText, submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, matchedWordCount: p.matchedWordCount })) };
    }
    case "B_E8M_ONLY": {
      const e8m = computeRobustCorrespondence(submittedText, candidateText, e8mConfig);
      return { variant, matchedWordCount: e8m.matchedWordCount, longestMatchWords: e8m.longestMatchWords, passageCount: e8m.passageCount, containment: e8m.containment, passageDensity: e8m.passageDensity, distinctiveness: null, passages: e8m.passages };
    }
    case "C_V0_V1": {
      const v1 = evaluatePassagesV1(submittedText, candidateText, { localCorpusContext: options.localCorpusContext });
      return { variant, matchedWordCount: v1.matchedWordCount, longestMatchWords: v1.longestMatchWords, passageCount: v1.passageCount, containment: v1.wholeDocumentContainment, passageDensity: v1.passageDensity, distinctiveness: v1.distinctiveness, passages: v1.passages.map((p) => ({ submittedText: p.submittedText, submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, matchedWordCount: p.matchedWordCount })) };
    }
    case "D_V0_V2": {
      const v2 = computeFeaturesV2(submittedText, candidateText, options.freqIndex);
      const density = computePassageDensity(v2.passages, v2.matchedWordCount, v2.isExactCanonicalMatch);
      return { variant, matchedWordCount: v2.matchedWordCount, longestMatchWords: v2.longestMatchWords, passageCount: v2.passageCount, containment: v2.wholeDocumentContainment, passageDensity: density, distinctiveness: v2.distinctivenessV2, passages: v2.passages.map((p) => ({ submittedText: p.submittedText, submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, matchedWordCount: p.matchedWordCount })) };
    }
    case "E_E8M_V1": {
      const e8m = computeRobustCorrespondence(submittedText, candidateText, e8mConfig);
      const distinctiveness = v1DistinctivenessFromCorrespondence(submittedText, candidateText, e8m, options.localCorpusContext);
      return { variant, matchedWordCount: e8m.matchedWordCount, longestMatchWords: e8m.longestMatchWords, passageCount: e8m.passageCount, containment: e8m.containment, passageDensity: e8m.passageDensity, distinctiveness, passages: e8m.passages };
    }
    case "F_E8M_V2": {
      const e8m = computeRobustCorrespondence(submittedText, candidateText, e8mConfig);
      const { distinctiveness } = v2DistinctivenessFromCorrespondence(submittedText, candidateText, e8m, options.freqIndex);
      return { variant, matchedWordCount: e8m.matchedWordCount, longestMatchWords: e8m.longestMatchWords, passageCount: e8m.passageCount, containment: e8m.containment, passageDensity: e8m.passageDensity, distinctiveness, passages: e8m.passages };
    }
  }
}

// --- acceptance decision (reuses lib/e8k-passage-acceptance.ts's own shape, not reimplemented) ---

export { evaluateExperimentalAcceptance, PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS, sweepThresholds, type PassageLevelExperimentalThresholds } from "./e8k-passage-acceptance";

// --- failure taxonomy ------------------------------------------------------------

export type FailureCause =
  | "SHINGLE_FRAGMENTATION" | "GENERIC_CORRESPONDENCE" | "DISTINCTIVENESS_FAILURE" | "THRESHOLD_FAILURE"
  | "CANDIDATE_GENERATION_FAILURE" | "PASSAGE_LOCALIZATION_FAILURE" | "FIXTURE_CONSTRUCTION_ISSUE" | "OTHER";

/**
 * Heuristic, not exact — a best-effort explanation for a confusion-matrix
 * cell's cause, for the report's failure taxonomy (section 16). Order
 * matters: checked most-specific-cause-first.
 */
export function classifyFailure(params: {
  expectedShouldDetect: boolean;
  predicted: boolean;
  evaluation: PipelineEvaluation;
  thresholds: { minimumMatchedWords: number; minimumLongestPassageWords: number; minimumPassageDensity: number; minimumDistinctiveness: number };
}): FailureCause {
  const { expectedShouldDetect, evaluation: e, thresholds } = params;

  if (expectedShouldDetect && e.matchedWordCount === 0) {
    // No evidence found at all — either the correspondence engine itself never seeded/aligned anything.
    return "SHINGLE_FRAGMENTATION";
  }
  if (!expectedShouldDetect && e.matchedWordCount > 0 && (e.distinctiveness === null || e.distinctiveness >= thresholds.minimumDistinctiveness)) {
    // Generic/independent text produced real matched evidence that also cleared the distinctiveness bar.
    return e.distinctiveness === null ? "GENERIC_CORRESPONDENCE" : "DISTINCTIVENESS_FAILURE";
  }
  if (expectedShouldDetect && e.matchedWordCount > 0 && e.distinctiveness !== null && e.distinctiveness < thresholds.minimumDistinctiveness) {
    return "DISTINCTIVENESS_FAILURE";
  }
  if (expectedShouldDetect && e.matchedWordCount > 0) {
    // Real evidence exists but fell just short of a numeric gate (matched words/longest/density).
    const closeToMatchedWords = e.matchedWordCount < thresholds.minimumMatchedWords && e.matchedWordCount >= thresholds.minimumMatchedWords * 0.5;
    const closeToLongest = e.longestMatchWords < thresholds.minimumLongestPassageWords && e.longestMatchWords >= thresholds.minimumLongestPassageWords * 0.5;
    if (closeToMatchedWords || closeToLongest) return "THRESHOLD_FAILURE";
    return "SHINGLE_FRAGMENTATION";
  }
  return "OTHER";
}
