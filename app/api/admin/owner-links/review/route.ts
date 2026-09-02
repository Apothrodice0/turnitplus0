import { getReportsDbClient } from '../../../../../lib/reports-db';
import { checkAdminRate } from '../../../../../lib/rate-limit';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { getAdminSessionUser } from '../../../../../lib/auth-session';
import { isSameOriginRequest } from '../../../../../lib/same-origin';
import { adminJsonResponse } from '../../../../../lib/admin-http';
import { reviewOwnerEvidence } from '../../../../../lib/owner-review';

/**
 * Admin-only READ-ONLY owner-evidence review for a proposed direct account
 * pair. It is READ-ONLY with respect to owner-link / account / report /
 * passport business data — `reviewOwnerEvidence` only SELECTs bounded Device
 * Passport supporting evidence + the current direct owner-link state
 * (lib/owner-review.ts). `checkAdminRate` DOES persist/update this caller's
 * `rate_limit_buckets` row — that is expected operational state, not a business
 * mutation, and must not be stubbed away to make the call "read-only". It is
 * deliberately a POST, not a GET, so the two
 * account emails travel in the request body rather than a URL / access log /
 * referer: emails are a PII/logging surface that has no business in a query
 * string. Being a POST, it takes the full admin-mutation protection stack even
 * though it mutates nothing:
 *   1. checkAdminRate  — the dedicated admin bucket
 *   2. isSameOriginRequest — CSRF defence in depth beyond the Lax cookie
 *   3. getAdminSessionUser — role='admin'; a plain 404 (no body) for BOTH
 *      "not signed in" and "signed in but not admin", checked BEFORE any body
 *      validation so the route's existence is never confirmed to a non-admin
 *   4. server-side email -> account-id resolution (email is a TARGET SELECTOR
 *      ONLY — authority is the admin session; no client-supplied account id,
 *      ownerAccountRef, passport id, actor key, or device key is ever read)
 *   5. adminJsonResponse — Cache-Control: no-store on every response
 *
 * Neither email is echoed in any response, and no request body / email is
 * logged. Unknown accounts collapse to a bare { found: false } 200 — the same
 * shape whether zero, one, or the wrong account matched — leaking nothing about
 * which side (or whether any account) exists.
 *
 * NOT an establishment endpoint: manual ADMIN_MANUAL establish / withdraw is a
 * separate, later, independently-reviewed design.
 */

export const dynamic = 'force-dynamic';

const MAX_EMAIL_LENGTH = 254;
// The same shape check signup / login / lib/admin-role.ts apply before
// writing/comparing users.email.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function POST(request: Request) {
  try {
    const rate = await checkAdminRate(clientIpFrom(request));
    if (!rate.allowed) {
      return adminJsonResponse({ error: 'Too many requests' }, 429, { 'Retry-After': String(rate.retryAfter) });
    }

    // CSRF / same-origin — before auth and before the body is touched.
    if (!isSameOriginRequest(request)) {
      return adminJsonResponse(null, 404);
    }

    const client = await getReportsDbClient();
    try {
      // Auth BEFORE body validation: a non-admin / anonymous caller always gets
      // the same bare 404, never a 400 that would confirm the route exists.
      const admin = await getAdminSessionUser(request, client);
      if (!admin) {
        return adminJsonResponse(null, 404);
      }

      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return adminJsonResponse({ error: 'Invalid JSON' }, 400);
      }
      const { a, b } = body as Record<string, unknown>;
      if (
        !isNonEmptyString(a) || !isNonEmptyString(b) ||
        a.length > MAX_EMAIL_LENGTH || b.length > MAX_EMAIL_LENGTH
      ) {
        return adminJsonResponse({ error: 'Two account emails (a, b) are required.' }, 400);
      }

      // Canonicalize the SAME way users.email is stored (trim + lowercase),
      // then shape-check.
      const emailA = a.trim().toLowerCase();
      const emailB = b.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(emailA) || !EMAIL_PATTERN.test(emailB)) {
        return adminJsonResponse({ error: 'Two valid account emails are required.' }, 400);
      }
      if (emailA === emailB) {
        return adminJsonResponse({ error: 'a and b must be two different accounts.' }, 400);
      }

      const resolution = await reviewOwnerEvidence(client, { emailA, emailB });
      if (resolution.kind === 'same_account') {
        return adminJsonResponse({ error: 'a and b resolve to the same account.' }, 400);
      }
      if (resolution.kind === 'conflict') {
        // Impossible under ux_users_email — guarded anyway, and never a guess.
        return adminJsonResponse({ found: false, error: 'An email matches more than one account.' }, 409);
      }
      if (resolution.kind === 'not_found') {
        return adminJsonResponse({ found: false }, 200);
      }
      return adminJsonResponse(resolution.result, 200);
    } finally {
      client.close();
    }
  } catch (err) {
    return adminJsonResponse({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  }
}
