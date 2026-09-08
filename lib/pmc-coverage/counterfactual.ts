import {
  computeUnifiedSimilarity,
  UNIFIED_SIMILARITY_VERSION,
  type UnifiedSimilarityResult,
} from "../unified-similarity";
import type { ExternalAcademicEvidence } from "../academic-search/types";
import type { ReportHistoricalSubmissionMatch } from "../report-types";

/**
 * PMC OA scholarly-coverage SHADOW slice — the pure counterfactual.
 *
 * "What would the authoritative unified similarity percentage be if the PMC OA
 * coverage corpus were also a source." Computed by calling the UNMODIFIED
 * lib/unified-similarity.ts computeUnifiedSimilarity twice with identical
 * baseline inputs — once as authoritative production computed it, once with the
 * PMC-verified submission word positions unioned into archiveMatchedPositions
 * (computeUnifiedSimilarity filters that array to the valid range and unions it
 * exactly like the built-in archive channel — no new parameter, no code change).
 *
 * The first call is a PARITY GUARD: its unifiedScore MUST equal the authoritative
 * result the caller was handed (same request-local inputs
 * resolvePrimarySimilaritySummary used). A mismatch means an input drifted
 * between authoritative resolution and now — the caller records
 * SKIPPED_BASELINE_MISMATCH rather than publishing a misleading delta.
 *
 * PMC positions can only ADD covered submission positions, so the counterfactual
 * score is always >= the baseline; a negative delta is an invariant violation.
 */

export const PMC_COVERAGE_COUNTERFACTUAL_VERSION = "pmc-coverage-counterfactual-v1";

export type PmcCoverageCounterfactualInvariantReason = "BASELINE_MISMATCH" | "NEGATIVE_DELTA";

export class PmcCoverageCounterfactualInvariantError extends Error {
  readonly reason: PmcCoverageCounterfactualInvariantReason;
  constructor(reason: PmcCoverageCounterfactualInvariantReason, message: string) {
    super(message);
    this.name = "PmcCoverageCounterfactualInvariantError";
    this.reason = reason;
  }
}

export type PmcCoverageCounterfactualParams = {
  /** authoritativeUnifiedSimilarity.wordCount — the canonical tokenization length. */
  wordCount: number;
  /** The EXACT archiveMatchedPositions the caller passed into
   *  resolvePrimarySimilaritySummary. */
  authoritativeArchiveMatchedPositions: number[] | null;
  /** The EXACT externalAcademicEvidence the caller passed in (server-verified set). */
  externalAcademicEvidence: ExternalAcademicEvidence[] | null;
  /** Production's already-resolved historical-match result — read verbatim. */
  historicalSubmissionMatch: ReportHistoricalSubmissionMatch | null;
  /** resolvePrimarySimilaritySummary(...).effectiveDeviceSelfRepresentationIds. */
  effectiveDeviceSelfRepresentationIds: readonly string[];
  /** The authoritative UnifiedSimilarityResult the caller was handed. */
  authoritativeUnifiedSimilarity: UnifiedSimilarityResult;
  /** Stage B's verified submission word positions (lib/pmc-coverage/verify.ts). */
  pmcVerifiedPositions: readonly number[];
};

export type PmcCoverageCounterfactualResult = {
  version: typeof PMC_COVERAGE_COUNTERFACTUAL_VERSION;
  unifiedSimilarityVersion: typeof UNIFIED_SIMILARITY_VERSION;
  /** == authoritativeUnifiedSimilarity.unifiedScore (recorded as the source of truth). */
  baselineScore: number;
  /** computeUnifiedSimilarity(baseline inputs + PMC positions). >= baselineScore. */
  counterfactualScore: number;
  scoreDelta: number;
  /** Distinct PMC-verified positions in [0, wordCount). */
  pmcMatchedWordCount: number;
  /** Of those, the count NOT already in the authoritative unified matched set. */
  pmcMarginalWordCount: number;
};

function inRange(positions: readonly number[], wordCount: number): number[] {
  return positions.filter((p) => Number.isInteger(p) && p >= 0 && p < wordCount);
}

export function computePmcCoverageCounterfactual(
  params: PmcCoverageCounterfactualParams,
): PmcCoverageCounterfactualResult {
  const wordCount =
    Number.isInteger(params.wordCount) && params.wordCount > 0 ? params.wordCount : 0;

  const baseArchive = inRange(params.authoritativeArchiveMatchedPositions ?? [], wordCount);
  const pmcPositions = inRange(params.pmcVerifiedPositions, wordCount);

  const sharedInputs = {
    wordCount,
    externalAcademicEvidence: params.externalAcademicEvidence,
    historicalSubmissionMatch: params.historicalSubmissionMatch,
    effectiveDeviceSelfRepresentationIds: params.effectiveDeviceSelfRepresentationIds,
  };

  // Parity recompute — identical to how resolvePrimarySimilaritySummary called
  // computeUnifiedSimilarity for this report.
  const baselineRecomputed = computeUnifiedSimilarity({
    ...sharedInputs,
    archiveMatchedPositions: baseArchive,
  });

  const authoritativeScore = params.authoritativeUnifiedSimilarity.unifiedScore;
  if (baselineRecomputed.unifiedScore !== authoritativeScore) {
    throw new PmcCoverageCounterfactualInvariantError(
      "BASELINE_MISMATCH",
      `baseline parity mismatch: recomputed ${baselineRecomputed.unifiedScore} != authoritative ${authoritativeScore}`,
    );
  }

  // Counterfactual — PMC positions unioned into the archive channel. Union over
  // submission word positions, so a PMC position already covered by archive /
  // live-academic / prior-upload cannot double count.
  const counterfactual = computeUnifiedSimilarity({
    ...sharedInputs,
    archiveMatchedPositions: [...baseArchive, ...pmcPositions],
  });

  const scoreDelta = counterfactual.unifiedScore - authoritativeScore;
  if (scoreDelta < 0) {
    throw new PmcCoverageCounterfactualInvariantError(
      "NEGATIVE_DELTA",
      `negative score delta: counterfactual ${counterfactual.unifiedScore} < baseline ${authoritativeScore}`,
    );
  }

  const authoritativeUnion = new Set(params.authoritativeUnifiedSimilarity.matchedPositions);
  const pmcDistinct = new Set(pmcPositions);
  let marginal = 0;
  for (const p of pmcDistinct) if (!authoritativeUnion.has(p)) marginal += 1;

  return {
    version: PMC_COVERAGE_COUNTERFACTUAL_VERSION,
    unifiedSimilarityVersion: UNIFIED_SIMILARITY_VERSION,
    baselineScore: authoritativeScore,
    counterfactualScore: counterfactual.unifiedScore,
    scoreDelta,
    pmcMatchedWordCount: pmcDistinct.size,
    pmcMarginalWordCount: marginal,
  };
}
