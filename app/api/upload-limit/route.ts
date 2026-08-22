import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../lib/reports-db';
import { checkRate } from '../../../lib/rate-limit';
import { clientIpFrom } from '../../../lib/client-ip';
import { getSessionUser } from '../../../lib/auth-session';
import { getUploadLimitStatus } from '../../../lib/upload-limit';

/**
 * Display-only status for the "N/10 uploads today" / "Unlimited" UI (see
 * lib/upload-limit.ts's own header comment for the enforcement side, which
 * lives in app/api/reports/route.ts's POST handler — this route never
 * enforces anything itself). Deliberately NOT folded into /api/auth/me:
 * that route's response must never carry anything role-shaped (see its own
 * tests), and "unlimited" is exactly that for an admin account. A separate,
 * ordinary route with no such constraint is the smaller, cleaner change.
 *
 * Meaningless for an anonymous caller (no account to meter) — returns
 * authenticated: false rather than 401/404, since this route's existence
 * is not a secret the way /api/developer/* is.
 */

export async function GET(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) {
        return new NextResponse(JSON.stringify({ authenticated: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      const status = await getUploadLimitStatus(client, sessionUser.id, sessionUser.role === 'admin');
      return new NextResponse(JSON.stringify({ authenticated: true, ...status }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
