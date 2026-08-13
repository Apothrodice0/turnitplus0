import type { SourceClass } from "./source-class";
import type { DiscoveryType } from "./provenance-evidence-types";

/**
 * Phase E6A: source discovery architecture — shared vocabulary and shapes.
 *
 * The whole point of this module (and everything else in this phase) is
 * that a discovery result is NOT a provenance verification. Nothing here
 * can move a provenance_sources row to VERIFIED_SOURCE — the only functions
 * that can do that live in lib/provenance-verification-workflow.ts (E5),
 * and this phase does not call them. See lib/discovery-provenance-bridge.ts
 * for the one narrow, already-safe connection point this phase does add:
 * a discovery candidate can become a CANDIDATE_SOURCE (the weakest,
 * unverified starting state E1 already defines) plus a DISCOVERY_INDEPENDENCE
 * evidence record (E4) describing how it was found — never anything
 * stronger.
 */

/**
 * Who/what supplied a discovery result. USER_SUPPLIED is deliberately
 * distinguished from every other type: per Phase E3's independence rule
 * (lib/provenance-verification-policy.ts's INDEPENDENT_DISCOVERY criterion),
 * a user-supplied candidate can never by itself satisfy independence — see
 * deriveCandidateIndependence in lib/discovery-candidates.ts.
 */
export const DISCOVERY_PROVIDER_TYPES = [
  "WEB_SEARCH",
  "ACADEMIC_INDEX",
  "DOI_LOOKUP",
  "REPOSITORY",
  "PUBLISHER",
  "USER_SUPPLIED",
] as const;

export type DiscoveryProviderType = (typeof DISCOVERY_PROVIDER_TYPES)[number];

const DISCOVERY_PROVIDER_TYPE_SET: ReadonlySet<string> = new Set(DISCOVERY_PROVIDER_TYPES);

export function isDiscoveryProviderType(value: unknown): value is DiscoveryProviderType {
  return typeof value === "string" && DISCOVERY_PROVIDER_TYPE_SET.has(value);
}

/**
 * Why a discovery request was made. Deliberately minimal — only the use
 * cases already named across E3/E5/E6A's own task descriptions
 * (a live submission being checked for correspondence; a deliberate,
 * human-initiated pass over the legacy 230-document archive per E3 design
 * section 9; ad hoc manual research/candidate registration per E3 design
 * section 10). Extend explicitly when a new real use case exists — do not
 * repurpose MANUAL_RESEARCH as a stand-in for a use case that deserves its
 * own value.
 */
export const DISCOVERY_PURPOSES = ["SUBMISSION_CORRESPONDENCE", "LEGACY_BACKFILL", "MANUAL_RESEARCH"] as const;

export type DiscoveryPurpose = (typeof DISCOVERY_PURPOSES)[number];

const DISCOVERY_PURPOSE_SET: ReadonlySet<string> = new Set(DISCOVERY_PURPOSES);

export function isDiscoveryPurpose(value: unknown): value is DiscoveryPurpose {
  return typeof value === "string" && DISCOVERY_PURPOSE_SET.has(value);
}

/**
 * The outcome of one provider attempt. "NO_RESULTS" is deliberately
 * distinct from every failure status, and from the absence of a row
 * altogether — per this phase's Case E, "no candidate was discovered by
 * this provider" is never conflated with "no source exists." See this
 * phase's own task description, section 13.
 */
export const DISCOVERY_ATTEMPT_STATUSES = [
  "OK",
  "NO_RESULTS",
  "PROVIDER_UNAVAILABLE",
  "TIMEOUT",
  "RATE_LIMITED",
  "MALFORMED_RESULT",
  "ERROR",
] as const;

export type DiscoveryAttemptStatus = (typeof DISCOVERY_ATTEMPT_STATUSES)[number];

const DISCOVERY_ATTEMPT_STATUS_SET: ReadonlySet<string> = new Set(DISCOVERY_ATTEMPT_STATUSES);

export function isDiscoveryAttemptStatus(value: unknown): value is DiscoveryAttemptStatus {
  return typeof value === "string" && DISCOVERY_ATTEMPT_STATUS_SET.has(value);
}

/**
 * A small, server-side, in-memory representation of "please try to find a
 * correspondent for this document" — deliberately NOT a document's full
 * text (see this phase's own task description, section 2: "do not copy
 * entire document text into every request record"). Not persisted as its
 * own row anywhere; `id` exists purely to correlate the multiple
 * discovery_attempts rows (one per provider) a single request produces —
 * see lib/discovery-repository.ts.
 */
export type DiscoveryRequest = {
  id: string;
  documentIdentityId: string | null;
  requestedAt: string;
  purpose: DiscoveryPurpose;
  language: string | null;
  title: string | null;
  author: string | null;
  /** The bounded, already-extracted distinctive signals actually used — never the raw document text. */
  distinctiveSignals: string[];
  fingerprintVersion: string;
};

/**
 * Deterministic facts extracted from a document for discovery purposes —
 * NOT a similarity computation (see lib/discovery-signals.ts's header
 * comment). Every field here is small and bounded; none of them, alone or
 * together, can reconstruct the source document.
 */
export type DiscoverySignals = {
  normalizedTitle: string | null;
  normalizedAuthor: string | null;
  /** Bounded list of short, distinctive (non-generic) passages — see lib/discovery-signals.ts for the extraction/bounding rules. */
  distinctivePassages: string[];
  canonicalHash: string | null;
  language: "Arabic" | "French" | "English" | "Mixed" | null;
};

/** What a query was built from. TITLE and AUTHOR only ever appear together — see lib/discovery-query-generation.ts's header comment for why title-alone/author-alone queries are never generated. */
export type DiscoverySignalBasis = "TITLE" | "AUTHOR" | "DISTINCTIVE_PASSAGE";

export type DiscoveryQuery = {
  queryText: string;
  basis: DiscoverySignalBasis[];
  /** Ordinal position only (0 = tried first) — not a confidence score. */
  rank: number;
};

/**
 * What a provider's discover() call returns, one entry per candidate it
 * found — before this phase's orchestrator tags it with provider identity
 * (see lib/discovery-orchestrator.ts) and before deduplication (see
 * lib/discovery-candidates.ts). `providerConfidence` is exactly what its
 * name says: the *provider's* own ranking/confidence signal, if it supplies
 * one. Per this phase's own task description, section 5: this must never be
 * relabeled or treated as "provenance confidence" — see
 * lib/discovery-candidates.ts's rankDiscoveryCandidates for the (separate,
 * also-not-provenance) ranking this phase actually computes.
 */
export type RawProviderResult = {
  providerResultId: string | null;
  url: string | null;
  externalIdentifier: string | null;
  externalIdentifierType: string | null;
  title: string | null;
  author: string | null;
  publisher: string | null;
  publicationDate: string | null;
  sourceClass: SourceClass | null;
  providerConfidence: number | null;
  querySignalUsed: string;
  discoveredAt: string;
};

export type TaggedProviderResult = RawProviderResult & {
  providerId: string;
  providerType: DiscoveryProviderType;
};

/** One provider's contribution to a (possibly multi-provider) deduplicated candidate. */
export type ContributingProviderResult = {
  providerId: string;
  providerType: DiscoveryProviderType;
  providerResultId: string | null;
  providerConfidence: number | null;
  querySignalUsed: string;
  discoveredAt: string;
};

/**
 * A deduplicated, normalized discovery candidate — the output of
 * lib/discovery-candidates.ts. This is the "candidate source record" named
 * in this phase's own task description's section 1 diagram. It is NOT a
 * provenance_sources row (though lib/discovery-provenance-bridge.ts can
 * create one, always starting at CANDIDATE_SOURCE, never anything
 * stronger) and it is NOT provenance evidence (though its `independence`
 * field is exactly the payload lib/provenance-evidence-types.ts's
 * DISCOVERY_INDEPENDENCE evidence type expects, once/if it is ever recorded
 * as evidence).
 */
export type DiscoveryCandidate = {
  candidateKey: string;
  externalIdentifier: string | null;
  externalIdentifierType: string | null;
  canonicalUrl: string | null;
  /** Every raw URL any provider actually returned, verbatim — canonicalUrl is derived separately and never replaces these. */
  originalUrls: string[];
  title: string | null;
  author: string | null;
  publisher: string | null;
  publicationDate: string | null;
  sourceClass: SourceClass | null;
  contributingProviders: ContributingProviderResult[];
  /**
   * Derived from contributingProviders' provider types (see
   * lib/discovery-candidates.ts's deriveCandidateIndependence) — never
   * self-reported by a provider. USER_SUPPLIED whenever any contributing
   * provider is type USER_SUPPLIED, matching this phase's Case A: a
   * user-provided URL can be recorded as a candidate, but can never satisfy
   * independence, no matter what else is true about it.
   */
  independence: DiscoveryType;
  /** Ordinal ranking position after lib/discovery-candidates.ts's rankDiscoveryCandidates — triage ordering only, never a provenance/verification percentage. */
  rank: number;
};
