import type { Client } from "@libsql/client";
import { getOrComputeHistoricalMatchSnapshot } from "./report-historical-match";
import { computeUnifiedSimilarity, type UnifiedSimilarityResult } from "./unified-similarity";
import type { ReportHistoricalSubmissionMatch } from "./report-types";
import type { ExternalAcademicEvidence } from "./academic-search/types";

/**
 * Release-hardening audit finding SIM-02: the ONE server-side source for
 * "what is this report's resolved primary-similarity result" — used by both
 * app/api/reports/[id]/route.ts (report detail) and lib/reports-repo.ts's
 * findRoomOccupant (room card). Before this existed, the room card had no
 * access to the unified/combined result at all (lib/reports-repo.ts's own
 * findRoomOccupant read only the persisted archive_score column), so it
 * showed the archive-only figure — 0% in the reported case — permanently,
 * never resolving to the real 100% a corpus-source match produced. This
 * function is the single place that decides "archive-only fallback vs.
 * resolved combined result" for both surfaces, so they can never disagree.
 *
 * Reuses lib/report-historical-match.ts's getOrComputeHistoricalMatchSnapshot
 * exactly as-is — the real snapshot cache (report_historical_match_snapshots,
 * keyed by report_device_key+report_id, staleness-checked against version
 * tags AND corpus_match_generation) and its own CORPUS_SOURCE_MATCHING_ENABLED
 * read-time filter (lib/corpus-source-matching-flag.ts) — never a second
 * matching implementation, and never a duplicate computation for an
 * already-cached, still-current snapshot: two calls for the same report
 * within the same corpus-match generation and version tags both resolve to
 * the same stored row, the second one costing only the two cheap SELECTs
 * getOrComputeHistoricalMatchSnapshot itself already does to decide the
 * snapshot is still fresh — the expensive matchAgainstUserSubmissionCorpus
 * search itself runs at most once per snapshot per generation.
 *
 * Lives in lib/, not app/ — this file, like lib/report-historical-match.ts,
 * is the sanctioned bridge into lib/user-submission-matching.ts;
 * tests/user-submission-matching-privacy.test.mjs's own structural guarantee
 * ("the matching service is never imported by any file under app/") is
 * unaffected, since no app/ file imports lib/user-submission-matching.ts
 * directly either way — every app/ caller only ever imports THIS function or
 * getOrComputeHistoricalMatchSnapshot, never the matcher itself.
 */

export type PrimarySimilarityResolution = {
  /** Passed straight through — callers that also need it for their own read-time enrichment (E8P.3, E8S, shadow evaluation) get it from the one call already made here, never a second one. */
  historicalSubmissionMatch: ReportHistoricalSubmissionMatch;
  /** Present whenever the resolution succeeded — absent only if computeUnifiedSimilarity itself threw (it is documented as never doing so; this is a defensive fallback, not an expected path). */
  unifiedSimilarity: UnifiedSimilarityResult | undefined;
  /** unifiedSimilarity.unifiedScore when resolved, otherwise the caller's own supplied archiveScore — the exact same fallback rule lib/report-types.ts's primarySimilarityScore already applies client-side, computed here once, server-side, for both the room card and report detail to share. */
  primaryScore: number;
  /** True when primaryScore reflects the resolved combined result rather than the archive-only fallback. */
  isUnified: boolean;
};

export async function resolvePrimarySimilaritySummary(
  client: Client,
  params: {
    reportDeviceKey: string;
    reportId: string;
    accountId: string | null;
    rawText: string;
    wordCount: number;
    archiveMatchedPositions?: number[] | null;
    externalAcademicEvidence?: ExternalAcademicEvidence[] | null;
    /** The archive-only fallback value — never mutated, never persisted by this function; see this module's own header comment. */
    archiveScore: number;
    /** Test-only override, mirroring getOrComputeHistoricalMatchSnapshot's own testOnlyPauseBeforeWrite convention — lets a test force the "unified matching genuinely failed" branch without fighting computeUnifiedSimilarity's own deliberately defensive, never-throws-on-malformed-input contract. Always undefined in production. */
    testOnlyComputeUnifiedSimilarity?: typeof computeUnifiedSimilarity;
  },
): Promise<PrimarySimilarityResolution> {
  const historicalSubmissionMatch = await getOrComputeHistoricalMatchSnapshot(client, {
    reportDeviceKey: params.reportDeviceKey,
    reportId: params.reportId,
    accountId: params.accountId,
    rawText: params.rawText,
  });

  // Mirrors the exact try/catch boundary app/api/reports/[id]/route.ts
  // already had around its own inline computeUnifiedSimilarity call —
  // getOrComputeHistoricalMatchSnapshot above is not wrapped here for the
  // same reason it wasn't there either: it never throws by its own
  // documented contract (a computation failure becomes a stored "FAILED"
  // snapshot / UNAVAILABLE status, not an exception).
  try {
    const compute = params.testOnlyComputeUnifiedSimilarity ?? computeUnifiedSimilarity;
    const unifiedSimilarity = compute({
      wordCount: params.wordCount,
      archiveMatchedPositions: params.archiveMatchedPositions,
      externalAcademicEvidence: params.externalAcademicEvidence,
      historicalSubmissionMatch,
    });
    return { historicalSubmissionMatch, unifiedSimilarity, primaryScore: unifiedSimilarity.unifiedScore, isUnified: true };
  } catch (err) {
    console.error("resolvePrimarySimilaritySummary: computeUnifiedSimilarity failed (non-fatal), falling back to the archive-only result:", err instanceof Error ? err.message : String(err));
    return { historicalSubmissionMatch, unifiedSimilarity: undefined, primaryScore: params.archiveScore, isUnified: false };
  }
}
