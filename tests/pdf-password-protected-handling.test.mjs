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
} from "../lib/document-check-pipeline.ts";
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
 * PDF FAILURE SEMANTICS hardening — password-protected AND malformed/corrupt
 * PDFs. Covers the customer-facing gaps found by the read-only PDF-failure
 * audits: pdfjs's own PasswordException and InvalidPDFException were both
 * propagating uncaught out of extractFileTextWithDiagnostics and being
 * discarded by a bare `catch {}` in app/page.tsx / room-page-shell.tsx,
 * collapsing into the same generic "I could not read that document" message
 * shown for every other failure. lib/document-check-pipeline.ts's
 * loadPdfDocument now converts each of those two pdfjs exceptions (identified
 * by stable NAME, reusing the exact idiom lib/corpus-extraction-worker.ts's
 * own isPasswordException already uses for the corpus-ingestion path) into
 * small, distinct app-owned signals — PasswordProtectedPdfError and
 * MalformedPdfError — so both real upload entry points can show a specific,
 * actionable message without ever importing pdfjs-dist themselves or
 * matching on its user-facing text. UnknownErrorException, FormatError, and
 * ResponseException are all deliberately left unconverted (see
 * lib/document-check-pipeline.ts's own header comment on MalformedPdfError
 * for why) and must keep hitting the generic fallback.
 */

const repoRoot = path.resolve(".");

function pdfFile(name, bytes) {
  return new File([bytes], name, { type: "application/pdf" });
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

test("STRUCTURAL: loadPdfDocument (the sole MalformedPdfError conversion site) runs strictly before per-page completeness classification in extractFileTextWithDiagnostics's PDF branch — a per-page failure can never reach the malformed-classification boundary", () => {
  const src = fs.readFileSync(path.join(repoRoot, "lib/document-check-pipeline.ts"), "utf8");
  const loadPdfDocumentCallIndex = src.indexOf("await loadPdfDocument(");
  const completenessCallIndex = src.indexOf("await extractPdfTextDocumentWithCompleteness(");
  assert.ok(loadPdfDocumentCallIndex !== -1 && completenessCallIndex !== -1, "sanity: both call sites must exist");
  assert.ok(loadPdfDocumentCallIndex < completenessCallIndex, "loadPdfDocument must resolve a document before per-page completeness classification ever runs");
});

// ---------------------------------------------------------------------------
// Image-only safety — a REAL, valid, single-blank-page PDF (no OCR, no
// synthetic mock) must reach the pre-existing generic "This file could not
// be read." failure, never MalformedPdfError.
// ---------------------------------------------------------------------------

function buildMinimalBlankPagePdf() {
  // A real, minimal, valid PDF: one page, zero-length content stream (no
  // text operators at all) -- exactly the shape of a genuinely valid
  // image-only/scanned PDF with no selectable text layer, without needing
  // OCR or any image data to prove the point (pdfjs opens it successfully;
  // the absence of any BT/ET text content is what drives extractedWordCount
  // to 0, identically to a real scanned page).
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

test("IMAGE-ONLY SAFETY: a real, valid, single-blank-page PDF (zero extractable text, structurally valid) reaches the pre-existing generic failure, never MalformedPdfError or PasswordProtectedPdfError", async () => {
  const bytes = buildMinimalBlankPagePdf();
  const file = pdfFile("blank.pdf", bytes);

  await assert.rejects(
    () => extractFileTextWithDiagnostics(file, () => {}),
    (error) => {
      assert.ok(error instanceof Error, "must reject with a real Error");
      assert.equal(error.message, "This file could not be read.", "must be the pre-existing generic completeness-FAILED message, unchanged by this task");
      assert.equal(isMalformedPdfError(error), false, "a valid-but-textless PDF must NEVER be classified as malformed — this task must not touch image-only handling");
      assert.equal(isPasswordProtectedPdfError(error), false);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// UI message wiring — structural/source-text, matching this repo's existing
// convention (e.g. tests/corpus-lookup-mandatory.test.mjs's own source-text
// assertions) rather than introducing a component-rendering test framework.
// ---------------------------------------------------------------------------

const PASSWORD_MESSAGE = "This PDF is password-protected. Remove the password and upload it again.";
const MALFORMED_MESSAGE = "We couldn't read this PDF. Try exporting or downloading a fresh copy and uploading it again.";
const GENERIC_MESSAGE = "I could not read that document. Try another file.";

for (const relativePath of ["app/page.tsx", "app/reports/rooms/[room]/room-page-shell.tsx"]) {
  test(`WIRING: ${relativePath} contains all three extraction-failure messages (password, malformed, generic), with the generic message retained as the final fallback branch`, () => {
    const src = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

    assert.match(src, /isPasswordProtectedPdfError/, "must use the app-owned password signal, not a raw pdfjs check or message-string match");
    assert.match(src, /isMalformedPdfError/, "must use the app-owned malformed signal, not a raw pdfjs check or message-string match");
    assert.ok(src.includes(PASSWORD_MESSAGE), "must contain the exact password-protected message");
    assert.ok(src.includes(MALFORMED_MESSAGE), "must contain the exact malformed/corrupt message");
    assert.ok(src.includes(GENERIC_MESSAGE), "must retain the exact existing generic message as the final fallback");
    assert.doesNotMatch(src, /No password given/, "must never match on pdfjs's own raw exception text");
    assert.doesNotMatch(src, /Invalid PDF structure/, "must never match on pdfjs's own raw exception text");

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
