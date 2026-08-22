import { getReportsDbClient } from '../../../../../../lib/reports-db';
import { checkAdminRate } from '../../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../../../lib/auth-session';
import { isSameOriginRequest } from '../../../../../../lib/same-origin';
import { deactivateAcceptedRepresentation, validateAdminReason } from '../../../../../../lib/corpus-admission-admin-actions';
import { parseDecisionRowId } from '../../../../../../lib/corpus-admission-admin-repo';
import { adminJsonResponse } from '../../../../../../lib/admin-http';

/**
 * Admin-only: excludes this decision's accepted fingerprint from active
 * "first accepted sample wins" family matching (revoked_at) — never
 * deletes the retained text or the decision's audit trail. Requires a
 * short reason (see lib/corpus-admission-admin-actions.ts's
 * validateAdminReason) and runs as one atomic transaction with its audit
 * row — see that module's own header comment.
 */

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const rate = await checkAdminRate(clientIpFrom(request));
    if (!rate.allowed) {
      return adminJsonResponse({ error: "Too many requests" }, 429, { "Retry-After": String(rate.retryAfter) });
    }

    if (!isSameOriginRequest(request)) {
      return adminJsonResponse(null, 404);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return adminJsonResponse({ error: "Invalid JSON" }, 400);
    }
    const reasonCheck = validateAdminReason((body as Record<string, unknown>).reason);
    if (!reasonCheck.ok) {
      return adminJsonResponse({ error: reasonCheck.error }, 400);
    }

    const { id } = await params;
    const decisionId = parseDecisionRowId(id);
    if (!decisionId) {
      return adminJsonResponse({ error: "No accepted fingerprint exists for this decision." }, 404);
    }

    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return adminJsonResponse(null, 404);
      }

      const result = await deactivateAcceptedRepresentation({
        decisionId,
        adminUserId: admin.id,
        reason: reasonCheck.reason,
        openConnection: () => getReportsDbClient(),
      });

      if (result.outcome === "not_found") return adminJsonResponse({ error: "No accepted fingerprint exists for this decision." }, 404);
      return adminJsonResponse(result, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return adminJsonResponse({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
}
