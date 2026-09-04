-- Developer control: per-account exemption from the 7-day corpus maturity
-- gate (lib/user-submission-corpus.ts's admissionEligibilitySql /
-- CORPUS_ACTIVATION_DELAY_DAYS). Purely additive: ONE new table, no existing
-- table altered, no backfill, no down migration.
--
-- Semantics: if a corpus backing's owning account has a row in this table,
-- that backing is treated as mature immediately, regardless of its own T0
-- (corpus_submission_references.created_at / corpus_admission_decisions.created_at).
-- This affects ONLY the maturity term of admissionEligibilitySql — it never
-- bypasses the account self-exclusion check, ADMISSION_DEDUP's own
-- unconditional visibility, or any scoring/relationship/duplicate-suppression
-- logic downstream of eligibility.
--
-- user_id is the PRIMARY KEY (not an autoincrement id) — an account is either
-- exempt or not, never exempt "more than once"; ON DELETE CASCADE so a
-- deleted account's exemption row cannot outlive it.
-- created_by_user_id is informational only (which admin added the exemption)
-- and is never read by the maturity gate itself; ON DELETE SET NULL so
-- deleting the admin who granted it never blocks the admin's own deletion or
-- silently deletes someone else's exemption.
CREATE TABLE IF NOT EXISTS developer_corpus_maturity_exemptions (
  user_id            TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
