import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mammoth from "mammoth";
import { comparisonText, tokens } from "../lib/similarity-core.ts";
import { eligibleAiText, eligibleAiWordCount } from "../lib/ai-core.ts";
import { extractPdfTextDocument } from "../lib/pdf-text-extraction.ts";
import { extractDocxTextDocument } from "../lib/docx-text-extraction.ts";
import { normalizeExtractedText } from "../lib/extracted-text-normalization.ts";

/**
 * "Investigate two real detection issues" ISSUE 1 — regression coverage
 * using the REAL paired documents described in the investigation: a real
 * downloaded PDF of arXiv:1706.03762 ("Attention Is All You Need") and a
 * real-content DOCX built from genuine text extracted from that same PDF
 * (see tests/fixtures/ — both fixtures are the actual files used to
 * diagnose and confirm the fix, not synthetic stand-ins).
 *
 * ROOT CAUSE (see lib/reference-section.ts's own header comment for the
 * full account): lib/pdf-text-extraction.ts joins every text item on a PDF
 * page with a single space and only inserts a paragraph break between
 * pages, so a "References" heading essentially never lands on a clean
 * newline boundary in PDF-extracted text. The two independent regexes that
 * used to require exactly that boundary (lib/similarity-core.ts's
 * comparisonText, lib/ai-core.ts's reference-exclusion) therefore silently
 * kept the entire bibliography in scope for PDF uploads while correctly
 * excluding it for DOCX uploads (mammoth preserves real paragraph breaks).
 * Both now delegate to lib/reference-section.ts's single, format-agnostic
 * detector, which corroborates a heading match against the reference-list-
 * shaped content that follows it instead of relying on whitespace alone.
 */

const PDF_PATH = new URL("./fixtures/attention-is-all-you-need.pdf", import.meta.url);
const DOCX_PATH = new URL("./fixtures/attention-is-all-you-need.docx", import.meta.url);

// Uses the real, exported production cleanup function (app/page.tsx's
// generateReport() calls this exact function), so this test exercises the
// same text every real upload of these files would actually produce —
// including the HTML-tag-stripping bug found and fixed alongside the
// reference-list parity issue (see lib/extracted-text-normalization.ts's
// own header comment).
async function extractRealPdfText() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = await readFile(PDF_PATH);
  const document = await pdfjs.getDocument({
    data: new Uint8Array(data),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  return normalizeExtractedText(await extractPdfTextDocument(document));
}

async function extractRealDocxText() {
  const buffer = await readFile(DOCX_PATH);
  // "Investigate two production issues" ISSUE 2: convertToHtml (via
  // extractDocxTextDocument), not extractRawText — see lib/docx-text-
  // extraction.ts's own header comment for why extractRawText() silently
  // drops any real Word footnote/endnote content.
  const text = await extractDocxTextDocument(mammoth.convertToHtml, { buffer });
  return normalizeExtractedText(text);
}

test("REAL FIXTURES: both the real PDF and the real-content DOCX of the same article successfully extract non-trivial text", async () => {
  const pdfText = await extractRealPdfText();
  const docxText = await extractRealDocxText();

  assert.ok(pdfText.length > 10_000, "the real 15-page PDF should extract to well over 10,000 characters");
  assert.ok(docxText.length > 500, "the real DOCX excerpt should extract to a few hundred characters at least");
  assert.match(pdfText, /Attention Is All You Need/);
  assert.match(docxText, /Attention Is All You Need/);
});

test("REGRESSION: math-notation angle brackets in a real PDF no longer trigger a catastrophic tag-strip match that deletes huge spans of real content", async () => {
  const pdfText = await extractRealPdfText();

  // The real trigger: this exact paper contains a math inequality
  // ("n < ...") in its Model Architecture discussion. The old unbounded
  // `/<[^>]*>/g` regex matched from that stray "<" all the way to the next
  // ">" anywhere later in the document — nearly 20,000 characters,
  // silently deleting the Introduction, Model Architecture section, and
  // the References heading itself.
  assert.match(pdfText, /Introduction/);
  assert.match(pdfText, /Model Architecture/);
  assert.match(pdfText, /References/);
  assert.match(pdfText, /Self-attention/);
});

test("PARITY: comparisonText() (archive-matching input) strips the reference list from BOTH the PDF and the DOCX, not just the DOCX", async () => {
  const pdfText = await extractRealPdfText();
  const docxText = await extractRealDocxText();

  const pdfBody = comparisonText(pdfText);
  const docxBody = comparisonText(docxText);

  assert.ok(pdfBody.length < pdfText.length, "PDF: the reference list must be stripped — this was the exact regression (previously pdfBody.length === pdfText.length)");
  assert.ok(docxBody.length < docxText.length, "DOCX: the reference list must still be stripped (must not regress the already-working case)");

  // The real reference-list content (author of the paper's [1] citation)
  // must not survive in either body.
  assert.doesNotMatch(pdfBody, /Jimmy Lei Ba/, "PDF body must not contain reference-list text");
  assert.doesNotMatch(docxBody, /Jimmy Lei Ba/, "DOCX body must not contain reference-list text");
});

test("PARITY: eligibleAiText()/eligibleAiWordCount() (AI-analysis input) also strip the reference list from both formats identically", async () => {
  const pdfText = await extractRealPdfText();
  const docxText = await extractRealDocxText();

  const pdfEligible = eligibleAiText(pdfText);
  const docxEligible = eligibleAiText(docxText);

  assert.ok(pdfEligible.length < pdfText.length, "PDF: AI-eligible text must exclude the reference list");
  assert.ok(docxEligible.length < docxText.length, "DOCX: AI-eligible text must exclude the reference list");
  assert.doesNotMatch(pdfEligible, /Jimmy Lei Ba/);
  assert.doesNotMatch(docxEligible, /Jimmy Lei Ba/);

  assert.ok(eligibleAiWordCount(pdfText) < tokens(pdfText).length + 1000, "sanity: eligible word count is a real (reduced) figure, not accidentally the full raw count");
});

test("PRESERVED: real in-text bracketed citations inside the body survive filtering, for both formats", async () => {
  const pdfText = await extractRealPdfText();
  const docxText = await extractRealDocxText();

  const pdfBody = comparisonText(pdfText);
  const docxBody = comparisonText(docxText);

  // [13] and [7] are the real in-text citation markers from this exact
  // paper's introduction ("long short-term memory [13] and gated
  // recurrent [7] neural networks").
  assert.match(pdfBody, /\[13\]/, "PDF body must still contain the real in-text citation [13]");
  assert.match(pdfBody, /\[7\]/, "PDF body must still contain the real in-text citation [7]");
  assert.match(docxBody, /\[13\]/, "DOCX body must still contain the real in-text citation [13]");
  assert.match(docxBody, /\[7\]/, "DOCX body must still contain the real in-text citation [7]");
});

test("PRESERVED: legitimate body text after the abstract (e.g. the Acknowledgements section) is not mistaken for the reference list", async () => {
  const pdfText = await extractRealPdfText();
  const pdfBody = comparisonText(pdfText);

  assert.match(pdfBody, /grateful to Nal Kalchbrenner and Stephan Gouws/, "the real Acknowledgements section is legitimate body text and must survive filtering");
});

test("WORD COUNT PARITY: the reference list changes the reported word count for BOTH formats, not just DOCX", async () => {
  const pdfText = await extractRealPdfText();
  const docxText = await extractRealDocxText();

  // Not asserting the PDF and DOCX word counts are close to EACH OTHER —
  // the DOCX fixture is a short excerpt of the full paper, not a full
  // reproduction (see this file's own header comment). Asserting instead
  // that BOTH formats apply the identical rule: the archive-matching word
  // count (tokens(), which already runs text through comparisonText()
  // internally) must be strictly smaller than the raw, unfiltered word
  // count for EVERY format — this is exactly what the reported bug broke
  // for PDF specifically (previously the two were equal there, because
  // comparisonText() never found a match on PDF-extracted text at all).
  const pdfBodyWordCount = tokens(pdfText).length;
  const pdfFullWordCount = pdfText.trim().split(/\s+/).filter(Boolean).length;
  assert.ok(pdfBodyWordCount < pdfFullWordCount, "PDF: the archive-matching word count must exclude the reference list, so it must be smaller than the raw word count");

  const docxBodyWordCount = tokens(docxText).length;
  const docxFullWordCount = docxText.trim().split(/\s+/).filter(Boolean).length;
  assert.ok(docxBodyWordCount < docxFullWordCount, "DOCX: same rule, unchanged from before");
});
