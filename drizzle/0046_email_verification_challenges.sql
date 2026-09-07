-- Email Verification FOUNDATION (A3).
-- Additive: ONE new column on `users`, ONE new table + TWO indexes. No other
-- existing table changes, there is no backfill (the new column defaults to
-- SQL NULL = "not verified", the correct state for every existing account) and
-- there is no down migration.
--
-- DO NOT apply this to Preview or Production in this phase. A dedicated,
-- separately-reviewed application step comes later, exactly as for
-- drizzle/0045. Known from controlled runtime verification: Preview is at
-- migration 0045; Production is untouched by this work. lib/e8-tables-migration-
-- runner.ts is deliberately NOT touched (frozen at 0040; 0041-0046 all bypass
-- it — its naive splitStatements() is not involved here).
--
-- Applied ONLY by lib/ingest.ts's applyMigrations (better-sqlite3 db.exec) /
-- applyMigrationsLibsql (client.executeMultiple) and the test paths. Plain DDL:
-- ALTER TABLE ADD COLUMN + CREATE TABLE + CREATE INDEX, no trigger.
--
-- ── WHERE EMAIL-VERIFIED STATE LIVES ──────────────────────────────────────
-- users.email_verified_at (epoch-ms, nullable) is the SINGLE AUTHORITATIVE
-- record of whether an account's login email is verified. It is a property of
-- the login credential itself (users.email), so it works uniformly for EVERY
-- account — including grandfathered accounts that predate A2 and have no
-- account_identity_profiles row. NULL = unverified; a timestamp = verified at
-- that instant.
--
-- account_identity_profiles.email_verified_at (added in 0045) is now
-- DEPRECATED / VESTIGIAL. It is kept only so 0045 need not be rewritten and so
-- the column drop can be a later, separate migration. Nothing reads it and
-- nothing writes it any more — lib/account-identity-repo.ts never wrote it, and
-- A3's routes deliberately target users.email_verified_at instead. Do not
-- reintroduce a reader or writer for the profile column.
--
-- A3 still writes NO account_identity_fingerprints row — a verified primary
-- email stays ACCOUNT_ONLY (lib/account-identity.ts
-- ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING) and never becomes cross-account
-- ownership evidence.
--
-- ── WHAT THIS IS ───────────────────────────────────────────────────────────
-- One row per issued email-verification challenge. A challenge proves the
-- account controls the mailbox at a specific address; consuming it is the only
-- thing that ever sets an account's email-verified state (A3:
-- account_identity_profiles.email_verified_at for an account that has a
-- profile — see lib/email-verification.ts and the /api/auth/email-verification
-- routes; profile-less legacy accounts are handled separately, see the phase
-- report).
--
--   user_id       REFERENCES users(id) ON DELETE CASCADE — the challenge is
--     per-account and is transient state, so it is removed automatically with
--     the account (same rationale as sessions / account_identity_profiles; no
--     change to lib/account-deletion.ts is needed).
--   email         the exact users.email (lowercased) this challenge was issued
--     FOR. Compared against the account's CURRENT users.email at verify time so
--     a token minted for a since-changed address can never verify the new one
--     ("token belonging to another current email state"). users.email is
--     already stored cleartext and UNIQUE — recording it again here is not a
--     new exposure class, and it is what the mail-delivery layer addresses.
--   token_digest  lowercase SHA-256 hex of the raw 256-bit (32-byte) token.
--     The RAW token is generated with a CSPRNG, handed ONLY to the mail-
--     delivery layer, and is NEVER stored or logged — identical discipline to
--     sessions.token_hash (lib/auth-session.ts hashToken) and
--     device_passport_challenges.nonce_hash. A plain digest (no keyed HMAC, no
--     server secret, hence no new environment variable) is sufficient: the
--     token is 32 bytes of CSPRNG output, so neither preimage nor brute-force
--     over the digest is feasible. UNIQUE — it is the verification lookup key.
--   created_at / expires_at / consumed_at / revoked_at  epoch-ms integers (the
--     sessions / device-passport convention, never TEXT CURRENT_TIMESTAMP).
--     expires_at enforces the short bounded TTL (an application constant in
--     lib/email-verification.ts, NOT an env variable). consumed_at makes a
--     challenge strictly single-use (verification does an atomic
--     UPDATE ... SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND
--     revoked_at IS NULL AND expires_at > ? and requires rowsAffected = 1, so
--     two concurrent verifications can never both succeed). revoked_at is set
--     in bulk when the account's email changes, invalidating every outstanding
--     challenge atomically with the users.email UPDATE.
--
-- Rows may be removed freely once expires_at has passed — opportunistic
-- cleanup piggybacked on ordinary traffic, the same pattern
-- device_passport_challenges / rate_limit_buckets use (this app has no cron
-- infrastructure).
--
-- PRIVACY: no raw token, no password, no session token, no fingerprint, no IP,
-- and no coarse-location or timing column.

-- The single authoritative email-verified marker (see the header). Epoch-ms,
-- nullable, defaults to NULL for every existing row (= unverified). Only
-- consuming a valid email_verification_challenges row ever sets it; changing
-- users.email clears it back to NULL atomically with the email UPDATE.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

CREATE TABLE IF NOT EXISTS email_verification_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER,

  -- 64 lowercase hex chars = SHA-256. A structural backstop only; the app
  -- always writes exactly this.
  CHECK (length(token_digest) = 64),
  -- A challenge cannot expire before it exists.
  CHECK (expires_at > created_at)
);

-- The verification lookup key. UNIQUE both to serve the lookup and to make a
-- (cryptographically impossible) digest collision a hard error rather than an
-- ambiguous match.
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_verification_challenges_token_digest
  ON email_verification_challenges(token_digest);

-- Serves the per-account resend-cooldown lookup ("this account's most recent
-- challenge") and the bounded-issuance-per-window count.
CREATE INDEX IF NOT EXISTS idx_email_verification_challenges_user_created
  ON email_verification_challenges(user_id, created_at);
