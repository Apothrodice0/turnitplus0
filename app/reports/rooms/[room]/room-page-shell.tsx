"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Download, FileText } from "lucide-react";
import { fetchReportRoomContents, fetchRemoteReport, saveReportRemote, type ReportSummary, type RoomContents, type RoomContentsFetchResult } from "@/lib/reports-remote";
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
import { detectLanguage } from "@/lib/similarity-core";
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
 * pass (runCheck below) and the manual retry (retryAiCheck, via
 * retryAiAnalysisWithFreshLanguage) so the two can never drift into
 * different failure-shape handling.
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
 * The fix for the "language-misclassification stranded reports forever"
 * bug: Retry analysis must NEVER trust a report's own persisted
 * features.detectedLanguage — that value was computed once, at whatever
 * moment the report was originally saved, by whatever version of
 * lib/similarity-core.ts's detectLanguage() existed then. A report
 * genuinely misclassified by an old, less accurate detector (or one that
 * will be fixed again in the future) would otherwise retry forever with
 * the exact same wrong input and the exact same "unsupported" outcome —
 * runAiAnalysis's own language-eligibility gate (app/ai-detector-worker.ts)
 * has no way to know the stored value might be stale.
 *
 * This always re-derives the language FRESH from the report's own already-
 * extracted text, using whatever the CURRENT detectLanguage() is — so a
 * report that was wrongly classified under an older detector recovers
 * automatically on the next manual retry, once a fix ships, with no
 * re-upload and no direct database repair needed. Extracted from
 * retryAiCheck so it's directly testable without a React render — same
 * reasoning as runAiAnalysis's own header comment.
 */
export async function retryAiAnalysisWithFreshLanguage(text: string): Promise<{ aiScore: number | null; aiAnalysis: AiAnalysis }> {
  return runAiAnalysis(text, detectLanguage(text));
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
      console.error("Could not persist the terminal failed state either (non-fatal — recoverable via Retry analysis):", persistError instanceof Error ? persistError.message : String(persistError));
      return false;
    }
  }
}

// Exported (visibility-only change, values unchanged) so tests can assert
// exhaustion happens at exactly the real, current policy rather than a
// magic literal that could silently drift from it.
export const POLL_INTERVAL_MS = 3000;
export const MAX_POLL_ATTEMPTS = 10;

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

/**
 * Release-hardening audit finding LIFECYCLE-05: AI-writing detection and
 * unified similarity are independent PIPELINES (see the "processing"
 * branch's own LIFECYCLE-03 comment below for why they finalize on their
 * own schedules), but this room card DELIBERATELY presents their
 * completion as one atomic event: "reveal AI score, unified similarity
 * score, and receipt together." Real, if rare, orderings exist where
 * ai_status has already reached a terminal value (ready/failed) while
 * similarity is still "stale"/"pending" (a write-time finalization that
 * genuinely failed, or a corpus promotion landing after this report's own
 * save) — this occupant is NOT yet fully revealed either. An AI FAILURE
 * still counts as terminal on the AI side (occupant.status "failed" is a
 * real, final answer — "Unavailable," never a reason to keep waiting), so
 * only similarity's own tri-state gates the second half of this check.
 * `undefined` (a legacy summary predating this field) is treated as
 * resolved, matching SimilarityMetricTile's own identical convention just
 * below — there is exactly one interpretation of "absent" in this file,
 * not two that could quietly drift apart.
 */
/**
 * Release-hardening audit finding LIFECYCLE-06 (extended): similarityStatus
 * can now also be "failed" — a real, persisted, reproducible
 * overall-computation failure (lib/report-primary-similarity.ts's own
 * resolution.failed) — which this check already treats as revealed
 * without any code change, since it is neither "stale" nor "pending".
 * SimilarityMetricTile below is the piece that actually renders it, as
 * "Unavailable" rather than a number.
 */
export function isFullyRevealed(occupant: RoomContents): boolean {
  if (occupant.status !== "ready" && occupant.status !== "failed") return false;
  const similarityStatus = occupant.report?.similarityStatus;
  return similarityStatus !== "stale" && similarityStatus !== "pending";
}

export type PollTickResult =
  | { outcome: "revealed"; occupant: RoomContents }
  | { outcome: "exhausted"; occupant?: RoomContents }
  | { outcome: "continue"; occupant?: RoomContents };

/**
 * Defect #2 fix: the completion-poll effect's per-tick decision, extracted
 * into a pure function so the attempt-budget behavior is directly testable
 * without a React render — the same reason completeAiAnalysisWithRecovery
 * below is extracted rather than inlined in runCheck. Behavior-preserving
 * extraction of exactly what the poll effect's own body used to do inline;
 * see tests/room-page-shell.test.mjs for the regression this exists to
 * prove: a sequence of fresh, distinct, non-terminal responses must still
 * reach "exhausted" after exactly maxAttempts, which requires the CALLER to
 * hold `attemptsSoFar` in something that survives across ticks (a ref) —
 * this function itself is stateless and trusts whatever count it's given.
 *
 * `attemptsSoFar` must already include the current tick (the caller
 * increments its own counter before calling this). occupant is carried on
 * "exhausted" too, matching the original inline behavior: even the tick that
 * exhausts the budget still surfaces the freshest known non-terminal state
 * before falling back to the manual "Check again" UI.
 */
export function evaluatePollTick(result: RoomContentsFetchResult, attemptsSoFar: number, maxAttempts: number): PollTickResult {
  // A failed poll request (429/500/timeout/network error) must never be
  // treated as "the room is now empty" or as confirmation of anything —
  // production bug fix. It's simply inconclusive, exactly like a still-
  // "processing" result: keep polling until a genuine non-processing status
  // arrives or the attempt budget runs out.
  if (result.ok && result.contents.status !== "processing") {
    if (isFullyRevealed(result.contents)) return { outcome: "revealed", occupant: result.contents };
    if (attemptsSoFar >= maxAttempts) return { outcome: "exhausted", occupant: result.contents };
    return { outcome: "continue", occupant: result.contents };
  }
  if (attemptsSoFar >= maxAttempts) return { outcome: "exhausted" };
  return { outcome: "continue" };
}

export type ReconciliationDecision = { action: "adopt"; occupant: RoomContents } | { action: "wait" };

/**
 * Defect #3's own pure decision, extracted for the same testability reason
 * as evaluatePollTick above. Given the server's current, already-terminal
 * (isFullyRevealed) view of a room and the id of the report THIS session's
 * own in-flight check is for, decides whether that server result must win
 * over local "still generating" state:
 *  - the server's report IS the one this session's own check is for (same
 *    id) -> "adopt" (this session's own detached AI-completion landed);
 *  - the server's report is any OTHER id -> "wait" (never cancel an active
 *    run for a report this session did not itself create — see below for
 *    why this is deliberately conservative);
 *  - not ok, or not yet fully revealed at all -> "wait" (never manufacture
 *    a terminal result from an inconclusive or non-terminal read).
 *
 * Deliberately does NOT attempt to recognize a genuinely NEWER, independent
 * report (a different session/tab/device racing ahead and completing a
 * check for this same room while this one is still stuck) as adoptable —
 * an earlier version of this function compared the candidate's own
 * server-persisted createdAt against a LOCAL Date.now() snapshot
 * (checkStartedAtRef), which is unsafe: it compares a server timestamp
 * against this browser's own clock, and two different clients' clocks
 * (or a client's clock against the server's) can disagree by an amount
 * this code has no way to bound or detect. A skewed clock could make an
 * OLDER, unrelated report look newer than it really is — the exact failure
 * this function exists to prevent (an unrelated report cancelling an
 * active run) — so the comparison was removed rather than kept as an
 * unreliable heuristic. There is currently no server-generated revision/
 * version number exposed on ReportSummary/RoomContents that could replace
 * it safely; adding one is a real, valid future improvement (a monotonic,
 * server-issued counter this function could compare instead of a
 * timestamp) but is out of scope for this patch — cross-session
 * supersession (a different tab/device's check completing first) is left
 * unhandled here, correctly conservative in the meantime: the affected
 * session simply keeps waiting/polling rather than being torn down.
 */
export function evaluateReconciliation(result: RoomContentsFetchResult, trackedReportId: string | null): ReconciliationDecision {
  if (!result.ok || !isFullyRevealed(result.contents) || !result.contents.report) return { action: "wait" };
  const serverReport = result.contents.report;
  const isOwnReport = trackedReportId !== null && serverReport.id === trackedReportId;
  return isOwnReport ? { action: "adopt", occupant: result.contents } : { action: "wait" };
}

/**
 * Release-hardening audit finding SIM-04 (acceptance-check hardening): the
 * room card's own Similarity tile — for both the "ready" and "failed"
 * occupant states below — previously rendered the occupant's own
 * primaryScore, falling back to its archiveScore, completely
 * unconditionally, with no regard for `similarityStatus` at all. That was
 * the actual, real UI gap: lib/reports-repo.ts's findRoomOccupant already
 * fell back to archiveScore correctly whenever a result was stale/pending
 * (see resolvePersistedSimilarityDisplay), but this component then showed
 * that fallback number as if it were a final, trustworthy result — exactly
 * the "0% flash" / "wrong number during a flag rollback" failure mode the
 * data layer was built to prevent. Extracted into its own component (shared
 * by both call sites below) so the gate can never again be forgotten at one
 * of the two: `similarityStatus` not "resolved" always renders neutral
 * text, never a number, matching components/report/similarity-report-
 * papers.tsx's OverviewReport treatment of the same tri-state on the detail
 * page. `room-metric-pending` reuses the same class the fully-"processing"
 * tile above already uses (see the JSX below) — same neutral visual
 * treatment, not a new style.
 */
export function SimilarityMetricTile({ report, room }: { report: ReportSummary; room: number }) {
  // Release-hardening audit finding LIFECYCLE-06 (extended): a genuine,
  // persisted terminal failure — see lib/report-primary-similarity.ts's
  // own resolution.failed for what does/doesn't set this — renders exactly
  // like the AI tile's own "Unavailable" state (room-metric-unavailable,
  // non-link, no further detail to click through to), never as a number
  // and never lumped in with the still-in-progress "···" placeholder
  // below.
  if (report.similarityStatus === "failed") {
    return (
      <div className="room-metric room-metric-unavailable">
        <span className="room-metric-label">Similarity</span>
        <strong className="room-metric-value">—</strong>
        <span className="room-metric-sub">Unavailable</span>
      </div>
    );
  }
  const notResolved = report.similarityStatus === "stale" || report.similarityStatus === "pending";
  if (notResolved) {
    return (
      <Link href={`/reports/${report.id}?room=${room}`} className="room-metric room-metric-pending">
        <span className="room-metric-label">Similarity</span>
        <strong className="room-metric-value">···</strong>
        <span className="room-metric-sub">{report.similarityStatus === "stale" ? "Updating…" : "Calculating…"}</span>
      </Link>
    );
  }
  const score = report.primaryScore ?? report.archiveScore;
  const band = similarityScoreBand(score);
  return (
    <Link href={`/reports/${report.id}?room=${room}`} className={`room-metric room-metric-${band?.key ?? "low"}`}>
      <span className="room-metric-label">Similarity</span>
      <strong className="room-metric-value">{score}%</strong>
      <span className="room-metric-sub">{band?.label ?? "Result"}</span>
    </Link>
  );
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
  // Defect #2 fix: the poll-for-completion effect's own attempt count, moved
  // out of the effect's per-instance closure into a ref so it survives the
  // effect being torn down and re-run by React whenever `occupant` changes
  // (including from the SAME poll's own setOccupant call) — see the poll
  // effect's own comment for why a closure-local counter there is defeated
  // by exactly that. A ref is stable across re-renders for the life of this
  // component instance; explicitly reset to 0 only at the specific,
  // intentional "new polling lifecycle" points called out below (never
  // implicitly, never by occupant churn alone).
  const pollAttemptsRef = useRef(0);
  // Defect #3: identity of the report THIS session's own in-flight
  // runCheck() is for — the one fact the reconciliation watchdog effect
  // needs to tell "the terminal report the server just showed me is MY OWN
  // check landing" apart from any other report (see evaluateReconciliation's
  // own comment for why cross-session/cross-device supersession is
  // deliberately NOT attempted here — no safe, clock-independent way to
  // order two different reports exists yet). Reset to null at the start of
  // every runCheck() invocation; filled in once analyzeText() produces a
  // real report object (its id is stable from that point on).
  const currentCheckReportIdRef = useRef<string | null>(null);
  // The upload-progress animation interval — lifted from a runCheck()-local
  // const into a ref so the reconciliation watchdog (a separate effect, with
  // no access to runCheck()'s own local variables) can tear it down too.
  const progressTimerRef = useRef(0);

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
      //
      // Preview receipt regression: this used to prefer the local IndexedDB
      // copy over a fresh server fetch. That copy is `report` from runCheck
      // (a few hundred lines below), stored once via storeReportBestEffort
      // at upload time with attachUnifiedSimilarity's own client-side,
      // corpus-blind unifiedSimilarity already attached (see that call
      // site's own comment) — it is never refreshed once write-time
      // finalization persists the real, corpus-aware result server-side. A
      // promoted-corpus-only match (the exact LIFECYCLE-06 scenario this
      // room already guards against for the room card/poll path) therefore
      // downloaded a receipt showing the client's own partial 0% instead of
      // the server-confirmed 100% the room and report detail page both
      // already display. Fetching the server-confirmed copy first — same
      // "never trust a client-computed result as server-confirmed"
      // discipline as saveEnrichedAiResult's own similarityStatus fix above
      // — makes the receipt agree with what this room already shows; the
      // local copy is used only as an offline fallback when the network
      // fetch itself fails.
      const remote = await fetchRemoteReport<SimilarityReport>(reportId);
      const full = remote ?? (await getStoredReportById<SimilarityReport>(reportId).catch(() => null));
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
   *
   * Release-hardening audit finding LIFECYCLE-06 (Preview regression fix):
   * `report` here is the SAME client-generated SimilarityReport object
   * runCheck built before ever saving — its own `unifiedSimilarity` field
   * (set by attachUnifiedSimilarity, called once during upload) was computed
   * CLIENT-SIDE, from archive/academic evidence only (see that function's
   * own call — it never passes historicalSubmissionMatch, so it has no way
   * to see the corpus at all). This same object is spread into `enriched`
   * below and NEVER refreshed with the server's own write-time-finalized,
   * corpus-aware result — the save response is just {ok:true}, not the
   * enriched payload. buildReportSummary(enriched)'s own similarityStatus
   * heuristic (hasUnifiedSimilarity ? "resolved" : "pending") could not
   * tell the difference: a present-but-corpus-blind unifiedSimilarity
   * looks identical to a genuinely server-confirmed one, so a promoted-
   * corpus-only match (no archive/academic overlap) reported "resolved"
   * at whatever partial score the client alone could see — 0% in the
   * observed Preview reproduction, even though write-time finalization had
   * already persisted the real 100% server-side by the time this save
   * resolved. Because isFullyRevealed only checks similarityStatus (never
   * primaryScore), that false "resolved" made the room reveal immediately
   * and permanently stop polling — the ONE thing that would have picked up
   * the already-correct persisted value. Forced to "pending" here,
   * unconditionally: this room's own poll effect (a few lines below) is
   * the ONLY thing ever allowed to promote similarity to "resolved", and
   * it does so exclusively from a fresh server read (fetchReportRoomContents
   * -> findRoomOccupant -> resolvePersistedSimilarityDisplay), which is
   * generation/flag-aware and reads whatever write-time finalization
   * already, actually persisted — never a locally-computed guess.
   */
  async function saveEnrichedAiResult(report: SimilarityReport, aiResult: { aiScore: number | null; aiAnalysis: AiAnalysis }): Promise<boolean> {
    const enriched = { ...report, ...aiResult };
    const enrichedSummary: ReportSummary = {
      ...buildReportSummary(enriched),
      aiStatus: aiResult.aiAnalysis.status === "complete" ? "ready" : "failed",
      similarityStatus: "pending",
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
   * extracted text (no re-upload needed). Language is always recomputed
   * fresh (retryAiAnalysisWithFreshLanguage), never taken from
   * full.features.detectedLanguage — see that function's own comment.
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
      const aiResult = await retryAiAnalysisWithFreshLanguage(full.text);
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

  // Poll for genuine completion — of EITHER pipeline — when this room is
  // not yet fully revealed (see isFullyRevealed's own comment) and this
  // session did NOT just start that check itself (isGeneratingReport is the
  // in-flight-upload path below, which already updates `occupant` directly
  // the moment its own AI promise resolves — running both at once would
  // just be redundant work, not incorrect, but there's no reason to).
  //
  // Release-hardening audit finding LIFECYCLE-05: previously stopped the
  // instant ai_status left "processing" — correct back when similarity was
  // assumed to always already be done by then. Now also keeps polling
  // through the (rare) case where AI is already terminal but similarity
  // itself is still "stale"/"pending": occupant is still updated on every
  // response either way, so the room card reflects the freshest known
  // state even while waiting, but polling itself only stops once BOTH are
  // ready to reveal together.
  //
  // Defect #2 fix: the attempt count lives in pollAttemptsRef (component-
  // level, see its own comment), never in a variable local to this effect.
  // fetchReportRoomContents always returns a freshly-constructed object
  // (lib/reports-remote.ts's own fetchReportRoomContents), so every
  // non-"processing", not-yet-fully-revealed response's own setOccupant call
  // below is a genuine reference change — React re-runs this effect on the
  // very next render because `occupant` is one of its dependencies. A
  // closure-local counter would be silently recreated at 0 on every one of
  // those re-runs, permanently defeating MAX_POLL_ATTEMPTS the instant a
  // room ever entered the (normal, expected — LIFECYCLE-05 above) window
  // where AI and similarity finish at different times — this was a real,
  // confirmed-live Preview regression (indefinite polling despite an
  // already-terminal server row), not a hypothetical. The ref is deliberately
  // NOT reset here on every effect run; it is reset only at the specific
  // "new polling lifecycle" points this file's other functions own:
  // runCheck() (a genuinely new report/check generation), checkAgain() (the
  // user explicitly asking for a fresh attempt budget), and this effect's
  // own terminal-reveal branch below (hygiene, so a later, unrelated polling
  // lifecycle for this same mounted instance never inherits a stale count).
  useEffect(() => {
    if (isFullyRevealed(occupant) || isGeneratingReport || pollExhausted) return;
    let cancelled = false;
    let timer = 0;

    async function poll() {
      pollAttemptsRef.current += 1;
      const result = await fetchReportRoomContents(room);
      if (cancelled) return;
      const tick = evaluatePollTick(result, pollAttemptsRef.current, MAX_POLL_ATTEMPTS);
      if (tick.occupant) setOccupant(tick.occupant);
      if (tick.outcome === "revealed") {
        pollAttemptsRef.current = 0;
        return;
      }
      if (tick.outcome === "exhausted") {
        // Bounded: a genuine AI failure now arrives as its own "failed"
        // status via evaluatePollTick's own "revealed" branch (production
        // audit fix), so reaching this cap means genuinely still unresolved
        // — most likely the tab that started the check is gone (closed/
        // crashed) before its save landed, or this device has had
        // persistent connectivity trouble. Offer a manual recheck rather
        // than polling forever.
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

  /**
   * Defect #3: authoritative-server-wins reconciliation for the in-flight
   * upload overlay. The completion-poll effect above is deliberately guarded
   * OUT while isGeneratingReport is true (its own comment: "this session did
   * NOT just start that check itself") — by design, since runCheck() itself
   * updates `occupant` directly the moment its own work resolves. That
   * design assumes runCheck() always eventually reaches that point. If it
   * doesn't (hangs before ever calling saveReportRemote, or the tab that
   * started it is otherwise never going to finish), isGeneratingReport/
   * generationLockRef/the progress overlay have no OTHER path back to a
   * correct state — nothing previously reconciled them against what the
   * server actually knows about this room while a check is believed to
   * still be running locally.
   *
   * This effect is that reconciliation path. It runs ONLY while
   * isGeneratingReport is true (the exact window the completion poll
   * excludes), periodically re-confirming that belief against the server's
   * own authoritative view of this room — never manufacturing a terminal
   * result client-side, only ever adopting one the server itself already
   * produced and that resolvePersistedSimilarityDisplay/findRoomOccupant
   * already confirmed is genuinely terminal (isFullyRevealed).
   *
   * Report-aware by design (the safe rule this effect exists to implement)
   * — deliberately conservative, see evaluateReconciliation's own comment
   * for why a "different but genuinely newer report" case is NOT handled
   * here (it would require comparing a server timestamp against this
   * browser's own clock, which is unsafe across tabs/devices with
   * potentially skewed clocks — a stale/wrong comparison there could let an
   * unrelated report wrongly cancel an active run, the opposite of this
   * effect's own purpose):
   *  - The terminal report IS the one this session's own runCheck() is for
   *    (same id, tracked in currentCheckReportIdRef since analyzeText()
   *    produced it) — this session's own detached AI-completion (Call B)
   *    already landed; the local "still generating" belief is simply stale
   *    and must be torn down.
   *  - The terminal report is ANY other id — could be an older, unrelated
   *    report already sitting in this room, or a genuinely newer one from a
   *    different tab/device racing ahead; this effect cannot safely tell
   *    those apart without a server-issued, clock-independent ordering key,
   *    which does not exist yet (see evaluateReconciliation's own comment —
   *    a real future improvement, out of scope here). Correctly
   *    conservative in the meantime: never adopt, keep waiting. The only
   *    other recovery path in THAT scenario — a different tab/device's
   *    check having already completed for this room — is a manual reload,
   *    which SSR (findRoomOccupant, the same resolver) already handles
   *    correctly and immediately.
   */
  useEffect(() => {
    if (!isGeneratingReport) return;
    let cancelled = false;
    let timer = 0;

    async function reconcile() {
      const result = await fetchReportRoomContents(room);
      if (cancelled) return;
      const decision = evaluateReconciliation(result, currentCheckReportIdRef.current);
      if (decision.action === "adopt") {
        window.clearInterval(progressTimerRef.current);
        generationLockRef.current = false;
        setIsGeneratingReport(false);
        setProgress(0);
        setProcessingLabel("Reading document content");
        pollAttemptsRef.current = 0;
        setOccupant(decision.occupant);
        return;
      }
      timer = window.setTimeout(reconcile, POLL_INTERVAL_MS);
    }
    timer = window.setTimeout(reconcile, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isGeneratingReport, room]);

  function checkAgain() {
    // A genuinely new polling lifecycle for the SAME report — see
    // pollAttemptsRef's own comment. Without this, the very next poll would
    // immediately see the count still at MAX_POLL_ATTEMPTS from the
    // exhausted run and re-exhaust after a single attempt, making "Check
    // again" a no-op.
    pollAttemptsRef.current = 0;
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
    // Defect #3: marks the start of a new check generation for the
    // reconciliation watchdog below — reset to null here, filled in once
    // analyzeText() below produces a real report object with a stable id.
    currentCheckReportIdRef.current = null;
    setProgress(4);
    setProcessingLabel("Reading document content");
    const minimumProcessingMs = 8_000 + Math.floor(Math.random() * 7_001);
    const animationStartedAt = Date.now();
    progressTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - animationStartedAt;
      setProgress(Math.min(95, 4 + Math.round((elapsed / minimumProcessingMs) * 91)));
    }, 250);

    let text = "";
    try {
      text = normalizeExtractedText(await extractFileText(submittedFile, (_value, label) => setProcessingLabel(label)));
    } catch {
      notify("I could not read that document. Try another file.");
      window.clearInterval(progressTimerRef.current);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }

    if (text.length < 80) {
      notify("Add at least 80 characters to create a useful report.");
      window.clearInterval(progressTimerRef.current);
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
      window.clearInterval(progressTimerRef.current);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }
    // ReportSummary.id (what the server/poll ever hands back) is always
    // String(SimilarityReport.id) — see buildReportSummary in
    // lib/report-types.ts — so the tracked id is normalized the same way
    // here for a same-type comparison in the watchdog effect below.
    currentCheckReportIdRef.current = String(report.id);

    const aiAnalysisPromise = runAiAnalysis(text, report.features.detectedLanguage);

    setProcessingLabel("Checking external academic sources");
    const [webCheck, academicResult] = await Promise.all([wikipediaPromise, academicEvidencePromise]);
    if (webCheck) report = enrichReportWithWikipedia(report, webCheck);
    report = enrichReportWithAcademicEvidence(report, academicResult);
    report = attachUnifiedSimilarity(report);

    const remainingAnimationMs = Math.max(0, minimumProcessingMs - (Date.now() - animationStartedAt));
    if (remainingAnimationMs > 0) await new Promise((resolve) => window.setTimeout(resolve, remainingAnimationMs));
    window.clearInterval(progressTimerRef.current);
    setProgress(100);
    setProcessingLabel("Saving your report");

    try {
      // Explicitly "processing" (not left implicit as "no aiStatus yet") so
      // a legacy-vs-fresh row is never ambiguous — see
      // lib/report-rooms.ts's deriveRoomStatus.
      //
      // Release-hardening audit finding LIFECYCLE-06 (Preview regression
      // fix): similarityStatus forced to "pending" for the identical reason
      // saveEnrichedAiResult's own enrichedSummary is below — report.unifiedSimilarity
      // here is attachUnifiedSimilarity's own client-side, corpus-blind
      // computation (just set two lines above), never a server-confirmed
      // result. Harmless today only because occupant.status is "processing"
      // here (isFullyRevealed already requires "ready"/"failed" first) —
      // forced explicitly anyway so this optimistic summary can never
      // become a false "resolved" source if it is ever read before AI
      // finishes, or if isFullyRevealed's own condition ever changes.
      const summary: ReportSummary = { ...buildReportSummary(report), aiStatus: "processing", similarityStatus: "pending" };
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
      // Defect #2: a new report/check generation has just started for this
      // room — give the completion poll a fresh attempt budget rather than
      // inheriting whatever pollAttemptsRef/pollExhausted happened to be
      // left over from a PRIOR occupant of this same mounted instance (a
      // report that expired and the room emptied, then a new upload
      // followed, all without a remount).
      pollAttemptsRef.current = 0;
      setPollExhausted(false);
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
      // "processing" branch's own "Retry analysis" action below; the
      // notify() calls here are only a same-tab courtesy.
      void completeAiAnalysisWithRecovery(aiAnalysisPromise, (aiResult) => saveEnrichedAiResult(report, aiResult)).then((saved) => {
        if (!saved) notify("AI analysis finished but could not be saved. Retry analysis once it settles, or reopen this room.");
      });
    } finally {
      generationLockRef.current = false;
      setIsGeneratingReport(false);
    }
  }

  // Release-hardening audit finding LIFECYCLE-05: this line is the room
  // card's own top-level summary, shown above the three metric tiles —
  // "Analysis in progress" for ANY not-yet-fully-revealed occupant
  // (isFullyRevealed's own comment explains exactly what that means),
  // regardless of whether occupant.status itself is "processing" or an
  // already-terminal "ready"/"failed" still waiting on similarity to
  // resolve — the tiles below stay uniformly neutral in that same window,
  // so this summary line must never claim more than they do.
  const statusLine =
    isFullyRevealed(occupant) && occupant.status === "ready" && occupant.report ? `Report ready · Last checked ${formatDate(occupant.report.createdAt)}`
    : isFullyRevealed(occupant) && occupant.status === "failed" ? "Report ready · AI analysis unavailable"
    : occupant.report ? "Analysis in progress"
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

        {!isFullyRevealed(occupant) && occupant.report && (
          <div className="room-report-card">
            <div className="room-report-card-header">
              <FileText aria-hidden="true" />
              <div>
                <strong>{occupant.report.title}</strong>
                <span>{formatDate(occupant.report.createdAt)} · {occupant.report.wordCount.toLocaleString()} words</span>
              </div>
            </div>

            {/* Release-hardening audit finding LIFECYCLE-05: AI-writing
                detection and unified similarity are independent PIPELINES
                (write-time finalization can persist a fully resolved
                unifiedSimilarity before, after, or well before AI analysis
                finishes — see app/api/reports/route.ts), but this room card
                deliberately presents their completion as one atomic REVEAL:
                neither tile shows a real number, and neither is a link,
                until isFullyRevealed(occupant) is true — see that
                function's own comment for the exact (AI terminal AND
                similarity resolved) condition, which this branch is simply
                the negation of. Reaching this branch at all, regardless of
                whether occupant.status is "processing" or an already-
                terminal "ready"/"failed" still waiting on similarity, means
                at least one of the two is not yet ready — so both tiles
                stay uniformly neutral rather than trying to distinguish
                which pipeline is the reason. Receipt keeps its own
                independent gate (a receipt bundles the complete picture,
                so it has a real reason to stay "Preparing…" here too). */}
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
                <p>Analysis is taking longer than usual.</p>
                <button className="button subtle" type="button" onClick={checkAgain}>Check again</button>
                {/* Release-hardening audit finding LIFECYCLE-01, widened by
                    LIFECYCLE-05: a room can reach this exhausted-poll state
                    because AI analysis is genuinely still running elsewhere
                    (another tab/device — "Check again" alone is correct
                    there), because the session that started it closed/
                    crashed/failed to save before ever writing "ready" or
                    "failed," or because similarity itself is still "stale"/
                    "pending" even though AI already finished — permanently
                    stranding this room without ever reaching a full reveal.
                    retryAiCheck is idempotent (re-runs AI analysis from the
                    already-persisted text and resaves via the same UPSERT
                    saveEnrichedAiResult uses), and every save re-runs
                    write-time similarity finalization too (see
                    app/api/reports/route.ts) — so offering it here is safe
                    and is the one action that can recover a genuinely stuck
                    room regardless of which pipeline is the actual cause. */}
                <button className="button subtle" type="button" onClick={() => retryAiCheck(occupant.report!.id)} disabled={retryingAi}>
                  {retryingAi ? "Checking…" : "Retry analysis"}
                </button>
              </div>
            ) : (
              <div className="ai-analysis-loading" role="status" aria-live="polite">
                <span aria-hidden="true" />
                <div>
                  <strong>Analysis in progress</strong>
                  <p>Your AI-writing and similarity results will appear here together as soon as both are ready.</p>
                </div>
              </div>
            )}
          </div>
        )}

        {occupant.status === "ready" && isFullyRevealed(occupant) && occupant.report && (
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
              <SimilarityMetricTile report={occupant.report} room={room} />
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

        {occupant.status === "failed" && isFullyRevealed(occupant) && occupant.report && (
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
              <SimilarityMetricTile report={occupant.report} room={room} />
              <button className="room-metric" type="button" onClick={() => handleDownloadReceipt(occupant.report!.id)} disabled={downloadingReceipt}>
                <span className="room-metric-label">Receipt</span>
                <Download aria-hidden="true" className="room-metric-icon" />
                <span className="room-metric-sub">{downloadingReceipt ? "Preparing…" : "Download"}</span>
              </button>
            </div>

            <div className="ai-analysis-message" role="status">
              <p>AI-writing analysis was unavailable for this document. The similarity result above is complete and unaffected.</p>
              <button className="button subtle" type="button" onClick={() => retryAiCheck(occupant.report!.id)} disabled={retryingAi}>
                {retryingAi ? "Checking…" : "Retry analysis"}
              </button>
            </div>

            <Link href={`/reports/${occupant.report.id}?room=${room}`} className="button secondary room-open-full">Open full report</Link>
          </div>
        )}
      </div>
    </div>
  );
}
