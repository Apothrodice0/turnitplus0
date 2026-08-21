import { getDeviceKey } from "./device-key";
import { REPORT_ROOM_COUNT, type RoomIndexEntry } from "./report-rooms";

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
   * with quotaExceeded is new and different: it is not transient, so
   * generateReport() surfaces it to the user instead of treating it like
   * every other silent remote-save failure.
   */
  | { ok: false; status: number; quotaExceeded: boolean; error?: string; resetsAt?: string };

/**
 * `academicSearchDiagnosticsId` is sent as a sibling of `payload`, never
 * nested inside it — it must never become part of SimilarityReport/
 * saved_reports.payload_json. It is only ever a bare row id (see
 * app/api/academic-evidence/route.ts's own header comment for why the raw
 * diagnostic content itself is persisted server-side and never sent to this
 * client at all) — app/api/reports/route.ts uses it to link that
 * already-persisted row to this report, once both exist.
 */
export async function saveReportRemote<T>(report: T, summary: ReportSummary, academicSearchDiagnosticsId?: number | null): Promise<SaveReportRemoteResult> {
  try {
    const deviceKey = getDeviceKey();
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceKey, ...summary, payload: report, academicSearchDiagnosticsId: academicSearchDiagnosticsId ?? null }),
    });
    if (!response.ok) {
      console.debug("Remote report save was rejected (local copy is unaffected).", { status: response.status });
      const body = (await response.json().catch(() => null)) as { error?: string; resetsAt?: string } | null;
      // Distinguished from the IP rate limiter's own 429 (checkRate in
      // app/api/reports/route.ts, `{ error: 'Too many requests' }`, no
      // resetsAt) by the presence of resetsAt — only the daily upload quota
      // response includes it. The rate limiter's 429 stays in the existing
      // silent/fail-soft category; only a real quota-exceeded is surfaced.
      const quotaExceeded = response.status === 429 && typeof body?.resetsAt === "string";
      return { ok: false, status: response.status, quotaExceeded, error: body?.error, resetsAt: body?.resetsAt };
    }
    return { ok: true };
  } catch (error) {
    console.debug("Remote report save failed (local copy is unaffected).", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, status: 0, quotaExceeded: false };
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
 * The 10-room architecture's index fetch — see app/api/reports/rooms/route.ts's
 * own header comment. This is the ONLY report-related network call "opening
 * My Reports" makes for an authenticated account (client-side cached for
 * 24h — see lib/report-rooms-cache.ts); it never returns the reports
 * themselves, only a count/most-recent-timestamp per room.
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

/** One room's lightweight summaries — fetched only when the user actually opens that room, never all 10 up front. */
export async function fetchReportRoom(room: number): Promise<ReportSummary[]> {
  try {
    const response = await fetch(`/api/reports?room=${room}`);
    if (!response.ok) return [];
    const data = (await response.json()) as { reports?: ReportSummary[] };
    return Array.isArray(data.reports) ? data.reports : [];
  } catch (error) {
    console.debug("Report room fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * The one deliberate exception to "never fetch across all rooms at once":
 * a full account wipe (clearHistory in app/page.tsx) is a rare, explicit,
 * destructive action that genuinely needs every report's id, not a browsing
 * operation this feature's lazy-loading requirement is about. Still only
 * lightweight summaries, never full report bodies.
 */
export async function fetchAllReportSummariesAcrossRooms(): Promise<ReportSummary[]> {
  const perRoom = await Promise.all(Array.from({ length: REPORT_ROOM_COUNT }, (_, room) => fetchReportRoom(room)));
  return perRoom.flat();
}

/**
 * Always the real, complete report body — there is deliberately no
 * "lightweight/cached placeholder" mode here. That was an earlier,
 * competing approach (masquerading a ReportSummary as a fake full report to
 * avoid an N+1 fetch loop); it is unnecessary now that the 10-room
 * architecture already solves the N+1 problem at its source — a room's
 * lightweight list comes from one real fetchReportRoom() call, never a loop
 * of per-report fetches — so every caller of this function genuinely wants,
 * and gets, real data. Callers that only need summary-shaped fields should
 * use fetchReportRoom/fetchAllReportSummariesAcrossRooms instead of calling
 * this and discarding most of the response.
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
