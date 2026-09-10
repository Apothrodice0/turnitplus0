import { createReceiptPdf } from "@/lib/receipt-pdf";
import { extractPdfTextDocument, extractPdfTextDocumentWithCompleteness, PDF_EXTRACTOR_VERSION } from "@/lib/pdf-text-extraction";
import { extractDocxTextDocument, extractDocxTextDocumentWithCompleteness } from "@/lib/docx-text-extraction";
import { combineMatchedWordPositions } from "@/lib/similarity-enrichment";
import { computeUnifiedSimilarity } from "@/lib/unified-similarity";
import { similarityScoreBand } from "@/lib/ai-core";
import { analyzeArchive } from "@/lib/archive-analysis-runtime";
import {
  hasUnifiedSimilarity,
  PRIMARY_SIMILARITY_BAND_LABELS,
  primarySimilarityScore,
  unifiedEvidenceSummary,
  type SimilarityReport,
} from "@/lib/report-types";
import { withEvidenceInterpretation } from "@/lib/report-evidence-interpretation";
import {
  extractionDiagnosticFromCounts,
  plainTextExtractionDiagnostic,
  type ReportExtractionDiagnostic,
} from "@/lib/evidence-interpretation";
import type { WebCheckResult } from "@/lib/web-check-core";
import type { AcademicSearchStatus, ExternalAcademicEvidence } from "@/lib/academic-search/types";
import {
  setReferenceEntryStatus,
  MAX_REFERENCE_TEXT_CHARS,
  REFERENCE_TOO_LARGE_MESSAGE,
  type ReferenceIntakeEntry,
  type SuppliedReferenceInput,
} from "@/lib/user-supplied-reference-constants";

// USER-SUPPLIED REFERENCES — the browser upload intake. Re-exported through the
// existing shared check-pipeline module so app/page.tsx and the room shell add
// no new import (see lib/user-supplied-reference-constants.ts for the pure
// validation/limits and components/reports/reference-files-panel.tsx for the UI).
export {
  addReferenceFiles,
  removeReferenceFile,
  markReferencesChecked,
  referenceFileType,
  referenceTransportBudgetError,
  REFERENCE_BUDGET_MESSAGE,
  REFERENCE_TOO_LARGE_MESSAGE,
  MAX_REFERENCE_FILES,
  MAX_REFERENCE_TEXT_CHARS,
  MAX_REFERENCE_AGGREGATE_TEXT_CHARS,
  REFERENCE_ACCEPT_ATTR,
  REFERENCE_STATUS_LABEL,
} from "@/lib/user-supplied-reference-constants";
export type {
  ReferenceIntakeEntry,
  ReferenceIntakeStatus,
  ReferenceRejection,
  ReferenceBudgetError,
  SuppliedReferenceInput,
} from "@/lib/user-supplied-reference-constants";

/**
 * The document-check pipeline's shared, stateless pieces — extracted so
 * app/page.tsx's anonymous Dashboard flow and the authenticated room page
 * (app/reports/rooms/[room]/room-page-shell.tsx) can both drive a new check
 * without duplicating the worker-orchestration/enrichment logic itself.
 *
 * Deliberately excludes analyzeAiText and its pendingAiReject cancellation
 * plumbing: tests/ai-model-prep.test.mjs pins that specific pair to
 * app/page.tsx's own source text (an existing, protected assertion from
 * before this file existed), and the room page has no equivalent
 * cancellation UI to wire it into anyway — each caller keeps its own small,
 * self-contained AI-worker singleton instead.
 */

let webCheckWorker: Worker | null = null;
let webCheckRequestId = 0;

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function analyzeText(
  text: string,
  fileName: string,
  fileSize: number,
  onProgress: (progress: number, label: string) => void,
): Promise<SimilarityReport> {
  // slice 2E: the archive engine (browser static-index worker vs server DB
  // matcher) is chosen inside analyzeArchive, once per page load, from
  // ARCHIVE_SERVER_SIDE_ENABLED via GET /api/archive/match. Both engines
  // return the identical frozen ArchiveAnalysisResult shape, so everything
  // below is engine-agnostic. Ordinary uploads (app/page.tsx) and room
  // uploads (room-page-shell.tsx) both reach it through here.
  const result = await analyzeArchive(text, fileName, onProgress);
  const now = new Date();

  return {
    version: 11,
    id: Date.now(),
    submissionId: String(Date.now()).slice(-10),
    title: fileName,
    author: "Guest submission",
    assignment: "Personal similarity check",
    created: now.toISOString(),
    score: result.score,
    archiveScore: result.score,
    wordCount: result.wordCount,
    characterCount: text.length,
    pageCount: Math.max(1, Math.ceil(result.wordCount / 450)),
    fileSize: fileSize ? formatBytes(fileSize) : `${new Blob([text]).size} B`,
    databaseSize: result.databaseSize,
    corpusVersion: result.corpusVersion,
    scoreBand: result.scoreBand,
    riskStatus: result.riskStatus,
    riskTarget: result.riskTarget,
    riskCutoff: result.riskCutoff,
    riskCalibration: result.riskCalibration,
    features: result.features,
    excludedDocuments: result.excludedDocuments,
    matchedWordCount: result.matchedWordCount,
    archiveMatchedPositions: result.archiveMatchedPositions,
    sources: result.sources,
    repeats: result.repeats,
    text,
  };
}

export async function analyzeWikipediaText(
  text: string,
  title: string,
  onProgress: (current: number, total: number, label: string) => void,
): Promise<WebCheckResult> {
  webCheckWorker ??= new Worker(
    new URL("../app/web-check-worker.ts", import.meta.url),
    { type: "module" },
  );
  const id = ++webCheckRequestId;
  return new Promise<WebCheckResult>((resolve, reject) => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.id !== id) return;
      if (event.data.type === "progress") {
        onProgress(event.data.current, event.data.total, event.data.label);
        return;
      }
      webCheckWorker?.removeEventListener("message", handleMessage);
      if (event.data.ok) resolve(event.data.result as WebCheckResult);
      else reject(new Error(event.data.error));
    };
    webCheckWorker?.addEventListener("message", handleMessage);
    webCheckWorker?.postMessage({ id, text, title, count: 20 });
  });
}

export type AcademicEvidenceCheckResult = {
  evidence: ExternalAcademicEvidence[];
  status: AcademicSearchStatus;
  /**
   * Developer-diagnostics addition: a bare correlation id for the
   * server-side-only diagnostics row /api/academic-evidence already
   * persisted (see that route's own header comment for why the raw
   * diagnostic content itself — candidates, queries, provider errors —
   * never round-trips through this client at all, only this id). Forwarded
   * to saveReport()/saveReportRemote() so app/api/reports/route.ts can link
   * it to the saved report. null whenever no diagnostics row exists (a
   * network failure before the check ran, or text under MIN_TEXT_LENGTH).
   */
  academicSearchDiagnosticsId: number | null;
};

// Phase 3: unlike analyzeWikipediaText above, this cannot run in a Worker —
// lib/academic-search/'s HTTP-fallback text retrieval needs Node's
// SSRF-validation module (node:dns/node:net), which does not exist in a
// browser/Worker context. A server round-trip is the smallest safe
// alternative the existing architecture already supports (the same
// fetch-a-JSON-API shape every other client helper in this file uses) — see
// app/api/academic-evidence/route.ts's own header comment.
//
// Must never throw — every failure path (network error, non-2xx response,
// malformed body) resolves to a well-formed FAILED result instead, exactly
// like getExternalAcademicEvidence's own never-throws contract server-side.
export async function analyzeAcademicEvidence(text: string): Promise<AcademicEvidenceCheckResult> {
  try {
    const response = await fetch("/api/academic-evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`academic evidence request failed (${response.status})`);
    const data = (await response.json()) as {
      evidence?: ExternalAcademicEvidence[];
      status?: AcademicSearchStatus;
      academicSearchDiagnosticsId?: number | null;
    };
    return {
      evidence: Array.isArray(data.evidence) ? data.evidence : [],
      status: data.status ?? "FAILED",
      academicSearchDiagnosticsId: data.academicSearchDiagnosticsId ?? null,
    };
  } catch (error) {
    console.debug("Academic evidence check failed.", {
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return { evidence: [], status: "FAILED", academicSearchDiagnosticsId: null };
  }
}

export async function extractFileText(file: File, onProgress: (progress: number, label: string) => void) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (["txt", "md", "html", "csv"].includes(extension ?? "")) {
    onProgress(18, "Reading document content");
    return file.text();
  }
  if (extension === "docx") {
    onProgress(18, "Reading document content");
    const mammoth = await import("mammoth/mammoth.browser");
    return extractDocxTextDocument(mammoth.convertToHtml, { arrayBuffer: await file.arrayBuffer() });
  }
  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
    // Release-hardening audit (DEP-01): enableScripting is NOT a
    // getDocument() option in this pdfjs-dist version (belongs only to
    // AnnotationLayerBuilder/PDFViewer, never imported here) — see
    // lib/corpus-extraction-worker.ts's own comment on the same finding.
    // The real fix is the pdfjs-dist version pin (>=6.2.108, patches
    // GHSA-hq66-cqwq-w95j); text-extraction-only usage like this never
    // reaches the scripting-capable rendering subsystem regardless.
    const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    return extractPdfTextDocument(document, (pageNumber, pageCount) => {
      onProgress(8 + Math.round((pageNumber / pageCount) * 20), `Reading page ${pageNumber} of ${pageCount}`);
    });
  }
  throw new Error("This file type is not supported.");
}

/**
 * DOCUMENT EXTRACTION V2 — the product upload boundary. Same format routing and
 * same extracted TEXT as {@link extractFileText} (delegates to the same
 * helpers), plus a {@link ReportExtractionDiagnostic} describing whether the
 * extraction was COMPLETE / PARTIAL / UNKNOWN.
 *
 * - txt/md/html/csv: a successful `file.text()` read is always COMPLETE
 *   (a read failure throws, exactly as before — the FAILED path, no report).
 * - docx: COMPLETE on a successful parse with usable text; a parse failure or
 *   zero-usable-text throws (existing failure path). mammoth has no reliable
 *   partial-loss signal, so DOCX never reports PARTIAL.
 * - pdf: COMPLETE when every page parsed; PARTIAL when one or more non-blank
 *   pages failed to parse (the rest of the document is still analysed); a
 *   throw only when NO analyzable text could be extracted at all. No OCR.
 *
 * The diagnostic is SCORE-NEUTRAL — it feeds only the report-completion banner
 * (lib/evidence-interpretation/completion.ts), never a score or a matched
 * position — and is recomputed/replaced client-side for the immediately-shown
 * view; the server sanitises the client value on save (it never sees the
 * uploaded bytes and so cannot recompute this itself).
 */
export async function extractFileTextWithDiagnostics(
  file: File,
  onProgress: (progress: number, label: string) => void,
): Promise<{ text: string; extraction: ReportExtractionDiagnostic }> {
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (["txt", "md", "html", "csv"].includes(extension ?? "")) {
    onProgress(18, "Reading document content");
    const text = await file.text();
    const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
    return { text, extraction: plainTextExtractionDiagnostic(words) };
  }

  if (extension === "docx") {
    onProgress(18, "Reading document content");
    const mammoth = await import("mammoth/mammoth.browser");
    const result = await extractDocxTextDocumentWithCompleteness(mammoth.convertToHtml, {
      arrayBuffer: await file.arrayBuffer(),
    });
    if (result.completeness === "FAILED") throw new Error("This file could not be read.");
    return {
      text: result.text,
      extraction: {
        completeness: "COMPLETE",
        analyzableWordCount: result.extractedWordCount,
        skipped: null,
        extractor: "docx-text-extraction-v1",
      },
    };
  }

  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
    const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const result = await extractPdfTextDocumentWithCompleteness(document, (pageNumber, pageCount) => {
      onProgress(8 + Math.round((pageNumber / pageCount) * 20), `Reading page ${pageNumber} of ${pageCount}`);
    });
    if (result.completeness === "FAILED") throw new Error("This file could not be read.");
    return {
      text: result.text,
      extraction: extractionDiagnosticFromCounts({
        extractor: PDF_EXTRACTOR_VERSION,
        unit: "pages",
        total: result.totalPages,
        read: result.parsedPages,
        analyzableWordCount: result.extractedWordCount,
      }),
    };
  }

  throw new Error("This file type is not supported.");
}

/**
 * USER-SUPPLIED REFERENCES V1 — PHASE 3. Run every chosen reference file through
 * Extraction V2 and shape ONLY the raw, server-expected input:
 * `{ fileName, fileType, extractedText, extraction }`. This never computes a
 * matched position, similarity %, contribution %, interpretation, admission, or
 * source ref — the server (re)derives all of that from the text.
 *
 * A reference whose extraction fails — OR whose extracted text is over
 * {@link MAX_REFERENCE_TEXT_CHARS} — still yields an input, but with an EMPTY
 * `extractedText` (NEVER a truncated prefix): the server records it as a FAILED
 * reference, the reference channel becomes PARTIAL, and the OTHER references are
 * still checked. It never aborts the manuscript report. `onStatus` drives the
 * per-file UI lifecycle (processing → failed | checking); `checked` is set by
 * the caller once the save that runs the server verification has completed.
 *
 * `extract` is injectable purely for tests — production always uses the real
 * client-side {@link extractFileTextWithDiagnostics}.
 */
export async function extractReferenceInputs(
  entries: readonly ReferenceIntakeEntry[],
  onStatus: (entries: ReferenceIntakeEntry[]) => void,
  extract: (
    file: File,
    onProgress: (progress: number, label: string) => void,
  ) => Promise<{ text: string; extraction: ReportExtractionDiagnostic }> = extractFileTextWithDiagnostics,
): Promise<SuppliedReferenceInput[]> {
  let live: ReferenceIntakeEntry[] = [...entries];
  const push = (id: string, status: ReferenceIntakeEntry["status"], note: string | null = null) => {
    live = setReferenceEntryStatus(live, id, status, note);
    onStatus(live);
  };

  const inputs: SuppliedReferenceInput[] = [];
  for (const entry of entries) {
    push(entry.id, "processing");
    try {
      const { text, extraction } = await extract(entry.file, () => {});
      const usable = typeof text === "string" ? text : "";
      if (usable.trim().length === 0) {
        push(entry.id, "failed", "Could not read this reference");
        inputs.push({ fileName: entry.displayName, fileType: entry.fileType, extractedText: "", extraction: null });
        continue;
      }
      if (usable.length > MAX_REFERENCE_TEXT_CHARS) {
        // Over the per-reference limit — REJECT this one reference, never
        // truncate it. Sent as an empty (FAILED) input so the server marks the
        // channel PARTIAL; every other reference is still checked normally.
        push(entry.id, "failed", REFERENCE_TOO_LARGE_MESSAGE);
        inputs.push({ fileName: entry.displayName, fileType: entry.fileType, extractedText: "", extraction: null });
        continue;
      }
      push(entry.id, "checking");
      inputs.push({ fileName: entry.displayName, fileType: entry.fileType, extractedText: usable, extraction });
    } catch {
      push(entry.id, "failed", "Could not read this reference");
      inputs.push({ fileName: entry.displayName, fileType: entry.fileType, extractedText: "", extraction: null });
    }
  }
  return inputs;
}

export async function downloadReceipt(report: SimilarityReport) {
  const primaryScore = primarySimilarityScore(report);
  const verdict = similarityScoreBand(primaryScore);
  const unified = hasUnifiedSimilarity(report) && report.unifiedSimilarity && verdict
    ? {
      score: primaryScore,
      label: PRIMARY_SIMILARITY_BAND_LABELS[verdict.key],
      evidenceSummary: unifiedEvidenceSummary(report.unifiedSimilarity),
    }
    : undefined;
  const blob = await createReceiptPdf({ ...report, unified });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const baseName = report.title.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  anchor.href = url;
  anchor.download = `${baseName || "submission"}-receipt.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function enrichReportWithWikipedia(report: SimilarityReport, webCheck: WebCheckResult): SimilarityReport {
  const archiveScore = report.archiveScore ?? report.score;
  const combined = report.archiveMatchedPositions
    ? combineMatchedWordPositions(
      report.archiveMatchedPositions,
      webCheck.matches.filter((match) => match.matched),
      report.wordCount,
    )
    : { matchedWordCount: report.matchedWordCount, externalMatchedWordCount: 0, score: archiveScore };
  return {
    ...report,
    archiveScore,
    score: combined.score,
    matchedWordCount: combined.matchedWordCount,
    wikipediaMatchedWordCount: combined.externalMatchedWordCount,
    webCheck,
  };
}

// Phase 3: unlike enrichReportWithWikipedia above, this never touches
// score/archiveScore/matchedWordCount — the phase's own PRIMARY PRODUCT
// RULE. TurnitPlus's own corpus similarity stays the single, unambiguous
// headline number; external academic evidence is purely additive. Always
// carries the check's status alongside the evidence array itself so a
// FAILED check is never rendered identically to a genuine zero-result
// COMPLETE_NO_MATCHES.
export function enrichReportWithAcademicEvidence(report: SimilarityReport, result: AcademicEvidenceCheckResult): SimilarityReport {
  return { ...report, externalAcademicEvidence: result.evidence, academicEvidenceStatus: result.status };
}

/**
 * computeUnifiedSimilarity() is a pure, synchronous, network-free function
 * (lib/unified-similarity.ts's own header comment) — safe to run here, in
 * the browser, at save time, using exactly the archive + live-academic
 * evidence this client already has in memory. Attaching the result to the
 * report BEFORE storeReport()/saveReportRemote() means it rides along in
 * payload_json and IndexedDB for free, with no new server round-trip.
 *
 * Deliberately omits historicalSubmissionMatch: that axis is server-only
 * (lib/report-historical-match.ts) and, by design, must stay read-time-
 * recomputed rather than frozen at save time — the growing corpus can gain
 * a match for this exact content after this report was saved, so freezing
 * it here would risk permanently under- OR over-counting it. Never touches
 * score/archiveScore/aiScore.
 */
export function attachUnifiedSimilarity(report: SimilarityReport): SimilarityReport {
  try {
    return {
      ...report,
      unifiedSimilarity: computeUnifiedSimilarity({
        wordCount: report.wordCount,
        archiveMatchedPositions: report.archiveMatchedPositions,
        externalAcademicEvidence: report.externalAcademicEvidence,
      }),
    };
  } catch {
    return report;
  }
}

/**
 * Report V2 — attach the additive, EXPLANATION-ONLY `evidenceInterpretation` /
 * `reportCompletion` / `extractionDiagnostic` fields for the immediately-shown
 * (pre-save / anonymous) view and the receipt. Same pattern as
 * attachUnifiedSimilarity: pure, synchronous, network-free, changes no score
 * or matched position.
 *
 * Client-side this omits `historicalSubmissionMatch` (server-only, and
 * same-work is dormant regardless) and passes `null` for the Selective Corpus
 * branch (a flag-OFF shadow, never a client search). The SERVER recomputes and
 * OVERWRITES these values on save — see lib/report-evidence-interpretation.ts
 * withEvidenceInterpretation.
 */
export function attachEvidenceInterpretation(
  report: SimilarityReport,
  opts: { extraction?: ReportExtractionDiagnostic | null } = {},
): SimilarityReport {
  try {
    return withEvidenceInterpretation(report, {
      selectiveCorpusBranch: null,
      // DOCUMENT EXTRACTION V2 — the client-observed extraction completeness for
      // the immediately-shown view. The server re-sanitises the same value from
      // the save request's sibling field (it never sees the uploaded bytes).
      serverExtractionDiagnostic: opts.extraction ?? null,
    });
  } catch {
    return report;
  }
}
