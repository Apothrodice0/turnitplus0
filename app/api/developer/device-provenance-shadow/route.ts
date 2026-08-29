import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../lib/auth-session';
import {
  summarizeDeviceProvenanceShadowMeasurement,
  DEFAULT_RECENT_CANDIDATE_LIMIT,
  MAX_RECENT_CANDIDATE_LIMIT,
} from '../../../../lib/device-provenance-shadow-measurement';

/**
 * Admin-only Device Passport shadow measurement summary — a compact
 * aggregate view of the device-provenance-shadow-v1 telemetry
 * (lib/device-provenance-shadow.ts) so the proposed same-device SELF rule
 * can be measured against real data before any score effect is enabled.
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
        ? Math.min(Math.floor(recentParam), MAX_RECENT_CANDIDATE_LIMIT)
        : DEFAULT_RECENT_CANDIDATE_LIMIT;

      const summary = await summarizeDeviceProvenanceShadowMeasurement(client, { recentLimit });
      return new NextResponse(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
