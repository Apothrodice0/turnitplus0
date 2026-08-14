import type { Client } from "@libsql/client";
import { E8I_B_SNAPSHOT_TARGETS, type SnapshotTarget } from "./e8i-b-snapshot-targets";
import { verifySnapshotTarget, type SnapshotVerification } from "./e8i-b-snapshot-runner";

/**
 * Phase E8I-B: the only module that writes. Re-runs verifySnapshotTarget()
 * itself immediately before deleting — never trusts a previously-computed
 * plan. Deletes exactly one report_historical_match_snapshots row, scoped
 * by its full composite primary key (report_device_key, report_id) — the
 * same pair the table's own unique index enforces, so this can never touch
 * more than one row. Touches no other table.
 */

export type SnapshotApplyOutcome =
  | { status: "deleted"; cluster: number; reportId: string; deviceKey: string }
  | { status: "refused"; cluster: number; verification: SnapshotVerification };

export async function applyVerifiedSnapshotInvalidation(client: Client, target: SnapshotTarget): Promise<SnapshotApplyOutcome> {
  const verification = await verifySnapshotTarget(client, target);
  if (!verification.ok) {
    return { status: "refused", cluster: target.cluster, verification };
  }
  await client.execute({
    sql: "DELETE FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [target.deviceKey, target.reportId],
  });
  return { status: "deleted", cluster: target.cluster, reportId: target.reportId, deviceKey: target.deviceKey };
}

export async function applyAllVerifiedSnapshotInvalidations(
  client: Client,
  targets: readonly SnapshotTarget[] = E8I_B_SNAPSHOT_TARGETS,
): Promise<SnapshotApplyOutcome[]> {
  const outcomes: SnapshotApplyOutcome[] = [];
  for (const target of targets) {
    outcomes.push(await applyVerifiedSnapshotInvalidation(client, target));
  }
  return outcomes;
}
