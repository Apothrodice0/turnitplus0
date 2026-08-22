import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkAdminRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../../lib/auth-session';
import { getCorpusAdmissionDecisionDetail } from '../../../../../lib/corpus-admission-admin-repo';
import { adminJsonResponse } from '../../../../../lib/admin-http';

/**
 * Admin-only corpus-admission detail bundle for one row — scores, reason
 * codes, language, word count, source report (or "deleted"/"unknown" if
 * the report/job no longer exists — accepted content survives deletion,
 * see lib/corpus-admission-report-integration.ts), timestamps, attempts,
 * and fingerprint (active/deactivated) status. Never includes retained
 * text — see POST .../preview for that, deliberately separate and
 * audit-logged.
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = await checkAdminRate(clientIpFrom(request));
    if (!rate.allowed) {
      return adminJsonResponse({ error: "Too many requests" }, 429, { "Retry-After": String(rate.retryAfter) });
    }

    const { id } = await params;

    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return adminJsonResponse(null, 404);
      }

      const detail = await getCorpusAdmissionDecisionDetail(client, id);
      if (!detail) {
        return adminJsonResponse(null, 404);
      }
      return adminJsonResponse(detail, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return adminJsonResponse({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
}
