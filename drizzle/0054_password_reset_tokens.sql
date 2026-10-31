-- Customer password recovery. Additive: ONE new table + TWO indexes. No existing table changes, no backfill, no down
-- migration. Applied by lib/ingest.ts's applyMigrations / applyMigrationsLibsql and the test paths, exactly like 0046.
--
-- DEPLOYMENT PREREQUISITE: apply to Production (and Preview) BEFORE relying on the feature. Until it is applied the
-- /api/auth/password-reset/* routes detect the missing table and answer the same 503 "not available right now" as an
-- unconfigured email provider — never a 500, never a false "email sent".
--
-- One row per issued reset link. The raw token (32 CSPRNG bytes, hex) exists only in the emailed link; this table
-- stores its SHA-256 digest. A token is usable while consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now.
-- Redemption is ONE conditional UPDATE that also stamps a fresh random redemption_id; the password change, the
-- session revocation and the revocation of the account's other open tokens in the same batch are guarded by that
-- redemption_id, so a replay or a concurrent second redemption of the same link can never change anything.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER,
  redemption_id TEXT,
  CHECK (length(token_digest) = 64),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_password_reset_tokens_token_digest ON password_reset_tokens (token_digest);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_created ON password_reset_tokens (user_id, created_at);
