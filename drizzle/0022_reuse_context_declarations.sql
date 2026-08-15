-- Phase E8S Step 4: reuse-context declarations — the human-asserted layer
-- proposed in E8S Step 2's design and built on E8S Step 3's exact
-- match-pair resolver (lib/e8s-match-pair-resolution.ts). Purely additive —
-- no existing table's rows, columns, or constraints change, and this table
-- is never read by the production historical-match path
-- (lib/user-submission-matching.ts, lib/report-historical-match.ts): it is
-- an independent, opt-in claim a submitter can make about one specific
-- historical match, never a replacement for SELF/PRIOR_SUBMISSION/
-- UNKNOWN_RELATIONSHIP, which stay computed exactly as before. Not exposed
-- in the UI yet.
--
-- The match pair is (document_identity_id, matched_representation_id) — see
-- E8S Step 2 §2/13 for why this is the enforced boundary rather than the
-- account or the raw canonical hash: document_identities never deduplicates
-- across resubmissions, so a declaration never silently carries forward to
-- a re-uploaded/revised version of the same content. matched_submission_
-- reference_id is additionally recorded when E8S Step 3's resolver can
-- prove exactly one candidate corpus_submission_references row exists — it
-- is nullable because that resolver deliberately returns no id when the
-- match is ambiguous, and this table must never store a guess.
--
-- No DB-level FOREIGN KEY to document_identities, corpus_document_
-- representations, or corpus_submission_references — the same schema-drift-
-- tooling reason already documented on report_historical_match_snapshots
-- (drizzle/0020) and historical_match_shadow_evaluations (drizzle/0021).
-- declared_by_account_id / confirmed_by_account_id / revoked_by_account_id
-- DO reference users(id) ON DELETE SET NULL, matching document_identities.
-- account_id and saved_reports.user_id exactly: losing an account must not
-- delete the declaration's audit trail (declared_context, declared_at,
-- verification_state, and any confirmation/revocation timestamps all
-- survive with the account pointer nulled out).
--
-- No document text, no historical document text, no email — only ids,
-- bounded enums, and timestamps. declared_context is one of SUPERVISOR_COPY,
-- COAUTHOR_COPY, INSTITUTIONAL_SUBMISSION, AUTHORIZED_ARCHIVAL_COPY,
-- OTHER_AUTHORIZED_REUSE — SELF is deliberately not a storable value here
-- (it is an existing, automatically-computed relationship, never a
-- declaration — see lib/reuse-context-declarations.ts's own header
-- comment). verification_state is one of SELF_ASSERTED_UNVERIFIED,
-- MUTUALLY_CONFIRMED, REVOKED.
--
-- Revoke is a state change (revoked_at/revoked_by_account_id set, never a
-- DELETE) — every declaration ever made stays queryable. The partial unique
-- index below enforces at most one ACTIVE declaration per match pair while
-- placing no limit on how many revoked/historical rows accumulate for that
-- same pair over time — a corrected or re-declared claim is a new row, not
-- an edit of the old one.
CREATE TABLE IF NOT EXISTS reuse_context_declarations (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  document_identity_id TEXT NOT NULL,
  matched_representation_id TEXT NOT NULL,
  matched_submission_reference_id INTEGER,
  declared_context TEXT NOT NULL,
  declared_by_account_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  declared_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  confirmed_by_account_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  verification_state TEXT NOT NULL DEFAULT 'SELF_ASSERTED_UNVERIFIED',
  revoked_at TEXT,
  revoked_by_account_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- At most one ACTIVE declaration per match pair (requirement 14 of E8S Step
-- 2's design) — a partial index, not a plain one, so a revoked row never
-- blocks a fresh declaration for the same pair.
CREATE UNIQUE INDEX IF NOT EXISTS ux_reuse_context_declarations_active_pair
  ON reuse_context_declarations(document_identity_id, matched_representation_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reuse_context_declarations_document_identity ON reuse_context_declarations(document_identity_id);
CREATE INDEX IF NOT EXISTS idx_reuse_context_declarations_matched_submission_reference ON reuse_context_declarations(matched_submission_reference_id);
CREATE INDEX IF NOT EXISTS idx_reuse_context_declarations_declared_by ON reuse_context_declarations(declared_by_account_id);
