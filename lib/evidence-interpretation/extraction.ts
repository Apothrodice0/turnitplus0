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

/**
 * DOCUMENT EXTRACTION V2 — server-side clamp of a client-observed extraction
 * diagnostic.
 *
 * Document extraction runs ENTIRELY client-side (the browser parses the
 * uploaded PDF/DOCX bytes; the server only ever receives the already-extracted
 * `report.text`), so — unlike `evidenceInterpretation` / `reportCompletion`,
 * which the server recomputes from its OWN authoritative matched-position data —
 * this signal has no server-side recompute path. It is therefore treated like
 * the pre-existing `academicEvidenceStatus` completion input: a client-supplied,
 * SCORE-NEUTRAL value (it feeds only `resolveReportCompletion`'s display copy —
 * `completion.ts` never reads a score or a matched position) that is
 * sanitised-and-kept rather than stripped-and-recomputed. It travels on the save
 * request as a sibling of `payload` (never inside it — the in-payload
 * `extractionDiagnostic` stays on the untrusted-key strip list), exactly like
 * `academicSearchDiagnosticsId`.
 *
 * Clamps `completeness` to the known 3-value enum ("FAILED" and any unknown
 * value collapse to "UNKNOWN" — a FAILED extraction never produces a report to
 * attach a diagnostic to), bounds every count to a safe non-negative integer,
 * caps `skipped.total` so a forged value cannot render an absurd "about
 * 999999999 pages were skipped" banner, and drops every other key. Returns
 * `null` for input that is not a plain object.
 */
const MAX_SKIPPED_UNIT_TOTAL = 100_000;

export function sanitizeExtractionDiagnostic(raw: unknown): ReportExtractionDiagnostic | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const completeness: ReportExtractionCompleteness =
    r.completeness === "COMPLETE" || r.completeness === "PARTIAL" ? r.completeness : "UNKNOWN";

  const clampCount = (v: unknown): number | null => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : NaN;
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(n, MAX_SKIPPED_UNIT_TOTAL);
  };

  const analyzableWordCount = clampCount(r.analyzableWordCount);

  let skipped: ReportExtractionDiagnostic["skipped"] = null;
  if (r.skipped && typeof r.skipped === "object" && !Array.isArray(r.skipped)) {
    const s = r.skipped as Record<string, unknown>;
    const unit = s.unit === "pages" || s.unit === "sections" || s.unit === "characters" ? s.unit : null;
    // total is required and must be a real positive count; read is a count with
    // a floor of 0 and a ceiling of total (a negative/garbage read is clamped,
    // not treated as "the whole object is invalid").
    const total = clampCount(s.total);
    const rawRead = typeof s.read === "number" && Number.isFinite(s.read) ? Math.floor(s.read) : 0;
    if (unit && total != null && total > 0) {
      skipped = { unit, total, read: Math.min(Math.max(0, rawRead), total) };
    }
  }

  const extractor =
    typeof r.extractor === "string" && r.extractor.length > 0 && r.extractor.length <= 64
      ? r.extractor
      : null;

  return { completeness, analyzableWordCount, skipped, extractor };
}
