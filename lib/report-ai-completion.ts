import { storeReportBestEffort } from "./report-store";
import { saveReportRemote, type ReportSummary } from "./reports-remote";

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
