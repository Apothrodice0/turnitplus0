import { getReportsDbClient } from '../../../../lib/reports-db';
import { checkAdminRate } from '../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../lib/auth-session';
import { listCorpusAdmissionDecisions, type CorpusAdmissionAdminStatus } from '../../../../lib/corpus-admission-admin-repo';
import { adminJsonResponse } from '../../../../lib/admin-http';

/**
 * Admin-only corpus-admission list — search/filter/paginate. Never reveals
 * retained text (list rows never join corpus_admission_content_store).
 * Admin-gated (getAdminSessionUser, 404 for anyone else — same "don't
 * confirm this route exists" discipline as every /api/developer/* route)
 * and admin-rate-limited (checkAdminRate — a dedicated bucket, not the
 * general/read buckets sized for ordinary-user traffic).
 */

const VALID_STATUSES = new Set(["pending", "failed", "cancelled", "accepted", "review", "rejected"]);
const MAX_QUERY_LENGTH = 500;

export async function GET(request: Request) {
  try {
    const rate = await checkAdminRate(clientIpFrom(request));
    if (!rate.allowed) {
      return adminJsonResponse({ error: "Too many requests" }, 429, { "Retry-After": String(rate.retryAfter) });
    }

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    if (statusParam && !VALID_STATUSES.has(statusParam)) {
      return adminJsonResponse({ error: `status must be one of ${[...VALID_STATUSES].join(", ")}` }, 400);
    }
    const language = url.searchParams.get("language");
    const q = url.searchParams.get("q");
    if (q && q.length > MAX_QUERY_LENGTH) {
      return adminJsonResponse({ error: `q must be at most ${MAX_QUERY_LENGTH} characters` }, 400);
    }
    const pageParam = Number(url.searchParams.get("page"));
    const pageSizeParam = Number(url.searchParams.get("pageSize"));

    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return adminJsonResponse(null, 404);
      }

      const result = await listCorpusAdmissionDecisions(client, {
        status: (statusParam as CorpusAdmissionAdminStatus | null) ?? undefined,
        language: language ?? undefined,
        q: q ?? undefined,
        page: Number.isFinite(pageParam) && pageParam > 0 ? pageParam : undefined,
        pageSize: Number.isFinite(pageSizeParam) && pageSizeParam > 0 ? pageSizeParam : undefined,
      });
      return adminJsonResponse(result, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return adminJsonResponse({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
}
