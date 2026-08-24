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
  hasUnifiedSimilarity,
  primaryMatchedWordCount,
  primaryResultLabel,
  primarySimilarityScore,
  type ReportMode,
  type ResultTab,
  type SimilarityReport,
} from "@/lib/report-types";
import {
  computeDetailRevealState,
  startBoundedPoll,
  type DetailAiStatus,
  type DetailSimilarityStatus,
} from "@/lib/report-detail-poll";
import { AiReport } from "@/components/report/ai-report";
import { CategorySummary, OverviewReport, SourcesReport, SubmissionReport, dedupeExternalAcademicEvidence } from "@/components/report/similarity-report-papers";
import { ReportNotFoundPanel } from "@/components/report/report-not-found-panel";

type LoadStatus = "loading" | "found" | "not-found";

export function ReportDetailShell({
  id,
  initialReport,
  initialAiStatus,
  initialSimilarityStatus,
  requiresClientResolution,
  mode,
  backRoom,
}: {
  id: string;
  initialReport: SimilarityReport | null;
  /**
   * Production bug fix: the report's real AI-lifecycle status (see
   * app/reports/[id]/page.tsx's own comment), so a direct visit to this
   * URL while AI analysis is still running shows an explicit "in
   * progress" state instead of presenting the page as if everything were
   * finished. null for the anonymous/device-key path (requiresClientResolution),
   * which has no server-computed status to hand over — that path's own
   * empty/found result already renders correctly without this, and in
   * practice never has a real "still processing" window at all (see
   * isAiTerminal's own comment in lib/report-detail-poll.ts).
   */
  initialAiStatus: DetailAiStatus;
  /**
   * Release-hardening audit finding SIM-04: the SAME "resolved"/"stale"/
   * "pending" status lib/report-primary-similarity.ts's
   * resolvePersistedSimilarityDisplay computes server-side (see
   * app/reports/[id]/page.tsx's own comment) — "resolved" means
   * initialReport's own primarySimilarityScore is already trustworthy
   * as-is (whether a real combined result or a definitive archive-only
   * answer forced by a live CORPUS_SOURCE_MATCHING_ENABLED rollback);
   * "stale" means a persisted combined result exists but no longer
   * reflects the current corpus generation/flag state; "pending" means
   * nothing has ever been persisted (write-time finalization has not
   * completed for this report yet). null only for the anonymous/device-key
   * path, which resolves client-side only, from scratch, on every visit —
   * there is no server-computed status to hand over there, matching
   * initialAiStatus's own null convention.
   */
  initialSimilarityStatus: DetailSimilarityStatus | null;
  requiresClientResolution: boolean;
  mode: ReportMode;
  /** The room this report was opened from (see app/reports/[id]/page.tsx's own comment) — null when opened any other way (the anonymous flat list, a bookmark, etc.), in which case the back button falls back to the generic My Reports directory. */
  backRoom: number | null;
}) {
  const backHref = backRoom !== null ? `/reports/rooms/${backRoom}` : "/#reports";
  const backLabel = backRoom !== null ? `Back to Room ${backRoom + 1}` : "Back to reports";
  const router = useRouter();
  const [report, setReport] = useState<SimilarityReport | null>(initialReport);
  const [aiStatus, setAiStatus] = useState<DetailAiStatus>(initialAiStatus);
  const [status, setStatus] = useState<LoadStatus>(
    initialReport ? "found" : requiresClientResolution ? "loading" : "not-found",
  );
  // Release-hardening audit finding SIM-03, SIM-04: app/api/reports/route.ts's
  // POST handler finalizes unifiedSimilarity at WRITE time, before a save's
  // own response is ever sent, so app/reports/[id]/page.tsx's server render
  // already knows whether initialReport's own primarySimilarityScore is
  // trustworthy ("resolved"), knowably outdated ("stale"), or simply never
  // computed yet ("pending"). Read once, at mount, into this state (never
  // re-derived from report on every render) — the poll effect below is the
  // only thing allowed to change it afterward, so a later resave/refresh
  // within the same mount can't silently regress it. Anonymous/device-key
  // reports (requiresClientResolution) have no server-computed signal at
  // all — mode === "similarity" alone decides whether to start "pending"
  // there.
  const [similarityStatus, setSimilarityStatus] = useState<DetailSimilarityStatus>(
    mode !== "similarity"
      ? "resolved"
      : (initialSimilarityStatus ?? (initialReport !== null && hasUnifiedSimilarity(initialReport) ? "resolved" : "pending")),
  );
  const [resultTab, setResultTab] = useState<ResultTab>("full");
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Release-hardening audit finding LIFECYCLE-06: true once the bounded
  // poll budget below is exhausted without either pipeline reaching a real
  // terminal state. This is purely a "stop asking automatically, offer a
  // manual retry" signal — see lib/report-detail-poll.ts's own header
  // comment for why it must never be treated as evidence that either
  // pipeline itself failed. Reset to false by retryAnalysis(), which
  // starts a genuinely fresh bounded cycle from zero, never an unbounded
  // retry.
  const [pollExhausted, setPollExhausted] = useState(false);

  // effectiveSimilarityStatus/mode "ai" always reads as resolved for this
  // gate's purposes — the AI-only tab has no similarity result to wait on
  // in the first place. Computed here, before any hook — React's rules of
  // hooks require every hook to run unconditionally, before any early
  // return, so the poll effect below (which depends on the reveal state)
  // needs it available this early, rather than alongside the other
  // JSX-prep consts further down.
  const effectiveSimilarityStatus: DetailSimilarityStatus = mode === "similarity" ? similarityStatus : "resolved";
  const revealState = computeDetailRevealState({ aiStatus, similarityStatus: effectiveSimilarityStatus, pollExhausted });
  const bothReady = revealState.screen === "revealed";

  // The server now sends the saved payload without waiting for expensive
  // read-time historical/family enrichment. Render that payload immediately
  // (once revealed — see above) and hydrate richer fields in the
  // background.
  useEffect(() => {
    if (!initialReport || requiresClientResolution || bothReady || pollExhausted) return;
    let cancelled = false;

    // Release-hardening audit finding LIFECYCLE-04: a single settle of this
    // fetch is enough to trust similarity forever — the GET route it hits
    // (app/api/reports/[id]/route.ts) always resolves and persists a fully
    // current, live-flag-correct result before responding, so whatever it
    // returns is the freshest answer this client can get without another
    // request. AI-writing analysis is different: it is a genuinely
    // still-running background job the FIRST read here can easily catch
    // mid-flight, so this same fetch is repeated — "poll/revalidate in the
    // background" — until it reports a real terminal status (ready or
    // failed), not merely accepted once and left stale.
    async function checkOnce(): Promise<boolean> {
      const enriched = await fetchRemoteReport<SimilarityReport>(id);
      if (cancelled) return true;
      // A failed poll request (429/500/timeout/network error) is
      // inconclusive, not a resolution — matching room-page-shell.tsx's own
      // poll discipline, this must never be treated as "similarity is now
      // resolved" or "AI is now done." Leave every piece of state exactly
      // as it was and simply try again.
      if (!enriched) return false;
      // Release-hardening audit finding LIFECYCLE-06 (extended): a
      // successful GET no longer always means "similarity is now
      // resolved" — enriched.unifiedSimilarityFailed is a real, persisted
      // signal (lib/report-primary-similarity.ts's own resolution.failed,
      // written by both write-time finalization and this same GET route's
      // own self-heal) distinguishing a genuine, reproducible
      // overall-computation failure from "genuinely still processing, try
      // again." hasUnifiedSimilarity(enriched) being false with
      // unifiedSimilarityFailed also false/absent means this exact attempt
      // was inconclusive (e.g. a transient DB error one layer up from
      // computeUnifiedSimilarity's own try/catch) — stays "pending", kept
      // eligible for the next bounded-poll attempt, never silently
      // promoted to "resolved".
      const resolvedSimilarityStatus: DetailSimilarityStatus = enriched.unifiedSimilarityFailed
        ? "failed"
        : hasUnifiedSimilarity(enriched)
          ? "resolved"
          : "pending";
      // These two updates stay adjacent, synchronous statements — no await
      // between them — so React batches both into one commit; see the
      // structural test covering this exact ordering for why that matters
      // (a "resolved"/"failed" status must never be painted alongside a
      // still-old report).
      setSimilarityStatus(resolvedSimilarityStatus);
      setReport((current) => (current ? { ...current, ...enriched } : enriched));
      // Derived fresh from THIS response, never from the outer aiStatus
      // closure — if an earlier poll within this same cycle had already
      // resolved AI to a terminal value, similarity would have settled
      // (resolved, failed, OR still pending — see resolvedSimilarityStatus
      // above) together with it from that SAME earlier call, so bothReady
      // would already have been evaluated then; this effect only reaches
      // a later attempt at all when the prior one was not yet terminal on
      // both sides. The only value that can ever reach here is
      // "processing".
      let resolvedAiStatus: DetailAiStatus = "processing";
      if (enriched.aiAnalysis?.status === "complete") {
        resolvedAiStatus = "ready";
      } else if (enriched.aiAnalysis?.status === "error" || enriched.aiAnalysis?.status === "unsupported") {
        resolvedAiStatus = "failed";
      }
      if (resolvedAiStatus !== "processing") setAiStatus(resolvedAiStatus);
      return computeDetailRevealState({ aiStatus: resolvedAiStatus, similarityStatus: resolvedSimilarityStatus, pollExhausted: false }).screen === "revealed";
    }

    const handle = startBoundedPoll({
      attempt: checkOnce,
      onExhausted: () => setPollExhausted(true),
    });
    return () => {
      cancelled = true;
      handle.cancel();
    };
  }, [id, requiresClientResolution, initialReport, bothReady, pollExhausted]);

  /**
   * Release-hardening audit finding LIFECYCLE-06: starts a genuinely fresh
   * bounded cycle — resetting pollExhausted re-triggers the effect above
   * (it is one of that effect's own dependencies), and startBoundedPoll's
   * own `attempts` counter is scoped to that new call, never resuming a
   * stale count. Mirrors room-page-shell.tsx's own checkAgain().
   */
  function retryAnalysis() {
    setPollExhausted(false);
  }

  useEffect(() => {
    // Anonymous/device-key reports can only ever be resolved client-side.
    // Prefer the instant IndexedDB copy, then fetch the complete remote room
    // in the background if the local copy exists; otherwise use the remote
    // room as the primary source. In practice this path never has a genuine
    // "still processing" window (see isAiTerminal's own comment in
    // lib/report-detail-poll.ts) — the whole report, AI-writing analysis
    // included, is already generated client-side before it is ever saved
    // or shown — so a single settle here (not a poll loop) is enough.
    if (!requiresClientResolution || initialReport) return;
    let cancelled = false;
    (async () => {
      // .catch(() => null): production audit fix — unlike this same call at
      // report-history-row.tsx and room-page-shell.tsx, this site had no
      // error handling at all. getStoredReportById can genuinely reject
      // (storage disabled, private-browsing restrictions, quota/corruption
      // errors), which threw here, left setStatus uncalled, and stranded
      // this view on "Opening report…" forever with no error and no way
      // forward. A rejection now falls through to the same remote-fetch
      // fallback a local miss already takes, below.
      const local = await getStoredReportById<SimilarityReport>(id).catch(() => null);
      if (cancelled) return;
      if (local) {
        setReport(local);
        setStatus("found");
        // local carries at most attachUnifiedSimilarity's own archive+
        // academic-only computation (see lib/document-check-pipeline.ts) —
        // never historicalSubmissionMatch, which can't exist before this
        // report has ever been saved. Still pending until the fetch below
        // settles — the reveal gate above keeps the loading screen up for
        // exactly this window, rather than flashing this partial local
        // copy.
        const enriched = await fetchRemoteReport<SimilarityReport>(id);
        if (cancelled) return;
        setSimilarityStatus("resolved");
        if (enriched) {
          setReport((current) => (current ? { ...current, ...enriched } : enriched));
        }
        return;
      }
      const remote = await fetchRemoteReport<SimilarityReport>(id);
      if (cancelled) return;
      setSimilarityStatus("resolved");
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
      router.push(backHref);
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
              <strong>Opening report…</strong>
              <p>Checking this device for a saved copy.</p>
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

  if (revealState.screen === "still-processing") {
    // Release-hardening audit finding LIFECYCLE-06: the bounded poll budget
    // ran out and at least one pipeline is still genuinely non-terminal —
    // never revealed here, never mutated into "Unavailable." "Back to Room"
    // stays available exactly like the actively-polling screen below, and
    // a manual "Retry analysis" starts a fresh bounded cycle.
    return (
      <div className="result-view report-detail-page">
        <div className="report-not-found-wrap">
          <section className="ai-analysis-message" role="status">
            <strong>—</strong>
            <div>
              <p>Still processing. This report is taking longer than usual to analyze.</p>
              <button className="button subtle" type="button" onClick={retryAnalysis}>Retry analysis</button>
              <Link href={backHref} className="button secondary">{backLabel}</Link>
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (revealState.screen === "loading") {
    return (
      <div className="result-view report-detail-page">
        <div className="report-not-found-wrap">
          <section className="ai-analysis-loading" aria-live="polite" aria-busy="true">
            <span aria-hidden="true" />
            <div>
              <strong>Analysis in progress</strong>
              <p>This report is still being analyzed. It will appear here automatically as soon as everything is ready — no need to refresh.</p>
              <Link href={backHref} className="button secondary">{backLabel}</Link>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const primaryScore = primarySimilarityScore(report);
  const isUnified = hasUnifiedSimilarity(report);
  // Report-source presentation correction, extended by Task A's final
  // report simplification and Task A's authorization correction: this
  // sidebar paragraph AND the "Top source types" CategorySummary block
  // below it both gate on the SAME explicit, server-decided authorization
  // signal (report.viewerIsAdmin — see SimilarityReport's own comment) that
  // gates the equivalent surfaces in components/report/
  // similarity-report-papers.tsx — never on whether report.historicalSubmissionMatch
  // happens to be present, since a real admin's own no-match report would
  // otherwise read as ordinary. An ordinary viewer sees one neutral
  // "TurnitPlus Similarity reflects matched text..." note and no per-source-
  // type percentage breakdown at all; only the authoritative score/word
  // count remain.
  const canSeeSourceBreakdown = Boolean(report.viewerIsAdmin);
  const primaryLabel = primaryResultLabel(report);
  const similarityVerdict = similarityScoreBand(primaryScore);
  const aiSignal = aiSignalDisplay(report);
  const academicEvidenceCount = report.externalAcademicEvidence ? dedupeExternalAcademicEvidence(report.externalAcademicEvidence).length : 0;
  const reportDate = new Date(report.created).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

  return (
    <section className="result-view report-detail-page">
      <header className="result-toolbar">
        <Link href={backHref} className="back-button">
          <ArrowLeft aria-hidden="true" />
          {backLabel}
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

      {/* Production bug fix: a report reached directly by URL (bookmark,
          typed link) whose AI check genuinely failed must say so plainly,
          regardless of which tab is open — a real, persisted ai_status
          "failed", never inferred from poll timing (see revealState's own
          aiUnavailable, computed in lib/report-detail-poll.ts). */}
      {revealState.aiUnavailable && (
        <section className="ai-analysis-message" role="status">
          <strong>—</strong>
          <div>
            <p>AI-writing analysis was unavailable for this document.{!revealState.similarityUnavailable ? " The similarity results below are complete and unaffected." : ""}</p>
            <Link href={backHref} className="button secondary">{backLabel}</Link>
          </div>
        </section>
      )}

      {/* Release-hardening audit finding LIFECYCLE-06 (extended): the
          mirror image of the AI banner above — a real, persisted
          unifiedSimilarityFailed signal (lib/report-primary-similarity.ts's
          own resolution.failed), never inferred from poll timing. */}
      {revealState.similarityUnavailable && (
        <section className="ai-analysis-message" role="status">
          <strong>—</strong>
          <div>
            <p>Similarity analysis is currently unavailable for this document.{!revealState.aiUnavailable ? " The AI-writing result above is complete and unaffected." : ""}</p>
            <Link href={backHref} className="button secondary">{backLabel}</Link>
          </div>
        </section>
      )}

      <div className="report-summary-strip">
        <div>
          <strong className={`summary-chip summary-score-chip ${mode === "ai" ? `ai-summary-chip ai-summary-${aiSignal.tone}` : revealState.similarityUnavailable ? "summary-verdict-pending" : similarityVerdict ? `summary-verdict-${similarityVerdict.key}` : ""}`}>
            <span className={`score-dot ${mode === "ai" ? `ai-dot ai-dot-${aiSignal.tone}` : revealState.similarityUnavailable ? "score-dot-pending" : similarityVerdict ? `score-dot-${similarityVerdict.key}` : ""}`} />
            {mode === "ai"
              ? `${aiSignal.value === null ? "" : `${aiSignal.value}% · `}${aiSignal.label}`
              : revealState.similarityUnavailable ? "Unavailable" : `${primaryScore}% ${primaryLabel}`}
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
          <span className="summary-chip">{report.pageCount || Math.max(1, Math.ceil(report.wordCount / 450))} pages</span>
          <span className="summary-chip">{report.characterCount ? report.characterCount.toLocaleString() : "—"} characters</span>
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
                <OverviewReport report={report} similarityStatus={effectiveSimilarityStatus} />
                <SubmissionReport report={report} />
                <SourcesReport report={report} />
              </div>
            )}
            {resultTab === "overview" && <OverviewReport report={report} similarityStatus={effectiveSimilarityStatus} />}
            {resultTab === "submission" && <SubmissionReport report={report} />}
            {resultTab === "sources" && <SourcesReport report={report} />}
          </>
        )}

        <aside className="report-inspector">
          <div
            className={`inspector-score ${mode === "ai" ? `ai-signal-card-${aiSignal.tone}` : revealState.similarityUnavailable ? "similarity-verdict-pending" : similarityVerdict ? `similarity-verdict-${similarityVerdict.key}` : ""}`}
            aria-label={mode === "ai"
              ? `${aiSignal.value === null ? "no result" : `${aiSignal.value}%`} AI writing score`
              : revealState.similarityUnavailable ? "similarity unavailable" : `${primaryScore}% ${primaryLabel}${similarityVerdict ? `, ${PRIMARY_SIMILARITY_BAND_LABELS[similarityVerdict.key]}` : ""}`}
          >
            <span>{mode === "ai" ? "AI writing score" : revealState.similarityUnavailable ? "Similarity" : primaryLabel}</span>
            <strong>{mode === "ai" ? (aiSignal.value === null ? "—" : `${aiSignal.value}%`) : revealState.similarityUnavailable ? "—" : `${primaryScore}%`}</strong>
            {mode === "ai" && <p className="inspector-writing-estimate">{aiSignal.label}</p>}
            {mode === "similarity" && revealState.similarityUnavailable && <p className="inspector-writing-estimate">Unavailable</p>}
            {mode === "similarity" && !revealState.similarityUnavailable && similarityVerdict && <em>{PRIMARY_SIMILARITY_BAND_LABELS[similarityVerdict.key]}</em>}
            {mode === "similarity" && !revealState.similarityUnavailable && <div><i style={{ width: `${primaryScore * 5}%` }} /></div>}
          </div>
          {/* Ordinary-user simplification (Task A, final report simplification):
              the per-source-type percentage breakdown is a matching-mechanism
              detail, admin-only diagnostics, gated on the same explicit
              viewerIsAdmin-derived signal used everywhere else in this file
              — see the canSeeSourceBreakdown comment above. */}
          {mode === "similarity" && canSeeSourceBreakdown && <div className="inspector-section">
            <h3>Top source types</h3>
            <CategorySummary report={report} />
          </div>}
          <div className="inspector-section">
            <h3>Report notes</h3>
            {mode === "ai" ? <p>
              English-only local analysis. {report.aiAnalysis?.status === "complete"
                ? `${report.aiAnalysis.analyzedWordCount.toLocaleString()} words analyzed. Review the AI writing score and highlighted passage breakdown.`
                : "A numeric result requires at least 300 eligible English words and a successful local model load."}
            </p> : revealState.similarityUnavailable ? <p>
              Similarity analysis could not be completed for this submission.
            </p> : <p>
              {isUnified && canSeeSourceBreakdown
                ? <>TurnitPlus Similarity combines text found through TurnitPlus&apos;s own checks, verified external academic sources, and eligible previous TurnitPlus submissions into one result — the same submitted passage found by more than one source counts once.</>
                : isUnified
                  ? <>TurnitPlus Similarity reflects matched text identified across the sources checked for this submission. Highlighted passages show the text contributing to the result.</>
                  // Matches components/report/similarity-report-papers.tsx's
                  // own OverviewReport guard: the archive-only fallback must
                  // never say "TurnitPlus Similarity" — reserved for a
                  // genuinely computed unified result.
                  : <>This result reflects matched text identified across the sources checked for this submission. Highlighted passages show the text contributing to the result.</>}
              {" "}{primaryMatchedWordCount(report).toLocaleString()} words were matched
              {isUnified ? "." : ` across ${report.sources.length} matched source${report.sources.length === 1 ? "" : "s"}.`}
              {/* Task A correction: only mentioned when authorized — an
                  ordinary viewer never gets Wikipedia body highlighting, so
                  "shown separately" would be false for them. */}
              {canSeeSourceBreakdown && (report.webCheck?.phrasesMatched ?? 0) > 0 && ` Wikipedia evidence is shown separately and does not change this result.`}
              {" "}Language detected: {report.features.detectedLanguage}. Longest matched span: {report.features.longestMatchedSpan} words.
            </p>}
          </div>
        </aside>
      </div>

      <div className="print-report-bundle">
        {mode === "ai" ? <AiReport report={report} printMode /> : <>
          <OverviewReport report={report} similarityStatus={effectiveSimilarityStatus} />
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
