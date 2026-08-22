/**
 * The room/slot architecture: each authenticated account gets a fixed set of
 * numbered rooms (10 for a normal account, more for admin — see
 * getRoomCountForRole), and each room is a real upload SLOT, not a visual
 * grouping. A room holds AT MOST one *current* report at a time — which room
 * a report belongs to is an explicit fact recorded at upload time
 * (saved_reports.room_number, set once and never changed — see
 * db/schema.ts's own comment on that column), never derived from the
 * report's id. This deliberately replaces an earlier design where "room" was
 * computed as `id % 10`: that let unlimited reports silently accumulate in
 * the same room tile (two different reports can share the same id%10 by
 * pure chance), which is exactly the bug this file's rewrite fixes.
 *
 * A room's status is a pure function of its most recent report (if any):
 *  - "ready"      — a report exists, is still within its active 24h cycle,
 *                   AND its AI analysis has actually finished (ai_score is
 *                   recorded). The room shows that report; a new upload into
 *                   this room is refused (both client- and server-side —
 *                   see app/api/reports/route.ts) until the cycle ends.
 *  - "processing" — a report exists and is within its active 24h cycle, but
 *                   ai_score is still NULL: app/page.tsx's generateReport()
 *                   deliberately saves the similarity result first and
 *                   merges the AI score in via a second save once analysis
 *                   finishes (see that file's own TASK 4 comment — this is
 *                   what lets the user start a new check immediately rather
 *                   than waiting on a possibly-slow AI model download), so
 *                   there is a real, short window where the report exists
 *                   but isn't fully analyzed yet. The room MUST NOT claim
 *                   "ready" during this window — see
 *                   app/reports/rooms/[room]/room-page-shell.tsx, which
 *                   polls for genuine completion rather than faking it. The
 *                   room still counts as occupied for occupancy/409 purposes
 *                   regardless of this status — see isWithinActiveCycle,
 *                   which this is layered on top of, not a replacement for.
 *  - "empty"      — no report has ever been assigned to this room, OR the
 *                   most recent one's 24h cycle has ended. Either way the
 *                   room is available for a new upload. An expired report
 *                   is never deleted — it stays in saved_reports and is
 *                   still reachable at its own /reports/[id] permalink and
 *                   via developer/admin lookup — it is simply no longer the
 *                   room's *current* occupant once superseded by a new
 *                   upload.
 *
 * Isomorphic on purpose (no @libsql/client, no window/localStorage): both
 * the server (app/api/reports/route.ts, app/api/reports/rooms/route.ts) and
 * the client (components/reports/report-rooms.tsx) need to agree on the
 * exact same cycle boundary.
 */

import type { UserRole } from "./auth-session";

export const NORMAL_ROOM_COUNT = 10;

/**
 * Admin/developer accounts generate far more test reports than the normal
 * daily-use pattern the 10-room limit is designed around, so they get a
 * much larger room space (this task's own explicit requirement: "the
 * developer acc should still have infinite rooms or at least 40") rather
 * than being squeezed by the same slot count as a normal account. This is
 * intentionally still a fixed, finite number (not literally unlimited) —
 * the same one-room-one-slot invariant applies, just with more slots.
 */
export const ADMIN_ROOM_COUNT = 40;

export function getRoomCountForRole(role: UserRole): number {
  return role === "admin" ? ADMIN_ROOM_COUNT : NORMAL_ROOM_COUNT;
}

export const ROOM_CYCLE_MS = 24 * 60 * 60 * 1000;

/** Whether a report saved at `reportCreatedAtIso` still holds its room's active slot. */
export function isWithinActiveCycle(reportCreatedAtIso: string, now: number = Date.now()): boolean {
  const createdAt = Date.parse(reportCreatedAtIso);
  if (!Number.isFinite(createdAt)) return false;
  return now - createdAt < ROOM_CYCLE_MS;
}

/** The moment a room next becomes available for a new upload, given its current occupant's creation time. */
export function roomCycleEndsAt(reportCreatedAtIso: string): string {
  return new Date(Date.parse(reportCreatedAtIso) + ROOM_CYCLE_MS).toISOString();
}

export type RoomStatus = "empty" | "processing" | "ready";

/** One row of the lightweight room index — never the report itself, just enough to render one room row. */
export type RoomIndexEntry = {
  room: number;
  status: RoomStatus;
  /** The current occupant's creation time — present whenever status is "ready" or "processing". */
  mostRecentAt: string | null;
  /** When this room next becomes available for a new upload — present whenever status is "ready" or "processing" (occupancy, not AI completion, decides this). */
  cycleEndsAt: string | null;
};
