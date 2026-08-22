import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { SESSION_COOKIE_NAME, getSessionUserByToken } from "@/lib/auth-session";
import { checkRate } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { getReportsDbClient } from "@/lib/reports-db";
import { findReportRowForUser } from "@/lib/reports-repo";
import type { SimilarityReport } from "@/lib/report-types";
import { ReportDetailShell } from "./report-detail-shell";

export const dynamic = "force-dynamic";

type OwnedReportResult =
  | { status: "found"; payload: SimilarityReport }
  | { status: "not-found-for-session" }
  | { status: "no-session" }
  | { status: "rate-limited"; retryAfterSeconds: number };

// The report room is intentionally a fast saved-payload read. Expensive
// historical/family enrichment belongs to the background client hydration
// path, not the critical path for opening a saved report. This is the core
// "one report = one room" performance boundary: opening report #37 never
// requires computing data for reports #1-36.
const loadOwnedReport = cache(async (id: string): Promise<OwnedReportResult> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) return { status: "no-session" };

  // A session cookie is already present, so a rejection here is this
  // account's own rate-limit bucket, never "not signed in" — must stay
  // distinct from "no-session", which ReportDetailShell treats as "try the
  // anonymous device-key lookup" (see requiresClientResolution below). An
  // account-owned report can never be found that way, so collapsing the two
  // used to render "This report could not be found" to its own owner
  // (production audit finding).
  const clientIp = clientIpFromHeaders(await headers());
  const rate = await checkRate(clientIp);
  if (!rate.allowed) return { status: "rate-limited", retryAfterSeconds: rate.retryAfter };

  const client = await getReportsDbClient();
  try {
    const sessionUser = await getSessionUserByToken(token, client);
    if (!sessionUser) return { status: "no-session" };
    const row = await findReportRowForUser(client, id, sessionUser.id);
    if (!row) return { status: "not-found-for-session" };
    // A corrupt payload_json is, from the user's own perspective,
    // indistinguishable from "not available" — reusing the existing
    // not-found path (rather than letting JSON.parse's SyntaxError bubble
    // up uncaught to error.tsx's generic "Try again," which would just
    // fail identically on every retry for genuinely corrupt data) is both
    // more honest and avoids a dead-end retry loop. Production audit fix.
    try {
      return { status: "found", payload: JSON.parse(row.payload_json) as SimilarityReport };
    } catch {
      return { status: "not-found-for-session" };
    }
  } finally {
    client.close();
  }
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const result = await loadOwnedReport(id);
  return {
    title: result.status === "found" ? `${result.payload.title} · TurnitPlus report` : "Saved report · TurnitPlus",
    description: "A saved TurnitPlus AI-writing and similarity report.",
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  };
}

export default async function ReportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string | string[]; room?: string | string[] }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const mode = sp.mode === "ai" ? "ai" : "similarity";
  // Navigation context only — never a security/ownership check (that's
  // already handled by loadOwnedReport above). A report opened from its
  // room (see app/reports/rooms/[room]/room-page-shell.tsx's own links)
  // carries ?room=N so this page's back button can return the user there
  // instead of the generic My Reports directory. A malformed/absent value
  // just falls back to that generic destination — never a hard failure.
  const roomParam = Array.isArray(sp.room) ? sp.room[0] : sp.room;
  const backRoom = roomParam !== undefined && /^\d+$/.test(roomParam) ? Number(roomParam) : null;
  const result = await loadOwnedReport(id);

  if (result.status === "not-found-for-session") notFound();

  if (result.status === "rate-limited") {
    const backHref = backRoom !== null ? `/reports/rooms/${backRoom}` : "/#reports";
    const backLabel = backRoom !== null ? `Back to Room ${backRoom + 1}` : "Back to my reports";
    return (
      <div className="result-view report-detail-page">
        <div className="report-not-found-wrap">
          <section className="ai-analysis-message">
            <strong>—</strong>
            <div>
              <p>You&apos;re signed in, but this device has made a lot of requests in a short time. Try this report again in about {result.retryAfterSeconds}s.</p>
              <Link href={backHref} className="button primary">{backLabel}</Link>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <ReportDetailShell
      id={id}
      mode={mode}
      initialReport={result.status === "found" ? result.payload : null}
      requiresClientResolution={result.status === "no-session"}
      backRoom={backRoom}
    />
  );
}
