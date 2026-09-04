import { randomBytes, createHash } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import type { NextResponse } from "next/server";

export const SESSION_COOKIE_NAME = "tp_session_v1";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Requests are handled as plain Request objects (not NextRequest) throughout
 * this app's API routes, so existing tests can import and call route
 * handlers directly without a Next.js server. That means incoming cookies
 * must be parsed from the raw Cookie header rather than a NextRequest's
 * .cookies helper.
 */
export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

/**
 * SHA-256 (hex) of a raw session token — the exact value stored in
 * sessions.token_hash. Exported so lib/device-passport-server.ts can bind a
 * device-passport challenge to the issuing browser session server-side
 * (challenge.session_token_hash), computed the identical way, without
 * re-implementing the hash.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Hex, not base64url: @cloudflare/workers-types (included alongside
// @types/node for this project's Vite/Workers build path) declares
// `declare const Buffer: any`, which shadows @types/node's Buffer and
// breaks Buffer.prototype.toString(encoding)'s typed overload. Hex is
// equally URL-safe for a cookie value and sidesteps the issue — see
// lib/auth-crypto.ts for the same workaround, applied there too.
function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export type UserRole = "user" | "admin";

export type SessionUser = {
  id: string;
  username: string;
  email: string;
  /**
   * Product decision: cross-account TurnitPlus corpus checking (both
   * lookup and corpus-admission eligibility) is mandatory for every
   * authenticated account — no per-account preference can disable it.
   * Always `true` for a resolved session; users.corpus_reuse_consented_at
   * is no longer read here (see db/schema.ts's own comment on that column,
   * now a vestigial historical timestamp). Kept as a field (rather than
   * removed) so existing callers — app/api/reports/route.ts's admission-
   * job creation, app/api/auth/me's GET response — need no shape change,
   * even though its value can no longer vary.
   */
  corpusReuseConsented: boolean;
  /**
   * Developer/admin authorization: read fresh from users.role on every
   * session lookup, never cached in the session token/cookie itself — a
   * revoked admin loses developer-dashboard access on their very next
   * request, not just their next login. See lib/admin-role.ts for the only
   * place a row's role is ever changed.
   */
  role: UserRole;
};

function toUserRole(value: string): UserRole {
  return value === "admin" ? "admin" : "user";
}

export async function createSession(client: Client, userId: string): Promise<string> {
  const token = bytesToHex(randomBytes(32));
  await client.execute(sessionInsertStatement(token, userId));
  return token;
}

/** A fresh session token plus the INSERT that persists it — for atomic account creation (client.batch). */
export function newSession(userId: string, now: number = Date.now()): { token: string; statement: InStatement } {
  const token = bytesToHex(randomBytes(32));
  return { token, statement: sessionInsertStatement(token, userId, now) };
}

function sessionInsertStatement(token: string, userId: string, now: number = Date.now()): InStatement {
  return {
    sql: "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
    args: [hashToken(token), userId, now, now + SESSION_TTL_MS],
  };
}

export async function destroySessionByToken(client: Client, token: string): Promise<void> {
  await client.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [hashToken(token)] });
}

// Split out from getSessionUser so Server Components (which read cookies via
// next/headers, not a Request object) can resolve a session without needing
// to fabricate a fake Request. getSessionUser below is now a thin wrapper
// kept for the existing Request-based route handlers/tests.
export async function getSessionUserByToken(token: string | null, client: Client): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const result = await client.execute({
    sql: `SELECT sessions.expires_at as expires_at, users.id as id, users.username as username, users.email as email, users.role as role
          FROM sessions JOIN users ON users.id = sessions.user_id
          WHERE sessions.token_hash = ?`,
    args: [tokenHash],
  });
  const row = result.rows[0] as unknown as
    | { expires_at: number | bigint; id: string; username: string; email: string; role: string }
    | undefined;
  if (!row) return null;
  if (Number(row.expires_at) <= Date.now()) {
    await client.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [tokenHash] });
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    // See the SessionUser type's own comment: mandatory, not read from the
    // users row any more.
    corpusReuseConsented: true,
    role: toUserRole(row.role),
  };
}

export async function getSessionUser(request: Request, client: Client): Promise<SessionUser | null> {
  return getSessionUserByToken(parseCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME), client);
}

/**
 * Developer/admin authorization gate for Route Handlers. Returns null for
 * both "not signed in" and "signed in but not an admin" — every
 * /api/developer/* route treats those two cases identically (a plain 404,
 * never a 401/403 that would confirm the route exists to a non-admin
 * caller), so callers never need to branch on which one happened.
 */
export async function getAdminSessionUser(request: Request, client: Client): Promise<SessionUser | null> {
  const user = await getSessionUser(request, client);
  return user?.role === "admin" ? user : null;
}

/** Same gate as getAdminSessionUser, for Server Components resolving a session from a raw cookie token (see getSessionUserByToken's own comment). */
export async function getAdminSessionUserByToken(token: string | null, client: Client): Promise<SessionUser | null> {
  const user = await getSessionUserByToken(token, client);
  return user?.role === "admin" ? user : null;
}

/** Sets the session cookie on an outgoing NextResponse. remember=false yields a browser-session-only cookie (no Max-Age). */
export function setSessionCookie(response: NextResponse, token: string, remember: boolean): void {
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    ...(remember ? { maxAge: 30 * 24 * 60 * 60 } : {}),
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * One-time, best-effort migration of a device's pre-existing anonymous
 * reports onto a real account, run on every signup/login. Idempotent (a
 * repeat login matches nothing new) and can never take rows already claimed
 * by a different user (the user_id IS NULL guard).
 *
 * Also invalidates the historical-match snapshot of every report it claims.
 * report_historical_match_snapshots is keyed on (report_device_key,
 * report_id) only, never on the requester account, and a snapshot computed
 * while the report was anonymous ran a BROADER search than the one that
 * report is now entitled to as an owned report: matchAgainstUserSubmissionCorpus's
 * own-account exclusion (excludeAccountId, lib/report-primary-similarity.ts)
 * only engages once the report has an owning account, so an anonymous
 * MATCHED could reference a promoted representation that is backed solely by
 * THIS account's own admission(s) — which must be excluded as same-account
 * the moment the report becomes theirs (lib/user-submission-corpus.ts's
 * admissionEligibilitySql). Dropping the snapshot forces the next view to
 * recompute under the new owner's own exclusion context. A raw DELETE here
 * (rather than importing lib/report-historical-match.ts's own
 * deleteHistoricalMatchSnapshot) keeps this module free of that file's
 * matcher import chain — the same boundary lib/corpus-source-matching-flag.ts
 * exists to preserve. Scoped to the rows this call is about to claim
 * (user_id IS NULL for this device_key); a still-anonymous report whose
 * snapshot is dropped by a failed claim simply recomputes to the identical
 * anonymous result on next view, so ordering is not load-bearing.
 */
export async function claimAnonymousReports(client: Client, userId: string, deviceKey: unknown): Promise<void> {
  if (typeof deviceKey !== "string" || deviceKey.trim().length === 0) return;
  try {
    await client.execute({
      sql: `DELETE FROM report_historical_match_snapshots
            WHERE report_device_key = ?
              AND report_id IN (SELECT id FROM saved_reports WHERE device_key = ? AND user_id IS NULL)`,
      args: [deviceKey, deviceKey],
    });
    await client.execute({
      sql: "UPDATE saved_reports SET user_id = ? WHERE device_key = ? AND user_id IS NULL",
      args: [userId, deviceKey],
    });
  } catch (err) {
    console.error("claimAnonymousReports failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}
