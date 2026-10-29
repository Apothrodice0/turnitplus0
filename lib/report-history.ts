/**
 * REPORT HISTORY RETENTION (owner decision 2026-10-29) — behind REPORT_HISTORY_RETENTION_ENABLED, off unless explicitly
 * "1"/"true".
 *
 * Off (the default): exactly the existing one-current-report-per-room behaviour. When a room is reused after its 24 h
 * cycle, the earlier report is replaced, i.e. deleted (app/api/reports/route.ts insertReportWithRoomCheck), and a room's
 * order and cycle come from saved_reports.report_created_at.
 *
 * On: a reused room KEEPS its earlier reports — nothing is deleted, the new check is simply the room's newest report,
 * and the earlier ones stay readable (with their evidence, highlights, AI result and receipt) from the room's history
 * list and by their own links. Only an explicit customer deletion or account deletion removes a report. Which report is
 * the room's current one, and when its 24 h cycle ends, are decided by the SERVER's saved_at (set once, at the first
 * save, never by the browser and never by a resave) — report_created_at comes from the browser and is display only.
 * The cooldown length, purchased room limits and daily cap are unchanged.
 */

export function reportHistoryRetentionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.REPORT_HISTORY_RETENTION_ENABLED;
  return raw === "1" || raw === "true";
}

/**
 * SQL for the moment a saved_reports row entered its room, as an ISO-8601 UTC string comparable with the room-cycle
 * helpers (lib/report-rooms.ts): the server's saved_at with retention on, the legacy report_created_at otherwise.
 * saved_at is SQLite CURRENT_TIMESTAMP text ("YYYY-MM-DD HH:MM:SS", UTC), hence the strftime.
 */
export function roomTimeSql(table?: string): string {
  const prefix = table ? `${table}.` : "";
  return reportHistoryRetentionEnabled() ? `strftime('%Y-%m-%dT%H:%M:%SZ', ${prefix}saved_at)` : `${prefix}report_created_at`;
}

/** One earlier report of a room, for the room's history list (display only — the report page itself re-checks access). */
export type EarlierRoomReport = { id: string; title: string; createdAt: string; savedAt: string; wordCount: number };
