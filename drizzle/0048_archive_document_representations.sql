-- Built-in archive parity foundation (100k-scale slice 1). Purely additive:
-- ONE new table, no existing table altered, no backfill, no down migration.
--
-- corpus_document_representations/corpus_document_shingles (drizzle/0019)
-- already have a "legacy/pre-existing/built-in corpus row" eligibility arm
-- (lib/user-submission-corpus.ts's admissionEligibilitySql, condition 3: "no
-- promotion with link_type = NEW_CONTENT_REPRESENTATION exists for it at
-- all") that is exactly this table's target — a representation seeded here,
-- with no corpus_submission_references row and no corpus_admission_promotions
-- row ever created for it, is permanently eligible for matching (subject only
-- to the same 7-day maturity gate every other backing gets, via its own
-- first_seen_at) and is never account-owned, never SELF, and never counted as
-- a real submission by summarizeSubmissionOwnership.
--
-- What corpus_document_representations itself cannot express: a title, or
-- which of the 321 built-in archive documents (public/data/document-index.*)
-- a given representation corresponds to. This table supplies exactly that,
-- as pure display/lookup metadata — it is never read by any eligibility or
-- scoring predicate.
--
-- archive_article_id is the SAME id already used in
-- public/data/document-index.meta.json's articles[].id (stable, derived from
-- the source document's own title+content hash by scripts/build-document-
-- corpus.py) — the join key back to that static metadata, not a new
-- identifier scheme. representation_id is UNIQUE (one archive article seeds
-- at most one representation; a second archive build that reuses identical
-- canonical text would naturally collide on
-- ux_corpus_document_representations_canonical_sha256 first).
-- fingerprint_version records which corpus_document_shingles generation this
-- article's shingles were written under (see ARCHIVE_FINGERPRINT_VERSION in
-- lib/archive-corpus-seed.ts) — deliberately a SEPARATE shingle namespace
-- from CORPUS_FINGERPRINT_VERSION so seeding the archive can never change
-- what findCandidateCorpusRepresentations returns for the live historical-
-- match path (Stage C2) unless a caller explicitly queries this fingerprint.
-- archive_order: this article's index in public/data/document-index.meta.json's
-- own articles[] array — the SAME fixed, build-time ordering the browser's
-- packed postings index assigns each document's sourceIndex from. Not a
-- display concern: lib/archive-similarity-scoring.ts's scoreAgainstArchive
-- (ported verbatim from app/similarity-worker.ts) breaks a same-score
-- winner-take-all tie at a word position by LOWEST sourceIndex — an
-- inherent, pre-existing property of the algorithm, not something this
-- slice introduces. A server-side adapter that assigned sourceIndex from a
-- query-dependent ranking (e.g. "most shared shingles first") would
-- therefore resolve those rare true-tie cases differently from the browser
-- on every query, silently breaking parity only in that narrow situation.
-- Sorting candidates by archive_order before assigning sourceIndex
-- (lib/archive-corpus-matching.ts) reproduces the browser's own fixed,
-- query-independent tie-break instead. NULL for a representation seeded
-- without a known meta.json position (e.g. a future manually-added archive
-- document) — such rows sort after every explicitly-ordered one.
CREATE TABLE IF NOT EXISTS archive_document_representations (
  archive_article_id  TEXT PRIMARY KEY NOT NULL,
  representation_id   TEXT NOT NULL REFERENCES corpus_document_representations(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  source_type          TEXT NOT NULL DEFAULT 'Publication',
  original_similarity  INTEGER,
  archive_order        INTEGER,
  corpus_version       TEXT NOT NULL,
  fingerprint_version  TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_archive_document_representations_representation_id ON archive_document_representations(representation_id);
CREATE INDEX IF NOT EXISTS idx_archive_document_representations_corpus_version ON archive_document_representations(corpus_version);
