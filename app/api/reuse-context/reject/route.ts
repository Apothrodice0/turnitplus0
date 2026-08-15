import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getSessionUser } from '../../../../lib/auth-session';
import { isE8sReuseContextAllowlisted } from '../../../../lib/e8s-visibility';
import { getReuseContextDeclarationById, revokeReuseContext } from '../../../../lib/reuse-context-declarations';

/**
 * E8S Step 6: POST /api/reuse-context/reject — E8S Step 5's Flow 5(a).
 * Semantically distinct from /revoke: reject is specifically the original
 * submitter declining a claim they never confirmed. At the database level
 * this is the same UPDATE as revoke (verification_state='REVOKED') — the
 * fix to revokeReuseContext's authorization (E8S Step 6 requirement 2) is
 * what makes it reachable for an account that has never confirmed at all.
 * This route additionally refuses (409, "USE_REVOKE_INSTEAD") if the
 * declaration was already MUTUALLY_CONFIRMED, so "reject" never silently
 * undoes a real mutual confirmation — that's what /revoke is for.
 * revokedByAccountId is ALWAYS the session's own account id.
 *
 * Phase E8S Step 6.1: gated behind E8S_REUSE_CONTEXT_ALLOWLIST
 * (lib/e8s-visibility.ts) — see app/api/reuse-context/status/route.ts's
 * identical comment for why this check runs immediately after session auth
 * and returns the same generic 404 as every other gated-out response here
 * (including the existing-declaration lookup below, which never runs at
 * all for a non-allowlisted caller).
 */

export const dynamic = 'force-dynamic';

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

export async function POST(request: Request) {
  try {
    const rate = checkRate(clientIpFrom(request));
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

      const existing = await getReuseContextDeclarationById(client, declarationId);
      if (!existing) {
        return new NextResponse(JSON.stringify({ status: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      if (existing.verificationState === 'MUTUALLY_CONFIRMED') {
        return new NextResponse(JSON.stringify({ status: 'USE_REVOKE_INSTEAD' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
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
