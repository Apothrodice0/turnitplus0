import { storeReportBestEffort } from "./report-store";
import { saveReportRemote, saveAiRetryResultRemote, classifySaveReportRemoteResult, type ReportSummary } from "./reports-remote";
import { prepareAiAnalysisForTransport } from "./ai-passage-table";
import { AI_SAVE_OUTCOME_SIZE_UNAVAILABLE, withSizeUnavailableAi } from "./ai-unavailable-state";

/**
 * `summary` is the summary the caller must hold for the report AFTER this save: the very object it passed in — except when the
 * server decided the real AI result cannot be stored next to the report (G2, lib/ai-unavailable-state.ts) and persisted the
 * terminal "AI unavailable" state instead, in which case it is that state (failed, no score, `aiUnavailableReason`). Callers
 * that update the room must use it rather than the summary they built from their own, real AI result.
 */
export type AiCompletionSaveResult = { ok: boolean; summary: ReportSummary };

/**
 * Sends ONLY the AI result of `enrichedReport` to the narrow AI-result route (POST /api/reports/[id]/ai-retry) and folds the
 * server's answer into the returned summary. The one path both a manual Retry (persistAiRetryResult) and the automatic
 * resave's size fallback (persistAiCompletion) go through, so they cannot drift.
 *
 * `summary` supplies the report id and the three flat AI columns; one that is not 'ready' or 'failed' (a save only ever
 * carries a terminal AI state), or a report with no `aiAnalysis`, is never sent. Never throws past its caller's try/catch.
 */
async function saveAiResultViaNarrowRoute(
  enrichedReport: { aiScore?: number | null; aiAnalysis?: unknown; text?: string },
  summary: ReportSummary,
  saveNarrow: typeof saveAiRetryResultRemote,
): Promise<AiCompletionSaveResult> {
  if ((summary.aiStatus !== "ready" && summary.aiStatus !== "failed") || !enrichedReport.aiAnalysis) return { ok: false, summary };
  const result = await saveNarrow({
    id: summary.id,
    aiStatus: summary.aiStatus,
    aiScore: summary.aiScore,
    aiTone: summary.aiTone,
    rawAiScore: enrichedReport.aiScore ?? null,
    aiAnalysis: prepareAiAnalysisForTransport(enrichedReport.aiAnalysis, enrichedReport.text),
  });
  if (!result.ok) return { ok: false, summary };
  return { ok: true, summary: result.aiOutcome === AI_SAVE_OUTCOME_SIZE_UNAVAILABLE ? withSizeUnavailableAi(summary) : summary };
}

/**
 * Release-hardening audit finding LIFECYCLE-01: persists an AI-enriched
 * report (local IndexedDB cache + authoritative remote save) without ever
 * throwing. Shared by app/reports/rooms/[room]/room-page-shell.tsx's
 * saveEnrichedAiResult and app/page.tsx's equivalent anonymous-flow resave —
 * both used to call storeReport/saveReportRemote directly inside an
 * unawaited `.then(...)` with no `.catch()`, so a rejection from either
 * (most concretely storeReport, the one call in this pair that genuinely
 * can reject) became an unhandled promise rejection, and — for the room
 * flow specifically — permanently stranded the report at
 * ai_status='processing': nothing left running would ever write 'ready' or
 * 'failed'.
 *
 * The local cache write is best-effort (storeReportBestEffort never
 * throws); the remote save is the real answer this function returns. The
 * try/catch around the remote save is defense-in-depth — saveReportRemote
 * is already documented "fail-soft by design" and always resolves
 * {ok:false} rather than rejecting — but this boundary must hold even if
 * that contract is ever violated, since this is the last line of defense
 * before the caller's own `.then()` chain.
 *
 * G2 — SIZE FALLBACK (POLICY_B_KEEP_REPORT_AI_UNAVAILABLE_FOR_SIZE). The whole-report resave can be refused for SIZE before
 * any AI logic runs: the request (the manuscript plus the AI result) is over MAX_REPORT_SAVE_REQUEST_BYTES, or the server's
 * re-finalized report plus the AI result is over the persisted ceiling — both HTTP 413, and either way the report would stay
 * `processing` forever. That 413 (and only that: the existing typed classification, classifySaveReportRemoteResult's
 * REQUEST_TOO_LARGE — never a 401/403/404, a validation 400, a network failure, a 5xx or an unreadable-report 503) is answered
 * by handing the SAME AI result, already computed and never re-run, to the narrow AI-result route. That route is the ONLY
 * place that can decide exactly: it stores the real result when it fits next to the SAVED report (it often does when the
 * whole-report path could not tell), and otherwise persists the tiny terminal "AI unavailable" state — see
 * app/api/reports/[id]/ai-retry/route.ts. The returned `summary` then reflects what the server actually persisted.
 *
 * `saveRemote` / `saveNarrow` are injectable (default to the real ones) purely so tests can supply a deterministic stub
 * without a real network/DB.
 */
export async function persistAiCompletion<T extends Record<string, unknown>>(
  enrichedReport: T,
  summary: ReportSummary,
  room?: number,
  saveRemote: typeof saveReportRemote = saveReportRemote,
  saveNarrow: typeof saveAiRetryResultRemote = saveAiRetryResultRemote,
): Promise<AiCompletionSaveResult> {
  await storeReportBestEffort(enrichedReport);
  try {
    const result = await saveRemote(enrichedReport, summary, undefined, room);
    if (result.ok) return { ok: true, summary };
    if (classifySaveReportRemoteResult(result) !== "REQUEST_TOO_LARGE") return { ok: false, summary };
    return await saveAiResultViaNarrowRoute(enrichedReport as { aiScore?: number | null; aiAnalysis?: unknown; text?: string }, summary, saveNarrow);
  } catch (error) {
    console.error("Remote save of AI-enriched report failed unexpectedly (non-fatal):", error instanceof Error ? error.message : String(error));
    return { ok: false, summary };
  }
}

/**
 * G2 — the persistence half of a MANUAL AI RETRY (app/reports/rooms/[room]/room-page-shell.tsx's retryAiCheck).
 *
 * Same contract as persistAiCompletion — best-effort local cache write, the remote save is the real answer, and
 * nothing here ever throws — but the remote save is the narrow AI-result route, not a re-POST of the whole
 * report. persistAiCompletion posts `enrichedReport` in full; when a retry's report came from a GET (no local
 * copy in this browser) that is the EXPANDED similarity report, which exceeds the report-save request ceiling
 * for a large report whose compact persisted form fits — a deterministic 413 (see app/api/reports/[id]/
 * ai-retry/route.ts). Here only the AI result leaves the browser; the server keeps its own persisted similarity
 * state, identity, ownership and room untouched.
 *
 * `enrichedReport` is still what the LOCAL cache stores (unchanged behaviour); `summary` supplies the report id
 * and the three flat AI columns (the same values the resave path derives). A summary that is not 'ready' or
 * 'failed' (a retry only ever produces a terminal AI state), or a report with no `aiAnalysis`, is never sent.
 *
 * ai-compact-v1 (lib/ai-passage-table.ts): what leaves the browser is the AI result, and that is dominated by its
 * per-window passages (a decoded copy of every window, ~2.4x the manuscript). With the (default OFF) writer gate on,
 * they are sent as a compact table that points into the manuscript the server already stores (`enrichedReport.text` is
 * the string the model analysed), so the request scales at ~0.08x the manuscript instead. With the gate off — or when
 * the result is not compactable — `aiAnalysis` is sent exactly as it always was. The LOCAL cache above keeps the full
 * runtime shape.
 *
 * G2 (size policy): when the server decides the real result cannot be stored next to the saved report it persists the
 * terminal "AI unavailable" state instead, and the returned `summary` says so (see AiCompletionSaveResult).
 *
 * `saveRemote` is injectable purely so tests can supply a deterministic stub without a real network/DB.
 */
export async function persistAiRetryResult<T extends { aiScore?: number | null; aiAnalysis?: unknown; text?: string }>(
  enrichedReport: T,
  summary: ReportSummary,
  saveRemote: typeof saveAiRetryResultRemote = saveAiRetryResultRemote,
): Promise<AiCompletionSaveResult> {
  await storeReportBestEffort(enrichedReport);
  try {
    return await saveAiResultViaNarrowRoute(enrichedReport, summary, saveRemote);
  } catch (error) {
    console.error("Remote save of AI retry result failed unexpectedly (non-fatal):", error instanceof Error ? error.message : String(error));
    return { ok: false, summary };
  }
}
