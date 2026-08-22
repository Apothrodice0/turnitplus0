import { cache } from "react";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, getAdminSessionUserByToken, type SessionUser } from "./auth-session";
import { getReportsDbClient } from "./reports-db";

/**
 * Shared admin-session resolution for the three app/developer/* Server
 * Components, wrapped in React's cache() so a single request's
 * generateMetadata() and page component share one DB lookup instead of
 * each doing its own (the same pattern app/reports/[id]/page.tsx and
 * app/reports/rooms/[room]/page.tsx already use for their own loaders).
 *
 * Production audit fix: generateMetadata() previously had no gate at all —
 * it always returned a page-identifying title regardless of who was
 * asking, even though the page body correctly 404s a non-admin. Next
 * resolves <head> metadata independently of (and often before) the body's
 * notFound() call, so a non-admin's browser tab still showed "Developer ·
 * TurnitPlus" / "Article lookup · Developer · TurnitPlus" / "Report
 * inspection · Developer · TurnitPlus" — confirming this route's existence
 * through the one channel the 404 body was specifically trying to hide it
 * from. Every generateMetadata() in app/developer/* must call this first
 * and return {} (never a page-identifying title) when it resolves null, so
 * the tab title falls back to the root layout's generic default — exactly
 * what a genuinely nonexistent route would show.
 */
export const loadDeveloperGate = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) return null;
  const client = await getReportsDbClient();
  try {
    return await getAdminSessionUserByToken(token, client);
  } finally {
    client.close();
  }
});
