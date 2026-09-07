"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight, Download, FileText } from "lucide-react";
import type { ReportSummary } from "@/lib/reports-remote";
import { fetchRemoteReport } from "@/lib/reports-remote";
import { getStoredReportById } from "@/lib/report-store";
import { similarityScoreBand } from "@/lib/ai-core";
import { resolveAiDisplayState } from "@/lib/ai-display-state";
import type { SimilarityReport } from "@/lib/report-types";

/**
 * One report row, shared between the anonymous flat list (app/page.tsx) and
 * the 10-room browser's per-room list (report-rooms.tsx) — both only ever
 * have a lightweight ReportSummary in hand, never the full report body, so
 * this renders entirely from summary fields (no aiSignalDisplay/
 * primarySimilarityScore/hasUnifiedSimilarity — those need the full
 * SimilarityReport and are only ever computed once the report is actually
 * opened, at /reports/[id]).
 *
 * "Receipt" is the one action here that genuinely needs the full report
 * body — resolved on demand, only on click.
 *
 * Preview receipt regression: the receipt must show the same server-
 * finalized primary/unified similarity result the room card and report
 * detail page already show — never a locally-cached snapshot. The local
 * IndexedDB copy is written once, at upload time, from
 * attachUnifiedSimilarity's own client-side, corpus-blind computation (see
 * that call site's own comment) and is never refreshed once write-time
 * finalization persists the real, corpus-aware result server-side — so for
 * any report whose similarity depends on corpus-source matching, the local
 * copy can permanently disagree with what the room/detail page show. Fetches
 * the server-confirmed copy first; the local copy is used only as an
 * offline fallback when the network fetch itself fails.
 */

/**
 * Every AI result surface resolves through the one shared interpreter
 * (lib/ai-display-state.ts) so the list row can never disagree with the
 * room card or the detail page. A ReportSummary carries no aiAnalysis, so
 * this only ever exercises the flat-column branches — equivalent to the
 * previous inline logic for the common case, but now with a real "failed"
 * state instead of it collapsing back into "AI report pending", and a
 * missing score can never render as "0%".
 */
function aiRowDisplay(report: ReportSummary): { value: string; label: string; toneClass: string } {
  const ai = resolveAiDisplayState({ aiStatus: report.aiStatus, aiScore: report.aiScore, aiTone: report.aiTone });
  if (ai.state === "complete" && ai.score !== null) {
    const label =
      ai.tone === "low" ? "Low AI indicators" : ai.tone === "review" ? "Moderate AI indicators" : "Strong AI indicators";
    return { value: `${ai.score}%`, label, toneClass: ai.tone };
  }
  if (ai.state === "failed") return { value: "—", label: "AI unavailable", toneClass: "unavailable" };
  if (ai.state === "not_eligible") return { value: "—", label: "Not enough text", toneClass: "unavailable" };
  return { value: "—", label: "AI report pending", toneClass: "unavailable" };
}

export function ReportHistoryRow({
  report,
  onDownloadReceipt,
}: {
  report: ReportSummary;
  onDownloadReceipt: (report: SimilarityReport) => Promise<void>;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  // Release-hardening audit finding SIM-01: prefer the combined result when
  // this summary happens to carry one (see ReportSummary.primaryScore's own
  // comment) — falls back to the archive-only value with the same
  // "Similarity result" label the detail page itself uses for exactly the
  // same fallback case, so this row can never contradict what opening the
  // report would show.
  const displayScore = report.primaryScore ?? report.archiveScore;
  const displayLabel = report.isUnified ? "TurnitPlus Similarity" : "Similarity result";
  const similarityVerdict = similarityScoreBand(displayScore);
  const aiRow = aiRowDisplay(report);

  async function handleDownloadReceipt() {
    setDownloading(true);
    setDownloadError(false);
    try {
      // Production audit fix: both "the report couldn't be found anywhere"
      // and "onDownloadReceipt itself threw" (e.g. its own font-loading
      // fetch failed) used to be entirely silent — the button just flipped
      // back to "Receipt" with no indication anything went wrong.
      const remote = await fetchRemoteReport<SimilarityReport>(report.id);
      const full = remote ?? (await getStoredReportById<SimilarityReport>(report.id).catch(() => null));
      if (full) {
        await onDownloadReceipt(full);
      } else {
        setDownloadError(true);
      }
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
    window.setTimeout(() => setDownloadError(false), 4000);
  }

  return (
    <article>
      <div className="history-file-icon"><FileText aria-hidden="true" /></div>
      <div className="history-copy">
        <strong>{report.title}</strong>
        <p>
          {new Date(report.createdAt).toLocaleDateString("en-GB")} · {report.wordCount.toLocaleString()} words
        </p>
      </div>
      {/* prefetch=false on both links: this row renders in a loop (every
          saved report at once), and each link points at a force-dynamic,
          rate-limited page (app/reports/[id]/page.tsx). Viewport prefetching
          every row's two links the moment the list is visible would burn the
          account's rate-limit budget before any report is actually opened —
          see components/reports/report-rooms.tsx's own room-link comment for
          the same fix applied to the room directory. */}
      <div className="history-action-group" aria-label={`Actions for ${report.title}`}>
        <Link href={`/reports/${report.id}?mode=ai`} prefetch={false} className={`history-result history-ai-result history-ai-${aiRow.toneClass}`} aria-label={`Open AI report for ${report.title}`}>
          <span className="history-result-score">
            <strong className="history-ai-value">{aiRow.value}</strong>
            <span>{aiRow.label}</span>
          </span>
          <span className="history-open-cue" aria-hidden="true"><ChevronRight /></span>
        </Link>
        <Link href={`/reports/${report.id}`} prefetch={false} className={`history-result history-similarity-result ${similarityVerdict ? `history-similarity-${similarityVerdict.key}` : ""}`} aria-label={`Open similarity report for ${report.title} — ${displayScore}% ${displayLabel}`}>
          <span className="history-result-score">
            <strong>{displayScore}%</strong>
            <span>{displayLabel}</span>
          </span>
          <span className="history-open-cue" aria-hidden="true"><ChevronRight /></span>
        </Link>
        <button
          className="history-receipt"
          type="button"
          disabled={downloading}
          onClick={handleDownloadReceipt}
          title={downloadError ? "Couldn't generate the receipt. Click to try again." : undefined}
        >
          <Download aria-hidden="true" />
          <span aria-live="polite">{downloading ? "Preparing…" : downloadError ? "Failed — retry" : "Receipt"}</span>
        </button>
      </div>
    </article>
  );
}
