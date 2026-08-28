-- Device Passport provenance links — Phase 1 SCHEMA FOUNDATION ONLY. Purely
-- additive. Nothing reads or writes these columns / this table yet.
--
-- (A) saved_reports.verified_device_passport_id — the device passport that
--     was cryptographically verified when POST /api/reports first created
--     this report. NULL when no passport was verified at upload (feature
--     off, unsupported browser, verification failed — all of which a later
--     phase must treat as fail-safe: no device-based exclusion). NO foreign
--     key, deliberately — this mirrors report_historical_match_snapshots'
--     own no-FK / explicit-application-cleanup choice: report-local data
--     must never be collaterally mutated by a passport-side change, and the
--     stored value is a self-sufficient immutable fingerprint string. A
--     later phase writes it only in the INSERT arm of the report upsert and
--     never lists it in ON CONFLICT DO UPDATE, exactly as room_number / 0027
--     is immutable after first insert. NULL for every existing row and every
--     report saved before this column; no backfill is possible or wanted (a
--     pre-existing report's upload was never passport-verified).
--
-- (B) corpus_admission_report_jobs.verified_device_passport_id — carries the
--     value verified synchronously in the upload request into the deferred
--     admission-decision path, where a later phase writes the per-backing
--     provenance row below on ACCEPT. Nullable, no foreign key (mirrors this
--     table's existing plain account_id / device_key columns).
--
-- (C) corpus_admission_decision_device_provenance — one verified device per
--     admission decision (decision_id is the primary key). This is the ONLY
--     place a promoted corpus backing is linked to a device passport, joined
--     to the deduplicated representation only through
--     corpus_admission_promotions.decision_id — the same per-backing shape
--     admissionEligibilitySql already uses for the account check. The device
--     passport id is NEVER placed on corpus_document_representations: that
--     row is deduplicated and may have many independent backings.
--       decision_id -> corpus_admission_decisions(id) ON DELETE CASCADE:
--         provenance follows the decision's lifecycle exactly as
--         corpus_admission_content_store does; an accepted decision is
--         durable, so accepted provenance is durable.
--       device_passport_id -> device_passports(id) ON DELETE RESTRICT:
--         a passport row can never be removed while any promoted backing
--         still references it.
--     verified_at is an epoch-millisecond integer (the 0038 convention).
ALTER TABLE saved_reports ADD COLUMN verified_device_passport_id TEXT;

ALTER TABLE corpus_admission_report_jobs ADD COLUMN verified_device_passport_id TEXT;

CREATE INDEX IF NOT EXISTS idx_saved_reports_verified_device_passport
  ON saved_reports(verified_device_passport_id)
  WHERE verified_device_passport_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS corpus_admission_decision_device_provenance (
  decision_id TEXT PRIMARY KEY NOT NULL REFERENCES corpus_admission_decisions(id) ON DELETE CASCADE,
  device_passport_id TEXT NOT NULL REFERENCES device_passports(id) ON DELETE RESTRICT,
  verified_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cadp_device_passport_id ON corpus_admission_decision_device_provenance(device_passport_id);
