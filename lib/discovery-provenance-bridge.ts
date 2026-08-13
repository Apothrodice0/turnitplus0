import type { Client } from "@libsql/client";
import type { DiscoveryCandidate } from "./discovery-types";
import { createProvenanceSource, type ProvenanceSource } from "./provenance-registry";
import { createProvenanceEvidence } from "./provenance-evidence";

/**
 * Phase E6A: the one, narrow, already-safe connection point between
 * discovery and provenance — completing this phase's task description
 * section 1 diagram's final "candidate source records" step using only
 * already-existing, already-tested E1/E4 functions. This is deliberately
 * the ONLY function in this phase that writes to a provenance table.
 *
 * It can ONLY ever create a source in CANDIDATE_SOURCE — the weakest,
 * fully-unverified starting state E1 already defines — plus a
 * DISCOVERY_INDEPENDENCE evidence record (E4) describing how the candidate
 * was found. It cannot skip ahead: reaching PROVENANCE_PENDING requires a
 * separate, deliberate transitionProvenanceState call (E1), and reaching
 * VERIFIED_SOURCE requires the full E4 evidence-gate plus an explicit E5
 * approveVerification decision — neither of which this function calls, or
 * could call, since CANDIDATE_SOURCE -> VERIFIED_SOURCE is not even a valid
 * edge in lib/provenance-types.ts's transition graph. See this phase's own
 * task description, section 6: "A provider result can eventually create
 * CANDIDATE_SOURCE but cannot directly create VERIFIED_SOURCE" — enforced
 * here structurally, not just by convention, and proven in
 * tests/discovery-orchestrator.test.mjs.
 *
 * Not called from anywhere live in this phase (see this phase's task
 * description, sections 18/19) — exercised only by tests, as the concrete
 * proof that the intended future pipeline (discover -> candidate ->
 * CANDIDATE_SOURCE -> ... -> explicit verification) actually composes.
 */
export async function createCandidateSourceFromDiscovery(
  client: Client,
  candidate: DiscoveryCandidate,
  documentIdentityId?: string | null,
): Promise<ProvenanceSource> {
  const providerIds = candidate.contributingProviders.map((p) => p.providerId).join(", ") || "unknown provider";
  const source = await createProvenanceSource(client, {
    provenanceState: "CANDIDATE_SOURCE",
    sourceType: "external_reference",
    canonicalUrl: candidate.canonicalUrl,
    externalIdentifier: candidate.externalIdentifier,
    title: candidate.title,
    author: candidate.author,
    publisher: candidate.publisher,
    publicationDate: candidate.publicationDate,
    documentIdentityId: documentIdentityId ?? null,
    reason: `discovered via ${providerIds}`,
  });

  const contributingProviderTypes = [...new Set(candidate.contributingProviders.map((p) => p.providerType))].join(", ") || "unknown";
  await createProvenanceEvidence(client, {
    sourceId: source.id,
    evidenceType: "DISCOVERY_INDEPENDENCE",
    payload: {
      discoveryType: candidate.independence,
      independent: candidate.independence === "INDEPENDENT_DISCOVERY",
      basis: `derived from contributing discovery provider type(s): ${contributingProviderTypes}`,
    },
  });

  return source;
}
