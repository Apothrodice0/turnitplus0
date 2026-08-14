-- Phase E8P: production shadow-evaluation telemetry for the proposed E8O
-- historical-match acceptance policy (lib/e8o-historical-match-policy.ts).
-- Purely additive — no existing table's rows, columns, or constraints
-- change, and this table is never read by the production historical-match
-- path (lib/user-submission-matching.ts, lib/report-historical-match.ts):
-- it only ever records the OUTCOME of comparing production's real result
-- against an independently-computed proposed classification, so that
-- decision can be reviewed with real data before any later phase considers
-- rendering it. See lib/e8p-shadow-evaluation.ts's own header comment for
-- the full rationale and the bounded-telemetry discipline every column
-- below follows.
--
-- No document text, no passage text, and no account id are ever stored
-- here — only bounded counts, enums, and timings. report_device_key +
-- report_id mirror report_historical_match_snapshots' own composite key
-- (drizzle/0020_report_historical_match_snapshots.sql) for the same
-- reason: neither value is an account identity, and together they let one
-- row be recomputed idempotently per report per policy version rather than
-- appended on every repeat view. No DB-level FOREIGN KEY, for the same
-- schema-drift-tooling reason documented on that table.
--
-- error_message is truncated to 500 chars by the application before
-- insert (mirroring report_historical_match_snapshots' own convention) and
-- must never contain document/passage content — see this phase's own
-- structural test (tests/e8p-shadow-evaluation.test.mjs) for the
-- enforcement of that rule at the source-code level.

CREATE TABLE IF NOT EXISTS historical_match_shadow_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  report_device_key TEXT NOT NULL,
  report_id TEXT NOT NULL,
  production_status TEXT NOT NULL,
  production_relationship TEXT,
  proposed_status TEXT NOT NULL,
  proposed_relationship TEXT,
  proposed_evidence TEXT,
  agreement TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  passage_level_evaluated_count INTEGER NOT NULL DEFAULT 0,
  freq_index_document_count INTEGER NOT NULL DEFAULT 0,
  submitted_word_count INTEGER NOT NULL DEFAULT 0,
  e8m_runtime_ms INTEGER,
  v2_runtime_ms INTEGER,
  total_runtime_ms INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  correspondence_version TEXT NOT NULL,
  distinctiveness_version TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  computed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_historical_match_shadow_evaluations_report_policy ON historical_match_shadow_evaluations(report_device_key, report_id, policy_version);
