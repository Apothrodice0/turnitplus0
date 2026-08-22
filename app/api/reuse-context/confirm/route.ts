import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getSessionUser } from '../../../../lib/auth-session';
import { isE8sReuseContextAllowlisted } from '../../../../lib/e8s-visibility';
import { confirmReuseContext } from '../../../../lib/reuse-context-declarations';

/**
 * E8S Step 6: POST /api/reuse-context/confirm — E8S Step 5's Flow 4.
 * confirmingAccountId is ALWAYS the session's own account id, never read
 * from the request body. confirmReuseContext itself re-validates that this
 * account is the actual original submitter, resolved fresh from
 * corpus_submission_references on every call — never trusted from here.
 * Not wired into the live report route/page/UI.
 *
 * Phase E8S Step 6.1: gated behind E8S_REUSE_CONTEXT_ALLOWLIST
 * (lib/e8s-visibility.ts) — see app/api/reuse-context/status/route.ts's
 * identical comment for why this check runs immediately after session auth
 * and returns the same generic 404 as every other gated-out response here.
 */

export const dynamic = 'force-dynamic';

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

      const result = await confirmReuseContext(client, { declarationId, confirmingAccountId: sessionUser.id });

      if (result.status === 'CONFIRMED' || result.status === 'ALREADY_CONFIRMED') {
        return new NextResponse(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (result.status === 'NOT_FOUND') {
        return new NextResponse(JSON.stringify(result), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      // ALREADY_REVOKED / SELF_CONFIRMATION_REJECTED / ORIGINAL_SUBMISSION_UNRESOLVABLE / NOT_ORIGINAL_SUBMITTER
      return new NextResponse(JSON.stringify(result), { status: 409, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
