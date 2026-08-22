-- Audit trail for the admin-only corpus-admission dashboard
-- (app/admin/corpus/*, app/api/admin/corpus/*). Every deactivate,
-- reactivate, and retained-text preview reveal writes exactly one row here
-- — see lib/corpus-admission-admin-actions.ts's own header comment.
--
-- Deliberately no FOREIGN KEY to users or corpus_admission_decisions: an
-- audit trail must remain fully readable even if the acting admin's account
-- is later deleted, or (in principle) the decision row itself is gone —
-- losing the audit record along with either would defeat the point of
-- having one. decision_id/accepted_representation_id are still recorded as
-- plain text columns for correlation.
CREATE TABLE IF NOT EXISTS corpus_admission_admin_audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  admin_user_id TEXT NOT NULL,
  -- 'deactivate' | 'reactivate' | 'view_retained_text'
  action TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  accepted_representation_id TEXT,
  -- Required (non-empty) for 'deactivate'/'reactivate' — see
  -- lib/corpus-admission-admin-actions.ts's own validation. Always NULL for
  -- 'view_retained_text', which was not asked to require one.
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_corpus_admission_admin_audit_log_decision_id ON corpus_admission_admin_audit_log(decision_id);
CREATE INDEX IF NOT EXISTS idx_corpus_admission_admin_audit_log_admin_user_id ON corpus_admission_admin_audit_log(admin_user_id);
