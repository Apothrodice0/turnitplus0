import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { SESSION_COOKIE_NAME, parseCookie, destroySessionByToken, clearSessionCookie } from '../../../../lib/auth-session';

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

// Best-effort/idempotent, matching this codebase's fail-soft ethos: a
// missing or already-invalid cookie is still treated as a successful
// sign-out, not an error.
export async function POST(request: Request) {
  try {
    const rate = checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const token = parseCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME);
    if (token) {
      const client = await getReportsDbClient();
      try {
        await destroySessionByToken(client, token);
      } finally {
        client.close();
      }
    }

    const response = new NextResponse(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    clearSessionCookie(response);
    return response;
  } catch {
    const response = new NextResponse(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    clearSessionCookie(response);
    return response;
  }
}
