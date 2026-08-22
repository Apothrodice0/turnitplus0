-- Corpus admission / quality gate: durable, cross-process "first accepted
-- sample wins" enforcement (fixes the confirmed concurrency/idempotency
-- defect from the verification pass — family resolution previously only
-- checked the real corpus tables, which a real ACCEPT never writes into,
-- so two independent evaluations of the same new content — sequential or
-- concurrent — could both reach ACCEPT). Purely additive.
--
-- Deliberately holds ONLY the derived fingerprint needed for staging
-- deduplication (canonical_sha256, word_count, shingle hashes) — never raw
-- text. lib/corpus-admission-content-store.ts (canonical_text) remains the
-- one and only place full text is ever persisted for a corpus-admission
-- candidate; see lib/corpus-admission-gate.ts's own header comment.
--
-- The UNIQUE index on canonical_sha256 is the actual atomicity primitive:
-- two concurrent processes racing to accept identical content can both
-- pass an application-level pre-check, but at most one of their INSERTs
-- into this table can ever succeed — SQLite itself is the arbiter, not a
-- JavaScript mutex. lib/corpus-admission-gate.ts pairs this with a
-- write-transaction re-check (exact hash AND near-duplicate shingle
-- containment) immediately before the insert, so the same protection
-- extends to near-duplicate/cross-format concurrent submissions, which a
-- bare hash-uniqueness constraint alone cannot catch (two different
-- documents' canonical hashes are never equal even when their content is
-- 99% the same).
CREATE TABLE IF NOT EXISTS corpus_admission_accepted_representations (
  id TEXT PRIMARY KEY NOT NULL,
  decision_id TEXT NOT NULL REFERENCES corpus_admission_decisions(id) ON DELETE CASCADE,
  canonical_sha256 TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  fingerprint_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_admission_accepted_representations_canonical_sha256 ON corpus_admission_accepted_representations(canonical_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_admission_accepted_representations_decision_id ON corpus_admission_accepted_representations(decision_id);

-- One row per informative shingle of an accepted representation's own
-- canonical text — same shingling primitives as corpus_document_shingles
-- (lib/user-submission-corpus.ts's corpusShingleHashes), applied here to
-- staging-only accepted admissions rather than the real, separate corpus.
CREATE TABLE IF NOT EXISTS corpus_admission_accepted_shingles (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  accepted_representation_id TEXT NOT NULL REFERENCES corpus_admission_accepted_representations(id) ON DELETE CASCADE,
  shingle_hash TEXT NOT NULL,
  fingerprint_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_admission_accepted_shingles_rep_version_hash ON corpus_admission_accepted_shingles(accepted_representation_id, fingerprint_version, shingle_hash);
CREATE INDEX IF NOT EXISTS idx_corpus_admission_accepted_shingles_hash ON corpus_admission_accepted_shingles(shingle_hash);
