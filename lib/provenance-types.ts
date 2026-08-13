/**
 * Phase E1: provenance infrastructure types. This module defines two
 * deliberately separate concepts, per the frozen architecture:
 *
 *  - ProvenanceState: a property of a SOURCE (does this source have
 *    identifiable, acceptable provenance?).
 *  - DocumentRelationshipType: a property of a COMPARISON between two
 *    document identities (lib/document-relationship.ts's SELF/
 *    PRIOR_SUBMISSION, computed entirely independently in Phase C).
 *
 * A source can be provenance_state = VERIFIED_SOURCE while a particular
 * comparison against it is independently relationship_type =
 * PRIOR_SUBMISSION — the two are never collapsed into one axis. Nothing in
 * this file touches, imports, or is imported by lib/document-relationship.ts,
 * lib/document-family.ts, or any similarity-scoring code
 * (app/similarity-worker.ts, lib/report-types.ts, app/page.tsx,
 * lib/receipt-pdf.ts) — see tests/provenance-scoring-invariance.test.mjs,
 * which asserts that structurally.
 */

export const PROVENANCE_STATES = [
  "UNKNOWN",
  "OBSERVED_SUBMISSION",
  "CANDIDATE_SOURCE",
  "PROVENANCE_PENDING",
  "VERIFIED_SOURCE",
  "VERIFICATION_REJECTED",
  "DISPUTED_SOURCE",
  "RETRACTED_SOURCE",
] as const;

export type ProvenanceState = (typeof PROVENANCE_STATES)[number];

const PROVENANCE_STATE_SET: ReadonlySet<string> = new Set(PROVENANCE_STATES);

export function isProvenanceState(value: unknown): value is ProvenanceState {
  return typeof value === "string" && PROVENANCE_STATE_SET.has(value);
}

/**
 * Forward-declared for type-level separation only (see module comment) —
 * PRIOR_SUBMISSION is a relationship type, never a provenance state.
 * lib/document-relationship.ts's real SubmitterRelationship ("SELF" |
 * "PRIOR_SUBMISSION") is the only relationship classifier actually wired up
 * anywhere in this codebase as of Phase E1; VERIFIED_SOURCE_MATCH is listed
 * here only because the frozen architecture names it as the third
 * relationship category a match could eventually carry once VERIFIED_SOURCE
 * scoring exists — no code produces it yet, and this type is not consumed by
 * lib/document-relationship.ts or any relationship-classification logic.
 */
export type DocumentRelationshipType = "SELF" | "PRIOR_SUBMISSION" | "VERIFIED_SOURCE_MATCH";

/**
 * The allowed state graph. Deliberately conservative and extensible rather
 * than exhaustive: every edge here is one this phase's own use cases need
 * (UNKNOWN/OBSERVED_SUBMISSION as starting points, a review pipeline through
 * CANDIDATE_SOURCE -> PROVENANCE_PENDING -> VERIFIED_SOURCE, and the three
 * post-verification outcomes). RETRACTED_SOURCE is treated as terminal (no
 * outgoing edges) — reconsidering a retraction is a future decision, not
 * assumed here. Extend this map, don't bypass it, if a new edge is needed.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ProvenanceState, readonly ProvenanceState[]>> = {
  UNKNOWN: ["CANDIDATE_SOURCE", "OBSERVED_SUBMISSION"],
  OBSERVED_SUBMISSION: ["CANDIDATE_SOURCE"],
  CANDIDATE_SOURCE: ["PROVENANCE_PENDING", "VERIFICATION_REJECTED"],
  PROVENANCE_PENDING: ["VERIFIED_SOURCE", "VERIFICATION_REJECTED"],
  VERIFIED_SOURCE: ["DISPUTED_SOURCE", "RETRACTED_SOURCE"],
  VERIFICATION_REJECTED: ["CANDIDATE_SOURCE"],
  DISPUTED_SOURCE: ["VERIFIED_SOURCE", "RETRACTED_SOURCE", "VERIFICATION_REJECTED"],
  RETRACTED_SOURCE: [],
};

/**
 * A transition is valid only if `to` appears in `from`'s allowed-edges list.
 * Same-state "transitions" (from === to) are never valid — a transition
 * records a state *change*; updating other metadata without changing state
 * is a separate operation (see updateProvenanceSourceMetadata in
 * lib/provenance-registry.ts) and is not logged as a provenance event.
 */
export function isValidProvenanceTransition(from: ProvenanceState, to: ProvenanceState): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * The single source of truth for Core Invariants #6-11: only a source
 * currently in VERIFIED_SOURCE state is eligible to contribute to a future
 * verified-similarity calculation. CANDIDATE_SOURCE, PROVENANCE_PENDING,
 * VERIFICATION_REJECTED, DISPUTED_SOURCE, and RETRACTED_SOURCE are all
 * ineligible — including RETRACTED_SOURCE, which was VERIFIED_SOURCE in the
 * past but is not currently reportable as an active one. Nothing in this
 * phase actually wires this into scoring (that is explicitly out of scope);
 * this function exists so that whenever a later phase does, there is one
 * place encoding the rule rather than a scattered `state === "VERIFIED_SOURCE"`
 * check reinvented at each call site.
 */
export function isEligibleForVerifiedSimilarity(state: ProvenanceState): boolean {
  return state === "VERIFIED_SOURCE";
}

/**
 * Controlled vocabulary for provenance_sources.source_type. Deliberately
 * minimal: only values this phase's own concrete use cases justify.
 * "user_submission" represents a TurnitPlus account's own submitted
 * document, wrapped as OBSERVED_SUBMISSION provenance (see
 * createObservedSubmissionProvenance). "external_reference" is a generic
 * placeholder for a source outside TurnitPlus (a manually-entered candidate
 * citation, for instance) — deliberately coarse, since no specific external
 * system (Wikipedia, OpenAlex, a DOI registry) is wired into this registry
 * in this phase; inventing "wikipedia" or "openalex" as provider values here
 * before either is actually connected to this table would be exactly the
 * unfounded specificity this phase was told not to add. "unknown" covers a
 * source whose very nature (not just its verification status) has not yet
 * been established. Extend this list explicitly when a new provider is
 * actually wired up — do not repurpose "external_reference" as a substitute
 * for adding a real value.
 */
export const SOURCE_PROVIDER_TYPES = ["user_submission", "external_reference", "unknown"] as const;

export type SourceProviderType = (typeof SOURCE_PROVIDER_TYPES)[number];

const SOURCE_PROVIDER_TYPE_SET: ReadonlySet<string> = new Set(SOURCE_PROVIDER_TYPES);

export function isSourceProviderType(value: unknown): value is SourceProviderType {
  return typeof value === "string" && SOURCE_PROVIDER_TYPE_SET.has(value);
}
