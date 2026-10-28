import type { Client } from "@libsql/client";
import type { NextResponse } from "next/server";
import { adminJsonResponse } from "./admin-http";
import { checkAdminRate } from "./rate-limit";
import { clientIpFrom } from "./client-ip";
import { getAdminSessionUser, type SessionUser } from "./auth-session";
import { isSameOriginRequest } from "./same-origin";
import { getReportsDbClient } from "./reports-db";
import { entitlementTablesExist } from "./account-entitlements";

/**
 * The shared gate for every app/api/admin/account-activation/* route, in the order every app/api/admin/* route uses:
 * admin rate bucket -> (state-changing requests) same-origin -> admin session from the cookie -> migration present.
 * A caller that is not a signed-in administrator gets the same bodiless 404 as a route that does not exist; nothing
 * from the request body is read before this passes. Returns either the response to send or the admin + an open
 * client the route must close.
 */
export async function openAccountActivationRequest(
  request: Request,
  options: { stateChanging: boolean },
): Promise<{ response: NextResponse } | { admin: SessionUser; client: Client }> {
  const rate = await checkAdminRate(clientIpFrom(request));
  if (!rate.allowed) return { response: adminJsonResponse({ error: "Too many requests" }, 429, { "Retry-After": String(rate.retryAfter) }) };
  if (options.stateChanging && !isSameOriginRequest(request)) return { response: adminJsonResponse(null, 404) };

  const client = await getReportsDbClient();
  try {
    const admin = await getAdminSessionUser(request, client);
    if (!admin) {
      client.close();
      return { response: adminJsonResponse(null, 404) };
    }
    if (!(await entitlementTablesExist(client))) {
      client.close();
      return { response: adminJsonResponse({ error: "Account activation needs database migration 0056_account_entitlements before it can be used." }, 503) };
    }
    return { admin, client };
  } catch (err) {
    client.close();
    throw err;
  }
}
