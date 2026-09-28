"use client";

import { Ban, BookMarked, CircleCheck, Copy, FileClock, Hourglass, Inbox, Layers, MinusCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ArchiveExplorerActivityEvent, ArchiveExplorerActivityKind } from "./archive-types";
import { ACTIVITY_LABEL, formatCount, formatDateTime, formatRelative } from "./archive-format";

const ICON: Record<ArchiveExplorerActivityKind, LucideIcon> = {
  admitted: Inbox,
  duplicate: Copy,
  rejected: Ban,
  review: FileClock,
  matured: Hourglass,
  indexed: CircleCheck,
  removed: MinusCircle,
  reference_added: BookMarked,
  legacy_added: Layers,
};

/**
 * Recent corpus activity — every event is derived from an existing
 * timestamp (decision time, T0 + maturity window, promotion indexing,
 * revocation, archive/legacy row creation). No event log of its own.
 */
export function ArchiveActivityFeed({
  events,
  referenceIso,
  onSelect,
}: {
  events: ArchiveExplorerActivityEvent[];
  referenceIso: string;
  onSelect: (sourceId: string) => void;
}) {
  if (events.length === 0) {
    return <p className="admin-corpus-empty">No corpus activity recorded yet.</p>;
  }
  return (
    <ol className="admin-archive-feed">
      {events.map((event, index) => {
        const Icon = ICON[event.kind];
        const body = (
          <>
            <span className={`admin-archive-feed-icon admin-archive-feed-icon--${event.kind}`}><Icon size={15} aria-hidden="true" /></span>
            <span className="admin-archive-feed-text">
              <span className="admin-archive-feed-title">{ACTIVITY_LABEL[event.kind]}</span>
              <span className="admin-archive-feed-subject">
                {event.count !== null ? `${formatCount(event.count)} · ` : ""}
                {event.label}
              </span>
            </span>
            <time className="admin-archive-feed-time" dateTime={event.at} title={formatDateTime(event.at)}>
              {formatRelative(event.at, referenceIso)}
            </time>
          </>
        );
        return (
          <li key={`${event.kind}-${event.sourceId ?? event.label}-${event.at}-${index}`}>
            {event.sourceId ? (
              <button type="button" className="admin-archive-feed-row" onClick={() => onSelect(event.sourceId as string)}>
                {body}
              </button>
            ) : (
              <div className="admin-archive-feed-row">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
