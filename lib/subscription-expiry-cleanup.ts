import type { Client } from "@libsql/client";
import { deleteAllReportDataForAccount } from "./account-deletion";
import { accountActivationEnforced, entitlementTablesExist, readEntitlement } from "./account-entitlements";
import { planStateOf, type PlanBlockCode } from "./account-plan";
import { getReportsDbClient } from "./reports-db";
import { runAfterResponse } from "./run-after-response";

/**
 * SUBSCRIPTION EXPIRY CLEANUP (owner decision 2026-10-30): when a customer's plan expires, the reports it saved and
 * their report-specific document data are deleted, so a later renewal starts with an empty history. The account itself,
 * its plan row, the plan's audit trail (account_entitlement_events), room claims and check authorizations are kept.
 *
 * Access is NOT what this decides: lib/account-entitlements.ts reportAccessRefusal refuses every report of an expired
 * account from the moment it expires, whether or not this cleanup has run yet. A suspended plan is never cleaned while
 * it is still within its term (reactivation restores its reports); a suspended plan whose term then ends is expired,
 * and cleaned like any other.
 *
 * The deletion is lib/account-deletion.ts deleteAllReportDataForAccount — the same routine account deletion uses, with
 * all its protections (another account's rows are never touched; a corpus representation is removed only when nothing
 * references it any more; accepted / actively promoted corpus content is kept) — limited to rows saved at or before the
 * moment this run confirmed the plan had expired. So it is:
 *   - idempotent: a second run finds nothing left to delete;
 *   - safe against a concurrent renewal: anything saved after it is newer than the cutoff and is never touched;
 *   - safe against a straggling save (an AI result that passed its gate just before expiry): the next run, a sweep or
 *     the customer's next visit, removes it, and it is never readable in between.
 *
 * Who runs it: the customer's next visit to My Reports / a room / a report (after the response), the hourly sweep
 * (app/api/internal/subscription-expiry-sweep), and an administrator activating an expired account again (before the
 * new plan is granted). All three obey SUBSCRIPTION_EXPIRY_CLEANUP:
 *   "on"              every expired account;
 *   "synthetic-only"  only accounts whose email ends in @example.test (development / Preview, so no real account's
 *                     data is ever deleted while the feature is being tested);
 *   anything else     off (the default): nothing is deleted; access is still refused.
 */

export type ExpiryCleanupMode = "on" | "synthetic-only" | "off";
export const SYNTHETIC_ACCOUNT_EMAIL_SUFFIX = "@example.test";

export function expiryCleanupMode(env: NodeJS.ProcessEnv = process.env): ExpiryCleanupMode {
  const raw = (env.SUBSCRIPTION_EXPIRY_CLEANUP ?? "").trim().toLowerCase();
  return raw === "on" ? "on" : raw === "synthetic-only" ? "synthetic-only" : "off";
}

export function expiryCleanupAllowedFor(email: string | null | undefined, mode: ExpiryCleanupMode = expiryCleanupMode()): boolean {
  if (mode === "on") return true;
  if (mode === "synthetic-only") return typeof email === "string" && email.trim().toLowerCase().endsWith(SYNTHETIC_ACCOUNT_EMAIL_SUFFIX);
  return false;
}

/** A server time in the CURRENT_TIMESTAMP format saved_reports.saved_at / document_identities.created_at use. */
export function sqliteTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export type ExpiryCleanupResult =
  | { ran: true; reportsDeleted: number; identitiesProcessed: number }
  | { ran: false; reason: "disabled" | "not-enforced" | "no-tables" | "not-expired" | "account-not-eligible" };

/**
 * Deletes the expired account's report data (see the header). Re-reads the plan itself, so a caller's earlier view of
 * it can be stale without harm: it only deletes when the plan is expired NOW, and only rows saved up to NOW.
 */
export async function cleanupExpiredSubscriptionReports(client: Client, account: { id: string; email: string | null }, nowMs: number = Date.now(), mode: ExpiryCleanupMode = expiryCleanupMode()): Promise<ExpiryCleanupResult> {
  if (mode === "off") return { ran: false, reason: "disabled" };
  if (!accountActivationEnforced()) return { ran: false, reason: "not-enforced" };
  if (!expiryCleanupAllowedFor(account.email, mode)) return { ran: false, reason: "account-not-eligible" };
  if (!(await entitlementTablesExist(client))) return { ran: false, reason: "no-tables" };
  const entitlement = await readEntitlement(client, account.id);
  if (planStateOf(entitlement, nowMs) !== "expired") return { ran: false, reason: "not-expired" };
  const result = await deleteAllReportDataForAccount(client, account.id, { preserveActivelyPromotedRepresentations: true, savedAtOrBefore: sqliteTimestamp(nowMs) });
  return { ran: true, ...result };
}

/**
 * For request paths that have just refused an expired account: runs the cleanup after the response, on its own
 * connection, and never fails the request (the refusal is already decided). Any other refusal code does nothing.
 */
export async function scheduleExpiryCleanupAfterRefusal(code: PlanBlockCode | null | undefined, account: { id: string; email: string | null }): Promise<void> {
  if (code !== "PLAN_EXPIRED" || expiryCleanupMode() === "off") return;
  await runAfterResponse(async () => {
    try {
      const client = await getReportsDbClient();
      try {
        await cleanupExpiredSubscriptionReports(client, account);
      } finally {
        client.close();
      }
    } catch (error) {
      console.error("subscription expiry cleanup failed:", error instanceof Error ? error.name : "unknown");
    }
  });
}

/**
 * The sweep: every expired account that still has a saved report (within the mode), at most `limit` per run. Each one
 * re-checks its own plan inside cleanupExpiredSubscriptionReports, so a renewal between this query and its cleanup is
 * respected.
 */
export async function runSubscriptionExpirySweep(client: Client, nowMs: number = Date.now(), limit = 50, mode: ExpiryCleanupMode = expiryCleanupMode()): Promise<{ mode: ExpiryCleanupMode; accounts: number; cleaned: number; reportsDeleted: number; failures: number }> {
  if (mode === "off" || !accountActivationEnforced() || !(await entitlementTablesExist(client))) return { mode, accounts: 0, cleaned: 0, reportsDeleted: 0, failures: 0 };
  const rows = (await client.execute({
    sql: `SELECT e.user_id AS id, u.email AS email FROM account_entitlements e JOIN users u ON u.id = e.user_id
          WHERE e.expires_at <= ? AND EXISTS (SELECT 1 FROM saved_reports r WHERE r.user_id = e.user_id)
          ${mode === "synthetic-only" ? "AND lower(u.email) LIKE ?" : ""}
          ORDER BY e.expires_at LIMIT ?`,
    args: mode === "synthetic-only" ? [nowMs, `%${SYNTHETIC_ACCOUNT_EMAIL_SUFFIX}`, limit] : [nowMs, limit],
  })).rows as unknown as { id: string; email: string }[];
  let cleaned = 0, reportsDeleted = 0, failures = 0;
  for (const row of rows) {
    try {
      const result = await cleanupExpiredSubscriptionReports(client, { id: String(row.id), email: String(row.email) }, nowMs, mode);
      if (result.ran) { cleaned += 1; reportsDeleted += result.reportsDeleted; }
    } catch (error) {
      failures += 1;
      console.error("subscription expiry sweep: one account failed:", error instanceof Error ? error.name : "unknown");
    }
  }
  return { mode, accounts: rows.length, cleaned, reportsDeleted, failures };
}
