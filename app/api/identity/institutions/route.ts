import { NextResponse } from 'next/server';
import { checkReadRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { searchRorInstitutions } from '../../../../lib/ror-client';

export const dynamic = 'force-dynamic';

/**
 * Canonical institution typeahead for the signup / account-settings forms,
 * backed by the public ROR registry (lib/ror-client.ts -> api.ror.org v2, CC0,
 * no key). Read-only; usable without a session. The ROR ids it returns are
 * RE-RESOLVED server-side on submit, so a stale/tampered result here can never
 * let an unknown institution through.
 */
export async function GET(request: Request) {
  const rate = await checkReadRate(clientIpFrom(request));
  if (!rate.allowed) {
    return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
  }

  const q = new URL(request.url).searchParams.get('q') ?? '';
  const results = (await searchRorInstitutions(q)).map((i) => ({
    rorId: i.rorId,
    name: i.name,
    countryCode: i.countryCode,
    countryName: i.countryName,
    types: i.types,
  }));

  return new NextResponse(JSON.stringify({ results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
