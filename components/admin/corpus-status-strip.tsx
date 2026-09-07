import { CRON_SCHEDULES, nextDailyUtcRun } from "@/lib/cron-schedule";
import { MetricGrid, MetricTile } from "@/components/admin/metric-tile";
import { AdminStatusBadge } from "@/components/admin/status-badge";
import { AdminCollapsible } from "@/components/admin/collapsible";
import { BadgeGroup } from "@/components/admin/badge-list";

type SweepKind = "promotion" | "report_admission" | "retention";
type SweepEntry = { lastRunAt: string; lastStatus: "success" | "failed"; summary: Record<string, number> | null } | null;

/**
 * Structurally mirrors lib/corpus-admission-admin-repo.ts's own
 * CorpusAdmissionOperationalSummary shape — duplicated locally rather than
 * imported, the same convention components/admin/corpus-search.tsx and
 * corpus-detail.tsx already use for their own admin-repo-shaped props, so
 * this presentational component carries no corpus-admission-* import of
 * its own (TypeScript's structural typing checks the caller's real object
 * against this shape at the JSX call site regardless).
 */
type OperationalSummary = {
  retryablePromotionCount: number;
  deadLetteredPromotionCount: number;
  sweeps: Record<SweepKind, SweepEntry>;
};

const SWEEP_LABELS: Record<SweepKind, string> = {
  report_admission: "Admission sweep",
  retention: "Retention sweep",
  promotion: "Promotion sweep",
};

/** Each kind's own display schedule — report_admission and retention share one cron entry (both run from the SAME 03:00 route), promotion has its own. */
const SWEEP_SCHEDULE: Record<SweepKind, { hourUtc: number }> = {
  report_admission: CRON_SCHEDULES.admissionRetention,
  retention: CRON_SCHEDULES.admissionRetention,
  promotion: CRON_SCHEDULES.promotion,
};

function hourLabel(hourUtc: number): string {
  return `${String(hourUtc).padStart(2, "0")}:00 UTC`;
}

/** corpus_admission_sweep_runs.last_run_at is a plain SQLite CURRENT_TIMESTAMP string ("YYYY-MM-DD HH:MM:SS", implicitly UTC, no timezone suffix) — normalized to a real UTC instant before formatting. */
function formatUtcTimestamp(sqliteTimestamp: string): string {
  const isoLike = sqliteTimestamp.includes("T") ? sqliteTimestamp : sqliteTimestamp.replace(" ", "T");
  const withZone = isoLike.endsWith("Z") ? isoLike : `${isoLike}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) return sqliteTimestamp;
  return `${formatUtcInstant(date)} UTC`;
}

function formatUtcInstant(date: Date): string {
  return date.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
}

/**
 * Admin-only operational status strip for /admin/corpus — a plain,
 * server-rendered presentational component (no "use client": there is no
 * interaction here — no filter, no polling, no button — so no client
 * boundary is warranted; see this project's own convention of reserving
 * "use client" for components that actually need browser-side state or
 * event handlers, e.g. components/admin/corpus-search.tsx's real
 * filter/pagination interactivity). `summary` is already resolved
 * server-side by the caller (app/admin/corpus/page.tsx, itself an
 * authenticated, force-dynamic server component) via
 * lib/corpus-admission-admin-repo.ts's getCorpusAdmissionOperationalSummary
 * — called directly, not through a dedicated API route; a route existed
 * for this earlier and was removed as unnecessary indirection once the
 * data is only ever needed for this one server-rendered page. `summary`
 * is null when that server-side call itself failed (a DB error, logged
 * non-fatally by the caller) — rendered as "unavailable," never thrown
 * past this component.
 *
 * Never renders an account id, report id, decision id, representation id,
 * filename, email, source ref, or raw error/exception text — `summary`
 * itself structurally cannot contain any of those (see
 * lib/corpus-admission-sweep-state.ts's numeric-only allowlist and
 * getCorpusAdmissionOperationalSummary's own comment).
 *
 * `vercelEnv` is process.env.VERCEL_ENV, read server-side and passed
 * down — Vercel Cron only ever invokes Production, so anything OTHER than
 * "production" renders the schedule-only caveat instead of a persisted
 * sweep history that would misleadingly appear to belong to this
 * deployment (see this component's own non-production branch below).
 */
export function AdminCorpusStatusStrip({
  vercelEnv,
  promotionEnabled,
  retentionEnabled,
  sourceMatchingEnabled,
  summary,
}: {
  vercelEnv: string | undefined;
  promotionEnabled: boolean;
  retentionEnabled: boolean;
  sourceMatchingEnabled: boolean;
  summary: OperationalSummary | null;
}) {
  const isProduction = vercelEnv === "production";
  const sweepKinds: SweepKind[] = ["report_admission", "retention", "promotion"];
  const sweepDetails: { kind: SweepKind; summary: Record<string, number> }[] = [];
  for (const kind of sweepKinds) {
    const entrySummary = summary?.sweeps[kind]?.summary;
    if (entrySummary) sweepDetails.push({ kind, summary: entrySummary });
  }

  return (
    <div className="admin-corpus-status-strip">
      <MetricGrid>
        <MetricTile label="Promotion" value={promotionEnabled ? "Enabled" : "Disabled"} />
        <MetricTile label="Retention" value={retentionEnabled ? "Enabled" : "Disabled"} />
        <MetricTile label="Source matching" value={sourceMatchingEnabled ? "Enabled" : "Disabled"} />
        <MetricTile label="Retrying promotions" value={summary ? summary.retryablePromotionCount : "—"} />
        <MetricTile label="Dead-lettered promotions" value={summary ? summary.deadLetteredPromotionCount : "—"} />
      </MetricGrid>

      {isProduction ? (
        <div className="admin-table-scroll">
          <table className="developer-table">
            <thead>
              <tr>
                <th>Sweep</th>
                <th>Last run</th>
                <th>Status</th>
                <th>Next run</th>
              </tr>
            </thead>
            <tbody>
              {sweepKinds.map((kind) => {
                const entry = summary?.sweeps[kind] ?? null;
                const next = `${formatUtcInstant(nextDailyUtcRun(SWEEP_SCHEDULE[kind].hourUtc))} UTC`;
                return (
                  <tr key={kind}>
                    <td>{SWEEP_LABELS[kind]}</td>
                    <td>{entry ? formatUtcTimestamp(entry.lastRunAt) : "never"}</td>
                    <td>{entry ? <AdminStatusBadge status={entry.lastStatus} /> : "—"}</td>
                    <td>{next}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="admin-corpus-status-note">
          Cron schedule: Production only · admission/retention {hourLabel(CRON_SCHEDULES.admissionRetention.hourUtc)} · promotion {hourLabel(CRON_SCHEDULES.promotion.hourUtc)}
        </p>
      )}

      {sweepDetails.length > 0 && (
        <AdminCollapsible summary="Sweep run details">
          {sweepDetails.map(({ kind, summary: sweepSummary }) => (
            <BadgeGroup key={kind} label={SWEEP_LABELS[kind]} distribution={sweepSummary} />
          ))}
        </AdminCollapsible>
      )}
    </div>
  );
}
