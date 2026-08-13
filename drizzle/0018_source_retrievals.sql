-- Phase E6C: external source retrieval records. Purely additive — no
-- existing table is touched, including provenance_sources/provenance_events
-- /provenance_evidence/provenance_verification_decisions (Phases E1/E4/E5)
-- and discovery_attempts (Phase E6A).
--
-- Append-only. The only foreign key is source_id, into provenance_sources —
-- this table is never linked to document_identities, saved_reports, or any
-- provenance/evidence table directly; external retrieved content is never
-- treated as, or merged into, a TurnitPlus user document. No raw HTML is
-- stored — only hashes and a bounded extracted-text excerpt. See
-- lib/retrieval-repository.ts and db/schema.ts's own comment on this table.
CREATE TABLE IF NOT EXISTS source_retrievals (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  source_id TEXT NOT NULL REFERENCES provenance_sources(id) ON DELETE CASCADE,
  original_url TEXT NOT NULL,
  final_url TEXT,
  http_status INTEGER,
  content_type TEXT,
  retrieved_at TEXT NOT NULL,
  raw_sha256 TEXT,
  canonical_sha256 TEXT,
  extracted_text_excerpt TEXT,
  extractor_version TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_source_retrievals_source_id ON source_retrievals(source_id);
