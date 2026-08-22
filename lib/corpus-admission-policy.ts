import type { CorpusAdmissionDecision, CorpusAdmissionReasonCode, CorpusSupportedFormat, SpecifiedValue } from "./corpus-admission-types";
import type { CorpusHardGateResult } from "./corpus-hard-gates";
import type { CorpusFamilyResolution } from "./corpus-admission-family";
import type { CorpusFeatureVector } from "./corpus-quality-signals";
import type { CorpusQualityComponentScores, CorpusQualityScoreResult } from "./corpus-quality-model";

/**
 * Pure decision-tree module — mirrors this codebase's existing pure-policy-module
 * conventions exactly: no I/O, no @libsql/client import, every threshold a
 * SpecifiedValue<T>, a policy-version string embedded in every decision.
 * Takes already-computed signals (hard-gate result, family resolution,
 * quality score, corpus-value score) and classifies — never computes a
 * signal itself. See tests/corpus-admission-policy.test.mjs's structural
 * self-check.
 *
 * Decision is a strict 3-value enum (ACCEPT/REVIEW/REJECT) per the original
 * spec's section 3 — a family match (e.g. "REVIEW_NEAR_DUPLICATE"-shaped
 * language elsewhere) is expressed as decision:"REJECT" +
 * reasonCodes:["DUPLICATE_ALREADY_REPRESENTED"|"EDITED_VERSION_ALREADY_REPRESENTED"],
 * never a 4th enum value.
 */

export const CORPUS_ADMISSION_POLICY_VERSION = "corpus-admission-policy-v1";
export const CORPUS_VALUE_MODEL_VERSION = "corpus-value-model-v1";

function clamp100(value: number): number {
  return Math.max(0, Math.min(100, value));
}

// ============================================================================
// Corpus-value score — kept separate from quality (spec's own worked
// example: qualityScore 95 + corpusValueScore 32 are two independent
// numbers, never one derived from the other). Driven purely by the best
// containment found against the EXISTING corpus (computed by
// lib/corpus-admission-gate.ts via the same near-dup search used for family
// resolution) — a continuous "how novel is this" signal, distinct from the
// hard family-match REJECT below, which fires on genuine duplicates
// regardless of this score.
// ============================================================================

export type CorpusValueScoreResult = { corpusValueScore: number; corpusValueModelVersion: string };

export function computeCorpusValueScore(bestContainmentAgainstCorpus: number | null): CorpusValueScoreResult {
  const containmentValue = Math.max(0, Math.min(1, bestContainmentAgainstCorpus ?? 0));
  return { corpusValueScore: clamp100(100 * (1 - containmentValue)), corpusValueModelVersion: CORPUS_VALUE_MODEL_VERSION };
}

// ============================================================================
// Thresholds
// ============================================================================

export type CorpusAdmissionThresholds = {
  qualityAcceptFloor: SpecifiedValue<number>;
  qualityRejectFloor: SpecifiedValue<number>;
  corpusValueReviewFloor: SpecifiedValue<number>;
};

export const DEFAULT_CORPUS_ADMISSION_THRESHOLDS: CorpusAdmissionThresholds = {
  qualityAcceptFloor: { value: 70, status: "ENGINEERING_DEFAULT", rationale: "Placeholder pending 770-article calibration (spec section 6) — deliberately not presented as a scientifically justified cutoff." },
  qualityRejectFloor: { value: 25, status: "ENGINEERING_DEFAULT", rationale: "Deliberately low, leaving a wide 25-70 REVIEW band — the spec explicitly favors acceptance precision and a healthy REVIEW bucket over a tight, unproven threshold." },
  corpusValueReviewFloor: { value: 50, status: "ENGINEERING_DEFAULT", rationale: "Placeholder — below this, substantial overlap with existing corpus content (short of a hard family match) caps a candidate at REVIEW rather than auto-accepting it." },
};

// ============================================================================
// Decision
// ============================================================================

export type ClassifyCorpusAdmissionInput = {
  hardGate: CorpusHardGateResult;
  format: CorpusSupportedFormat | null;
  family: CorpusFamilyResolution;
  /** null only when text extraction itself failed — a hard-gate failure alone never suppresses quality computation, so the dry-run report can still show a quality score for every candidate that produced text (spec section 7). */
  quality: CorpusQualityScoreResult | null;
  featureVector: CorpusFeatureVector | null;
  corpusValueScore: number | null;
  thresholds?: CorpusAdmissionThresholds;
};

export type CorpusAdmissionClassification = {
  decision: CorpusAdmissionDecision;
  reasonCodes: CorpusAdmissionReasonCode[];
  policyVersion: string;
  qualityScore: number | null;
  corpusValueScore: number | null;
};

const DIAGNOSTIC_FLOOR = 50;

function appendComponentDiagnostics(
  reasonCodes: CorpusAdmissionReasonCode[],
  componentScores: CorpusQualityComponentScores,
  featureVector: CorpusFeatureVector | null,
): void {
  if (componentScores.extractionIntegrity < DIAGNOSTIC_FLOOR) reasonCodes.push("LOW_EXTRACTION_INTEGRITY");
  if (componentScores.linguisticQuality < DIAGNOSTIC_FLOOR) reasonCodes.push("LOW_LINGUISTIC_QUALITY");
  if (componentScores.documentStructure < DIAGNOSTIC_FLOOR) reasonCodes.push("WEAK_DOCUMENT_STRUCTURE");
  if (componentScores.contamination < DIAGNOSTIC_FLOOR) reasonCodes.push("HIGH_CONTAMINATION");
  if (componentScores.redundancy < DIAGNOSTIC_FLOOR) reasonCodes.push("HIGH_INTERNAL_REDUNDANCY");
  if (featureVector) {
    if (componentScores.articleComposition < DIAGNOSTIC_FLOOR && featureVector.articleComposition.referenceSectionProportion > 0.4) {
      reasonCodes.push("REFERENCE_SECTION_DOMINANT");
    }
    if (componentScores.articleComposition < DIAGNOSTIC_FLOOR && featureVector.articleComposition.tableProportion > 0.3) {
      reasonCodes.push("TABLE_CONTENT_DOMINANT");
    }
    if (featureVector.contamination.codeTokenDensityPer1000Words > 30) {
      reasonCodes.push("CODE_CONTENT_DOMINANT");
    }
  }
}

function build(decision: CorpusAdmissionDecision, reasonCodes: CorpusAdmissionReasonCode[], input: ClassifyCorpusAdmissionInput): CorpusAdmissionClassification {
  return {
    decision,
    reasonCodes: [...new Set(reasonCodes)],
    policyVersion: CORPUS_ADMISSION_POLICY_VERSION,
    qualityScore: input.quality?.qualityScore ?? null,
    corpusValueScore: input.corpusValueScore,
  };
}

/**
 * Pure decision function. Step order:
 *   1. Any hard-gate failure -> REJECT, unconditionally (English-only,
 *      3000-word, format/extraction/consent-retention all live here).
 *   2. A family match (exact or edited-version duplicate of an already-
 *      ACCEPTed sample) -> REJECT, before quality is even consulted —
 *      "first accepted sample wins" (requirement 2). This is certainty, not
 *      a judgment call, so it is REJECT rather than REVIEW.
 *   3. Otherwise, quality score drives ACCEPT/REVIEW/REJECT against a wide
 *      REVIEW band.
 *   4. Three cap-only overrides can pull an ACCEPT down to REVIEW (never up,
 *      never to REJECT): uncertain language, a v1-deferred format
 *      (html/md), or low corpus-value (substantial-but-sub-family overlap
 *      with existing corpus content).
 */
export function decideCorpusAdmission(input: ClassifyCorpusAdmissionInput): CorpusAdmissionClassification {
  const thresholds = input.thresholds ?? DEFAULT_CORPUS_ADMISSION_THRESHOLDS;
  const reasonCodes: CorpusAdmissionReasonCode[] = [];

  if (!input.hardGate.passed) {
    reasonCodes.push(...input.hardGate.failureCodes);
    return build("REJECT", reasonCodes, input);
  }
  reasonCodes.push("MEETS_ALL_HARD_GATES");

  if (input.family.relation !== "NONE") {
    reasonCodes.push(input.family.relation === "EXACT_DUPLICATE" ? "DUPLICATE_ALREADY_REPRESENTED" : "EDITED_VERSION_ALREADY_REPRESENTED");
    return build("REJECT", reasonCodes, input);
  }

  if (!input.quality) {
    // Hard gates passed, which requires successful extraction — quality
    // should always be present here. Fail closed rather than accepting.
    return build("REVIEW", reasonCodes, input);
  }

  appendComponentDiagnostics(reasonCodes, input.quality.componentScores, input.featureVector);

  let decision: CorpusAdmissionDecision;
  if (input.quality.qualityScore < thresholds.qualityRejectFloor.value) {
    decision = "REJECT";
    reasonCodes.push("OVERALL_QUALITY_CRITICALLY_LOW");
  } else if (input.quality.qualityScore < thresholds.qualityAcceptFloor.value) {
    decision = "REVIEW";
    reasonCodes.push("OVERALL_QUALITY_BELOW_ACCEPT_THRESHOLD");
  } else {
    decision = "ACCEPT";
    reasonCodes.push("QUALITY_ABOVE_ACCEPT_THRESHOLD");
  }

  if (input.hardGate.languageClass === "UNCERTAIN") {
    reasonCodes.push("LANGUAGE_UNCERTAIN");
    if (decision === "ACCEPT") decision = "REVIEW";
  }
  if (input.format === "html" || input.format === "md") {
    reasonCodes.push("FORMAT_DEFERRED_FOR_V1");
    if (decision === "ACCEPT") decision = "REVIEW";
  }
  if (input.corpusValueScore !== null) {
    if (input.corpusValueScore < thresholds.corpusValueReviewFloor.value) {
      reasonCodes.push("LOW_CORPUS_VALUE");
      if (decision === "ACCEPT") decision = "REVIEW";
    } else if (decision === "ACCEPT") {
      reasonCodes.push("CORPUS_VALUE_ABOVE_ACCEPT_THRESHOLD");
    }
  }

  return build(decision, reasonCodes, input);
}
