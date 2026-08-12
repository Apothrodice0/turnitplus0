"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileText, Globe2, Printer } from "lucide-react";
import { similarityScoreBand } from "@/lib/ai-core";
import { deleteRemoteReportChecked, fetchRemoteReport } from "@/lib/reports-remote";
import { deleteStoredReport, getStoredReportById } from "@/lib/report-store";
import {
  SIMILARITY_BAND_LABELS,
  aiSignalDisplay,
  archiveMatchedWordCount,
  archiveOverlapScore,
  archiveScopeCount,
  type ReportMode,
  type ResultTab,
  type SimilarityReport,
} from "@/lib/report-types";
import { AiReport } from "@/components/report/ai-report";
import { CategorySummary, OverviewReport, SourcesReport, SubmissionReport } from "@/components/report/similarity-report-papers";
import { ReportNotFoundPanel } from "@/components/report/report-not-found-panel";

type LoadStatus = "loading" | "found" | "not-found";

export function ReportDetailShell({
  id,
  initialReport,
  requiresClientResolution,
  mode,
}: {
  id: string;
  initialReport: SimilarityReport | null;
  requiresClientResolution: boolean;
  mode: ReportMode;
}) {
  const router = useRouter();
  const [report, setReport] = useState<SimilarityReport | null>(initialReport);
  const [status, setStatus] = useState<LoadStatus>(
    initialReport ? "found" : requiresClientResolution ? "loading" : "not-found",
  );
  const [resultTab, setResultTab] = useState<ResultTab>("full");
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Anonymous/device-key reports can only ever be resolved client-side (the
  // device key lives in localStorage, never available during SSR) — mirrors
  // the existing anonymous report-loading order elsewhere: local IndexedDB
  // copy first, remote fetch only as a fallback.
  useEffect(() => {
    if (!requiresClientResolution || initialReport) return;
    let cancelled = false;
    (async () => {
      const local = await getStoredReportById<SimilarityReport>(id);
      if (cancelled) return;
      if (local) {
        setReport(local);
        setStatus("found");
        return;
      }
      const remote = await fetchRemoteReport<SimilarityReport>(id);
      if (cancelled) return;
      if (remote) {
        setReport(remote);
        setStatus("found");
        return;
      }
      setStatus("not-found");
    })();
    return () => {
      cancelled = true;
    };
  }, [id, requiresClientResolution, initialReport]);

  async function handleDelete() {
    if (!report || isDeleting) return;
    if (!window.confirm("Delete this report? This can't be undone.")) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deleteStoredReport(id);
      const ok = await deleteRemoteReportChecked(id);
      if (!ok) {
        setDeleteError("This report could not be deleted. Please try again.");
        setIsDeleting(false);
        return;
      }
      router.push("/#reports");
    } catch {
      setDeleteError("This report could not be deleted. Please try again.");
      setIsDeleting(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="result-view report-detail-page">
        <div className="report-not-found-wrap">
          <section className="ai-analysis-loading" aria-live="polite">
            <span aria-hidden="true" />
            <div>
              <strong>Looking for this report</strong>
              <p>Checking this device for a saved copy…</p>
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (status === "not-found" || !report) {
    return (
      <div className="result-view report-detail-page">
        <div className="report-not-found-wrap">
          <ReportNotFoundPanel />
        </div>
      </div>
    );
  }

  const overlapScore = archiveOverlapScore(report);
  const similarityVerdict = similarityScoreBand(overlapScore);
  const aiSignal = aiSignalDisplay(report);
  const reportDate = new Date(report.created).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

  return (
    <section className="result-view report-detail-page">
      <header className="result-toolbar">
        <Link href="/#reports" className="back-button">
          <ArrowLeft aria-hidden="true" />
          Back to reports
        </Link>
        <div className="result-document">
          <FileText aria-hidden="true" />
          <div>
            <h1>{report.title}</h1>
            <p>Generated {reportDate} · Submission ID {report.submissionId}</p>
          </div>
        </div>
        <button className="button secondary" type="button" onClick={handleDelete} disabled={isDeleting}>
          {isDeleting ? "Deleting…" : "Delete report"}
        </button>
      </header>

      {deleteError && (
        <div className="ai-analysis-message">
          <strong>—</strong>
          <p>{deleteError}</p>
        </div>
      )}

      <div className="report-summary-strip">
        <div>
          <strong className={`summary-chip summary-score-chip ${mode === "ai" ? `ai-summary-chip ai-summary-${aiSignal.tone}` : similarityVerdict ? `summary-verdict-${similarityVerdict.key}` : ""}`}>
            <span className={`score-dot ${mode === "ai" ? `ai-dot ai-dot-${aiSignal.tone}` : similarityVerdict ? `score-dot-${similarityVerdict.key}` : ""}`} />
            {mode === "ai"
              ? `${aiSignal.value === null ? "" : `${aiSignal.value}% · `}${aiSignal.label}`
              : `${overlapScore}% Archive overlap`}
          </strong>
          {mode === "similarity" && <span className="summary-chip">Matched against {archiveScopeCount(report).toLocaleString()} indexed documents</span>}
          {mode === "similarity" && <span className="summary-chip">{report.sources.length} archive sources</span>}
          {mode === "similarity" && (report.webCheck?.phrasesMatched ?? 0) > 0 && <span className="summary-chip wikipedia-evidence-chip"><Globe2 aria-hidden="true" /> Separate Wikipedia evidence</span>}
          {mode === "ai" && <span className="summary-chip">English only</span>}
        </div>
        <div>
          <span className="summary-chip">{report.wordCount.toLocaleString()} words</span>
          <span className="summary-chip">{report.pageCount} pages</span>
          <span className="summary-chip">{report.characterCount.toLocaleString()} characters</span>
          <span className="summary-chip">{report.corpusVersion}</span>
        </div>
      </div>

      <nav className="report-tabs" aria-label="Report sections">
        {mode === "ai" ? (
          <button className="active" type="button">AI report</button>
        ) : (
          <>
            <button className={resultTab === "full" ? "active" : ""} type="button" onClick={() => setResultTab("full")}>Full report</button>
            <button className={resultTab === "overview" ? "active" : ""} type="button" onClick={() => setResultTab("overview")}>Integrity overview</button>
            <button className={resultTab === "submission" ? "active" : ""} type="button" onClick={() => setResultTab("submission")}>Submission</button>
            <button className={resultTab === "sources" ? "active" : ""} type="button" onClick={() => setResultTab("sources")}>Source details</button>
          </>
        )}
      </nav>

      <div className="report-workspace">
        {mode === "ai" ? (
          <AiReport report={report} />
        ) : (
          <>
            {resultTab === "full" && (
              <div className="full-report-preview">
                <OverviewReport report={report} />
                <SubmissionReport report={report} />
                <SourcesReport report={report} />
              </div>
            )}
            {resultTab === "overview" && <OverviewReport report={report} />}
            {resultTab === "submission" && <SubmissionReport report={report} />}
            {resultTab === "sources" && <SourcesReport report={report} />}
          </>
        )}

        <aside className="report-inspector">
          <div className={`inspector-score ${mode === "ai" ? `ai-signal-card-${aiSignal.tone}` : similarityVerdict ? `similarity-verdict-${similarityVerdict.key}` : ""}`}>
            <span>{mode === "ai" ? "AI writing score" : `Archive overlap · ${archiveScopeCount(report)} docs`}</span>
            <strong>{mode === "ai" ? (aiSignal.value === null ? "—" : `${aiSignal.value}%`) : `${overlapScore}%`}</strong>
            {mode === "ai" && <p className="inspector-writing-estimate">{aiSignal.label}</p>}
            {mode === "similarity" && similarityVerdict && <em>{SIMILARITY_BAND_LABELS[similarityVerdict.key]}</em>}
            {mode === "similarity" && <div><i style={{ width: `${overlapScore * 5}%` }} /></div>}
          </div>
          {mode === "similarity" && <div className="inspector-section">
            <h3>Top source types</h3>
            <CategorySummary report={report} />
          </div>}
          <div className="inspector-section">
            <h3>Report notes</h3>
            {mode === "ai" ? <p>
              English-only local analysis. {report.aiAnalysis?.status === "complete"
                ? `${report.aiAnalysis.analyzedWordCount.toLocaleString()} words analyzed. Review the AI writing score and highlighted passage breakdown.`
                : "A numeric result requires at least 300 eligible English words and a successful local model load."}
            </p> : <p>
              Archive overlap measures the percentage of this document found within TurnitPlus&apos;s {archiveScopeCount(report).toLocaleString()} indexed documents. It is not an estimate of a Turnitin score.
              {" "}{archiveMatchedWordCount(report).toLocaleString()} words were matched across {report.sources.length} retained source{report.sources.length === 1 ? "" : "s"}.
              {(report.webCheck?.phrasesMatched ?? 0) > 0 && ` Wikipedia evidence is shown separately and does not change Archive overlap.`}
              {" "}Language detected: {report.features.detectedLanguage}. Longest matched span: {report.features.longestMatchedSpan} words. Archive: {report.corpusVersion}.
            </p>}
          </div>
        </aside>
      </div>

      <div className="print-report-bundle">
        {mode === "ai" ? <AiReport report={report} printMode /> : <>
          <OverviewReport report={report} />
          <SubmissionReport report={report} />
          <SourcesReport report={report} />
        </>}
      </div>

      <div className="download-report-dock">
        <div>
          <strong>Full report</strong>
          <span>Save a PDF copy</span>
        </div>
        <button className="download-report-fab" type="button" onClick={() => window.print()}>
          <Printer aria-hidden="true" />
          Download
        </button>
      </div>
    </section>
  );
}
