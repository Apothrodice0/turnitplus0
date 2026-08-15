import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getSessionUser } from '../../../../lib/auth-session';
import { isE8sReuseContextAllowlisted } from '../../../../lib/e8s-visibility';
import { canDeclareReuseContext, getActiveReuseContextDeclaration } from '../../../../lib/reuse-context-declarations';

/**
 * E8S Step 6: read-only status for the DECLARER's own affordance
 * (E8S Step 5's Flows 1/2/6/8/9) — "should I show 'Add context' for this
 * pair, and is there already an active declaration?" Not wired into the
 * live report route/page; this feature is not reachable by a real user yet
 * — see lib/reuse-context-declarations.ts's own header comment.
 *
 * Phase E8S Step 6.1: gated behind E8S_REUSE_CONTEXT_ALLOWLIST
 * (lib/e8s-visibility.ts), checked immediately after session auth and
 * before any other logic — a signed-in but non-allowlisted caller gets the
 * exact same generic 404 regardless of whether the pair/declaration would
 * have existed, never a distinguishable response.
 *
 * Ownership is checked before anything else past the allowlist gate: a
 * session that does not own documentIdentityId gets 403 with no
 * declaration data at all, never a peek at another account's declaration
 * state (E8S Step 6 test K).
 */

export const dynamic = 'force-dynamic';

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function GET(request: Request) {
  try {
    const rate = checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const url = new URL(request.url);
    const documentIdentityId = url.searchParams.get('documentIdentityId');
    const representationId = url.searchParams.get('representationId');
    if (!isNonEmptyString(documentIdentityId) || !isNonEmptyString(representationId)) {
      return new NextResponse(JSON.stringify({ error: 'documentIdentityId and representationId are required' }), { status: 400 });
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

      // canDeclareReuseContext's own NOT_SUBMISSION_OWNER check already
      // covers this, but the ownership check is duplicated at the route
      // boundary too, deliberately: it decides whether activeDeclaration is
      // even computed/returned at all, never just whether the CTA renders.
      const identity = await client.execute({ sql: 'SELECT account_id FROM document_identities WHERE id = ?', args: [documentIdentityId] });
      const ownerAccountId = (identity.rows[0] as unknown as { account_id: string | null } | undefined)?.account_id ?? null;
      if (ownerAccountId === null || ownerAccountId !== sessionUser.id) {
        return new NextResponse(JSON.stringify({ error: 'Not authorized for this submission.' }), { status: 403 });
      }

      const [affordance, activeDeclaration] = await Promise.all([
        canDeclareReuseContext(client, { documentIdentityId, representationId, accountId: sessionUser.id }),
        getActiveReuseContextDeclaration(client, { documentIdentityId, representationId }),
      ]);

      return new NextResponse(JSON.stringify({ affordance, activeDeclaration }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
