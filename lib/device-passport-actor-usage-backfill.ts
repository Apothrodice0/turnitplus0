import type { Client } from "@libsql/client";
import {
  recordDevicePassportActorUsage,
  resolveActorObservation,
  type ActorObservation,
} from "./device-passport-actor-ledger";

/**
 * Device Passport actor-usage ledger — OPTIONAL backfill helper (drizzle/0041).
 *
 * NOT wired into any route, sweep, or cron. Provided so an operator CAN seed
 * device_passport_actor_usage from the (passport, account) associations that
 * still survive in saved_reports.verified_device_passport_id.
 *
 * HARD RULES this helper obeys, by construction:
 *   - It is POSITIVE EVIDENCE ONLY. It records observations that provably
 *     happened; it does NOT and CANNOT reconstruct deleted historical
 *     accounts or past anonymous use.
 *   - It NEVER writes device_passports.actor_usage_tracking_version. A legacy
 *     passport stays version 0 (history-incomplete) no matter how much
 *     surviving evidence is backfilled. There is deliberately no code path
 *     here that touches that column.
 *   - It only ever UPSERTs (recordDevicePassportActorUsage): first_observed_at
 *     preserved, last_observed_at advanced, observation_count incremented.
 *     Never deletes, never decrements.
 *
 * An authenticated report's actor key needs the actor HMAC key
 * (DEVICE_PASSPORT_ACTOR_HMAC_KEY). Without it, those rows are SKIPPED and
 * counted — never guessed, never stored as a raw account id. Anonymous reports
 * (user_id IS NULL) need no key.
 */

export type ActorUsageBackfillResult = {
  /** saved_reports rows with a verified passport that were examined. */
  scanned: number;
  /** rows that produced a resolvable actor observation (UPSERTed when !dryRun, would be UPSERTed when dryRun). */
  observations: number;
  /** actor-usage UPSERTs actually performed — always 0 when dryRun. */
  observationsRecorded: number;
  /** authenticated rows skipped because the actor HMAC key was unavailable. */
  skippedNoActorKey: number;
  /** rows whose report_created_at could not be parsed (last_observed_at fell back to now). */
  unparseableTimestamps: number;
  dryRun: boolean;
};

type SavedReportRow = {
  device_key: string;
  id: string;
  user_id: string | null;
  verified_device_passport_id: string;
  report_created_at: string | null;
};

export async function backfillDevicePassportActorUsageFromSavedReports(
  client: Client,
  options: { dryRun?: boolean; limit?: number } = {},
): Promise<ActorUsageBackfillResult> {
  const dryRun = options.dryRun ?? true;
  const limitClause = typeof options.limit === "number" && Number.isFinite(options.limit)
    ? ` LIMIT ${Math.max(0, Math.floor(options.limit))}`
    : "";

  // Oldest first, so a genuine repeat (same passport + same actor across
  // several reports) lands its earliest report as first_observed_at.
  const result = await client.execute(
    `SELECT device_key, id, user_id, verified_device_passport_id, report_created_at
       FROM saved_reports
      WHERE verified_device_passport_id IS NOT NULL
      ORDER BY report_created_at ASC${limitClause}`,
  );
  const rows = result.rows as unknown as SavedReportRow[];

  let observations = 0;
  let observationsRecorded = 0;
  let skippedNoActorKey = 0;
  let unparseableTimestamps = 0;

  for (const row of rows) {
    const observation: ActorObservation | null = resolveActorObservation(row.user_id ?? null);
    if (!observation) {
      // Authenticated row, but no actor HMAC key — never guess, never store a
      // raw account id.
      skippedNoActorKey += 1;
      continue;
    }
    observations += 1;

    const parsed = row.report_created_at ? Date.parse(row.report_created_at) : NaN;
    let observedAt = parsed;
    if (!Number.isFinite(parsed)) {
      unparseableTimestamps += 1;
      observedAt = Date.now();
    }

    if (!dryRun) {
      await recordDevicePassportActorUsage(client, {
        devicePassportId: row.verified_device_passport_id,
        observation,
        observedAt,
      });
      observationsRecorded += 1;
    }
  }

  return {
    scanned: rows.length,
    observations,
    observationsRecorded,
    skippedNoActorKey,
    unparseableTimestamps,
    dryRun,
  };
}
