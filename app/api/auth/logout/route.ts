import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkLogoutRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import {
  SESSION_COOKIE_NAME,
  parseCookie,
  destroySessionByToken,
  clearSessionCookie,
  isWellFormedSessionToken,
} from '../../../../lib/auth-session';

// Truthful sign-out (security fix). This route used to answer {ok:true} and
// expire the cookie from a catch-all, so a failed session DELETE left the
// server session valid for 30 days while the browser lost the only cookie
// that could ever revoke it. Now:
//   - 200 {ok:true, revoked:true}  — a live session row was deleted;
//   - 200 {ok:true, revoked:false} — nothing live to revoke (no cookie on this
//     hostname, a malformed/unknown token, an already-expired row): the
//     browser is signed out either way, so this stays idempotent;
//   - 503 {ok:false} — the database failed or its outcome is unknown. The
//     cookie is deliberately NOT expired: it stays the handle a retry needs;
//   - 429 {ok:false} — only the dedicated logout bucket (lib/rate-limit.ts's
//     checkLogoutRate), never the general one dashboard traffic spends.
// Error bodies are fixed strings: no token, database detail or exception text.
//
// Limitation: the session cookie is host-only, so this can only ever see (and
// revoke) the session of the hostname the request was sent to, in the
// database that deployment is configured with — a sign-out on one Preview
// URL, the branch alias or Production never touches another's session.

// Bounds a hung database request so the browser gets a definite 503 instead
// of a platform timeout; the outcome is then unknown and reported as failure.
const LOGOUT_DB_TIMEOUT_MS = 10_000;

type LogoutOutcome = 'revoked' | 'no_active_session' | 'rate_limited' | 'failed';

const FAILED_MESSAGE = 'Sign-out could not be completed. Please try again.';

function json(body: { ok: boolean; revoked: boolean; outcome: LogoutOutcome; error?: string }, status: number, headers: Record<string, string> = {}) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function failed(stage: string, err: unknown) {
  console.error(`logout failed (${stage}):`, err instanceof Error ? err.message : String(err));
  return json({ ok: false, revoked: false, outcome: 'failed', error: FAILED_MESSAGE }, 503);
}

function signedOut(revoked: boolean) {
  const response = json({ ok: true, revoked, outcome: revoked ? 'revoked' : 'no_active_session' }, 200);
  clearSessionCookie(response);
  return response;
}

export async function POST(request: Request) {
  let rate;
  try {
    rate = await checkLogoutRate(clientIpFrom(request));
  } catch (err) {
    return failed('rate check', err);
  }
  if (!rate.allowed) {
    return json(
      { ok: false, revoked: false, outcome: 'rate_limited', error: 'Too many sign-out attempts. Please try again shortly.' },
      429,
      { 'Retry-After': String(rate.retryAfter) },
    );
  }

  const token = parseCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME);
  if (!isWellFormedSessionToken(token)) return signedOut(false);

  try {
    const client = await getReportsDbClient({ requestTimeoutMs: LOGOUT_DB_TIMEOUT_MS });
    try {
      const { revokedActive } = await destroySessionByToken(client, token);
      return signedOut(revokedActive);
    } finally {
      client.close();
    }
  } catch (err) {
    return failed('session delete', err);
  }
}
