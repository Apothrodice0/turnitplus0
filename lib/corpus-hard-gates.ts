import type { detectLanguage } from "./similarity-core";
import type { CorpusConsentEvidence, CorpusHardGateCode, SpecifiedValue } from "./corpus-admission-types";
import type { CorpusFileValidationResult } from "./corpus-file-validation";
import type { CorpusExtractionResult } from "./corpus-text-extraction";

/**
 * Pure hard-gate evaluation (requirement 1's "English-only" reversal of the
 * earlier "language gate is a no-op" draft, plus the original spec's other
 * 5 hard gates). Takes already-computed inputs — computes no signal
 * itself, does no I/O — exactly the discipline this codebase's other pure
 * policy/spec modules already established.
 *
 * The 3000-word minimum and the English-only gate here are
 * corpus-admission-only: this module is never imported by
 * app/api/reports/route.ts, app/page.tsx, or app/ai-detector-worker.ts, so
 * ordinary report checking keeps accepting any length/language exactly as
 * today. See tests/corpus-admission-privacy.test.mjs.
 */

export const CORPUS_HARD_GATE_POLICY_VERSION = "corpus-hard-gates-v1";

export type CorpusLanguageAdmissionClass = "CONFIDENT_ENGLISH" | "CONFIDENT_NON_ENGLISH" | "UNCERTAIN";

export type CorpusHardGateThresholds = {
  minimumWords: SpecifiedValue<number>;
  /** Below this, classifyLanguageForAdmission returns UNCERTAIN regardless of the detected label — catches "Mixed" (pinned low by construction in lib/corpus-quality-signals.ts) and any low-confidence single-language guess alike. */
  languageConfidenceFloor: SpecifiedValue<number>;
};

export const DEFAULT_CORPUS_HARD_GATE_THRESHOLDS: CorpusHardGateThresholds = {
  minimumWords: { value: 3000, status: "ENGINEERING_DEFAULT", rationale: "Directly specified by the corpus-admission requirements (not statistically calibrated); corpus-admission-only, never applied to ordinary report checking." },
  languageConfidenceFloor: { value: 0.65, status: "ENGINEERING_DEFAULT", rationale: "Placeholder pending 770-article calibration (spec section 6) — chosen to comfortably exceed the 0.5 confidence lib/corpus-quality-signals.ts pins 'Mixed' detections to, so ambiguous documents reliably land as UNCERTAIN rather than slipping through as falsely confident." },
};

/**
 * Reuses the SAME underlying script-ratio/French-stopword confidence
 * lib/corpus-quality-signals.ts already derives (passed in, not
 * recomputed) — this function only applies the admission-specific decision
 * boundary on top of it. "Mixed" and any low-confidence guess both resolve
 * to UNCERTAIN; only a confident non-English detection is NOT_ENGLISH.
 */
export function classifyLanguageForAdmission(
  detectedLanguage: ReturnType<typeof detectLanguage> | null,
  languageConfidence: number | null,
  thresholds: CorpusHardGateThresholds = DEFAULT_CORPUS_HARD_GATE_THRESHOLDS,
): CorpusLanguageAdmissionClass {
  if (detectedLanguage === null || languageConfidence === null) return "UNCERTAIN";
  if (languageConfidence < thresholds.languageConfidenceFloor.value) return "UNCERTAIN";
  return detectedLanguage === "English" ? "CONFIDENT_ENGLISH" : "CONFIDENT_NON_ENGLISH";
}

export type CorpusHardGateInput = {
  fileValidation: CorpusFileValidationResult;
  /** null when extraction was never attempted (file validation already failed) — never treated as an implicit pass. */
  extraction: CorpusExtractionResult | null;
  wordCount: number | null;
  detectedLanguage: ReturnType<typeof detectLanguage> | null;
  languageConfidence: number | null;
  consent: CorpusConsentEvidence;
  thresholds?: CorpusHardGateThresholds;
};

export type CorpusHardGateResult = {
  passed: boolean;
  failureCodes: CorpusHardGateCode[];
  languageClass: CorpusLanguageAdmissionClass;
};

function consentSatisfied(consent: CorpusConsentEvidence): boolean {
  return consent.kind === "PER_USER_CONSENT" ? consent.consented === true : consent.provenance.retentionRightsResolved === true;
}

export function evaluateCorpusHardGates(input: CorpusHardGateInput): CorpusHardGateResult {
  const thresholds = input.thresholds ?? DEFAULT_CORPUS_HARD_GATE_THRESHOLDS;
  const failureCodes: CorpusHardGateCode[] = [];
  let languageClass: CorpusLanguageAdmissionClass = "UNCERTAIN";

  if (!input.fileValidation.ok) {
    failureCodes.push(input.fileValidation.reasonCode);
  } else if (input.extraction === null) {
    failureCodes.push("EXTRACTION_FAILED");
  } else if (!input.extraction.ok) {
    failureCodes.push(input.extraction.reasonCode);
  } else {
    if (input.wordCount === null || input.wordCount < thresholds.minimumWords.value) {
      failureCodes.push("WORD_COUNT_BELOW_MINIMUM");
    }
    languageClass = classifyLanguageForAdmission(input.detectedLanguage, input.languageConfidence, thresholds);
    if (languageClass === "CONFIDENT_NON_ENGLISH") {
      failureCodes.push("NOT_ENGLISH");
    }
  }

  if (!consentSatisfied(input.consent)) {
    failureCodes.push(input.consent.kind === "PER_USER_CONSENT" ? "CONSENT_MISSING" : "RETENTION_REQUIREMENT_UNMET");
  }

  return { passed: failureCodes.length === 0, failureCodes, languageClass };
}
