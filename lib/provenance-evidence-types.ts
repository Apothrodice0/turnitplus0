/**
 * Phase E4: the evidence-record vocabulary. Companion to
 * lib/provenance-types.ts (which defines ProvenanceState, the source's
 * current status) — this file defines the separate, lower-level concept of
 * *evidence*: individual, immutable, timestamped facts gathered about a
 * provenance_sources row. A source's evidence_level (also defined here) is
 * always DERIVED from its accumulated evidence records by
 * lib/provenance-verification-policy.ts, never stored as an independently
 * settable column — see that file's header comment.
 *
 * Nothing in this file touches, imports, or is imported by
 * lib/document-relationship.ts, lib/document-family.ts, or any
 * similarity-scoring code — see tests/provenance-scoring-invariance.test.mjs.
 */

/**
 * Controlled vocabulary for provenance_evidence.evidence_type. Exactly the
 * fifteen types identified by the Phase E3 design (no more — inventing
 * additional types without a concrete use case is exactly the unfounded
 * specificity that phase's own policy warned against, mirroring
 * lib/provenance-types.ts's SOURCE_PROVIDER_TYPES precedent).
 *
 * A few types deliberately overlap in the *kind* of fact they can carry
 * rather than being merged into one type:
 *  - URL_ACCESSIBILITY vs RETRIEVAL_TIMESTAMP: URL_ACCESSIBILITY records the
 *    outcome of one fetch attempt (reachable or not, at what URL) and may
 *    carry its own retrievedAt; RETRIEVAL_TIMESTAMP exists independently
 *    because "when was this content retrieved" is also a fact for
 *    non-URL retrieval methods (an API/DOI-resolver lookup, for instance)
 *    that never produces a URL_ACCESSIBILITY record at all. Kept separate so
 *    "was it reachable" and "when was it retrieved" can each be recorded
 *    without forcing every retrieval through a URL-shaped record.
 *  - CONTENT_HASH vs CANONICAL_CORRESPONDENCE/STRONG_TEXT_CORRESPONDENCE:
 *    CONTENT_HASH records the raw hash comparison (what was hashed, with
 *    what algorithm); the correspondence types record the *interpretation*
 *    of that comparison (and/or a shingle-containment comparison) against a
 *    specific method and threshold. Kept separate so a hash can be recorded
 *    the moment content is fetched, before any correspondence judgment is
 *    made.
 *  - MIRROR_CONFLICT vs SOURCE_DISPUTE vs RETRACTION: three different kinds
 *    of "something is currently wrong with this source" facts (a competing
 *    copy exists; someone has formally disputed authenticity; the source
 *    itself is withdrawn) — the verification gate's NO_UNRESOLVED_CONFLICT
 *    criterion (lib/provenance-verification-policy.ts) considers all three
 *    together, but they remain distinct evidence types because a reader may
 *    need to know *which* kind of problem was recorded, not just that one
 *    exists.
 */
export const EVIDENCE_TYPES = [
  "URL_ACCESSIBILITY",
  "EXTERNAL_IDENTIFIER",
  "CONTENT_HASH",
  "CANONICAL_CORRESPONDENCE",
  "STRONG_TEXT_CORRESPONDENCE",
  "PASSAGE_CORRESPONDENCE",
  "PUBLISHER_IDENTITY",
  "SOURCE_CLASS",
  "RETRIEVAL_TIMESTAMP",
  "DISCOVERY_INDEPENDENCE",
  "METADATA",
  "MIRROR_CONFLICT",
  "SOURCE_DISPUTE",
  "RETRACTION",
  "OTHER",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

const EVIDENCE_TYPE_SET: ReadonlySet<string> = new Set(EVIDENCE_TYPES);

export function isEvidenceType(value: unknown): value is EvidenceType {
  return typeof value === "string" && EVIDENCE_TYPE_SET.has(value);
}

/**
 * The Phase E3 evidence levels, in ascending order of strength. A derived
 * value only (lib/provenance-verification-policy.ts's deriveEvidenceLevel)
 * — never a column, never independently settable. PROVENANCE_VERIFIED is
 * deliberately the only level that requires more than text/content
 * correspondence; see that module for why similarity alone can never reach
 * it.
 */
export const EVIDENCE_LEVELS = [
  "NO_EVIDENCE",
  "WEAK_DISCOVERY",
  "CANDIDATE_CORRESPONDENCE",
  "STRONG_CORRESPONDENCE",
  "PROVENANCE_VERIFIED",
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

const EVIDENCE_LEVEL_SET: ReadonlySet<string> = new Set(EVIDENCE_LEVELS);

export function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return typeof value === "string" && EVIDENCE_LEVEL_SET.has(value);
}

/**
 * The Phase E3 independence rule's vocabulary (design section 6). Recorded
 * on a DISCOVERY_INDEPENDENCE evidence record's payload. Deliberately only
 * three values, matching the design document exactly — this is the
 * vocabulary lib/provenance-verification-policy.ts's INDEPENDENT_DISCOVERY
 * criterion enforces: USER_SUPPLIED and DERIVED_FROM_SUBMISSION_TEXT_ONLY
 * can never satisfy that criterion, regardless of any other field on the
 * same payload (see that module's header comment for why the policy layer,
 * not the evidence payload, is the authority on this).
 */
export const DISCOVERY_TYPES = [
  "INDEPENDENT_DISCOVERY",
  "USER_SUPPLIED",
  "DERIVED_FROM_SUBMISSION_TEXT_ONLY",
] as const;

export type DiscoveryType = (typeof DISCOVERY_TYPES)[number];

const DISCOVERY_TYPE_SET: ReadonlySet<string> = new Set(DISCOVERY_TYPES);

export function isDiscoveryType(value: unknown): value is DiscoveryType {
  return typeof value === "string" && DISCOVERY_TYPE_SET.has(value);
}

// --- Structured payload shapes, per evidence type ---------------------------
//
// Only the types the Phase E4 verification gate actually reads
// (lib/provenance-verification-policy.ts) get a specific interface; the
// remaining types (PASSAGE_CORRESPONDENCE, METADATA, OTHER) are informational
// only in this phase and use a plain JSON-object shape — a small payload,
// per the task's own instruction not to over-engineer a schema no current
// code needs.

export type UrlAccessibilityPayload = {
  url: string;
  httpStatus: number | null;
  retrievedAt: string | null;
  accessible: boolean;
};

export type ExternalIdentifierPayload = {
  identifierType: string;
  identifierValue: string;
  url?: string | null;
};

export type ContentHashPayload = {
  candidateHash: string;
  externalHash: string;
  algorithm: string;
  match: boolean;
};

export type CanonicalCorrespondencePayload = {
  method: "canonical_hash";
  match: boolean;
};

export type StrongTextCorrespondencePayload = {
  method: "shingle_containment";
  containment: number;
  threshold: number;
  match: boolean;
};

export type PassageCorrespondencePayload = Record<string, unknown>;

export type PublisherIdentityPayload = {
  publisher: string;
  domain?: string | null;
};

export type SourceClassPayload = {
  sourceClass: string;
  eligibleForVerification: boolean;
};

export type RetrievalTimestampPayload = {
  retrievedAt: string;
};

export type DiscoveryIndependencePayload = {
  discoveryType: DiscoveryType;
  independent: boolean;
  basis?: string | null;
};

export type MetadataPayload = Record<string, unknown>;

export type MirrorConflictPayload = {
  description: string;
  resolved: boolean;
  conflictingUrl?: string | null;
};

export type SourceDisputePayload = {
  description: string;
  resolved: boolean;
};

export type RetractionPayload = {
  description: string;
  active: boolean;
};

export type OtherPayload = Record<string, unknown>;

/** Union of every recognized evidence payload shape, keyed by evidence type. Not exhaustive-checked at runtime (see this module's own header comment on the "honest functions, TS-enforced" convention) — callers pass the shape matching the evidenceType they choose. */
export type EvidencePayloadByType = {
  URL_ACCESSIBILITY: UrlAccessibilityPayload;
  EXTERNAL_IDENTIFIER: ExternalIdentifierPayload;
  CONTENT_HASH: ContentHashPayload;
  CANONICAL_CORRESPONDENCE: CanonicalCorrespondencePayload;
  STRONG_TEXT_CORRESPONDENCE: StrongTextCorrespondencePayload;
  PASSAGE_CORRESPONDENCE: PassageCorrespondencePayload;
  PUBLISHER_IDENTITY: PublisherIdentityPayload;
  SOURCE_CLASS: SourceClassPayload;
  RETRIEVAL_TIMESTAMP: RetrievalTimestampPayload;
  DISCOVERY_INDEPENDENCE: DiscoveryIndependencePayload;
  METADATA: MetadataPayload;
  MIRROR_CONFLICT: MirrorConflictPayload;
  SOURCE_DISPUTE: SourceDisputePayload;
  RETRACTION: RetractionPayload;
  OTHER: OtherPayload;
};
