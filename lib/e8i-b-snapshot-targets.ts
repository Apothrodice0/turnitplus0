import { E8I_CLEANUP_TARGETS } from "./e8i-cleanup-targets";

/**
 * Phase E8I-B: the allowlist of exactly the 4 report_historical_match_snapshots
 * rows to invalidate — one per report affected by E8I's now-completed
 * identity/reference cleanup. Deliberately DERIVED from
 * E8I_CLEANUP_TARGETS's own expectedReportId/expectedDeviceKey fields rather
 * than re-typed, so the two phases' allowlists can never silently diverge
 * (e.g. a report id transcribed correctly in one phase and wrong in the
 * other) — there is exactly one pinned source of truth for "which 4
 * reports," and it was already independently verified against production
 * during E8I.
 *
 * expectedComputedAtObservedDuringE8HAudit is informational only (shown in
 * the dry-run report, never gates a refusal) — see
 * lib/e8i-b-snapshot-runner.ts's own comment on why a changed computed_at
 * is not, by itself, a reason to refuse.
 */

export type SnapshotTarget = {
  cluster: number;
  title: string;
  reportId: string;
  deviceKey: string;
  expectedStatus: "MATCHED";
  expectedComputedAtObservedDuringE8HAudit: string;
};

export const E8I_B_SNAPSHOT_TARGETS: readonly SnapshotTarget[] = E8I_CLEANUP_TARGETS.map((t) => ({
  cluster: t.cluster,
  title: t.title,
  reportId: t.expectedReportId,
  deviceKey: t.expectedDeviceKey,
  expectedStatus: "MATCHED" as const,
  expectedComputedAtObservedDuringE8HAudit: {
    1: "2026-08-14T03:48:44.549Z",
    2: "2026-08-14T03:53:24.135Z",
    3: "2026-08-14T03:50:03.918Z",
    4: "2026-08-14T03:46:50.307Z",
  }[t.cluster] as string,
}));
