import type { Client } from "@libsql/client";
import { getReportsDbClient } from "./reports-db";
import { runAfterResponse } from "./run-after-response";
import { runHistoricalMatchShadowEvaluation } from "./e8p-shadow-evaluation";
import { runDeviceProvenanceShadowEvaluation } from "./device-provenance-shadow";
import { runCorpusDuplicateSuppressionShadowEvaluation } from "./corpus-duplicate-suppression-shadow";
import type { ReportHistoricalSubmissionMatch } from "./report-types";
import type { UnifiedSimilarityResult } from "./unified-similarity";
import type { ExternalAcademicEvidence } from "./academic-search/types";

/**
 * The ONE trigger for the three post-report shadow-telemetry evaluators:
 *   - lib/e8p-shadow-evaluation.ts's runHistoricalMatchShadowEvaluation
 *     (Phase E8P — the proposed E8O historical-match acceptance policy,
 *     measured against the real production result),
 *   - lib/device-provenance-shadow.ts's runDeviceProvenanceShadowEvaluation
 *     (Device Passport Phase 4 — the same-device prior-submission SELF
 *     proposal, measured against the real production result), and
 *   - lib/corpus-duplicate-suppression-shadow.ts's
 *     runCorpusDuplicateSuppressionShadowEvaluation (Phase B2 — the B1
 *     document-local exact-canonical duplicate counterfactual, measured
 *     against the real authoritative unified similarity result).
 *
 * Shared verbatim by BOTH call sites so the trigger logic cannot drift on
 * WHICH evaluators run, in WHAT order, on WHICH production result, or on the
 * deferred-execution / own-connection / never-throw discipline around them:
 *   - app/api/reports/route.ts POST — a report whose authoritative unified
 *     similarity finalizes during the save itself (release-hardening finding
 *     SIM-03's write-time finalization) and whose AI is likewise already
 *     complete is frequently NEVER fetched through GET /api/reports/[id], so
 *     this is the path that must actually schedule the telemetry for it; and
 *   - app/api/reports/[id]/route.ts GET — the pre-existing trigger, kept as
 *     a self-heal / fallback for a report saved before this wiring existed,
 *     or whose POST-time schedule did not run.
 *
 * This module holds NO policy of its own — it only schedules. Every
 * classification decision stays inside the two evaluator modules.
 *
 * MEASUREMENT ONLY, cannot change the score. No evaluator writes
 * report_historical_match_snapshots, saved_reports, or any scoring field —
 * the E8P / device-provenance evaluators' sole write target is
 * historical_match_shadow_evaluations (drizzle/0021), each under its own
 * distinct policy_version; the corpus-duplicate evaluator's is
 * corpus_duplicate_suppression_shadow_evaluations (drizzle/0044). Every
 * evaluator reuses production's already-computed historicalSubmissionMatch (and,
 * for the corpus-duplicate one, the already-computed authoritative
 * UnifiedSimilarityResult) as inputs, and never re-runs the matcher or the
 * authoritative computeUnifiedSimilarity.
 *
 * IDEMPOTENT. Every evaluator UPSERTs its telemetry row on
 * (report_device_key, report_id, policy_version), so a repeat POST, a repeat
 * GET, or a POST followed by a GET all converge on the SAME logical row per
 * policy rather than inserting a duplicate. The corpus-duplicate evaluator's
 * UPSERT is additionally EXISTS-guarded on saved_reports, and drizzle/0044 has
 * an AFTER DELETE trigger, so a deferred run whose report was deleted meanwhile
 * writes nothing (and any row it already wrote is removed atomically with the
 * report). This function passes only the stable (deviceKey, id) identity plus
 * production's already-resolved results — nothing an evaluator could turn into a
 * second row.
 *
 * Deferred via lib/run-after-response.ts so it never adds to the caller's
 * response latency in production (and runs inline-and-awaited under the test
 * fallback, same as every other runAfterResponse caller). Best-effort by
 * construction — every evaluator is documented never to throw — with an
 * unconditional catch here as a second safety net so a telemetry failure can
 * never fail a report save or a report read.
 *
 * A report with no verified upload passport is safe: the device-provenance
 * evaluator returns before its first query (as designed — see that module's
 * header), the historical-match evaluator runs unchanged regardless, and the
 * corpus-duplicate evaluator only reads a passport id transiently (resolved to
 * booleans inside SQL by summarizeSubmissionProvenance) and persists none.
 */

export type ScheduleReportShadowEvaluationsParams = {
  reportDeviceKey: string;
  reportId: string;
  /** For a valid report read/write this equals the report owner; null for an anonymous report. */
  accountId: string | null;
  /** The report's own submitted text — reused as-is; never re-fetched, never re-matched. */
  rawText: string;
  /**
   * Production's already-computed historical-match result — normally
   * resolvePrimarySimilaritySummary(...).historicalSubmissionMatch, reused
   * exactly, never re-derived. Every evaluator reads it and returns early for
   * status "UNAVAILABLE".
   */
  productionResult: ReportHistoricalSubmissionMatch;
  /**
   * Phase B2 — production's already-computed authoritative UnifiedSimilarityResult
   * (resolvePrimarySimilaritySummary(...).unifiedSimilarity). null when
   * computeUnifiedSimilarity itself threw for this report (the corpus-duplicate
   * shadow then records status SKIPPED_NO_AUTHORITATIVE). Consumed ONLY by
   * runCorpusDuplicateSuppressionShadowEvaluation; the E8P / device-provenance
   * evaluators ignore it. Reused verbatim — never recomputed.
   *
   * REQUIRED (not optional-with-default): the null case is a real, distinct
   * signal the evaluator must see, so a future caller that forgets to thread it
   * must fail TypeScript rather than silently degrade every report to
   * SKIPPED_NO_AUTHORITATIVE.
   */
  authoritativeUnifiedSimilarity: UnifiedSimilarityResult | null;
  /**
   * Phase B2 — resolvePrimarySimilaritySummary(...).effectiveDeviceSelfRepresentationIds
   * (empty array whenever the Preview same-device SELF flag is off). Passed
   * through to the B1 counterfactual unchanged so the hypothetical differs from
   * authoritative by ONLY the document-local exclusion, and used to mark
   * same-Passport classification. Bare representation ids only. REQUIRED — pass
   * the explicit [] when the flag is off, never omit it.
   */
  effectiveDeviceSelfRepresentationIds: readonly string[];
  /**
   * Phase B2 — resolvePrimarySimilaritySummary(...).corpusGeneration. The
   * corpus-match generation the authoritative resolution reasoned under; a
   * freshness key for the corpus-duplicate shadow row alongside
   * productionResult.computedAt. REQUIRED — no silent 0 default.
   */
  authoritativeCorpusGeneration: number;
  /**
   * Phase B2 — the EXACT archiveMatchedPositions the caller passed into
   * resolvePrimarySimilaritySummary to produce authoritativeUnifiedSimilarity,
   * captured request-locally from the SAME request and threaded straight through
   * to the B1 counterfactual. NEVER re-read from payload_json (a concurrent
   * resave / self-heal could drift it). This is the authoritative-scoring-input
   * parity guarantee. REQUIRED — pass the explicit null when absent.
   */
  authoritativeArchiveMatchedPositions: number[] | null;
  /**
   * Phase B2 — the EXACT externalAcademicEvidence the caller passed into
   * resolvePrimarySimilaritySummary — same request-local parity guarantee as
   * authoritativeArchiveMatchedPositions. REQUIRED — pass the explicit null when
   * absent.
   */
  authoritativeExternalAcademicEvidence: ExternalAcademicEvidence[] | null;
  /**
   * Test seam, mirroring processReportAdmissionJob's own openConnection
   * parameter (app/api/reports/route.ts already threads that pattern through
   * its own deferred callback) — production always uses the default
   * dedicated connection.
   */
  openConnection?: () => Promise<Client> | Client;
};

export async function scheduleReportShadowEvaluations(
  params: ScheduleReportShadowEvaluationsParams,
): Promise<void> {
  const {
    reportDeviceKey,
    reportId,
    accountId,
    rawText,
    productionResult,
    authoritativeUnifiedSimilarity,
    effectiveDeviceSelfRepresentationIds,
    authoritativeCorpusGeneration,
    authoritativeArchiveMatchedPositions,
    authoritativeExternalAcademicEvidence,
  } = params;
  const openConnection = params.openConnection ?? getReportsDbClient;
  await runAfterResponse(async () => {
    let deferredClient: Client | null = null;
    try {
      deferredClient = await openConnection();
      await runHistoricalMatchShadowEvaluation(deferredClient, {
        reportDeviceKey,
        reportId,
        accountId,
        rawText,
        productionResult,
      });
      await runDeviceProvenanceShadowEvaluation(deferredClient, {
        reportDeviceKey,
        reportId,
        accountId,
        rawText,
        productionResult,
      });
      await runCorpusDuplicateSuppressionShadowEvaluation(deferredClient, {
        reportDeviceKey,
        reportId,
        accountId,
        rawText,
        productionResult,
        authoritativeUnifiedSimilarity,
        effectiveDeviceSelfRepresentationIds,
        authoritativeCorpusGeneration,
        archiveMatchedPositions: authoritativeArchiveMatchedPositions,
        externalAcademicEvidence: authoritativeExternalAcademicEvidence,
      });
    } catch (err) {
      // All three evaluators are "never throws" by their own contract; this is
      // a second, unconditional net so a telemetry failure (a broken
      // connection, an unexpected error path — including a failed shadow UPSERT,
      // which by design writes no row and is retried on a later view) can never
      // fail report saving or a report read, and never touches the score.
      console.error(
        "scheduleReportShadowEvaluations: deferred shadow telemetry failed (non-fatal — the similarity score and the response are unaffected):",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      deferredClient?.close();
    }
  });
}
