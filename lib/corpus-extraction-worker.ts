import { parentPort, workerData } from "node:worker_threads";
import mammoth from "mammoth";
import { ensurePdfjsNodePolyfills } from "./pdfjs-node-polyfill";
import { extractPdfTextDocument, PDF_EXTRACTOR_VERSION, type PdfTextDocument } from "./pdf-text-extraction";
import { extractDocxTextDocument } from "./docx-text-extraction";
import { extractTextFromHtml, HTML_EXTRACTOR_VERSION } from "./html-text-extraction";
import { validateDocxStructure } from "./corpus-docx-validation";
import type { CorpusAdmissionLimits, CorpusHardGateCode, CorpusSupportedFormat } from "./corpus-admission-types";

/**
 * The isolated unit of work for corpus-admission extraction (requirement
 * 5): runs inside a node:worker_threads Worker spawned by
 * lib/corpus-text-extraction.ts, which enforces a real OS-thread-level
 * worker.terminate() on timeout/memory-limit breach — not a same-thread
 * Promise.race that merely stops waiting while an abandoned parse keeps
 * running. DOCX structural validation (lib/corpus-docx-validation.ts) runs
 * in here too, not in the main process, since parsing a ZIP central
 * directory is itself "parsing untrusted file content."
 *
 * Reuses the exact same server-side extraction primitives every other
 * phase of this codebase already uses (lib/pdf-text-extraction.ts +
 * lib/pdfjs-node-polyfill.ts, lib/docx-text-extraction.ts + Node mammoth,
 * lib/html-text-extraction.ts) — no second extraction implementation.
 */

export const DOCX_MAMMOTH_EXTRACTOR_VERSION = "docx-mammoth-html-v1";
export const PLAIN_TEXT_EXTRACTOR_VERSION = "plain-text-decode-v1";

export type CorpusExtractionWorkerRequest = {
  format: CorpusSupportedFormat;
  bytes: Uint8Array;
  limits: CorpusAdmissionLimits;
};

export type CorpusExtractionWorkerResult =
  | { ok: true; rawText: string; extractorVersion: string }
  | { ok: false; reasonCode: CorpusHardGateCode; detail: string };

function isPasswordException(err: unknown): boolean {
  return err instanceof Error && err.name === "PasswordException";
}

export async function runCorpusExtraction(request: CorpusExtractionWorkerRequest): Promise<CorpusExtractionWorkerResult> {
  const { format, limits } = request;
  const bytes = Buffer.from(request.bytes);

  if (format === "docx") {
    const structure = await validateDocxStructure(bytes, limits);
    if (!structure.ok) return structure;
  }

  let rawText: string;
  let extractorVersion: string;

  try {
    if (format === "pdf") {
      await ensurePdfjsNodePolyfills();
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      let document: unknown;
      try {
        // pdfjs-dist explicitly rejects a Node Buffer here ("Please provide
        // binary data as Uint8Array, rather than Buffer") even though
        // Buffer is a Uint8Array subclass — it must be a genuine Uint8Array.
        // Release-hardening audit (DEP-01): enableScripting is NOT a
        // getDocument()/DocumentInitParameters option in this pdfjs-dist
        // version — TypeScript itself rejects it there. It exists only on
        // AnnotationLayerBuilder/PDFViewer (web/annotation_layer_builder.d.ts,
        // web/pdf_viewer.d.ts), pdfjs's interactive-rendering subsystem,
        // which this file never imports — see
        // tests/pdfjs-scripting-disabled.test.mjs's structural proof that
        // no code path in this app ever does. Embedded-PDF-JS execution is
        // therefore unreachable here regardless of any flag; the real fix
        // is the pdfjs-dist version pin itself (>=6.2.108, patches
        // GHSA-hq66-cqwq-w95j).
        document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      } catch (err) {
        if (isPasswordException(err)) {
          return { ok: false, reasonCode: "EXTRACTION_FAILED", detail: "PDF is password-protected/encrypted." };
        }
        throw err;
      }
      const pdfDocument = document as PdfTextDocument & { numPages: number };
      if (pdfDocument.numPages > limits.maxPdfPages.value) {
        return { ok: false, reasonCode: "EXTRACTION_FAILED", detail: `PDF has ${pdfDocument.numPages} pages, exceeding the ${limits.maxPdfPages.value}-page cap.` };
      }
      rawText = await extractPdfTextDocument(pdfDocument, () => {});
      extractorVersion = PDF_EXTRACTOR_VERSION;
    } else if (format === "docx") {
      rawText = await extractDocxTextDocument(mammoth.convertToHtml, { buffer: bytes });
      extractorVersion = DOCX_MAMMOTH_EXTRACTOR_VERSION;
    } else if (format === "html") {
      rawText = extractTextFromHtml(bytes.toString("utf8"));
      extractorVersion = HTML_EXTRACTOR_VERSION;
    } else {
      rawText = bytes.toString("utf8");
      extractorVersion = PLAIN_TEXT_EXTRACTOR_VERSION;
    }
  } catch (err) {
    return { ok: false, reasonCode: "EXTRACTION_FAILED", detail: err instanceof Error ? err.message : String(err) };
  }

  if (rawText.trim().length === 0) {
    return { ok: false, reasonCode: "EXTRACTION_EMPTY_RESULT", detail: "Extraction produced no text." };
  }
  if (rawText.length > limits.maxExtractedChars.value) {
    return { ok: false, reasonCode: "EXTRACTED_CONTENT_TOO_LARGE", detail: `Extracted text is ${rawText.length} characters, exceeding the ${limits.maxExtractedChars.value}-character cap.` };
  }

  return { ok: true, rawText, extractorVersion };
}

// Only runs when this module is actually loaded as a Worker entry point
// (parentPort is non-null exactly then) — safe to import this module's
// types/runCorpusExtraction from a non-worker context (tests) without
// triggering this block.
if (parentPort) {
  const port = parentPort;
  runCorpusExtraction(workerData as CorpusExtractionWorkerRequest)
    .then((result) => port.postMessage(result))
    .catch((err) => port.postMessage({ ok: false, reasonCode: "EXTRACTION_FAILED", detail: err instanceof Error ? err.message : String(err) } satisfies CorpusExtractionWorkerResult));
}
