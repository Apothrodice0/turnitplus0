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
  /**
   * The room/slot architecture's genuine AI-lifecycle signal (production
   * audit fix) — 'processing' | 'ready' | 'failed', set explicitly by
   * app/reports/rooms/[room]/room-page-shell.tsx at each save. Optional:
   * absent for the anonymous flat-list flow (app/page.tsx's own
   * generateReport, which has no room concept and never sets this) and for
   * any report saved before this field existed. See
   * lib/report-rooms.ts's deriveRoomStatus for how a room's overall status
   * falls back cleanly when this is absent.
   */
  aiStatus?: "processing" | "ready" | "failed";
  /**
   * Release-hardening audit finding SIM-01, SIM-03: lib/report-types.ts's
   * buildReportSummary() sets this from primarySimilarityScore(report) —
   * the SAME combined-result selection the detail page's headline/sidebar
   * use — whenever the caller already had a full SimilarityReport in hand
   * (a just-generated or just-AI-completed report). lib/reports-repo.ts's
   * findRoomOccupant ALSO sets it (as of SIM-03/SIM-04) — cheaply, via
   * json_extract against the write-time-finalized payload_json (see
   * app/api/reports/route.ts's POST handler), never by recomputing
   * anything. `archiveScore` itself is NEVER changed by this field's
   * existence (still the pure archive-only value other readers of the
   * persisted column, e.g. lib/developer-repo.ts, depend on) — this is
   * purely an additive display hint. Absent, or similarityStatus below not
   * "resolved", means "do not trust this as final — fall back to
   * archiveScore," never "zero."
   */
  primaryScore?: number;
  /** True when primaryScore reflects the full unified result rather than the archive-only fallback — see primaryScore's own comment. Absent/false with primaryScore also absent means the same thing: nothing more precise than archiveScore is known at this call site. */
  isUnified?: boolean;
  /**
   * Release-hardening audit finding SIM-04, widened by LIFECYCLE-06
   * (corrected): the SAME four-way status
   * lib/report-primary-similarity.ts's resolvePersistedSimilarityDisplay
   * returns — "resolved" (primaryScore is trustworthy, whether combined or
   * a definitive archive-only answer), "stale" (a real combined result IS
   * persisted, but corpus_match_generation has moved on, or
   * CORPUS_SOURCE_MATCHING_ENABLED was rolled back ON since computation —
   * show "Updating similarity…" rather than primaryScore), "pending"
   * (unifiedSimilarity has never been persisted for this report at all,
   * and no terminal failure recorded either — show neutral loading, never
   * primaryScore as if it were final), or "failed" (a genuine, persisted,
   * reproducible computation failure — see resolvePrimarySimilaritySummary's
   * own `failed` field's investigation of what does/doesn't set it — show
   * "Unavailable," never a number, never inferred from client poll timing).
   * Absent only for a caller that predates this field (client-built
   * summaries via buildReportSummary always set it); a "processing" room
   * occupant never gets this far (see findRoomOccupant's own scoping
   * comment), so it is simply omitted there — the UI already shows
   * "Analyzing…" for that case regardless.
   */
  similarityStatus?: "resolved" | "stale" | "pending" | "failed";
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
 *
 * Production bug fix: a failed request (429/500/timeout/network error) used
 * to silently become `[]` — indistinguishable from "this account genuinely
 * has zero rooms," which can't actually happen for a real authenticated
 * account (every account gets 10-40 room entries, even if all are
 * "empty"). Rendered as a real, empty-looking room directory instead of the
 * transient failure it actually was, and callers had no way to tell "the
 * request failed" apart from "you're signed out" or "there's nothing here"
 * — both of which are separate, distinct facts a failed HTTP request can
 * never actually prove. This now returns a discriminated result instead, so
 * a caller can render an honest retry state and keep the account's
 * signed-in UI intact.
 */
export type RoomIndexFetchResult =
  | { ok: true; rooms: RoomIndexEntry[] }
  | { ok: false; status: number | null };

export async function fetchReportRoomIndex(): Promise<RoomIndexFetchResult> {
  try {
    const response = await fetch("/api/reports/rooms");
    if (!response.ok) return { ok: false, status: response.status };
    const data = (await response.json()) as { rooms?: RoomIndexEntry[] };
    return { ok: true, rooms: Array.isArray(data.rooms) ? data.rooms : [] };
  } catch (error) {
    console.debug("Report room index fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, status: null };
  }
}

export type RoomContents =
  | { status: "empty"; report: null; cycleEndsAt: null }
  /**
   * Occupied, but the AI-enriched resave hasn't landed yet (see
   * lib/report-rooms.ts's own header comment) — the report itself
   * (title/similarity/etc.) is real and complete; only report.aiScore/
   * aiTone are still null. app/reports/rooms/[room]/room-page-shell.tsx
   * polls this endpoint until status flips to "ready" or "failed" rather
   * than ever presenting this as "ready" — see that file's own header
   * comment.
   */
  | { status: "processing"; report: ReportSummary; cycleEndsAt: string }
  | { status: "ready"; report: ReportSummary; cycleEndsAt: string }
  /**
   * The AI-enriched resave landed, but with a genuine non-transient outcome
   * other than a real score (production audit fix — see
   * lib/report-rooms.ts's own header comment on "failed"). The similarity
   * result is unaffected and still shown; only the AI signal is missing,
   * with a retry offered.
   */
  | { status: "failed"; report: ReportSummary; cycleEndsAt: string };

const EMPTY_ROOM_CONTENTS: RoomContents = { status: "empty", report: null, cycleEndsAt: null };

/**
 * Production bug fix — see fetchReportRoomIndex's own comment for the full
 * rationale, which applies identically here: a failed request used to
 * silently become EMPTY_ROOM_CONTENTS, indistinguishable from "this room is
 * genuinely empty." For app/reports/rooms/[room]/room-page-shell.tsx's own
 * polling loop specifically, that meant a single transient failure mid-poll
 * could look like the room's occupant vanished. Callers now get a real
 * ok:false and decide for themselves (retry, keep polling, show an error).
 */
export type RoomContentsFetchResult =
  | { ok: true; contents: RoomContents }
  | { ok: false; status: number | null };

/** One room's current occupant (at most one report) — fetched only when the user actually opens that room, never all rooms up front. */
export async function fetchReportRoomContents(room: number): Promise<RoomContentsFetchResult> {
  try {
    const response = await fetch(`/api/reports?room=${room}`);
    if (!response.ok) return { ok: false, status: response.status };
    const data = (await response.json()) as Partial<RoomContents>;
    if ((data.status === "ready" || data.status === "processing" || data.status === "failed") && data.report) {
      return { ok: true, contents: { status: data.status, report: data.report, cycleEndsAt: data.cycleEndsAt ?? new Date().toISOString() } };
    }
    return { ok: true, contents: EMPTY_ROOM_CONTENTS };
  } catch (error) {
    console.debug("Report room fetch failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, status: null };
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
 * "processing" and "failed" rooms too — either way it's still a real,
 * deletable row that a full wipe must not skip.
 */
export async function fetchAllReportSummariesAcrossRooms(): Promise<ReportSummary[]> {
  const indexResult = await fetchReportRoomIndex();
  if (!indexResult.ok) return [];
  const contentsResults = await Promise.all(indexResult.rooms.map((entry) => fetchReportRoomContents(entry.room)));
  return contentsResults.flatMap((r) => (r.ok && r.contents.status !== "empty" ? [r.contents.report] : []));
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
