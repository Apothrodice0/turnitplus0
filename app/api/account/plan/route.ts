import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkReadRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getSessionUser } from '../../../../lib/auth-session';
import { buildCustomerPlanView } from '../../../../lib/account-entitlements';

/**
 * The signed-in customer's own plan, for the account page's "Your plan" card (lib/account-entitlements.ts
 * buildCustomerPlanView): state, duration, dates and rooms. Display only — enforcement lives in POST /api/reports.
 * Kept out of /api/auth/me for the same reason GET /api/upload-limit is (that response must stay role-free).
 *
 *  - signed out              -> { authenticated: false }
 *  - feature off             -> { authenticated: true, enforced: false } (the page shows nothing new)
 *  - feature on, admin       -> { authenticated: true, enforced: true, exempt: true }
 *  - feature on, customer    -> the plan view, computed from the session's own account only
 */

export const dynamic = 'force-dynamic';

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...extraHeaders },
  });
}

export async function GET(request: Request) {
  try {
    const rate = await checkReadRate(clientIpFrom(request));
    if (!rate.allowed) return json({ error: 'Too many requests' }, 429, { 'Retry-After': String(rate.retryAfter) });

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) return json({ authenticated: false }, 200);
      return json({ authenticated: true, ...(await buildCustomerPlanView(client, sessionUser)) }, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
}
