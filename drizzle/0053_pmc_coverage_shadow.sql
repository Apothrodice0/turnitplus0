-- PMC OA scholarly-coverage SHADOW slice (storage/loader decision: Turso-backed
-- dedicated PMC shadow corpus). Purely additive: FOUR new tables plus their
-- indexes and ONE AFTER DELETE cleanup trigger. No existing table is altered,
-- no column is added to any existing table, there is no backfill and no down
-- migration. Every statement is CREATE ... IF NOT EXISTS, so replaying this file
-- (lib/ingest.ts applyMigrationsLibsql / applyMigrations, and every test path)
-- is a no-op.
--
-- DO NOT apply this to Preview or Production in this phase. Deliberately OUTSIDE
-- lib/e8-tables-migration-runner.ts (its TARGET_MIGRATIONS allowlist is frozen
-- at 0051; 0052 already bypasses it the same way). Applied only by
-- applyMigrationsLibsql (client.executeMultiple, which parses
-- CREATE TRIGGER ... BEGIN ... END correctly) and the test paths.
--
-- WHAT THIS IS. A server-side two-stage scholarly-coverage matcher, run ONLY as
-- deferred telemetry off lib/report-shadow-evaluations.ts and ONLY when
-- process.env.PMC_COVERAGE_SHADOW_ENABLED === "true":
--
--   submission -> production 5-gram hashes -> winnow w=15
--     -> DF-banded fingerprint candidate retrieval (pmc_document_fingerprints,
--        pmc_hash_df_bands as the stop set) -> rank top-K <= 20
--     -> load ONLY those canonical texts (pmc_coverage_documents.canonical_text)
--     -> the UNMODIFIED lib/archive-similarity-scoring.ts scoreAgainstArchive
--        matcher over the <= 20 candidates -> verified submission word positions
--     -> a counterfactual lib/unified-similarity.ts computeUnifiedSimilarity
--        (PMC positions unioned into archiveMatchedPositions) -> score delta
--     -> ONE bounded telemetry row in pmc_coverage_shadow_evaluations.
--
-- Fingerprint hits NEVER score directly: winnowing only decides WHICH <= 20
-- documents scoreAgainstArchive verifies, exactly like the built-in archive's
-- own compact index (drizzle/0049). The authoritative unifiedSimilarity.unifiedScore
-- is NEVER read, re-derived, or written by this path.
--
-- NONE of pmc_coverage_documents / pmc_document_fingerprints / pmc_hash_df_bands
-- is read by admissionEligibilitySql or any historical-corpus / SELF /
-- relationship / archive predicate. The PMC coverage evaluator
-- (lib/pmc-coverage-shadow.ts + lib/pmc-coverage/*) is the sole reader; the
-- offline seed tool (tools/seed-pmc-coverage-shadow-corpus.ts) is the sole
-- writer of the first three.

-- ── 1. The PMC OA coverage corpus — one row per open-access document ─────────
-- canonical_text is the front-matter-stripped article body (the prototype's
-- validated "clean text"): tokens(canonical_text) reproduces the prototype's
-- normalized body exactly, so the production matcher normalizes it at read time
-- like every other corpus text. is_retracted is the query-time tombstone — a
-- retracted document is excluded from Stage A candidate tallying and never
-- loaded for Stage B, with NO index rebuild (mirrors DESIGN.md's tombstone
-- requirement). pmc_id is the PMCID accession and the stable key; pmcid is kept
-- as the explicit accession field for parity with the seed source.
CREATE TABLE IF NOT EXISTS pmc_coverage_documents (
  pmc_id            TEXT PRIMARY KEY NOT NULL,
  pmcid             TEXT NOT NULL,
  doi               TEXT,
  pmid              TEXT,
  title             TEXT NOT NULL,
  license           TEXT NOT NULL,
  citation          TEXT,
  canonical_text    TEXT NOT NULL,
  canonical_sha256  TEXT NOT NULL,
  body_words        INTEGER NOT NULL,
  version           INTEGER NOT NULL,
  is_retracted      INTEGER NOT NULL DEFAULT 0,
  oa_snapshot_date  TEXT,
  ingested_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pmc_coverage_documents_canonical_sha256
  ON pmc_coverage_documents(canonical_sha256);

-- ── 2. Stage A — compact winnowed fingerprint postings ──────────────────────
-- ~800 rows/doc at winnow window 15 (Schleimer/Wilkerson/Aiken). fingerprint_hash
-- is a 16-hex lib/similarity-core.ts gramHash of the selected 5-gram.
-- fingerprint_version (PMC_COMPACT_FINGERPRINT_VERSION) namespaces the winnow
-- generation so a re-fingerprint pass adds a new generation beside the old rows.
-- The composite PRIMARY KEY is the unique(pmc_id, fingerprint_version,
-- fingerprint_hash) constraint (a re-seed is INSERT OR IGNORE idempotent).
-- idx_pmc_document_fingerprints_hash serves the request-time lookup:
--   WHERE fingerprint_version = ? AND fingerprint_hash IN (...).
CREATE TABLE IF NOT EXISTS pmc_document_fingerprints (
  pmc_id               TEXT NOT NULL REFERENCES pmc_coverage_documents(pmc_id) ON DELETE CASCADE,
  fingerprint_hash     TEXT NOT NULL,
  fingerprint_version  TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (pmc_id, fingerprint_version, fingerprint_hash)
);
CREATE INDEX IF NOT EXISTS idx_pmc_document_fingerprints_hash
  ON pmc_document_fingerprints(fingerprint_hash, fingerprint_version);

-- ── 3. Compact PMC-global DF-band metadata (REQUIRED in phase 1) ────────────
-- Exact copy of archive_hash_df_bands' shape and semantics (drizzle/0049):
--   df_bucket 13..20 = exact PMC-corpus-wide 5-gram document frequency
--   df_bucket 21     = DF >= 21 (bounded catch-all)
--   absent           = DF in {0..12}
-- Built from every pmc_coverage_documents.canonical_text 5-gram set; rows are
-- persisted ONLY for DF >= MIN_PERSISTED_DF (13). This ONE table is the stop
-- set for BOTH stages: Stage A drops query fingerprints whose 5-gram is in it
-- before retrieval (bounded fan-out), and Stage B's getPostings prunes the same
-- hashes, exactly like lib/archive-corpus-matching.ts. The scorer's own
-- maximumDocumentFrequency (6 for PMC) resolves the 7..12 band at scoring time.
-- policy_version (PMC_DF_BAND_POLICY_VERSION) namespaces a threshold/bucketing
-- change. WITHOUT ROWID: pure hash -> bucket lookup, never scanned.
CREATE TABLE IF NOT EXISTS pmc_hash_df_bands (
  shingle_hash    TEXT NOT NULL,
  df_bucket       INTEGER NOT NULL,
  policy_version  TEXT NOT NULL,
  PRIMARY KEY (shingle_hash, policy_version)
) WITHOUT ROWID;

-- ── 4. Bounded SHADOW telemetry — one row per (report, evaluator_version) ────
-- MEASUREMENT ONLY. Never read by the production similarity / relationship /
-- scoring path — written only by the deferred evaluator
-- (lib/pmc-coverage-shadow.ts via lib/report-shadow-evaluations.ts) and, later,
-- read by ADMIN-ONLY surfaces. No field ever reaches an ordinary user's report
-- payload.
--
-- report_device_key is a random per-browser UUID (lib/device-key.ts). With
-- report_id it is the minimum handle to address one saved_reports row
-- (composite PK (device_key, id)); there is deliberately NO DB-level FOREIGN KEY,
-- the same reasoning drizzle/0020 / 0021 / 0044 apply. The spec's
-- UNIQUE(report_id, evaluator_version) is the UPSERT conflict key (report_id is
-- a randomUUID, unique in practice).
--
-- pmc_matched_positions_json / pmc_sources_json hold word indices and PUBLIC
-- open-access identifiers (PMCID / DOI / title) only — no account, device, or
-- private identifier of any kind. Measurement columns are NULLABLE and left NULL
-- where no counterfactual was computed (status FAILED / SKIPPED_*), never a
-- fake 0.
--
-- DELETION IS ATOMIC via the AFTER DELETE trigger: deleting the saved_reports
-- row removes every shadow row for it within the same statement. The evaluator's
-- UPSERT is ADDITIONALLY EXISTS-guarded on saved_reports.
CREATE TABLE IF NOT EXISTS pmc_coverage_shadow_evaluations (
  id                                 INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  report_device_key                  TEXT NOT NULL,
  report_id                          TEXT NOT NULL,

  status                             TEXT NOT NULL,   -- 'OK' | 'BOUNDED' | 'FAILED'
                                                       -- | 'SKIPPED_NO_AUTHORITATIVE' | 'SKIPPED_EMPTY_CORPUS'
                                                       -- | 'SKIPPED_BASELINE_MISMATCH'
  error_code                         TEXT,            -- NULL unless status='FAILED': 'STAGE_A_FAILED'
                                                       -- | 'STAGE_B_FAILED' | 'COUNTERFACTUAL_INVARIANT' | 'UNEXPECTED'

  -- version / freshness
  evaluator_version                  TEXT NOT NULL,   -- PMC_COVERAGE_SHADOW_EVALUATOR_VERSION (the UPSERT conflict key)
  unified_similarity_version         TEXT NOT NULL,   -- UNIFIED_SIMILARITY_VERSION
  fingerprint_version                TEXT NOT NULL,   -- PMC_COMPACT_FINGERPRINT_VERSION
  df_band_policy_version             TEXT NOT NULL,   -- PMC_DF_BAND_POLICY_VERSION
  authoritative_snapshot_computed_at TEXT,            -- productionResult.computedAt freshness key; NULL for SKIPPED_NO_AUTHORITATIVE

  submission_canonical_sha256        TEXT,            -- canonicalSha256(report text) at evaluation time; NEVER a scoring gate here
  submitted_word_count               INTEGER,

  -- score comparison — NULL unless status IN ('OK','BOUNDED')
  baseline_unified_score             INTEGER,         -- == authoritative unifiedSimilarity.unifiedScore (recorded, never recomputed as the source of truth)
  counterfactual_unified_score       INTEGER,         -- computeUnifiedSimilarity(baseline inputs + PMC positions); >= baseline
  score_delta                        INTEGER,         -- counterfactual - baseline (>= 0)

  -- PMC-side measurement — NULL unless status IN ('OK','BOUNDED')
  pmc_matched_word_count             INTEGER,         -- total distinct submission word positions scoreAgainstArchive attributed to PMC sources
  pmc_marginal_word_count            INTEGER,         -- of those, the count NOT already covered by the authoritative union
  pmc_candidate_count                INTEGER,         -- Stage A candidates handed to Stage B (<= PMC_STAGE_A_TOP_K)
  pmc_verified_source_count          INTEGER,         -- of those, how many scoreAgainstArchive accepted as contributing sources

  -- Stage A bounds accounting
  stage_a_query_fingerprints         INTEGER,         -- winnowed submission fingerprints actually queried (<= PMC_MAX_QUERY_FINGERPRINTS)
  stage_a_stopped_fingerprints       INTEGER,         -- winnowed submission fingerprints dropped by the DF-band stop set
  stage_a_tombstoned_hits            INTEGER,         -- posting rows skipped because the document is_retracted
  evaluation_truncated               INTEGER NOT NULL DEFAULT 0,   -- 1 when a Stage A bound (query fp cap / posting-row cap) clipped the scan

  pmc_matched_positions_json         TEXT,            -- sorted int[] of PMC-verified submission word positions; NULL unless OK/BOUNDED
  pmc_sources_json                   TEXT,            -- [{pmcId,doi,title,matchedWords}] for accepted PMC sources; NULL unless OK/BOUNDED

  total_runtime_ms                   INTEGER,
  computed_at                        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- last attempt — drives the FAILED-retry cooldown
  created_at                         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pmc_coverage_shadow_report_evaluator
  ON pmc_coverage_shadow_evaluations(report_id, evaluator_version);

CREATE TRIGGER IF NOT EXISTS trg_pmc_coverage_shadow_cleanup_on_report_delete
AFTER DELETE ON saved_reports
FOR EACH ROW
BEGIN
  DELETE FROM pmc_coverage_shadow_evaluations
  WHERE report_device_key = OLD.device_key
    AND report_id = OLD.id;
END;
