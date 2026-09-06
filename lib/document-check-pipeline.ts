import { createReceiptPdf } from "@/lib/receipt-pdf";
import { extractPdfTextDocument } from "@/lib/pdf-text-extraction";
import { extractDocxTextDocument } from "@/lib/docx-text-extraction";
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
import type { WebCheckResult } from "@/lib/web-check-core";
import type { AcademicSearchStatus, ExternalAcademicEvidence } from "@/lib/academic-search/types";

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
