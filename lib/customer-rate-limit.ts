import { getSessionUser, SESSION_COOKIE_NAME } from "./auth-session";
import { clientIpFrom } from "./client-ip";
import { getReportsDbClient } from "./reports-db";
import { checkAccountNewCheckRate, checkAccountProcessingRate, checkRate, checkSharedIpCeilingRate, type RateCheckResult } from "./rate-limit";

/**
 * ACCOUNT-AWARE CUSTOMER RATE LIMITING (owner-approved 2026-10-25) — the one decision every customer pipeline route makes before
 * doing any work. See lib/rate-limit.ts for the buckets.
 *
 * Identity: the account id of the SERVER-VERIFIED session (the session cookie resolved against the sessions table by
 * getSessionUser) — never a client-supplied account id, never a header. No session, an unknown / expired session, or a failed
 * lookup → the request is ANONYMOUS and takes the unchanged per-IP general bucket (the stricter path; a forged cookie gains
 * nothing). The IP itself comes from lib/client-ip.ts exactly as before.
 *
 * Scopes:
 *   "new-check"   starting a new document check (once per document). Only POST /api/reports/check-authorization uses it, so a
 *                 multi-step check never spends more than one new-check allowance.
 *   "processing"  everything a started check needs afterwards (saves, AI-result updates, recovery, evidence, layout …).
 * Signed-in requests are checked against the account bucket first and then the per-IP ceiling for signed-in traffic.
 */
export type CustomerRateScope = "new-check" | "processing";
export type CustomerRateDecision = RateCheckResult & { identity: "account" | "anonymous" };

export async function verifiedAccountIdForRateLimit(request: Request): Promise<string | null> {
  if (!(request.headers.get("cookie") ?? "").includes(`${SESSION_COOKIE_NAME}=`)) return null; // no session cookie: no lookup at all
  let client: Awaited<ReturnType<typeof getReportsDbClient>> | null = null;
  try {
    client = await getReportsDbClient();
    const user = await getSessionUser(request, client);
    return user ? String(user.id) : null;
  } catch {
    return null; // fail closed to the stricter anonymous (per-IP) limit
  } finally {
    client?.close();
  }
}

export async function checkCustomerRate(request: Request, scope: CustomerRateScope): Promise<CustomerRateDecision> {
  const ip = clientIpFrom(request);
  const accountId = await verifiedAccountIdForRateLimit(request);
  if (!accountId) return { ...(await checkRate(ip)), identity: "anonymous" };
  const own = scope === "new-check" ? await checkAccountNewCheckRate(accountId) : await checkAccountProcessingRate(accountId);
  if (!own.allowed) return { ...own, identity: "account" };
  return { ...(await checkSharedIpCeilingRate(ip)), identity: "account" };
}
