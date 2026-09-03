import type { Client } from "@libsql/client";
import { checkRate } from "./rate-limit";
import { clientIpFrom } from "./client-ip";
import { getSessionUser, parseCookie, SESSION_COOKIE_NAME, type SessionUser } from "./auth-session";
import { isSameOriginRequest } from "./same-origin";
import { isE8sReuseContextAllowlisted } from "./e8s-visibility";
import { reuseContextSessionKey } from "./reuse-context-action-ref";

/**
 * The two-phase front door for every reuse-context mutation route
 * (declare / withdraw / revoke / confirm / reject). Kept as two calls,
 * NOT one, so each route runs the reviewed security-checkpoint order:
 *
 *   1. checkRate                          (guardReuseContextRequest)
 *   2. isSameOriginRequest (fail-closed)  (guardReuseContextRequest)
 *   3. JSON parse + bounded body validation   <-- done in the route, no DB/session
 *   4. session AND raw session cookie     (resolveReuseContextSession)
 *   5. E8S allowlist                      (resolveReuseContextSession)
 *   6. session-bound action-ref key       (resolveReuseContextSession)
 *   7. business resolution / mutation         <-- route
 *
 * A missing/foreign Origin is the feature's generic hidden 404 (committed in
 * 67c49a0) and is rejected BEFORE the body is read. Same-origin malformed
 * JSON therefore reaches the route's own 400 path. An unauthenticated
 * request with a valid body still gets the existing 401; a non-allowlisted
 * one still gets the existing generic 404.
 *
 * The raw session token is consumed only inside resolveReuseContextSession
 * and never leaves it — only its hash (via reuseContextSessionKey ->
 * hashToken) flows onward, and no caller places that in a response or log.
 */

const HIDDEN_404 = { status: 404, body: { error: "Not found." } } as const;

export type ReuseContextRequestGuard =
  | { ok: false; status: number; body: Record<string, unknown>; headers?: Record<string, string> }
  | { ok: true };

/** Phase 1: rate limit + same-origin. Runs before any body read. */
export async function guardReuseContextRequest(request: Request): Promise<ReuseContextRequestGuard> {
  const rate = await checkRate(clientIpFrom(request));
  if (!rate.allowed) {
    return { ok: false, status: 429, body: { error: "Too many requests" }, headers: { "Retry-After": String(rate.retryAfter) } };
  }
  if (!isSameOriginRequest(request)) {
    return { ok: false, ...HIDDEN_404 };
  }
  return { ok: true };
}

export type ReuseContextSessionGuard =
  | { ok: false; status: number; body: Record<string, unknown> }
  | { ok: true; sessionUser: SessionUser; sessionKey: string };

/** Phase 2: session + raw cookie, allowlist, session-key. Runs AFTER body validation. */
export async function resolveReuseContextSession(request: Request, client: Client): Promise<ReuseContextSessionGuard> {
  const rawToken = parseCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  const sessionUser = await getSessionUser(request, client);
  if (!sessionUser || !rawToken) {
    return { ok: false, status: 401, body: { error: "Not signed in." } };
  }
  if (!isE8sReuseContextAllowlisted(sessionUser.id)) {
    return { ok: false, ...HIDDEN_404 };
  }
  const sessionKey = reuseContextSessionKey(rawToken, true);
  if (!sessionKey) {
    return { ok: false, status: 401, body: { error: "Not signed in." } };
  }
  return { ok: true, sessionUser, sessionKey };
}

/** Standard JSON response for a reuse-context route, always no-store. */
export function reuseContextJson(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(extraHeaders ?? {}) },
  });
}
