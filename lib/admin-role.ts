import type { Client } from "@libsql/client";

/**
 * Developer/admin role management.
 *
 * ── SECURITY (A2): NO AUTOMATIC PROMOTION FROM AN EMAIL STRING ──────────────
 * Historically an account was promoted to `admin` automatically the first time
 * the address in the ADMIN_EMAIL env var logged in OR signed up. That predates
 * any email verification: because a signup email is entirely unverified, anyone
 * who learned the configured ADMIN_EMAIL could create an account with it (when
 * no admin account existed yet) and instantly hold the admin role.
 *
 * That path is REMOVED. Neither /api/auth/signup nor /api/auth/login promotes
 * anyone. The admin role is now granted ONLY by a deliberate operator action —
 * a one-off `UPDATE users SET role = 'admin' WHERE email = ?` (or grantAdminRole
 * below, run from a maintenance script), performed once the operator has
 * confirmed out of band that the account is genuinely theirs.
 *
 * An account that already holds `role = 'admin'` keeps it — nothing here ever
 * demotes, and the removed auto-promote path was a no-op for an already-admin
 * row anyway, so existing admin access is unaffected.
 *
 * ADMIN_EMAIL remains a deployment note (see .env.example) recording WHICH
 * address an operator should grant; it is not read by any request handler.
 */

/** The configured admin address, normalized, or null. Not consulted by any request path — for operator tooling / docs only. */
export function configuredAdminEmail(): string | null {
  const raw = process.env.ADMIN_EMAIL;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** True iff `email` is exactly the configured ADMIN_EMAIL (case-insensitive). Operator tooling only. */
export function isConfiguredAdminEmail(email: string): boolean {
  const configured = configuredAdminEmail();
  return configured !== null && typeof email === "string" && email.trim().toLowerCase() === configured;
}

/**
 * The manual grant primitive: set one account's role to `admin`. This is
 * DELIBERATELY not wired into any request handler — call it only from a
 * maintenance script, after confirming the account belongs to the intended
 * operator. Idempotent.
 */
export async function grantAdminRole(client: Client, userId: string): Promise<void> {
  await client.execute({
    sql: "UPDATE users SET role = 'admin' WHERE id = ? AND role != 'admin'",
    args: [userId],
  });
}
