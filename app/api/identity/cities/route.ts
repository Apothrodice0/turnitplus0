import { NextResponse } from 'next/server';
import { checkReadRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { searchCities } from '../../../../lib/geonames-cities';

export const dynamic = 'force-dynamic';

/**
 * Canonical city typeahead for the signup / account-settings forms, backed by
 * the bundled GeoNames cities15000 dataset (lib/geonames-cities.ts). Read-only;
 * usable without a session (signup happens before one exists). The ids it
 * returns are re-resolved server-side on submit — a stale or tampered result
 * here can never let a bad city through.
 */
export async function GET(request: Request) {
  const rate = await checkReadRate(clientIpFrom(request));
  if (!rate.allowed) {
    return new NextResponse(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
  }

  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? '';
  const country = url.searchParams.get('country');

  const results = searchCities(q, { countryCode: country, limit: 20 }).map((c) => ({
    geonamesId: c.geonamesId,
    name: c.name,
    countryCode: c.countryCode,
    countryName: c.countryName,
    admin1: c.admin1,
  }));

  return new NextResponse(JSON.stringify({ results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
