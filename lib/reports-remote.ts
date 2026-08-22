import { getDeviceKey } from "./device-key";
import type { RoomIndexEntry } from "./report-rooms";

export type ReportSummary = {
  id: string;
  submissionId: string;
  title: string;
  createdAt: string;
  wordCount: number;
  archiveScore: number;
  scoreBand: string;
  aiScore: number | null;
  aiTone: string | null;
};

// Every function here is fail-soft by design: a network or database problem
// must never interrupt analysis or block the existing local (IndexedDB) flow.

export type SaveReportRemoteResult =
  | { ok: true }
  /**
   * status 0 means the request never completed (network/DB error) — the
   * existing fail-soft case, where the local copy is the only signal that
   * matters and the caller has never needed to react to a value. status 429
   * with quotaExceeded, and status 409 with roomOccupied, are surfaced to the
   * user instead of being treated like every other silent remote-save
   * failure — see generateReport() in app/page.tsx.
   */
  | { ok: false; status: number; quotaExceeded: boolean; roomOccupied: boolean; error?: string; resetsAt?: string; cycleEndsAt?: string };

/**
 * `academicSearchDiagnosticsId` is sent as a sibling of `payload`, never
 * nested inside it — it must never become part of SimilarityReport/
 * saved_reports.payload_json. It is only ever a bare row id (see
 * app/api/academic-evidence/route.ts's own header comment for why the raw
 * diagnostic content itself is persisted server-side and never sent to this
 * client at all) — app/api/reports/route.ts uses it to link that
 * already-persisted row to this report, once both exist.
 *
 * `room` must be provided for a genuinely new, authenticated (account)
 * upload — the room the user had open when they started the check (see
 * components/reports/report-rooms.tsx) — and is ignored server-side for a
 * resave of an already-existing report (room_number is immutable after the
 * first insert). Omitted entirely for anonymous saves, which have no room
 * concept at all.
 */
export async function saveReportRemote<T>(report: T, summary: ReportSummary, academicSearchDiagnosticsId?: number | null, room?: number): Promise<SaveReportRemoteResult> {
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceKey,
        ...summary,
        payload: report,
        academicSearchDiagnosticsId: academicSearchDiagnosticsId ?? null,
        ...(room !== undefined ? { room } : {}),
      }),
    });
    if (!response.ok) {
      console.debug("Remote report save was rejected (local copy is unaffected).", { status: response.status });
      const body = (await response.json().catch(() => null)) as { error?: string; resetsAt?: string; cycleEndsAt?: string } | null;
      // Distinguished from the IP rate limiter's own 429 (checkRate in
      // app/api/reports/route.ts, `{ error: 'Too many requests' }`, no
      // resetsAt) by the presence of resetsAt — only the daily upload quota
      // response includes it. roomOccupied is its own distinct status code
      // (409), so it never needs a similar body-shape heuristic.
      const quotaExceeded = response.status === 429 && typeof body?.resetsAt === "string";
      const roomOccupied = response.status === 409;
      return { ok: false, status: response.status, quotaExceeded, roomOccupied, error: body?.error, resetsAt: body?.resetsAt, cycleEndsAt: body?.cycleEndsAt };
    }
    return { ok: true };
  } catch (error) {
    console.debug("Remote report save failed (local copy is unaffected).", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, status: 0, quotaExceeded: false, roomOccupied: false };
  }
}

export type UploadLimitStatus =
  | { authenticated: false }
  | { authenticated: true; unlimited: true }
  | { authenticated: true; unlimited: false; uploadsToday: number; limit: number };

/** Display-only — see app/api/upload-limit/route.ts's own header comment for why this is a separate endpoint from /api/auth/me. */
export async function fetchUploadLimitStatus(): Promise<UploadLimitStatus> {
  try {
    const response = await fetch("/api/upload-limit");
    if (!response.ok) return { authenticated: false };
    const data = (await response.json()) as UploadLimitStatus;
    return data.authenticated ? data : { authenticated: false };
  } catch (error) {
    console.debug("Upload limit status fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { authenticated: false };
  }
}

export async function listRemoteReportSummaries(): Promise<ReportSummary[]> {
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch(`/api/reports?deviceKey=${encodeURIComponent(deviceKey)}`, { cache: "no-store" });
    if (!response.ok) return [];
    const data = (await response.json()) as { reports?: ReportSummary[] };
    return Array.isArray(data.reports) ? data.reports : [];
  } catch (error) {
    console.debug("Remote report list fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * The room/slot architecture's index fetch — see app/api/reports/rooms/route.ts's
 * own header comment. This is the ONLY report-related network call "opening
 * My Reports" makes for an authenticated account (client-side cached for
 * 24h — see lib/report-rooms-cache.ts); it never returns a report itself,
 * only each room's status (empty/ready) and, when ready, its occupant's
 * timestamps. The array's length is however many rooms this account has
 * (10 normal, more for admin — see lib/report-rooms.ts's getRoomCountForRole)
 * — the client never needs to know the account's role to render the right
 * number of tiles.
 */
export async function fetchReportRoomIndex(): Promise<RoomIndexEntry[]> {
  try {
    const response = await fetch("/api/reports/rooms");
    if (!response.ok) return [];
    const data = (await response.json()) as { rooms?: RoomIndexEntry[] };
    return Array.isArray(data.rooms) ? data.rooms : [];
  } catch (error) {
    console.debug("Report room index fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export type RoomContents =
  | { status: "empty"; report: null; cycleEndsAt: null }
  /**
   * Occupied, but the AI-enriched resave hasn't landed yet (see
   * lib/report-rooms.ts's own header comment) — the report itself
   * (title/similarity/etc.) is real and complete; only report.aiScore/
   * aiTone are still null. app/reports/rooms/[room]/room-page-shell.tsx
   * polls this endpoint until status flips to "ready" rather than ever
   * presenting this as "ready" — see that file's own header comment.
   */
  | { status: "processing"; report: ReportSummary; cycleEndsAt: string }
  | { status: "ready"; report: ReportSummary; cycleEndsAt: string };

const EMPTY_ROOM_CONTENTS: RoomContents = { status: "empty", report: null, cycleEndsAt: null };

/** One room's current occupant (at most one report) — fetched only when the user actually opens that room, never all rooms up front. */
export async function fetchReportRoomContents(room: number): Promise<RoomContents> {
  try {
    const response = await fetch(`/api/reports?room=${room}`);
    if (!response.ok) return EMPTY_ROOM_CONTENTS;
    const data = (await response.json()) as Partial<RoomContents>;
    if ((data.status === "ready" || data.status === "processing") && data.report) {
      return { status: data.status, report: data.report, cycleEndsAt: data.cycleEndsAt ?? new Date().toISOString() };
    }
    return EMPTY_ROOM_CONTENTS;
  } catch (error) {
    console.debug("Report room fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_ROOM_CONTENTS;
  }
}

/**
 * The one deliberate exception to "never fetch across all rooms at once": a
 * full account wipe (clearHistory in app/page.tsx) is a rare, explicit,
 * destructive action that genuinely needs every occupied room's report id,
 * not a browsing operation this feature's lazy-loading requirement is
 * about. Still only ever fetches the tiny index first, then each room's
 * single lightweight summary — never a full report body, and never more
 * network calls than this account actually has rooms. Includes
 * "processing" rooms too — a report mid-AI-analysis is still a real,
 * deletable row that a full wipe must not skip.
 */
export async function fetchAllReportSummariesAcrossRooms(): Promise<ReportSummary[]> {
  const index = await fetchReportRoomIndex();
  const contents = await Promise.all(index.map((entry) => fetchReportRoomContents(entry.room)));
  return contents.flatMap((c) => (c.status === "ready" || c.status === "processing" ? [c.report] : []));
}

/**
 * Always the real, complete report body — there is deliberately no
 * "lightweight/cached placeholder" mode here. Every caller that only needs
 * summary-shaped fields should use fetchReportRoomContents/
 * fetchAllReportSummariesAcrossRooms instead of calling this and discarding
 * most of the response.
 */
export async function fetchRemoteReport<T>(id: string): Promise<T | null> {
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch(`/api/reports/${encodeURIComponent(id)}?deviceKey=${encodeURIComponent(deviceKey)}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { payload?: T };
    return (data.payload ?? null) as T | null;
  } catch (error) {
    console.debug("Remote report fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function deleteRemoteReport(id: string): Promise<void> {
  try {
    const deviceKey = getDeviceKey();
    await fetch(`/api/reports/${encodeURIComponent(id)}?deviceKey=${encodeURIComponent(deviceKey)}`, { method: "DELETE" });
  } catch (error) {
    console.debug("Remote report delete failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Unlike deleteRemoteReport (fail-soft, for best-effort bulk cleanup), this
// reports success/failure instead of swallowing it — needed for a primary,
// user-initiated single-report delete, where silently failing while the UI
// navigates away as if it succeeded would leave a ghost row in the database.
export async function deleteRemoteReportChecked(id: string): Promise<boolean> {
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch(`/api/reports/${encodeURIComponent(id)}?deviceKey=${encodeURIComponent(deviceKey)}`, { method: "DELETE" });
    return response.ok;
  } catch (error) {
    console.debug("Remote report delete failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
