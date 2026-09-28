import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAdminRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../lib/auth-session';
import { ARCHIVE_EXPLORER_MAX_PAGE_SIZE, isArchiveExplorerSourceClass, isArchiveExplorerState, listArchiveExplorerSources } from '../../../../lib/corpus-admission-archive-explorer';
import { adminJsonResponse } from '../../../../lib/admin-http';

/**
 * Admin-only Archive / Corpus Explorer source list — search, class/state
 * filters, newest/oldest sort, server-side pagination (pageSize clamped to
 * ARCHIVE_EXPLORER_MAX_PAGE_SIZE). Read-only: GET is the only method.
 * Rate-limited (checkAdminRate), then admin-gated (getAdminSessionUser, a
 * bare 404 for anyone else) BEFORE any parameter is validated, so a
 * non-admin cannot learn the route exists from a 400. Never returns account,
 * device or report identifiers, emails, or any text.
 */

const MAX_QUERY_LENGTH = 200;
const VALID_SORTS = new Set(['newest', 'oldest']);

export async function GET(request: Request) {
  try {
    const rate = await checkAdminRate(clientIpFrom(request));
    if (!rate.allowed) {
      return adminJsonResponse({ error: 'Too many requests' }, 429, { 'Retry-After': String(rate.retryAfter) });
    }

    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return adminJsonResponse(null, 404);
      }

      const url = new URL(request.url);
      const sourceClass = url.searchParams.get('class');
      if (sourceClass && !isArchiveExplorerSourceClass(sourceClass)) {
        return adminJsonResponse({ error: 'Unknown source class' }, 400);
      }
      const state = url.searchParams.get('state');
      if (state && !isArchiveExplorerState(state)) {
        return adminJsonResponse({ error: 'Unknown state' }, 400);
      }
      const sort = url.searchParams.get('sort');
      if (sort && !VALID_SORTS.has(sort)) {
        return adminJsonResponse({ error: 'sort must be newest or oldest' }, 400);
      }
      const q = url.searchParams.get('q');
      if (q && q.length > MAX_QUERY_LENGTH) {
        return adminJsonResponse({ error: `q must be at most ${MAX_QUERY_LENGTH} characters` }, 400);
      }
      const pageParam = Number(url.searchParams.get('page'));
      const pageSizeParam = Number(url.searchParams.get('pageSize'));

      const result = await listArchiveExplorerSources(client, {
        q: q ?? undefined,
        sourceClass: sourceClass && isArchiveExplorerSourceClass(sourceClass) ? sourceClass : undefined,
        state: state && isArchiveExplorerState(state) ? state : undefined,
        sort: sort === 'oldest' ? 'oldest' : 'newest',
        page: Number.isFinite(pageParam) && pageParam > 0 ? pageParam : undefined,
        pageSize: Number.isFinite(pageSizeParam) && pageSizeParam > 0 ? Math.min(pageSizeParam, ARCHIVE_EXPLORER_MAX_PAGE_SIZE) : undefined,
      });
      return adminJsonResponse(result, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    console.error('GET /api/admin/archive failed:', err instanceof Error ? err.message : String(err));
    return adminJsonResponse({ error: 'Internal error' }, 500);
  }
}
