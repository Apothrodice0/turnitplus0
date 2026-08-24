import type { Client } from "@libsql/client";
import { getOrComputeHistoricalMatchSnapshot, getCurrentCorpusMatchGeneration, isHistoricalMatchSnapshotCurrent } from "./report-historical-match";
import { isCorpusSourceMatchingEnabled } from "./corpus-source-matching-flag";
import { computeUnifiedSimilarity, type UnifiedSimilarityResult } from "./unified-similarity";
import type { ReportHistoricalSubmissionMatch } from "./report-types";
import type { ExternalAcademicEvidence } from "./academic-search/types";

/**
 * Release-hardening audit finding SIM-02/SIM-03/SIM-04: the ONE server-side
 * source for "what is this report's resolved primary-similarity result" —
 * used by app/api/reports/route.ts (write-time finalization) and
 * app/api/reports/[id]/route.ts (the stale-generation self-heal path). See
 * resolvePersistedSimilarityDisplay below for the READ-side counterpart
 * lib/reports-repo.ts's findRoomOccupant and app/reports/[id]/page.tsx
 * share — that one never calls into this file's own DB-touching functions,
 * only the already-persisted result plus two cheap freshness checks.
 *
 * Reuses lib/report-historical-match.ts's getOrComputeHistoricalMatchSnapshot
 * exactly as-is — the real snapshot cache (report_historical_match_snapshots,
 * keyed by report_device_key+report_id, staleness-checked against version
 * tags AND corpus_match_generation) and its own CORPUS_SOURCE_MATCHING_ENABLED
 * read-time filter — never a second matching implementation, and never a
 * duplicate computation for an already-cached, still-current snapshot.
 *
 * Lives in lib/, not app/ — this file, like lib/report-historical-match.ts,
 * is the sanctioned bridge into lib/user-submission-matching.ts;
 * tests/user-submission-matching-privacy.test.mjs's own structural guarantee
 * ("the matching service is never imported by any file under app/") is
 * unaffected, since no app/ file imports lib/user-submission-matching.ts
 * directly either way.
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
  /**
   * Release-hardening audit finding SIM-04: isCorpusSourceMatchingEnabled()
   * read once, at the START of this resolution — the flag snapshot a
   * caller must persist alongside unifiedSimilarity so a later reader can
   * detect "this stored result was computed under a different flag state"
   * without re-running anything (see resolvePersistedSimilarityDisplay's
   * own comment for why this is the "live flag rollback" fix: the room
   * card's own read never called getOrComputeHistoricalMatchSnapshot, so it
   * never re-applied applyCorpusSourceMatchingFlag either — this snapshot
   * is what lets a pure SQL read reproduce that same live filtering
   * without a second matching implementation).
   */
  corpusSourceMatchingEnabled: boolean;
  /**
   * Release-hardening audit finding SIM-04: getCurrentCorpusMatchGeneration()
   * read once, at the START of this resolution (before the snapshot lookup
   * — the same "read fresh, before the cache-hit decision" discipline
   * getOrComputeHistoricalMatchSnapshot's own header comment documents for
   * itself). A caller persists this alongside unifiedSimilarity as a
   * monotonic ordering key: when two concurrent resaves finalize the same
   * report, whichever carries the LOWER generation must never overwrite the
   * higher one, regardless of which write actually commits last — see
   * app/api/reports/route.ts's own SAVE_REPORT_SQL generation guard.
   */
  corpusGeneration: number;
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
  const corpusSourceMatchingEnabled = isCorpusSourceMatchingEnabled();
  const corpusGeneration = await getCurrentCorpusMatchGeneration(client);
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
    return { historicalSubmissionMatch, unifiedSimilarity, primaryScore: unifiedSimilarity.unifiedScore, isUnified: true, corpusSourceMatchingEnabled, corpusGeneration };
  } catch (err) {
    console.error("resolvePrimarySimilaritySummary: computeUnifiedSimilarity failed (non-fatal), falling back to the archive-only result:", err instanceof Error ? err.message : String(err));
    return { historicalSubmissionMatch, unifiedSimilarity: undefined, primaryScore: params.archiveScore, isUnified: false, corpusSourceMatchingEnabled, corpusGeneration };
  }
}

/**
 * Release-hardening audit finding SIM-04 (acceptance-check hardening): a
 * genuine discriminated union, not a flat object with a status label beside
 * an always-present primaryScore. The earlier shape let a consumer read
 * `.primaryScore` without ever checking `.status` first — harmless by
 * convention as long as every call site remembered the rule, but nothing
 * stopped a future call site from forgetting it and rendering the
 * archive-only fallback as if it were a trustworthy final number. Here,
 * `primaryScore`/`isUnified` simply DO NOT EXIST on the "stale"/"pending"
 * branches — TypeScript itself refuses `display.primaryScore` unless the
 * caller has already narrowed on `display.status === "resolved"`, so the
 * mistake this hardening pass is closing off cannot compile.
 *  - "resolved": primaryScore is trustworthy as-is — either the real
 *    combined result (isUnified true), or a definitive archive-only answer
 *    known correct right now with no further wait (isUnified false:
 *    CORPUS_SOURCE_MATCHING_ENABLED was rolled back OFF since this report's
 *    own persisted result was computed with it on — disabling can only
 *    ever remove a contribution, never add one, so archive-only is
 *    immediately, deterministically right).
 *  - "stale": a real unifiedSimilarity IS persisted, but either
 *    corpus_match_generation has moved on, or the flag was rolled back ON
 *    since this report's own result was computed with it off (the opposite
 *    flag transition from "resolved" above — NOT deterministic: a
 *    newly-eligible corpus source cannot be ruled out without actually
 *    running the matcher again). The caller must show "Updating
 *    similarity…" — there is no number here to render even by accident.
 *  - "pending": no unifiedSimilarity has ever been persisted for this
 *    report (finalization has not completed yet — a legacy report, or a
 *    write-time finalization that genuinely failed/timed out and left no
 *    trace, see app/api/reports/route.ts's own finalization try/catch). The
 *    caller must show neutral loading — again, no number to render.
 * A caller that wants an archive-only number to show for "stale"/"pending"
 * (there usually isn't one — see OverviewReport/room-page-shell.tsx, which
 * both show neutral text instead) must fetch archiveScore itself from
 * wherever it already had it and decide that explicitly; it is deliberately
 * not handed out here.
 */
export type PersistedSimilarityDisplay =
  | { status: "resolved"; primaryScore: number; isUnified: boolean }
  | { status: "stale" }
  | { status: "pending" };

/**
 * Release-hardening audit finding SIM-04: the READ-side counterpart to
 * resolvePrimarySimilaritySummary above — never calls
 * getOrComputeHistoricalMatchSnapshot, never runs (or risks running) the
 * expensive matcher. Takes only what a caller can obtain from ALREADY-
 * PERSISTED data (lib/reports-repo.ts's findRoomOccupant via a plain
 * json_extract SQL read; app/reports/[id]/page.tsx via its own already-
 * parsed payload_json) plus isHistoricalMatchSnapshotCurrent's own two
 * cheap, read-only SELECTs — this is "equivalent live filtering" to
 * lib/report-historical-match.ts's own applyCorpusSourceMatchingFlag,
 * reproduced here at the DISPLAY-DECISION level (never reaching for the raw
 * historicalSubmissionMatch.matches array this function never has) so the
 * room card's own bypass of that flag check (the exact gap this finding
 * closes) can never happen again — and so room and detail, which both call
 * this same function, can never disagree.
 */
export async function resolvePersistedSimilarityDisplay(
  client: Client,
  params: {
    reportDeviceKey: string;
    reportId: string;
    archiveScore: number;
    /** From payload.unifiedSimilarity?.unifiedScore (or its json_extract equivalent) — meaningless unless hasUnifiedSimilarity is true. */
    unifiedScore: number | null;
    /** Whether payload.unifiedSimilarity was ever persisted at all for this report. */
    hasUnifiedSimilarity: boolean;
    /** payload.corpusSourceMatchingEnabledAtComputation (or its json_extract equivalent) — the flag snapshot resolvePrimarySimilaritySummary recorded at write time. null/undefined is treated as "never recorded" (a report saved before this fix existed), which is always a mismatch against the live flag, forcing one honest re-resolution rather than silently trusting an unlabeled legacy value. */
    corpusSourceMatchingEnabledAtComputation: boolean | null | undefined;
  },
): Promise<PersistedSimilarityDisplay> {
  if (!params.hasUnifiedSimilarity) {
    return { status: "pending" };
  }
  const liveFlag = isCorpusSourceMatchingEnabled();
  const computedWithFlag = Boolean(params.corpusSourceMatchingEnabledAtComputation);
  if (computedWithFlag && !liveFlag) {
    // Live flag ROLLBACK (was on, now off): a deterministic, IMMEDIATE
    // answer — disabling corpus-source matching can only ever REMOVE a
    // contribution, never add one, so archive-only is already known
    // correct right now. No wait, no recompute needed to know this.
    return { status: "resolved", primaryScore: params.archiveScore, isUnified: false };
  }
  if (!computedWithFlag && liveFlag) {
    // Live flag ROLL-FORWARD (was off, now on): the opposite direction is
    // NOT deterministic — a corpus source that would now match cannot be
    // ruled out without actually running the matcher again. Treated
    // exactly like generation staleness: show "Updating similarity…"
    // rather than a number until a real recompute (app/api/reports/[id]/
    // route.ts's own self-heal path) resolves and persists the answer.
    return { status: "stale" };
  }
  const current = await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: params.reportDeviceKey, reportId: params.reportId });
  if (!current) {
    return { status: "stale" };
  }
  return { status: "resolved", primaryScore: params.unifiedScore ?? params.archiveScore, isUnified: true };
}
