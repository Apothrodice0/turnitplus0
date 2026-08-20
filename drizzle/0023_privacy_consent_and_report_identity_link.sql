-- Privacy/data-lifecycle hardening (production audit fix). Two purely-
-- additive columns, no existing column/constraint changes.
--
-- 1. saved_reports.document_identity_id: the missing link between a saved
--    report and the document_identities row captureDocumentIdentityAndFamily
--    creates for it (see app/api/reports/route.ts). Without this, DELETE
--    /api/reports/[id] could only *guess* which identity/shingle/family/
--    corpus rows belong to a given report -- unsafe, because the same
--    account can legitimately submit identical text as two different
--    reports, each getting its OWN document_identities row
--    (isFirstSaveOfThisReport is keyed on report id, not content), so a
--    hash-based guess could delete data a different, still-live report
--    still legitimately needs. Nullable and ON DELETE SET NULL: losing the
--    identity row must not delete the report, matching every other
--    account_id/user_id nullable-on-delete column in this schema (same
--    proven pattern as 0011_saved_reports_user_id.sql). NULL for every
--    report saved before this migration -- those pre-existing reports
--    cannot be exactly traced to a specific identity row after the fact, so
--    deleting them cannot safely cascade further than saved_reports itself
--    (see lib/report-deletion.ts's own header comment for this documented
--    limitation).
--
-- 2. users.corpus_reuse_consented_at: NULL means "has not opted in" (the
--    default for every existing and new account). indexDocumentSubmission
--    IntoCorpus (the cross-account matching corpus write, called from
--    POST /api/reports) now additionally requires this to be non-NULL for
--    a signed-in user before it runs at all -- see app/api/reports/route.ts.
--    A timestamp rather than a plain boolean so the audit trail records
--    *when* consent was granted, matching this schema's existing
--    declared_at/confirmed_at/revoked_at convention (reuse_context_
--    declarations). Revoking (PATCH /api/auth/me) sets it back to NULL --
--    revocation stops *future* indexing; it does not retroactively remove
--    text already indexed under a prior report's own deletion path (report
--    deletion is the only text-removal mechanism, by design -- see
--    lib/report-deletion.ts).
ALTER TABLE saved_reports ADD COLUMN document_identity_id TEXT REFERENCES document_identities(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN corpus_reuse_consented_at TEXT;

CREATE INDEX IF NOT EXISTS idx_saved_reports_document_identity_id ON saved_reports(document_identity_id);
