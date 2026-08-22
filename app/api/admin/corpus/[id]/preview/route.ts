import { getReportsDbClient } from '../../../../../../lib/reports-db';
import { checkAdminRate } from '../../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../../../lib/auth-session';
import { isSameOriginRequest } from '../../../../../../lib/same-origin';
import { revealRetainedTextPreview } from '../../../../../../lib/corpus-admission-admin-actions';
import { parseDecisionRowId } from '../../../../../../lib/corpus-admission-admin-repo';
import { adminJsonResponse } from '../../../../../../lib/admin-http';

/**
 * Admin-only retained-text preview reveal. POST, not GET — a GET route can
 * be prefetched, cached, or logged (URLs) in more places than a POST body
 * ever is, and it must never be reachable via a plain link/navigation the
 * way a GET could be. Bounded preview length (never the full text — see
 * lib/corpus-admission-admin-actions.ts's MAX_PREVIEW_CHARS) and the audit
 * row for this exact reveal is written and confirmed successful BEFORE the
 * preview is ever included in the response — see that module's own header
 * comment for why, and for what happens if the audit write itself fails
 * (the text is withheld, not returned anyway).
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

    const { id } = await params;
    const decisionId = parseDecisionRowId(id);
    if (!decisionId) {
      return adminJsonResponse(null, 404);
    }

    const client = await getReportsDbClient();
    try {
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return adminJsonResponse(null, 404);
      }

      const result = await revealRetainedTextPreview(client, {
        decisionId,
        adminUserId: admin.id,
        openConnection: () => getReportsDbClient(),
      });

      if (result.outcome === "not_found") return adminJsonResponse(null, 404);
      if (result.outcome === "audit_failed") {
        return adminJsonResponse({ error: "Could not record the required audit entry for this reveal — the retained text was not returned." }, 500);
      }
      return adminJsonResponse({ preview: result.preview, truncated: result.truncated, fullLength: result.fullLength }, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return adminJsonResponse({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
}
