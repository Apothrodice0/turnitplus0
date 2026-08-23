"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight, Download, FileText } from "lucide-react";
import type { ReportSummary } from "@/lib/reports-remote";
import { fetchRemoteReport } from "@/lib/reports-remote";
import { getStoredReportById } from "@/lib/report-store";
import { similarityScoreBand } from "@/lib/ai-core";
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
 * body — resolved on demand, only on click: local IndexedDB first (already
 * present for most anonymous reports), then a remote fetch, never eagerly.
 */

function aiToneLabel(aiScore: number | null, aiTone: string | null): string {
  if (aiScore === null) return "AI report pending";
  if (aiTone === "low") return "Low AI indicators";
  if (aiTone === "review") return "Moderate AI indicators";
  if (aiTone === "high") return "Strong AI indicators";
  return "AI report pending";
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

  async function handleDownloadReceipt() {
    setDownloading(true);
    setDownloadError(false);
    try {
      // Production audit fix: both "the report couldn't be found anywhere"
      // and "onDownloadReceipt itself threw" (e.g. its own font-loading
      // fetch failed) used to be entirely silent — the button just flipped
      // back to "Receipt" with no indication anything went wrong.
      const local = await getStoredReportById<SimilarityReport>(report.id).catch(() => null);
      const full = local ?? (await fetchRemoteReport<SimilarityReport>(report.id));
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
        <Link href={`/reports/${report.id}?mode=ai`} prefetch={false} className={`history-result history-ai-result history-ai-${report.aiTone ?? "unavailable"}`} aria-label={`Open AI report for ${report.title}`}>
          <span className="history-result-score">
            <strong className="history-ai-value">{report.aiScore === null ? "—" : `${report.aiScore}%`}</strong>
            <span>{aiToneLabel(report.aiScore, report.aiTone)}</span>
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
