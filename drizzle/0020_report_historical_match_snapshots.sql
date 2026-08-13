-- Phase E8C: per-saved-report historical-match snapshot cache. Purely
-- additive — no existing table's rows, columns, or constraints change.
-- See db/schema.ts's own comment above this table for the full rationale
-- (report_device_key/report_id mirror saved_reports' own composite primary
-- key, one upserted row per report rather than an appended history, bounded
-- privacy-screened result_json). No DB-level FOREIGN KEY: this project's
-- schema-drift tooling only recognizes single-column references(), not a
-- composite one, and this phase does not modify that shared tooling —
-- cleanup on report deletion is explicit and application-level instead (see
-- app/api/reports/[id]/route.ts's DELETE handler).

CREATE TABLE IF NOT EXISTS report_historical_match_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  report_device_key TEXT NOT NULL,
  report_id TEXT NOT NULL,
  status TEXT NOT NULL,
  matcher_version TEXT,
  fingerprint_version TEXT,
  canonicalization_version TEXT,
  result_json TEXT,
  candidate_count INTEGER,
  processing_duration_ms INTEGER,
  error_message TEXT,
  computed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_report_historical_match_snapshots_report ON report_historical_match_snapshots(report_device_key, report_id);
