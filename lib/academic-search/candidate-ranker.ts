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
   * Phase 5 addition: awarded once if ANY contributor came from a
   * queryType "keyword" query (lib/academic-search/phrase-extractor.ts's
   * extractKeywordQueries) rather than only "sentence" queries. Real,
   * confirmed gap this closes: a candidate found ONLY by one precision-
   * engineered keyword query (queryType "keyword", 1 contributor) was
   * previously tied in rankScore with several genuinely irrelevant
   * candidates ALSO at 1 contributor with textAvailable/doi/url — and lost
   * the tie to an arbitrary alphabetical candidateKey comparison, landing
   * outside maxCandidatesToRetrieve despite being the real match (see this
   * phase's own final report). A keyword query exists specifically because
   * it is a higher-precision, lower-recall signal than a full sentence —
   * this weight reflects that its contributors deserve real ranking credit,
   * not just a tiebreak nudge.
   */
  foundByKeywordQuery: number;
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
  foundByKeywordQuery: 3,
  multiProviderCorroboration: 5,
};

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
  if (candidate.contributors.some((c) => c.queryType === "keyword")) score += weights.foundByKeywordQuery;
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
