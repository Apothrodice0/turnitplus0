import type { Client } from "@libsql/client";

/**
 * Daily upload quota for authenticated, non-admin accounts — a separate
 * abuse-control layer from lib/rate-limit.ts's IP-based checkRate/
 * checkAuthRate (that one throttles request bursts from a client address;
 * this one caps genuinely new submissions per account per day, regardless
 * of how many devices/IPs an account uses). Anonymous (no session) traffic
 * has no concept of this limit at all — it is governed only by the existing
 * IP rate limiter, unchanged.
 *
 * "Genuinely new" is answered by saved_reports.saved_at, not by a separate
 * counter table: app/api/reports/route.ts's POST handler's INSERT ... ON
 * CONFLICT(device_key, id) DO UPDATE clause never lists saved_at in either
 * the inserted-columns list or the UPDATE SET list, so a resave of an
 * already-existing (device_key, id) — the product's own real
 * "save immediately, then again after Wikipedia enrichment" pattern (see
 * that route's own comment) — never changes saved_at. Counting distinct
 * rows by saved_at therefore counts distinct new-upload events, never a
 * resave of the same report, with no new column or table required.
 *
 * The calendar-day boundary is UTC (SQLite/libSQL's own `date()`/`'now'`
 * default), matching this schema's existing CURRENT_TIMESTAMP convention
 * (see db/schema.ts) — simple and predictable to communicate as a reset
 * time, and consistent regardless of which server region handles a request.
 *
 * Deliberately a plain COUNT-then-compare, not an atomic upsert-based
 * counter like lib/rate-limit.ts's checkBucket(): this is a soft daily
 * quota on real submission content, not a security-critical resource limit,
 * so a small race window (two concurrent saves from the same account both
 * passing the check right at the boundary) is an accepted tradeoff for
 * staying a small, easily-reasoned-about addition — see this project's own
 * "smallest architectural change possible" instruction for this feature.
 */
export const DAILY_UPLOAD_LIMIT = 10;

export type UploadLimitStatus =
  | { unlimited: true }
  | { unlimited: false; uploadsToday: number; limit: number };

export type UploadLimitCheck =
  | { allowed: true }
  | { allowed: false; limit: number; uploadsToday: number; resetsAt: string; retryAfterSeconds: number };

/** Distinct genuinely-new uploads this account has saved today (UTC) — see this file's own header comment for why saved_at is the right signal. */
export async function countUploadsToday(client: Client, userId: string): Promise<number> {
  const result = await client.execute({
    sql: `SELECT COUNT(*) as cnt FROM saved_reports WHERE user_id = ? AND date(saved_at) = date('now')`,
    args: [userId],
  });
  return Number((result.rows[0] as unknown as { cnt: number | bigint }).cnt);
}

/** The next UTC midnight after `now` — the moment countUploadsToday's window rolls over. */
function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * The enforcement check — call ONLY when the save about to happen is itself
 * a genuine first save (app/api/reports/route.ts's own existing
 * isFirstSaveOfThisReport) and the account is not role="admin". Calling it
 * on every request would be harmless (it only counts existing rows) but
 * wastes a query on every resave/admin request.
 */
export async function checkUploadLimit(client: Client, userId: string): Promise<UploadLimitCheck> {
  const uploadsToday = await countUploadsToday(client, userId);
  if (uploadsToday < DAILY_UPLOAD_LIMIT) return { allowed: true };

  const now = new Date();
  const resetsAt = nextUtcMidnight(now);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000));
  return { allowed: false, limit: DAILY_UPLOAD_LIMIT, uploadsToday, resetsAt: resetsAt.toISOString(), retryAfterSeconds };
}

/** Display-only status for the UI ("7/10 uploads today" / "Unlimited") — never itself an enforcement decision. */
export async function getUploadLimitStatus(client: Client, userId: string, isAdmin: boolean): Promise<UploadLimitStatus> {
  if (isAdmin) return { unlimited: true };
  const uploadsToday = await countUploadsToday(client, userId);
  return { unlimited: false, uploadsToday, limit: DAILY_UPLOAD_LIMIT };
}
