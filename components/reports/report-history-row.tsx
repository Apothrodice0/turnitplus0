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
  const similarityVerdict = similarityScoreBand(report.archiveScore);

  async function handleDownloadReceipt() {
    setDownloading(true);
    try {
      const local = await getStoredReportById<SimilarityReport>(report.id).catch(() => null);
      const full = local ?? (await fetchRemoteReport<SimilarityReport>(report.id));
      if (full) await onDownloadReceipt(full);
    } finally {
      setDownloading(false);
    }
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
      <div className="history-action-group" aria-label={`Actions for ${report.title}`}>
        <Link href={`/reports/${report.id}?mode=ai`} className={`history-result history-ai-result history-ai-${report.aiTone ?? "unavailable"}`} aria-label={`Open AI report for ${report.title}`}>
          <span className="history-result-score">
            <strong className="history-ai-value">{report.aiScore === null ? "—" : `${report.aiScore}%`}</strong>
            <span>{aiToneLabel(report.aiScore, report.aiTone)}</span>
          </span>
          <span className="history-open-cue" aria-hidden="true"><ChevronRight /></span>
        </Link>
        <Link href={`/reports/${report.id}`} className={`history-result history-similarity-result ${similarityVerdict ? `history-similarity-${similarityVerdict.key}` : ""}`} aria-label={`Open similarity report for ${report.title}`}>
          <span className="history-result-score">
            <strong>{report.archiveScore}%</strong>
            <span>Similarity result</span>
          </span>
          <span className="history-open-cue" aria-hidden="true"><ChevronRight /></span>
        </Link>
        <button className="history-receipt" type="button" disabled={downloading} onClick={handleDownloadReceipt}>
          <Download aria-hidden="true" />
          <span>{downloading ? "Preparing…" : "Receipt"}</span>
        </button>
      </div>
    </article>
  );
}
