import type { Client } from "@libsql/client";

/**
 * Read/write access to corpus_admission_sweep_runs (drizzle/0037) — the
 * durable SINGLETON operational-state table the admin corpus dashboard's
 * status strip reads. Named WITH the "corpus-admission-" prefix like every
 * other module in this feature family, and deliberately so: it is its own
 * explicit, closed door in tests/corpus-admission-privacy.test.mjs's
 * allowlist system (the SWEEP_STATE_DOOR_MODULE constant there), not an
 * attempt to sit outside that guard by naming around it. The allowlist is
 * intentionally small and exact — see that test file's own
 * EXPECTED_APP_FILES_USING_THE_SWEEP_STATE_DOOR — because this module,
 * like every other door, must have a closed, reviewed set of callers even
 * though it carries no consent/account-shaped data of its own (bounded
 * numeric counts only — see SweepRunSummary below).
 *
 * recordSweepRun is called by exactly three sites, one per SweepKind:
 *   - app/api/internal/corpus-admission-promotion-sweep/route.ts -> 'promotion'
 *   - app/api/internal/corpus-admission-sweep/route.ts -> 'report_admission'
 *     and, independently, 'retention' (two separate calls — see that
 *     route's own comment for why the two operations must never share one
 *     row: one can succeed while the other fails in the same invocation).
 * A sweep writes its own row ONLY when its own feature flag is enabled AND
 * it was actually attempted — the disabled-flag branch of every caller
 * returns before ever reaching this module, so a disabled sweep neither
 * writes a fake successful run nor overwrites whatever real run history
 * already exists. This module itself does not know or care about flags;
 * it only ever runs when a caller has already decided to attempt a sweep.
 *
 * getSweepRunRecords is read by lib/corpus-admission-admin-repo.ts's own
 * getCorpusAdmissionOperationalSummary — the admin corpus dashboard's
 * status-strip data source, called directly, server-side, from
 * app/admin/corpus/page.tsx (an already-authenticated, force-dynamic
 * server component) — no separate API route exists for this, on purpose.
 */

export type SweepKind = "promotion" | "report_admission" | "retention";
export type SweepRunStatus = "success" | "failed";

/**
 * Every value here becomes a bound argument to a JSON.stringify'd object —
 * the ENTIRE allowlist of what can ever be persisted. Deliberately typed as
 * plain numbers only (never string, never nested objects) so a caller
 * cannot smuggle an exception message, a stack trace, or any identifier
 * through this path even by mistake — sanitizeSummary below is a second,
 * independent belt-and-suspenders filter that drops anything non-numeric
 * at the boundary, so this is enforced twice: once by the type system,
 * once at runtime.
 */
export type SweepRunSummary = Record<string, number>;

export type SweepRunRecord = {
  sweepKind: SweepKind;
  lastRunAt: string;
  lastStatus: SweepRunStatus;
  /** Parsed back from last_summary_json — always a flat, numeric-only object, or null if the run produced no countable summary. */
  summary: Record<string, number> | null;
};

type RawSweepRunRow = {
  sweep_kind: string;
  last_run_at: string;
  last_status: string;
  last_summary_json: string | null;
};

/** Strips anything that isn't a finite number — see this module's own header comment on why this is a second, runtime-enforced layer of the same allowlist the SweepRunSummary type already expresses. */
function sanitizeSummary(summary: SweepRunSummary | undefined): string | null {
  if (!summary) return null;
  const clean: Record<string, number> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : null;
}

/** Best-effort parse — a malformed/legacy row degrades to no summary rather than throwing; the admin strip has nothing useful to render from a summary anyway beyond its own counts. */
function parseSummary(json: string | null): Record<string, number> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const clean: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
      }
      return Object.keys(clean).length > 0 ? clean : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Upserts this sweep kind's own singleton row — never a second, appended
 * row (ON CONFLICT DO UPDATE, keyed by the table's own sweep_kind primary
 * key). Called once per real sweep attempt, after the attempt has already
 * concluded (success or thrown) — never speculatively before, and never at
 * all when the caller's own feature flag was off. Swallows its own write
 * failure rather than throwing: a telemetry write must never be able to
 * turn a real sweep's own success into an apparent failure for its
 * caller — see each call site's own comment for how the failure is
 * surfaced (a console.error, never a re-thrown error).
 */
export async function recordSweepRun(client: Client, kind: SweepKind, result: { status: SweepRunStatus; summary?: SweepRunSummary }): Promise<void> {
  const summaryJson = sanitizeSummary(result.summary);
  await client.execute({
    sql: `INSERT INTO corpus_admission_sweep_runs (sweep_kind, last_run_at, last_status, last_summary_json, updated_at)
          VALUES (?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(sweep_kind) DO UPDATE SET
            last_run_at = excluded.last_run_at,
            last_status = excluded.last_status,
            last_summary_json = excluded.last_summary_json,
            updated_at = excluded.updated_at`,
    args: [kind, result.status, summaryJson],
  });
}

/**
 * Reads every sweep-kind row that currently exists — absent entries (a
 * kind that has never run) are simply missing from the returned array, not
 * padded with a placeholder; the admin repo's own aggregate query is what
 * turns "missing" into the UI's "Last sweep: never" for each of the three
 * known kinds. Read-only, no authorization of its own — same discipline as
 * every other function in the corpus-admission-admin-repo.ts family this
 * is designed to be called from.
 */
export async function getSweepRunRecords(client: Client): Promise<SweepRunRecord[]> {
  const result = await client.execute("SELECT sweep_kind, last_run_at, last_status, last_summary_json FROM corpus_admission_sweep_runs");
  return (result.rows as unknown as RawSweepRunRow[]).map((row) => ({
    sweepKind: row.sweep_kind as SweepKind,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as SweepRunStatus,
    summary: parseSummary(row.last_summary_json),
  }));
}
