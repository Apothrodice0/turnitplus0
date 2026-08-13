-- Phase A: document identity. A standalone identity record for an analyzed
-- document (account association, title, author, raw hash, canonical hash).
-- Independent of the corpus-contribution schema (documents/.../contributions)
-- and of saved_reports — additive only, no existing table is touched.
--
-- No column here is unique: the same document may legitimately be submitted
-- more than once (same account or different accounts). Lookups are served by
-- plain (non-unique) indexes on the two hashes and on (account_id,
-- canonical_sha256) for the same-account check.
CREATE TABLE IF NOT EXISTS document_identities (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT,
  author TEXT,
  raw_sha256 TEXT NOT NULL,
  canonical_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_document_identities_raw_sha256 ON document_identities(raw_sha256);
CREATE INDEX IF NOT EXISTS idx_document_identities_canonical_sha256 ON document_identities(canonical_sha256);
CREATE INDEX IF NOT EXISTS idx_document_identities_account_canonical ON document_identities(account_id, canonical_sha256);
