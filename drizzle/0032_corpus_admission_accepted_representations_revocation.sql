-- Removal follow-through for the "first accepted sample wins" fingerprint
-- (drizzle/0030's corpus_admission_accepted_representations). Additive to
-- an already-committed table — 0030 itself is not edited.
--
-- revoked_at is reserved for a future, explicitly admin-triggered removal
-- flow (e.g. a legal takedown) — nothing in this codebase sets it yet.
-- Accepted corpus content is durable by policy: neither a consent change
-- nor a report/account deletion ever sets this column (see
-- lib/corpus-admission-report-integration.ts's own header comment) — a
-- self-service consent toggle must never retroactively pull content out of
-- the shared corpus. When that future flow does mark a row, it must NOT be
-- deleted — the row (hash, word count, shingle hashes; never raw text)
-- remains as an audit trail of what was once accepted and why it no longer
-- is — but it must stop participating in ACTIVE "first accepted sample
-- wins" matching, so a later, independently authorized submission of the
-- same or overlapping content can be evaluated fresh and become canonical
-- in its place. lib/corpus-admission-gate.ts already filters WHERE
-- revoked_at IS NULL, so this takes effect immediately once that future
-- flow ships, with no further gate changes needed.
--
-- The original plain UNIQUE index on canonical_sha256 (0030) is replaced
-- here with a PARTIAL unique index scoped to WHERE revoked_at IS NULL:
-- uniqueness is enforced only among currently-active fingerprints, so a new
-- row can legitimately reuse a hash whose only prior holder has been
-- revoked, while two simultaneously-active rows still can never share one.
DROP INDEX IF EXISTS ux_corpus_admission_accepted_representations_canonical_sha256;

ALTER TABLE corpus_admission_accepted_representations ADD COLUMN revoked_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_admission_accepted_representations_canonical_sha256_active
  ON corpus_admission_accepted_representations(canonical_sha256)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_corpus_admission_accepted_representations_revoked_at
  ON corpus_admission_accepted_representations(revoked_at);
