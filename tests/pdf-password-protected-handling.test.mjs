import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  extractFileTextWithDiagnostics,
  isPasswordProtectedPdfError,
  PasswordProtectedPdfError,
  isMalformedPdfError,
  MalformedPdfError,
  isPdfHasNoSelectableTextError,
  PdfHasNoSelectableTextError,
  isNoSelectableTextResult,
} from "../lib/document-check-pipeline.ts";
import { extractPdfTextDocumentWithCompleteness } from "../lib/pdf-text-extraction.ts";
import { buildMinimalEncryptedPdf } from "./helpers/pdf-fixtures.mjs";
import { ensurePdfjsNodePolyfills } from "../lib/pdfjs-node-polyfill.ts";

// Node-only test-environment requirement (see lib/pdfjs-node-polyfill.ts's own
// header comment): document-check-pipeline.ts's PDF branch imports the
// "main"/browser pdfjs-dist build, which relies on a real browser DOMMatrix
// global and a real Worker to reach real PDF parsing. Neither exists in a
// plain Node test process, so without this polyfill applied first, getDocument()
// fails on an unrelated Node-environment error before ever reaching the real
// PDF content this file is actually testing. Production never needs this call
// — app/page.tsx and the room page both run in a real browser.
await ensurePdfjsNodePolyfills();

/**
 * PDF FAILURE SEMANTICS hardening — password-protected, malformed/corrupt,
 * AND zero-selectable-text PDFs. Covers the customer-facing gaps found by the
 * read-only PDF-failure audits: pdfjs's own PasswordException and
 * InvalidPDFException were both propagating uncaught out of
 * extractFileTextWithDiagnostics and being discarded by a bare `catch {}` in
 * app/page.tsx / room-page-shell.tsx, collapsing into the same generic
 * "I could not read that document" message shown for every other failure —
 * including a genuinely VALID PDF (e.g. scanned/image-only) that opens and
 * parses fine but has no selectable text at all. lib/document-check-
 * pipeline.ts's loadPdfDocument converts the first two pdfjs exceptions
 * (identified by stable NAME, reusing the exact idiom lib/corpus-extraction-
 * worker.ts's own isPasswordException already uses for the corpus-ingestion
 * path) into small, distinct app-owned signals — PasswordProtectedPdfError
 * and MalformedPdfError. The third signal, PdfHasNoSelectableTextError, is
 * NOT a loadPdfDocument()/getDocument() boundary conversion (a zero-text PDF
 * never rejects there) — it is decided downstream, from
 * extractPdfTextDocumentWithCompleteness()'s own result, via the narrowest
 * truthful condition (isNoSelectableTextResult): completeness==="FAILED" AND
 * failedPages===0 AND parsedPages>0 AND extractedWordCount===0. Every other
 * FAILED case (all pages individually failed, or a mix of failed+blank
 * pages) deliberately stays on the pre-existing generic message.
 * UnknownErrorException, FormatError, and ResponseException are all
 * deliberately left unconverted and must keep hitting the generic fallback.
 */

const repoRoot = path.resolve(".");

function pdfFile(name, bytes) {
  return new File([bytes], name, { type: "application/pdf" });
}

// Synthetic PdfTextDocument mock, matching the exact shape already
// established in tests/document-extraction-completeness.test.mjs, reused
// here (not duplicated as a second production path) purely to exercise the
// real extractPdfTextDocumentWithCompleteness()/isNoSelectableTextResult()
// boundary at the smallest level, for cases that are impractical to
// construct as real PDF byte buffers (every page individually failing to
// parse, or a mix of failed and blank pages).
function pdfDoc(pages) {
  return {
    numPages: pages.length,
    async getPage(pageNumber) {
      const spec = pages[pageNumber - 1];
      if (spec === "THROW") throw new Error(`synthetic getPage failure on page ${pageNumber}`);
      return {
        async getTextContent() {
          return { items: (spec ?? []).map((str) => ({ str })) };
        },
      };
    },
  };
}

async function assertRejectsAsMalformed(bytes, label) {
  const file = pdfFile("test.pdf", bytes);
  let resolvedValue;
  let resolved = false;
  await assert.rejects(
    async () => {
      resolvedValue = await extractFileTextWithDiagnostics(file, () => {});
      resolved = true;
    },
    (error) => {
      assert.ok(error instanceof Error, `${label}: must reject with a real Error`);
      assert.ok(error instanceof MalformedPdfError, `${label}: must be an instance of the dedicated app-owned MalformedPdfError class`);
      assert.equal(isMalformedPdfError(error), true, `${label}: the predicate must classify it as malformed`);
      assert.equal(isPasswordProtectedPdfError(error), false, `${label}: must NOT also be classified as password-protected`);
      return true;
    },
  );
  assert.equal(resolved, false, `${label}: extraction must reject, never resolve (got: ${JSON.stringify(resolvedValue)})`);
}

// ---------------------------------------------------------------------------
// REAL encrypted PDF through the real customer extraction path (password)
// ---------------------------------------------------------------------------

test("REAL FIXTURE: a genuine password-protected PDF is classified as the app-owned PasswordProtectedPdfError through the real customer extraction path (extractFileTextWithDiagnostics, real pdfjs loader)", async () => {
  const bytes = buildMinimalEncryptedPdf();
  const file = pdfFile("encrypted.pdf", bytes);

  await assert.rejects(
    () => extractFileTextWithDiagnostics(file, () => {}),
    (error) => {
      assert.ok(error instanceof Error, "must reject with a real Error");
      assert.ok(error instanceof PasswordProtectedPdfError, "must be an instance of the dedicated app-owned class");
      assert.equal(isPasswordProtectedPdfError(error), true, "the predicate must classify it as password-protected");
      assert.equal(isMalformedPdfError(error), false, "must NOT also be classified as malformed");
      assert.equal(isPdfHasNoSelectableTextError(error), false, "must NOT also be classified as zero-text");
      return true;
    },
  );
});

test("REAL FIXTURE: the encrypted PDF never resolves — no empty-text success, no COMPLETE/PARTIAL completeness, nothing for a matching/scoring path to consume", async () => {
  const bytes = buildMinimalEncryptedPdf();
  const file = pdfFile("encrypted.pdf", bytes);
  let resolvedValue;
  let resolved = false;
  try {
    resolvedValue = await extractFileTextWithDiagnostics(file, () => {});
    resolved = true;
  } catch {
    // expected — the extraction must reject, not resolve
  }
  assert.equal(resolved, false, `extraction must reject for an encrypted PDF, never resolve (got: ${JSON.stringify(resolvedValue)})`);
});

// ---------------------------------------------------------------------------
// Classification predicates — unit level
// ---------------------------------------------------------------------------

test("isPasswordProtectedPdfError: true for the dedicated app-owned error", () => {
  assert.equal(isPasswordProtectedPdfError(new PasswordProtectedPdfError()), true);
});

test("isPasswordProtectedPdfError: false for an ordinary generic error (non-password fallback)", () => {
  assert.equal(isPasswordProtectedPdfError(new Error("something else")), false);
});

test("isPasswordProtectedPdfError: false for non-Error values, never throws", () => {
  assert.equal(isPasswordProtectedPdfError("PasswordProtectedPdfError"), false);
  assert.equal(isPasswordProtectedPdfError(null), false);
  assert.equal(isPasswordProtectedPdfError(undefined), false);
  assert.equal(isPasswordProtectedPdfError({ name: "PasswordProtectedPdfError" }), false, "a plain object is never an Error instance");
});

test("isPasswordProtectedPdfError: a RAW pdfjs-named PasswordException (not converted) does not match — proves the predicate keys on the app-owned name, not incidental overlap", () => {
  const rawPdfjsShaped = new Error("No password given");
  rawPdfjsShaped.name = "PasswordException"; // pdfjs's OWN name, never converted by this test
  assert.equal(isPasswordProtectedPdfError(rawPdfjsShaped), false);
});

test("isMalformedPdfError: true for the dedicated app-owned error", () => {
  assert.equal(isMalformedPdfError(new MalformedPdfError()), true);
});

test("isMalformedPdfError: false for non-Error values, never throws", () => {
  assert.equal(isMalformedPdfError("MalformedPdfError"), false);
  assert.equal(isMalformedPdfError(null), false);
  assert.equal(isMalformedPdfError(undefined), false);
  assert.equal(isMalformedPdfError({ name: "MalformedPdfError" }), false, "a plain object is never an Error instance");
});

test("isMalformedPdfError: a RAW pdfjs-named InvalidPDFException (not converted) does not match — proves the predicate keys on the app-owned name, not incidental overlap", () => {
  const rawPdfjsShaped = new Error("Invalid PDF structure.");
  rawPdfjsShaped.name = "InvalidPDFException"; // pdfjs's OWN name, never converted by this test
  assert.equal(isMalformedPdfError(rawPdfjsShaped), false);
});

test("isPdfHasNoSelectableTextError: true for the dedicated app-owned error", () => {
  assert.equal(isPdfHasNoSelectableTextError(new PdfHasNoSelectableTextError()), true);
});

test("isPdfHasNoSelectableTextError: false for non-Error values, never throws", () => {
  assert.equal(isPdfHasNoSelectableTextError("PdfHasNoSelectableTextError"), false);
  assert.equal(isPdfHasNoSelectableTextError(null), false);
  assert.equal(isPdfHasNoSelectableTextError(undefined), false);
  assert.equal(isPdfHasNoSelectableTextError({ name: "PdfHasNoSelectableTextError" }), false, "a plain object is never an Error instance");
});

test("isPdfHasNoSelectableTextError: false for the OTHER two app-owned PDF signals — the three signals are mutually exclusive", () => {
  assert.equal(isPdfHasNoSelectableTextError(new PasswordProtectedPdfError()), false);
  assert.equal(isPdfHasNoSelectableTextError(new MalformedPdfError()), false);
});

// ---------------------------------------------------------------------------
// REAL malformed/corrupt PDFs -> the real customer path classifies them as
// MalformedPdfError, never as password-protected, never a bogus success.
// ---------------------------------------------------------------------------

test("A. REAL EMPTY PDF: a zero-byte file is classified as MalformedPdfError through the real extraction path", async () => {
  await assertRejectsAsMalformed(Buffer.alloc(0), "empty buffer");
});

test("B. REAL NON-PDF BYTES: plain, entirely non-PDF bytes are classified as MalformedPdfError through the real extraction path", async () => {
  await assertRejectsAsMalformed(Buffer.from("hello world, this is not a pdf at all", "utf8"), "non-PDF bytes");
});

test("C. REAL FAKE HEADER: a plausible '%PDF-1.4' header with no real structure behind it is classified as MalformedPdfError through the real extraction path", async () => {
  // Same malformed-bytes shape already used by tests/corpus-text-extraction.test.mjs's
  // own "corrupted PDF bytes" case.
  await assertRejectsAsMalformed(Buffer.from("%PDF-1.4\nthis is not real pdf content", "utf8"), "fake header");
});

test("D. REAL TRUNCATED PDF: a real committed PDF retaining only 50% of its bytes is classified as MalformedPdfError through the real extraction path", async () => {
  const fullBytes = fs.readFileSync(path.join(repoRoot, "tests/fixtures/attention-is-all-you-need.pdf"));
  // The read-only malformed-PDF audit already established this exact retention
  // fraction reliably rejects with pdfjs's own InvalidPDFException (unlike a
  // few KB trimmed from the very end, which pdfjs's own internal recovery
  // silently repairs) -- an in-memory-only slice, no copy written to disk.
  const truncated = fullBytes.subarray(0, Math.floor(fullBytes.length * 0.5));
  await assertRejectsAsMalformed(truncated, "50%-truncated real PDF");
});

// ---------------------------------------------------------------------------
// What must remain generic — deliberately NOT classified as malformed
// ---------------------------------------------------------------------------

test("isMalformedPdfError: false for an ordinary generic error (non-malformed fallback)", () => {
  assert.equal(isMalformedPdfError(new Error("something else")), false);
});

test("isMalformedPdfError: an app-unconverted error named 'UnknownErrorException' is NOT malformed — pdfjs's own uncategorized catch-all is not specific enough to mean 'corrupt PDF'", () => {
  const rawUnknown = new Error("Ensure that the standardFontDataUrl API parameter is provided.");
  rawUnknown.name = "UnknownErrorException";
  assert.equal(isMalformedPdfError(rawUnknown), false);
});

test("isMalformedPdfError: an app-unconverted error named 'FormatError' is NOT malformed — a page-content-level failure, never a whole-document classification", () => {
  const rawFormatError = new Error("Bad encoding in flate stream");
  rawFormatError.name = "FormatError";
  assert.equal(isMalformedPdfError(rawFormatError), false);
});

// ---------------------------------------------------------------------------
// Page-level PARTIAL safety — a single broken page must never surface as a
// whole-document MalformedPdfError. Structural guarantee, not re-derived
// here: lib/pdf-text-extraction.ts's collectPdfPages/extractPdfTextDocument
// WithCompleteness (already covered by tests/document-extraction-
// completeness.test.mjs's own "PDF fixture 3" -- re-run in this task's
// validation pass, not duplicated here) never throws for a PARTIAL result at
// all, and it only ever runs AFTER loadPdfDocument has already resolved a
// real document -- a per-page failure structurally cannot reach
// loadPdfDocument's catch block, which only wraps the earlier
// getDocument(...).promise call.
// ---------------------------------------------------------------------------

test("STRUCTURAL: loadPdfDocument (the sole PasswordProtectedPdfError/MalformedPdfError conversion site) runs strictly before per-page completeness classification in extractFileTextWithDiagnostics's PDF branch — a per-page failure can never reach either whole-document classification boundary", () => {
  const src = fs.readFileSync(path.join(repoRoot, "lib/document-check-pipeline.ts"), "utf8");
  const loadPdfDocumentCallIndex = src.indexOf("await loadPdfDocument(");
  const completenessCallIndex = src.indexOf("await extractPdfTextDocumentWithCompleteness(");
  assert.ok(loadPdfDocumentCallIndex !== -1 && completenessCallIndex !== -1, "sanity: both call sites must exist");
  assert.ok(loadPdfDocumentCallIndex < completenessCallIndex, "loadPdfDocument must resolve a document before per-page completeness classification ever runs");
});

test("PARTIAL WITH USABLE TEXT: usable words plus one or more failed pages classifies as PARTIAL, and isNoSelectableTextResult is false — never zero-text, never a whole-document failure", async () => {
  const partial = await extractPdfTextDocumentWithCompleteness(pdfDoc([["Real", "words", "here"], "THROW", []]));
  assert.equal(partial.completeness, "PARTIAL");
  assert.equal(partial.failedPages, 1);
  assert.equal(partial.parsedPages, 2);
  assert.ok(partial.extractedWordCount > 0);
  assert.equal(isNoSelectableTextResult(partial), false, "a PARTIAL result (real words present) must never satisfy the zero-text condition");
});

// ---------------------------------------------------------------------------
// isNoSelectableTextResult boundary — cases that MUST stay generic even
// though completeness === "FAILED", tested at the smallest appropriate
// boundary (the real extractPdfTextDocumentWithCompleteness result), since
// extractFileTextWithDiagnostics hardcodes its own real pdfjs.getDocument()
// call internally and cannot be reached with a synthetic all-pages-fail /
// mixed-fail PDF without constructing genuinely corrupt page content streams
// inside an otherwise-valid document -- not attempted here, per the audit's
// own "do not invent a parallel production path" guidance. The REAL,
// end-to-end customer path IS exercised below for the one case that can be
// built as a real, valid PDF byte buffer: a genuinely valid, zero-text
// document (every page parses, zero words, zero failures).
// ---------------------------------------------------------------------------

test("ALL-PAGES-FAILED must stay generic: parsedPages === 0 fails isNoSelectableTextResult, even though completeness === FAILED", async () => {
  const allFail = await extractPdfTextDocumentWithCompleteness(pdfDoc(["THROW", "THROW"]));
  assert.equal(allFail.completeness, "FAILED");
  assert.equal(allFail.parsedPages, 0);
  assert.equal(allFail.failedPages, 2);
  assert.equal(
    isNoSelectableTextResult(allFail),
    false,
    "every page individually failing to parse is a different, more serious failure than 'this file has no selectable text' — must stay generic",
  );
});

test("MIXED FAILURE + ZERO WORDS must stay generic: failedPages > 0 fails isNoSelectableTextResult, even though completeness === FAILED and some pages parsed", async () => {
  const mixed = await extractPdfTextDocumentWithCompleteness(pdfDoc([[], "THROW", []]));
  assert.equal(mixed.completeness, "FAILED");
  assert.equal(mixed.parsedPages, 2);
  assert.equal(mixed.failedPages, 1);
  assert.equal(mixed.extractedWordCount, 0);
  assert.equal(
    isNoSelectableTextResult(mixed),
    false,
    "a genuine per-page parse failure mixed with blank pages must stay generic — the file's lack of text is not the whole story",
  );
});

test("isNoSelectableTextResult: true only for the exact narrow condition (completeness FAILED, no failures, at least one parsed page, zero words)", () => {
  assert.equal(isNoSelectableTextResult({ completeness: "FAILED", failedPages: 0, parsedPages: 1, extractedWordCount: 0 }), true);
  assert.equal(isNoSelectableTextResult({ completeness: "FAILED", failedPages: 0, parsedPages: 3, extractedWordCount: 0 }), true);
  assert.equal(isNoSelectableTextResult({ completeness: "FAILED", failedPages: 1, parsedPages: 1, extractedWordCount: 0 }), false, "any failed page disqualifies it");
  assert.equal(isNoSelectableTextResult({ completeness: "FAILED", failedPages: 0, parsedPages: 0, extractedWordCount: 0 }), false, "zero parsed pages disqualifies it (degenerate/zero-page edge case)");
  assert.equal(isNoSelectableTextResult({ completeness: "FAILED", failedPages: 0, parsedPages: 1, extractedWordCount: 5 }), false, "any real words disqualifies it");
});

test("isNoSelectableTextResult: SELF-CONTAINED — requires completeness === \"FAILED\" itself, never relying on an outer caller guard", () => {
  // Same failedPages/parsedPages/extractedWordCount shape that would otherwise
  // satisfy the condition, but completeness is NOT "FAILED" -- proves the
  // helper does not trust an outer `if (result.completeness === "FAILED")`
  // check to have already been performed by the caller.
  assert.equal(
    isNoSelectableTextResult({ completeness: "PARTIAL", failedPages: 0, parsedPages: 1, extractedWordCount: 0 }),
    false,
    "a PARTIAL result must never classify as no-selectable-text, even if the other three fields would otherwise match",
  );
  assert.equal(
    isNoSelectableTextResult({ completeness: "COMPLETE", failedPages: 0, parsedPages: 1, extractedWordCount: 0 }),
    false,
    "a COMPLETE result must never classify as no-selectable-text either",
  );
  assert.equal(
    isNoSelectableTextResult({ completeness: "FAILED", failedPages: 0, parsedPages: 1, extractedWordCount: 0 }),
    true,
    "the identical field shape DOES classify once completeness is genuinely FAILED",
  );
});

// ---------------------------------------------------------------------------
// Zero-text safety — a REAL, valid, single-blank-page PDF (no OCR, no
// synthetic mock, and NOT described as "image-only" since no image content
// is actually embedded — this is accurately a valid zero-text PDF) must
// reach the new PdfHasNoSelectableTextError, never MalformedPdfError or
// PasswordProtectedPdfError, and never a bogus successful result.
// ---------------------------------------------------------------------------

function buildMinimalBlankPagePdf() {
  // A real, minimal, valid PDF: one page, zero-length content stream (no
  // text operators at all) -- the smallest real construction that reaches
  // "structurally valid, every page parses, zero extractable words",
  // without needing OCR or any actually-embedded image data to prove the
  // classification boundary. Accurately a zero-text PDF, not an image-only
  // fixture (no image is embedded).
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ];
  let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += obj;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body + xref + trailer, "latin1");
}

test("REAL VALID ZERO-TEXT PDF: a real, valid, single-blank-page PDF (zero extractable text, zero failed pages, at least one parsed page) is classified as PdfHasNoSelectableTextError through the real customer extraction path", async () => {
  const bytes = buildMinimalBlankPagePdf();
  const file = pdfFile("blank.pdf", bytes);
  let resolvedValue;
  let resolved = false;

  await assert.rejects(
    async () => {
      resolvedValue = await extractFileTextWithDiagnostics(file, () => {});
      resolved = true;
    },
    (error) => {
      assert.ok(error instanceof Error, "must reject with a real Error");
      assert.ok(error instanceof PdfHasNoSelectableTextError, "must be an instance of the dedicated app-owned class");
      assert.equal(error.message, "This PDF has no selectable text.", "the error class's OWN message is a short, internal-only string, distinct from the customer-facing UI copy (matching PasswordProtectedPdfError/MalformedPdfError's own established convention) — the UI owns the shown sentence");
      assert.equal(isPdfHasNoSelectableTextError(error), true, "the predicate must classify it as zero-text");
      assert.equal(isMalformedPdfError(error), false, "a valid-but-textless PDF must NEVER be classified as malformed");
      assert.equal(isPasswordProtectedPdfError(error), false, "a valid-but-textless PDF must NEVER be classified as password-protected");
      return true;
    },
  );
  assert.equal(resolved, false, `extraction must reject, never resolve with any text/completeness for a zero-text PDF (got: ${JSON.stringify(resolvedValue)})`);
});

// ---------------------------------------------------------------------------
// Short-but-readable text stays on the SEPARATE, pre-existing downstream
// "< 80 characters" path, never the zero-text extraction-failure path. This
// is a structural/source-text check, made explicit about its own scope:
// extractFileTextWithDiagnostics never even sees an 80-character floor (that
// check lives entirely in app/page.tsx / room-page-shell.tsx, AFTER a
// successful, non-throwing extraction) -- it proves the two paths remain
// textually distinct and correctly ordered in source, not that the runtime
// branch executes end-to-end (a real short-PDF-to-UI round trip would
// require a component-rendering harness this repo does not have).
// ---------------------------------------------------------------------------

const SHORT_TEXT_MESSAGE = "Add at least 80 characters to create a useful report.";

for (const relativePath of ["app/page.tsx", "app/reports/rooms/[room]/room-page-shell.tsx"]) {
  test(`SHORT-TEXT SEPARATION (structural, scope: source order only): ${relativePath} retains the unchanged "${SHORT_TEXT_MESSAGE}" message as a separate check after a successful (non-throwing) extraction, never inside the extraction catch block`, () => {
    const src = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.ok(src.includes(SHORT_TEXT_MESSAGE), "the exact, unchanged short-text message must still be present");
    assert.match(src, /text\.length < 80/, "the 80-character threshold itself must remain unchanged");

    const extractCatchIndex = src.indexOf("catch (error)");
    const shortTextCheckIndex = src.indexOf("text.length < 80");
    assert.ok(extractCatchIndex !== -1 && shortTextCheckIndex !== -1, "sanity: both must exist");
    assert.ok(extractCatchIndex < shortTextCheckIndex, "the short-text check must appear AFTER the extraction catch block in source order — a separate, later check on a successfully-extracted string, not a branch of the extraction-failure classification");
  });
}

// ---------------------------------------------------------------------------
// UI message wiring — structural/source-text, matching this repo's existing
// convention (e.g. tests/corpus-lookup-mandatory.test.mjs's own source-text
// assertions) rather than introducing a component-rendering test framework.
// ---------------------------------------------------------------------------

const PASSWORD_MESSAGE = "This PDF is password-protected. Remove the password and upload it again.";
const MALFORMED_MESSAGE = "We couldn't read this PDF. Try exporting or downloading a fresh copy and uploading it again.";
const ZERO_TEXT_MESSAGE = "This PDF doesn't contain enough selectable text to analyze.";
const GENERIC_MESSAGE = "I could not read that document. Try another file.";

for (const relativePath of ["app/page.tsx", "app/reports/rooms/[room]/room-page-shell.tsx"]) {
  test(`WIRING: ${relativePath} contains all four extraction-failure messages (password, malformed, zero-text, generic), in that priority order, with the generic message retained as the final fallback branch`, () => {
    const src = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

    assert.match(src, /isPasswordProtectedPdfError/, "must use the app-owned password signal, not a raw pdfjs check or message-string match");
    assert.match(src, /isMalformedPdfError/, "must use the app-owned malformed signal, not a raw pdfjs check or message-string match");
    assert.match(src, /isPdfHasNoSelectableTextError/, "must use the app-owned zero-text signal, not diagnostics inspection or message-string match");
    assert.ok(src.includes(PASSWORD_MESSAGE), "must contain the exact password-protected message");
    assert.ok(src.includes(MALFORMED_MESSAGE), "must contain the exact malformed/corrupt message");
    assert.ok(src.includes(ZERO_TEXT_MESSAGE), "must contain the exact zero-text message");
    assert.ok(src.includes(GENERIC_MESSAGE), "must retain the exact existing generic message as the final fallback");
    assert.doesNotMatch(src, /No password given/, "must never match on pdfjs's own raw exception text");
    assert.doesNotMatch(src, /Invalid PDF structure/, "must never match on pdfjs's own raw exception text");

    // Branch priority: password check first, then malformed, then zero-text,
    // then the generic fallback last — enforced by requiring each signal
    // check to appear before the next one in source order.
    const passwordCheckIndex = src.indexOf("isPasswordProtectedPdfError(error)");
    const malformedCheckIndex = src.indexOf("isMalformedPdfError(error)");
    const zeroTextCheckIndex = src.indexOf("isPdfHasNoSelectableTextError(error)");
    const genericMessageIndex = src.indexOf(GENERIC_MESSAGE);
    assert.ok(
      passwordCheckIndex !== -1 && passwordCheckIndex < malformedCheckIndex &&
      malformedCheckIndex < zeroTextCheckIndex && zeroTextCheckIndex < genericMessageIndex,
      "branch priority must be exactly password -> malformed -> zero-text -> generic",
    );

    // The extraction catch block must bind the error (no longer a bare `catch {}`)
    // so it can actually classify it.
    assert.match(src, /catch \(error\)/, "the extraction catch block must bind the error to classify it");

    // Structural ordering (FAKE-SCORE SAFETY): the extraction call's early
    // return must still appear before any matching/scoring call in source
    // order — this patch changed only the notify() branch, never moved the
    // early exit.
    const extractIndex = src.indexOf("extractFileTextWithDiagnostics(");
    const analyzeTextIndex = src.indexOf("await analyzeText(");
    const attachUnifiedIndex = src.indexOf("attachUnifiedSimilarity(");
    assert.ok(extractIndex !== -1 && analyzeTextIndex !== -1, "sanity: both call sites must exist");
    assert.ok(extractIndex < analyzeTextIndex, "extraction (and its early-return catch) must appear before analyzeText() in source order");
    if (attachUnifiedIndex !== -1) {
      assert.ok(extractIndex < attachUnifiedIndex, "extraction must appear before attachUnifiedSimilarity() in source order");
    }
  });
}
