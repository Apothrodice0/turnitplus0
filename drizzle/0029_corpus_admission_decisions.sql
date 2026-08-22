-- Corpus admission / quality gate (v1): audit-trail decision records for
-- candidate documents being evaluated for admission into the reusable
-- corpus (lib/user-submission-corpus.ts's 3 existing tables), plus a
-- deliberately separate, narrowly-gated store for the raw text those
-- decisions are based on. Purely additive — no existing table changes.
--
-- corpus_admission_decisions never has a canonical_text column: the full
-- feature vector, component scores, and reason codes are stored so a
-- decision can be explained and re-scored under a new policy_version
-- without ever holding raw extracted text in this table (see
-- lib/corpus-admission-gate.ts's own header comment). One row per
-- EVALUATION, not per candidate — the same source_ref can recur across
-- multiple policy_version/run_id rows (re-evaluation, the calibrate/
-- refreeze/rerun workflow), so canonical_sha256 is deliberately NOT unique
-- here, unlike corpus_document_representations.
CREATE TABLE IF NOT EXISTS corpus_admission_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  source_ref TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  hard_gate_passed INTEGER NOT NULL,
  hard_gate_failure_codes TEXT NOT NULL,
  detected_format TEXT,
  extracted_word_count INTEGER,
  detected_language TEXT,
  language_confidence REAL,
  canonical_sha256 TEXT,
  extractor_version TEXT,
  -- Deliberately NOT a DB-level FOREIGN KEY: corpus_admission_content_store
  -- is created below, in this same migration file, and its own decision_id
  -- column already carries the enforced FK back to this table (the
  -- direction that actually matters — ON DELETE CASCADE removes retained
  -- text when its decision row is removed). A FK in both directions would
  -- be a circular same-migration reference for no added safety; NULL means
  -- no text was ever retained for this decision.
  content_store_id TEXT,
  quality_score REAL,
  quality_model_version TEXT,
  component_scores TEXT,
  feature_vector TEXT,
  feature_vector_version TEXT,
  corpus_value_score REAL,
  corpus_value_model_version TEXT,
  family_relation TEXT,
  family_matched_source_ref TEXT,
  family_containment REAL,
  consent_metadata TEXT,
  dry_run INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_corpus_admission_decisions_source_ref ON corpus_admission_decisions(source_ref);
CREATE INDEX IF NOT EXISTS idx_corpus_admission_decisions_decision ON corpus_admission_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_corpus_admission_decisions_run_id ON corpus_admission_decisions(run_id);

-- The ONLY place full extracted text may ever be persisted for a
-- corpus-admission candidate (requirement 2). Written only when
-- dry_run=false AND the decision is ACCEPT AND retention rights were
-- resolved (per-user consent, or a bulk-import CorpusProvenanceRecord with
-- retentionRightsResolved=true) — never during a dry run (requirement 4),
-- and never for a candidate whose retention/consent hard gate failed. A
-- decision row with no matching content-store row (content_store_id IS
-- NULL) cannot be re-evaluated from retained text at all — by
-- construction, not by convention.
CREATE TABLE IF NOT EXISTS corpus_admission_content_store (
  id TEXT PRIMARY KEY NOT NULL,
  decision_id TEXT NOT NULL REFERENCES corpus_admission_decisions(id) ON DELETE CASCADE,
  canonical_sha256 TEXT NOT NULL,
  canonical_text TEXT NOT NULL,
  extractor_version TEXT,
  retention_basis TEXT NOT NULL,
  stored_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_admission_content_store_decision_id ON corpus_admission_content_store(decision_id);
CREATE INDEX IF NOT EXISTS idx_corpus_admission_content_store_canonical_sha256 ON corpus_admission_content_store(canonical_sha256);
