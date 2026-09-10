/**
 * PHASE 5 — document-extraction completeness signal.
 *
 * The canonical extraction boundary in the product is `extractFileText()` in
 * lib/document-check-pipeline.ts (txt/md/html/csv -> file.text(); docx ->
 * extractDocxTextDocument; pdf -> extractPdfTextDocument). Today all three
 * return a bare string with NO completeness metadata, so this module's default
 * is UNKNOWN — a percentage is never invented when the source data cannot
 * support one (task rule). Populating COMPLETE / PARTIAL requires the extractors
 * to return per-page / per-section results:
 *   - pdf: pages that threw or produced no text; a maxPages truncation;
 *   - docx: mammoth conversion-loss `messages` for unconvertible content.
 * txt/md/html/csv are always COMPLETE.
 *
 * Nothing here changes the score or the analyzed text — it is a diagnostic that
 * rides alongside the report.
 */

export type ReportExtractionCompleteness = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export type ReportExtractionDiagnostic = {
  completeness: ReportExtractionCompleteness;
  /** words the similarity pipeline could analyse, when knowable; else null. */
  analyzableWordCount: number | null;
  /**
   * The portion that could not be read, when knowable. Unit is abstract
   * (pdf pages vs docx sections) so a caller never has to invent a percentage.
   * null when the extractor reports nothing.
   */
  skipped: { unit: "pages" | "sections" | "characters"; total: number; read: number } | null;
  /** non-sensitive extractor tag (e.g. "pdf-text-extraction-v1", "plain-text"). */
  extractor: string | null;
};

export function unknownExtractionDiagnostic(): ReportExtractionDiagnostic {
  return { completeness: "UNKNOWN", analyzableWordCount: null, skipped: null, extractor: null };
}

/** Build a diagnostic from real extractor counts. `read < total` => PARTIAL. */
export function extractionDiagnosticFromCounts(input: {
  extractor: string;
  unit: "pages" | "sections" | "characters";
  total: number;
  read: number;
  analyzableWordCount?: number | null;
}): ReportExtractionDiagnostic {
  const partial = Number.isFinite(input.total) && Number.isFinite(input.read) && input.read < input.total;
  return {
    completeness: partial ? "PARTIAL" : "COMPLETE",
    analyzableWordCount: input.analyzableWordCount ?? null,
    skipped: input.total > 0 ? { unit: input.unit, total: input.total, read: input.read } : null,
    extractor: input.extractor,
  };
}

/** Plain-text formats are always fully extracted. */
export function plainTextExtractionDiagnostic(analyzableWordCount: number | null): ReportExtractionDiagnostic {
  return { completeness: "COMPLETE", analyzableWordCount, skipped: null, extractor: "plain-text" };
}

export function skippedUnitCount(d: ReportExtractionDiagnostic): number {
  if (!d.skipped) return 0;
  return Math.max(0, d.skipped.total - d.skipped.read);
}
