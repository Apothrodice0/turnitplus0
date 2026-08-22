import { cache } from "react";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, getAdminSessionUserByToken, type SessionUser } from "./auth-session";
import { getReportsDbClient } from "./reports-db";

/**
 * Shared admin-session resolution for the app/admin/* Server Components —
 * the exact same underlying check as lib/developer-gate.ts's
 * loadDeveloperGate (getAdminSessionUserByToken, one role='admin' concept
 * for the whole codebase), kept as its own small wrapper rather than
 * importing something literally named "developer" from app/admin/* pages,
 * which would be confusing to a future reader even though the check itself
 * is identical. wrapped in React's cache() for the same reason
 * loadDeveloperGate is: a single request's generateMetadata() and page
 * component share one DB lookup instead of each doing its own.
 *
 * Every app/admin/*'s generateMetadata() MUST call this first and return {}
 * (never a page-identifying title) when it resolves null — see
 * lib/developer-gate.ts's own comment for the exact historical bug
 * (metadata resolving independently of, and often before, the body's
 * notFound() call) this guards against.
 */
export const loadAdminGate = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) return null;
  const client = await getReportsDbClient();
  try {
    return await getAdminSessionUserByToken(token, client);
  } finally {
    client.close();
  }
});
