-- asjp-sixword-0001 — PREVIEW-ONLY migration for the developer six-word overlap experiment (informational, unscored).
-- NOT part of drizzle/: the Production migration set is unchanged. Applied only to the isolated ASJP Preview database,
-- after its Phase 7 Stage A migration, by scripts/asjp-sixword/migrate-preview-sixword.mjs (owner approval required).
-- Must equal lib/asjp-sixword-report-store.ts ASJP_SIXWORD_MIGRATION_SQL (a test checks it). Idempotent.
-- Rollback (in this order): DROP TRIGGER IF EXISTS trg_asjp_sixword_overlap_records_report_deleted;
--                           DROP TABLE IF EXISTS asjp_sixword_overlap_records;

CREATE TABLE IF NOT EXISTS asjp_sixword_overlap_records (
    device_key TEXT NOT NULL,
    report_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (device_key, report_id)
  );
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_asjp_sixword_overlap_records_report_deleted AFTER DELETE ON saved_reports
   BEGIN DELETE FROM asjp_sixword_overlap_records WHERE device_key = OLD.device_key AND report_id = OLD.id; END;
