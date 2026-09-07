-- Phase B2a — bounded SHADOW-MEASUREMENT telemetry for the B1 corpus-duplicate
-- counterfactual (lib/corpus-duplicate-suppression-policy.ts +
-- lib/corpus-duplicate-counterfactual.ts, committed 7cc5208).
--
-- MEASUREMENT ONLY. This table is never read by the production similarity /
-- relationship / scoring path — only written by the deferred evaluator
-- (lib/corpus-duplicate-suppression-shadow.ts, scheduled off-response via
-- lib/report-shadow-evaluations.ts) and, in a later phase, read by ADMIN-ONLY
-- surfaces. No B2 field ever reaches an ordinary user's report payload.
--
-- Purely additive: ONE new table, ONE unique index, ONE trigger. No existing
-- table is altered, no column is added to any existing table, there is no
-- backfill and no down migration. DO NOT apply this to Preview or Production in
-- this phase. Migration order remains 0042 -> 0043 -> 0044 (Preview is at 0041).
--
-- This migration is applied only by lib/ingest.ts's applyMigrationsLibsql()
-- (client.executeMultiple, which parses CREATE TRIGGER ... BEGIN ... END
-- correctly) and the test paths. It is deliberately OUTSIDE
-- lib/e8-tables-migration-runner.ts (frozen at 0040; 0041-0043 all bypass it,
-- and its naive splitStatements() would shred the trigger).
--
-- PRIVACY: every column is a bounded count, enum, boolean, or timestamp. NO
-- account/user id, email, device-passport id, HMAC / passport fingerprint,
-- source_ref, canonical hash, document_identity_id, representation id,
-- admission-decision id, promotion id, owner-link id, action ref, document or
-- passage text, and NO generic JSON / payload / evidence / metadata blob.
--
-- report_device_key is a random per-browser UUID (lib/device-key.ts, "soft
-- scoping, not authentication"). With report_id it is the MINIMUM handle to
-- address one saved_reports row (composite PK (device_key, id)) with no DB-level
-- FOREIGN KEY, and for admin deep-dive navigation. Same rationale as
-- drizzle/0020 / drizzle/0021 ("neither value is an account identity").
--
-- MEASUREMENT COLUMNS ARE NULLABLE and are left NULL where a measurement was
-- never computed (status FAILED / SKIPPED_*) — never a fake 0. Aggregate
-- statistics MUST filter status IN ('OK','BOUNDED').
--
-- DELETION IS ATOMIC via the AFTER DELETE trigger below: deleting the
-- saved_reports row removes every shadow row for it WITHIN the same DELETE
-- statement (crash-safe, covers every report/account deletion path). The
-- evaluator's INSERT is ADDITIONALLY EXISTS-guarded on saved_reports so a
-- deferred write scheduled before deletion cannot recreate a row afterward.

CREATE TABLE IF NOT EXISTS corpus_duplicate_suppression_shadow_evaluations (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  report_device_key               TEXT NOT NULL,
  report_id                       TEXT NOT NULL,

  -- status decides which columns are meaningful
  status              TEXT NOT NULL,   -- 'OK' | 'BOUNDED' | 'FAILED'
                                        -- | 'SKIPPED_NOT_MATCHED' | 'SKIPPED_NO_AUTHORITATIVE'
  error_code          TEXT,            -- NULL unless status='FAILED'. One of:
                                        -- 'PROVENANCE_QUERY_FAILED' | 'COUNTERFACTUAL_INVARIANT' | 'UNEXPECTED'
  error_detail        TEXT,            -- reserved; B2a always writes NULL. If ever populated it must be an
                                        -- APP-GENERATED bounded string (integers/enums only), never caught exception text.

  -- checker-account side signal — INDEPENDENT of the core status
  checker_accounts_status          TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',   -- 'NOT_APPLICABLE' | 'OK' | 'FAILED'
  distinct_checker_accounts_bucket TEXT,   -- '0'|'1'|'2'|'3-5'|'6+' only when checker_accounts_status='OK'; else NULL

  -- version / freshness
  policy_version                     TEXT NOT NULL,   -- the B2 shadow evaluator's own version (the UPSERT conflict key)
  rule_version                       TEXT NOT NULL,   -- CORPUS_DUPLICATE_SUPPRESSION_POLICY_VERSION (B1 classifier)
  unified_similarity_version         TEXT NOT NULL,   -- UNIFIED_SIMILARITY_VERSION
  counterfactual_version             TEXT NOT NULL,   -- CORPUS_DUPLICATE_COUNTERFACTUAL_VERSION
  authoritative_corpus_generation    INTEGER,   -- OK/BOUNDED/SKIPPED_NOT_MATCHED; NULL for SKIPPED_NO_AUTHORITATIVE / FAILED
  authoritative_snapshot_computed_at TEXT,      -- OK/BOUNDED/SKIPPED_NOT_MATCHED; NULL for SKIPPED_NO_AUTHORITATIVE / FAILED
  submitted_word_count               INTEGER,   -- from authoritativeUnifiedSimilarity.wordCount; NULL for SKIPPED_NO_AUTHORITATIVE / FAILED

  -- score comparison — NULL unless status IN ('OK','BOUNDED')
  authoritative_score                 INTEGER,
  hypothetical_score                  INTEGER,   -- <= authoritative_score (B1 invariant; else status='FAILED')
  score_delta                         INTEGER,   -- authoritative - hypothetical, direct (>= 0)
  authoritative_unique_matched_words  INTEGER,
  hypothetical_unique_matched_words   INTEGER,
  unique_matched_words_removed        INTEGER,
  candidate_matched_words             INTEGER,
  candidates_excluded                 INTEGER,

  -- surviving evidence (B1 field names) — NULL unless status IN ('OK','BOUNDED').
  -- When present, the four reconcile exactly to hypothetical_unique_matched_words.
  archive_only_words_surviving         INTEGER,
  live_academic_only_words_surviving   INTEGER,
  previous_upload_only_words_surviving INTEGER,
  overlap_words_surviving              INTEGER,

  -- candidate classification.
  --   candidate_count: written for OK/BOUNDED (0 is a real value) AND for
  --     SKIPPED_NOT_MATCHED (always 0). NULL for SKIPPED_NO_AUTHORITATIVE / FAILED.
  candidate_count                 INTEGER,
  measurement_category            TEXT,      -- CROSS_ACCOUNT_EXACT_CANONICAL | ALREADY_UNKNOWN
                                              -- | ALREADY_EFFECTIVE_DEVICE_SELF | ANONYMOUS | NOT_MATCHED
                                              -- | NOT_EXACT_CANONICAL | NOT_CORPUS_SOURCE
                                              -- | BACKING_SHAPE_UNSUPPORTED | NOT_ELIGIBLE
  origin_confidence               TEXT,      -- SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE | BACKING_SHAPE_UNSUPPORTED | NOT_EVALUATED
  multi_origin_evidence           TEXT,      -- MULTI_ORIGIN_NOT_PROVEN | N/A  (never PROVEN_SINGLE_LINEAGE, never MULTI_ORIGIN_PROVEN)

  -- strongest-candidate backing shape (counts only) — NULL unless a candidate/exact-canonical rep was provenance-checked
  candidate_admitted_promotion_backing_count   INTEGER,
  candidate_submission_reference_backing_count  INTEGER,
  candidate_independent_backing_count           INTEGER,
  candidate_same_device_backing_count           INTEGER,

  -- relationship categories (booleans) — NO same_account_category.
  --   same_passport_category = 1 only when an evaluated matched representation is
  --   actually in effectiveDeviceSelfRepresentationIds. NULL for SKIPPED_* / FAILED.
  same_passport_category   INTEGER,
  cross_account_category   INTEGER,

  -- bounds
  evaluation_truncated INTEGER NOT NULL DEFAULT 0,   -- 1 when distinct candidate reps exceeded the defensive cap
  total_runtime_ms     INTEGER,

  computed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),   -- last attempt — drives the 15-minute FAILED-retry cooldown
  created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_duplicate_suppression_shadow_report_policy
  ON corpus_duplicate_suppression_shadow_evaluations(report_device_key, report_id, policy_version);

-- Atomic deletion cascade (this table has no DB-level FOREIGN KEY, by the same
-- schema-drift-tooling reasoning as report_historical_match_snapshots /
-- historical_match_shadow_evaluations). A DELETE of a saved_reports row removes
-- every shadow row for that (device_key, id) WITHIN the same DELETE statement —
-- so report deletion + shadow cleanup commit or roll back together, and a
-- process crash immediately after the saved_reports DELETE cannot leave an
-- orphan. This covers every deletion path (DELETE /api/reports/[id] both
-- branches, lib/account-deletion.ts's deleteAllReportDataForAccount loop,
-- POST /api/developer/reset-rooms) with NO route-side wiring.
CREATE TRIGGER IF NOT EXISTS trg_corpus_duplicate_suppression_shadow_cleanup_on_report_delete
AFTER DELETE ON saved_reports
FOR EACH ROW
BEGIN
  DELETE FROM corpus_duplicate_suppression_shadow_evaluations
  WHERE report_device_key = OLD.device_key
    AND report_id = OLD.id;
END;
