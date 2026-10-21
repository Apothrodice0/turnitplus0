/**
 * UPLOAD PROGRESS (customer-facing check progress, 2026-10-20/21).
 *
 * Production showed "100% · Saving your report" for several minutes: the bar was a timer animated to 95 % over a random
 * 8–15 s, then set to 100 % BEFORE the save request was even sent, so every second the server spent saving was displayed as
 * finished. Now there is ONE continuous bar (owner decision 2026-10-21): measured events (pages read, Archive scorer progress)
 * move it at once; between events it keeps easing toward the current stage's ceiling, slowing as it gets closer, so it never
 * freezes and never races ahead; it can never pass 95 % before the server has the report, and 100 % is shown
 * only once the room read confirms the saved report ("Report saved" — "Report ready" is the room header's word once AI is done too).
 *
 * Shared by the room page and the dashboard; tests/upload-progress-ux.test.mjs pins it.
 */
import { useEffect } from "react";
import type { RoomContentsFetchResult } from "./reports-remote";

export type CheckStage = "reading" | "analyzing" | "matching" | "finishing" | "saving" | "confirming" | "complete";

/** What is happening right now (the panel adds "…"). */
export const CHECK_STAGE_LABELS: Record<CheckStage, string> = {
  reading: "Reading your document",
  analyzing: "Analyzing your document",
  matching: "Checking for matching passages",
  finishing: "Preparing your report",
  saving: "Saving your report",
  confirming: "Finalizing your report",
  // 100 % = the report is saved; AI analysis is still running then (it starts after the save), so the room header says
  // "Report ready" only later, once both AI and similarity are available.
  complete: "Report saved",
};

/** Shown once (not rotated) when a save is still running after SAVE_SLOW_AFTER_MS. */
export const SLOW_SAVE_LABEL = "Still saving your report. Long documents can take a little longer";

/** Measured band of each stage: [value when the stage starts, value its measured progress reaches at 100 %]. */
const STAGE_BANDS: Record<CheckStage, readonly [number, number]> = {
  reading: [2, 15],
  analyzing: [15, 60],
  matching: [60, 60],
  finishing: [60, 60],
  saving: [60, 60],
  confirming: [60, 60],
  complete: [100, 100],
};

/** The highest value the bar may ease toward before the server has confirmed the report. */
export const MAX_PERCENT_BEFORE_CONFIRMED = 95;

/** How far the bar may ease on its own while a stage runs (it slows as it approaches this). */
export const CHECK_STAGE_CEILING: Record<CheckStage, number> = {
  reading: 15,
  analyzing: 60,
  matching: MAX_PERCENT_BEFORE_CONFIRMED,
  finishing: MAX_PERCENT_BEFORE_CONFIRMED,
  saving: MAX_PERCENT_BEFORE_CONFIRMED,
  confirming: MAX_PERCENT_BEFORE_CONFIRMED,
  complete: 100,
};

/** Percent for a stage and the measured fraction (0..1) of that stage. 100 ONLY for "complete". */
export function checkStagePercent(stage: CheckStage, fraction = 0): number {
  const [from, to] = STAGE_BANDS[stage];
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const value = from + (to - from) * f;
  return stage === "complete" ? 100 : Math.min(MAX_PERCENT_BEFORE_CONFIRMED, value);
}

/** How often the bar eases forward on its own. */
export const CREEP_INTERVAL_MS = 250;
/** Share of the remaining distance to the ceiling covered per step: the gap halves roughly every 8 s (fast early, slow late). */
const CREEP_SHARE = 0.02;

/** One easing step toward `ceiling` (never past it, never backwards). */
export function nextCreepValue(current: number, ceiling: number): number {
  if (!Number.isFinite(current) || current >= ceiling) return current;
  return Math.min(ceiling, current + Math.max(0.02, (ceiling - current) * CREEP_SHARE));
}

/** While `active`, eases the bar toward `ceiling` every CREEP_INTERVAL_MS. */
export function useProgressCreep(active: boolean, ceiling: number, setProgress: (update: (current: number) => number) => void): void {
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setProgress((current) => nextCreepValue(current, ceiling)), CREEP_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, ceiling, setProgress]);
}

/** What the progress panel may display: never 100 unless the check is confirmed complete. */
export function displayedCheckPercent(progress: number, complete: boolean): number {
  if (complete) return 100;
  const value = Number.isFinite(progress) ? Math.floor(progress) : 0;
  return Math.min(MAX_PERCENT_BEFORE_CONFIRMED, Math.max(0, value));
}

/** A short, calm encouragement shown directly above the bar, following the percentage. */
export function progressEncouragement(percent: number, complete: boolean): string {
  if (complete) return "Report saved";
  if (percent >= 85) return "Almost there…";
  if (percent >= 60) return "Getting there…";
  if (percent >= 25) return "Making good progress…";
  return "Just getting started…";
}

/** How long "100 % · Report saved" stays visible before the room shows the report card. */
export const COMPLETE_HOLD_MS = 900;

/** After this long without a save answer the label says so, once. */
export const SAVE_SLOW_AFTER_MS = 60_000;
/** After this long the client stops waiting for the save request itself (the server may still finish; the room read decides). */
export const SAVE_GIVE_UP_AFTER_MS = 300_000;

/** True when the room read shows THIS check's report (any status) — the server has it, whatever happened to the save answer. */
export function roomHoldsReport(result: RoomContentsFetchResult, reportId: string): boolean {
  return result.ok && result.contents.status !== "empty" && result.contents.report?.id === reportId;
}
