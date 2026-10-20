/**
 * UPLOAD PROGRESS (customer-facing check progress, 2026-10-20).
 *
 * Production showed "100% · Saving your report" for several minutes: the bar was a timer animated to 95 % over a random
 * 8–15 s, then set to 100 % BEFORE the save request was even sent, so every second the server spent saving was displayed as
 * finished. Here the bar only reflects stages that have actually completed, never reaches 100 % before the server has the
 * report, and a step with no measurable progress (saving, confirming) is shown as indeterminate instead of a number.
 *
 * Pure helpers only (no React): the room page and the dashboard both use them, and tests/upload-progress-ux.test.mjs pins them.
 */
import type { RoomContentsFetchResult } from "./reports-remote";

export type CheckStage = "reading" | "analyzing" | "matching" | "finishing" | "saving" | "confirming" | "complete";

/** Calm, plain wording shown under the file name ("…" is added by the panel). */
export const CHECK_STAGE_LABELS: Record<CheckStage, string> = {
  reading: "Reading your document",
  analyzing: "Analyzing your document",
  matching: "Checking for matching passages",
  finishing: "Almost there",
  saving: "Saving your report",
  confirming: "Finalizing your report",
  complete: "Report saved",
};

/** Shown once (not rotated) when a save is still running after SAVE_SLOW_AFTER_MS. */
export const SLOW_SAVE_LABEL = "Still saving your report. Long documents can take a little longer";

/** Percent band of each stage: [value when the stage starts, highest value it may reach]. */
const STAGE_BANDS: Record<CheckStage, readonly [number, number]> = {
  reading: [2, 15],
  analyzing: [15, 60],
  matching: [60, 80],
  finishing: [85, 85],
  saving: [95, 95],
  confirming: [98, 98],
  complete: [100, 100],
};

/** The highest percentage that may ever be shown before the server has confirmed the finished report. */
export const MAX_PERCENT_BEFORE_CONFIRMED = 99;

/**
 * Only reading and analysis report measurable progress (pages read, Archive scorer 0..100). Everything after — the external
 * matching checks, the final assembly, saving and finalizing — is shown as indeterminate (spinner, no number), never as a
 * number that sits still or moves on its own.
 */
export function isIndeterminateCheckStage(stage: CheckStage): boolean {
  return stage === "matching" || stage === "finishing" || stage === "saving" || stage === "confirming";
}

/**
 * Percent for a stage and the measured fraction (0..1) of that stage. Monotonic within a stage; 100 ONLY for "complete".
 */
export function checkStagePercent(stage: CheckStage, fraction = 0): number {
  const [from, to] = STAGE_BANDS[stage];
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const value = Math.round(from + (to - from) * f);
  return stage === "complete" ? 100 : Math.min(MAX_PERCENT_BEFORE_CONFIRMED, value);
}

/** What the progress panel may display: never 100 unless the check is confirmed complete. */
export function displayedCheckPercent(progress: number, complete: boolean): number {
  if (complete) return 100;
  const value = Number.isFinite(progress) ? Math.round(progress) : 0;
  return Math.min(MAX_PERCENT_BEFORE_CONFIRMED, Math.max(0, value));
}

/** After this long without a save answer the label says so, once. */
export const SAVE_SLOW_AFTER_MS = 60_000;
/** After this long the client stops waiting for the save request itself (the server may still finish; the room read decides). */
export const SAVE_GIVE_UP_AFTER_MS = 300_000;

/** True when the room read shows THIS check's report (any status) — the server has it, whatever happened to the save answer. */
export function roomHoldsReport(result: RoomContentsFetchResult, reportId: string): boolean {
  return result.ok && result.contents.status !== "empty" && result.contents.report?.id === reportId;
}
