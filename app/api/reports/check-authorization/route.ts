import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getSessionUser } from '../../../../lib/auth-session';
import { isCrossOriginBrowserRequest, CROSS_ORIGIN_REJECTED } from '../../../../lib/same-origin';
import { issueCheckAuthorization, isSha256Hex } from '../../../../lib/account-entitlements';

/**
 * Manual account activation — issue a CHECK AUTHORIZATION when the room page starts a check (see
 * lib/account-entitlements.ts). Body: { room, textSha256 } where textSha256 is the SHA-256 (hex) of the manuscript's
 * canonical text (lib/canonical-text.ts) — the text itself is never sent here.
 *
 *  - 200 { required: false }                  activation is not enforced for this account (feature off, or admin)
 *  - 200 { required: true, authorization, expiresAt }   plan active, room free: one single-use authorization
 *  - 403 { code, error }                      no active plan / room outside the plan (the check is refused up front)
 *  - 409 { code: 'ROOM_COOLING_DOWN', availableAt }    the room is still in its 24 h cycle
 *  - 401 signed out; 403 cross-site; 429 rate limited
 *
 * It grants nothing by itself: the save (POST /api/reports) still applies every rule, and consults the authorization
 * only when the plan expired after it was issued.
 */
function json(body: unknown, status: number, extraHeaders?: Record<string, string>): NextResponse {
  return new NextResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders } });
}

export async function POST(request: Request) {
  try {
    if (isCrossOriginBrowserRequest(request)) return json(CROSS_ORIGIN_REJECTED, 403);
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) return json({ error: 'Too many requests' }, 429, { 'Retry-After': String(rate.retryAfter) });

    const body = (await request.json().catch(() => null)) as { room?: unknown; textSha256?: unknown } | null;
    if (!body || !Number.isInteger(body.room) || (body.room as number) < 0 || !isSha256Hex(body.textSha256)) {
      return json({ error: 'room (integer) and textSha256 (hex) are required' }, 400);
    }

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) return json({ error: 'Log in to start a check.' }, 401);
      const issued = await issueCheckAuthorization(client, sessionUser, body.room as number, body.textSha256, () =>
        Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join(''),
      );
      switch (issued.kind) {
        case 'not_required':
          return json({ required: false }, 200);
        case 'blocked':
          return json({ error: issued.message, code: issued.code }, 403);
        case 'busy':
          return json({ error: `This room is in its 24-hour cooldown until ${new Date(issued.availableAt).toISOString()}.`, code: 'ROOM_COOLING_DOWN', availableAt: new Date(issued.availableAt).toISOString() }, 409);
        case 'issued':
          return json({ required: true, authorization: issued.id, expiresAt: new Date(issued.expiresAt).toISOString() }, 200);
      }
    } finally {
      client.close();
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
}
