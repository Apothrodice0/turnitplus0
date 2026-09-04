import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";

/**
 * A3 — the email-verification challenge state machine (storage in
 * drizzle/0046_email_verification_challenges.sql).
 *
 * This module owns the CHALLENGE ONLY. The authoritative verified-email marker
 * is users.email_verified_at (added by drizzle/0046); the routes read/write it
 * directly. This module stays uncoupled from account-identity.
 *
 * TOKEN DISCIPLINE (identical to lib/auth-session.ts / device-passport
 * challenges):
 *   - 32 bytes (256 bits) of CSPRNG output, hex-encoded.
 *   - The RAW token is returned exactly once, to the caller, for the
 *     mail-delivery layer. It is NEVER stored and NEVER logged.
 *   - Only sha256(rawToken) — a 64-char lowercase hex digest — is persisted,
 *     and it is the verification lookup key.
 *
 * All TTL / cooldown / issuance bounds are APPLICATION CONSTANTS below, never
 * environment variables.
 */

type Exec = Pick<Client, "execute">;

/** Short bounded TTL for a verification link. Application constant — not env-configurable. */
export const EMAIL_VERIFICATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Minimum gap between two "send"/"resend" requests for one account. */
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

/** Bounded issuance per account within a rolling window (abuse ceiling on top of the cooldown). */
export const EMAIL_VERIFICATION_ISSUANCE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const EMAIL_VERIFICATION_MAX_ISSUANCE_PER_WINDOW = 5;

/** Raw token size. 32 bytes = 256 bits of entropy. */
export const EMAIL_VERIFICATION_TOKEN_BYTES = 32;

const TOKEN_HEX_PATTERN = /^[0-9a-f]{64}$/;

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/** sha256 (lowercase hex) of the raw token string — the exact value stored in token_digest. */
export function hashEmailVerificationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** True only for a syntactically well-formed raw token (64 lowercase hex chars). Cheap pre-check before any DB work. */
export function isWellFormedEmailVerificationToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_HEX_PATTERN.test(value);
}

export type GeneratedEmailVerificationChallenge = {
  id: string;
  /** Return ONLY to the mail-delivery layer. Never persist, never log. */
  rawToken: string;
  tokenDigest: string;
  createdAt: number;
  expiresAt: number;
};

/** Pure: mint a new challenge's identifiers + token. Does not touch the DB. */
export function generateEmailVerificationChallenge(now: number = Date.now()): GeneratedEmailVerificationChallenge {
  const rawToken = bytesToHex(randomBytes(EMAIL_VERIFICATION_TOKEN_BYTES));
  return {
    id: randomUUID(),
    rawToken,
    tokenDigest: hashEmailVerificationToken(rawToken),
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
    args: [challenge.id, userId, email, challenge.tokenDigest, challenge.createdAt, challenge.expiresAt],
  };
}

/**
 * Revoke every still-outstanding (not consumed, not revoked) challenge for an
 * account. Bulk — used atomically with a users.email UPDATE so an address
 * change invalidates every in-flight link in the same transaction. A no-op
 * when the account has none.
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
 * self-guard means a concurrent verify of the same token (whose own consume
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
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    consumedAt: n(row.consumed_at),
    revokedAt: n(row.revoked_at),
  };
}

/** Look up a challenge by the digest of a presented raw token. Null when nothing matches. */
export async function findEmailVerificationChallengeByToken(
  exec: Exec,
  rawToken: string,
): Promise<EmailVerificationChallengeRow | null> {
  const digest = hashEmailVerificationToken(rawToken);
  const row = (
    await exec.execute({
      sql: `SELECT id, user_id, email, created_at, expires_at, consumed_at, revoked_at
              FROM email_verification_challenges WHERE token_digest = ?`,
      args: [digest],
    })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/** The account's most recent challenge (any state), for the resend-cooldown check. */
export async function mostRecentEmailVerificationChallenge(
  exec: Exec,
  userId: string,
): Promise<EmailVerificationChallengeRow | null> {
  const row = (
    await exec.execute({
      sql: `SELECT id, user_id, email, created_at, expires_at, consumed_at, revoked_at
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
// Failure classification (for a token holder's own helpful error message)
// ---------------------------------------------------------------------------

export type EmailVerificationRejectReason =
  | "MALFORMED"        // token isn't 64 hex chars — never hit the DB
  | "UNKNOWN"          // no challenge with this digest
  | "REVOKED"          // invalidated (e.g. the account's email changed)
  | "CONSUMED"         // already used
  | "EXPIRED"          // past its TTL
  | "EMAIL_CHANGED";   // challenge's target address no longer matches the account's current email

/**
 * Classify why a found challenge cannot verify. `currentEmail` is the account's
 * CURRENT users.email (lowercased). Returns null when the challenge is good to
 * consume. Order matters: revoked/consumed/expired are reported ahead of the
 * email-state mismatch so the most specific actionable message wins.
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
