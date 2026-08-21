"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, FileText, FolderClock } from "lucide-react";
import type { ReportSummary } from "@/lib/reports-remote";
import { fetchReportRoom, fetchReportRoomIndex } from "@/lib/reports-remote";
import { getCachedRoom, getCachedRoomIndex, invalidateRoomCache, setCachedRoom, setCachedRoomIndex } from "@/lib/report-rooms-cache";
import { REPORT_ROOM_COUNT, reportRoomForId, type RoomIndexEntry } from "@/lib/report-rooms";
import { ReportHistoryRow } from "./report-history-row";
import type { SimilarityReport } from "@/lib/report-types";

/**
 * The 10-room architecture's UI: opening "My Reports" shows only the room
 * index (10 tiles, each just a count + most-recent date — one lightweight
 * query, 24h client-cached). Entering a room fetches only that room's
 * lightweight summaries (also 24h cached). Opening an actual report is a
 * plain <Link> to the existing /reports/[id] route (inside ReportHistoryRow),
 * which does its own, already-lazy, per-report server fetch — this
 * component never fetches a full report body itself.
 *
 * Deliberately does not preload the other 9 rooms, and does not eagerly
 * fetch a room's contents until the user opens it.
 *
 * newlySavedReportSummary exists to counter one specific gap the 24h cache
 * would otherwise have: if this account's room-index/room-contents cache is
 * still within its own TTL from earlier today, it was necessarily written
 * BEFORE a report the user just created in *this* session — a plain cache
 * read would silently omit it until the cache naturally expires. The fixups
 * below are a best-effort, self-correcting nudge (an accepted, cosmetic-only
 * imprecision: if the index happened to be freshly fetched rather than
 * cache-served, a room tile's count can read one-too-many until the next
 * real fetch) — never a source of truth. The server's own room-scoped
 * queries remain the actual source of truth for both counts and contents.
 */

type Props = {
  accountEmail: string;
  /** The just-saved report's lightweight summary; null once there is nothing new to reconcile. Identity (object reference) matters: pass a NEW object each time a save completes, even for the same id, so the effect below re-fires on an AI-score update too. */
  newlySavedReportSummary: ReportSummary | null;
  /** Called once this component has applied newlySavedReportSummary, so the parent can clear it back to null. Without this, an unrelated remount later (e.g. navigating away from "reports" and back) would see the same stale value and incorrectly re-apply it — re-auto-opening an old report's room and double-counting it. */
  onConsumedNewlySavedReport: () => void;
  onTotalCountChange: (total: number) => void;
  onDownloadReceipt: (report: SimilarityReport) => Promise<void>;
};

function upsertById(list: ReportSummary[], incoming: ReportSummary): ReportSummary[] {
  return [incoming, ...list.filter((item) => item.id !== incoming.id)];
}

function RoomSkeletonRows({ count }: { count: number }) {
  return (
    <div className="report-history" aria-busy="true" aria-live="polite">
      {Array.from({ length: count }, (_, i) => (
        <article key={i} className="history-skeleton-row">
          <div className="history-file-icon"><FileText aria-hidden="true" /></div>
          <div className="history-copy">
            <span className="skeleton-line skeleton-line-title" />
            <span className="skeleton-line skeleton-line-meta" />
          </div>
        </article>
      ))}
    </div>
  );
}

export function ReportRoomsBrowser({ accountEmail, newlySavedReportSummary, onConsumedNewlySavedReport, onTotalCountChange, onDownloadReceipt }: Props) {
  // A newly-saved report is only ever present at the moment generateReport()
  // just navigated here (view "reports" only mounts this component fresh) —
  // auto-opening its own room immediately reproduces the pre-rooms UX of
  // seeing the just-created report at the top of the list, without
  // requiring the user to first land on the bare room index and guess which
  // tile to click.
  const initialRoom = useRef(newlySavedReportSummary ? reportRoomForId(newlySavedReportSummary.id) : null).current;

  const [roomIndex, setRoomIndex] = useState<RoomIndexEntry[] | null>(null);
  const [indexLoading, setIndexLoading] = useState(true);
  const [selectedRoom, setSelectedRoom] = useState<number | null>(initialRoom);
  const [roomContents, setRoomContents] = useState<ReportSummary[] | null>(null);
  const [roomLoading, setRoomLoading] = useState(initialRoom !== null);
  const appliedSummaryRef = useRef<ReportSummary | null>(null);

  async function openRoom(room: number) {
    setSelectedRoom(room);
    const cached = getCachedRoom(accountEmail, room);
    if (cached) {
      setRoomContents(cached);
      setRoomLoading(false);
      return;
    }
    setRoomContents(null);
    setRoomLoading(true);
    const fresh = await fetchReportRoom(room);
    setCachedRoom(accountEmail, room, fresh);
    setRoomContents(fresh);
    setRoomLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    async function loadIndex() {
      const cached = getCachedRoomIndex(accountEmail);
      if (cached) {
        setRoomIndex(cached);
        setIndexLoading(false);
        return;
      }
      setIndexLoading(true);
      const fresh = await fetchReportRoomIndex();
      if (cancelled) return;
      setCachedRoomIndex(accountEmail, fresh);
      setRoomIndex(fresh);
      setIndexLoading(false);
    }
    loadIndex();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountEmail]);

  useEffect(() => {
    if (initialRoom === null) return;
    openRoom(initialRoom);
    // Mount-only: openRoom's later, user-driven calls are handled by the
    // click handlers below, not this effect re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalCount = useMemo(() => roomIndex?.reduce((sum, entry) => sum + entry.count, 0) ?? 0, [roomIndex]);
  useEffect(() => {
    if (roomIndex) onTotalCountChange(totalCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomIndex, totalCount]);

  useEffect(() => {
    if (!newlySavedReportSummary || newlySavedReportSummary === appliedSummaryRef.current) return;
    const room = reportRoomForId(newlySavedReportSummary.id);
    const isFirstTimeSeeingThisId = appliedSummaryRef.current?.id !== newlySavedReportSummary.id;

    // A cache hit (see openRoom/the index-loading effect) resolves
    // asynchronously — on the very first render after mount, roomContents/
    // roomIndex can still be null even though a fetch is already in flight.
    // Wait for whichever of the two this reconciliation actually needs
    // before consuming the signal, or a stale cache would silently never
    // get corrected (the signal would already be gone by the time the data
    // arrives).
    const needsRoomContents = selectedRoom === room;
    const needsIndexBump = isFirstTimeSeeingThisId;
    if ((needsRoomContents && roomContents === null) || (needsIndexBump && roomIndex === null)) return;

    appliedSummaryRef.current = newlySavedReportSummary;

    if (needsRoomContents && roomContents) {
      setRoomContents(upsertById(roomContents, newlySavedReportSummary));
    }
    if (needsIndexBump && roomIndex) {
      invalidateRoomCache(accountEmail, room);
      setRoomIndex(roomIndex.map((entry) => (entry.room === room ? { ...entry, count: entry.count + 1, mostRecentAt: newlySavedReportSummary.createdAt } : entry)));
    }
    onConsumedNewlySavedReport();
  }, [newlySavedReportSummary, roomContents, roomIndex, selectedRoom, accountEmail, onConsumedNewlySavedReport]);

  if (selectedRoom !== null) {
    const roomEntry = roomIndex?.find((entry) => entry.room === selectedRoom);
    return (
      <div className="report-rooms-view">
        <button className="button subtle report-room-back" type="button" onClick={() => { setSelectedRoom(null); setRoomContents(null); }}>
          <ChevronLeft aria-hidden="true" /> Back to rooms
        </button>
        <h3 className="report-room-heading">
          Room {selectedRoom + 1}
          {roomContents ? ` · ${roomContents.length} report${roomContents.length === 1 ? "" : "s"}` : roomEntry ? ` · ${roomEntry.count} report${roomEntry.count === 1 ? "" : "s"}` : ""}
        </h3>
        {roomLoading || roomContents === null ? (
          <RoomSkeletonRows count={Math.min(6, roomEntry?.count || 3)} />
        ) : roomContents.length === 0 ? (
          <div className="empty-reports">
            <FolderClock aria-hidden="true" />
            <h3>No reports in this room</h3>
          </div>
        ) : (
          <div className="report-history">
            {roomContents.map((report) => (
              <ReportHistoryRow key={report.id} report={report} onDownloadReceipt={onDownloadReceipt} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (indexLoading || !roomIndex) {
    return (
      <div className="report-rooms-grid" aria-busy="true" aria-live="polite">
        {Array.from({ length: REPORT_ROOM_COUNT }, (_, room) => (
          <div key={room} className="report-room-tile report-room-tile-skeleton">
            <span className="skeleton-line skeleton-line-title" />
            <span className="skeleton-line skeleton-line-meta" />
          </div>
        ))}
      </div>
    );
  }

  if (totalCount === 0) {
    return (
      <div className="empty-reports">
        <FolderClock aria-hidden="true" />
        <h3>No reports yet</h3>
        <p>Your reports will appear here after you check a document.</p>
      </div>
    );
  }

  return (
    <div className="report-rooms-grid">
      {roomIndex.map((entry) => (
        <button key={entry.room} type="button" className="report-room-tile" onClick={() => openRoom(entry.room)} disabled={entry.count === 0}>
          <strong>Room {entry.room + 1}</strong>
          <span>{entry.count} report{entry.count === 1 ? "" : "s"}</span>
          {entry.mostRecentAt && <small>Most recent {new Date(entry.mostRecentAt).toLocaleDateString("en-GB")}</small>}
        </button>
      ))}
    </div>
  );
}
