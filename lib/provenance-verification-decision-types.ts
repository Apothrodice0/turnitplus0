/**
 * Phase E5: controlled vocabularies for the verification-decision workflow.
 * Companion to lib/provenance-types.ts (ProvenanceState) and
 * lib/provenance-evidence-types.ts (EvidenceType/EvidenceLevel) — this file
 * adds the two vocabularies a verification *decision* needs that neither of
 * those cover: who/what made the decision, and what the decision actually
 * was.
 */

/**
 * Who/what is allowed to make a verification decision. Deliberately does
 * NOT reference any real user/account identity — this application has no
 * admin role or reviewer-permission model yet, and inventing one here would
 * be exactly the unfounded architecture this phase was told not to add (see
 * this phase's own task description, section 4). A method value is a
 * category of decision-making process, not a "who": SYSTEM_POLICY (an
 * automated, deterministic policy decision — e.g. a rejection issued purely
 * because the source class is ineligible, with no human judgment involved),
 * HUMAN_REVIEW (a person looked at the evidence and decided), ADMIN_REVIEW
 * (a person with elevated review responsibility decided — kept distinct
 * from HUMAN_REVIEW for future use once/if an actual admin role exists;
 * nothing today enforces that distinction beyond the label itself),
 * IMPORTED_TRUSTED_SOURCE (the decision was inherited from an already-
 * trusted external determination, e.g. bulk-importing sources a prior,
 * out-of-band review already verified — recorded honestly as "imported,"
 * not fabricated as HUMAN_REVIEW).
 */
export const VERIFICATION_METHODS = [
  "SYSTEM_POLICY",
  "HUMAN_REVIEW",
  "ADMIN_REVIEW",
  "IMPORTED_TRUSTED_SOURCE",
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

const VERIFICATION_METHOD_SET: ReadonlySet<string> = new Set(VERIFICATION_METHODS);

export function isVerificationMethod(value: unknown): value is VerificationMethod {
  return typeof value === "string" && VERIFICATION_METHOD_SET.has(value);
}

/**
 * The outcome recorded on a verification-decision row. Four correspond
 * 1:1 with the four state-changing workflow actions
 * (lib/provenance-verification-workflow.ts's approveVerification /
 * rejectVerification / recordDispute / recordRetraction); REAFFIRMED is
 * distinct from APPROVED specifically so a "reviewed, nothing changed"
 * decision (Phase E3 design section 7 — new evidence arrives on an
 * already-VERIFIED_SOURCE and a reviewer confirms it still holds) is never
 * recorded as if a fresh approval/transition had occurred, when in fact no
 * provenance_events row was written for it at all — see
 * reaffirmVerification's own comment.
 */
export const VERIFICATION_DECISION_OUTCOMES = [
  "APPROVED",
  "REJECTED",
  "DISPUTED",
  "RETRACTED",
  "REAFFIRMED",
] as const;

export type VerificationDecisionOutcome = (typeof VERIFICATION_DECISION_OUTCOMES)[number];

const VERIFICATION_DECISION_OUTCOME_SET: ReadonlySet<string> = new Set(VERIFICATION_DECISION_OUTCOMES);

export function isVerificationDecisionOutcome(value: unknown): value is VerificationDecisionOutcome {
  return typeof value === "string" && VERIFICATION_DECISION_OUTCOME_SET.has(value);
}
