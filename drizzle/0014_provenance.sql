-- Phase E1: provenance infrastructure. Purely additive — no existing table
-- (documents/.../contributions, document_identities/.../document_family_members,
-- saved_reports, users, sessions) is touched. Two new tables only.
--
-- provenance_sources.document_identity_id is nullable and only set when a
-- row represents a TurnitPlus account's own submission (OBSERVED_SUBMISSION),
-- not an external candidate source. No account_id column exists here at all
-- — see lib/provenance-registry.ts's createObservedSubmissionProvenance,
-- which never accepts one.
CREATE TABLE IF NOT EXISTS provenance_sources (
  id TEXT PRIMARY KEY NOT NULL,
  provenance_state TEXT NOT NULL,
  source_type TEXT NOT NULL,
  canonical_url TEXT,
  external_identifier TEXT,
  title TEXT,
  author TEXT,
  publisher TEXT,
  publication_date TEXT,
  retrieved_at TEXT,
  content_hash TEXT,
  verification_method TEXT,
  verification_notes TEXT,
  document_identity_id TEXT REFERENCES document_identities(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_provenance_sources_state ON provenance_sources(provenance_state);
CREATE INDEX IF NOT EXISTS idx_provenance_sources_document_identity_id ON provenance_sources(document_identity_id);

-- Append-only. previous_state NULL marks a source's genesis event (its
-- initial state, recorded atomically with the source's own creation).
CREATE TABLE IF NOT EXISTS provenance_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  source_id TEXT NOT NULL REFERENCES provenance_sources(id) ON DELETE CASCADE,
  previous_state TEXT,
  new_state TEXT NOT NULL,
  reason TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_provenance_events_source_id ON provenance_events(source_id);
