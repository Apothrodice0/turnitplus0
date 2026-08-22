import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../lib/auth-session';
import { listRecentReportsForDeveloper } from '../../../../lib/developer-repo';

/**
 * Developer dashboard overview feed — every saved report across every
 * account, most recently updated first. A plain 404 (never 401/403) for
 * anyone whose session isn't role="admin", so this route's existence is not
 * revealed to an ordinary signed-in user — see lib/auth-session.ts's
 * getAdminSessionUser for why both "no session" and "wrong role" collapse
 * into the same outcome here.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export async function GET(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return new NextResponse(null, { status: 404 });
      }

      const url = new URL(request.url);
      const limitParam = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

      const reports = await listRecentReportsForDeveloper(client, limit);
      return new NextResponse(JSON.stringify({ reports }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
