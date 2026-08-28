import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { isSameOriginRequest } from '../../../../lib/same-origin';
import { getSessionUser, parseCookie, hashToken, SESSION_COOKIE_NAME } from '../../../../lib/auth-session';
import {
  isDevicePassportEnabled,
  createDevicePassportChallenge,
  maybeCleanupExpiredDevicePassportChallenges,
} from '../../../../lib/device-passport-server';

/**
 * Device Passport — Phase 2. POST /api/device-passport/challenge: issues one
 * single-use, 120-second, replay-resistant challenge bound SERVER-SIDE to
 * the current session/account context. Only sha256(nonce) is stored; the raw
 * nonce is returned exactly once.
 *
 * The browser never handles a session secret: account_id / session_token_hash
 * are resolved here, server-side, from the session cookie, and stored on the
 * challenge row. Verification (POST /api/reports) re-resolves the CURRENT
 * request's session and requires it to match the challenge's binding in both
 * directions. The response exposes no session hash and no binding metadata —
 * only { challengeId, nonce }.
 *
 * Fails closed / inert when DEVICE_PASSPORT_ENABLED is not "true" (generic
 * 404) and for a cross-origin request.
 */

export const dynamic = 'force-dynamic';

function notFound() {
  return new NextResponse(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

export async function POST(request: Request) {
  try {
    if (!isDevicePassportEnabled()) return notFound();
    if (!isSameOriginRequest(request)) return notFound();

    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const client = await getReportsDbClient();
    try {
      const rawToken = parseCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME);
      const sessionUser = await getSessionUser(request, client);
      // sessionTokenHash is bound only when there is a VALID session — a
      // present-but-invalid/expired cookie is treated as anonymous, exactly
      // as verification will.
      const sessionTokenHash = sessionUser && rawToken ? hashToken(rawToken) : null;

      const { challengeId, nonce } = await createDevicePassportChallenge(client, {
        accountId: sessionUser ? sessionUser.id : null,
        sessionTokenHash,
      });

      await maybeCleanupExpiredDevicePassportChallenges(client);

      return new NextResponse(JSON.stringify({ challengeId, nonce }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
