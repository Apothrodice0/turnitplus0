"use client";

import { useEffect, useReducer, useTransition, useState } from "react";
import type { MouseEvent } from "react";
import { useRouter } from "next/navigation";
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
 *
 * Production bug fix: a room click used to be a bare <Link>, with no
 * pending/disabled state at all. That route's target (app/reports/rooms/
 * [room]/page.tsx) is a force-dynamic server component doing a real DB
 * round trip, so a slow or cold-started request left the OLD page fully
 * interactive for however long that took — nothing stopped a user from
 * clicking other rooms while waiting, each an independent, un-deduped
 * navigation. Whichever one happened to resolve last then silently won,
 * overriding whatever the user was already looking at.
 *
 * roomNavReducer below is the single source of truth for the whole
 * pending/stuck/idle lifecycle — deliberately a plain, DOM-free reducer
 * (not scattered useState flags) so every transition (activate, timeout,
 * settle) can be driven and asserted directly with an explicit event
 * sequence, without racing real timers or simulating clicks (this repo has
 * no jsdom/click-simulation infrastructure — see
 * tests/report-historical-ui-consolidation.test.mjs's own "J" test for the
 * same documented limitation). A discriminated union (never a bare
 * `pendingRoom`+`stuck` pair) makes an impossible combination — "stuck" with
 * no room, e.g — unrepresentable rather than merely untested.
 *
 * Deliberately NO route-level loading.tsx for app/reports/rooms/[room]/:
 * that page calls notFound() for an invalid room number, and a loading.tsx
 * there would flush an initial 200 (the fallback) before the async page
 * component resolves and decides notFound() — the eventual 404 could then
 * only patch the DOM client-side, never change the already-sent status
 * code. tests/report-detail-route.test.mjs documents this exact tradeoff
 * for the sibling /reports/[id] route, which has the same constraint for
 * the same reason; the pending state below is this route's answer to "show
 * feedback immediately" instead, entirely client-side, with no effect on
 * SSR status codes.
 */

export type RoomNavState =
  | { phase: "idle" }
  | { phase: "pending"; room: number; href: string }
  | { phase: "stuck"; room: number; href: string };

export type RoomNavEvent =
  | { type: "ACTIVATE"; room: number; href: string }
  | { type: "TIMEOUT" }
  | { type: "SETTLED" };

export const IDLE_NAV_STATE: RoomNavState = { phase: "idle" };

/**
 * Pure reducer for the whole lifecycle. Correction (post-review): the
 * original 30s safety-net timeout cleared pendingRoom outright, which would
 * have let a DIFFERENT room start a second, real router.push while the
 * first's underlying fetch could still resolve later — reintroducing
 * exactly the "whichever one resolves last silently wins" bug this fix
 * exists to remove, just delayed by 30s instead of immediate. TIMEOUT here
 * only ever moves "pending" -> "stuck" for the SAME room/href — it never
 * clears the state, so ACTIVATE for any room (including the original)
 * keeps refusing exactly as it does in "pending". "stuck" only ever
 * resolves back to "idle" via SETTLED (see the isPending effect below) or a
 * hard navigation (window.location.assign — see handleRetry), never via
 * another dispatched event.
 */
export function roomNavReducer(state: RoomNavState, event: RoomNavEvent): RoomNavState {
  switch (event.type) {
    case "ACTIVATE":
      // Refuses from "pending" AND "stuck" alike — a different room can
      // never preempt either, and the same room can't double-push either.
      if (state.phase !== "idle") return state;
      return { phase: "pending", room: event.room, href: event.href };
    case "TIMEOUT":
      if (state.phase !== "pending") return state; // already stuck, or nothing pending — no-op
      return { phase: "stuck", room: state.room, href: state.href };
    case "SETTLED":
      return state.phase === "idle" ? state : IDLE_NAV_STATE;
    default:
      return state;
  }
}

export function canActivateRoom(state: RoomNavState): boolean {
  return state.phase === "idle";
}

/**
 * Whether a just-settled transition (isPending flipping to false) should
 * dispatch SETTLED. Kept pure for the same testability reason as the
 * reducer above. "Settled while this component is still mounted" always
 * means recovery, never a race with a successful navigation — a successful
 * push to the target room unmounts this whole component before this could
 * ever fire, whether or not the wait had already crossed into "stuck".
 */
export function shouldRecoverFromSettledTransition(isPending: boolean, state: RoomNavState): boolean {
  return !isPending && state.phase !== "idle";
}

// Safety net only — the primary recovery path is the isPending effect
// below, which fires on a genuine settle at 5s or 35s alike. This exists
// specifically for a request that never settles at all: the exact
// production symptom this fix responds to (a room click with no feedback
// for up to ~20s, nothing else recovering it). Well past any realistic
// legitimate wait, so it never fires during normal use.
const STUCK_NAVIGATION_TIMEOUT_MS = 30_000;

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
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [navState, dispatch] = useReducer(roomNavReducer, IDLE_NAV_STATE);
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

  // Recovery: fires on a genuine settle, whether that happens before or
  // after the 30s mark — "stuck" is not a dead end, only a label change,
  // exactly as "pending" is. See shouldRecoverFromSettledTransition's own
  // comment for why this never races a successful navigation away.
  useEffect(() => {
    if (shouldRecoverFromSettledTransition(isPending, navState)) dispatch({ type: "SETTLED" });
  }, [isPending, navState]);

  // Safety-net timer: schedules exactly once per entry into "pending" (the
  // effect's own dependency is the navState object itself, which React only
  // gives a new identity to on an actual dispatch — TIMEOUT firing, or
  // navState leaving "pending", both change identity and run this effect's
  // cleanup first) — never reschedules while already "stuck", and is always
  // cleared (window.clearTimeout) on unmount or on any further navState
  // change, so a stale timer can never fire against a later, unrelated
  // pending room.
  useEffect(() => {
    if (navState.phase !== "pending") return;
    const timer = window.setTimeout(() => dispatch({ type: "TIMEOUT" }), STUCK_NAVIGATION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [navState]);

  function handleRoomActivate(event: MouseEvent<HTMLAnchorElement>, room: number, href: string) {
    // Preserve native browser behavior for modified/non-primary clicks
    // (ctrl/cmd/middle-click to open in a new tab, etc.) — only a plain
    // primary activation (mouse or keyboard; a keyboard-triggered click on
    // a focused <a> reports button 0 the same as a primary mouse click) is
    // ever intercepted below.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (!canActivateRoom(navState)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    dispatch({ type: "ACTIVATE", room, href });
    startTransition(() => {
      router.push(href);
    });
  }

  // The only way out of "stuck" besides a genuine settle — a real hard
  // navigation, not another router.push (a second SPA transition here would
  // be exactly the double-request this fix removes). navState.href is
  // provably the ORIGINAL target: TIMEOUT carries it over unchanged from
  // "pending", and no event can overwrite a "stuck" state's room/href
  // before SETTLED resets to idle — see roomNavReducer's own comment.
  function handleRetry() {
    if (navState.phase === "stuck") window.location.assign(navState.href);
  }

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
      {roomIndex.map((entry) => {
        const href = `/reports/rooms/${entry.room}`;
        const isThisTarget = navState.phase !== "idle" && navState.room === entry.room;
        const isThisStuck = isThisTarget && navState.phase === "stuck";
        // Every OTHER row while anything is pending or stuck — never
        // functionally clickable (canActivateRoom refuses it regardless),
        // and marked inert for assistive tech too rather than silently
        // ignoring the activation with no signal at all.
        const isBlocked = navState.phase !== "idle" && !isThisTarget;

        if (isThisStuck) {
          return (
            <div key={entry.room} className="report-room-row report-room-row-stuck" aria-busy="true">
              <span className="report-room-row-label">
                <strong>Room {entry.room + 1}</strong>
                <span className="report-room-row-status" aria-live="polite">Still opening…</span>
              </span>
              <button type="button" className="report-room-row-retry" onClick={handleRetry}>Retry</button>
            </div>
          );
        }

        return (
          <Link
            key={entry.room}
            href={href}
            className={`report-room-row report-room-row-${entry.status}${isThisTarget ? " report-room-row-pending" : ""}${isBlocked ? " report-room-row-blocked" : ""}`}
            prefetch={false}
            aria-busy={isThisTarget ? true : undefined}
            aria-disabled={isBlocked ? true : undefined}
            onClick={(event) => handleRoomActivate(event, entry.room, href)}
          >
            <span className="report-room-row-label">
              <strong>Room {entry.room + 1}</strong>
              <span className="report-room-row-status" aria-live="polite">
                {isThisTarget ? "Opening…" : statusLabel(entry.status)}
                {!isThisTarget && entry.mostRecentAt && ` · Last checked ${new Date(entry.mostRecentAt).toLocaleDateString("en-GB")}`}
              </span>
            </span>
            {isThisTarget
              ? <span className="report-room-row-spinner" aria-hidden="true" />
              : <ChevronRight aria-hidden="true" className="report-room-row-chevron" />}
          </Link>
        );
      })}
    </div>
  );
}
