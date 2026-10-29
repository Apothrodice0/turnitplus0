import { formatSimilarityPercent } from "./report-types";

/**
 * UNIFIED SIMILARITY — PROVISIONAL owner-only fusion of System 1 and System 2 (owner decision 2026-10-29).
 *
 *   final_similarity = max(system1_similarity, conservative_system2_estimate)
 *
 * This is a transparent PROVISIONAL rule, NOT a validated combined similarity model: no completed study established a
 * fusion rule (the joint and two-route models were NO-GO, and percentages must never be added). It is only reachable
 * for the allowlisted owner in protected Preview deployments (lib/system2-research.ts) and must not reach customers
 * until its behaviour has been evaluated.
 *
 * System 2 contributes only when its estimate is usable: an English Word document, authorized, inference succeeded and
 * an integer 0–20 conservative estimate was shown. Otherwise the System 1 result is kept unchanged. System 1's
 * source-backed highlights, sources and per-source percentages are never touched by this: when System 2 raises the
 * score, the difference is marked as statistical estimation, never attributed to a source.
 */

export type System2EstimateRecord = {
  state: string;
  estimate_shown: boolean;
  final_text: string;
  conservative_estimate_percent?: number;
  warnings?: string[];
};

export type UnifiedSimilarity = {
  /** The ONE similarity percentage shown. */
  percent: number;
  /** System 1's verified, source-backed percentage (kept for the distinction; never shown as a second percentage). */
  system1Percent: number;
  /** System 2's conservative estimate when usable, else null. */
  system2Percent: number | null;
  /** True only when System 2 raised the result above verified source coverage. */
  includesStatisticalEstimate: boolean;
};

export const UNIFIED_ESTIMATE_NOTE = "Includes statistical estimation beyond verified source matches.";

export function usableSystem2Percent(estimate: System2EstimateRecord | null | undefined): number | null {
  if (!estimate || estimate.estimate_shown !== true) return null;
  const p = estimate.conservative_estimate_percent;
  return typeof p === "number" && Number.isInteger(p) && p >= 0 && p <= 20 ? p : null;
}

export function unifySimilarity(system1Percent: number, estimate: System2EstimateRecord | null | undefined): UnifiedSimilarity {
  const system2Percent = usableSystem2Percent(estimate);
  const includesStatisticalEstimate = system2Percent !== null && system2Percent > system1Percent;
  return {
    percent: includesStatisticalEstimate ? system2Percent : system1Percent,
    system1Percent,
    system2Percent,
    includesStatisticalEstimate,
  };
}

/** The display string: System 1's own "<1%" rule when System 1 stands, the plain unified percentage otherwise. */
export function unifiedPercentText(unified: UnifiedSimilarity, matchedWords: number): string {
  return unified.includesStatisticalEstimate ? `${unified.percent}%` : formatSimilarityPercent(unified.system1Percent, matchedWords);
}
