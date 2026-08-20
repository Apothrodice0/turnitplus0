import type { AcademicSearchCandidate } from "./types";

/**
 * Stage 5 of the pipeline: orders candidates for triage — "which should we
 * spend a text-retrieval attempt on first" — never a final verification or
 * plagiarism-probability score. Deterministic: identical input always
 * produces the same order, ties broken by candidateKey so no two calls can
 * ever disagree.
 */

export type CandidateRankingWeights = {
  hasDoi: number;
  hasUrl: number;
  textAvailable: number;
  /** Per additional independent contributor beyond the first — rewards candidates multiple queries/providers agreed on. */
  additionalContributor: number;
  providerRelevance: number;
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
   * PROVIDER_SPECIFICITY_TRUST below, and the offline ranking experiment
   * (_ranking_experiment.mjs, run against real captured candidate sets for
   * both documents) that measured this before it was implemented here.
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
   * full-text comparison, and it was being outweighed by textAvailable
   * (OpenAIRE's provider never reports textAvailable at all — see
   * providers/openaire.ts's own header comment — so a real OpenAIRE-
   * confirmed match starts every ranking 4 points behind an unrelated
   * Europe PMC record purely on that account). Reproduced live against a
   * real OpenAIRE-indexed paper (tests/academic-search-candidate-ranker.test.mjs
   * and the ISSUE 2 investigation's own report): eight topically-unrelated
   * candidates, each matched by only one provider, outranked the genuine
   * source purely on textAvailable + a shared generic keyword-query hit.
   */
  multiProviderCorroboration: number;
};

/** A starting point for the POC, not a calibrated weighting — same disclaimer as lib/discovery-candidates.ts's own DEFAULT_CANDIDATE_RANKING_WEIGHTS. */
export const DEFAULT_CANDIDATE_RANKING_WEIGHTS: CandidateRankingWeights = {
  hasDoi: 3,
  hasUrl: 1,
  textAvailable: 4,
  additionalContributor: 2,
  providerRelevance: 1,
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

function maxProviderRelevance(candidate: AcademicSearchCandidate): number {
  const values = candidate.contributors.map((c) => c.providerRelevance).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return 0;
  return Math.max(0, Math.min(1, Math.max(...values)));
}

function distinctContributingProviderCount(candidate: AcademicSearchCandidate): number {
  return new Set(candidate.contributors.map((c) => c.providerId)).size;
}

function rankScore(candidate: AcademicSearchCandidate, weights: CandidateRankingWeights): number {
  let score = 0;
  if (candidate.doi) score += weights.hasDoi;
  if (candidate.url) score += weights.hasUrl;
  if (candidate.textAvailable) score += weights.textAvailable;
  score += Math.max(0, candidate.contributors.length - 1) * weights.additionalContributor;
  score += maxProviderRelevance(candidate) * weights.providerRelevance;
  score += maxSpecificity(candidate) * weights.specificityBonus;
  if (distinctContributingProviderCount(candidate) >= 2) score += weights.multiProviderCorroboration;
  return score;
}

export function rankAcademicCandidates(
  candidates: AcademicSearchCandidate[],
  weights: CandidateRankingWeights = DEFAULT_CANDIDATE_RANKING_WEIGHTS,
): AcademicSearchCandidate[] {
  return [...candidates]
    .sort((a, b) => rankScore(b, weights) - rankScore(a, weights) || a.candidateKey.localeCompare(b.candidateKey))
    .map((candidate, index) => ({ ...candidate, rank: index }));
}
