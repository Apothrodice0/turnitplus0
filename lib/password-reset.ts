import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";

/**
 * CUSTOMER PASSWORD RECOVERY — tokens and their statements (drizzle/0054_password_reset_tokens.sql).
 *
 * A reset link carries a 256-bit CSPRNG token as lowercase hex. Only its SHA-256 digest is stored; the raw token is handed
 * to the mail layer and never logged or returned. A link is valid for PASSWORD_RESET_TTL_MS, once. Issuing a new link
 * revokes the account's earlier open links. Redemption, the password change, the revocation of every session of the
 * account and the revocation of its other open links happen in ONE batch, all guarded by a per-redemption random id.
 * Never shares tokens or tables with email verification.
 */
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
/** At most this many reset links per account per PASSWORD_RESET_WINDOW_MS (checked against stored rows). */
export const PASSWORD_RESET_MAX_PER_WINDOW = 3;
export const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;
/** The same password rule signup applies (app/api/auth/signup/route.ts). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function isWellFormedPasswordResetToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

export function passwordResetTokenDigest(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export type IssuedPasswordResetToken = { id: string; rawToken: string; digest: string; createdAt: number; expiresAt: number };

// Hex without Buffer#toString(encoding): the Workers type shadowing noted in lib/auth-session.ts applies here too.
function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

export function generatePasswordResetToken(now: number = Date.now()): IssuedPasswordResetToken {
  const rawToken = bytesToHex(randomBytes(32));
  return { id: randomUUID(), rawToken, digest: passwordResetTokenDigest(rawToken), createdAt: now, expiresAt: now + PASSWORD_RESET_TTL_MS };
}

/** Revoke the account's still-open links, then insert the new one (run both in one batch). */
export function issuePasswordResetTokenStatements(userId: string, token: IssuedPasswordResetToken): InStatement[] {
  return [
    { sql: "UPDATE password_reset_tokens SET revoked_at = ? WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL", args: [token.createdAt, userId] },
    { sql: "INSERT INTO password_reset_tokens (id, user_id, token_digest, created_at, expires_at) VALUES (?,?,?,?,?)", args: [token.id, userId, token.digest, token.createdAt, token.expiresAt] },
  ];
}

/** Revoke exactly one link by id — used when its email could not be delivered. */
export function revokePasswordResetTokenByIdStatement(id: string, now: number = Date.now()): InStatement {
  return { sql: "UPDATE password_reset_tokens SET revoked_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL", args: [now, id] };
}

export async function countRecentPasswordResetTokens(client: Client, userId: string, now: number = Date.now()): Promise<number> {
  const r = await client.execute({ sql: "SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ? AND created_at > ?", args: [userId, now - PASSWORD_RESET_WINDOW_MS] });
  return Number((r.rows[0] as unknown as { n: number | bigint }).n);
}

/**
 * The redemption batch. Statement 0 is the ONLY gate: it consumes the link iff it is still open and unexpired, and stamps
 * `redemptionId`. Statements 1-3 fire only for the row carrying that redemptionId, so if statement 0 changed nothing
 * (invalid, expired, already used, revoked, or lost a concurrent race) the batch changes nothing at all.
 */
export function redeemPasswordResetStatements(digest: string, newPasswordHash: string, redemptionId: string, now: number): InStatement[] {
  const owner = "(SELECT user_id FROM password_reset_tokens WHERE redemption_id = ?)";
  return [
    {
      sql: "UPDATE password_reset_tokens SET consumed_at = ?, redemption_id = ? WHERE token_digest = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
      args: [now, redemptionId, digest, now],
    },
    { sql: `UPDATE users SET password_hash = ? WHERE id = ${owner}`, args: [newPasswordHash, redemptionId] },
    { sql: `DELETE FROM sessions WHERE user_id = ${owner}`, args: [redemptionId] },
    { sql: `UPDATE password_reset_tokens SET revoked_at = ? WHERE user_id = ${owner} AND consumed_at IS NULL AND revoked_at IS NULL`, args: [now, redemptionId] },
  ];
}

export type PasswordResetLinkState = "VALID" | "INVALID" | "EXPIRED" | "USED";

/** Why a link cannot be (or could not be) redeemed — for the customer message only; never changes anything. */
export async function classifyPasswordResetToken(client: Client, digest: string, now: number = Date.now()): Promise<PasswordResetLinkState> {
  const r = await client.execute({ sql: "SELECT expires_at, consumed_at, revoked_at FROM password_reset_tokens WHERE token_digest = ?", args: [digest] });
  const row = r.rows[0] as unknown as { expires_at: number | bigint; consumed_at: number | bigint | null; revoked_at: number | bigint | null } | undefined;
  if (!row) return "INVALID";
  if (row.consumed_at !== null) return "USED";
  if (row.revoked_at !== null) return "INVALID";
  if (Number(row.expires_at) <= now) return "EXPIRED";
  return "VALID";
}

/** Deploy-ordering safety: the routes answer "not available" until migration 0054 is applied. */
export async function passwordResetTableExists(client: Client): Promise<boolean> {
  const r = await client.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'password_reset_tokens'", args: [] });
  return r.rows.length > 0;
}

export const PASSWORD_RESET_MESSAGES = {
  requested: "If an account exists for that email, we've sent a link to reset your password. It expires in 30 minutes. Check your inbox and spam folder.",
  unavailable: "Password reset by email is not available right now. Please try again later.",
  reset: "Your password has been changed. Sign in with your new password.",
  INVALID: "This reset link is not valid. Request a new link from the sign-in page.",
  EXPIRED: "This reset link has expired. Request a new link from the sign-in page.",
  USED: "This reset link has already been used. Request a new link if you still need to reset your password.",
} as const;
