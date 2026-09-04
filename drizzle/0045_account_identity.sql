-- Account Identity FOUNDATION (A1) — SCHEMA + STORAGE ONLY. Purely additive:
-- two new tables (account_identity_profiles, account_identity_fingerprints)
-- plus their indexes. NOTHING is altered on `users` or on any other existing
-- table, there is no new column anywhere outside these two tables, there is no
-- backfill and there is no down migration.
--
-- DO NOT apply this to Preview or Production in this phase. Known from
-- controlled runtime verification: Preview is at migration 0044 (0042, 0043,
-- 0044 already applied); Production is untouched by this work. A dedicated,
-- separately-reviewed Preview application step for 0045 comes later —
-- lib/e8-tables-migration-runner.ts is deliberately NOT touched here.
--
-- This migration is applied by lib/ingest.ts's applyMigrations (better-sqlite3
-- db.exec) / applyMigrationsLibsql (client.executeMultiple) and the test
-- paths only. Plain DDL: CREATE TABLE / CREATE INDEX, no trigger.
--
-- ── WHAT THIS IS ───────────────────────────────────────────────────────────
-- A per-account 1:1 identity profile beside `users`. It records the KIND of
-- account (account_type: student | instructor | researcher | independent) and,
-- optionally, residence country, institution, city, phone and full name — as
-- CANONICAL identifiers wherever possible. `users.role` (user | admin) remains
-- the ONLY authorization field and is untouched; account_type is descriptive
-- identity, never a permission.
--
-- ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
--   * NOT a verification system. In A1 every value is UNVERIFIED. The
--     *_verified_at columns exist for a later phase and are ALWAYS NULL now —
--     nothing in lib/account-identity{,-repo}.ts ever writes them.
--   * NOT owner evidence. lib/account-identity.ts's
--     identityClaimIsOwnerEvidenceEligible is unconditionally false in A1. An
--     UNVERIFIED_TEXT institution / city name is explicitly LOW-TRUST and can
--     never feed owner-link inference until it is BOTH canonicalized AND
--     independently verified (a separate, reviewed phase).
--   * NOT wired into similarity / owner-link / Device Passport / corpus /
--     scoring in any way. tests/account-identity*.test.mjs pin the isolation.
--
-- ── account_identity_profiles ──────────────────────────────────────────────
--   user_id  PRIMARY KEY, REFERENCES users(id) ON DELETE CASCADE. The PK makes
--     this strictly 1:1 with `users`; CASCADE means account deletion removes
--     the profile automatically (it is per-account PII owned by the account —
--     unlike the durable cross-account owner-link tables which use RESTRICT).
--     No route wiring and no change to lib/account-deletion.ts is needed.
--   account_type      NOT NULL DEFAULT 'independent' — the unaffiliated,
--     no-institutional-claim default, so an independent user is never forced to
--     invent fake university data. CHECK-constrained; keep the list identical to
--     lib/account-identity.ts ACCOUNT_TYPES.
--   full_name         NOT NULL — the NFC-normalized name (lib/account-identity.ts
--     normalizeFullName — Unicode-safe: ZWJ/ZWNJ and combining marks preserved,
--     bidi/control characters rejected). It is the required human-identity
--     anchor of a profile: normalizeAccountIdentityProfile rejects a missing /
--     empty name, so a profile row never exists without one. PRIVACY: never logged.
--   country_code      nullable, ISO 3166-1 alpha-2 (uppercase) RESIDENCE
--     country. Deliberately SEPARATE from phone_region (the phone number's own
--     dial/region context) — the two are never conflated.
--   institution_status  NOT NULL DEFAULT 'NONE'. 'NONE' is an explicit positive
--     "non-affiliated" state, not a missing value. 'ROR' → institution_ror_id
--     holds a canonical Research Organization Registry id body (checksum-checked
--     in lib/account-identity.ts). 'UNVERIFIED_TEXT' → institution_unverified_name
--     holds a low-trust free-text name kept ONLY for future import compatibility.
--     A table CHECK pins exactly one shape per status.
--   city_status        NOT NULL DEFAULT 'NONE', same three-way shape:
--     'GEONAMES' → city_geonames_id (canonical GeoNames feature id);
--     'UNVERIFIED_TEXT' → city_unverified_name (low-trust). The multi-MB ROR /
--     GeoNames datasets themselves are deliberately NOT bundled in A1.
--   phone_e164         nullable, normalized E.164 (lib/account-identity.ts
--     normalizePhoneNumber, which delegates ALL validity to libphonenumber-js/max
--     — no custom national-number rules). The column CHECK is a structural DB
--     backstop that does NOT depend on GLOB '*' wildcards: leading '+', first
--     digit 1-9, every remaining character a decimal digit, 8-16 chars total.
--     PRIVACY: never logged.
--   phone_region       nullable, ISO alpha-2 dial/region context of the phone
--     number (NULL for a global-service number). NOT the residence country.
--   email_verified_at / phone_verified_at / institution_verified_at  epoch-ms,
--     nullable, ALWAYS NULL in A1. No code may set a non-NULL value in this
--     phase; the columns exist so the verified-identity phase is purely additive.
--   normalization_version  NOT NULL DEFAULT 1 — which normalizer version
--     produced the stored values, so a future normalizer change can find stale
--     rows (the device_passports.actor_usage_tracking_version pattern).
--   created_at / updated_at  epoch-ms integers (the drizzle/0038 convention),
--     app-supplied, never TEXT CURRENT_TIMESTAMP.
--
-- The partial indexes on institution_ror_id / city_geonames_id / country_code
-- support later ADMIN aggregation only ("accounts at institution X"); nothing
-- reads them yet.
--
-- ── account_identity_fingerprints ─────────────────────────────────────────
-- FUTURE keyed-HMAC pseudonyms of VERIFIED identity values (a verified email /
-- phone), so two accounts sharing one can be matched WITHOUT storing the raw
-- value. In A1 THIS TABLE IS NEVER WRITTEN: lib/account-identity-repo.ts exposes
-- only a reader for it and no writer at all, and lib/account-identity.ts's
-- accountIdentityFingerprint fails closed unless the value is explicitly
-- { verified: true } — which nothing produces in A1.
--   user_id           REFERENCES users(id) ON DELETE CASCADE.
--   fingerprint_kind  CHECK-constrained; keep identical to
--     lib/account-identity.ts ACCOUNT_IDENTITY_FINGERPRINT_KINDS. Each name
--     encodes that the source value MUST have been verified first. The
--     cross-account owner-link ceiling per kind lives in
--     lib/account-identity.ts ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING:
--       VERIFIED_EMAIL            ACCOUNT_ONLY — the fingerprint is over the
--         PRIMARY login email (users.email); ux_users_email makes that column
--         UNIQUE, so two live accounts can never share it and exact equality is
--         STRUCTURALLY UNAVAILABLE as an owner-link signal. (A future
--         recovery-email / OAuth-subject / SSO-subject would be a SEPARATE
--         kind; A1 adds none, and ux_users_email must NOT be weakened.)
--       VERIFIED_INSTITUTION_ROR  SUPPORTING only — an entire campus shares one
--         verified ROR, so institution equality alone is NEVER ownership proof.
--       VERIFIED_PHONE_E164       ESTABLISHING_CANDIDATE only — never automatic
--         ownership proof; a separate confidence review gates any HIGH.
--   fingerprint       an HMAC-SHA256 hex digest. The HMAC key is derived
--     PER KIND from the one root secret (a KDF step keyed by the root over the
--     kind), so the SAME normalized value under two different kinds yields
--     cryptographically unrelated digests — NEVER a raw email / phone / ror id.
--   key_version       which keying generation produced it
--     (ACCOUNT_IDENTITY_KEY_VERSION).
--   source_verified_at  epoch-ms; NOT NULL by construction — a fingerprint only
--     ever exists for a value that was verified.
--   ux_account_identity_fingerprints_kind  one fingerprint per (account, kind,
--     key generation). idx_..._lookup serves the future "which other accounts
--     share this fingerprint" query.
--
-- PRIVACY: no raw phone, full name, email, fingerprint, or verification secret
-- is stored in cleartext; no IP / coarse-location / timing column exists here.

CREATE TABLE IF NOT EXISTS account_identity_profiles (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  account_type TEXT NOT NULL DEFAULT 'independent'
    CHECK (account_type IN ('student', 'instructor', 'researcher', 'independent')),

  full_name TEXT NOT NULL,

  country_code TEXT
    CHECK (country_code IS NULL OR (length(country_code) = 2 AND country_code GLOB '[A-Z][A-Z]')),

  institution_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (institution_status IN ('NONE', 'ROR', 'UNVERIFIED_TEXT')),
  institution_ror_id TEXT,
  institution_unverified_name TEXT,

  city_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (city_status IN ('NONE', 'GEONAMES', 'UNVERIFIED_TEXT')),
  city_geonames_id INTEGER
    CHECK (city_geonames_id IS NULL OR city_geonames_id > 0),
  city_unverified_name TEXT,

  -- E.164 backstop that does NOT rely on GLOB '*' (which matches ANY character):
  --   substr(...,1,1) = '+'                first character is a literal '+'
  --   substr(...,2,1) GLOB '[1-9]'         first digit is 1-9 (no leading zero, no '+')
  --   substr(...,3) NOT GLOB '*[^0-9]*'    every remaining character is a decimal digit
  --   length(...) BETWEEN 8 AND 16         '+' plus 7-15 digits (E.164 max is 15 digits)
  -- App-side validity still comes from libphonenumber-js/max; this is the DB backstop.
  phone_e164 TEXT
    CHECK (
      phone_e164 IS NULL OR (
        length(phone_e164) BETWEEN 8 AND 16
        AND substr(phone_e164, 1, 1) = '+'
        AND substr(phone_e164, 2, 1) GLOB '[1-9]'
        AND substr(phone_e164, 3) NOT GLOB '*[^0-9]*'
      )
    ),
  phone_region TEXT
    CHECK (phone_region IS NULL OR (length(phone_region) = 2 AND phone_region GLOB '[A-Z][A-Z]')),

  -- ALWAYS NULL in A1. No code writes a non-NULL value in this phase.
  email_verified_at INTEGER,
  phone_verified_at INTEGER,
  institution_verified_at INTEGER,

  normalization_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Table-level consistency CHECKs (SQLite requires every table constraint
  -- AFTER all column definitions): exactly one shape per *_status.
  CHECK (
    (institution_status = 'NONE'
      AND institution_ror_id IS NULL AND institution_unverified_name IS NULL) OR
    (institution_status = 'ROR'
      AND institution_ror_id IS NOT NULL AND institution_unverified_name IS NULL) OR
    (institution_status = 'UNVERIFIED_TEXT'
      AND institution_unverified_name IS NOT NULL AND institution_ror_id IS NULL)
  ),
  CHECK (
    (city_status = 'NONE'
      AND city_geonames_id IS NULL AND city_unverified_name IS NULL) OR
    (city_status = 'GEONAMES'
      AND city_geonames_id IS NOT NULL AND city_unverified_name IS NULL) OR
    (city_status = 'UNVERIFIED_TEXT'
      AND city_unverified_name IS NOT NULL AND city_geonames_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_account_identity_profiles_institution_ror
  ON account_identity_profiles(institution_ror_id)
  WHERE institution_ror_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_account_identity_profiles_city_geonames
  ON account_identity_profiles(city_geonames_id)
  WHERE city_geonames_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_account_identity_profiles_country_code
  ON account_identity_profiles(country_code)
  WHERE country_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_identity_fingerprints (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint_kind TEXT NOT NULL
    CHECK (fingerprint_kind IN ('VERIFIED_EMAIL', 'VERIFIED_PHONE_E164', 'VERIFIED_INSTITUTION_ROR')),
  fingerprint TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  source_verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_account_identity_fingerprints_kind
  ON account_identity_fingerprints(user_id, fingerprint_kind, key_version);

CREATE INDEX IF NOT EXISTS idx_account_identity_fingerprints_lookup
  ON account_identity_fingerprints(fingerprint_kind, fingerprint);
