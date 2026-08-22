"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, FileText, LockKeyhole } from "lucide-react";
import { fetchReportRoomContents, fetchRemoteReport, saveReportRemote, type RoomContents } from "@/lib/reports-remote";
import { invalidateRoomCache } from "@/lib/report-rooms-cache";
import { ROOM_CYCLE_MS } from "@/lib/report-rooms";
import { storeReport } from "@/lib/report-store";
import { buildReportSummary, type AiAnalysis, type SimilarityReport } from "@/lib/report-types";
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
import { ReportHistoryRow } from "@/components/reports/report-history-row";
import { DocumentUploadPanel } from "@/components/reports/document-upload-panel";

/**
 * The dedicated room page's client half: owns this ONE room's state, the
 * upload/check flow for it (when empty), and "wait for genuine AI
 * completion" polling (when a report exists but analysis hasn't finished).
 *
 * "Ready" must actually mean ready: this component never presents a report
 * as complete while report.aiScore is still null. A room whose occupant's
 * AI-enriched resave hasn't landed yet (status "processing" — see
 * lib/report-rooms.ts's own header comment for why this is a real,
 * expected window, not a bug) shows an explicit "still analyzing" state
 * instead, and:
 *  - if THIS session is the one that just uploaded the document, the
 *    in-flight AI promise below updates local state directly the moment it
 *    resolves (no polling needed — we already have the answer in memory);
 *  - otherwise (a fresh page load / a different tab / a reload mid-analysis)
 *    it polls the lightweight room endpoint on a bounded interval until the
 *    status flips to "ready", then falls back to one full-report fetch to
 *    tell a genuine AI failure ("error") apart from still-in-flight, rather
 *    than polling forever.
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

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 10;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

type Props = {
  room: number;
  accountEmail: string;
  initialOccupant: RoomContents;
};

export function RoomPageShell({ room, accountEmail, initialOccupant }: Props) {
  const [occupant, setOccupant] = useState<RoomContents>(initialOccupant);
  const [aiUnavailable, setAiUnavailable] = useState(false);
  const [pollExhausted, setPollExhausted] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [processingLabel, setProcessingLabel] = useState("Reading document content");
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [toast, setToast] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generationLockRef = useRef(false);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
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
      const fresh = await fetchReportRoomContents(room);
      if (cancelled) return;
      if (fresh.status !== "processing") {
        setOccupant(fresh);
        return;
      }
      if (attempts >= MAX_POLL_ATTEMPTS) {
        // Bounded: fall back to one real check of the full payload to tell
        // a genuine AI failure apart from still-in-flight, rather than
        // polling forever — see this file's own header comment.
        const full = occupant.report ? await fetchRemoteReport<SimilarityReport>(occupant.report.id) : null;
        if (cancelled) return;
        if (full?.aiAnalysis?.status === "error") {
          setAiUnavailable(true);
        } else {
          setPollExhausted(true);
        }
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
    setAiUnavailable(false);
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

    let aiPrepStage: AiPrepStage | null = "preparing";
    const aiAnalysisPromise = analyzeAiText(text, report.features.detectedLanguage, (stage) => {
      aiPrepStage = stage;
    }).then((aiAnalysis) => ({ aiScore: aiAnalysis.score, aiAnalysis }))
      .catch((error) => ({
        aiScore: null,
        aiAnalysis: {
          status: "error" as const,
          score: null,
          model: AI_MODEL_VERSION,
          engine: null,
          threshold: AI_PASSAGE_THRESHOLD,
          thresholdLogOdds: AI_PASSAGE_LOG_ODDS_THRESHOLD,
          eligibleWordCount: 0,
          analyzedWordCount: 0,
          passages: [],
          error: describeAiAnalysisError(error, aiPrepStage),
        },
      }));

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
      const summary = buildReportSummary(report);
      await storeReport(report);
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
      // marks this room "ready" — never optimistically, never before this.
      void aiAnalysisPromise.then(async (aiResult) => {
        const enriched = { ...report, ...aiResult };
        const enrichedSummary = buildReportSummary(enriched);
        await storeReport(enriched);
        const enrichedSaveResult = await saveReportRemote(enriched, enrichedSummary, undefined, room);
        if (enrichedSaveResult.ok) {
          invalidateRoomCache(accountEmail, room);
          setOccupant({ status: "ready", report: enrichedSummary, cycleEndsAt: new Date(Date.parse(enrichedSummary.createdAt) + ROOM_CYCLE_MS).toISOString() });
        }
      });
    } finally {
      generationLockRef.current = false;
      setIsGeneratingReport(false);
    }
  }

  return (
    <section className="result-view report-detail-page room-page">
      <header className="result-toolbar">
        <Link href="/#reports" className="back-button">
          <ChevronLeft aria-hidden="true" />
          Back to My Reports
        </Link>
        <div className="result-document">
          <FileText aria-hidden="true" />
          <div>
            <h1>Room {room + 1}</h1>
          </div>
        </div>
      </header>

      {toast && <div className="ai-analysis-message" role="status"><p>{toast}</p></div>}

      {occupant.status === "empty" && (
        <div className="room-empty-slot">
          <p className="room-status-label">Ready for a new check</p>
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
        <div className="room-processing-panel">
          <p className="room-status-label">Report ready · similarity result complete</p>
          <h2>{occupant.report.title}</h2>
          <p>{occupant.report.wordCount.toLocaleString()} words · {occupant.report.archiveScore}% similarity</p>
          {aiUnavailable ? (
            <p className="room-cycle-note">AI-writing analysis was unavailable for this document. The similarity result above is complete.</p>
          ) : pollExhausted ? (
            <div className="ai-analysis-message" role="status">
              <p>AI analysis is taking longer than usual.</p>
              <button className="button subtle" type="button" onClick={checkAgain}>Check again</button>
            </div>
          ) : (
            <div className="ai-analysis-loading" role="status" aria-live="polite">
              <span aria-hidden="true" />
              <div>
                <strong>Finishing AI-writing analysis…</strong>
                <p>This document's similarity result is ready; the AI-writing score is still being computed.</p>
              </div>
            </div>
          )}
          <Link href={`/reports/${occupant.report.id}`} className="button secondary">Open full report</Link>
        </div>
      )}

      {occupant.status === "ready" && occupant.report && (
        <div className="report-history">
          <ReportHistoryRow report={occupant.report} onDownloadReceipt={downloadReceipt} />
          <p className="room-cycle-note">
            This room becomes available again: {formatDateTime(occupant.cycleEndsAt)}.
          </p>
        </div>
      )}
    </section>
  );
}
