"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { fetchReportRoomIndex } from "@/lib/reports-remote";
import { getCachedRoomIndex, setCachedRoomIndex } from "@/lib/report-rooms-cache";
import type { RoomIndexEntry, RoomStatus } from "@/lib/report-rooms";

/**
 * My Reports' room directory: a plain vertical list of rooms, one row per
 * room, nothing else. This component fetches ONLY the lightweight room
 * index (status + timestamps per room) and never a report's actual data —
 * see app/api/reports/rooms/route.ts's own header comment for that query.
 * Clicking a row is a real navigation to that room's own dedicated page
 * (app/reports/rooms/[room]/page.tsx), which fetches and owns that one
 * room's data (and the upload flow, for an empty room). This component
 * itself never renders a report, never renders the upload panel, and never
 * fetches any other room's data — there is deliberately no expand/accordion
 * state here at all.
 */

type Props = {
  accountEmail: string;
  onTotalCountChange: (total: number) => void;
};

function statusLabel(status: RoomStatus): string {
  if (status === "ready") return "Report ready";
  if (status === "processing") return "Processing…";
  if (status === "failed") return "AI check failed — tap to retry";
  return "Ready for a new check";
}

function RoomRowSkeleton() {
  return (
    <div className="report-room-row report-room-row-skeleton" aria-busy="true" aria-live="polite">
      <span className="skeleton-line skeleton-line-title" />
      <span className="skeleton-line skeleton-line-meta" />
    </div>
  );
}

export function ReportRoomsBrowser({ accountEmail, onTotalCountChange }: Props) {
  const [roomIndex, setRoomIndex] = useState<RoomIndexEntry[] | null>(null);
  const [indexLoading, setIndexLoading] = useState(true);
  // Production bug fix: a failed index fetch (429/500/timeout/network
  // error) must render as its own honest retry state — never as an empty
  // room directory (which would look identical to "you have zero rooms,"
  // impossible for a real account) and never anything that touches or
  // implies the account's own signed-in state, which lives entirely in the
  // parent (app/page.tsx) and this component never sees, let alone clears.
  const [indexError, setIndexError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function loadIndex() {
      const cached = getCachedRoomIndex(accountEmail);
      if (cached) {
        setRoomIndex(cached);
        setIndexLoading(false);
        setIndexError(false);
        return;
      }
      setIndexLoading(true);
      setIndexError(false);
      const result = await fetchReportRoomIndex();
      if (cancelled) return;
      if (result.ok) {
        setCachedRoomIndex(accountEmail, result.rooms);
        setRoomIndex(result.rooms);
      } else {
        setIndexError(true);
      }
      setIndexLoading(false);
    }
    loadIndex();
    return () => {
      cancelled = true;
    };
  }, [accountEmail, retryToken]);

  useEffect(() => {
    if (roomIndex) onTotalCountChange(roomIndex.filter((entry) => entry.status !== "empty").length);
  }, [roomIndex, onTotalCountChange]);

  if (indexError) {
    return (
      <section className="ai-analysis-message" role="status">
        <strong>—</strong>
        <div>
          <p>Couldn&apos;t load your rooms right now. You&apos;re still signed in — this is just a temporary connection issue.</p>
          <button className="button secondary" type="button" onClick={() => setRetryToken((token) => token + 1)}>Try again</button>
        </div>
      </section>
    );
  }

  if (indexLoading || !roomIndex) {
    return (
      <div className="report-rooms-list" aria-busy="true" aria-live="polite">
        {Array.from({ length: 10 }, (_, room) => <RoomRowSkeleton key={room} />)}
      </div>
    );
  }

  return (
    <div className="report-rooms-list">
      {/* prefetch=false: every room row renders at once (up to 40 for an
          admin account), and each is a force-dynamic page that does a real
          rate-limited DB read (see app/reports/rooms/[room]/page.tsx). Next's
          default viewport prefetching would fire all of those the instant
          this list is visible, burning the account's own rate-limit budget
          before any room is actually opened. */}
      {roomIndex.map((entry) => (
        <Link
          key={entry.room}
          href={`/reports/rooms/${entry.room}`}
          className={`report-room-row report-room-row-${entry.status}`}
          prefetch={false}
        >
          <span className="report-room-row-label">
            <strong>Room {entry.room + 1}</strong>
            <span className="report-room-row-status">
              {statusLabel(entry.status)}
              {entry.mostRecentAt && ` · Last checked ${new Date(entry.mostRecentAt).toLocaleDateString("en-GB")}`}
            </span>
          </span>
          <ChevronRight aria-hidden="true" className="report-room-row-chevron" />
        </Link>
      ))}
    </div>
  );
}
