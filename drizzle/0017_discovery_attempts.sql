-- Phase E6A: source discovery architecture. Purely additive — no existing
-- table is touched, and this table has no foreign key into any provenance
-- table (provenance_sources/provenance_events/provenance_evidence/
-- provenance_verification_decisions), document_families, or
-- document_family_members — discovery facts stay a separate concern (see
-- lib/discovery-repository.ts and db/schema.ts's own comment on this
-- table). Only document_identity_id is a foreign key, and it is nullable.
CREATE TABLE IF NOT EXISTS discovery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  request_id TEXT NOT NULL,
  document_identity_id TEXT REFERENCES document_identities(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  queries_used_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  raw_results_json TEXT,
  error_message TEXT,
  requested_at TEXT NOT NULL,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_discovery_attempts_request_id ON discovery_attempts(request_id);
CREATE INDEX IF NOT EXISTS idx_discovery_attempts_document_identity_id ON discovery_attempts(document_identity_id);
