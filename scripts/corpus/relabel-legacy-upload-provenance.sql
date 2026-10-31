-- Uploads retained before 2026-10-31 carry a hard-coded consent label: nobody was asked. This records what actually happened.
-- A data change, never run by the app or a migration: it needs its own approval on each database, after the build that knows
-- LEGACY_NOT_ASKED is live. Matching reads neither column. Inverse: relabel-legacy-upload-provenance.rollback.sql.
UPDATE corpus_admission_content_store SET retention_basis = 'LEGACY_NOT_ASKED'
WHERE retention_basis = 'CONSENT_GRANTED'
  AND decision_id IN (SELECT id FROM corpus_admission_decisions WHERE source_ref LIKE 'report-upload:%');
UPDATE corpus_admission_decisions SET consent_metadata = '{"kind":"SERVICE_POLICY","policy":"turnitplus-legacy-upload-not-asked-v1"}'
WHERE source_ref LIKE 'report-upload:%' AND consent_metadata = '{"kind":"PER_USER_CONSENT","consented":true}';
