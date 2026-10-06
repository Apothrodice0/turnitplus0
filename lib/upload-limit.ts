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
 * WHAT IS COUNTED: every new upload the server accepted today, whatever
 * became of its report afterwards.
 *
 *   - While a report exists, its upload is its saved_reports row, dated by
 *     saved_at: app/api/reports/route.ts's INSERT ... ON CONFLICT(device_key,
 *     id) DO UPDATE never lists saved_at in either the inserted-columns list
 *     or the UPDATE SET list, so a resave of an already-existing (device_key,
 *     id) — the AI save, a re-analysis, the Selective Corpus finalizer, a
 *     retry of a save the server already stored — never inserts a row and
 *     never changes saved_at. Counting rows by saved_at therefore counts
 *     distinct new-upload events and nothing else.
 *   - Once a report is deleted, its upload is a row in upload_usage_tombstones
 *     (drizzle/0054), written by a database trigger as the saved_reports row
 *     goes — by the owner's DELETE, by a room replacing its expired occupant,
 *     by a rooms reset, by anything. Without it a deletion gave the upload
 *     back, and upload → delete → upload had no limit at all.
 *
 * The two never overlap (a tombstone exists only for a row that does not), so
 * their sum is the count. Deleting never lowers it; nothing but a new upload
 * raises it.
 *
 * The calendar-day boundary is UTC (SQLite/libSQL's own `date()`/`'now'`
 * default), matching this schema's existing CURRENT_TIMESTAMP convention
 * (see db/schema.ts) — simple and predictable to communicate as a reset
 * time, and consistent regardless of which server region handles a request.
 * Both halves of the count use the same expression, so they roll over at the
 * same instant.
 *
 * ENFORCEMENT happens twice, with the same check. POST /api/reports calls
 * checkUploadLimit early, so an account over its limit is refused before any
 * of the save's expensive work; and again inside the write transaction that
 * inserts the report (insertReportWithRoomCheck), where no other save can
 * interleave — so two uploads racing for an account's last slot cannot both
 * be stored.
 */
export const DAILY_UPLOAD_LIMIT = 10;

export type UploadLimitStatus =
  | { unlimited: true }
  | { unlimited: false; uploadsToday: number; limit: number };

export type UploadLimitCheck =
  | { allowed: true }
  | { allowed: false; limit: number; uploadsToday: number; resetsAt: string; retryAfterSeconds: number };

/** A connection or an open transaction: the count must be readable inside the transaction that inserts the report. */
type UploadLimitDb = Pick<Client, "execute">;

/** New uploads the server has accepted from this account today (UTC), deleted or not — see this file's own header comment. */
export async function countUploadsToday(client: UploadLimitDb, userId: string): Promise<number> {
  const result = await client.execute({
    sql: `SELECT (SELECT COUNT(*) FROM saved_reports WHERE user_id = ? AND date(saved_at) = date('now'))
               + (SELECT COUNT(*) FROM upload_usage_tombstones WHERE user_id = ? AND date(used_at) = date('now')) AS cnt`,
    args: [userId, userId],
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
export async function checkUploadLimit(client: UploadLimitDb, userId: string): Promise<UploadLimitCheck> {
  const uploadsToday = await countUploadsToday(client, userId);
  if (uploadsToday < DAILY_UPLOAD_LIMIT) return { allowed: true };

  const now = new Date();
  const resetsAt = nextUtcMidnight(now);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000));
  return { allowed: false, limit: DAILY_UPLOAD_LIMIT, uploadsToday, resetsAt: resetsAt.toISOString(), retryAfterSeconds };
}

/** Display-only status for the UI ("7/10 uploads today" / "Unlimited") — never itself an enforcement decision. */
export async function getUploadLimitStatus(client: UploadLimitDb, userId: string, isAdmin: boolean): Promise<UploadLimitStatus> {
  if (isAdmin) return { unlimited: true };
  const uploadsToday = await countUploadsToday(client, userId);
  return { unlimited: false, uploadsToday, limit: DAILY_UPLOAD_LIMIT };
}
