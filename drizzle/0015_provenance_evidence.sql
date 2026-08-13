-- Phase E4: provenance evidence records. Purely additive — no existing table
-- is touched, including provenance_sources/provenance_events from Phase E1.
--
-- Append-only, like provenance_events: nothing in the repository layer
-- (lib/provenance-evidence.ts) updates or deletes a row here. If a
-- previously-recorded fact changes (a URL that was reachable becomes
-- unreachable, for instance), a NEW row is inserted recording the new
-- observation; the old row is left exactly as it was. payload_json holds
-- the type-specific structured facts for evidence_type (see
-- lib/provenance-evidence-types.ts for the controlled vocabulary and the
-- shape each type's payload is expected to have) — kept as a single JSON
-- column rather than a wide, mostly-NULL column set, matching this schema's
-- existing precedent (saved_reports.payload_json, analysis_runs.result_json,
-- index_versions.assets_json) for "structured data whose shape varies by
-- row kind."
CREATE TABLE IF NOT EXISTS provenance_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  source_id TEXT NOT NULL REFERENCES provenance_sources(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_provenance_evidence_source_id ON provenance_evidence(source_id);
CREATE INDEX IF NOT EXISTS idx_provenance_evidence_type ON provenance_evidence(evidence_type);
