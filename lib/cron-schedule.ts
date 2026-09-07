/**
 * The single source of truth for what vercel.json's own "crons" entries
 * say, for anything that needs to DISPLAY the schedule (the admin corpus
 * status strip) rather than react to an actual invocation. Deliberately
 * hand-maintained constants, not a runtime parse of vercel.json — Vercel
 * does not ship that file into the deployed runtime bundle in a place this
 * app could read it from at request time, and parsing a local repo file
 * from within a server component/route would silently do nothing useful
 * on the actual deployed server anyway. tests/cron-schedule.test.mjs
 * cross-checks these constants against vercel.json's real content at test
 * time instead, so a schedule change in one place without the other fails
 * CI rather than silently drifting.
 */

export type CronScheduleKey = "admissionRetention" | "promotion";

export type CronSchedule = {
  /** The exact vercel.json "schedule" string — kept verbatim so the drift test can compare it directly. */
  cronExpression: string;
  /** This app's crons are always daily-at-a-fixed-UTC-hour (see vercel.json) — the one number nextDailyUtcRun below actually needs. */
  hourUtc: number;
  /** Which route this schedule triggers — for display only. */
  path: string;
};

export const CRON_SCHEDULES: Record<CronScheduleKey, CronSchedule> = {
  admissionRetention: { cronExpression: "0 3 * * *", hourUtc: 3, path: "/api/internal/corpus-admission-sweep" },
  promotion: { cronExpression: "0 4 * * *", hourUtc: 4, path: "/api/internal/corpus-admission-promotion-sweep" },
};

/**
 * The next UTC instant this hour-of-day will occur — today's occurrence if
 * it hasn't passed yet, otherwise tomorrow's. Pure function of `now` (never
 * reads the system clock itself) so it is trivially testable and never
 * flaky. Deliberately not persisted anywhere (see B1C-adjacent trace's own
 * conclusion): a fixed daily schedule needs no stored "next run" value,
 * only this arithmetic, computed fresh on every render.
 */
export function nextDailyUtcRun(hourUtc: number, now: Date = new Date()): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
