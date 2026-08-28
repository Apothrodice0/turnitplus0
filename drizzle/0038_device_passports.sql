-- Device Passport — Phase 1 SCHEMA FOUNDATION ONLY. Purely additive: no
-- existing table's rows, columns, or constraints change, and nothing reads
-- or writes these tables yet. Browser key generation, challenge issuance,
-- signature verification, device-continuity matching, the SELF downgrade,
-- shared-device thresholds, and any admin UI are all deliberately out of
-- scope for this migration — it only establishes the storage shape.
--
-- device_passports: one row per registered browser public key. `id` is the
-- lowercase SHA-256 hex fingerprint of public_key_spki, so registration is
-- idempotent (INSERT ... ON CONFLICT(id) DO NOTHING). public_key_spki holds
-- ONLY the raw DER SubjectPublicKeyInfo, kept solely to verify ECDSA P-256 /
-- SHA-256 signatures — the private key never leaves the browser and is never
-- stored server-side in any form. No account_id / device_key / foreign key:
-- a passport is deliberately not owned by an account (the same verified
-- device can legitimately be used across accounts — that is the whole point
-- of the signal). revoked_at is the only removal lever for v1 (admin
-- triggered, for a compromised passport); rows are never removed by any
-- automated process while report or corpus-backing provenance still
-- references the id.
--
-- provenance_generation is a PER-PASSPORT monotonic counter (never a global
-- singleton — a global one would invalidate every report's device-sensitive
-- classification whenever ANY passport gained a new account). A later phase
-- increments THIS passport's counter when it gains a materially relevant new
-- distinct account association, and on revocation. Passport D2's changes
-- never touch passport D1's counter, so a report uploaded under D1 is only
-- ever re-evaluated when D1 itself changes. report_historical_match_snapshots
-- stamps the passport's counter value at computation time (drizzle/0040).
--
-- Epoch-millisecond integers for every timestamp (the sessions / 0010
-- convention), never the TEXT CURRENT_TIMESTAMP used elsewhere in this
-- schema: expires_at and last_seen_at are range-compared, and mixing
-- SQLite's space-separated CURRENT_TIMESTAMP format with app-generated
-- values in a comparison is a real lexicographic-ordering bug that integers
-- sidestep entirely.
CREATE TABLE IF NOT EXISTS device_passports (
  id TEXT PRIMARY KEY NOT NULL,
  public_key_spki BLOB NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'ECDSA-P256-SHA256',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  provenance_generation INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_device_passports_last_seen ON device_passports(last_seen_at);

-- device_passport_challenges: one row per issued device-attestation
-- challenge nonce. nonce_hash is SHA-256 of the 32-byte random nonce — the
-- raw nonce is returned to the client exactly once and never stored (the
-- same discipline sessions.token_hash follows). account_id and
-- session_token_hash record the session context captured SERVER-SIDE at
-- issue time; a later verification step compares them against the
-- then-current session, so the browser never handles a session secret. A
-- row is single-use: verification performs an atomic
-- UPDATE ... SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL and
-- requires rowsAffected = 1. Rows may be removed freely once expires_at has
-- passed — opportunistic cleanup piggybacked on ordinary traffic (this app
-- has no cron infrastructure; the same pattern rate_limit_buckets / 0024
-- uses). No foreign key: a challenge outlives nothing and references no
-- durable owner.
CREATE TABLE IF NOT EXISTS device_passport_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  nonce_hash TEXT NOT NULL,
  account_id TEXT,
  session_token_hash TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_device_passport_challenges_expiry ON device_passport_challenges(expires_at);
