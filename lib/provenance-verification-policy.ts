import type { EvidenceType, EvidenceLevel } from "./provenance-evidence-types";

/**
 * Phase E4: the pure provenance verification policy. This module has no
 * database client, no network access, and no side effects of any kind — it
 * only reads an already-fetched array of evidence records and returns a
 * judgment. It never calls lib/provenance-registry.ts's
 * transitionProvenanceState, never imports @libsql/client, and never mutates
 * anything it is given (see tests/provenance-scoring-invariance.test.mjs,
 * extended in this phase to assert this structurally). Deciding to actually
 * act on evaluateVerificationEligibility's output (e.g. moving a source from
 * PROVENANCE_PENDING to VERIFIED_SOURCE) is a future, separately-approved
 * workflow's job — see this phase's own task description, section 11.
 *
 * Two composed layers:
 *  1. evaluateVerificationGate — the Phase E3 nine-criterion checklist for
 *     PROVENANCE_VERIFIED eligibility. A conjunctive AND-gate, deliberately
 *     not a weighted score: meeting 8 of 9 criteria is not "89% verified",
 *     it is not eligible.
 *  2. deriveEvidenceLevel — the five-level evidence ladder
 *     (NO_EVIDENCE..PROVENANCE_VERIFIED). Only its top level requires the
 *     full gate; the lower levels describe correspondence/discovery
 *     progress on their own, so a source can visibly be "close" without
 *     ever being reported as verified.
 *
 * evaluateVerificationEligibility composes both, matching the shape E3
 * proposed: { eligible, evidenceLevel, satisfied, missing }.
 */

/** A single evidence record, as read from lib/provenance-evidence.ts's ProvenanceEvidence — structurally compatible, but declared independently here so this module stays decoupled from the repository/DB layer. */
export type EvidenceRecordInput = {
  /** Optional: pure unit tests may omit this. When present, used only as a stable tiebreaker for records sharing the same observedAt. */
  id?: number;
  evidenceType: EvidenceType;
  payload: Record<string, unknown>;
  /** ISO-8601 (or any consistently-formatted, lexicographically-sortable) timestamp — the same convention as every other app-supplied timestamp field in provenance_sources. Determines "latest" for evidence types where the current fact matters (e.g. accessibility), not just whether it was ever recorded. */
  observedAt: string;
};

/**
 * The Phase E3 nine verification criteria, in the fixed order they are
 * always reported in (independent of evidence input order — see
 * deriveEvidenceLevel's determinism note below).
 */
export const VERIFICATION_CRITERIA = [
  "EXTERNAL_ANCHOR",
  "ACCEPTABLE_SOURCE_CLASS",
  "IDENTIFIABLE_PUBLISHER",
  "STRONG_CORRESPONDENCE",
  "RETRIEVAL_TIMESTAMP_RECORDED",
  "RETRIEVED_CONTENT_HASH",
  "ACCESSIBILITY_CONFIRMED",
  "NO_UNRESOLVED_CONFLICT",
  "INDEPENDENT_DISCOVERY",
] as const;

export type VerificationCriterion = (typeof VERIFICATION_CRITERIA)[number];

export type VerificationGateResult = {
  satisfied: VerificationCriterion[];
  missing: VerificationCriterion[];
  eligible: boolean;
};

export type VerificationEligibilityResult = {
  eligible: boolean;
  evidenceLevel: EvidenceLevel;
  satisfied: VerificationCriterion[];
  missing: VerificationCriterion[];
};

// --- Determinism helpers -----------------------------------------------------

/**
 * Sorts records by observedAt ascending, then by id ascending as a
 * tiebreaker. This is what makes every function below produce the same
 * result regardless of the order evidence records are passed in (Edge case
 * I) — the caller's array order is never trusted. Records that share both
 * the same observedAt and no id fall back to their relative position in the
 * input array (Array.prototype.sort is stable) — callers should give each
 * evidence record its own distinct observedAt, which is both realistic
 * (each row records a separate observation) and necessary for fully
 * order-independent results in that edge case.
 */
function sortedByObservedAt(records: readonly EvidenceRecordInput[]): EvidenceRecordInput[] {
  return [...records].sort((a, b) => {
    if (a.observedAt < b.observedAt) return -1;
    if (a.observedAt > b.observedAt) return 1;
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

/** The most recent record (by observedAt, then id) whose evidenceType is one of `types`, or undefined if none exists. "Most recent wins" is what lets a later negative fact correctly supersede an earlier positive one (Edge case K) without deleting or mutating the earlier record (Edge case L) — both remain in the input array; only the *interpretation* changes. */
function latestOfTypes(records: readonly EvidenceRecordInput[], types: readonly EvidenceType[]): EvidenceRecordInput | undefined {
  const typeSet = new Set<EvidenceType>(types);
  const matching = sortedByObservedAt(records).filter((r) => typeSet.has(r.evidenceType));
  return matching.at(-1);
}

/** Whether any record (at any time — presence, not recency, is what matters for these facts) of one of `types` satisfies `predicate`. Used for facts that, once true, stay true (e.g. "a retrieval timestamp was recorded") rather than facts whose *current* value matters (which use latestOfTypes instead). */
function anyOfTypes(records: readonly EvidenceRecordInput[], types: readonly EvidenceType[], predicate: (payload: Record<string, unknown>) => boolean): boolean {
  const typeSet = new Set<EvidenceType>(types);
  return records.some((r) => typeSet.has(r.evidenceType) && predicate(r.payload));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// --- Per-criterion checks (Phase E3 design section 4 / this phase's section 8) --

/** Criterion 1: an identifiable external URL OR a stable external identifier has been recorded, ever. Whether it is *currently reachable* is a separate criterion (ACCESSIBILITY_CONFIRMED) — identifying an anchor does not un-happen when a later fetch fails. */
function hasExternalAnchor(records: readonly EvidenceRecordInput[]): boolean {
  return (
    anyOfTypes(records, ["EXTERNAL_IDENTIFIER"], (p) => isNonEmptyString(p.identifierValue)) ||
    anyOfTypes(records, ["URL_ACCESSIBILITY"], (p) => isNonEmptyString(p.url))
  );
}

/** Criterion 2: the most recently recorded source-class judgment says this source's class is eligible for verification (Phase E3 design section 3 — aggregators, forums, social media, and unknown sources are excluded by default). */
function hasAcceptableSourceClass(records: readonly EvidenceRecordInput[]): boolean {
  const latest = latestOfTypes(records, ["SOURCE_CLASS"]);
  return latest?.payload.eligibleForVerification === true;
}

/** Criterion 3: a publisher/provider has been named. "Identifiable" only — legitimacy judgment is folded into ACCEPTABLE_SOURCE_CLASS and, ultimately, human review (this phase's section 11), not this criterion. */
function hasIdentifiablePublisher(records: readonly EvidenceRecordInput[]): boolean {
  const latest = latestOfTypes(records, ["PUBLISHER_IDENTITY"]);
  return isNonEmptyString(latest?.payload.publisher);
}

/** Criterion 4: exact canonical correspondence OR strong configured text correspondence, per the most recent correspondence judgment of either kind. This is the ONLY criterion similarity evidence can satisfy — meeting it alone never satisfies the other eight, which is what stops "strong text similarity alone" from ever reaching PROVENANCE_VERIFIED (Edge case A). */
function hasStrongCorrespondence(records: readonly EvidenceRecordInput[]): boolean {
  const latest = latestOfTypes(records, ["CANONICAL_CORRESPONDENCE", "STRONG_TEXT_CORRESPONDENCE"]);
  return latest?.payload.match === true;
}

/** Criterion 5: a retrieval timestamp was recorded, ever (via a dedicated RETRIEVAL_TIMESTAMP record, or as part of a URL_ACCESSIBILITY record). */
function hasRetrievalTimestamp(records: readonly EvidenceRecordInput[]): boolean {
  return (
    anyOfTypes(records, ["RETRIEVAL_TIMESTAMP"], (p) => isNonEmptyString(p.retrievedAt)) ||
    anyOfTypes(records, ["URL_ACCESSIBILITY"], (p) => isNonEmptyString(p.retrievedAt))
  );
}

/** Criterion 6: the content actually retrieved was hashed, ever. */
function hasRetrievedContentHash(records: readonly EvidenceRecordInput[]): boolean {
  return anyOfTypes(records, ["CONTENT_HASH"], (p) => isNonEmptyString(p.externalHash));
}

/** Criterion 7: the source is *currently* accessible, per the most recent accessibility check — deliberately recency-sensitive (Edge case K): an old HTTP 200 does not outrank a newer HTTP 404. */
function isAccessibilityConfirmed(records: readonly EvidenceRecordInput[]): boolean {
  const latest = latestOfTypes(records, ["URL_ACCESSIBILITY"]);
  return latest?.payload.accessible === true;
}

/** Criterion 8: no currently-unresolved mirror/impersonation conflict, dispute, or retraction. All three evidence types are considered together — see lib/provenance-evidence-types.ts's header comment for why they stay distinct evidence types while sharing one criterion — and each is judged by its own most recent record, independently. */
function hasNoUnresolvedConflict(records: readonly EvidenceRecordInput[]): boolean {
  const mirror = latestOfTypes(records, ["MIRROR_CONFLICT"]);
  if (mirror && mirror.payload.resolved !== true) return false;
  const dispute = latestOfTypes(records, ["SOURCE_DISPUTE"]);
  if (dispute && dispute.payload.resolved !== true) return false;
  const retraction = latestOfTypes(records, ["RETRACTION"]);
  if (retraction && retraction.payload.active === true) return false;
  return true;
}

/**
 * Criterion 9: discovery of this source was independent of the very
 * submission being justified (Phase E3 design section 6). The authority
 * here is the most recent record's `discoveryType` value, NOT the
 * `independent` boolean the payload also carries — a payload claiming
 * discoveryType "USER_SUPPLIED" or "DERIVED_FROM_SUBMISSION_TEXT_ONLY"
 * can never satisfy this criterion even if `independent` were mistakenly
 * (or maliciously) set to true (Edge cases E and F). This is precisely the
 * poisoning defense E3's design section 14, Case B describes: a user
 * supplying their own "external" copy must never be able to talk its way
 * into VERIFIED_SOURCE by asserting independence.
 */
function isDiscoveryIndependent(records: readonly EvidenceRecordInput[]): boolean {
  const latest = latestOfTypes(records, ["DISCOVERY_INDEPENDENCE"]);
  if (!latest) return false;
  return latest.payload.discoveryType === "INDEPENDENT_DISCOVERY" && latest.payload.independent !== false;
}

const CRITERION_CHECKS: Record<VerificationCriterion, (records: readonly EvidenceRecordInput[]) => boolean> = {
  EXTERNAL_ANCHOR: hasExternalAnchor,
  ACCEPTABLE_SOURCE_CLASS: hasAcceptableSourceClass,
  IDENTIFIABLE_PUBLISHER: hasIdentifiablePublisher,
  STRONG_CORRESPONDENCE: hasStrongCorrespondence,
  RETRIEVAL_TIMESTAMP_RECORDED: hasRetrievalTimestamp,
  RETRIEVED_CONTENT_HASH: hasRetrievedContentHash,
  ACCESSIBILITY_CONFIRMED: isAccessibilityConfirmed,
  NO_UNRESOLVED_CONFLICT: hasNoUnresolvedConflict,
  INDEPENDENT_DISCOVERY: isDiscoveryIndependent,
};

/**
 * The Phase E3 nine-criterion gate. A pure conjunctive checklist — eligible
 * only when every criterion is satisfied. Never produces or consumes a
 * percentage/confidence score (per this phase's explicit instruction).
 */
export function evaluateVerificationGate(evidenceRecords: readonly EvidenceRecordInput[]): VerificationGateResult {
  const satisfied: VerificationCriterion[] = [];
  const missing: VerificationCriterion[] = [];
  for (const criterion of VERIFICATION_CRITERIA) {
    if (CRITERION_CHECKS[criterion](evidenceRecords)) satisfied.push(criterion);
    else missing.push(criterion);
  }
  return { satisfied, missing, eligible: missing.length === 0 };
}

const CORRESPONDENCE_ATTEMPT_TYPES: readonly EvidenceType[] = [
  "CANONICAL_CORRESPONDENCE",
  "STRONG_TEXT_CORRESPONDENCE",
  "PASSAGE_CORRESPONDENCE",
];

/**
 * The Phase E3 five-level evidence ladder. Reuses `gate` (already computed
 * by the caller) rather than re-deriving STRONG_CORRESPONDENCE, so the two
 * functions can never disagree about whether strong correspondence holds.
 *
 * NO_EVIDENCE: no evidence records at all.
 * WEAK_DISCOVERY: some evidence exists, but no correspondence has been
 *   attempted yet (no CANONICAL_/STRONG_TEXT_/PASSAGE_CORRESPONDENCE record).
 * CANDIDATE_CORRESPONDENCE: correspondence has been attempted but is not
 *   (yet) strong — e.g. a STRONG_TEXT_CORRESPONDENCE record below threshold,
 *   or only passage-level overlap.
 * STRONG_CORRESPONDENCE: exact canonical or strong text correspondence
 *   holds, but the full nine-criterion gate is not yet satisfied.
 * PROVENANCE_VERIFIED: strong correspondence AND the full gate are both
 *   satisfied. This is the only level similarity evidence can never reach on
 *   its own — see hasStrongCorrespondence's own comment (Edge cases A-D,H).
 */
export function deriveEvidenceLevel(evidenceRecords: readonly EvidenceRecordInput[], gate: VerificationGateResult): EvidenceLevel {
  if (evidenceRecords.length === 0) return "NO_EVIDENCE";
  const strongCorrespondence = gate.satisfied.includes("STRONG_CORRESPONDENCE");
  if (strongCorrespondence) {
    return gate.eligible ? "PROVENANCE_VERIFIED" : "STRONG_CORRESPONDENCE";
  }
  const correspondenceAttempted = evidenceRecords.some((r) => CORRESPONDENCE_ATTEMPT_TYPES.includes(r.evidenceType));
  return correspondenceAttempted ? "CANDIDATE_CORRESPONDENCE" : "WEAK_DISCOVERY";
}

/**
 * The composed, top-level Phase E3 function: given a source's full evidence
 * history, what is its evidence level, and is it eligible for
 * PROVENANCE_VERIFIED? Deterministic and side-effect free — see this
 * module's header comment. Does NOT transition any provenance_sources row;
 * a caller who wants to act on `eligible` must do so through
 * lib/provenance-registry.ts's transitionProvenanceState separately (this
 * phase's section 11 — that workflow is explicitly out of scope here).
 */
export function evaluateVerificationEligibility(evidenceRecords: readonly EvidenceRecordInput[]): VerificationEligibilityResult {
  const gate = evaluateVerificationGate(evidenceRecords);
  const evidenceLevel = deriveEvidenceLevel(evidenceRecords, gate);
  return {
    eligible: evidenceLevel === "PROVENANCE_VERIFIED",
    evidenceLevel,
    satisfied: gate.satisfied,
    missing: gate.missing,
  };
}
