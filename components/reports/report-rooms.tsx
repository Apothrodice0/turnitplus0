"use client";

import { useEffect, useRef, useState } from "react";
import type { ReportSummary } from "@/lib/reports-remote";
import { fetchReportRoomContents, fetchReportRoomIndex, type RoomContents } from "@/lib/reports-remote";
import { getCachedRoom, getCachedRoomIndex, invalidateRoomCache, setCachedRoom, setCachedRoomIndex } from "@/lib/report-rooms-cache";
import type { RoomIndexEntry } from "@/lib/report-rooms";
import { ReportHistoryRow } from "./report-history-row";
import type { SimilarityReport } from "@/lib/report-types";

/**
 * The room/slot architecture's UI: opening "My Reports" shows only the room
 * index (however many rows this account has, each just a status + last-used
 * date — one lightweight query, 24h client-cached), rendered as a single
 * vertical list — every room is always visible as its own row, never a
 * grid of cards. Opening a room (clicking its row) fetches only that one
 * room's single current occupant, if any (also 24h cached), and expands
 * that row in place — every other row stays exactly as it was, collapsed,
 * with no data fetched for it.
 *
 * Each room is a real upload SLOT, not a browsable list: it holds at most
 * one current report. An empty row shows "Ready for a new check" and a
 * "New check" action that expands to the upload panel — this is the ONLY
 * place an authenticated account can start a new check; there is
 * deliberately no standalone "New check" action on My Reports itself (see
 * app/page.tsx, which no longer renders one when `account` is set). A row
 * with a report shows a "View report" action that expands to that report's
 * information via the same ReportHistoryRow used by the anonymous flat
 * list.
 *
 * Deliberately does not preload the other rooms, and does not eagerly fetch
 * a room's contents until the user opens it. Only one row is expanded at a
 * time (opening a different room collapses whichever was open).
 *
 * newlySavedReportSummary exists to counter one specific gap the 24h cache
 * would otherwise have: if this account's room-index/room-contents cache is
 * still within its own TTL from earlier today, it was necessarily written
 * BEFORE a report the user just created in *this* session — a plain cache
 * read would silently omit it until the cache naturally expires. app/page.tsx
 * only ever sets this AFTER confirming the remote save actually succeeded
 * (never optimistically on a save that is still in flight or that failed) —
 * showing a report here that the server doesn't actually have is exactly
 * the bug that made /reports/[id] 404 for reports still visible in a room.
 */

type NewlySavedReport = ReportSummary & { room: number };

type Props = {
  accountEmail: string;
  newlySavedReportSummary: NewlySavedReport | null;
  onConsumedNewlySavedReport: () => void;
  onTotalCountChange: (total: number) => void;
  onDownloadReceipt: (report: SimilarityReport) => Promise<void>;
  renderUploadPanel: (room: number) => React.ReactNode;
  /** Fired every time a room is opened (cache hit or fresh fetch), with its resolved status — lets app/page.tsx know which room a new check should be tagged to. */
  onRoomOpened: (room: number, status: "empty" | "ready") => void;
};

function RoomRowSkeleton() {
  return (
    <div className="report-room-row report-room-row-skeleton" aria-busy="true" aria-live="polite">
      <span className="skeleton-line skeleton-line-title" />
      <span className="skeleton-line skeleton-line-meta" />
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="report-history" aria-busy="true" aria-live="polite">
      <article className="history-skeleton-row">
        <div className="history-file-icon" />
        <div className="history-copy">
          <span className="skeleton-line skeleton-line-title" />
          <span className="skeleton-line skeleton-line-meta" />
        </div>
      </article>
    </div>
  );
}

export function ReportRoomsBrowser({ accountEmail, newlySavedReportSummary, onConsumedNewlySavedReport, onTotalCountChange, onDownloadReceipt, renderUploadPanel, onRoomOpened }: Props) {
  // A newly-saved report is only ever present at the moment generateReport()
  // just confirmed the remote save succeeded (view "reports" only mounts
  // this component fresh) — auto-expanding its own row immediately
  // reproduces the pre-rooms UX of seeing the just-created report right
  // away, without requiring the user to first scan the list for it.
  const initialRoom = useRef(newlySavedReportSummary ? newlySavedReportSummary.room : null).current;

  const [roomIndex, setRoomIndex] = useState<RoomIndexEntry[] | null>(null);
  const [indexLoading, setIndexLoading] = useState(true);
  const [selectedRoom, setSelectedRoom] = useState<number | null>(initialRoom);
  const [roomContents, setRoomContents] = useState<RoomContents | null>(null);
  const [roomLoading, setRoomLoading] = useState(initialRoom !== null);
  const appliedSummaryRef = useRef<ReportSummary | null>(null);

  async function openRoom(room: number) {
    setSelectedRoom(room);
    const cached = getCachedRoom(accountEmail, room);
    if (cached) {
      setRoomContents(cached);
      setRoomLoading(false);
      onRoomOpened(room, cached.status);
      return;
    }
    setRoomContents(null);
    setRoomLoading(true);
    const fresh = await fetchReportRoomContents(room);
    setCachedRoom(accountEmail, room, fresh);
    setRoomContents(fresh);
    setRoomLoading(false);
    onRoomOpened(room, fresh.status);
  }

  function toggleRoom(room: number) {
    if (selectedRoom === room) {
      setSelectedRoom(null);
      setRoomContents(null);
      return;
    }
    openRoom(room);
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

  useEffect(() => {
    if (roomIndex) onTotalCountChange(roomIndex.filter((entry) => entry.status === "ready").length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomIndex]);

  useEffect(() => {
    if (!newlySavedReportSummary || newlySavedReportSummary === appliedSummaryRef.current) return;
    const room = newlySavedReportSummary.room;
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

    const cycleEndsAt = new Date(Date.parse(newlySavedReportSummary.createdAt) + 24 * 60 * 60 * 1000).toISOString();
    if (needsRoomContents) {
      const fresh: RoomContents = { status: "ready", report: newlySavedReportSummary, cycleEndsAt };
      setRoomContents(fresh);
      setCachedRoom(accountEmail, room, fresh);
    }
    if (needsIndexBump && roomIndex) {
      invalidateRoomCache(accountEmail, room);
      setRoomIndex(roomIndex.map((entry) => (entry.room === room ? { ...entry, status: "ready" as const, mostRecentAt: newlySavedReportSummary.createdAt, cycleEndsAt } : entry)));
    }
    onConsumedNewlySavedReport();
  }, [newlySavedReportSummary, roomContents, roomIndex, selectedRoom, accountEmail, onConsumedNewlySavedReport]);

  if (indexLoading || !roomIndex) {
    return (
      <div className="report-rooms-list" aria-busy="true" aria-live="polite">
        {Array.from({ length: 10 }, (_, room) => <RoomRowSkeleton key={room} />)}
      </div>
    );
  }

  return (
    <div className="report-rooms-list">
      {roomIndex.map((entry) => {
        const isOpen = selectedRoom === entry.room;
        return (
          <div key={entry.room} className={`report-room-row ${entry.status === "ready" ? "report-room-row-ready" : "report-room-row-empty"} ${isOpen ? "report-room-row-open" : ""}`}>
            <button type="button" className="report-room-row-header" onClick={() => toggleRoom(entry.room)} aria-expanded={isOpen}>
              <span className="report-room-row-label">
                <strong>Room {entry.room + 1}</strong>
                <span className="report-room-row-status">
                  {entry.status === "ready" ? "Report ready" : "Ready for a new check"}
                  {entry.mostRecentAt && ` · Last checked ${new Date(entry.mostRecentAt).toLocaleDateString("en-GB")}`}
                </span>
              </span>
              <span className="button subtle report-room-row-action">
                {entry.status === "ready" ? "View report" : "New check"}
              </span>
            </button>
            {isOpen && (
              <div className="report-room-row-detail">
                {roomLoading || roomContents === null ? (
                  <DetailSkeleton />
                ) : roomContents.status === "empty" ? (
                  <div className="room-empty-slot">
                    {entry.status === "ready" && (
                      <p className="room-cycle-note">This slot's previous check has expired and is ready for a new one.</p>
                    )}
                    {renderUploadPanel(entry.room)}
                  </div>
                ) : (
                  <div className="report-history">
                    <ReportHistoryRow report={roomContents.report} onDownloadReceipt={onDownloadReceipt} />
                    <p className="room-cycle-note">
                      This room can accept a new check after {new Date(roomContents.cycleEndsAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
