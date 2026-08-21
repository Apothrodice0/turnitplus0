-- Developer-diagnostics addition: one row per live /api/academic-evidence
-- run. Captured additively in app/api/reports/route.ts's existing deferred
-- runAfterResponse callback — the same one that already creates a
-- document_identities row on first save. Before this table existed,
-- runAcademicSearch's own per-run diagnostics (generated queries, ranked
-- candidates, per-candidate retrieval/comparison outcome, provider errors,
-- stage timings) were computed on every real submission and then discarded
-- — this is pure instrumentation, storing values the pipeline already
-- produces; nothing in lib/academic-search/ changes what it ranks,
-- retrieves, or reports as evidence because this table exists.
--
-- document_identity_id is nullable (identity capture can fail independently
-- of this capture) and ON DELETE SET NULL, matching every other optional
-- document_identity_id reference in this schema. report_device_key/
-- report_id mirror saved_reports' own composite primary key as a second,
-- independent lookup path, with no DB-level FOREIGN KEY on the composite
-- pair — same reasoning as report_historical_match_snapshots (this
-- project's schema-drift tooling only recognizes single-column
-- references()). Variable-shape pipeline data is kept as JSON columns
-- rather than a wide, mostly-duplicative column set, matching this
-- project's own existing convention for that (see provenance_evidence).
CREATE TABLE IF NOT EXISTS academic_search_run_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  document_identity_id TEXT REFERENCES document_identities(id) ON DELETE SET NULL,
  report_device_key TEXT,
  report_id TEXT,
  status TEXT NOT NULL,
  total_latency_ms INTEGER NOT NULL,
  stats_json TEXT NOT NULL,
  queries_json TEXT,
  candidates_json TEXT,
  retrieval_diagnostics_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_academic_search_run_diagnostics_document_identity_id ON academic_search_run_diagnostics(document_identity_id);
CREATE INDEX IF NOT EXISTS idx_academic_search_run_diagnostics_report ON academic_search_run_diagnostics(report_device_key, report_id);
