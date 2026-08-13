-- Phase B: document families/versions. Purely additive — no existing table's
-- rows, columns, or constraints are changed. document_identities gains one
-- nullable column; everything else is new tables.
--
-- unique_shingle_count is NULL until a fingerprint has actually been
-- recorded for that identity (see lib/document-family.ts,
-- recordDocumentIdentityShingles). It is not populated by
-- lib/document-identity.ts's createDocumentIdentity (Phase A), so existing
-- and newly created identities alike start with NULL here until
-- fingerprinting is explicitly run — this migration changes no existing
-- identity's behavior.
ALTER TABLE document_identities ADD COLUMN unique_shingle_count INTEGER;

-- One row per distinct informative shingle per document identity (not one
-- row per occurrence — Phase B only needs set membership for containment,
-- not positions). This is what makes text-similarity comparison between two
-- document_identities rows possible at all, since document_identities never
-- stores the submitted text itself. Independent of chunk_fingerprints (the
-- corpus-contribution schema's equivalent) — never linked to it.
CREATE TABLE IF NOT EXISTS document_identity_shingles (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  document_identity_id TEXT NOT NULL REFERENCES document_identities(id) ON DELETE CASCADE,
  shingle_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_document_identity_shingles_identity_hash ON document_identity_shingles(document_identity_id, shingle_hash);
CREATE INDEX IF NOT EXISTS idx_document_identity_shingles_hash ON document_identity_shingles(shingle_hash);

-- A document family is just a group; everything about *why* an identity
-- belongs to one lives on document_family_members below.
CREATE TABLE IF NOT EXISTS document_families (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- One row per (family, identity) membership. An identity belongs to at most
-- one family (unique index on document_identity_id). match_type records why
-- this identity is here: SEED (founding member, no comparison made),
-- EXACT_CANONICAL_MATCH, or STRONG_TEXT_MATCH (matched against
-- matched_against_identity_id at evidence_score). This is a document
-- relationship record, never a plagiarism or provenance classification.
CREATE TABLE IF NOT EXISTS document_family_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  family_id TEXT NOT NULL REFERENCES document_families(id) ON DELETE CASCADE,
  document_identity_id TEXT NOT NULL REFERENCES document_identities(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL,
  matched_against_identity_id TEXT REFERENCES document_identities(id) ON DELETE SET NULL,
  evidence_score REAL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_document_family_members_identity ON document_family_members(document_identity_id);
CREATE INDEX IF NOT EXISTS idx_document_family_members_family_id ON document_family_members(family_id);
