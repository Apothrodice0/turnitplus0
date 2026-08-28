import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../../lib/auth-session';
import { getReportDeepDiveForDeveloper, getReportSimilarityDecisionTrace } from '../../../../../lib/developer-repo';

/**
 * Developer deep-dive for one saved report: the full report payload, its
 * document identity, every other submission (any account) its document
 * family resolved to, and every academic-search diagnostics run captured
 * for it. saved_reports has no globally-unique id (only unique per
 * device_key — see db/schema.ts's own comment), so deviceKey is required
 * here exactly like the ordinary GET /api/reports/[id] route already
 * requires it for an anonymous lookup.
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const { id } = await params;
    const url = new URL(request.url);
    const deviceKey = url.searchParams.get('deviceKey');
    if (!deviceKey) {
      return new NextResponse(JSON.stringify({ error: 'deviceKey is required' }), { status: 400 });
    }

    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return new NextResponse(null, { status: 404 });
      }

      const deepDive = await getReportDeepDiveForDeveloper(client, deviceKey, id);
      if (!deepDive.report) {
        return new NextResponse(null, { status: 404 });
      }
      // Admin-only similarity decision trace: WHY the final score is what it
      // is (word-position union proof, per-source counted/excluded reasons,
      // prior-submission account/backing evidence, Device Passport shadow
      // telemetry). Consumes the already-finalized production result — never
      // recomputes similarity, never changes a score. Best-effort: a failure
      // here degrades to a null trace, never a failed deep-dive response.
      let similarityDecisionTrace = null;
      try {
        similarityDecisionTrace = await getReportSimilarityDecisionTrace(client, deviceKey, id);
      } catch (err) {
        console.error('getReportSimilarityDecisionTrace failed (non-fatal):', err instanceof Error ? err.message : String(err));
      }
      return new NextResponse(JSON.stringify({ ...deepDive, similarityDecisionTrace }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
