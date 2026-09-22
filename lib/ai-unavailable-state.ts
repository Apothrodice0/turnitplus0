import {
  AI_MODEL_VERSION,
  AI_PASSAGE_LOG_ODDS_THRESHOLD,
  AI_PASSAGE_THRESHOLD,
} from "./ai-core";
import type { AiAnalysis } from "./report-types";

/**
 * G2 — POLICY_B_KEEP_REPORT_AI_UNAVAILABLE_FOR_SIZE.
 *
 * AI-writing analysis is ENRICHMENT on a similarity report that is already valid and persisted. When the real AI result
 * cannot be stored next to that report inside the (unchanged) 2,000,000-character persisted-report ceiling, the report must
 * still finish: the similarity half is left exactly as it is and the AI half ends in a tiny, honest, TERMINAL "unavailable"
 * state instead of staying `processing` forever behind a Retry that would deterministically fail again.
 *
 * This module is the ONE definition of that state and of the two size rules that go with it. It is dependency-light on
 * purpose (it is imported by the AI-retry route, the client completion helpers and the room/detail UI alike) and holds no
 * scoring logic: nothing here changes a similarity or AI score.
 *
 * THE STATE. No new `ai_status` value and no migration. It is the existing terminal FAILED state
 * (`ai_status = 'failed'`, `ai_score NULL`, `ai_tone 'unavailable'`, `aiAnalysis.status = 'error'`) plus one additive,
 * closed-enum field inside `aiAnalysis`: `unavailableReason: "REPORT_SIZE"`. Any reader that predates this field reads it as
 * an ordinary failed AI result and shows `aiAnalysis.error` — the same customer sentence — so nothing breaks; the only thing
 * such a reader still offers is a Retry, which the server answers idempotently (never a 413 loop).
 *
 * SERVER-AUTHORED ONLY. `unavailableReason` records a decision the SERVER made from its own exact persisted-size check
 * (app/api/reports/[id]/ai-retry/route.ts). A client can never declare it: the retry route strips it from anything the browser
 * sends and POST /api/reports strips it from a client payload, so a browser can neither hide a legitimate AI result nor
 * suppress its own Retry by claiming "too large".
 */

export const AI_UNAVAILABLE_REASON_REPORT_SIZE = "REPORT_SIZE" as const;
export type AiUnavailableReason = typeof AI_UNAVAILABLE_REASON_REPORT_SIZE;

/**
 * The outcome the AI-retry route reports when IT decided the real AI result cannot be stored and wrote the terminal state
 * instead. The only value today; absent means the real result was persisted (or nothing needed writing).
 */
export const AI_SAVE_OUTCOME_SIZE_UNAVAILABLE = "SIZE_UNAVAILABLE" as const;
export type AiSaveOutcome = typeof AI_SAVE_OUTCOME_SIZE_UNAVAILABLE;

/** Customer copy. Neutral and honest; never a byte count, a ceiling or any persistence detail. */
export const AI_SIZE_UNAVAILABLE_MESSAGE = "AI-writing analysis isn't available for this document.";
export const AI_SIZE_UNAVAILABLE_ROOM_NOTE = "AI-writing analysis isn't available for this document. The similarity result above is complete and unaffected.";
/** The detail page's AI verdict "range" line — replaces the generic "Try again" only for this state. */
export const AI_SIZE_UNAVAILABLE_RANGE = "No AI result";

/**
 * The room a NEW report must leave free in its persisted payload so that it can ALWAYS reach a terminal AI state.
 *
 * WHY. The first save of a report (no AI result yet) is accepted up to the persisted ceiling. A report accepted with only a
 * few hundred characters of headroom could then not hold even the tiny terminal marker below, and — with the real AI result
 * refused as too large — would stay `processing` forever: measured, a 1,988,611-character manuscript was accepted with 180
 * characters of headroom and the ~350-character marker then failed on both write paths. Reserving this many characters on a
 * save that carries no terminal AI state closes that sliver: every accepted report can hold the marker.
 *
 * SIZE. The marker's growth on a stored report is its own JSON (323 characters) plus the two keys it adds (`,"aiAnalysis":` and
 * `,"aiScore":null` — 14 + 15), ≈ 352 characters, measured exactly by tests/ai-size-unavailable-policy.test.mjs, which fails if
 * it ever exceeds half of this reserve. 1,024 is that measured need with ~3x headroom: ≈ 0.05 % of the ceiling. The ceiling
 * itself is NOT changed — this is not headroom added to it, only a deliberately small slice of it that a first save may not consume.
 *
 * UNIT. The reserve is enforced by POST /api/reports in the canonical persisted-size unit (persistedPayloadSize,
 * lib/report-transport-limits.ts: UTF-16 code units of the serialized JSON), and the AI-result route measures the marker's merged
 * payload in that SAME unit — so the guarantee is arithmetic-free and holds for any content, astral characters included: a report
 * accepted at ≤ MAX − 1,024 units grows by at most ≈ 352 units when the marker is written, which is ASCII (units are exact).
 *
 * SCOPE. Applied only by POST /api/reports, only to a save whose AI half is not terminal (deriveRoomStatus === "processing").
 * A save that already carries its AI result (the automatic AI resave), the AI-retry route and every server-internal writer are
 * not held to it: the reserve exists precisely so that THEY have room.
 */
export const TERMINAL_AI_RESERVE_CHARS = 1_024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tiny terminal AI result the SERVER persists when the real one cannot fit. The shape is the existing
 * `aiAnalysisErrorResult` failure shape (so every reader already understands it) plus `unavailableReason`; no passage array,
 * no manuscript text, no score.
 */
export function buildSizeUnavailableAiAnalysis(): AiAnalysis {
  return {
    status: "error",
    score: null,
    model: AI_MODEL_VERSION,
    engine: null,
    threshold: AI_PASSAGE_THRESHOLD,
    thresholdLogOdds: AI_PASSAGE_LOG_ODDS_THRESHOLD,
    eligibleWordCount: 0,
    analyzedWordCount: 0,
    passages: [],
    error: AI_SIZE_UNAVAILABLE_MESSAGE,
    unavailableReason: AI_UNAVAILABLE_REASON_REPORT_SIZE,
  };
}

/** True exactly for the server-authored size-unavailable result: an `error` analysis carrying the closed reason. */
export function isSizeUnavailableAiAnalysis(analysis: unknown): boolean {
  return isPlainObject(analysis) && analysis.status === "error" && analysis.unavailableReason === AI_UNAVAILABLE_REASON_REPORT_SIZE;
}

/**
 * `aiAnalysis` without a client-supplied `unavailableReason` (a shallow copy; the input is never mutated). Anything that is not
 * a plain object, or has no such key, is returned as is. Used at every trust boundary that accepts an AI result from a browser.
 */
export function withoutClientAiUnavailableReason<T>(aiAnalysis: T): T {
  if (!isPlainObject(aiAnalysis) || !("unavailableReason" in aiAnalysis)) return aiAnalysis;
  const { unavailableReason: _dropped, ...rest } = aiAnalysis;
  void _dropped;
  return rest as T;
}

/** Whether the room should offer "Retry analysis" for this summary: never for a report the server marked size-unavailable. */
export function isAiRetryOffered(report: { aiUnavailableReason?: unknown } | null | undefined): boolean {
  return report?.aiUnavailableReason !== AI_UNAVAILABLE_REASON_REPORT_SIZE;
}

/**
 * `summary` as the room must hold it once the server has persisted the terminal size-unavailable state — whatever the browser's
 * own (real, complete) AI result said. Terminal FAILED, no score, the non-numeric tone, and the reason that hides Retry.
 */
export function withSizeUnavailableAi<S extends { aiStatus?: "processing" | "ready" | "failed"; aiScore: number | null; aiTone: string | null }>(
  summary: S,
): S & { aiStatus: "failed"; aiScore: null; aiTone: "unavailable"; aiUnavailableReason: AiUnavailableReason } {
  return { ...summary, aiStatus: "failed", aiScore: null, aiTone: "unavailable", aiUnavailableReason: AI_UNAVAILABLE_REASON_REPORT_SIZE };
}
