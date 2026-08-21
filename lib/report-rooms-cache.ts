import type { ReportSummary } from "./reports-remote";
import type { RoomIndexEntry } from "./report-rooms";

/**
 * Client-side 24h cache for the 10-room architecture (localStorage — small,
 * synchronous, JSON-shaped data; IndexedDB via lib/report-store.ts remains
 * the cache for FULL report bodies, a separate and much larger concern).
 * Scoped per account email (the only stable account identifier this client
 * ever receives — see lib/auth-session.ts's SessionUser, which never sends
 * a raw account id to the browser) so switching accounts on the same
 * browser can never show a stale/wrong account's room data.
 *
 * "24 hours before its data needs refreshing" (this feature's own
 * requirement) is intentionally coarse: room membership is a pure function
 * of a report's own id (see lib/report-rooms.ts) and never changes, so a
 * cached room's CONTENTS only go stale when a genuinely new report is
 * saved into it — which invalidateRoomCache() below handles immediately,
 * targeted at just that one room, rather than waiting on the TTL.
 */

const CACHE_VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000;

type CachedEntry<T> = { fetchedAt: number; data: T };

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function indexKey(accountEmail: string): string {
  return `tp_report_rooms_v${CACHE_VERSION}:${accountEmail}:index`;
}

function roomKey(accountEmail: string, room: number): string {
  return `tp_report_rooms_v${CACHE_VERSION}:${accountEmail}:room:${room}`;
}

function read<T>(key: string): T | null {
  const storage = safeLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEntry<T>;
    if (typeof parsed.fetchedAt !== "number" || Date.now() - parsed.fetchedAt > TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function write<T>(key: string, data: T): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ fetchedAt: Date.now(), data } satisfies CachedEntry<T>));
  } catch {
    // Storage full/unavailable/private-mode — degrade to "always fetch fresh," never throw.
  }
}

function remove(key: string): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}

export function getCachedRoomIndex(accountEmail: string): RoomIndexEntry[] | null {
  return read<RoomIndexEntry[]>(indexKey(accountEmail));
}

export function setCachedRoomIndex(accountEmail: string, rooms: RoomIndexEntry[]): void {
  write(indexKey(accountEmail), rooms);
}

export function getCachedRoom(accountEmail: string, room: number): ReportSummary[] | null {
  return read<ReportSummary[]>(roomKey(accountEmail, room));
}

export function setCachedRoom(accountEmail: string, room: number, summaries: ReportSummary[]): void {
  write(roomKey(accountEmail, room), summaries);
}

/**
 * Called right after a genuinely new report is saved (never after a resave
 * of an existing one — the caller already knows which case it is). Clears
 * only the one affected room's cached contents plus the index, so the next
 * time either is viewed it fetches fresh data — every OTHER room's cache is
 * left completely untouched, matching this feature's own "do not force the
 * user to reload all existing rooms" requirement.
 */
export function invalidateRoomCache(accountEmail: string, room: number): void {
  remove(roomKey(accountEmail, room));
  remove(indexKey(accountEmail));
}

/** Called on sign-out/account switch so a different account can never read a previous account's cached room data (defense in depth alongside the per-email key). */
export function clearAllReportRoomCaches(accountEmail: string): void {
  remove(indexKey(accountEmail));
  for (let room = 0; room < 10; room++) remove(roomKey(accountEmail, room));
}
