import type { PredictedHighlightRange, SimilarityReport } from "@/lib/report-types";
import type { ReportV2ViewModel } from "@/lib/report-v2-view";
import { rankForCharRange } from "@/lib/similarity-print-layout";
import { findHighlightRanges } from "../similarity-report-papers";

/**
 * The printed report's manuscript highlights (2026-10-21): exactly the spans findHighlightRanges gives the report
 * page (Wikipedia only for an authorized viewer), each numbered by the source rank it overlaps most. Shared by the
 * standard text manuscript and the formatted (original .docx) manuscript, so both print the same evidence.
 */
export type PrintHighlight = { start: number; end: number; rank: number | null; wikipedia: boolean; title: string };

export function buildPrintHighlights(report: SimilarityReport, vm: ReportV2ViewModel, rankById: ReadonlyMap<string, number>): PrintHighlight[] {
  return findHighlightRanges(report, { includeWikipedia: Boolean(report.viewerIsAdmin) }).filter((r) => r.kind !== "predicted").map((r) => ({
    start: r.start,
    end: r.end,
    wikipedia: r.kind === "wikipedia",
    rank: r.kind === "wikipedia" ? null : rankForCharRange(r.start, r.end, vm.passages, rankById),
    title: r.kind === "wikipedia" ? `Found on Wikipedia: ${r.label}` : r.kind === "source" || r.kind === "academic" ? `Matched passage: ${r.label}` : "Matched passage",
  }));
}

/**
 * TURNITIN HIGHLIGHT MODEL prototype (lib/highlight-model.ts): the model-predicted passages, already clipped to the gaps
 * between verified matches. Kept apart from buildPrintHighlights so they never get a number, a source or a page-layout
 * role; empty for every viewer the model is not shown to.
 */
export function buildPrintPredicted(report: SimilarityReport): PredictedHighlightRange[] {
  if (!report.predictedHighlights?.length) return [];
  return findHighlightRanges(report, { includeWikipedia: Boolean(report.viewerIsAdmin) }).filter((r) => r.kind === "predicted").map(({ start, end }) => ({ start, end }));
}
