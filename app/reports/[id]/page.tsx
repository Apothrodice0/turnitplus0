import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { SESSION_COOKIE_NAME, getSessionUserByToken } from "@/lib/auth-session";
import { checkReadRate } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { getReportsDbClient } from "@/lib/reports-db";
import { findReportRowForUser } from "@/lib/reports-repo";
import { deriveRoomStatus } from "@/lib/report-rooms";
import { resolvePersistedSimilarityDisplay } from "@/lib/report-primary-similarity";
import { archiveOverlapScore, hasUnifiedSimilarity, type SimilarityReport } from "@/lib/report-types";
import { ReportDetailShell } from "./report-detail-shell";

export const dynamic = "force-dynamic";

type OwnedReportResult =
  // aiStatus (production bug fix): the report's real AI-lifecycle status,
  // derived the same way the room page already does (see
  // lib/report-rooms.ts's deriveRoomStatus) from the row's own ai_score/
  // ai_status columns — lets a direct visit to this URL show an honest "AI
  // analysis in progress" state instead of either pretending the report is
  // fully done or leaving the AI tab looking permanently, ambiguously
  // "pending." Always defined (never null): a legacy report predating
  // ai_status falls back to deriveRoomStatus's own ai_score-only rule,
  // exactly like the room page already does for the same case.
  // Release-hardening audit finding SIM-04: similarityStatus is a cheap,
  // read-only signal — computed via lib/report-primary-similarity.ts's
  // resolvePersistedSimilarityDisplay, the SAME function
  // lib/reports-repo.ts's findRoomOccupant uses, so room and detail can
  // never disagree. Never triggers recomputation itself (no matcher calls,
  // no writes); it only tells ReportDetailShell whether payload's own
  // primarySimilarityScore is already trustworthy ("resolved"), known
  // outdated by generation/live-flag change ("stale" — show "Updating
  // similarity…" instead), never computed at all ("pending" — show
  // "Calculating similarity…"), or genuinely, reproducibly failed
  // ("failed" — release-hardening audit finding LIFECYCLE-06, corrected —
  // show "Unavailable," never inferred from client poll timing). See
  // loadOwnedReport's own comment for why
  // payload.unifiedSimilarity is stripped in the one "resolved but
  // archive-only" case (a live CORPUS_SOURCE_MATCHING_ENABLED rollback) so
  // primarySimilarityScore(payload) itself agrees with this status, not
  // just the label around it.
  | { status: "found"; payload: SimilarityReport; aiStatus: "processing" | "ready" | "failed"; similarityStatus: "resolved" | "stale" | "pending" | "failed" }
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
  // account's own read/navigation rate-limit bucket (checkReadRate), never
  // "not signed in" — must stay distinct from "no-session", which
  // ReportDetailShell treats as "try the anonymous device-key lookup" (see
  // requiresClientResolution below). An account-owned report can never be
  // found that way, so collapsing the two used to render "This report could
  // not be found" to its own owner (production audit finding).
  const clientIp = clientIpFromHeaders(await headers());
  const rate = await checkReadRate(clientIp);
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
      const payload = JSON.parse(row.payload_json) as SimilarityReport;
      // Task A correction: the same explicit, unconditional authorization
      // signal app/api/reports/[id]/route.ts's GET handler sets for the
      // client-side background re-fetch — this is the server-rendered FIRST
      // PAINT path, so it must set the identical field the identical way
      // (the authenticated session's own real `role` column) or the very
      // first render would show/hide detailed source-channel UI differently
      // from every subsequent client re-render. See SimilarityReport's own
      // comment on this field.
      payload.viewerIsAdmin = sessionUser.role === "admin";
      const aiStatus = deriveRoomStatus(row.ai_score, row.ai_status);
      const display = await resolvePersistedSimilarityDisplay(client, {
        reportDeviceKey: row.device_key,
        reportId: id,
        archiveScore: archiveOverlapScore(payload),
        unifiedScore: payload.unifiedSimilarity?.unifiedScore ?? null,
        hasUnifiedSimilarity: hasUnifiedSimilarity(payload),
        corpusSourceMatchingEnabledAtComputation: payload.corpusSourceMatchingEnabledAtComputation ?? null,
        unifiedSimilarityFailed: payload.unifiedSimilarityFailed ?? false,
        // Backward-compatibility fix: a report self-healed before
        // matchedPositions existed (see lib/unified-similarity.ts's own
        // comment) must not render as "resolved" here with nothing for the
        // renderer to highlight from. `!== undefined`, not `.length`, so a
        // real, current 0% match (matchedPositions: []) still counts as
        // present. This page never self-heals itself (see this function's
        // own header comment on staying fast/unenriched) — a "stale" result
        // here is picked up by the client's own fetch to
        // app/api/reports/[id]/route.ts's GET handler, which always
        // resolves fresh and therefore always persists the new fields.
        hasPositionEvidence: payload.unifiedSimilarity?.matchedPositions !== undefined,
      });
      // Release-hardening audit finding SIM-04: "resolved" + isUnified
      // false means the live flag rollback path — payload.unifiedSimilarity
      // itself still holds the OLD, flag-computed value (it is never
      // mutated in storage just by a read), so it must be stripped here,
      // not just labeled around: primarySimilarityScore(payload) on the
      // client reads report.unifiedSimilarity directly and has no
      // knowledge of the live flag at all — without this, the client would
      // render the correct "resolved" status next to the WRONG (stale,
      // corpus-inflated) number.
      if (display.status === "resolved" && !display.isUnified) {
        delete payload.unifiedSimilarity;
      }
      // Release-hardening audit finding UI-02: payload.unifiedSimilarity is
      // read straight from durable storage here, so a non-admin's very
      // first server render would otherwise carry the same
      // contributions[].sourceId (an internal representation id) that
      // app/api/reports/[id]/route.ts's GET handler now strips for the
      // background-fetch response — see that route's own comment for why
      // this is safe (contributions is never rendered by any production UI)
      // and why unifiedScore itself is never touched.
      if (payload.unifiedSimilarity && sessionUser.role !== "admin") {
        payload.unifiedSimilarity = { ...payload.unifiedSimilarity, contributions: [] };
      }
      return { status: "found", payload, aiStatus, similarityStatus: display.status };
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
      initialAiStatus={result.status === "found" ? result.aiStatus : null}
      initialSimilarityStatus={result.status === "found" ? result.similarityStatus : null}
      requiresClientResolution={result.status === "no-session"}
      backRoom={backRoom}
    />
  );
}
