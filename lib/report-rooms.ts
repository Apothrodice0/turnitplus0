/**
 * The 10-room report architecture: a stable, deterministic partition of one
 * account's saved_reports rows into 10 buckets, computed from the report's
 * own id (a client-generated timestamp string — see app/page.tsx's
 * analyzeText()) rather than a stored column. This is deliberate: a report's
 * room membership never changes and needs no migration or backfill for
 * existing reports — "room" is a pure function of data that already exists,
 * not a new fact recorded about it.
 *
 * Isomorphic on purpose (no @libsql/client, no window/localStorage): both
 * app/api/reports/route.ts (server, SQL) and lib/reports-remote.ts /
 * components/reports/report-rooms.tsx (client, cache invalidation) need the
 * exact same room number for the exact same id — see reportRoomForId's own
 * comment for why the two computations must agree.
 */
export const REPORT_ROOM_COUNT = 10;

/**
 * Must compute IDENTICALLY to the server's own `CAST(id AS INTEGER) % 10`
 * (see app/api/reports/route.ts's GET handler) — this is what lets the
 * client, after saving a brand-new report, know which single room's cache
 * to invalidate without asking the server. Report ids are always positive
 * (Date.now()-based), so plain `%` never needs a sign correction here.
 */
export function reportRoomForId(id: string): number {
  const numeric = Number(id);
  return Number.isFinite(numeric) ? Math.trunc(numeric) % REPORT_ROOM_COUNT : 0;
}

/** One row of the lightweight room index — never the reports themselves, just enough to render 10 room tiles and decide which one to open. */
export type RoomIndexEntry = {
  room: number;
  count: number;
  mostRecentAt: string | null;
};
