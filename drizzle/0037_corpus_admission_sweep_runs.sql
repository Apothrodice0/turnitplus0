-- Durable SINGLETON operational-state table for the admin corpus dashboard's
-- status strip — NOT a history log: exactly one row per logical sweep kind
-- ('promotion' | 'report_admission' | 'retention'), upserted in place on
-- every real invocation, the same "one row of durable global operational
-- state" pattern drizzle/0036's corpus_match_generation already establishes
-- in this schema (see that migration's own comment) — the difference here
-- is a small fixed SET of singleton rows (keyed by sweep_kind) rather than
-- one single row keyed by a constant id, since three logically independent
-- operations each need their own last-run/last-status.
--
-- Rows are created LAZILY, only when a sweep actually runs (see
-- lib/corpus-admission-sweep-state.ts's own header comment) — unlike
-- corpus_match_generation, this migration does NOT seed any rows. No
-- persisted row for a given sweep_kind means exactly "this sweep has never
-- run" (the admin UI's own "Last sweep: never"), which is a real, valid,
-- and common state (a fresh environment, or a kind whose feature flag has
-- always been off) — seeding a fake row would misrepresent that.
--
-- Deliberately carries NO account/report/decision/representation-shaped
-- column, and last_summary_json is built ONLY from a typed allowlist of
-- plain numeric counts by the one writer that ever populates it (see
-- lib/corpus-admission-sweep-state.ts's recordSweepRun) — never an exception
-- message, stack trace, or any identifier. This table is read by the
-- admin-only corpus dashboard alone; a sweep's own detailed per-row
-- failure text continues to live only on corpus_admission_report_jobs.last_error
-- / corpus_admission_promotions.last_error, already admin-detail-only.
CREATE TABLE IF NOT EXISTS corpus_admission_sweep_runs (
  -- 'promotion' | 'report_admission' | 'retention' — no CHECK constraint,
  -- consistent with every other free-form status/kind column in this
  -- schema (e.g. corpus_admission_promotions.status); the three real values
  -- are the sole responsibility of lib/corpus-admission-sweep-state.ts's own
  -- SweepKind type.
  sweep_kind TEXT PRIMARY KEY NOT NULL,
  last_run_at TEXT NOT NULL,
  -- 'success' | 'failed' — whether the sweep OPERATION itself completed
  -- without throwing, not a judgment on individual rows it processed (a
  -- run that claims and correctly marks some rows 'failed'/'dead_lettered'
  -- is still an operationally 'success'ful run — those per-row outcomes
  -- are exactly what last_summary_json's own counts already represent).
  last_status TEXT NOT NULL,
  -- Bounded JSON object of plain numeric counts only (e.g. claimedCount,
  -- outcomeSummary.indexed, decisionsDeleted) — see this migration's own
  -- header comment. NULL when a run produced no countable summary at all.
  last_summary_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
