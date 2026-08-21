import type { Client } from "@libsql/client";

/**
 * The single source of truth for which account is the developer/admin
 * account. ADMIN_EMAIL is read in exactly this one function and nowhere
 * else in the codebase — the designated address itself lives only in
 * deployment config (.env.local for dev, the Vercel project's environment
 * variables for production), never hardcoded into source. This keeps the
 * grant mechanism safe to review: there is exactly one place that could ever
 * promote an account, and exactly one env var that controls it.
 *
 * Called from /api/auth/login and /api/auth/signup, after the account's id
 * is known but before the response is built, so a first login/signup with
 * the designated address is upgraded immediately rather than requiring a
 * separate manual step. Idempotent and self-healing: safe to call on every
 * login (a no-op once the row is already "admin"), and if the role column
 * were ever reset by an unrelated migration or manual edit, the very next
 * login from the configured address repairs it automatically.
 *
 * Deliberately never demotes: unsetting or changing ADMIN_EMAIL does not by
 * itself revoke an already-granted role (there is no "un-admin on mismatch"
 * branch below) — revoking access is an explicit, separate action (update
 * the row directly), never an incidental side effect of an env var change.
 */
export async function maybePromoteToAdmin(client: Client, userId: string, normalizedEmail: string): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;
  const normalizedAdminEmail = adminEmail.trim().toLowerCase();
  if (!normalizedAdminEmail || normalizedEmail !== normalizedAdminEmail) return;
  try {
    await client.execute({
      sql: "UPDATE users SET role = 'admin' WHERE id = ? AND role != 'admin'",
      args: [userId],
    });
  } catch (err) {
    // Best-effort, matching every other login/signup side effect in this
    // codebase (e.g. claimAnonymousReports) — a failed promotion must never
    // block a legitimate login.
    console.error("maybePromoteToAdmin failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}
