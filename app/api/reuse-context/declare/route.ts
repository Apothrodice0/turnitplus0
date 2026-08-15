import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getSessionUser } from '../../../../lib/auth-session';
import { isE8sReuseContextAllowlisted } from '../../../../lib/e8s-visibility';
import { declareReuseContext, type DeclaredContext } from '../../../../lib/reuse-context-declarations';

/**
 * E8S Step 6: POST /api/reuse-context/declare — E8S Step 5's Flow 2.
 * declaredByAccountId is ALWAYS the session's own account id, never read
 * from the request body — see this route's own DECLARED_CONTEXTS check and
 * declareReuseContext's own server-side ownership validation. Not wired
 * into the live report route/page/UI.
 *
 * Phase E8S Step 6.1: gated behind E8S_REUSE_CONTEXT_ALLOWLIST
 * (lib/e8s-visibility.ts) — see app/api/reuse-context/status/route.ts's
 * identical comment for why this check runs immediately after session auth
 * and returns the same generic 404 as every other gated-out response here.
 */

export const dynamic = 'force-dynamic';

const DECLARED_CONTEXTS: readonly DeclaredContext[] = [
  'SUPERVISOR_COPY',
  'COAUTHOR_COPY',
  'INSTITUTIONAL_SUBMISSION',
  'AUTHORIZED_ARCHIVAL_COPY',
  'OTHER_AUTHORIZED_REUSE',
];

function clientIpFrom(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  return forwarded.split(',')[0].trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function POST(request: Request) {
  try {
    const rate = checkRate(clientIpFrom(request));
    if (!rate.allowed) {
      return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return new NextResponse(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
    const { documentIdentityId, representationId, declaredContext } = body as Record<string, unknown>;

    if (!isNonEmptyString(documentIdentityId) || !isNonEmptyString(representationId)) {
      return new NextResponse(JSON.stringify({ error: 'documentIdentityId and representationId are required' }), { status: 400 });
    }
    if (typeof declaredContext !== 'string' || !DECLARED_CONTEXTS.includes(declaredContext as DeclaredContext)) {
      return new NextResponse(JSON.stringify({ error: `declaredContext must be one of ${DECLARED_CONTEXTS.join(', ')}` }), { status: 400 });
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

      const result = await declareReuseContext(client, {
        documentIdentityId,
        representationId,
        declaredByAccountId: sessionUser.id,
        declaredContext: declaredContext as DeclaredContext,
      });

      if (result.status === 'DECLARED') {
        return new NextResponse(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (result.status === 'IDENTITY_NOT_FOUND' || result.status === 'REPRESENTATION_NOT_FOUND') {
        return new NextResponse(JSON.stringify(result), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      if (result.status === 'DECLARER_NOT_SUBMISSION_OWNER') {
        return new NextResponse(JSON.stringify(result), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      // NO_MATCH_PAIR / AMBIGUOUS_MATCH_PAIR / SELF_RELATIONSHIP_NOT_DECLARABLE / ALREADY_ACTIVE
      return new NextResponse(JSON.stringify(result), { status: 409, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
