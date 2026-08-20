import type { AcademicSearchCandidate } from "./types";

/**
 * Stage 5 of the pipeline: orders candidates for triage — "which should we
 * spend a text-retrieval attempt on first" — never a final verification or
 * plagiarism-probability score. Deterministic: identical input always
 * produces the same order, ties broken by candidateKey so no two calls can
 * ever disagree.
 *
 * V11 (candidate-quality investigation, K-drama/Google Trends real
 * document): two structural problems were confirmed by an offline
 * experiment run against real captured candidate sets for three real
 * documents (K-drama/Google Trends, RECYT, BayesValidRox — see that
 * report), and are fixed here:
 *
 *  1. `textAvailable` used to be scored as ordinary relevance evidence (+4,
 *     the single largest flat term). It measures retrievability, not
 *     relevance — Europe PMC marks it true for any open-access record
 *     regardless of topical fit, while OpenAIRE's Graph API has no
 *     full-text field at all and so ALWAYS reports it false (see
 *     providers/openaire.ts's own header comment) — a genuinely relevant
 *     OpenAIRE candidate started every ranking 4 points behind an unrelated
 *     Europe PMC record purely on this account. It is no longer part of the
 *     relevance score at all; rankAcademicCandidates now uses it only as a
 *     secondary tie-breaker, after relevance is compared.
 *  2. `additionalContributor` used to credit every extra contributor
 *     equally, with no per-contributor quality check — unlike
 *     specificityBonus (already discounted for Europe PMC, see
 *     PROVIDER_SPECIFICITY_TRUST below), this term had no defense against a
 *     large, heterogeneous, multi-topic aggregator record (Europe PMC's
 *     "Full GSA Abstract Book", hundreds of unrelated abstracts in one
 *     record) coincidentally matching several of a submission's queries —
 *     the measured case scored as high as 19-23 points from this term
 *     alone, well above every genuine single-provider match. A repeat
 *     contributor from a provider ALREADY represented among a candidate's
 *     contributors now only earns full credit if it is independently
 *     reasonably specific; a weak, redundant repeat is discounted. See
 *     contributorScore() below.
 *
 * `providerRelevance` is removed from the score entirely (not just
 * zero-weighted): both real providers (openaire.ts, europe-pmc.ts)
 * currently hardcode it to null, so it has never contributed any
 * information — see types.ts's own field comment for what it is meant to
 * become if a provider ever populates it.
 */

export type CandidateRankingWeights = {
  hasDoi: number;
  hasUrl: number;
  /** Per additional independent contributor beyond the first — rewards candidates multiple queries/providers agreed on. Subject to contributorScore()'s same-provider weak-repeat discount (V11) — see this file's own header comment. */
  additionalContributor: number;
  /**
   * Full weight awarded when a candidate's most specific contributor came
   * from a query that matched almost nothing else in its provider's index
   * (queryTotalResults near 0); scaled down (via specificityScore below)
   * toward 0 as that count grows toward a "generic query" ceiling, and 0
   * when no contributor reports a count at all.
   *
   * Replaces the earlier flat `foundByKeywordQuery` bonus (awarded once for
   * ANY keyword-type contributor, regardless of how many other results that
   * exact query also matched). That flat version closed a real gap — see
   * git history on this field for the original measured case — but a later
   * differential test against two more real documents ("Approved to
   * implement the ranking fix" round) proved it both too coarse AND, when a
   * first attempt replaced it with raw specificity, exploitable: a large
   * multi-topic aggregator PDF (Europe PMC's "Full GSA Abstract Book",
   * hundreds of unrelated abstracts in one record) coincidentally matched
   * several sentence-window queries from BOTH unrelated real test documents
   * at low-looking hitCount values (2-95), because Europe PMC's hitCount is
   * a full-text search over a large heterogeneous corpus — a low count
   * there is much weaker evidence of genuine specificity than the same
   * count from OpenAIRE's metadata-only conjunctive search. See
   * PROVIDER_SPECIFICITY_TRUST below.
   */
  specificityBonus: number;
  /**
   * "Investigate two real detection issues" ISSUE 2: awarded once when a
   * candidate was independently returned by 2+ DISTINCT providers (not
   * merely 2+ queries against the SAME provider — additionalContributor
   * above already rewards that, generically). Real, confirmed gap this
   * closes: additionalContributor treated "the same Europe PMC record
   * matched three different sentence-window queries" (one provider,
   * loosely relevant, three coincidental keyword overlaps) identically to
   * "OpenAIRE and Europe PMC, searched independently, both returned this
   * exact DOI" — the second case is real cross-database corroboration, the
   * single strongest correctness signal this pipeline has without doing a
   * full-text comparison. Reproduced live against a real OpenAIRE-indexed
   * paper (tests/academic-search-candidate-ranker.test.mjs and the ISSUE 2
   * investigation's own report): eight topically-unrelated candidates, each
   * matched by only one provider, outranked the genuine source purely on
   * (pre-V11) textAvailable + a shared generic keyword-query hit.
   */
  multiProviderCorroboration: number;
};

/** A starting point for the POC, not a calibrated weighting — same disclaimer as lib/discovery-candidates.ts's own DEFAULT_CANDIDATE_RANKING_WEIGHTS. Magnitudes for every kept term (hasDoi/hasUrl/specificityBonus/multiProviderCorroboration) are unchanged from the pre-V11 formula — V11 only restructures textAvailable and additionalContributor, it does not retune anything. */
export const DEFAULT_CANDIDATE_RANKING_WEIGHTS: CandidateRankingWeights = {
  hasDoi: 3,
  hasUrl: 1,
  additionalContributor: 2,
  specificityBonus: 8,
  multiProviderCorroboration: 5,
};

/** A query returning this many results or fewer from a provider is treated as maximally specific (specificityScore 1). */
const HIGHLY_SPECIFIC_MAX_RESULTS = 5;
/** A query returning this many results or more is treated as generic (specificityScore 0) — chosen from the real gap observed between genuine matches (single digits) and topically-unrelated noise (hundreds+) in the differential test documents. */
const GENERIC_MIN_RESULTS = 500;

/**
 * How much a provider's own reported result count should be trusted as a
 * specificity signal, 0..1. OpenAIRE searches metadata only (title/
 * abstract/authors) with conjunctive (AND) term matching, so a low
 * numFound is strong evidence of a narrow, specific match. Europe PMC
 * full-text-searches a much larger, more heterogeneous corpus — measured
 * live, a single large multi-topic aggregator record ("Full GSA Abstract
 * Book PDF", hundreds of unrelated abstracts) scored hitCount as low as 2
 * purely by coincidental phrase overlap, so the same raw count there is
 * weaker evidence. A provider not listed here defaults to full trust
 * rather than being silently zeroed out.
 */
const PROVIDER_SPECIFICITY_TRUST: Record<string, number> = {
  openaire: 1,
  "europe-pmc": 0.25,
};

/** Log-interpolated specificity in [0,1]; 0 when the provider reported no count at all (never guessed). */
function specificityScore(queryTotalResults: number | null | undefined, providerId: string): number {
  if (typeof queryTotalResults !== "number" || queryTotalResults <= 0) return 0;
  const trust = PROVIDER_SPECIFICITY_TRUST[providerId] ?? 1;
  if (queryTotalResults <= HIGHLY_SPECIFIC_MAX_RESULTS) return trust;
  if (queryTotalResults >= GENERIC_MIN_RESULTS) return 0;
  const raw = 1 - (Math.log(queryTotalResults) - Math.log(HIGHLY_SPECIFIC_MAX_RESULTS)) / (Math.log(GENERIC_MIN_RESULTS) - Math.log(HIGHLY_SPECIFIC_MAX_RESULTS));
  return Math.max(0, Math.min(1, raw)) * trust;
}

/** The single most specific contributor determines the bonus — one genuinely narrow hit is real evidence even if every other contributor on the same candidate is generic noise. */
function maxSpecificity(candidate: AcademicSearchCandidate): number {
  const values = candidate.contributors.map((c) => specificityScore(c.queryTotalResults, c.providerId));
  return values.length === 0 ? 0 : Math.max(...values);
}

function distinctContributingProviderCount(candidate: AcademicSearchCandidate): number {
  return new Set(candidate.contributors.map((c) => c.providerId)).size;
}

/** A contributor scoring below this is "weak" for V11's same-provider-repeat discount — reuses PROVIDER_SPECIFICITY_TRUST's own scale (0..1), not a fresh unrelated number. */
const WEAK_CONTRIBUTOR_SPECIFICITY_THRESHOLD = 0.5;
/** V11's discount factor for a weak, same-provider repeat contributor — reuses the exact PROVIDER_SPECIFICITY_TRUST["europe-pmc"] discount already established in this file for the same reason (a low-specificity signal from a large heterogeneous corpus is weak evidence), rather than a new unexplained constant. */
const WEAK_CONTRIBUTOR_DISCOUNT = 0.25;

/**
 * V11: the additionalContributor term (see this file's own header comment).
 * The very first contributor overall is still free — mirrors the original
 * (contributors.length - 1) rule. Every contributor after that earns full
 * credit UNLESS it is both (a) a repeat from a provider already represented
 * among this candidate's earlier-counted contributors, AND (b) itself weak
 * (specificityScore below WEAK_CONTRIBUTOR_SPECIFICITY_THRESHOLD) — that
 * combination is exactly the "large heterogeneous aggregator record
 * coincidentally matched several generic queries from the SAME provider"
 * pattern this fix targets. A first appearance from a DIFFERENT provider is
 * never discounted here — that is multiProviderCorroboration's own signal,
 * kept separate. Each provider's own contributors are considered strongest-
 * specificity-first, so a provider's one genuinely specific hit (if any) is
 * what determines whether its later repeats look redundant, not whichever
 * happened to be discovered first.
 */
function contributorScore(candidate: AcademicSearchCandidate, weight: number): number {
  const byProvider = new Map<string, AcademicSearchCandidate["contributors"]>();
  for (const contributor of candidate.contributors) {
    const list = byProvider.get(contributor.providerId) ?? [];
    list.push(contributor);
    byProvider.set(contributor.providerId, list);
  }

  let score = 0;
  let firstOverallCounted = false;
  for (const contributors of byProvider.values()) {
    const bySpecificity = [...contributors].sort(
      (a, b) => specificityScore(b.queryTotalResults, b.providerId) - specificityScore(a.queryTotalResults, a.providerId),
    );
    bySpecificity.forEach((contributor, indexWithinProvider) => {
      if (!firstOverallCounted) {
        firstOverallCounted = true;
        return;
      }
      const isSameProviderRepeat = indexWithinProvider > 0;
      const weak = specificityScore(contributor.queryTotalResults, contributor.providerId) < WEAK_CONTRIBUTOR_SPECIFICITY_THRESHOLD;
      score += weight * (isSameProviderRepeat && weak ? WEAK_CONTRIBUTOR_DISCOUNT : 1);
    });
  }
  return score;
}

/** V11's relevance score — deliberately excludes textAvailable (retrieval availability, not relevance evidence — see this file's own header comment) and providerRelevance (currently always null, contributes nothing). */
function relevanceScore(candidate: AcademicSearchCandidate, weights: CandidateRankingWeights): number {
  let score = 0;
  if (candidate.doi) score += weights.hasDoi;
  if (candidate.url) score += weights.hasUrl;
  score += contributorScore(candidate, weights.additionalContributor);
  score += maxSpecificity(candidate) * weights.specificityBonus;
  if (distinctContributingProviderCount(candidate) >= 2) score += weights.multiProviderCorroboration;
  return score;
}

export function rankAcademicCandidates(
  candidates: AcademicSearchCandidate[],
  weights: CandidateRankingWeights = DEFAULT_CANDIDATE_RANKING_WEIGHTS,
): AcademicSearchCandidate[] {
  return [...candidates]
    .sort((a, b) => {
      const relevanceDiff = relevanceScore(b, weights) - relevanceScore(a, weights);
      if (relevanceDiff !== 0) return relevanceDiff;
      // Secondary tie-breaker, applied only once relevance is equal: a
      // retrievable candidate is marginally more useful to spend a
      // retrieval attempt on than an equally-relevant one that isn't, but
      // this must never let retrievability outrank actual relevance
      // evidence — see this file's own header comment on why textAvailable
      // was removed from the relevance score itself.
      const textAvailableDiff = Number(b.textAvailable) - Number(a.textAvailable);
      if (textAvailableDiff !== 0) return textAvailableDiff;
      return a.candidateKey.localeCompare(b.candidateKey);
    })
    .map((candidate, index) => ({ ...candidate, rank: index }));
}
