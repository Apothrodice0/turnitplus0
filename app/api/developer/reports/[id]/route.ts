import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkRate } from '../../../../../lib/rate-limit';
import { getAdminSessionUser } from '../../../../../lib/auth-session';
import { getReportDeepDiveForDeveloper } from '../../../../../lib/developer-repo';

/**
 * Developer deep-dive for one saved report: the full report payload, its
 * document identity, every other submission (any account) its document
 * family resolved to, and every academic-search diagnostics run captured
 * for it. saved_reports has no globally-unique id (only unique per
 * device_key — see db/schema.ts's own comment), so deviceKey is required
 * here exactly like the ordinary GET /api/reports/[id] route already
 * requires it for an anonymous lookup.
 */

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

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
      return new NextResponse(JSON.stringify(deepDive), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
