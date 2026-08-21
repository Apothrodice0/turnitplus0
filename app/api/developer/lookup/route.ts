import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getAdminSessionUser } from '../../../../lib/auth-session';
import { searchArticleHistory } from '../../../../lib/developer-repo';

/** Article History / Lookup — search by title, DOI, URL, hash/fingerprint, author, or document/report id. See lib/developer-repo.ts's searchArticleHistory for the exact matching rules. */

const MAX_QUERY_LENGTH = 500;

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

export async function GET(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const url = new URL(request.url);
    const q = url.searchParams.get('q');
    if (!q || !q.trim() || q.length > MAX_QUERY_LENGTH) {
      return new NextResponse(JSON.stringify({ error: 'q is required (1-500 characters)' }), { status: 400 });
    }

    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return new NextResponse(null, { status: 404 });
      }

      const result = await searchArticleHistory(client, q);
      return new NextResponse(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
