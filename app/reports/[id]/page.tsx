import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SESSION_COOKIE_NAME, getSessionUserByToken } from "@/lib/auth-session";
import { checkRate } from "@/lib/rate-limit";
import { getReportsDbClient } from "@/lib/reports-db";
import { findReportRowForUser } from "@/lib/reports-repo";
import { classifyReportMatches } from "@/lib/report-classification";
import { getOrComputeHistoricalMatchSnapshot } from "@/lib/report-historical-match";
import type { ReportMode, SimilarityReport } from "@/lib/report-types";
import { ReportDetailShell } from "./report-detail-shell";

export const dynamic = "force-dynamic";

type OwnedReportResult =
  | { status: "found"; payload: SimilarityReport }
  | { status: "not-found-for-session" }
  | { status: "no-session" };

// Memoized per request: both the page body and generateMetadata need this
// exact lookup, and unlike fetch(), a raw libSQL call isn't deduped by Next
// automatically — without cache() this would hit the database twice.
const loadOwnedReport = cache(async (id: string): Promise<OwnedReportResult> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) return { status: "no-session" };

  const clientIp = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rate = checkRate(clientIp);
  if (!rate.allowed) return { status: "no-session" };

  const client = await getReportsDbClient();
  try {
    const sessionUser = await getSessionUserByToken(token, client);
    if (!sessionUser) return { status: "no-session" };
    const row = await findReportRowForUser(client, id, sessionUser.id);
    if (!row) return { status: "not-found-for-session" };
    const payload = JSON.parse(row.payload_json) as SimilarityReport;
    // Phase D: read-time enrichment only — never written back to
    // saved_reports, so this can never fall out of sync with a family that
    // gains new members after this report was saved. See
    // lib/report-classification.ts for why this is safe to compute on every
    // read (a handful of indexed point-queries, not a corpus scan) and never
    // touches payload.score/archiveScore. Best-effort: a lookup failure here
    // must never turn an otherwise-successful report load into a 404/500.
    try {
      payload.matchClassification = await classifyReportMatches(client, { rawText: payload.text, accountId: sessionUser.id });
    } catch (err) {
      console.error("classifyReportMatches failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
    // Phase E8C: same read-time-enrichment discipline as Phase D just
    // above — see lib/report-historical-match.ts's own header comment.
    // sessionUser.id is always a real account here (the no-session branch
    // above already returned), so this is never the anonymous path; an
    // anonymous report is only ever served through the client-side
    // GET /api/reports/[id] fetch (requiresClientResolution below), which
    // does its own equivalent enrichment with accountId possibly null.
    try {
      payload.historicalSubmissionMatch = await getOrComputeHistoricalMatchSnapshot(client, {
        reportDeviceKey: row.device_key,
        reportId: id,
        accountId: sessionUser.id,
        rawText: payload.text,
      });
    } catch (err) {
      console.error("getOrComputeHistoricalMatchSnapshot failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
    return { status: "found", payload };
  } finally {
    client.close();
  }
});

function parseMode(searchParams: { mode?: string | string[] }): ReportMode {
  return searchParams.mode === "ai" ? "ai" : "similarity";
}

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
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const { id } = await params;
  const mode = parseMode(await searchParams);
  const result = await loadOwnedReport(id);

  if (result.status === "not-found-for-session") {
    notFound();
  }

  return (
    <ReportDetailShell
      id={id}
      mode={mode}
      initialReport={result.status === "found" ? result.payload : null}
      requiresClientResolution={result.status === "no-session"}
    />
  );
}
