import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { LogIn } from "lucide-react";
import { SESSION_COOKIE_NAME, getSessionUserByToken } from "@/lib/auth-session";
import { checkReadRate } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { getReportsDbClient } from "@/lib/reports-db";
import { findRoomOccupant, listEarlierRoomReports, type RoomOccupantResult } from "@/lib/reports-repo";
import { reportHistoryRetentionEnabled, type EarlierRoomReport } from "@/lib/report-history";
import { ROOM_CYCLE_MS } from "@/lib/report-rooms";
import { newCheckRefusal, readActiveRoomClaims, resolveRoomPolicy } from "@/lib/account-entitlements";
import { HISTORICAL_ROOM_NOTE, roomCooldownLock, subscriptionNoticeFor, uploadLockFor, type SubscriptionNotice, type UploadLock } from "@/lib/account-plan";
import { SubscriptionRequiredState } from "@/components/reports/subscription-required-state";
import { isSystem2ResearchUser } from "@/lib/system2-research";
import { RoomPageShell } from "./room-page-shell";

export const dynamic = "force-dynamic";

/**
 * The dedicated room page (requirement: "Clicking a room should navigate to
 * a dedicated room page"). Fetches ONLY this one room's current occupant —
 * a fast, session-scoped DB read, mirroring app/reports/[id]/page.tsx's own
 * pattern — never the account's other rooms, never a list of reports.
 *
 * Rooms are an authenticated-account concept only (see
 * lib/report-rooms.ts); there is no anonymous/device-key equivalent, so an
 * unauthenticated visit shows a plain sign-in prompt rather than attempting
 * any local-storage fallback.
 */

type RoomPageResult =
  | {
      status: "found";
      room: number;
      accountEmail: string;
      occupant: RoomOccupantResult;
      uploadLock: UploadLock | null;
      subscriptionEnforced: boolean;
      historicalNote: string | null;
      earlierReports: EarlierRoomReport[];
      system2Enabled: boolean;
    }
  | { status: "subscription-required"; notice: SubscriptionNotice }
  | { status: "invalid-room" }
  | { status: "no-session" }
  | { status: "rate-limited"; retryAfterSeconds: number };

/**
 * Manual subscriptions: an account with no active subscription (none, expired, suspended — or new checks unavailable)
 * never sees an empty / new-check room. Any such room URL it opens shows the same centered subscription-required screen
 * as My Reports; within this bound that includes room numbers beyond its listed rooms, which would otherwise be a 404.
 * Rooms holding one of its reports still open that report.
 */
const LOCKED_ROOM_URL_LIMIT = 100;

const loadRoom = cache(async (roomParam: string): Promise<RoomPageResult> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) return { status: "no-session" };

  // A session cookie is already present at this point, so a rejection here
  // is never "not signed in" — it's this account's own read/navigation rate-
  // limit bucket (lib/rate-limit.ts's checkReadRate) being briefly exhausted.
  // Must stay a distinct status, not "no-session": collapsing the two used
  // to render "Sign in to view this room" to an already-signed-in user
  // (production audit finding).
  const clientIp = clientIpFromHeaders(await headers());
  const rate = await checkReadRate(clientIp);
  if (!rate.allowed) return { status: "rate-limited", retryAfterSeconds: rate.retryAfter };

  const client = await getReportsDbClient();
  try {
    const sessionUser = await getSessionUserByToken(token, client);
    if (!sessionUser) return { status: "no-session" };

    // The selected room must never be guessed by the client — this
    // validates the URL param itself against the account's own role-based
    // room count (never exposing role, only accepting/rejecting a number).
    // Manual account activation (lib/account-entitlements.ts): the rooms the account's room list shows — with the
    // feature off, exactly the role-based count.
    const policy = await resolveRoomPolicy(client, sessionUser);
    // Manual subscriptions: an account without an active subscription opens any room URL within LOCKED_ROOM_URL_LIMIT
    // (the subscription-required screen below, or a room's earlier report) instead of a 404 past its listed rooms.
    const planBlock = policy.enforced ? policy.block : null;
    const roomCount = planBlock ? Math.max(policy.visibleRoomCount, LOCKED_ROOM_URL_LIMIT) : policy.visibleRoomCount;
    const room = Number(roomParam);
    if (!Number.isInteger(room) || room < 0 || room >= roomCount) return { status: "invalid-room" };

    const occupant = await findRoomOccupant(client, sessionUser.id, room);
    // Manual subscriptions: where no new check can start (no active subscription, or a room beyond the plan) the customer
    // still opens and reads this room's earlier report, however old. With the feature off this never applies.
    let shown: RoomOccupantResult = occupant;
    let historicalNote: string | null = null;
    if (policy.enforced && (policy.block !== null || room >= policy.uploadRoomCount) && occupant.status === "empty") {
      const earlier = await findRoomOccupant(client, sessionUser.id, room, new Date(), { includeHistorical: true });
      if (earlier.report) {
        shown = earlier;
        historicalNote = HISTORICAL_ROOM_NOTE;
      }
    }
    if (planBlock && shown.status === "empty") {
      return { status: "subscription-required", notice: subscriptionNoticeFor(planBlock.code, policy.entitlement?.expiresAt ?? null) };
    }
    // Said before the customer spends minutes on an analysis the save would refuse: the room's upload area is shown
    // locked (no active subscription, room outside the plan, server-clock cooldown). The save and the check-work routes
    // still decide on their own (app/api/reports/route.ts, lib/account-entitlements.ts). Always null with the feature off.
    let uploadLock: UploadLock | null = null;
    if (policy.enforced && shown.status === "empty") {
      const refusal = newCheckRefusal(policy, room);
      if (refusal) {
        uploadLock = uploadLockFor(refusal.code, policy.entitlement?.expiresAt ?? null, policy.entitlement?.rooms ?? null);
      } else if (policy.usesRoomClaims) {
        const claimedAt = (await readActiveRoomClaims(client, sessionUser.id, Date.now())).get(room);
        if (claimedAt !== undefined) uploadLock = roomCooldownLock(room + 1, claimedAt + ROOM_CYCLE_MS);
      }
    }
    // Report history retention (lib/report-history.ts): the room's earlier reports, readable from the room. Off: none.
    const earlierReports = reportHistoryRetentionEnabled() ? await listEarlierRoomReports(client, sessionUser.id, room, shown.report?.id ?? null) : [];
    return {
      status: "found",
      room,
      accountEmail: sessionUser.email,
      occupant: shown,
      uploadLock,
      subscriptionEnforced: policy.enforced,
      historicalNote,
      earlierReports,
      // Owner-only English System 2 research preview: resolved server-side (allowlist + feature switch, never in production).
      system2Enabled: isSystem2ResearchUser(sessionUser),
    };
  } finally {
    client.close();
  }
});

export async function generateMetadata({ params }: { params: Promise<{ room: string }> }): Promise<Metadata> {
  const { room } = await params;
  const roomNumber = Number(room);
  return {
    title: Number.isInteger(roomNumber) ? `Room ${roomNumber + 1} · TurnitPlus` : "Room · TurnitPlus",
    description: "A TurnitPlus report room.",
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  };
}

export default async function RoomPage({ params }: { params: Promise<{ room: string }> }) {
  const { room: roomParam } = await params;
  const result = await loadRoom(roomParam);

  if (result.status === "invalid-room") notFound();

  if (result.status === "subscription-required") {
    return (
      <section className="result-view report-detail-page">
        <SubscriptionRequiredState notice={result.notice} backHref="/#reports" />
      </section>
    );
  }

  if (result.status === "no-session") {
    return (
      <section className="result-view report-detail-page">
        <div className="report-not-found-wrap">
          <div className="empty-reports">
            <h3>Sign in to view this room</h3>
            <p>Rooms belong to your account — sign in to open them.</p>
            <Link href="/#account" className="button primary">
              <LogIn aria-hidden="true" /> Go to login
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (result.status === "rate-limited") {
    return (
      <section className="result-view report-detail-page">
        <div className="report-not-found-wrap">
          <section className="ai-analysis-message">
            <strong>—</strong>
            <div>
              <p>You&apos;re signed in, but this device has made a lot of requests in a short time. Try this room again in about {result.retryAfterSeconds}s.</p>
              <Link href="/#reports" className="button primary">Back to my reports</Link>
            </div>
          </section>
        </div>
      </section>
    );
  }

  // Defect #3 fix: an explicit, room-derived key forces React to remount
  // RoomPageShell (fresh occupant/isGeneratingReport/progress/refs/polling
  // state) whenever the account navigates from one room to another via
  // client-side navigation. Without a key, React reconciles consecutive
  // <RoomPageShell room={X} .../> renders at this same JSX position as the
  // SAME component instance across a room change (only the props update) —
  // useState(initialOccupant)'s own initializer never re-runs on a prop
  // change, and every ref/local-only state (isGeneratingReport,
  // generationLockRef, progress, processingLabel, poll-attempt tracking)
  // would silently carry over from whichever room was previously mounted in
  // this slot into the newly-navigated-to room. `room` is the same raw,
  // zero-based value already threaded through save/read/poll everywhere
  // else in this tree — using it as a key changes nothing about that
  // persisted semantics, it only tells React when a genuinely different
  // room warrants a fresh instance.
  // Manual subscriptions: an EMPTY room that cannot take a new check right now shows its usual upload area LOCKED
  // (dimmed, no file input, no drop target, no generate action) with the reason — never with the feature off.
  return <RoomPageShell key={result.room} room={result.room} accountEmail={result.accountEmail} initialOccupant={result.occupant} uploadLock={result.uploadLock} subscriptionEnforced={result.subscriptionEnforced} historicalNote={result.historicalNote} earlierReports={result.earlierReports} system2Enabled={result.system2Enabled} />;
}
