import type {
  DiscoveryCandidate,
  DiscoverySignals,
  TaggedProviderResult,
} from "./discovery-types";
import type { DiscoveryType } from "./provenance-evidence-types";
import { normalizeExternalIdentifier, normalizeUrlForDiscovery, normalizeTitleForComparison } from "./discovery-normalization";

/**
 * Phase E6A: deterministic candidate deduplication and ranking.
 *
 * Two results are considered the same candidate only when a stable,
 * meaningful identifier says so — never merely because they share a title
 * or an author (this phase's own task description, section 9, is explicit:
 * "Do not deduplicate based only on title... only author... Do not assume
 * two documents with the same title are the same source"). See Case C in
 * tests/discovery-orchestrator.test.mjs for the direct proof.
 */

/**
 * Deterministic dedup identity, in the priority order this phase's own
 * task description specifies: stable external identifier, then canonical
 * URL, then a provider-specific fallback (which therefore never
 * cross-provider-deduplicates on its own — there is no shared signal to do
 * it with).
 */
export function buildCandidateKey(result: TaggedProviderResult): string {
  const identifier = normalizeExternalIdentifier(result.externalIdentifierType, result.externalIdentifier);
  if (identifier) return `id:${identifier}`;
  const canonicalUrl = normalizeUrlForDiscovery(result.url);
  if (canonicalUrl) return `url:${canonicalUrl}`;
  const fallback = result.providerResultId ?? JSON.stringify([result.url ?? null, result.title ?? null, result.externalIdentifier ?? null]);
  return `provider:${result.providerId}:${fallback}`;
}

/** USER_SUPPLIED whenever ANY contributing provider is type USER_SUPPLIED — independence is never partial or averaged; one non-independent contribution is enough to withhold it entirely, matching lib/provenance-verification-policy.ts's own conservative INDEPENDENT_DISCOVERY criterion. */
function deriveCandidateIndependence(contributors: TaggedProviderResult[]): DiscoveryType {
  return contributors.some((c) => c.providerType === "USER_SUPPLIED") ? "USER_SUPPLIED" : "INDEPENDENT_DISCOVERY";
}

function firstNonNull<T>(values: (T | null | undefined)[]): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/**
 * Groups tagged provider results into deduplicated candidates. Input order
 * is preserved as "first seen" for field-merge purposes (first non-null
 * value wins per field — deterministic, but not an attempt to arbitrate
 * which provider is more trustworthy; that judgment belongs to a future
 * phase, not this one). originalUrls/contributingProviders always
 * accumulate across the whole group, regardless of merge order.
 */
export function deduplicateDiscoveryResults(results: TaggedProviderResult[]): DiscoveryCandidate[] {
  const groups = new Map<string, TaggedProviderResult[]>();
  const order: string[] = [];
  for (const result of results) {
    const key = buildCandidateKey(result);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(result);
  }

  return order.map((key) => {
    const group = groups.get(key)!;
    const originalUrls = [...new Set(group.map((r) => r.url).filter((u): u is string => Boolean(u)))];
    const canonicalUrl = firstNonNull(group.map((r) => normalizeUrlForDiscovery(r.url)));
    const externalIdentifier = firstNonNull(group.map((r) => r.externalIdentifier));
    const externalIdentifierType = firstNonNull(group.map((r) => r.externalIdentifierType));

    const candidate: DiscoveryCandidate = {
      candidateKey: key,
      externalIdentifier,
      externalIdentifierType,
      canonicalUrl,
      originalUrls,
      title: firstNonNull(group.map((r) => r.title)),
      author: firstNonNull(group.map((r) => r.author)),
      publisher: firstNonNull(group.map((r) => r.publisher)),
      publicationDate: firstNonNull(group.map((r) => r.publicationDate)),
      sourceClass: firstNonNull(group.map((r) => r.sourceClass)),
      contributingProviders: group.map((r) => ({
        providerId: r.providerId,
        providerType: r.providerType,
        providerResultId: r.providerResultId,
        providerConfidence: r.providerConfidence,
        querySignalUsed: r.querySignalUsed,
        discoveredAt: r.discoveredAt,
      })),
      independence: deriveCandidateIndependence(group),
      rank: 0, // assigned by rankDiscoveryCandidates
    };
    return candidate;
  });
}

export type CandidateRankingWeights = {
  hasExternalIdentifier: number;
  hasCanonicalUrl: number;
  titleMatch: number;
  authorMatch: number;
  distinctivePassageMatch: number;
  providerConfidence: number;
};

/**
 * A starting point for testing/development, not a calibrated or permanent
 * product decision — same disclaimer as lib/document-family-config.ts's
 * DEFAULT_DOCUMENT_FAMILY_THRESHOLDS, and for the same reason: nothing has
 * measured what these should be against real discovery results yet.
 */
export const DEFAULT_CANDIDATE_RANKING_WEIGHTS: CandidateRankingWeights = {
  hasExternalIdentifier: 3,
  hasCanonicalUrl: 1,
  titleMatch: 2,
  authorMatch: 1,
  distinctivePassageMatch: 2,
  providerConfidence: 1,
};

function candidateProviderConfidence(candidate: DiscoveryCandidate): number {
  const values = candidate.contributingProviders.map((c) => c.providerConfidence).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return 0;
  return Math.max(0, Math.min(1, Math.max(...values)));
}

function rankScore(candidate: DiscoveryCandidate, signals: DiscoverySignals, weights: CandidateRankingWeights): number {
  let score = 0;
  if (candidate.externalIdentifier) score += weights.hasExternalIdentifier;
  if (candidate.canonicalUrl) score += weights.hasCanonicalUrl;

  const candidateTitle = normalizeTitleForComparison(candidate.title);
  if (candidateTitle && signals.normalizedTitle && candidateTitle === signals.normalizedTitle) score += weights.titleMatch;

  const candidateAuthor = normalizeTitleForComparison(candidate.author);
  if (candidateAuthor && signals.normalizedAuthor && candidateAuthor === signals.normalizedAuthor) score += weights.authorMatch;

  const matchedDistinctivePassage = candidate.contributingProviders.some((c) => signals.distinctivePassages.includes(c.querySignalUsed));
  if (matchedDistinctivePassage) score += weights.distinctivePassageMatch;

  score += candidateProviderConfidence(candidate) * weights.providerConfidence;
  return score;
}

/**
 * Ranks candidates for triage — "which should we look at first," never a
 * verification/confidence percentage (this phase's own task description,
 * section 10: "Do not turn ranking into a final score such as '87%
 * verified.'"). Pure and deterministic: identical input always produces
 * the same order, ties broken by candidateKey so no two calls can ever
 * disagree.
 */
export function rankDiscoveryCandidates(
  candidates: DiscoveryCandidate[],
  signals: DiscoverySignals,
  weights: CandidateRankingWeights = DEFAULT_CANDIDATE_RANKING_WEIGHTS,
): DiscoveryCandidate[] {
  return [...candidates]
    .sort((a, b) => rankScore(b, signals, weights) - rankScore(a, signals, weights) || a.candidateKey.localeCompare(b.candidateKey))
    .map((candidate, index) => ({ ...candidate, rank: index }));
}
