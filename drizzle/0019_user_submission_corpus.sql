-- Phase E8A: user submission history corpus — storage/indexing only, not yet
-- wired into live scoring, matching, or the save-report route. Purely
-- additive — no existing table's rows, columns, or constraints change.
-- See db/schema.ts's own comment above these three tables for the full
-- rationale (account ownership deliberately not duplicated here; every
-- account-scoped query joins back through document_identities.account_id).

-- One row per distinct canonical_sha256 — many submissions (any account, any
-- number of times) that canonicalize to the same text share one row here.
CREATE TABLE IF NOT EXISTS corpus_document_representations (
  id TEXT PRIMARY KEY NOT NULL,
  canonical_sha256 TEXT NOT NULL,
  canonical_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  language TEXT,
  canonicalization_version TEXT NOT NULL,
  extractor_version TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_document_representations_canonical_sha256 ON corpus_document_representations(canonical_sha256);

-- One row per submission event that has been indexed into the corpus.
-- document_identity_id is unique: a given submission maps to exactly one
-- representation. link_type is 'EXACT_CANONICAL_DUPLICATE' or
-- 'NEW_CONTENT_REPRESENTATION'.
CREATE TABLE IF NOT EXISTS corpus_submission_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  representation_id TEXT NOT NULL REFERENCES corpus_document_representations(id) ON DELETE CASCADE,
  document_identity_id TEXT NOT NULL REFERENCES document_identities(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_submission_references_document_identity_id ON corpus_submission_references(document_identity_id);
CREATE INDEX IF NOT EXISTS idx_corpus_submission_references_representation_id ON corpus_submission_references(representation_id);

-- One row per distinct informative shingle of a representation's own
-- canonical_text — deliberately separate from document_identity_shingles
-- (which fingerprints raw text for Phase B family matching). fingerprint_version
-- is part of the unique key together with shingle_hash so a future
-- re-fingerprinting pass can add a new generation of shingles for the same
-- representation without deleting or colliding with the old ones.
CREATE TABLE IF NOT EXISTS corpus_document_shingles (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  representation_id TEXT NOT NULL REFERENCES corpus_document_representations(id) ON DELETE CASCADE,
  shingle_hash TEXT NOT NULL,
  fingerprint_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_document_shingles_representation_version_hash ON corpus_document_shingles(representation_id, fingerprint_version, shingle_hash);
CREATE INDEX IF NOT EXISTS idx_corpus_document_shingles_hash ON corpus_document_shingles(shingle_hash);
