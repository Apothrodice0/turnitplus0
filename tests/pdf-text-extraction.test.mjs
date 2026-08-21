import assert from "node:assert/strict";
import test from "node:test";
import { extractPdfTextDocument } from "../lib/pdf-text-extraction.ts";

test("shared PDF text extraction preserves page order and browser spacing", async () => {
  const progress = [];
  const document = {
    numPages: 2,
    async getPage(pageNumber) {
      return {
        async getTextContent() {
          return pageNumber === 1
            ? { items: [{ str: "First" }, { str: "page" }, { type: "marker" }] }
            : { items: [{ str: "Second" }, { str: "page" }] };
        },
      };
    },
  };

  const text = await extractPdfTextDocument(document, (page, total) => progress.push([page, total]));
  assert.equal(text, "First page \n\nSecond page\n\n");
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
});

// ---------------------------------------------------------------------------
// REGRESSION (Engineering discovery diagnostic, 2026-08-21): a "fi"/"fl"
// ligature glyph rendered from a separate embedded font subset than its
// surrounding text is reported by pdfjs as its own text item with no real
// space on the page — confirmed live against tools/diagnose-engineering-
// discovery.ts's own inspection of the real Frontiers PDF fixture. Test
// items below use the same shape real pdfjs items have (str/width/transform)
// with geometry taken directly from that inspection (scaled to round
// numbers), not invented from the word "configuration" alone.
// ---------------------------------------------------------------------------

/** Builds a pdfjs-shaped text item: starts at x=startX, is `width` points wide, at the given font size (default 10, matching this document's own body text scale). */
function pdfItem(str, startX, width, fontSize = 10) {
  return { str, width, transform: [fontSize, 0, 0, fontSize, startX, 700] };
}

async function extractSinglePage(items) {
  const document = {
    numPages: 1,
    async getPage() {
      return { async getTextContent() { return { items }; } };
    },
  };
  return extractPdfTextDocument(document);
}

test("REGRESSION: reconstructs 'con' + 'fi' + 'guration' -> 'configuration'", async () => {
  const text = await extractSinglePage([
    pdfItem("A review on con", 0, 100),
    pdfItem("fi", 100.02, 8),
    pdfItem("guration", 108.01, 60),
  ]);
  assert.ok(text.includes("A review on configuration"), text);
});

test("REGRESSION: reconstructs 'ef' + 'fi' + 'ciency' -> 'efficiency'", async () => {
  const text = await extractSinglePage([
    pdfItem("of high ef", 0, 60),
    pdfItem("fi", 60.03, 6),
    pdfItem("ciency, economy", 66.02, 90),
  ]);
  assert.ok(text.includes("of high efficiency, economy"), text);
});

test("REGRESSION: reconstructs 'bene' + 'fi' + 'ts' -> 'benefits'", async () => {
  const text = await extractSinglePage([
    pdfItem("its achievable bene", 0, 90),
    pdfItem("fi", 90.01, 5),
    pdfItem("ts need to be realized", 95.04, 120),
  ]);
  assert.ok(text.includes("its achievable benefits need to be realized"), text);
});

test("REGRESSION: reconstructs 'fl' + 'exibility' -> 'flexibility' (two-item case)", async () => {
  const text = await extractSinglePage([
    pdfItem("has numerous devices and", 0, 110), // ends at x=110
    pdfItem("fl", 113, 5), // real ~3pt word-space gap before "flexible" starts
    pdfItem("exible operation", 118.02, 70), // tiny ligature-adjacency gap after "fl"
  ]);
  assert.ok(text.includes("has numerous devices and flexible operation"), text);
});

test("REGRESSION: reconstructs 'diversi' + 'fi' + 'cation' -> 'diversification'", async () => {
  const text = await extractSinglePage([
    pdfItem("highlights the diversi", 0, 95),
    pdfItem("fi", 95.03, 5),
    pdfItem("cation of performance", 100.02, 90),
  ]);
  assert.ok(text.includes("highlights the diversification of performance"), text);
});

test("REGRESSION: a genuinely separate word is never glued, even when it happens to read 'fi' or 'fl'", async () => {
  // Same strings as the ligature cases, but with real inter-word gaps (well
  // past the adjacency tolerance) — must stay space-separated, not merged.
  const text = await extractSinglePage([
    pdfItem("sol", 0, 15),
    pdfItem("fi", 25, 5), // 10pt gap before this item — a real space, not ligature adjacency
    pdfItem("solutions", 40, 40), // 10pt gap after too
  ]);
  assert.equal(text.trim(), "sol fi solutions");
});

test("REGRESSION: legitimate word boundaries between two ordinary words are unaffected", async () => {
  const text = await extractSinglePage([
    pdfItem("Hybrid energy system", 0, 90),
    pdfItem("based on renewable energy", 95, 110),
  ]);
  assert.equal(text.trim(), "Hybrid energy system based on renewable energy");
});

test("REGRESSION (Humanities discovery diagnostic, 2026-08-21): reconstructs a mid-word FONT-SIZE-change wordmark split ('B'+'IBL'+'I'+'NDEX' -> 'BIBLINDEX'), not just fi/fl ligatures", async () => {
  // Geometry taken directly from the real fixture's own measured pdfjs
  // items (page 2, index 9-12): "B" and "I" render at 12pt, "IBL" and
  // "NDEX" render at 9.48pt — a genuine font-size change mid-word, a
  // structurally different corruption than the ligature case, caught by
  // the same geometric-adjacency test rather than any word-specific rule.
  const text = await extractSinglePage([
    pdfItem("B", 70.86, 8.004, 12),
    pdfItem("IBL", 78.84, 15.2723, 9.48),
    pdfItem("I", 94.16, 3.996, 12),
    pdfItem("NDEX", 98.18, 26.326, 9.48),
    pdfItem(" ", 124.506, 3.854, 9.48),
    pdfItem("currently offers a comprehensive inventory", 128.36, 200, 12),
  ]);
  assert.ok(text.includes("BIBLINDEX currently offers a comprehensive inventory"), text);
});

test("REGRESSION: a font-size change alone, with a real gap, is still treated as a genuine word boundary (not every style change is a same-run split)", async () => {
  const text = await extractSinglePage([
    pdfItem("Heading", 0, 40, 14),
    pdfItem("Subtitle text follows", 48, 100, 10), // 8pt real gap at a font-size change — not adjacent
  ]);
  assert.equal(text.trim(), "Heading Subtitle text follows");
});

test("REGRESSION: the end of a wrapped line is never glued to the start of the next line, even though the next line's left edge sits numerically 'before' the previous line's right edge", async () => {
  // Geometry shaped after the real over-merge this exact bug produced:
  // "text reuses" (end of line 1, right edge far out at x~524) followed by
  // "in the BIBLINDEX Project" (start of line 2, back at the left margin,
  // x~71, on a LOWER baseline) — a large NEGATIVE horizontal gap that an
  // unbounded "< tolerance" check wrongly accepted.
  const text = await extractSinglePage([
    { str: "Project council. We present the way", width: 180.356, transform: [12, 0, 0, 12, 344.08, 240.8] },
    { str: "our TEI encoding choices were defined", width: 200, transform: [12, 0, 0, 12, 70.86, 227] },
  ]);
  assert.equal(text.trim(), "Project council. We present the way our TEI encoding choices were defined");
});

test("REGRESSION: a horizontally-adjacent item on a different baseline (e.g. a superscript/footnote marker) is not glued", async () => {
  const text = await extractSinglePage([
    { str: "a result", width: 30, transform: [10, 0, 0, 10, 0, 700] },
    { str: "1", width: 4, transform: [7, 0, 0, 7, 30.01, 705] }, // touches horizontally, but raised baseline
    { str: "shows", width: 25, transform: [10, 0, 0, 10, 34.5, 700] },
  ]);
  assert.equal(text.trim(), "a result 1 shows");
});

test("REGRESSION: items without position data (e.g. a test double, or any pdfjs shape lacking transform/width) fall back to plain space-joining, never throw", async () => {
  const text = await extractSinglePage([
    { str: "con" },
    { str: "fi" },
    { str: "guration" },
  ]);
  assert.equal(text.trim(), "con fi guration");
});
