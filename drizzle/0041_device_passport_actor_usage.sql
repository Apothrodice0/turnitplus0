-- Device Passport — durable ACTOR USAGE LEDGER, FOUNDATION ONLY. Purely
-- additive: one new append-only table plus one new NOT NULL DEFAULT 0 column
-- on the already-existing device_passports table. NOTHING in any scoring path
-- reads or consumes this yet — the refined CONSERVATIVE_COMBINED (Policy D)
-- guard, resolveEffectiveDeviceSelfRepresentationIds, computeUnifiedSimilarity,
-- the same-device SELF rule and DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED
-- behaviour are all untouched and unaware of it. This migration only
-- establishes the storage shape.
--
-- WHY THIS EXISTS
-- The saved_reports fan-out facts a later phase would infer "how many distinct
-- actors have ever used this browser" from can SHRINK: a report is deleted
-- (DELETE /api/reports/[id]), an account is deleted, a developer / account
-- clears their rooms, an anonymous report is claimed (claimAnonymousReports),
-- the corpus retention sweep ages a job row out, an accepted corpus backing is
-- revoked. corpus_admission_decision_device_provenance (drizzle/0039) only
-- ever covers the tiny accepted-corpus subset. Neither is a complete, durable
-- record of which actors have uploaded under a given verified device passport.
-- device_passport_actor_usage IS that record: append-only, never deleted,
-- never decremented, and NEVER touched by any of the paths above.
--
-- device_passport_actor_usage: one row per (passport, actor-key-version,
-- actor-key) triple ever observed uploading under a cryptographically
-- verified device passport.
--   device_passport_id -> device_passports(id) ON DELETE RESTRICT: a passport
--     row can never be removed while any actor-usage observation still
--     references it — the same durability posture drizzle/0039's per-backing
--     corpus_admission_decision_device_provenance link already took.
--   actor_key is a STABLE KEYED PSEUDONYM, NEVER a raw account id:
--     HMAC-SHA256(dedicated server key, domain-separated account id) lowercase
--     hex for an authenticated account (domain separator
--     TURNITPLUS_DEVICE_ACTOR_V1 — see lib/device-passport-actor-ledger.ts), a
--     fixed internal sentinel for anonymous use. actor_key_version records
--     which keying generation produced the pseudonym so the scheme can be
--     rotated later without losing or rewriting history.
--   is_anonymous is 1 for the anonymous-sentinel row, 0 for a real
--     pseudonymous account row — redundant with the sentinel value, kept
--     explicit so a reader never has to know the sentinel string.
--   first_observed_at / last_observed_at / observation_count follow UPSERT
--     semantics: a repeat observation of the SAME triple PRESERVES
--     first_observed_at, ADVANCES last_observed_at, INCREMENTS
--     observation_count. Rows are NEVER deleted; counts are NEVER decremented.
--   Epoch-millisecond integer timestamps (the drizzle/0038 / sessions / 0010
--     convention), never TEXT CURRENT_TIMESTAMP.
--   Index on device_passport_id for the per-passport "who has used this
--     browser" lookup a later phase performs (the composite PK's own implicit
--     index already covers this as a leftmost prefix, but the explicit index
--     documents the access pattern and matches db/schema.ts).
--
-- device_passports.actor_usage_tracking_version — the COMPLETENESS marker:
--   0 (the value EVERY existing row keeps after this migration): historical
--     actor usage for this passport is NOT proven complete. Deleted historical
--     accounts and past anonymous use cannot be reconstructed.
--   1: this passport has been durably actor-tracked since its creation, by
--     code able to record every actor observation from birth.
--   A passport is NEVER promoted 0 -> 1 after the fact — not on re-register,
--     not because current saved_reports were backfilled, not because it
--     uploads again. Only a genuinely NEW passport, inserted by registration
--     code that has durable actor-tracking support available (the dedicated
--     actor HMAC key present — DEVICE_PASSPORT_ACTOR_HMAC_KEY), may be BORN at
--     version 1. NOT NULL DEFAULT 0 backfills every existing passport to 0,
--     which is exactly the correct "history not proven complete" resting
--     state, so no explicit backfill statement is needed.
ALTER TABLE device_passports ADD COLUMN actor_usage_tracking_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS device_passport_actor_usage (
  device_passport_id TEXT NOT NULL REFERENCES device_passports(id) ON DELETE RESTRICT,
  actor_key_version INTEGER NOT NULL,
  actor_key TEXT NOT NULL,
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (device_passport_id, actor_key_version, actor_key)
);

CREATE INDEX IF NOT EXISTS idx_device_passport_actor_usage_passport
  ON device_passport_actor_usage(device_passport_id);
