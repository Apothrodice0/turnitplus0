import { AI_UNAVAILABLE_REASON_REPORT_SIZE, type AiUnavailableReason } from "./ai-unavailable-state";

/**
 * POST /api/reports/[id]/ai-retry size-decision telemetry — one structured, privacy-allowlisted server-log line each time the
 * SERVER chooses the terminal "AI unavailable for this document" state (lib/ai-unavailable-state.ts) instead of persisting the
 * real AI result. Same discipline as lib/report-save-telemetry.ts, which it mirrors.
 *
 * PURPOSE: passive operational visibility into how often the size policy fires ("how many reports lost their AI half to size"),
 * from server logs alone, without ever inspecting or logging customer content. The persisted marker itself is queryable too
 * (`payload_json.aiAnalysis.unavailableReason`); this is the log-side twin.
 *
 * SCOPE: OBSERVATION ONLY. It never computes the decision, never influences the response and never reads request or report data —
 * the route passes in nothing but the already-made decision.
 *
 * PRIVACY: the event is a closed, explicit allowlist — event, reason, status, authMode. No arbitrary metadata bag, no object
 * spread, and the type structurally prevents passing manuscript text, AI passages, payload JSON, source evidence, report title,
 * ids (report / account / device), sizes, ceilings, hashes, IPs or any raw error message.
 */

export type AiSizeUnavailableTelemetryEvent = {
  event: "ai_size_unavailable";
  reason: AiUnavailableReason;
  status: 200;
  authMode: "authenticated";
};

/** Pure formatter: the exact closed event shape. Takes no input on purpose — there is nothing variable to log. */
export function buildAiSizeUnavailableTelemetryEvent(): AiSizeUnavailableTelemetryEvent {
  return { event: "ai_size_unavailable", reason: AI_UNAVAILABLE_REASON_REPORT_SIZE, status: 200, authMode: "authenticated" };
}

/**
 * Emits exactly one structured `warn` line (an expected business outcome, not a malfunction — the same level the intentional
 * rejections in lib/report-save-telemetry.ts use). BEST-EFFORT: never throws, so a telemetry failure can never be mistaken for,
 * or interrupt, the real request/response flow.
 */
export function logAiSizeUnavailableTelemetry(): void {
  try {
    console.warn(JSON.stringify(buildAiSizeUnavailableTelemetryEvent()));
  } catch {
    // Best-effort only. Never rethrow.
  }
}
