import type { Client, InStatement } from "@libsql/client";
import {
  normalizeAccountIdentityProfile,
  ACCOUNT_IDENTITY_KEY_VERSION,
  type AccountType,
  type InstitutionStatus,
  type CityStatus,
  type AccountIdentityProfileInput,
  type NormalizedAccountIdentityProfile,
  type AccountIdentityValidationError as AccountIdentityValidationErrorDetail,
  type AccountIdentityFingerprintKind,
} from "./account-identity";

/**
 * Account Identity FOUNDATION (A1) - the DB layer. Pure SELECTs plus ONE
 * writer: upsert the 1:1 identity profile row for an account. Every write runs
 * lib/account-identity.ts's normalizeAccountIdentityProfile first, so only
 * canonical, Unicode-safe, libphonenumber-js-validated values are ever
 * persisted, and every *_verified_at column is left untouched (NULL) - NOTHING
 * here can mark an email / phone / institution VERIFIED in A1.
 *
 * account_identity_fingerprints: this module still has NO insert/upsert writer
 * of its own (see readAccountIdentityFingerprints below) — a fingerprint row is
 * only ever produced by the specific, separately-reviewed flow that verified
 * the underlying value, and lib/account-identity.ts's accountIdentityFingerprint
 * fails closed unless that value is explicitly { verified: true }. A3c is the
 * first such flow: a successful email verification writes a VERIFIED_EMAIL row
 * via lib/email-verification.ts's own guarded statement (coupled to the
 * winning challenge-consume, not exposed here — see that module). This module
 * DOES own deleteAccountIdentityFingerprintStatement below, used by the
 * email-change transaction (app/api/auth/me/route.ts) to revoke a now-stale
 * VERIFIED_EMAIL fingerprint atomically with the users.email UPDATE.
 *
 * NOTHING in this module is imported by any scoring / similarity / matcher /
 * candidate-discovery / owner-link / Device Passport path
 * (tests/account-identity.test.mjs pins the isolation). Deleting a `users` row
 * removes its profile and fingerprints automatically via ON DELETE CASCADE - no
 * change to lib/account-deletion.ts is needed.
 *
 * PRIVACY: this module never logs. A validation failure throws
 * AccountIdentityValidationException whose message is field/code pairs only -
 * never the offending phone number or name.
 */

type Exec = Pick<Client, "execute">;

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value ?? 0) || 0;
}
function numOrNull(value: unknown): number | null {
  return value == null ? null : num(value);
}
function strOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

export class AccountIdentityValidationException extends Error {
  readonly errors: readonly AccountIdentityValidationErrorDetail[];
  constructor(errors: readonly AccountIdentityValidationErrorDetail[]) {
    super(`account identity validation failed: ${errors.map((e) => `${e.field}/${e.code}`).join(", ")}`);
    this.name = "AccountIdentityValidationException";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// account_identity_profiles
// ---------------------------------------------------------------------------

export type StoredAccountIdentityProfile = {
  userId: string;
  accountType: AccountType;
  /** NOT NULL in the schema - always a normalized non-empty string. */
  fullName: string;
  countryCode: string | null;
  institutionStatus: InstitutionStatus;
  institutionRorId: string | null;
  institutionUnverifiedName: string | null;
  cityStatus: CityStatus;
  cityGeonamesId: number | null;
  cityUnverifiedName: string | null;
  phoneE164: string | null;
  phoneRegion: string | null;
  /** ALWAYS null in A1 - no code sets these in this phase. */
  emailVerifiedAt: number | null;
  phoneVerifiedAt: number | null;
  institutionVerifiedAt: number | null;
  normalizationVersion: number;
  createdAt: number;
  updatedAt: number;
};

function mapProfileRow(row: Record<string, unknown>): StoredAccountIdentityProfile {
  return {
    userId: String(row.user_id),
    accountType: String(row.account_type) as AccountType,
    fullName: String(row.full_name),
    countryCode: strOrNull(row.country_code),
    institutionStatus: String(row.institution_status) as InstitutionStatus,
    institutionRorId: strOrNull(row.institution_ror_id),
    institutionUnverifiedName: strOrNull(row.institution_unverified_name),
    cityStatus: String(row.city_status) as CityStatus,
    cityGeonamesId: numOrNull(row.city_geonames_id),
    cityUnverifiedName: strOrNull(row.city_unverified_name),
    phoneE164: strOrNull(row.phone_e164),
    phoneRegion: strOrNull(row.phone_region),
    emailVerifiedAt: numOrNull(row.email_verified_at),
    phoneVerifiedAt: numOrNull(row.phone_verified_at),
    institutionVerifiedAt: numOrNull(row.institution_verified_at),
    normalizationVersion: num(row.normalization_version),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

/** Read one account's identity profile, or null if it has none. SELECT-only. */
export async function readAccountIdentityProfile(
  exec: Exec,
  userId: string,
): Promise<StoredAccountIdentityProfile | null> {
  const row = (
    await exec.execute({ sql: `SELECT * FROM account_identity_profiles WHERE user_id = ?`, args: [userId] })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapProfileRow(row) : null;
}

export type UpsertAccountIdentityProfileResult = {
  profile: StoredAccountIdentityProfile;
  created: boolean;
};

/**
 * The `INSERT ... ON CONFLICT (user_id) DO UPDATE` statement that persists ONE
 * already-normalized profile. Shared by upsertAccountIdentityProfile (below)
 * and the ATOMIC signup path (app/api/auth/signup/route.ts's client.batch,
 * where it rides in the same transaction as the users + sessions inserts so a
 * profile CHECK failure rolls the whole account creation back — no users row,
 * no session). Never writes a *_verified_at column: a new row gets SQL NULL by
 * column default; a pre-existing value is left untouched.
 */
export function accountIdentityProfileUpsertStatement(
  userId: string,
  profile: NormalizedAccountIdentityProfile,
  now: number = Date.now(),
): InStatement {
  return {
    sql: `INSERT INTO account_identity_profiles (
            user_id, account_type, full_name, country_code,
            institution_status, institution_ror_id, institution_unverified_name,
            city_status, city_geonames_id, city_unverified_name,
            phone_e164, phone_region,
            normalization_version, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (user_id) DO UPDATE SET
            account_type = excluded.account_type,
            full_name = excluded.full_name,
            country_code = excluded.country_code,
            institution_status = excluded.institution_status,
            institution_ror_id = excluded.institution_ror_id,
            institution_unverified_name = excluded.institution_unverified_name,
            city_status = excluded.city_status,
            city_geonames_id = excluded.city_geonames_id,
            city_unverified_name = excluded.city_unverified_name,
            phone_e164 = excluded.phone_e164,
            phone_region = excluded.phone_region,
            normalization_version = excluded.normalization_version,
            updated_at = excluded.updated_at`,
    args: [
      userId,
      profile.accountType,
      profile.fullName,
      profile.countryCode,
      profile.institutionStatus,
      profile.institutionRorId,
      profile.institutionUnverifiedName,
      profile.cityStatus,
      profile.cityGeonamesId,
      profile.cityUnverifiedName,
      profile.phoneE164,
      profile.phoneRegion,
      profile.normalizationVersion,
      now,
      now,
    ],
  };
}

/**
 * Validate + normalize `input` and UPSERT the account's 1:1 identity profile.
 * Throws AccountIdentityValidationException (value-free message) if the input
 * does not normalize cleanly. The `users` row must already exist (FK).
 *
 * On update, created_at is preserved and updated_at advances. The three
 * *_verified_at columns are NEVER written by this function - a pre-existing
 * value (there is none in A1) is left as-is; a new row gets SQL NULL by column
 * default.
 */
export async function upsertAccountIdentityProfile(
  exec: Exec,
  userId: string,
  input: AccountIdentityProfileInput,
  now: number = Date.now(),
): Promise<UpsertAccountIdentityProfileResult> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("upsertAccountIdentityProfile: userId must be a non-empty string");
  }
  const result = normalizeAccountIdentityProfile(input);
  if (!result.ok) throw new AccountIdentityValidationException(result.errors);

  const existing = await readAccountIdentityProfile(exec, userId);
  await exec.execute(accountIdentityProfileUpsertStatement(userId, result.profile, now));

  const stored = await readAccountIdentityProfile(exec, userId);
  if (!stored) throw new Error("upsertAccountIdentityProfile: row vanished immediately after write");
  return { profile: stored, created: existing === null };
}

/** Persist an ALREADY-NORMALIZED profile (from lib/account-identity-signup.ts's resolver). Same NULL-verification guarantee. */
export async function persistNormalizedAccountIdentityProfile(
  exec: Exec,
  userId: string,
  profile: NormalizedAccountIdentityProfile,
  now: number = Date.now(),
): Promise<StoredAccountIdentityProfile> {
  await exec.execute(accountIdentityProfileUpsertStatement(userId, profile, now));
  const stored = await readAccountIdentityProfile(exec, userId);
  if (!stored) throw new Error("persistNormalizedAccountIdentityProfile: row vanished immediately after write");
  return stored;
}

/**
 * Explicitly delete one account's identity profile. Rarely needed - deleting
 * the `users` row already CASCADE-removes it - but available for an admin
 * "forget my identity, keep my account" action.
 */
export async function deleteAccountIdentityProfile(exec: Exec, userId: string): Promise<void> {
  await exec.execute({ sql: `DELETE FROM account_identity_profiles WHERE user_id = ?`, args: [userId] });
}

export async function countAccountIdentityProfiles(exec: Exec): Promise<number> {
  return num((await exec.execute(`SELECT COUNT(*) AS c FROM account_identity_profiles`)).rows[0]?.c);
}

// ---------------------------------------------------------------------------
// account_identity_fingerprints - READER ONLY in A1
// ---------------------------------------------------------------------------

export type StoredAccountIdentityFingerprint = {
  id: string;
  userId: string;
  fingerprintKind: AccountIdentityFingerprintKind;
  fingerprint: string;
  keyVersion: number;
  sourceVerifiedAt: number;
  createdAt: number;
};

function mapFingerprintRow(row: Record<string, unknown>): StoredAccountIdentityFingerprint {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    fingerprintKind: String(row.fingerprint_kind) as AccountIdentityFingerprintKind,
    fingerprint: String(row.fingerprint),
    keyVersion: num(row.key_version),
    sourceVerifiedAt: num(row.source_verified_at),
    createdAt: num(row.created_at),
  };
}

/**
 * Read one account's identity fingerprints. Empty for every account that has
 * never completed a verification flow that produces one (still every account
 * before A3c, and still every kind other than VERIFIED_EMAIL). This module
 * has no insert/upsert writer of its own - see the module docstring for where
 * VERIFIED_EMAIL rows actually come from. PRIVACY: a fingerprint row is an
 * opaque HMAC digest; callers must not log it.
 */
export async function readAccountIdentityFingerprints(
  exec: Exec,
  userId: string,
  keyVersion: number = ACCOUNT_IDENTITY_KEY_VERSION,
): Promise<StoredAccountIdentityFingerprint[]> {
  const rows = (
    await exec.execute({
      sql: `SELECT * FROM account_identity_fingerprints
            WHERE user_id = ? AND key_version = ? ORDER BY fingerprint_kind`,
      args: [userId, keyVersion],
    })
  ).rows as unknown as Record<string, unknown>[];
  return rows.map(mapFingerprintRow);
}

/**
 * Remove one account's fingerprint of a given kind (and key generation),
 * a no-op if it has none. Used by the email-change transaction to revoke a
 * now-stale VERIFIED_EMAIL fingerprint atomically with the users.email
 * UPDATE (app/api/auth/me/route.ts) - a changed email must never leave
 * evidence for an address the account no longer controls. Deletion, unlike
 * creation, needs no verification-flow guard: removing evidence is always
 * safe, and this statement runs in the SAME batch as the email UPDATE so
 * there is no window where the address moved but the old fingerprint lingers.
 */
export function deleteAccountIdentityFingerprintStatement(
  userId: string,
  kind: AccountIdentityFingerprintKind,
  keyVersion: number = ACCOUNT_IDENTITY_KEY_VERSION,
): InStatement {
  return {
    sql: `DELETE FROM account_identity_fingerprints WHERE user_id = ? AND fingerprint_kind = ? AND key_version = ?`,
    args: [userId, kind, keyVersion],
  };
}
