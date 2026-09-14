import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  extractFileTextWithDiagnostics,
  isPasswordProtectedPdfError,
  PasswordProtectedPdfError,
} from "../lib/document-check-pipeline.ts";
import { buildMinimalEncryptedPdf } from "./helpers/pdf-fixtures.mjs";
import { ensurePdfjsNodePolyfills } from "../lib/pdfjs-node-polyfill.ts";

// Node-only test-environment requirement (see lib/pdfjs-node-polyfill.ts's own
// header comment): document-check-pipeline.ts's PDF branch imports the
// "main"/browser pdfjs-dist build, which relies on a real browser DOMMatrix
// global and a real Worker to reach real PDF parsing. Neither exists in a
// plain Node test process, so without this polyfill applied first, getDocument()
// fails on an unrelated Node-environment error before ever reaching the real
// encrypted-PDF content this file is actually testing. Production never needs
// this call — app/page.tsx and the room page both run in a real browser.
await ensurePdfjsNodePolyfills();

/**
 * PDF FAILURE SEMANTICS hardening — password-protected PDFs. Covers the
 * customer-facing gap found by the read-only PDF-failure audit: pdfjs's own
 * PasswordException was propagating uncaught out of extractFileTextWithDiagnostics
 * and being discarded by a bare `catch {}` in app/page.tsx / room-page-shell.tsx,
 * collapsing into the same generic "I could not read that document" message
 * shown for every other failure. lib/document-check-pipeline.ts now converts
 * that one pdfjs exception (identified by stable NAME, reusing the exact idiom
 * lib/corpus-extraction-worker.ts's own isPasswordException already uses for the
 * corpus-ingestion path) into a small app-owned PasswordProtectedPdfError, so
 * both real upload entry points can show a specific, actionable message without
 * ever importing pdfjs-dist themselves or matching on its user-facing text.
 */

const repoRoot = path.resolve(".");

function pdfFile(name, bytes) {
  return new File([bytes], name, { type: "application/pdf" });
}

// ---------------------------------------------------------------------------
// REAL encrypted PDF through the real customer extraction path
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
// Classification predicate — unit level
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

// ---------------------------------------------------------------------------
// Malformed PDF stays on the generic fallback (never reclassified as password)
// ---------------------------------------------------------------------------

test("REAL MALFORMED PDF: corrupt/invalid PDF bytes reject through the real extraction path but are NOT classified as password-protected", async () => {
  // Same malformed-bytes shape already used by tests/corpus-text-extraction.test.mjs's
  // own "corrupted PDF bytes" case: a plausible header, no real PDF structure behind it.
  const bytes = Buffer.from("%PDF-1.4\nthis is not real pdf content", "utf8");
  const file = pdfFile("corrupt.pdf", bytes);

  await assert.rejects(
    () => extractFileTextWithDiagnostics(file, () => {}),
    (error) => {
      assert.equal(isPasswordProtectedPdfError(error), false, "a malformed (non-encrypted) PDF must NOT be classified as password-protected");
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
const GENERIC_MESSAGE = "I could not read that document. Try another file.";

for (const relativePath of ["app/page.tsx", "app/reports/rooms/[room]/room-page-shell.tsx"]) {
  test(`WIRING: ${relativePath} contains both the password-protected and generic extraction-failure messages, with the generic message retained as the fallback branch`, () => {
    const src = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

    assert.match(src, /isPasswordProtectedPdfError/, "must use the app-owned password signal, not a raw pdfjs check or message-string match");
    assert.ok(src.includes(PASSWORD_MESSAGE), "must contain the exact password-protected message");
    assert.ok(src.includes(GENERIC_MESSAGE), "must retain the exact existing generic message as the fallback");
    assert.doesNotMatch(src, /No password given/, "must never match on pdfjs's own raw exception text");

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
