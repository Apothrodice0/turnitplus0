import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../lib/auth-session';
import {
  summarizeSharedDeviceRiskMeasurement,
  DEFAULT_SHARED_DEVICE_RECENT_LIMIT,
  MAX_SHARED_DEVICE_RECENT_LIMIT,
} from '../../../../lib/device-sharedness-measurement';

/**
 * Admin-only SHARED-DEVICE FALSE-SELF RISK measurement — for every current
 * same-device SELF downgrade candidate (lib/device-provenance-shadow.ts
 * telemetry), how shared its verified upload Passport looks, plus the four
 * hypothetical shared-device guard policy simulations (A/B/C/D). Lets the
 * risk be quantified before any Production rollout of the same-device SELF
 * rule.
 *
 * A plain 404 (never 401/403, never a body) for anyone whose session isn't
 * role="admin" — same as every other app/api/developer/* route, so this
 * route's existence is not revealed to an ordinary signed-in user. The
 * underlying data layer is read-only (SELECT only) and never touches
 * similarity scoring or relationship classification.
 */

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
      const recentParam = Number(url.searchParams.get('recentLimit'));
      const recentLimit = Number.isFinite(recentParam) && recentParam > 0
        ? Math.min(Math.floor(recentParam), MAX_SHARED_DEVICE_RECENT_LIMIT)
        : DEFAULT_SHARED_DEVICE_RECENT_LIMIT;

      const summary = await summarizeSharedDeviceRiskMeasurement(client, { recentLimit });
      return new NextResponse(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
