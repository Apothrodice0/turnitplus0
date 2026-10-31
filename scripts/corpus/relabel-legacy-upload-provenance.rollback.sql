-- Exact inverse of relabel-legacy-upload-provenance.sql. Every relabelled row held the same original value.
UPDATE corpus_admission_decisions SET consent_metadata = '{"kind":"PER_USER_CONSENT","consented":true}'
WHERE consent_metadata = '{"kind":"SERVICE_POLICY","policy":"turnitplus-legacy-upload-not-asked-v1"}';
UPDATE corpus_admission_content_store SET retention_basis = 'CONSENT_GRANTED' WHERE retention_basis = 'LEGACY_NOT_ASKED';
