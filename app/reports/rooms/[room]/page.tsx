import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { LogIn } from "lucide-react";
import { SESSION_COOKIE_NAME, getSessionUserByToken } from "@/lib/auth-session";
import { checkRate } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { getReportsDbClient } from "@/lib/reports-db";
import { findRoomOccupant, type RoomOccupantResult } from "@/lib/reports-repo";
import { getRoomCountForRole } from "@/lib/report-rooms";
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
  | { status: "found"; room: number; accountEmail: string; occupant: RoomOccupantResult }
  | { status: "invalid-room" }
  | { status: "no-session" }
  | { status: "rate-limited"; retryAfterSeconds: number };

const loadRoom = cache(async (roomParam: string): Promise<RoomPageResult> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) return { status: "no-session" };

  // A session cookie is already present at this point, so a rejection here
  // is never "not signed in" — it's this account's own general rate-limit
  // bucket (lib/rate-limit.ts) being briefly exhausted. Must stay a distinct
  // status, not "no-session": collapsing the two used to render "Sign in to
  // view this room" to an already-signed-in user (production audit finding).
  const clientIp = clientIpFromHeaders(await headers());
  const rate = await checkRate(clientIp);
  if (!rate.allowed) return { status: "rate-limited", retryAfterSeconds: rate.retryAfter };

  const client = await getReportsDbClient();
  try {
    const sessionUser = await getSessionUserByToken(token, client);
    if (!sessionUser) return { status: "no-session" };

    // The selected room must never be guessed by the client — this
    // validates the URL param itself against the account's own role-based
    // room count (never exposing role, only accepting/rejecting a number).
    const roomCount = getRoomCountForRole(sessionUser.role);
    const room = Number(roomParam);
    if (!Number.isInteger(room) || room < 0 || room >= roomCount) return { status: "invalid-room" };

    const occupant = await findRoomOccupant(client, sessionUser.id, room);
    return { status: "found", room, accountEmail: sessionUser.email, occupant };
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

  return <RoomPageShell room={result.room} accountEmail={result.accountEmail} initialOccupant={result.occupant} />;
}
