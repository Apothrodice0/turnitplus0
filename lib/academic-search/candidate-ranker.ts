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
};

/** A starting point for the POC, not a calibrated weighting — same disclaimer as lib/discovery-candidates.ts's own DEFAULT_CANDIDATE_RANKING_WEIGHTS. */
export const DEFAULT_CANDIDATE_RANKING_WEIGHTS: CandidateRankingWeights = {
  hasDoi: 3,
  hasUrl: 1,
  textAvailable: 4,
  additionalContributor: 2,
  providerRelevance: 1,
};

function maxProviderRelevance(candidate: AcademicSearchCandidate): number {
  const values = candidate.contributors.map((c) => c.providerRelevance).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return 0;
  return Math.max(0, Math.min(1, Math.max(...values)));
}

function rankScore(candidate: AcademicSearchCandidate, weights: CandidateRankingWeights): number {
  let score = 0;
  if (candidate.doi) score += weights.hasDoi;
  if (candidate.url) score += weights.hasUrl;
  if (candidate.textAvailable) score += weights.textAvailable;
  score += Math.max(0, candidate.contributors.length - 1) * weights.additionalContributor;
  score += maxProviderRelevance(candidate) * weights.providerRelevance;
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
