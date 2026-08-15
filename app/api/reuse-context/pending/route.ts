import { NextResponse } from 'next/server';
import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkRate } from '../../../../lib/rate-limit';
import { getSessionUser } from '../../../../lib/auth-session';
import { isE8sReuseContextAllowlisted } from '../../../../lib/e8s-visibility';
import { getDeclarationsReferencingSubmission } from '../../../../lib/reuse-context-declarations';

/**
 * E8S Step 6: the ORIGINAL submitter's confirmation-panel data source
 * (E8S Step 5's Flows 3/4) — "which active declarations reference one of
 * MY submissions?" Ownership of documentIdentityId is verified against the
 * caller's own session before calling the reverse lookup — the DTO itself
 * carries no account id, but the mere existence/count/context of a
 * declaration is still only ever shown to the account it's actually about
 * (E8S Step 6 test K). Not wired into the live report route/page.
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
    if (!isNonEmptyString(documentIdentityId)) {
      return new NextResponse(JSON.stringify({ error: 'documentIdentityId is required' }), { status: 400 });
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

      const identity = await client.execute({ sql: 'SELECT account_id FROM document_identities WHERE id = ?', args: [documentIdentityId] });
      const ownerAccountId = (identity.rows[0] as unknown as { account_id: string | null } | undefined)?.account_id ?? null;
      if (ownerAccountId === null || ownerAccountId !== sessionUser.id) {
        return new NextResponse(JSON.stringify({ error: 'Not authorized for this submission.' }), { status: 403 });
      }

      const declarations = await getDeclarationsReferencingSubmission(client, { documentIdentityId });
      return new NextResponse(JSON.stringify({ declarations }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.close();
    }
  } catch (err) {
    return new NextResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }), { status: 500 });
  }
}
