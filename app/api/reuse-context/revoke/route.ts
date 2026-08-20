import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getSessionUser } from '../../../../lib/auth-session';
import { isE8sReuseContextAllowlisted } from '../../../../lib/e8s-visibility';
import { revokeReuseContext } from '../../../../lib/reuse-context-declarations';

/**
 * E8S Step 6: POST /api/reuse-context/revoke — E8S Step 5's Flow 6.
 * revokedByAccountId is ALWAYS the session's own account id. Authorization
 * (declarer, confirmer, or the validated original submitter) is entirely
 * enforced inside revokeReuseContext — this route does no extra checks.
 * Not wired into the live report route/page/UI.
 *
 * Phase E8S Step 6.1: gated behind E8S_REUSE_CONTEXT_ALLOWLIST
 * (lib/e8s-visibility.ts) — see app/api/reuse-context/status/route.ts's
 * identical comment for why this check runs immediately after session auth
 * and returns the same generic 404 as every other gated-out response here.
 */

export const dynamic = 'force-dynamic';

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

export async function POST(request: Request) {
  try {
    const rate = await checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
    const { declarationId } = body as Record<string, unknown>;
    if (typeof declarationId !== 'number' || !Number.isInteger(declarationId)) {
      return new NextResponse(JSON.stringify({ error: 'declarationId must be an integer' }), { status: 400 });
    }

    const client = await getReportsDbClient();
    try {
      const sessionUser = await getSessionUser(request, client);
      if (!sessionUser) {
        return new NextResponse(JSON.stringify({ error: 'Not signed in.' }), { status: 401 });
      }
      if (!isE8sReuseContextAllowlisted(sessionUser.id)) {
        return new NextResponse(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      const result = await revokeReuseContext(client, { declarationId, revokedByAccountId: sessionUser.id });

      if (result.status === 'REVOKED') {
        return new NextResponse(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (result.status === 'NOT_FOUND') {
        return new NextResponse(JSON.stringify(result), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      // ALREADY_REVOKED / NOT_AUTHORIZED_TO_REVOKE
      return new NextResponse(JSON.stringify(result), { status: 409, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
