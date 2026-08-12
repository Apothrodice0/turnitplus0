import { randomBytes, createHash } from "node:crypto";
import type { Client } from "@libsql/client";
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

function hashToken(token: string): string {
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

export type SessionUser = { id: string; username: string; email: string };

export async function createSession(client: Client, userId: string): Promise<string> {
  const token = bytesToHex(randomBytes(32));
  const now = Date.now();
  await client.execute({
    sql: "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
    args: [hashToken(token), userId, now, now + SESSION_TTL_MS],
  });
  return token;
}

export async function destroySessionByToken(client: Client, token: string): Promise<void> {
  await client.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [hashToken(token)] });
}

export async function getSessionUser(request: Request, client: Client): Promise<SessionUser | null> {
  const token = parseCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const result = await client.execute({
    sql: `SELECT sessions.expires_at as expires_at, users.id as id, users.username as username, users.email as email
          FROM sessions JOIN users ON users.id = sessions.user_id
          WHERE sessions.token_hash = ?`,
    args: [tokenHash],
  });
  const row = result.rows[0] as unknown as { expires_at: number | bigint; id: string; username: string; email: string } | undefined;
  if (!row) return null;
  if (Number(row.expires_at) <= Date.now()) {
    await client.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [tokenHash] });
    return null;
  }
  return { id: row.id, username: row.username, email: row.email };
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
 */
export async function claimAnonymousReports(client: Client, userId: string, deviceKey: unknown): Promise<void> {
  if (typeof deviceKey !== "string" || deviceKey.trim().length === 0) return;
  try {
    await client.execute({
      sql: "UPDATE saved_reports SET user_id = ? WHERE device_key = ? AND user_id IS NULL",
      args: [userId, deviceKey],
    });
  } catch (err) {
    console.error("claimAnonymousReports failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}
