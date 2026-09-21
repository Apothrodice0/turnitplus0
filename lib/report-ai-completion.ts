import { storeReportBestEffort } from "./report-store";
import { saveReportRemote, saveAiRetryResultRemote, type ReportSummary } from "./reports-remote";
import { prepareAiAnalysisForTransport } from "./ai-passage-table";

export type AiCompletionSaveResult = { ok: boolean; summary: ReportSummary };

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
 * `saveRemote` is injectable (defaults to the real saveReportRemote) purely
 * so tests can supply a deterministic stub without a real network/DB.
 */
export async function persistAiCompletion<T extends Record<string, unknown>>(
  enrichedReport: T,
  summary: ReportSummary,
  room?: number,
  saveRemote: typeof saveReportRemote = saveReportRemote,
): Promise<AiCompletionSaveResult> {
  await storeReportBestEffort(enrichedReport);
  try {
    const result = await saveRemote(enrichedReport, summary, undefined, room);
    return { ok: result.ok, summary };
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
 * `saveRemote` is injectable purely so tests can supply a deterministic stub without a real network/DB.
 */
export async function persistAiRetryResult<T extends { aiScore?: number | null; aiAnalysis?: unknown; text?: string }>(
  enrichedReport: T,
  summary: ReportSummary,
  saveRemote: typeof saveAiRetryResultRemote = saveAiRetryResultRemote,
): Promise<AiCompletionSaveResult> {
  await storeReportBestEffort(enrichedReport);
  try {
    if ((summary.aiStatus !== "ready" && summary.aiStatus !== "failed") || !enrichedReport.aiAnalysis) return { ok: false, summary };
    const result = await saveRemote({
      id: summary.id,
      aiStatus: summary.aiStatus,
      aiScore: summary.aiScore,
      aiTone: summary.aiTone,
      rawAiScore: enrichedReport.aiScore ?? null,
      aiAnalysis: prepareAiAnalysisForTransport(enrichedReport.aiAnalysis, enrichedReport.text),
    });
    return { ok: result.ok, summary };
  } catch (error) {
    console.error("Remote save of AI retry result failed unexpectedly (non-fatal):", error instanceof Error ? error.message : String(error));
    return { ok: false, summary };
  }
}
