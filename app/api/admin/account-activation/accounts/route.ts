import { adminJsonResponse } from '../../../../../lib/admin-http';
import { openAccountActivationRequest } from '../../../../../lib/account-activation-http';
import { listActivatedAccounts, type AccountListFilter } from '../../../../../lib/account-activation-admin';

/**
 * Admin-only: the paginated list of accounts that have (or had) a plan, optionally narrowed by an email substring and
 * a state filter. Read-only. Rows carry the plan and room figures only — never a password hash, session or manuscript.
 */
const FILTERS: readonly AccountListFilter[] = ['all', 'active', 'expired', 'suspended'];

export async function GET(request: Request) {
  try {
    const opened = await openAccountActivationRequest(request, { stateChanging: false });
    if ('response' in opened) return opened.response;
    const { client } = opened;
    try {
      const url = new URL(request.url);
      const query = (url.searchParams.get('q') ?? '').slice(0, 254);
      const filterParam = url.searchParams.get('filter') ?? 'all';
      const filter = (FILTERS as readonly string[]).includes(filterParam) ? (filterParam as AccountListFilter) : 'all';
      const pageParam = Number(url.searchParams.get('page') ?? '1');
      const page = Number.isInteger(pageParam) && pageParam >= 1 && pageParam <= 100_000 ? pageParam : 1;
      return adminJsonResponse(await listActivatedAccounts(client, { query, filter, page }), 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return adminJsonResponse({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
}
