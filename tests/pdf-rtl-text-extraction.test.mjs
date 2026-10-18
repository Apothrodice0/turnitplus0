import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyPdfRtlRepairCounts,
  extractPdfTextDocument,
  hasRtlText,
  orderRtlVisualLines,
  PDF_EXTRACTOR_VERSION,
  repairRtlGlyphOrder,
} from "../lib/pdf-text-extraction.ts";

/**
 * pdf-text-extraction-v1-rtl (ported from the v3 candidate) — the right-to-left repairs, on synthetic pdf.js-shaped pages.
 *
 * Shapes mirror what pdf.js 6.2.108 really returns for a Word-produced Arabic PDF (ASJP pilot,
 * 2026-10-08): glyphs are drawn right to left (operator list order = visual order, left to right on
 * the line), a ligature glyph's Unicode is its logical two-letter string, and getTextContent()
 * reverses each chunk character by character — so the ligature comes out reversed inside itself.
 */

const SHOW_TEXT = 44;
const reverse = (s) => [...s].reverse().join("");
/** An operator list holding one showText per glyph string, in drawing order. */
const operatorList = (...glyphRuns) => ({
  fnArray: glyphRuns.map(() => SHOW_TEXT),
  argsArray: glyphRuns.map((glyphs) => [glyphs.map((unicode) => ({ unicode, width: 500 }))]),
});
/** What pdf.js getTextContent() makes of glyphs drawn in visual order: their strings joined, then reversed by character. */
const pdfjsRtlString = (glyphsInDrawingOrder) => reverse(glyphsInDrawingOrder.join(""));
const item = (str, { x = 0, width = 50, y = 700, em = 12, dir = "rtl", eol = false } = {}) => ({ str, dir, width, height: em, transform: [em, 0, 0, em, x, y], fontName: "g_d0_f1", hasEOL: eol });
const documentOf = (pages) => ({
  numPages: pages.length,
  async getPage(n) {
    const page = pages[n - 1];
    return {
      async getTextContent() { return { items: page.items }; },
      ...(page.ops ? { async getOperatorList() { page.opCalls = (page.opCalls ?? 0) + 1; return page.ops; } } : {}),
    };
  },
});

// "الجمهورية" drawn by Word: the logical word read right to left becomes the drawing order
// ة ي ر و ه م لج ا — with "لج" one ligature glyph whose Unicode is the logical "لج".
const JUMHURIYA_GLYPHS = ["ة", "ي", "ر", "و", "ه", "م", "لج", "ا"];

test("the extractor tag is v1-rtl (v1 + the ported right-to-left repairs)", () => {
  assert.equal(PDF_EXTRACTOR_VERSION, "pdf-text-extraction-v1-rtl");
});

test("pdf.js reverses a ligature glyph inside itself; the glyph-order repair restores the logical word", () => {
  const broken = pdfjsRtlString(JUMHURIYA_GLYPHS);
  assert.equal(broken, "اجلمهورية", "the shape pdf.js 6.2.108 really produces");
  const counts = emptyPdfRtlRepairCounts();
  const [fixed] = repairRtlGlyphOrder([item(broken)], operatorList(JUMHURIYA_GLYPHS), counts);
  assert.equal(fixed.str, "الجمهورية");
  assert.deepEqual(counts, { rtlItems: 1, alignedItems: 1, unalignedItems: 0, repairedGlyphs: 1, rtlLines: 0 });
});

test("two separate glyphs that read like a reversed ligature are NOT touched (alignment uses the real glyph boundaries)", () => {
  // "عمل": meem then lam are two glyphs; drawing order ل م ع; pdf.js output is already correct.
  const glyphs = ["ل", "م", "ع"];
  const str = pdfjsRtlString(glyphs);
  assert.equal(str, "عمل");
  const [out] = repairRtlGlyphOrder([item(str)], operatorList(glyphs), emptyPdfRtlRepairCounts());
  assert.equal(out.str, "عمل");
});

test("an item that cannot be aligned with the page's glyphs is left exactly as pdf.js produced it", () => {
  const counts = emptyPdfRtlRepairCounts();
  const original = item("اجلمهورية");
  const [out] = repairRtlGlyphOrder([original], operatorList(["ب", "ت"]), counts);
  assert.equal(out, original);
  assert.equal(counts.unalignedItems, 1);
});

test("digits inside a right-to-left item keep their place; only the ligature changes", () => {
  // logical "في 2016": drawing order 2 0 1 6 (LTR run) then the ligature glyph "في"
  const str = "يف 2016"; // pdf.js: RTL run reversed char by char, the number kept in order
  const [out] = repairRtlGlyphOrder([item(str)], operatorList(["2", "0", "1", "6", " ", "في"]), emptyPdfRtlRepairCounts());
  assert.equal(out.str, "في 2016");
});

test("Latin-only items are returned as the same objects (byte-identical v1 behaviour)", () => {
  const items = [item("configuration", { dir: "ltr" }), item(" ", { dir: "ltr" })];
  assert.equal(hasRtlText(items), false);
  const out = repairRtlGlyphOrder(items, operatorList(["c"]), emptyPdfRtlRepairCounts());
  assert.ok(out.every((x, i) => x === items[i]));
  assert.deepEqual(orderRtlVisualLines(items, emptyPdfRtlRepairCounts()), items);
});

test("a right-to-left printed line split into two overlapping items reads right to left, with no space inside the split word", async () => {
  // Word draws "أدخل المشرع الجزائري" as two runs, emitted left to right: the left run ("ع الجزائري")
  // first, then the right run ("أدخل المشر"), overlapping by 0.3 em.
  const left = item("ع الجزائري", { x: 100, width: 80, eol: false });
  const right = item("أدخل المشر", { x: 176.4, width: 60, eol: true });
  const text = await extractPdfTextDocument(documentOf([{ items: [left, right] }]));
  assert.equal(text.trim(), "أدخل المشرع الجزائري");
});

test("one item per word, emitted left to right, with no hasEOL between two printed lines: each line reads right to left", async () => {
  // The shape of ASJP 87895 (presentation-form glyphs): pdf.js emits every word and every space as its own item,
  // left to right, and sets no hasEOL where one printed line ends and the next begins.
  const line = (y, words) => {
    const items = [];
    let x = 400;
    for (const w of words) { // logical order; drawn right to left
      const width = 10 * w.length;
      x -= width;
      items.push(item(w, { x, width, y }));
      x -= 3;
      items.push(item(" ", { x, width: 0.2, y, dir: "ltr" }));
    }
    return items.reverse(); // emission order = left to right
  };
  const items = [...line(700, ["ويعتبر", "الاقتصادي"]), ...line(680, ["على", "خلق", "وتدعيم", "ميزة"])];
  items.at(-1).hasEOL = true;
  const text = await extractPdfTextDocument(documentOf([{ items }]));
  assert.equal(text.replace(/\s+/g, " ").trim(), "ويعتبر الاقتصادي على خلق وتدعيم ميزة");
});

test("a real word space between right-to-left runs (gap >= 0.15 em) stays a space", async () => {
  const left = item("الجزائري", { x: 100, width: 50 });
  const right = item("المشرع", { x: 156, width: 40, eol: true }); // 6 pt = 0.5 em gap
  const text = await extractPdfTextDocument(documentOf([{ items: [left, right] }]));
  assert.equal(text.trim(), "المشرع الجزائري");
});

test("end to end: glyph repair and line order together; the operator list is read only on pages with RTL text", async () => {
  const glyphsRight = ["ل", "خ", "د", "أ"]; // "أدخل" drawn right to left: ل خ د أ
  const right = item(pdfjsRtlString(glyphsRight), { x: 200, width: 40, eol: true });
  const leftGlyphs = JUMHURIYA_GLYPHS;
  const left = item(pdfjsRtlString(leftGlyphs), { x: 120, width: 70 });
  const arabicPage = { items: [left, right], ops: operatorList(leftGlyphs, glyphsRight) };
  const latinPage = { items: [item("An English page.", { dir: "ltr", eol: true })], ops: operatorList(["A"]) };
  const text = await extractPdfTextDocument(documentOf([arabicPage, latinPage]));
  assert.equal(text, "أدخل الجمهورية\n\nAn English page.\n\n");
  assert.equal(arabicPage.opCalls, 1);
  assert.equal(latinPage.opCalls, undefined, "no operator list for a page without right-to-left text");
});

test("an operator-list failure skips only the glyph repair; the page is still read", async () => {
  const broken = pdfjsRtlString(JUMHURIYA_GLYPHS);
  const doc = {
    numPages: 1,
    async getPage() {
      return { async getTextContent() { return { items: [item(broken, { eol: true })] }; }, async getOperatorList() { throw new Error("boom"); } };
    },
  };
  assert.equal((await extractPdfTextDocument(doc)).trim(), broken);
});
