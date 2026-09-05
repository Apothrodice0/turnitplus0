-- Scalable built-in-archive index (100k-scale architecture, slice 2B). Purely
-- additive: three new ordinary structures plus one FTS5 virtual table, no
-- existing table altered, no backfill, no down migration, no destructive
-- statement. Everything created here holds DERIVED, rebuildable data only —
-- every row is reconstructible from corpus_document_representations
-- .canonical_text by lib/archive-index-build.ts. None of it is read by
-- admissionEligibilitySql or any historical-corpus / SELF / relationship
-- predicate; lib/archive-corpus-matching.ts is the sole reader.
--
-- WHY: seeding the built-in archive previously wrote every 5-gram of every
-- archive document into corpus_document_shingles under ARCHIVE_FINGERPRINT_VERSION
-- (~5,500 rows/doc → ~550M rows at 100k documents). This slice replaces that
-- with (a) a compact winnowed fingerprint set for candidate discovery
-- (~120 rows/doc), (b) a contentless FTS5 phrase index for a bounded
-- short-phrase discovery fallback, and (c) compact archive-global DF-band
-- metadata that also subsumes the stop-hash pruning the scorer needs. The
-- request-time scorer (lib/archive-similarity-scoring.ts's scoreAgainstArchive)
-- is unchanged and still consumes canonical-text-reconstructed grams.
--
-- archive_document_fingerprints: the PRIMARY candidate-discovery index —
-- Schleimer/Wilkerson/Aiken winnowing (window 85, hard cap 192) over each
-- archive document's own ordered 5-gram hash sequence. Same synthetic-id +
-- composite-unique-index shape as corpus_document_shingles (drizzle/0019).
-- fingerprint_version records the fingerprint-algorithm generation
-- (ARCHIVE_COMPACT_FINGERPRINT_VERSION in lib/archive-fingerprint.ts), a
-- namespace distinct from both CORPUS_FINGERPRINT_VERSION and
-- ARCHIVE_FINGERPRINT_VERSION so a re-fingerprint pass adds a new generation
-- without colliding. representation_id -> corpus_document_representations(id)
-- ON DELETE CASCADE: derived data cannot outlive its source representation.
-- idx_archive_document_fingerprints_hash covers the discovery query's
-- WHERE fingerprint_version = ? AND fingerprint_hash IN (...) GROUP BY
-- representation_id access pattern.
CREATE TABLE IF NOT EXISTS archive_document_fingerprints (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  representation_id     TEXT NOT NULL REFERENCES corpus_document_representations(id) ON DELETE CASCADE,
  fingerprint_hash      TEXT NOT NULL,
  optional_position     INTEGER,
  fingerprint_version   TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_archive_document_fingerprints_repr_version_hash
  ON archive_document_fingerprints(representation_id, fingerprint_version, fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_archive_document_fingerprints_hash
  ON archive_document_fingerprints(fingerprint_hash, fingerprint_version);

-- archive_hash_df_bands: compact archive-global document-frequency metadata
-- (Slice 2A.5). One row per 5-gram hash whose archive-wide DF is >=
-- MIN_PERSISTED_DF (13). df_bucket is the EXACT DF for 13..20; df_bucket 21
-- means "DF >= 21" (a bounded catch-all). A hash ABSENT from this table has
-- DF in {0..12} and its exact value, when the phrase selector needs it, is
-- resolved on demand from the FTS phrase index's exact fan-out
-- (lib/archive-phrase-fallback.ts). This ONE structure also IS the scorer's
-- stop set: { h : df_bucket > maximumDocumentFrequency } exactly reproduces
-- { h : archive-global DF(h) > maximumDocumentFrequency } for any threshold
-- <= 20 — there is no separate stop-hash table. policy_version
-- (ARCHIVE_DF_BAND_POLICY_VERSION) makes a DF-threshold/policy change
-- distinguishable from a fingerprint-algorithm change; it is part of the
-- primary key so a policy change can build a new generation beside the old
-- one. 16-hex TEXT hash (gramHash output) for v1 — correctness over the
-- ~4-5x storage saving an INTEGER key would give on this deliberately small
-- table (see lib/archive-df-bands.ts). WITHOUT ROWID: pure hash -> bucket
-- lookup, never range-scanned.
CREATE TABLE IF NOT EXISTS archive_hash_df_bands (
  shingle_hash    TEXT NOT NULL,
  df_bucket       INTEGER NOT NULL,
  policy_version  TEXT NOT NULL,
  PRIMARY KEY (shingle_hash, policy_version)
) WITHOUT ROWID;

-- archive_phrase_fts_map: the rowid -> representation_id bridge for the
-- contentless FTS5 virtual table archive_phrase_fts (created below). A
-- contentless FTS5 table stores no column data — reading its indexed column
-- yields NULL — so it cannot itself return representation_id; every phrase
-- query joins back through this table on the FTS rowid. Wiped and rebuilt
-- wholesale with the FTS index (lib/archive-phrase-index.ts), never partially
-- updated. representation_id -> corpus_document_representations(id) ON DELETE
-- CASCADE keeps this bridge consistent with its source; a stale FTS shadow
-- row for a removed rowid is harmless and cleared by the next full rebuild
-- (archive representations are effectively immutable in practice).
CREATE TABLE IF NOT EXISTS archive_phrase_fts_map (
  fts_rowid         INTEGER PRIMARY KEY NOT NULL,
  representation_id TEXT NOT NULL REFERENCES corpus_document_representations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_archive_phrase_fts_map_representation_id
  ON archive_phrase_fts_map(representation_id);

-- archive_phrase_fts: contentless FTS5 phrase index over each archive
-- document's tokens(canonical_text).join(" ") stream (Slice 2A.4). One
-- logical FTS row per archive document — never one row per 5-gram. The
-- `ascii` tokenizer on our already-normalize()d stream is byte-identical to
-- lib/similarity-core.ts's tokens() (proven: 49,019/49,019 terms on the real
-- archive). content='' stores no text; only the compressed inverted index.
-- Managed as raw SQL here and by lib/archive-phrase-index.ts — Drizzle cannot
-- model an FTS5 virtual table, so it is deliberately absent from db/schema.ts
-- (only archive_phrase_fts_map above is declared there).
CREATE VIRTUAL TABLE IF NOT EXISTS archive_phrase_fts USING fts5(
  body,
  tokenize = 'ascii',
  content = ''
);
