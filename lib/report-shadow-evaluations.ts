import type { Client } from "@libsql/client";
import { getReportsDbClient } from "./reports-db";
import { runAfterResponse } from "./run-after-response";
import { runHistoricalMatchShadowEvaluation } from "./e8p-shadow-evaluation";
import { runDeviceProvenanceShadowEvaluation } from "./device-provenance-shadow";
import type { ReportHistoricalSubmissionMatch } from "./report-types";

/**
 * The ONE trigger for the two post-report shadow-telemetry evaluators:
 *   - lib/e8p-shadow-evaluation.ts's runHistoricalMatchShadowEvaluation
 *     (Phase E8P — the proposed E8O historical-match acceptance policy,
 *     measured against the real production result), and
 *   - lib/device-provenance-shadow.ts's runDeviceProvenanceShadowEvaluation
 *     (Device Passport Phase 4 — the same-device prior-submission SELF
 *     proposal, measured against the real production result).
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
 * MEASUREMENT ONLY, cannot change the score. Neither evaluator writes
 * report_historical_match_snapshots, saved_reports, or any scoring field —
 * their sole write target is historical_match_shadow_evaluations
 * (drizzle/0021), each under its own distinct policy_version. It reuses
 * production's already-computed historicalSubmissionMatch as an input and
 * never re-runs the matcher or recomputes computeUnifiedSimilarity.
 *
 * IDEMPOTENT. Both evaluators UPSERT their telemetry row on
 * (report_device_key, report_id, policy_version), so a repeat POST, a repeat
 * GET, or a POST followed by a GET all converge on the SAME logical row per
 * policy rather than inserting a duplicate. This function passes only the
 * stable (deviceKey, id) identity plus production's result — nothing an
 * evaluator could turn into a second row.
 *
 * Deferred via lib/run-after-response.ts so it never adds to the caller's
 * response latency in production (and runs inline-and-awaited under the test
 * fallback, same as every other runAfterResponse caller). Best-effort by
 * construction — both evaluators are documented never to throw — with an
 * unconditional catch here as a second safety net so a telemetry failure can
 * never fail a report save or a report read.
 *
 * A report with no verified upload passport is safe: the device-provenance
 * evaluator returns before its first query (as designed — see that module's
 * header), and the historical-match evaluator runs unchanged regardless.
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
   * exactly, never re-derived. Both evaluators read it and return early for
   * status "UNAVAILABLE".
   */
  productionResult: ReportHistoricalSubmissionMatch;
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
  const { reportDeviceKey, reportId, accountId, rawText, productionResult } = params;
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
    } catch (err) {
      // Both evaluators are "never throws" by their own contract; this is a
      // second, unconditional net so a telemetry failure (a broken
      // connection, an unexpected error path) can never fail report saving
      // or a report read, and never touches the score.
      console.error(
        "scheduleReportShadowEvaluations: deferred shadow telemetry failed (non-fatal — the similarity score and the response are unaffected):",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      deferredClient?.close();
    }
  });
}
