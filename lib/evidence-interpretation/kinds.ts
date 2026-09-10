/**
 * Evidence Interpretation Layer — the six approved user-facing V1 kinds.
 *
 * This is the report-/evidence-level home of the interpretation vocabulary.
 * lib/selective-corpus/ is ONE evidence producer that feeds this layer — it is
 * not special. Nothing here re-runs the matcher / STRICT_SPAN / FAMILY_GUARD /
 * co-source attribution / computeUnifiedSimilarity, changes a matched position,
 * or produces an adjusted similarity number.
 */

export const EVIDENCE_INTERPRETATION_VERSION = "evidence-interpretation-v1.1";

export type EvidenceInterpretationKind =
  | "DECLARED_QUOTATION"
  | "ATTRIBUTED_QUOTATION"
  | "POSSIBLE_SAME_WORK"
  | "FAMILY_BOILERPLATE"
  | "LEGITIMATE_ALTERNATE_SOURCE"
  | "DISTINCTIVE_EXTERNAL_MATCH";

export const EVIDENCE_INTERPRETATION_KINDS: readonly EvidenceInterpretationKind[] = [
  "DECLARED_QUOTATION",
  "ATTRIBUTED_QUOTATION",
  "POSSIBLE_SAME_WORK",
  "FAMILY_BOILERPLATE",
  "LEGITIMATE_ALTERNATE_SOURCE",
  "DISTINCTIVE_EXTERNAL_MATCH",
];

/**
 * COMMON_DEFINITION and COMMON_ACADEMIC_LANGUAGE are DELIBERATELY absent from
 * the user-facing V1 vocabulary — the evidence-interpretation-v1 benchmark
 * showed their recall is corpus-scale limited and their signals are not yet
 * reliable enough for a user-facing label. A span that would be one of those
 * falls through to DISTINCTIVE_EXTERNAL_MATCH.
 */
export const DEFERRED_INTERNAL_KINDS = ["COMMON_DEFINITION", "COMMON_ACADEMIC_LANGUAGE"] as const;

export type EvidenceInterpretationConfidence = "high" | "medium" | "low";

/** Presentation tone — drives the Report V2 highlight style. Never "alarming". */
export type EvidenceInterpretationTone = "neutral" | "informational" | "review";

export const TONE_BY_KIND: Readonly<Record<EvidenceInterpretationKind, EvidenceInterpretationTone>> = {
  DISTINCTIVE_EXTERNAL_MATCH: "review",
  ATTRIBUTED_QUOTATION: "informational",
  DECLARED_QUOTATION: "informational",
  LEGITIMATE_ALTERNATE_SOURCE: "neutral",
  POSSIBLE_SAME_WORK: "review",
  FAMILY_BOILERPLATE: "neutral",
};

/**
 * When a single submission POSITION is covered by spans of different kinds
 * (multiple sources, or overlapping spans of the same source), it is assigned
 * to exactly ONE kind by this precedence — highest wins — so `positionsByKind`
 * is a DISJOINT partition of the authoritative matched-position union and its
 * totals reconcile exactly with the headline similarity.
 */
export const KIND_PRECEDENCE: readonly EvidenceInterpretationKind[] = [
  "POSSIBLE_SAME_WORK",
  "FAMILY_BOILERPLATE",
  "ATTRIBUTED_QUOTATION",
  "DECLARED_QUOTATION",
  "LEGITIMATE_ALTERNATE_SOURCE",
  "DISTINCTIVE_EXTERNAL_MATCH",
];

export function moreSpecificKind(
  a: EvidenceInterpretationKind,
  b: EvidenceInterpretationKind,
): EvidenceInterpretationKind {
  return KIND_PRECEDENCE.indexOf(a) <= KIND_PRECEDENCE.indexOf(b) ? a : b;
}

/**
 * An EXISTING, trusted work/version relationship between a matched source and
 * the submission — produced by another subsystem, NEVER derived in this layer
 * (and NEVER from overlap percentage, Device Passport alone, same account
 * alone, or same device alone). Its presence is the ONLY thing that produces
 * POSSIBLE_SAME_WORK.
 *
 * `evidence` is a coarse, non-sensitive category label — no identifier, hash,
 * path, account, passport id, or provenance internal, and never echoed verbatim
 * into a user-facing `reasons` phrase.
 */
export type SameWorkRelationship = {
  evidence:
    | "CANONICAL_WORK_IDENTITY" // same canonical work / version id
    | "EXPLICIT_PRIOR_VERSION" // an explicit prior-/later-version relationship
    | "TRUSTED_SAME_WORK_METADATA"; // a same-work relationship asserted by a trusted subsystem
};
