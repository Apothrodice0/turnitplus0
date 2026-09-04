import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { accountIdentityFingerprint, ACCOUNT_IDENTITY_KEY_VERSION } from "./account-identity";

/**
 * A3 / A3b / A3c — the email-verification challenge state machine (storage in
 * drizzle/0046_email_verification_challenges.sql).
 *
 * This module owns the CHALLENGE. The authoritative verified-email marker is
 * users.email_verified_at (added by drizzle/0046); the routes read/write it
 * directly. A3c additionally lets a successful consume write ONE piece of
 * downstream identity evidence — a VERIFIED_EMAIL row in
 * account_identity_fingerprints (drizzle/0045, reused unchanged) — via
 * verifiedEmailFingerprintForChallenge / upsertVerifiedEmailFingerprintIfChallengeConsumedStatement
 * below. That is the ONLY account-identity coupling this module has: it calls
 * lib/account-identity.ts's existing keyed-HMAC contract (accountIdentityFingerprint)
 * and never computes a digest itself, never touches account_identity_profiles,
 * and the fingerprint stays ACCOUNT_ONLY evidence (lib/account-identity.ts
 * ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING) — this module does not
 * interpret it as ownership.
 *
 * A3b changed the challenge from a 256-bit link token to a 6-digit numeric
 * code (see generateEmailVerificationChallenge / hashEmailVerificationCode
 * below for why that also changes how the digest and the verify lookup work).
 * The storage column is still named token_digest (reused from A3, no
 * migration) even though it now holds a code digest.
 *
 * All TTL / cooldown / issuance bounds are APPLICATION CONSTANTS below, never
 * environment variables.
 */

type Exec = Pick<Client, "execute">;

/** Short bounded TTL for a verification code. Application constant — not env-configurable. */
export const EMAIL_VERIFICATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Minimum gap between two "send"/"resend" requests for one account. */
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

/** Bounded issuance per account within a rolling window (abuse ceiling on top of the cooldown). */
export const EMAIL_VERIFICATION_ISSUANCE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const EMAIL_VERIFICATION_MAX_ISSUANCE_PER_WINDOW = 5;

/** Every code is exactly this many decimal digits, zero-padded. */
export const EMAIL_VERIFICATION_CODE_LENGTH = 6;

const CODE_PATTERN = /^\d{6}$/;

/** True only for a syntactically well-formed code (exactly 6 decimal digits). Cheap pre-check before any DB work. */
export function isWellFormedEmailVerificationCode(value: unknown): value is string {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

/**
 * CSPRNG-uniform 6-digit code, 000000-999999, zero-padded. node:crypto's
 * randomInt is rejection-sampled over randomBytes internally, so this has no
 * modulo bias (unlike `randomBytes(n) % 1_000_000`).
 */
function generateRawCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(EMAIL_VERIFICATION_CODE_LENGTH, "0");
}

/** True when EMAIL_VERIFICATION_CODE_SECRET is set. Gates challenge issuance the same way usersHaveEmailVerifiedAtColumn gates on migration 0046 — see its own comment. */
export function emailVerificationCodeSecretConfigured(): boolean {
  const secret = process.env.EMAIL_VERIFICATION_CODE_SECRET;
  return typeof secret === "string" && secret.length > 0;
}

/**
 * Keyed HMAC-SHA256 digest of a challenge's code — deliberately NOT a bare
 * SHA-256 hash. A 6-digit code has only ~20 bits of entropy (1e6
 * possibilities): a bare hash of the code alone would be brute-forceable
 * offline in a fraction of a second if the database were ever exfiltrated.
 * Keying with a dedicated server secret (EMAIL_VERIFICATION_CODE_SECRET,
 * never itself stored in the database) makes that infeasible without also
 * exfiltrating the secret.
 *
 * The challenge id (a random UUID) is mixed into the HMAC input alongside the
 * code, not the code alone. token_digest carries a UNIQUE index
 * (drizzle/0046) that a global code-only digest could collide on: at 6-digit
 * entropy, ~1,200 concurrently outstanding codes already cross the 50%
 * birthday-collision mark, and two different accounts issued the identical
 * code at the same time is realistic at any real scale. Mixing in the
 * (unique, random) challenge id makes the digest practically unique per row
 * regardless of code collisions, so the UNIQUE index never spuriously
 * rejects a legitimate concurrent issuance.
 *
 * Throws when the secret is not configured — callers MUST check
 * emailVerificationCodeSecretConfigured() first and treat "not configured"
 * as "verification unavailable" (fail closed), exactly like the
 * usersHaveEmailVerifiedAtColumn() deploy-ordering gate.
 */
export function hashEmailVerificationCode(challengeId: string, rawCode: string): string {
  const secret = process.env.EMAIL_VERIFICATION_CODE_SECRET;
  if (!secret) throw new Error("EMAIL_VERIFICATION_CODE_SECRET is not configured");
  return createHmac("sha256", secret).update(`${challengeId}:${rawCode}`, "utf8").digest("hex");
}

/**
 * Constant-time check of a presented code against a challenge's stored
 * digest. Recomputes the keyed HMAC (over challengeId:rawCode, see
 * hashEmailVerificationCode) and compares with timingSafeEqual rather than
 * `===`, matching this codebase's convention for secret comparison (see
 * lib/auth-crypto.ts's password verification).
 */
export function emailVerificationCodeMatches(challengeId: string, rawCode: string, storedDigest: string): boolean {
  const expected = hashEmailVerificationCode(challengeId, rawCode);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(storedDigest, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type GeneratedEmailVerificationChallenge = {
  id: string;
  /** Return ONLY to the mail-delivery layer. Never persist, never log. */
  rawCode: string;
  codeDigest: string;
  createdAt: number;
  expiresAt: number;
};

/**
 * Pure: mint a new challenge's identifiers + code. Does not touch the DB.
 * Throws if EMAIL_VERIFICATION_CODE_SECRET is not configured (see
 * hashEmailVerificationCode) — callers must gate on
 * emailVerificationCodeSecretConfigured() first.
 */
export function generateEmailVerificationChallenge(now: number = Date.now()): GeneratedEmailVerificationChallenge {
  const id = randomUUID();
  const rawCode = generateRawCode();
  return {
    id,
    rawCode,
    codeDigest: hashEmailVerificationCode(id, rawCode),
    createdAt: now,
    expiresAt: now + EMAIL_VERIFICATION_TTL_MS,
  };
}

// ---------------------------------------------------------------------------
// Statement builders (so callers can compose them into an atomic client.batch)
// ---------------------------------------------------------------------------

/** INSERT one already-generated challenge for `userId` proving control of `email` (lowercased). */
export function emailVerificationChallengeInsertStatement(
  challenge: GeneratedEmailVerificationChallenge,
  userId: string,
  email: string,
): InStatement {
  return {
    sql: `INSERT INTO email_verification_challenges
            (id, user_id, email, token_digest, created_at, expires_at, consumed_at, revoked_at)
          VALUES (?,?,?,?,?,?,NULL,NULL)`,
    args: [challenge.id, userId, email, challenge.codeDigest, challenge.createdAt, challenge.expiresAt],
  };
}

/**
 * Revoke every still-outstanding (not consumed, not revoked) challenge for an
 * account. Bulk — used atomically with a users.email UPDATE so an address
 * change invalidates every in-flight code in the same transaction, and by a
 * resend so only the latest code is ever live. A no-op when the account has
 * none.
 */
export function revokeOutstandingEmailVerificationChallengesStatement(
  userId: string,
  now: number = Date.now(),
): InStatement {
  return {
    sql: `UPDATE email_verification_challenges
             SET revoked_at = ?
           WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    args: [now, userId],
  };
}

/**
 * Revoke ONE specific challenge by its id (still-outstanding only). Used when a
 * just-issued challenge could not be delivered — precise, so it can never
 * revoke a different (e.g. newer, concurrently-issued) challenge for the same
 * account the way the bulk revoke above could.
 */
export function revokeEmailVerificationChallengeByIdStatement(
  challengeId: string,
  now: number = Date.now(),
): InStatement {
  return {
    sql: `UPDATE email_verification_challenges
             SET revoked_at = ?
           WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    args: [now, challengeId],
  };
}

/**
 * The single-use, race-safe consume. Only flips consumed_at when the challenge
 * is genuinely still verifiable RIGHT NOW (not consumed, not revoked, not
 * expired). The caller MUST check rowsAffected === 1 — two concurrent verifies
 * cannot both see 1 (libSQL serialises writes to the row).
 */
export function consumeEmailVerificationChallengeStatement(
  challengeId: string,
  now: number = Date.now(),
): InStatement {
  return {
    sql: `UPDATE email_verification_challenges
             SET consumed_at = ?
           WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    args: [now, challengeId, now],
  };
}

// ---------------------------------------------------------------------------
// users.email_verified_at — THE authoritative email-verified marker (A3).
// account_identity_profiles.email_verified_at is deprecated/vestigial: never
// read, never written. See drizzle/0046 header.
// ---------------------------------------------------------------------------

/**
 * Set users.email_verified_at, but ONLY when `challengeId` was just consumed at
 * exactly `verifiedAt`. Pair this in ONE client.batch with
 * consumeEmailVerificationChallengeStatement(challengeId, verifiedAt): the
 * self-guard means a concurrent verify of the same code (whose own consume
 * failed) can never also flip the marker, without needing a read-back
 * mid-transaction.
 */
export function setUserEmailVerifiedIfChallengeConsumedStatement(
  userId: string,
  challengeId: string,
  verifiedAt: number,
): InStatement {
  return {
    sql: `UPDATE users
             SET email_verified_at = ?
           WHERE id = ?
             AND EXISTS (SELECT 1 FROM email_verification_challenges WHERE id = ? AND consumed_at = ?)`,
    args: [verifiedAt, userId, challengeId, verifiedAt],
  };
}

/** Clear users.email_verified_at back to NULL. Used atomically with a users.email change. */
export function clearUserEmailVerifiedStatement(userId: string): InStatement {
  return { sql: `UPDATE users SET email_verified_at = NULL WHERE id = ?`, args: [userId] };
}

// ---------------------------------------------------------------------------
// account_identity_fingerprints (VERIFIED_EMAIL) — A3c.
// ---------------------------------------------------------------------------

/**
 * The VERIFIED_EMAIL identity fingerprint for `normalizedEmail` (already
 * lowercased/trimmed by the caller with this codebase's usual
 * `.trim().toLowerCase()` convention). A thin wrapper around
 * lib/account-identity.ts's accountIdentityFingerprint so callers of this
 * module never need their own account-identity import (see the module
 * docstring, and tests/account-identity.test.mjs's app/ import allowlist).
 *
 * FAILS CLOSED: returns null when ACCOUNT_IDENTITY_HMAC_KEY is not
 * configured (the only way it can be null here, since kind is always the
 * literal 'VERIFIED_EMAIL' and verified is always true). Callers MUST treat
 * null as "identity evidence unavailable" and refuse to verify at all —
 * never consume the challenge or set users.email_verified_at without also
 * being able to persist this fingerprint in the same transaction.
 */
export function verifiedEmailFingerprintForChallenge(normalizedEmail: string): string | null {
  return accountIdentityFingerprint("VERIFIED_EMAIL", normalizedEmail, { verified: true });
}

/**
 * Upsert this account's VERIFIED_EMAIL fingerprint, but ONLY when
 * `challengeId` was just consumed at exactly `verifiedAt` — the same
 * self-guard as setUserEmailVerifiedIfChallengeConsumedStatement above, so
 * this belongs in the SAME client.batch as the consume statement (see
 * verify/route.ts). A losing concurrent verify of the same challenge (whose
 * own consume affected 0 rows) can therefore never also write or restamp
 * this fingerprint.
 *
 * `fingerprint` must already be the value of verifiedEmailFingerprintForChallenge
 * — this function does no hashing and never sees a raw email. One row per
 * (account, VERIFIED_EMAIL, key version): a second verification of the same
 * still-current email (e.g. a re-requested code) updates the existing row in
 * place rather than duplicating it, via the same ON CONFLICT target as
 * lib/account-identity-repo.ts's accountIdentityProfileUpsertStatement.
 */
export function upsertVerifiedEmailFingerprintIfChallengeConsumedStatement(
  fingerprintId: string,
  userId: string,
  fingerprint: string,
  challengeId: string,
  verifiedAt: number,
): InStatement {
  return {
    sql: `INSERT INTO account_identity_fingerprints
            (id, user_id, fingerprint_kind, fingerprint, key_version, source_verified_at, created_at)
          SELECT ?, ?, 'VERIFIED_EMAIL', ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM email_verification_challenges WHERE id = ? AND consumed_at = ?
           )
          ON CONFLICT (user_id, fingerprint_kind, key_version) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            source_verified_at = excluded.source_verified_at,
            created_at = excluded.created_at`,
    args: [
      fingerprintId,
      userId,
      fingerprint,
      ACCOUNT_IDENTITY_KEY_VERSION,
      verifiedAt,
      verifiedAt,
      challengeId,
      verifiedAt,
    ],
  };
}

/**
 * Deploy-ordering safety: A3 code can reach an environment where migration 0046
 * has NOT yet added users.email_verified_at (and the email_verification_challenges
 * table). Every route that reads/writes email-verification state calls this
 * first so it degrades gracefully — treating an account as "unverified" and
 * skipping the challenge / clear writes — instead of throwing "no such column".
 *
 * Cached once the column is seen (columns are never dropped in this schema);
 * while absent it is re-checked on every call, so the code self-heals the
 * instant 0046 is applied without a redeploy. The column and the challenge
 * table are added by the SAME migration, so this one check gates both.
 */
let usersEmailVerifiedAtColumnKnownPresent = false;
export async function usersHaveEmailVerifiedAtColumn(exec: Exec): Promise<boolean> {
  if (usersEmailVerifiedAtColumnKnownPresent) return true;
  try {
    const info = await exec.execute("PRAGMA table_info('users')");
    const present = info.rows.some((r) => String((r as { name?: unknown }).name) === "email_verified_at");
    if (present) usersEmailVerifiedAtColumnKnownPresent = true;
    return present;
  } catch {
    return false;
  }
}

/** TEST ONLY — forget the cached column-presence result so a test can exercise both schema states. */
export function __resetUsersEmailVerifiedAtColumnCacheForTest(): void {
  usersEmailVerifiedAtColumnKnownPresent = false;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type EmailVerificationChallengeRow = {
  id: string;
  userId: string;
  email: string;
  codeDigest: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
};

function mapRow(row: Record<string, unknown>): EmailVerificationChallengeRow {
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: String(row.id),
    userId: String(row.user_id),
    email: String(row.email),
    codeDigest: String(row.token_digest),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    consumedAt: n(row.consumed_at),
    revokedAt: n(row.revoked_at),
  };
}

/**
 * The account's most recent challenge (any state) — used both for the
 * resend-cooldown check and as the verify route's lookup (A3b: verify no
 * longer looks a challenge up by a global digest, since a 6-digit code's
 * digest is only unique per-row, not a safe global lookup key by itself — see
 * hashEmailVerificationCode. Instead it requires a session and asks "does
 * THIS account's current challenge match the code they typed", which is also
 * exactly what makes it impossible for one account to verify another's
 * challenge).
 */
export async function mostRecentEmailVerificationChallenge(
  exec: Exec,
  userId: string,
): Promise<EmailVerificationChallengeRow | null> {
  const row = (
    await exec.execute({
      sql: `SELECT id, user_id, email, token_digest, created_at, expires_at, consumed_at, revoked_at
              FROM email_verification_challenges
             WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      args: [userId],
    })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/** How many challenges this account has been issued since `sinceMs` — the bounded-issuance check. */
export async function countEmailVerificationChallengesSince(
  exec: Exec,
  userId: string,
  sinceMs: number,
): Promise<number> {
  const row = (
    await exec.execute({
      sql: `SELECT COUNT(*) AS c FROM email_verification_challenges WHERE user_id = ? AND created_at >= ?`,
      args: [userId, sinceMs],
    })
  ).rows[0] as unknown as { c: number | bigint } | undefined;
  return row ? Number(row.c) : 0;
}

// ---------------------------------------------------------------------------
// Failure classification (for a code holder's own helpful error message)
// ---------------------------------------------------------------------------

export type EmailVerificationRejectReason =
  | "MALFORMED"        // code isn't exactly 6 digits — never hit the DB
  | "UNKNOWN"          // this account has no challenge at all (never requested a code)
  | "REVOKED"          // invalidated (e.g. the account's email changed, or a resend superseded it)
  | "CONSUMED"         // already used
  | "EXPIRED"          // past its TTL
  | "EMAIL_CHANGED"    // challenge's target address no longer matches the account's current email
  | "WRONG_CODE";      // the challenge is otherwise live, but the presented code doesn't match it

/**
 * Classify why a found challenge cannot verify. `currentEmail` is the account's
 * CURRENT users.email (lowercased). Returns null when the challenge is good to
 * consume. Order matters: revoked/consumed/expired are reported ahead of the
 * email-state mismatch so the most specific actionable message wins. Does NOT
 * check the code itself — callers compare it separately with
 * emailVerificationCodeMatches once a challenge classifies as null here.
 */
export function classifyEmailVerificationChallenge(
  challenge: EmailVerificationChallengeRow,
  currentEmail: string,
  now: number = Date.now(),
): EmailVerificationRejectReason | null {
  if (challenge.revokedAt != null) return "REVOKED";
  if (challenge.consumedAt != null) return "CONSUMED";
  if (challenge.expiresAt <= now) return "EXPIRED";
  if (challenge.email.trim().toLowerCase() !== currentEmail.trim().toLowerCase()) return "EMAIL_CHANGED";
  return null;
}

/** Opportunistic cleanup of long-dead rows — piggybacked on ordinary traffic (this app has no cron). */
export async function pruneExpiredEmailVerificationChallenges(
  exec: Exec,
  olderThanMs: number,
  limit = 200,
): Promise<void> {
  await exec.execute({
    sql: `DELETE FROM email_verification_challenges
           WHERE id IN (
             SELECT id FROM email_verification_challenges
              WHERE expires_at < ? AND (consumed_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < ?)
              LIMIT ?
           )`,
    args: [olderThanMs, olderThanMs, limit],
  });
}
