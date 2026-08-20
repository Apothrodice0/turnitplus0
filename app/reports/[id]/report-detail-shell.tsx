"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileText, GraduationCap, Globe2, Printer } from "lucide-react";
import { similarityScoreBand } from "@/lib/ai-core";
import { deleteRemoteReportChecked, fetchRemoteReport } from "@/lib/reports-remote";
import { deleteStoredReport, getStoredReportById } from "@/lib/report-store";
import {
  PRIMARY_SIMILARITY_BAND_LABELS,
  aiSignalDisplay,
  archiveMatchedWordCount,
  hasUnifiedSimilarity,
  primarySimilarityScore,
  type ReportMode,
  type ResultTab,
  type SimilarityReport,
} from "@/lib/report-types";
import { AiReport } from "@/components/report/ai-report";
import { CategorySummary, OverviewReport, SourcesReport, SubmissionReport, dedupeExternalAcademicEvidence } from "@/components/report/similarity-report-papers";
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
        // Phase 7: the local IndexedDB copy is written once at generation
        // time and never carries the server's own read-time enrichment
        // (unifiedSimilarity, historicalSubmissionMatch, matchClassification,
        // reuseContext — see lib/report-types.ts's primarySimilarityScore
        // and app/api/reports/[id]/route.ts's own GET handler). Shown
        // instantly above for speed, then quietly topped up here so an
        // anonymous viewer — most of this product's traffic, since no
        // account is required — still sees the real TurnitPlus Similarity
        // headline rather than a silent archive-only fallback. Merged, not
        // replaced, so nothing the local copy already had is ever lost if
        // this fetch fails or returns something older.
        const enriched = await fetchRemoteReport<SimilarityReport>(id);
        if (!cancelled && enriched) {
          setReport((current) => (current ? { ...current, ...enriched } : current));
        }
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

  // Phase 7 PRIORITY 1: the customer-facing headline is the unified result
  // (archive + verified live academic evidence + eligible previous-submission
  // evidence, already deduplicated into one score — see
  // lib/unified-similarity.ts) whenever it has been computed for this report,
  // never report.score/archiveScore directly and never a second, separately
  // "added" percentage. Falls back to the existing archive-only score,
  // labeled honestly as "Similarity result" rather than "TurnitPlus Similarity",
  // for a report that predates Phase 6 or where the read-time computation
  // itself failed — see primarySimilarityScore's own comment.
  const primaryScore = primarySimilarityScore(report);
  const isUnified = hasUnifiedSimilarity(report);
  const primaryLabel = isUnified ? "TurnitPlus Similarity" : "Similarity result";
  const similarityVerdict = similarityScoreBand(primaryScore);
  const aiSignal = aiSignalDisplay(report);
  const academicEvidenceCount = report.externalAcademicEvidence ? dedupeExternalAcademicEvidence(report.externalAcademicEvidence).length : 0;
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
              : `${primaryScore}% ${primaryLabel}`}
          </strong>
          {mode === "similarity" && <span className="summary-chip">{report.sources.length} matched source{report.sources.length === 1 ? "" : "s"}</span>}
          {mode === "similarity" && (report.webCheck?.phrasesMatched ?? 0) > 0 && <span className="summary-chip wikipedia-evidence-chip"><Globe2 aria-hidden="true" /> Separate Wikipedia evidence</span>}
          {mode === "similarity" && academicEvidenceCount > 0 && (
            <span className="summary-chip academic-evidence-chip">
              <GraduationCap aria-hidden="true" /> {academicEvidenceCount} external academic {academicEvidenceCount === 1 ? "source" : "sources"}
            </span>
          )}
          {mode === "ai" && <span className="summary-chip">English only</span>}
        </div>
        <div>
          <span className="summary-chip">{report.wordCount.toLocaleString()} words</span>
          <span className="summary-chip">{report.pageCount} pages</span>
          <span className="summary-chip">{report.characterCount.toLocaleString()} characters</span>
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
            <span>{mode === "ai" ? "AI writing score" : primaryLabel}</span>
            <strong>{mode === "ai" ? (aiSignal.value === null ? "—" : `${aiSignal.value}%`) : `${primaryScore}%`}</strong>
            {mode === "ai" && <p className="inspector-writing-estimate">{aiSignal.label}</p>}
            {mode === "similarity" && similarityVerdict && <em>{PRIMARY_SIMILARITY_BAND_LABELS[similarityVerdict.key]}</em>}
            {mode === "similarity" && <div><i style={{ width: `${primaryScore * 5}%` }} /></div>}
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
              {isUnified
                ? <>TurnitPlus Similarity combines text found through TurnitPlus&apos;s own checks, verified external academic sources, and eligible previous TurnitPlus submissions into one result — the same submitted passage found by more than one source counts once.</>
                : <>The similarity result is based on identified overlapping passages and verified academic sources.</>}
              {" "}{archiveMatchedWordCount(report).toLocaleString()} words were matched across {report.sources.length} retained source{report.sources.length === 1 ? "" : "s"}.
              {(report.webCheck?.phrasesMatched ?? 0) > 0 && ` Wikipedia evidence is shown separately and does not change this result.`}
              {" "}Language detected: {report.features.detectedLanguage}. Longest matched span: {report.features.longestMatchedSpan} words.
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
