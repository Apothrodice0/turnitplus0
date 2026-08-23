"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Download, FileText } from "lucide-react";
import { fetchReportRoomContents, fetchRemoteReport, saveReportRemote, type ReportSummary, type RoomContents } from "@/lib/reports-remote";
import { invalidateRoomCache } from "@/lib/report-rooms-cache";
import { ROOM_CYCLE_MS } from "@/lib/report-rooms";
import { storeReportBestEffort, getStoredReportById } from "@/lib/report-store";
import { persistAiCompletion } from "@/lib/report-ai-completion";
import { buildReportSummary, type AiAnalysis, type SimilarityReport } from "@/lib/report-types";
import { similarityScoreBand } from "@/lib/ai-core";
import {
  analyzeAcademicEvidence,
  analyzeText,
  analyzeWikipediaText,
  attachUnifiedSimilarity,
  downloadReceipt,
  enrichReportWithAcademicEvidence,
  enrichReportWithWikipedia,
  extractFileText,
} from "@/lib/document-check-pipeline";
import { normalizeExtractedText } from "@/lib/extracted-text-normalization";
import { AI_MODEL_VERSION, AI_PASSAGE_LOG_ODDS_THRESHOLD, AI_PASSAGE_THRESHOLD } from "@/lib/ai-core";
import { describeAiAnalysisError, type AiPrepStage } from "@/lib/ai-model-prep";
import { DocumentUploadPanel } from "@/components/reports/document-upload-panel";

/**
 * The dedicated room page's client half: owns this ONE room's state, the
 * upload/check flow for it (when empty), and "wait for genuine AI
 * completion" polling (when a report exists but analysis hasn't finished).
 *
 * "Ready" must actually mean ready: this component never presents a report
 * as complete while report.aiScore is still null, and (production audit
 * fix) never presents a genuinely failed AI check as either "still
 * processing" or silently "ready" with a blank score — see
 * saveEnrichedAiResult and lib/report-rooms.ts's deriveRoomStatus, the
 * single place that decides "processing" vs "ready" vs "failed" from the
 * persisted ai_score/ai_status columns. A room whose occupant's AI-enriched
 * resave hasn't landed yet (status "processing" — see lib/report-rooms.ts's
 * own header comment for why this is a real, expected window, not a bug)
 * shows an explicit "still analyzing" state instead, and:
 *  - if THIS session is the one that just uploaded the document, the
 *    in-flight AI promise below updates local state directly the moment it
 *    resolves (no polling needed — we already have the answer in memory);
 *  - otherwise (a fresh page load / a different tab / a reload mid-analysis)
 *    it polls the lightweight room endpoint on a bounded interval — a
 *    genuine AI failure arrives as its own "failed" status through this
 *    same poll, no special-casing needed; a room still "processing" once
 *    the poll is exhausted offers a manual recheck instead of polling
 *    forever. A "failed" room offers its own manual retry (retryAiCheck)
 *    that re-runs AI analysis from the already-extracted text, no
 *    re-upload required.
 *
 * Duplicates the small AI-worker/cancellation plumbing
 * (analyzeAiText/pendingAiReject) that tests/ai-model-prep.test.mjs pins to
 * app/page.tsx's own source — see lib/document-check-pipeline.ts's own
 * header comment for why that one piece is deliberately NOT shared, while
 * everything else in the pipeline (analyzeText, analyzeWikipediaText,
 * analyzeAcademicEvidence, extractFileText, the enrichment functions,
 * downloadReceipt) is imported from there rather than duplicated too.
 */

let aiDetectorWorker: Worker | null = null;
let aiWorkerRequestId = 0;
let pendingAiReject: ((error: Error) => void) | null = null;

async function analyzeAiText(
  text: string,
  detectedLanguage: SimilarityReport["features"]["detectedLanguage"],
  onProgress: (stage: AiPrepStage) => void,
): Promise<AiAnalysis> {
  aiDetectorWorker ??= new Worker(new URL("../../../ai-detector-worker.ts", import.meta.url), { type: "module" });
  const id = ++aiWorkerRequestId;
  return new Promise<AiAnalysis>((resolve, reject) => {
    pendingAiReject = reject;
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === "prep") {
        onProgress(event.data.stage);
        return;
      }
      if (event.data.type === "progress") return;
      if (event.data.id !== id) return;
      aiDetectorWorker?.removeEventListener("message", handleMessage);
      if (pendingAiReject === reject) pendingAiReject = null;
      if (event.data.ok) resolve(event.data.result as AiAnalysis);
      else reject(new Error(event.data.error));
    };
    aiDetectorWorker?.addEventListener("message", handleMessage);
    aiDetectorWorker?.postMessage({ id, text, detectedLanguage });
  });
}

/**
 * The structured "AI analysis genuinely failed" result shape — extracted so
 * runAiAnalysis's own catch and the outer recovery catch in runCheck (for
 * the case where aiAnalysisPromise itself somehow rejects rather than
 * resolving through runAiAnalysis's own try/catch) can never drift apart.
 */
export function aiAnalysisErrorResult(error: unknown, stage: AiPrepStage | null): { aiScore: number | null; aiAnalysis: AiAnalysis } {
  return {
    aiScore: null,
    aiAnalysis: {
      status: "error",
      score: null,
      model: AI_MODEL_VERSION,
      engine: null,
      threshold: AI_PASSAGE_THRESHOLD,
      thresholdLogOdds: AI_PASSAGE_LOG_ODDS_THRESHOLD,
      eligibleWordCount: 0,
      analyzedWordCount: 0,
      passages: [],
      error: describeAiAnalysisError(error, stage),
    },
  };
}

/**
 * analyzeAiText, but never rejects — a worker crash/timeout becomes a real
 * AiAnalysis with status "error" instead of an unhandled rejection, exactly
 * matching how a genuinely "unsupported" (too little eligible text) result
 * already looks structurally. Shared by both the automatic post-upload AI
 * pass (runCheck below) and the manual retry (retryAiCheck) so the two can
 * never drift into different failure-shape handling.
 */
export async function runAiAnalysis(
  text: string,
  detectedLanguage: SimilarityReport["features"]["detectedLanguage"],
): Promise<{ aiScore: number | null; aiAnalysis: AiAnalysis }> {
  let aiPrepStage: AiPrepStage | null = "preparing";
  try {
    const aiAnalysis = await analyzeAiText(text, detectedLanguage, (stage) => {
      aiPrepStage = stage;
    });
    return { aiScore: aiAnalysis.score, aiAnalysis };
  } catch (error) {
    return aiAnalysisErrorResult(error, aiPrepStage);
  }
}

/**
 * Awaits the AI-analysis promise and persists it via `save` (in practice,
 * saveEnrichedAiResult), the ONE place that ever moves a room off
 * "processing". runAiAnalysis already guarantees its own promise never
 * rejects, and saveEnrichedAiResult's own I/O is contained by
 * persistAiCompletion — but this boundary must hold even if either
 * invariant is ever violated by a future change. A bare `.catch()` here
 * would be enough to avoid an unhandled rejection, but it would also skip
 * `save` entirely on a genuine rejection, leaving the room stuck at
 * "processing" with no attempt ever made to move it — exactly the bug this
 * whole fix exists to close. So on any rejection, this still ATTEMPTS to
 * persist a real "failed" terminal state (aiAnalysisErrorResult), with that
 * recovery attempt itself guarded so it can never throw a second time.
 * Extracted (rather than inlined in runCheck) so it's directly testable
 * without a React render — see tests/report-ai-completion.test.mjs.
 */
export async function completeAiAnalysisWithRecovery(
  aiAnalysisPromise: Promise<{ aiScore: number | null; aiAnalysis: AiAnalysis }>,
  save: (aiResult: { aiScore: number | null; aiAnalysis: AiAnalysis }) => Promise<boolean>,
): Promise<boolean> {
  try {
    const aiResult = await aiAnalysisPromise;
    return await save(aiResult);
  } catch (error) {
    console.error("Unexpected failure finishing AI analysis — attempting to persist a terminal failed state:", error instanceof Error ? error.message : String(error));
    try {
      return await save(aiAnalysisErrorResult(error, null));
    } catch (persistError) {
      console.error("Could not persist the terminal failed state either (non-fatal — recoverable via Retry AI check):", persistError instanceof Error ? persistError.message : String(persistError));
      return false;
    }
  }
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 10;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/** Mirrors components/reports/report-history-row.tsx's own labeling, kept local here since this page builds its own compact metric cards rather than reusing that component's row layout. */
function aiToneLabel(aiScore: number | null, aiTone: string | null): string {
  if (aiScore === null) return "Pending";
  if (aiTone === "low") return "Low AI indicators";
  if (aiTone === "review") return "Moderate AI indicators";
  if (aiTone === "high") return "Strong AI indicators";
  return "Pending";
}

type Props = {
  room: number;
  accountEmail: string;
  initialOccupant: RoomContents;
};

export function RoomPageShell({ room, accountEmail, initialOccupant }: Props) {
  const [occupant, setOccupant] = useState<RoomContents>(initialOccupant);
  const [pollExhausted, setPollExhausted] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [processingLabel, setProcessingLabel] = useState("Reading document content");
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [downloadingReceipt, setDownloadingReceipt] = useState(false);
  const [retryingAi, setRetryingAi] = useState(false);
  const [toast, setToast] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generationLockRef = useRef(false);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  async function handleDownloadReceipt(reportId: string) {
    setDownloadingReceipt(true);
    try {
      // Production audit fix: both the "report not found anywhere" and the
      // "downloadReceipt itself threw" cases (e.g. its own font-loading
      // fetch failed) used to be entirely silent — the button just flipped
      // back to "Receipt" with no indication anything went wrong.
      const local = await getStoredReportById<SimilarityReport>(reportId).catch(() => null);
      const full = local ?? (await fetchRemoteReport<SimilarityReport>(reportId));
      if (full) {
        await downloadReceipt(full);
      } else {
        notify("Couldn't find this report to generate a receipt. Please try again.");
      }
    } catch {
      notify("Couldn't generate the receipt. Please try again.");
    } finally {
      setDownloadingReceipt(false);
    }
  }

  /**
   * Persists an AI result (success or genuine failure) onto an already-saved
   * report and updates this room's occupant to match — the one place that
   * ever marks a room "ready" or "failed", used by both the automatic
   * post-upload pass (runCheck below) and the manual retry (retryAiCheck).
   * Returns whether the save itself succeeded; the caller decides what to
   * tell the user.
   */
  async function saveEnrichedAiResult(report: SimilarityReport, aiResult: { aiScore: number | null; aiAnalysis: AiAnalysis }): Promise<boolean> {
    const enriched = { ...report, ...aiResult };
    const enrichedSummary: ReportSummary = {
      ...buildReportSummary(enriched),
      aiStatus: aiResult.aiAnalysis.status === "complete" ? "ready" : "failed",
    };
    const enrichedSaveResult = await persistAiCompletion(enriched, enrichedSummary, room);
    if (!enrichedSaveResult.ok) return false;
    invalidateRoomCache(accountEmail, room);
    setOccupant({
      status: enrichedSummary.aiStatus === "ready" ? "ready" : "failed",
      report: enrichedSummary,
      cycleEndsAt: new Date(Date.parse(enrichedSummary.createdAt) + ROOM_CYCLE_MS).toISOString(),
    });
    return true;
  }

  /**
   * Manual re-run for a room whose AI check genuinely failed (occupant.status
   * === "failed") — the similarity result is already saved and unaffected;
   * this only re-attempts the AI half, using the full report's own already-
   * extracted text (no re-upload needed).
   */
  async function retryAiCheck(reportId: string) {
    if (retryingAi) return;
    setRetryingAi(true);
    try {
      const local = await getStoredReportById<SimilarityReport>(reportId).catch(() => null);
      const full = local ?? (await fetchRemoteReport<SimilarityReport>(reportId));
      if (!full) {
        notify("Could not load this report to retry AI analysis. Please try again.");
        return;
      }
      const aiResult = await runAiAnalysis(full.text, full.features.detectedLanguage);
      const saved = await saveEnrichedAiResult(full, aiResult);
      notify(
        !saved
          ? "Could not save the updated AI result. Please try again."
          : aiResult.aiAnalysis.status === "complete"
            ? "AI analysis complete."
            : "AI analysis is still unavailable for this document.",
      );
    } finally {
      setRetryingAi(false);
    }
  }

  // Poll for genuine AI completion when this room is "processing" and this
  // session did NOT just start that check itself (isGeneratingReport is the
  // in-flight-upload path below, which already updates `occupant` directly
  // the moment its own AI promise resolves — running both at once would
  // just be redundant work, not incorrect, but there's no reason to).
  useEffect(() => {
    if (occupant.status !== "processing" || isGeneratingReport || pollExhausted) return;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;

    async function poll() {
      attempts += 1;
      const result = await fetchReportRoomContents(room);
      if (cancelled) return;
      // A failed poll request (429/500/timeout/network error) must never be
      // treated as "the room is now empty" or as confirmation of anything —
      // production bug fix. It's simply inconclusive, exactly like a
      // still-"processing" result: keep polling until a genuine non-
      // processing status arrives or the attempt budget runs out.
      if (result.ok && result.contents.status !== "processing") {
        setOccupant(result.contents);
        return;
      }
      if (attempts >= MAX_POLL_ATTEMPTS) {
        // Bounded: a genuine AI failure now arrives as its own "failed"
        // status via the normal branch above (production audit fix), so
        // reaching this cap means genuinely still unresolved — most likely
        // the tab that started the check is gone (closed/crashed) before
        // its save landed, or this device has had persistent connectivity
        // trouble. Offer a manual recheck rather than polling forever.
        setPollExhausted(true);
        return;
      }
      timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    }
    timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [occupant, room, isGeneratingReport, pollExhausted]);

  function checkAgain() {
    setPollExhausted(false);
  }

  function chooseFile(selected: File | undefined) {
    if (generationLockRef.current) {
      notify("Please wait for the current check to finish before choosing another document.");
      return;
    }
    if (!selected) return;
    const extension = selected.name.split(".").pop()?.toLowerCase();
    if (!["pdf", "docx", "txt", "md", "html", "csv"].includes(extension ?? "")) {
      notify("Choose a PDF, DOCX, TXT, MD, HTML, or CSV file.");
      return;
    }
    if (selected.size > 10 * 1024 * 1024) {
      notify("The file must be 10 MB or smaller.");
      return;
    }
    setFile(selected);
  }

  async function runCheck() {
    if (generationLockRef.current) {
      notify("Your current document is still being analyzed.");
      return;
    }
    if (!file) {
      notify("Choose a document to generate the report.");
      return;
    }

    const submittedFile = file;
    generationLockRef.current = true;
    setIsGeneratingReport(true);
    setProgress(4);
    setProcessingLabel("Reading document content");
    const minimumProcessingMs = 8_000 + Math.floor(Math.random() * 7_001);
    const animationStartedAt = Date.now();
    const progressTimer = window.setInterval(() => {
      const elapsed = Date.now() - animationStartedAt;
      setProgress(Math.min(95, 4 + Math.round((elapsed / minimumProcessingMs) * 91)));
    }, 250);

    let text = "";
    try {
      text = normalizeExtractedText(await extractFileText(submittedFile, (_value, label) => setProcessingLabel(label)));
    } catch {
      notify("I could not read that document. Try another file.");
      window.clearInterval(progressTimer);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }

    if (text.length < 80) {
      notify("Add at least 80 characters to create a useful report.");
      window.clearInterval(progressTimer);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }

    const wikipediaPromise = analyzeWikipediaText(text, submittedFile.name, () => undefined).catch((error) => {
      console.debug("Wikipedia check failed.", { outcome: "failed", error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    const academicEvidencePromise = analyzeAcademicEvidence(text);

    let report: SimilarityReport;
    try {
      report = await analyzeText(text, submittedFile.name, submittedFile.size, (_value, label) => setProcessingLabel(label));
    } catch {
      notify("The private document corpus could not be loaded. Please try again.");
      window.clearInterval(progressTimer);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }

    const aiAnalysisPromise = runAiAnalysis(text, report.features.detectedLanguage);

    setProcessingLabel("Checking external academic sources");
    const [webCheck, academicResult] = await Promise.all([wikipediaPromise, academicEvidencePromise]);
    if (webCheck) report = enrichReportWithWikipedia(report, webCheck);
    report = enrichReportWithAcademicEvidence(report, academicResult);
    report = attachUnifiedSimilarity(report);

    const remainingAnimationMs = Math.max(0, minimumProcessingMs - (Date.now() - animationStartedAt));
    if (remainingAnimationMs > 0) await new Promise((resolve) => window.setTimeout(resolve, remainingAnimationMs));
    window.clearInterval(progressTimer);
    setProgress(100);
    setProcessingLabel("Saving your report");

    try {
      // Explicitly "processing" (not left implicit as "no aiStatus yet") so
      // a legacy-vs-fresh row is never ambiguous — see
      // lib/report-rooms.ts's deriveRoomStatus.
      const summary: ReportSummary = { ...buildReportSummary(report), aiStatus: "processing" };
      await storeReportBestEffort(report);
      // The upload request always names its room explicitly — the server
      // re-validates occupancy itself (409 if this room filled in the
      // meantime) rather than trusting this client's own view of it.
      const saveResult = await saveReportRemote(report, summary, academicResult.academicSearchDiagnosticsId, room);
      if (!saveResult.ok) {
        if (saveResult.quotaExceeded) {
          const resetLabel = saveResult.resetsAt
            ? new Date(saveResult.resetsAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })
            : "midnight UTC";
          notify(saveResult.error ?? `Daily upload limit reached. This report is saved on this device only until the limit resets at ${resetLabel}.`);
        } else if (saveResult.roomOccupied) {
          notify(saveResult.error ?? "This room already has an active check. Refresh to see it, or wait for it to reset.");
        } else {
          notify("Your report was generated but could not be saved. Please try again.");
        }
        return;
      }

      invalidateRoomCache(accountEmail, room);
      // We know the true state directly — no need to fetch it back. AI is
      // genuinely not done yet (the promise below is still in flight), so
      // this is "processing", never "ready", regardless of how the save
      // response is phrased.
      setOccupant({ status: "processing", report: summary, cycleEndsAt: new Date(Date.now() + ROOM_CYCLE_MS).toISOString() });
      notify(
        academicResult.status === "FAILED"
          ? "Your report is saved. External academic verification was unavailable this time; finishing AI analysis…"
          : "Your report is saved. Finishing AI analysis…",
      );

      // Deliberately not awaited, matching app/page.tsx's own generateReport()
      // — the generation lock releases as soon as the similarity result is
      // saved, so the user isn't blocked on a possibly-slow AI model
      // download. Whenever it resolves, this is the ONE place that ever
      // marks this room "ready" or "failed" — never optimistically, never
      // before this, and never silently defaulting to "ready" regardless of
      // outcome (production audit fix — see saveEnrichedAiResult above).
      //
      // Release-hardening audit finding LIFECYCLE-01: saveEnrichedAiResult
      // itself can no longer throw (its own I/O is contained by
      // persistAiCompletion) and runAiAnalysis guarantees aiAnalysisPromise
      // never rejects either — but this boundary must hold even if either
      // invariant is ever violated by a future change, so the recovery
      // branch below still ATTEMPTS to persist a genuine "failed" terminal
      // state (not just log and swallow) if aiAnalysisPromise itself were to
      // reject: skipping straight to a bare .catch() would skip
      // saveEnrichedAiResult entirely, leaving the room stuck at
      // "processing" with no attempt ever made to move it — exactly the bug
      // this whole fix exists to close. The recovery attempt is itself
      // guarded so it can never throw a second time. The genuine recovery
      // path — reachable from ANY tab, on refresh, indefinitely into the
      // future, regardless of whether this attempt lands — is the
      // "processing" branch's own "Retry AI check" action below; the
      // notify() calls here are only a same-tab courtesy.
      void completeAiAnalysisWithRecovery(aiAnalysisPromise, (aiResult) => saveEnrichedAiResult(report, aiResult)).then((saved) => {
        if (!saved) notify("AI analysis finished but could not be saved. Retry AI check once analysis settles, or reopen this room.");
      });
    } finally {
      generationLockRef.current = false;
      setIsGeneratingReport(false);
    }
  }

  const statusLine =
    occupant.status === "ready" && occupant.report ? `Report ready · Last checked ${formatDate(occupant.report.createdAt)}`
    : occupant.status === "processing" ? "Report ready · finishing AI analysis"
    : occupant.status === "failed" ? "Report ready · AI analysis unavailable"
    : "Ready for a new check";

  return (
    <div className="room-page">
      <div className="room-page-container">
        <Link href="/#reports" className="back-button room-back-button">
          <ChevronLeft aria-hidden="true" />
          Back to My Reports
        </Link>

        <div className="room-page-heading">
          <FileText aria-hidden="true" />
          <div>
            <h1>Room {room + 1}</h1>
            <p className="room-page-status">{statusLine}</p>
          </div>
        </div>

        {toast && <div className="ai-analysis-message" role="status"><p>{toast}</p></div>}

        {occupant.status === "empty" && (
          <div className="room-empty-slot">
            <DocumentUploadPanel
              file={file}
              isGeneratingReport={isGeneratingReport}
              progress={progress}
              processingLabel={processingLabel}
              fileInputRef={fileInputRef}
              onChooseFile={chooseFile}
              onGenerate={runCheck}
            />
          </div>
        )}

        {occupant.status === "processing" && occupant.report && (
          <div className="room-report-card">
            <div className="room-report-card-header">
              <FileText aria-hidden="true" />
              <div>
                <strong>{occupant.report.title}</strong>
                <span>{formatDate(occupant.report.createdAt)} · {occupant.report.wordCount.toLocaleString()} words</span>
              </div>
            </div>

            {/* Production bug fix: while genuinely processing, nothing here
                may present as finished. Similarity is technically computed
                first server-side, but surfacing its real number (or a link
                into the full report) here let a user open /reports/[id]
                before the room itself is ready — neither metric is a link,
                neither shows a number, and there is no "Open full report"
                escape hatch at all until this room reaches "ready" or
                "failed" below. */}
            <div className="room-report-metrics">
              <div className="room-metric room-metric-pending">
                <span className="room-metric-label">AI Detection</span>
                <strong className="room-metric-value">···</strong>
                <span className="room-metric-sub">Analyzing…</span>
              </div>
              <div className="room-metric room-metric-pending">
                <span className="room-metric-label">Similarity</span>
                <strong className="room-metric-value">···</strong>
                <span className="room-metric-sub">Analyzing…</span>
              </div>
              <button className="room-metric" type="button" disabled>
                <span className="room-metric-label">Receipt</span>
                <Download aria-hidden="true" className="room-metric-icon" />
                <span className="room-metric-sub">Preparing…</span>
              </button>
            </div>

            {pollExhausted ? (
              <div className="ai-analysis-message" role="status">
                <p>AI analysis is taking longer than usual.</p>
                <button className="button subtle" type="button" onClick={checkAgain}>Check again</button>
                {/* Release-hardening audit finding LIFECYCLE-01: a room can
                    reach this exhausted-poll state either because analysis
                    is genuinely still running elsewhere (another tab/device
                    — "Check again" alone is correct there) or because the
                    session that started it closed/crashed/failed to save
                    before ever writing "ready" or "failed" — permanently
                    stranding this room at "processing" with no other code
                    path that will ever move it. retryAiCheck is idempotent
                    (re-runs analysis from the already-persisted text and
                    resaves via the same UPSERT saveEnrichedAiResult uses),
                    so offering it here too is always safe, and is the one
                    thing that can recover a genuinely stuck room — the
                    same action already trusted for the "failed" branch
                    below, now also reachable before a "failed" status ever
                    gets written, which is exactly the gap that let a room
                    get permanently stuck without ever reaching "failed" in
                    the first place. */}
                <button className="button subtle" type="button" onClick={() => retryAiCheck(occupant.report!.id)} disabled={retryingAi}>
                  {retryingAi ? "Checking…" : "Retry AI check"}
                </button>
              </div>
            ) : (
              <div className="ai-analysis-loading" role="status" aria-live="polite">
                <span aria-hidden="true" />
                <div>
                  <strong>Finishing AI-writing analysis…</strong>
                  <p>The AI-writing score will appear here as soon as it's ready.</p>
                </div>
              </div>
            )}
          </div>
        )}

        {occupant.status === "ready" && occupant.report && (
          <div className="room-report-card">
            <div className="room-report-card-header">
              <FileText aria-hidden="true" />
              <div>
                <strong>{occupant.report.title}</strong>
                <span>{formatDate(occupant.report.createdAt)} · {occupant.report.wordCount.toLocaleString()} words</span>
              </div>
            </div>

            <div className="room-report-metrics">
              <Link href={`/reports/${occupant.report.id}?mode=ai&room=${room}`} className={`room-metric room-metric-${occupant.report.aiTone ?? "unavailable"}`}>
                <span className="room-metric-label">AI Detection</span>
                <strong className="room-metric-value">{occupant.report.aiScore ?? "—"}%</strong>
                <span className="room-metric-sub">{aiToneLabel(occupant.report.aiScore, occupant.report.aiTone)}</span>
              </Link>
              <Link href={`/reports/${occupant.report.id}?room=${room}`} className={`room-metric room-metric-${similarityScoreBand(occupant.report.primaryScore ?? occupant.report.archiveScore)?.key ?? "low"}`}>
                <span className="room-metric-label">Similarity</span>
                <strong className="room-metric-value">{occupant.report.primaryScore ?? occupant.report.archiveScore}%</strong>
                <span className="room-metric-sub">{similarityScoreBand(occupant.report.primaryScore ?? occupant.report.archiveScore)?.label ?? "Result"}</span>
              </Link>
              <button className="room-metric" type="button" onClick={() => handleDownloadReceipt(occupant.report!.id)} disabled={downloadingReceipt}>
                <span className="room-metric-label">Receipt</span>
                <Download aria-hidden="true" className="room-metric-icon" />
                <span className="room-metric-sub">{downloadingReceipt ? "Preparing…" : "Download"}</span>
              </button>
            </div>

            <p className="room-cycle-note">
              This room becomes available again: {formatDateTime(occupant.cycleEndsAt)}.
            </p>
          </div>
        )}

        {occupant.status === "failed" && occupant.report && (
          <div className="room-report-card">
            <div className="room-report-card-header">
              <FileText aria-hidden="true" />
              <div>
                <strong>{occupant.report.title}</strong>
                <span>{formatDate(occupant.report.createdAt)} · {occupant.report.wordCount.toLocaleString()} words</span>
              </div>
            </div>

            <div className="room-report-metrics">
              <div className="room-metric room-metric-unavailable">
                <span className="room-metric-label">AI Detection</span>
                <strong className="room-metric-value">—</strong>
                <span className="room-metric-sub">Unavailable</span>
              </div>
              <Link href={`/reports/${occupant.report.id}?room=${room}`} className={`room-metric room-metric-${similarityScoreBand(occupant.report.primaryScore ?? occupant.report.archiveScore)?.key ?? "low"}`}>
                <span className="room-metric-label">Similarity</span>
                <strong className="room-metric-value">{occupant.report.primaryScore ?? occupant.report.archiveScore}%</strong>
                <span className="room-metric-sub">{similarityScoreBand(occupant.report.primaryScore ?? occupant.report.archiveScore)?.label ?? "Result"}</span>
              </Link>
              <button className="room-metric" type="button" onClick={() => handleDownloadReceipt(occupant.report!.id)} disabled={downloadingReceipt}>
                <span className="room-metric-label">Receipt</span>
                <Download aria-hidden="true" className="room-metric-icon" />
                <span className="room-metric-sub">{downloadingReceipt ? "Preparing…" : "Download"}</span>
              </button>
            </div>

            <div className="ai-analysis-message" role="status">
              <p>AI-writing analysis was unavailable for this document. The similarity result above is complete and unaffected.</p>
              <button className="button subtle" type="button" onClick={() => retryAiCheck(occupant.report!.id)} disabled={retryingAi}>
                {retryingAi ? "Checking…" : "Retry AI check"}
              </button>
            </div>

            <Link href={`/reports/${occupant.report.id}?room=${room}`} className="button secondary room-open-full">Open full report</Link>
          </div>
        )}
      </div>
    </div>
  );
}
