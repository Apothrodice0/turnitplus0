import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkAdminRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../../lib/auth-session';
import { getArchiveExplorerSourceDetail } from '../../../../../lib/corpus-admission-archive-explorer';
import { adminJsonResponse } from '../../../../../lib/admin-http';

/**
 * Admin-only Archive / Corpus Explorer detail for one source id
 * ("archive:<id>" | "admission:<id>" | "legacy:<id>"). Read-only
 * diagnostics — class, eligibility (from the matchers' own predicates),
 * maturity, provenance, admission reason codes, duplicate/fingerprint state.
 * Never returns retained or canonical text, source_ref, account/device/report
 * identifiers, or emails. Malformed and unknown ids are the same bare 404.
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = await checkAdminRate(clientIpFrom(request));
    if (!rate.allowed) {
      return adminJsonResponse({ error: 'Too many requests' }, 429, { 'Retry-After': String(rate.retryAfter) });
    }

    const { id } = await params;

    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return adminJsonResponse(null, 404);
      }

      const detail = await getArchiveExplorerSourceDetail(client, id);
      if (!detail) {
        return adminJsonResponse(null, 404);
      }
      return adminJsonResponse(detail, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    console.error('GET /api/admin/archive/[id] failed:', err instanceof Error ? err.message : String(err));
    return adminJsonResponse({ error: 'Internal error' }, 500);
  }
}
