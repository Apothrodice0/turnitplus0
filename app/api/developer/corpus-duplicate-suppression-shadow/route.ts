import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../lib/auth-session';
import {
  summarizeCorpusDuplicateSuppressionShadowMeasurement,
  DEFAULT_RECENT_CANDIDATE_LIMIT,
  MAX_RECENT_CANDIDATE_LIMIT,
} from '../../../../lib/corpus-duplicate-suppression-shadow-measurement';

/**
 * Admin-only Phase B2b corpus-duplicate suppression shadow measurement summary
 * — a compact aggregate view of the document-local-corpus-duplicate-shadow-v1
 * telemetry (lib/corpus-duplicate-suppression-shadow.ts, drizzle/0044) so the
 * B1 counterfactual's effect on the unified similarity score can be measured
 * against real data before any later phase wires a score change.
 *
 * A plain 404 (never 401/403, never a body) for anyone whose session isn't
 * role="admin" — same as every other app/api/developer/* route, so this
 * route's existence is not revealed to an ordinary signed-in user. The
 * underlying data layer is read-only (SELECT only) and never touches
 * similarity scoring, relationship classification, or the B1 counterfactual.
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

      const summary = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client, { recentLimit });
      return new NextResponse(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch {
    // The caught exception can carry DB SQL, file paths, stack traces, or
    // identifiers — so it goes NOWHERE: not to the response body, and not to
    // the server log. Only a constant operational marker is emitted.
    console.error('corpus-duplicate-suppression-shadow measurement unavailable');
    return new NextResponse(JSON.stringify({ error: 'measurement_unavailable' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
