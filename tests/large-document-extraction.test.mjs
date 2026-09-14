import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import mammoth from "mammoth";
import JSZip from "jszip";
import {
  extractPdfTextDocument,
  extractPdfTextDocumentWithCompleteness,
} from "../lib/pdf-text-extraction.ts";
import {
  extractDocxTextDocument,
  extractDocxTextDocumentWithCompleteness,
} from "../lib/docx-text-extraction.ts";
import { normalizeExtractedText } from "../lib/extracted-text-normalization.ts";
import { comparisonText } from "../lib/similarity-core.ts";

/**
 * LARGE-DOCUMENT REGRESSION COVERAGE — test-only. Establishes durable
 * proof that the real production extraction path (lib/pdf-text-extraction.ts
 * / lib/docx-text-extraction.ts, feeding lib/extracted-text-normalization.ts
 * and lib/similarity-core.ts's comparisonText reference-list stripper)
 * behaves sanely on realistically LARGE documents, not just the small
 * excerpts most other extraction tests use — and, critically, never
 * produces a fake zero-word "success".
 *
 * PDF uses the existing real committed fixture (tests/fixtures/attention-
 * is-all-you-need.pdf, ~2.2MB / 15 pages / ~5,000+ words) already relied on
 * by tests/pdf-docx-extraction-parity.test.mjs — same load pattern reused
 * here, not reinvented.
 *
 * DOCX has no large committed fixture (the repo's attention-is-all-you-
 * need.docx is a small excerpt only, and the one known ~6.2MB real-world
 * DOCX lives outside the repo as authorized development data, not something
 * to commit). Instead this builds a REAL, valid DOCX zip/OOXML file at test
 * time with JSZip — already a devDependency, and already this exact pattern
 * (tests/docx-text-extraction.test.mjs's buildMinimalDocxWithFootnote,
 * tests/corpus-text-extraction.test.mjs's buildMinimalDocx) — scaled up to
 * ~7,700 words across many real <w:p> paragraphs plus a real Heading1-styled
 * paragraph, then run through the actual extractDocxTextDocument(mammoth.
 * convertToHtml, ...) path. No new dependency, no synthetic string passed
 * directly to normalization/HTML extraction pretending to be "DOCX coverage".
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function wordCount(text) {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

const PDF_PATH = new URL("./fixtures/attention-is-all-you-need.pdf", import.meta.url);

// Memoized so every test() block that needs the large-PDF/large-DOCX metrics
// can await the same real extraction work exactly once, regardless of which
// order node:test happens to run them in — never a second, parallel
// extraction implementation, just a cache around the one real call.
let pdfExtractionPromise = null;
function getPdfExtraction() {
  if (!pdfExtractionPromise) pdfExtractionPromise = computePdfExtraction();
  return pdfExtractionPromise;
}

async function computePdfExtraction() {
  const rawBytes = await readFile(PDF_PATH);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const startedAt = Date.now();
  const document = await pdfjs.getDocument({
    data: new Uint8Array(rawBytes),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;

  const rawText = await extractPdfTextDocument(document);
  const withCompleteness = await extractPdfTextDocumentWithCompleteness(document);
  const elapsedMs = Date.now() - startedAt;

  const normalizedText = normalizeExtractedText(rawText);
  const strippedText = comparisonText(normalizedText);

  return {
    rawBytes: rawBytes.length,
    pageCount: document.numPages,
    rawText,
    rawChars: rawText.length,
    rawWords: wordCount(rawText),
    normalizedText,
    normalizedWords: wordCount(normalizedText),
    strippedWords: wordCount(strippedText),
    withCompleteness,
    elapsedMs,
  };
}

let docxExtractionPromise = null;
function getDocxExtraction() {
  if (!docxExtractionPromise) docxExtractionPromise = computeDocxExtraction();
  return docxExtractionPromise;
}

// A fixed, deterministic pseudo-academic word bank — cycled by index, never
// Math.random(), so the generated DOCX's content (and therefore its exact
// word count) is identical on every run.
const WORD_BANK = [
  "the", "study", "examines", "framework", "results", "indicate", "significant", "correlation", "between", "variables",
  "researchers", "conducted", "analysis", "using", "standard", "methodology", "across", "multiple", "independent", "samples",
  "data", "were", "collected", "from", "several", "sources", "and", "subsequently", "normalized", "before",
  "evaluation", "additional", "experiments", "confirmed", "initial", "observations", "under", "varying", "conditions", "further",
  "discussion", "highlights", "practical", "implications", "for", "future", "work", "in", "related", "domains",
  "overall", "findings", "support", "proposed", "hypothesis", "while", "identifying", "notable", "limitations", "of",
  "approach", "each", "trial", "measured", "response", "over", "time", "with", "controlled", "parameters",
  "comparative", "review", "of", "existing", "literature", "reveals", "consistent", "patterns", "worth", "noting",
];

const DOCX_PARAGRAPH_COUNT = 110;
const DOCX_WORDS_PER_PARAGRAPH = 70;
const DOCX_HEADING_TEXT = "Experimental Results and Discussion";

function buildParagraphText(wordCountForParagraph, seedOffset) {
  const words = [];
  for (let i = 0; i < wordCountForParagraph; i += 1) {
    words.push(WORD_BANK[(seedOffset + i) % WORD_BANK.length]);
  }
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return `${words.join(" ")}.`;
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// Real Word default style names ("heading 1" is the exact built-in style
// name mammoth's own default style map matches against to produce <h1>) —
// enough of a real styles.xml for mammoth to recognize the heading as a
// genuine heading, not just a differently-formatted paragraph.
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`;

function buildDocumentXml(headingText, paragraphs) {
  const headingPara = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${headingText}</w:t></w:r></w:p>`;
  const bodyParas = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}>
  <w:body>
    ${headingPara}
    ${bodyParas}
  </w:body>
</w:document>`;
}

async function buildLargeDocx() {
  const paragraphs = [];
  for (let i = 0; i < DOCX_PARAGRAPH_COUNT; i += 1) {
    paragraphs.push(buildParagraphText(DOCX_WORDS_PER_PARAGRAPH, i * 7));
  }
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", ROOT_RELS_XML);
  zip.file("word/document.xml", buildDocumentXml(DOCX_HEADING_TEXT, paragraphs));
  zip.file("word/_rels/document.xml.rels", DOCUMENT_RELS_XML);
  zip.file("word/styles.xml", STYLES_XML);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function computeDocxExtraction() {
  const buffer = await buildLargeDocx();

  const originalFetch = globalThis.fetch;
  let networkCallAttempted = false;
  globalThis.fetch = (...args) => {
    networkCallAttempted = true;
    throw new Error(`unexpected network call during DOCX extraction: ${String(args[0])}`);
  };

  let rawText;
  let elapsedMs;
  try {
    const startedAt = Date.now();
    rawText = await extractDocxTextDocument(mammoth.convertToHtml, { buffer });
    elapsedMs = Date.now() - startedAt;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rawTextSecondPass = await extractDocxTextDocument(mammoth.convertToHtml, { buffer });
  const withCompleteness = await extractDocxTextDocumentWithCompleteness(mammoth.convertToHtml, { buffer });

  const normalizedText = normalizeExtractedText(rawText);
  const strippedText = comparisonText(normalizedText);

  return {
    generatedBytes: buffer.length,
    rawText,
    rawTextSecondPass,
    rawChars: rawText.length,
    rawWords: wordCount(rawText),
    normalizedText,
    normalizedWords: wordCount(normalizedText),
    strippedWords: wordCount(strippedText),
    withCompleteness,
    networkCallAttempted,
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// 1. LARGE PDF
// ---------------------------------------------------------------------------

test("LARGE PDF: the real 15-page paper fixture extracts substantial, sane, non-garbled text through the real production PDF extraction path", async () => {
  const r = await getPdfExtraction();

  console.log(
    `[large-pdf] bytes=${r.rawBytes} pages=${r.pageCount} chars=${r.rawChars} words=${r.rawWords} ` +
      `normalizedWords=${r.normalizedWords} strippedWords=${r.strippedWords} runtimeMs=${r.elapsedMs}`,
  );

  // --- fixture sanity ---
  assert.ok(r.rawBytes > 1_000_000, `fixture must be > 1MB (actual ${r.rawBytes})`);
  assert.equal(r.pageCount, 15, `expected the known 15-page fixture (actual ${r.pageCount})`);

  // --- extraction completes and produces a meaningful volume of text ---
  assert.ok(r.rawChars > 20_000, `extracted characters should be well over 20,000 (actual ${r.rawChars})`);
  assert.ok(r.rawWords > 4_000, `extracted words should exceed 4,000 (actual ${r.rawWords})`);

  // --- not obviously binary/garbled ---
  const replacementCharCount = (r.rawText.match(/\uFFFD/g) ?? []).length;
  assert.ok(
    replacementCharCount < r.rawText.length * 0.01,
    `extracted text should not be dominated by unicode replacement characters — encoding corruption (count ${replacementCharCount})`,
  );
  const printableRatio = (r.rawText.match(/[ -~\n]/g)?.length ?? 0) / Math.max(r.rawText.length, 1);
  assert.ok(printableRatio > 0.85, `extracted text should be overwhelmingly printable, not garbled binary (ratio ${printableRatio})`);
  assert.match(r.rawText, /Attention Is All You Need/);
  assert.match(r.rawText, /Introduction/);
  assert.match(r.rawText, /References/);

  // --- normalization succeeds and remains substantial ---
  assert.ok(r.normalizedWords > 4_000, `normalized text should remain substantial (actual ${r.normalizedWords} words)`);

  // --- reference stripping does not gut the document ---
  assert.ok(
    r.strippedWords > r.normalizedWords * 0.5,
    `reference-section stripping must not remove the majority of a 15-page paper's body text (normalized=${r.normalizedWords}, stripped=${r.strippedWords})`,
  );
  assert.ok(r.strippedWords > 3_000, `post-reference-strip word count must remain well above a trivial/zero floor (actual ${r.strippedWords})`);

  // --- never a fake zero-word success ---
  assert.equal(
    r.withCompleteness.completeness,
    "COMPLETE",
    `the real production completeness classifier must call this a COMPLETE extraction (got ${r.withCompleteness.completeness})`,
  );
  assert.ok(r.withCompleteness.extractedWordCount > 4_000);
  assert.equal(r.withCompleteness.failedPages, 0);

  // --- generous, non-brittle runtime guard ---
  assert.ok(r.elapsedMs < 30_000, `extraction should complete well under 30s, took ${r.elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// 2. LARGE DOCX (portable, generated)
// ---------------------------------------------------------------------------

test("LARGE DOCX: a real, generated ~7,700-word multi-paragraph DOCX (with a real heading) extracts substantial, sane text through the real production DOCX extraction path", async () => {
  const r = await getDocxExtraction();

  console.log(
    `[large-docx] bytes=${r.generatedBytes} chars=${r.rawChars} words=${r.rawWords} ` +
      `normalizedWords=${r.normalizedWords} strippedWords=${r.strippedWords} runtimeMs=${r.elapsedMs}`,
  );

  // --- the generated file is a real, non-trivial DOCX zip ---
  assert.ok(r.generatedBytes > 10_000, `generated DOCX should be a real, non-trivial zip (actual ${r.generatedBytes} bytes)`);

  // --- extraction succeeds through the real production extractor ---
  assert.ok(r.rawWords > 5_000, `generated DOCX should extract to more than 5,000 words (actual ${r.rawWords})`);
  assert.ok(r.rawWords < 15_000, `sanity: generated DOCX should stay within the intended target range (actual ${r.rawWords})`);
  assert.match(r.rawText, new RegExp(DOCX_HEADING_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the heading text must survive extraction");

  // --- multiple real paragraph boundaries were preserved, not one blob ---
  const paragraphBreaks = (r.rawText.match(/\n/g) ?? []).length;
  assert.ok(paragraphBreaks > 50, `extracted text should preserve many real paragraph boundaries (actual ${paragraphBreaks} newlines)`);

  // --- normalization succeeds and remains substantial ---
  assert.ok(r.normalizedWords > 5_000, `normalized text should remain substantial (actual ${r.normalizedWords} words)`);

  // --- reference stripping does not erase ordinary body text (no reference section present) ---
  assert.ok(
    r.strippedWords > r.normalizedWords * 0.9,
    `reference-section stripping must not remove ordinary body text when no reference section exists (normalized=${r.normalizedWords}, stripped=${r.strippedWords})`,
  );

  // --- never a fake zero-word success ---
  assert.equal(r.withCompleteness.completeness, "COMPLETE", `got ${r.withCompleteness.completeness}`);
  assert.ok(r.withCompleteness.extractedWordCount > 5_000);

  // --- deterministic across repeated extraction of the same generated file ---
  assert.equal(r.rawTextSecondPass, r.rawText, "extracting the identical generated DOCX buffer twice must produce byte-identical text");

  // --- no network/provider calls ---
  assert.equal(r.networkCallAttempted, false, "DOCX extraction must never perform a network call");

  // --- generous, non-brittle runtime guard ---
  assert.ok(r.elapsedMs < 30_000, `DOCX extraction should complete well under 30s, took ${r.elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// 3. OPTIONAL: authorized external 76.docx cross-check (never required for CI)
// ---------------------------------------------------------------------------

test("OPTIONAL CROSS-CHECK: the already-authorized 76.docx development fixture (outside the repo, never copied in), if present locally, is directionally consistent with the portable generated DOCX test", async () => {
  const externalPath = "D:/Github/corps/Corps above 321/76.docx";
  let fileStat;
  try {
    fileStat = await stat(externalPath);
  } catch {
    console.log("[76.docx cross-check] file not present on this machine — skipped cleanly (never required for CI)");
    return;
  }

  const buffer = await readFile(externalPath);
  const startedAt = Date.now();
  const text = await extractDocxTextDocument(mammoth.convertToHtml, { buffer });
  const elapsedMs = Date.now() - startedAt;
  const words = wordCount(text);

  console.log(`[76.docx cross-check] bytes=${fileStat.size} chars=${text.length} words=${words} runtimeMs=${elapsedMs}`);

  // Best-effort directional sanity only (this file is already-authorized,
  // previously-confirmed-working development data, not a fixture this test
  // is responsible for validating from scratch) — genuinely informative if
  // it regresses, since a real ~6.2MB DOCX failing here on a real production
  // path would itself be a production defect worth surfacing.
  assert.ok(words > 1_000, `the authorized cross-check fixture should extract a substantial word count when present (actual ${words})`);
});

// ---------------------------------------------------------------------------
// 4. TRANSPORT SANITY (informational only — does not reopen the closed
//    server-side evidence-compaction problem, just confirms plain manuscript
//    text for these two large documents stays comfortably under the
//    existing 2,000,000-byte report-transport ceiling)
// ---------------------------------------------------------------------------

test("TRANSPORT SANITY (informational): manuscript text alone for both the large PDF and the generated large DOCX stays comfortably under the 2,000,000-byte report-transport ceiling", async () => {
  const [pdf, docx] = await Promise.all([getPdfExtraction(), getDocxExtraction()]);

  const pdfManuscriptBytes = Buffer.byteLength(JSON.stringify({ text: pdf.normalizedText }), "utf8");
  const docxManuscriptBytes = Buffer.byteLength(JSON.stringify({ text: docx.normalizedText }), "utf8");

  console.log(`[transport-sanity] pdfManuscriptBytes=${pdfManuscriptBytes} docxManuscriptBytes=${docxManuscriptBytes}`);

  assert.ok(pdfManuscriptBytes < 2_000_000, `PDF manuscript-only transport bytes should remain under 2,000,000 (actual ${pdfManuscriptBytes})`);
  assert.ok(docxManuscriptBytes < 2_000_000, `DOCX manuscript-only transport bytes should remain under 2,000,000 (actual ${docxManuscriptBytes})`);
});
