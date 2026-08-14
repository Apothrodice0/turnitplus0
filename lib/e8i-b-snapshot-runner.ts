import type { Client } from "@libsql/client";
import { E8I_B_SNAPSHOT_TARGETS, type SnapshotTarget } from "./e8i-b-snapshot-targets";
import { maskId } from "./e8i-cleanup-runner";

/**
 * Phase E8I-B: read-only verification + dry-run planning for invalidating
 * the 4 stale report_historical_match_snapshots rows left behind by E8I's
 * identity/reference cleanup. Same discipline as lib/e8i-cleanup-runner.ts:
 * never reads process.env, issues SELECT statements only — the one function
 * that writes lives in the separate lib/e8i-b-snapshot-apply.ts.
 *
 * A cached "MATCHED" snapshot is never re-derived by new corpus content
 * arriving (see lib/report-historical-match.ts's own header comment) — that
 * is precisely why these 4 rows need an explicit delete rather than waiting
 * for them to self-correct: deleting the row is what makes the next report
 * view recompute from the now-corrected corpus.
 *
 * computed_at drift (the row's timestamp has changed since the original
 * E8H/E8I audit observed it) is NOT a refusal condition here — it only
 * means someone already viewed the report and it already recomputed. If it
 * recomputed to something other than MATCHED, the STATUS_MATCHED check
 * below already refuses (nothing to invalidate, it is no longer stale). If
 * it recomputed and is still MATCHED, invalidating it again is harmless
 * (forces one more recompute of an already-correct value) — so this is
 * surfaced as information in the dry-run report, never as a hard refusal.
 */

export type CheckResult = { code: string; ok: boolean; message: string };

export type SnapshotVerification = {
  cluster: number;
  target: SnapshotTarget;
  checks: CheckResult[];
  ok: boolean;
  observedStatus: string | null;
  observedComputedAt: string | null;
};

function check(code: string, ok: boolean, message: string): CheckResult {
  return { code, ok, message };
}

type SnapshotRow = { report_device_key: string; report_id: string; status: string; computed_at: string };

export async function verifySnapshotTarget(client: Client, target: SnapshotTarget): Promise<SnapshotVerification> {
  const checks: CheckResult[] = [];

  const snapshotResult = await client.execute({
    sql: "SELECT report_device_key, report_id, status, computed_at FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [target.deviceKey, target.reportId],
  });
  const rows = snapshotResult.rows as unknown as SnapshotRow[];
  const snapshot = rows[0] ?? null;

  checks.push(check("SNAPSHOT_EXISTS", rows.length === 1, rows.length === 1 ? "exactly one snapshot row exists for this (device_key, report_id) pair" : `REFUSED: expected exactly 1 snapshot row, found ${rows.length}`));

  if (rows.length !== 1) {
    return { cluster: target.cluster, target, checks, ok: false, observedStatus: null, observedComputedAt: null };
  }

  const keyMatch = snapshot!.report_device_key === target.deviceKey && snapshot!.report_id === target.reportId;
  checks.push(check("KEY_MATCH", keyMatch, keyMatch ? "snapshot row's own key columns match the expected pair" : "REFUSED: snapshot row's key columns do not match the expected (device_key, report_id) pair"));

  const statusMatch = snapshot!.status === target.expectedStatus;
  checks.push(check("STATUS_MATCHED", statusMatch, statusMatch ? `status is ${target.expectedStatus} as expected` : `REFUSED: expected status ${target.expectedStatus}, found ${snapshot!.status}`));

  const savedReportResult = await client.execute({
    sql: "SELECT id FROM saved_reports WHERE id = ? AND device_key = ?",
    args: [target.reportId, target.deviceKey],
  });
  const reportExists = savedReportResult.rows.length === 1;
  checks.push(check("REPORT_STILL_EXISTS", reportExists, reportExists ? "the mapped saved_reports row still exists" : "REFUSED: the mapped saved_reports row no longer exists"));

  const extraResult = await client.execute({
    sql: "SELECT report_device_key, report_id FROM report_historical_match_snapshots WHERE report_id = ?",
    args: [target.reportId],
  });
  const extraRows = extraResult.rows as unknown as { report_device_key: string; report_id: string }[];
  const noExtra = extraRows.length === 1 && extraRows[0].report_device_key === target.deviceKey;
  checks.push(check(
    "NO_EXTRA_SNAPSHOT_MATCH",
    noExtra,
    noExtra ? "no unrelated snapshot row shares this report_id under a different device_key" : `REFUSED: found ${extraRows.length} snapshot row(s) for report_id ${target.reportId}, expected exactly 1 under the expected device_key`,
  ));

  return {
    cluster: target.cluster,
    target,
    checks,
    ok: checks.every((c) => c.ok),
    observedStatus: snapshot!.status,
    observedComputedAt: snapshot!.computed_at,
  };
}

export type SnapshotPlanEntry = {
  cluster: number;
  title: string;
  verification: SnapshotVerification;
  computedAtDrifted: boolean;
  plannedAction: "DELETE_SNAPSHOT" | "NONE";
};

export type E8IBSnapshotPlan = {
  generatedAt: string;
  entries: SnapshotPlanEntry[];
  allVerified: boolean;
  summary: { snapshotsToDelete: number };
};

export async function planSnapshotInvalidation(
  client: Client,
  targets: readonly SnapshotTarget[] = E8I_B_SNAPSHOT_TARGETS,
): Promise<E8IBSnapshotPlan> {
  const entries: SnapshotPlanEntry[] = [];
  for (const target of targets) {
    const verification = await verifySnapshotTarget(client, target);
    const computedAtDrifted = verification.observedComputedAt !== null && verification.observedComputedAt !== target.expectedComputedAtObservedDuringE8HAudit;
    entries.push({
      cluster: target.cluster,
      title: target.title,
      verification,
      computedAtDrifted,
      plannedAction: verification.ok ? "DELETE_SNAPSHOT" : "NONE",
    });
  }
  const allVerified = entries.every((e) => e.verification.ok);
  return {
    generatedAt: new Date().toISOString(),
    entries,
    allVerified,
    summary: { snapshotsToDelete: entries.filter((e) => e.plannedAction === "DELETE_SNAPSHOT").length },
  };
}

export function renderSnapshotDryRunReport(plan: E8IBSnapshotPlan): string {
  const lines: string[] = [];
  lines.push(`=== E8I-B DRY-RUN SNAPSHOT INVALIDATION PLAN (generated ${plan.generatedAt}) ===`);
  lines.push("");
  for (const entry of plan.entries) {
    lines.push(`--- Cluster ${entry.cluster}: "${entry.title}" ---`);
    lines.push(`  report ID: ${entry.verification.target.reportId}`);
    lines.push(`  masked device key: ${maskId(entry.verification.target.deviceKey)}`);
    lines.push(`  observed status: ${entry.verification.observedStatus ?? "(none)"}`);
    lines.push(`  observed computed_at: ${entry.verification.observedComputedAt ?? "(none)"}${entry.computedAtDrifted ? "  [DRIFTED since original audit — informational only, does not block]" : ""}`);
    lines.push(`  verification: ${entry.verification.ok ? "PASSED" : "FAILED"}`);
    for (const c of entry.verification.checks) {
      lines.push(`    [${c.ok ? "ok" : "FAIL"}] ${c.code}: ${c.message}`);
    }
    lines.push(`  planned action: ${entry.plannedAction}`);
    lines.push("");
  }
  lines.push("=== SUMMARY ===");
  lines.push(`${plan.summary.snapshotsToDelete} report_historical_match_snapshots rows would be deleted`);
  lines.push(`all targets verified: ${plan.allVerified ? "YES" : "NO — see FAILED checks above, nothing would be deleted for any target that failed"}`);
  return lines.join("\n");
}
