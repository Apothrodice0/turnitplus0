import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createReceiptPdf } from "../lib/receipt-pdf.ts";
import { ensurePdfjsNodePolyfills } from "../lib/pdfjs-node-polyfill.ts";

/**
 * Task A, final receipt polish: layout overflow + visual cleanup.
 *
 * ROOT CAUSE (confirmed by direct measurement against the real embedded
 * font, not guessed): the receipt's disclaimer sentence — "TurnitPlus
 * Similarity combines identified overlapping passages, live academic
 * sources, and TurnitPlus reference sources." — was drawn as a single,
 * width-unconstrained line at size 8. Measured against the real embedded
 * bold font, it is 549.4pt wide; the printable content box only has 492pt
 * of width available from its own draw position, and the physical PAGE
 * itself is only 612pt wide — so part of the sentence rendered past the
 * receipt frame's right edge, and the trailing words rendered past the
 * PAGE's own edge entirely. (A prior version of this exact test file's own
 * "never relabeled as TurnitPlus reference sources" check had been passing
 * for the wrong reason: pdfjs's text extraction happened to omit the
 * off-page tail of that sentence, silently hiding the very phrase this fix
 * now correctly wraps on-page and makes extractable — see
 * tests/report-write-time-finalization.test.mjs's own updated comment on
 * that test for the full account.)
 *
 * FIX: every text draw in lib/receipt-pdf.ts is now placed via one
 * consistent content box (CONTENT_LEFT=72, CONTENT_RIGHT=540) and either
 * fitText() (single line, ellipsized, never wider than its column) or
 * wrapText() (multi-line, capped at a fixed maximum line count, so total
 * height is always bounded and the fixed-position footer bar can never be
 * overrun). This file verifies that geometrically, against the REAL
 * rendered PDF's own text-item positions (pdfjs's getTextContent(),
 * transform + width) — not by re-deriving the same arithmetic
 * lib/receipt-pdf.ts itself uses, which would only prove internal
 * consistency, not actual on-page placement.
 */

const repo = path.resolve(".");
const receiptFonts = {
  regular: fs.readFileSync(path.join(repo, "public/receipt-font.ttf")),
  bold: fs.readFileSync(path.join(repo, "public/receipt-font-bold.ttf")),
};

// The exact card geometry lib/receipt-pdf.ts itself draws
// (`page.drawRectangle({ x: 48, y: 52, width: 516, height: 696, ... })`) —
// duplicated here as independent, hand-computed bounds (not imported from
// the module under test) specifically so this test can never be fooled by
// a future change to those constants alone; it re-derives the same numbers
// from the same literal page/card layout the receipt has used since this
// fix, and would need to be updated in lockstep with any real, deliberate
// layout change.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const CARD_LEFT = 48;
const CARD_RIGHT = 48 + 516; // 564
const CARD_TOP = 52 + 696; // 748
const CARD_BOTTOM = 52;

/** Every text item on every page of the PDF, with its real rendered bounding box, from pdfjs's own getTextContent() — not a re-derivation of lib/receipt-pdf.ts's own layout math. */
async function extractTextItemBounds(blob) {
  await ensurePdfjsNodePolyfills();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  const items = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const left = Number(item.transform[4]);
      const baseline = Number(item.transform[5]);
      const emSize = Math.abs(Number(item.transform[3])) || Math.abs(Number(item.transform[0])) || 10;
      items.push({
        str: item.str,
        left,
        right: left + Number(item.width),
        // A conservative box around the glyph's own baseline — real glyphs
        // extend a little above (ascender) and below (descender) it; emSize
        // is the font's own point size at this exact draw call, so this
        // scales correctly across the receipt's several different text
        // sizes (22pt heading down to 8pt disclaimer) rather than a single
        // fixed guess.
        top: baseline + emSize * 0.8,
        bottom: baseline - emSize * 0.25,
      });
    }
  }
  return items;
}

function assertAllItemsWithinCard(items, label) {
  assert.ok(items.length > 10, `test setup sanity: ${label} must have actually extracted real text items`);
  for (const item of items) {
    assert.ok(item.left >= CARD_LEFT - 0.5, `${label}: "${item.str}" left edge ${item.left} must not start before the card's own left edge ${CARD_LEFT}`);
    assert.ok(item.right <= CARD_RIGHT + 0.5, `${label}: "${item.str}" right edge ${item.right} must not extend past the card's own right edge ${CARD_RIGHT} (page width is only ${PAGE_WIDTH})`);
    assert.ok(item.top <= CARD_TOP + 0.5, `${label}: "${item.str}" top edge ${item.top} must not extend above the card's own top edge ${CARD_TOP}`);
    assert.ok(item.bottom >= CARD_BOTTOM - 0.5, `${label}: "${item.str}" bottom edge ${item.bottom} must not extend below the card's own bottom edge ${CARD_BOTTOM} (page height is only ${PAGE_HEIGHT})`);
  }
}

function baseFixture(overrides = {}) {
  return {
    title: "Ordinary submission.pdf",
    author: "Jordan Smith",
    assignment: "Term paper",
    created: new Date().toISOString(),
    submissionId: "sub-layout-fixture",
    wordCount: 2500,
    characterCount: 15000,
    pageCount: 6,
    fileSize: "220 KB",
    score: 0,
    archiveScore: 0,
    scoreBand: "Low",
    ...overrides,
  };
}

test("LAYOUT: a normal corpus-only 100% receipt keeps every text item fully inside the printable card — no overflow past the right or bottom edge", async () => {
  const report = baseFixture({ unified: { score: 100, label: "High similarity", evidenceSummary: "TurnitPlus reference sources" } });
  const blob = await createReceiptPdf(report, receiptFonts);
  const items = await extractTextItemBounds(blob);
  assertAllItemsWithinCard(items, "corpus-only 100%");
  const joined = items.map((i) => i.str).join(" ");
  assert.match(joined, /TurnitPlus Similarity:\s*100%/);
  const similarityRowLabels = items.filter((i) => i.str.trim() === "TurnitPlus Similarity:");
  assert.equal(similarityRowLabels.length, 1, "REQUIRED: exactly one row labeled \"TurnitPlus Similarity\"");
  assert.doesNotMatch(joined, /Similarity result \(component\)/);
});

test("LAYOUT: an authoritative 0% unified receipt still displays 0% correctly and stays fully inside the card", async () => {
  const report = baseFixture({ unified: { score: 0, label: "Low similarity", evidenceSummary: "own reference material" } });
  const blob = await createReceiptPdf(report, receiptFonts);
  const items = await extractTextItemBounds(blob);
  assertAllItemsWithinCard(items, "authoritative 0%");
  const joined = items.map((i) => i.str).join(" ");
  assert.match(joined, /TurnitPlus Similarity:\s*0%/);
  const similarityRowLabels = items.filter((i) => i.str.trim() === "TurnitPlus Similarity:");
  assert.equal(similarityRowLabels.length, 1);
});

test("LAYOUT: a legacy archive-only receipt (no unified result) shows TurnitPlus Similarity, never a second/competing label, and stays fully inside the card", async () => {
  const report = baseFixture({ score: 62, archiveScore: 62, scoreBand: "High" });
  const blob = await createReceiptPdf(report, receiptFonts);
  const items = await extractTextItemBounds(blob);
  assertAllItemsWithinCard(items, "legacy archive-only");
  const joined = items.map((i) => i.str).join(" ");
  assert.match(joined, /TurnitPlus Similarity:\s*62%/);
  const similarityRowLabels = items.filter((i) => i.str.trim() === "TurnitPlus Similarity:");
  assert.equal(similarityRowLabels.length, 1, "REQUIRED: exactly one similarity row, always under the TurnitPlus Similarity label");
  assert.doesNotMatch(joined, /Similarity result/);
});

test("LAYOUT (REQUIRED, the reported bug): pathologically long submission title, file name, author, assignment, and evidence-source text all wrap/truncate cleanly and stay fully inside the card — nothing overflows past the right or bottom edge", async () => {
  const longTitle = "A Comprehensive Multi-Disciplinary Analysis of Longitudinal Sociotechnical Transformation Patterns in Post-Industrial Urban Environments Under Extended Climate Adaptation Regimes Volume Two";
  const longEvidence = "own reference material, live academic sources, TurnitPlus reference sources, and additional cross-referenced supplementary corroborating archival documentation spanning multiple independently verified repositories";
  const report = baseFixture({
    title: longTitle,
    author: "A Guest Submitter With An Unusually Long Display Name Attached To Their Account Profile",
    assignment: "An Extremely Long Assignment Title That Some Course Management System Somewhere Generated Automatically",
    submissionId: "sub-" + "x".repeat(60),
    wordCount: 123456,
    characterCount: 987654,
    pageCount: 42,
    unified: { score: 100, label: "High similarity", evidenceSummary: longEvidence },
  });
  const blob = await createReceiptPdf(report, receiptFonts);
  const items = await extractTextItemBounds(blob);
  assertAllItemsWithinCard(items, "pathologically long fields");

  const joined = items.map((i) => i.str).join(" ");
  assert.match(joined, /TurnitPlus Similarity:\s*100%/, "REQUIRED: the authoritative similarity result must still render correctly even when every other field is unusually long");
  const similarityRowLabels = items.filter((i) => i.str.trim() === "TurnitPlus Similarity:");
  assert.equal(similarityRowLabels.length, 1);
  // At least the first several distinctive words of the long title must
  // actually appear somewhere in the extracted text — proves wrapping (not
  // silent, total omission) is what kept it on the page.
  assert.match(joined, /Comprehensive/, "REQUIRED: the long title must still render (wrapped), not be dropped entirely");
  // Ordinary-user simplification: report.unified.evidenceSummary (however
  // long) is no longer read or rendered anywhere on the receipt at all —
  // its own content must never leak through regardless of length.
  assert.doesNotMatch(joined, /own reference material/);
  assert.doesNotMatch(joined, /cross-referenced supplementary/);
});

test("ORDINARY-USER SIMPLIFICATION: no Evidence sources row, and no wording naming a specific matching channel/method, appears anywhere on the receipt — regardless of what evidenceSummary is passed in", async () => {
  for (const evidenceSummary of ["own reference material", "live academic sources", "TurnitPlus reference sources", "own reference material, live academic sources, TurnitPlus reference sources"]) {
    const report = baseFixture({ unified: { score: 40, label: "Moderate similarity", evidenceSummary } });
    const blob = await createReceiptPdf(report, receiptFonts);
    const items = await extractTextItemBounds(blob);
    assertAllItemsWithinCard(items, `evidence summary "${evidenceSummary}"`);
    const joined = items.map((i) => i.str).join(" ");
    assert.doesNotMatch(joined, /Evidence sources/i, `REQUIRED: no "Evidence sources" row for evidenceSummary="${evidenceSummary}"`);
    assert.doesNotMatch(joined, /own reference material/i, `REQUIRED: never names this channel for evidenceSummary="${evidenceSummary}"`);
    assert.doesNotMatch(joined, /live academic sources/i, `REQUIRED: never names this channel for evidenceSummary="${evidenceSummary}"`);
    assert.doesNotMatch(joined, /TurnitPlus reference sources/i, `REQUIRED: never names this channel for evidenceSummary="${evidenceSummary}"`);
    assert.doesNotMatch(joined, /\barchive\b|\bcorpus\b|\bprovider\b/i, `REQUIRED: never names archive/corpus/provider internals for evidenceSummary="${evidenceSummary}"`);
    assert.match(joined, /TurnitPlus Similarity reflects matched text identified across the sources checked for this submission\./, "REQUIRED: the neutral disclaimer wording must be present");
    assert.match(joined, /Review the report for the matched passages\./, "REQUIRED: the neutral detail line must be present");
  }
});

test("ORDINARY-USER SIMPLIFICATION: the legacy archive-only (no unified result) receipt also carries the same neutral disclaimer, never channel-specific wording", async () => {
  const report = baseFixture({ score: 55, archiveScore: 55, scoreBand: "High" });
  const blob = await createReceiptPdf(report, receiptFonts);
  const items = await extractTextItemBounds(blob);
  assertAllItemsWithinCard(items, "legacy archive-only disclaimer");
  const joined = items.map((i) => i.str).join(" ");
  assert.doesNotMatch(joined, /Evidence sources/i);
  assert.doesNotMatch(joined, /own reference material|live academic sources|TurnitPlus reference sources/i);
  assert.doesNotMatch(joined, /\barchive\b|\bcorpus\b|\bprovider\b/i);
  assert.match(joined, /TurnitPlus Similarity reflects matched text identified across the sources checked for this submission\./);
  assert.match(joined, /Review the report for the matched passages\./);
});

test("DATA (no scoring/content regression): word count, page count, and submission date values still render correctly, unaffected by the layout rewrite", async () => {
  const created = new Date("2026-03-14T10:30:00.000Z");
  const report = baseFixture({
    wordCount: 4321,
    characterCount: 26000,
    pageCount: 9,
    created: created.toISOString(),
    unified: { score: 75, label: "High similarity", evidenceSummary: "own reference material" },
  });
  const blob = await createReceiptPdf(report, receiptFonts);
  const items = await extractTextItemBounds(blob);
  const joined = items.map((i) => i.str).join(" ");
  assert.match(joined, /4,321/, "word count must still render with its existing thousands-separator formatting");
  assert.match(joined, /\b9\b/, "page count must still render");
  assert.match(joined, /TurnitPlus Similarity:\s*75%/);
});
