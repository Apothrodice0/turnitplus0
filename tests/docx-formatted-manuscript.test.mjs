/**
 * ORIGINAL FORMATTING (2026-10-21) — the printed report's manuscript drawn from the reader's re-attached .docx:
 * lib/docx-document.ts (structure), lib/docx-manuscript-map.ts (verified placement of highlights),
 * components/report/report-v2/formatted-manuscript.tsx (rendering and the browser-only preparation).
 *
 * A synthetic .docx built here holds every case that matters: centred / justified paragraphs, an Arabic paragraph
 * whose complex-script bold must not leak onto Latin text, numbered and Symbol-font bulleted lists, a table with a
 * column span and a vertical merge, an inline image, a floating text box stored twice (DrawingML + VML fallback)
 * with empty spacer paragraphs under it, hidden text and a line break. Its saved text comes from the upload's own
 * extraction (mammoth -> extractTextFromHtml -> normalizeExtractedText), exactly as a real report's does.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JSZip from "jszip";
import mammoth from "mammoth";
import { DOMParser } from "@xmldom/xmldom";

import { readDocxDocument } from "../lib/docx-document.ts";
import {
  docxParagraphFlatText,
  docxParagraphsInOrder,
  formattedManuscriptReady,
  mapHighlightsOntoDocx,
  reattachedDocxMatchesReport,
} from "../lib/docx-manuscript-map.ts";
import { extractTextFromHtml } from "../lib/html-text-extraction.ts";
import { normalizeExtractedText } from "../lib/extracted-text-normalization.ts";
import { FormattedColumn } from "../components/report/report-v2/formatted-manuscript.tsx";

// ── a synthetic .docx ────────────────────────────────────────────────────
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"';
const run = (text, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (pPr, runs) => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
const cell = (text, tcPr = "") => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${para("", text ? run(text) : "")}</w:tc>`;
const textBoxXml = (inner) => `<w:txbxContent>${inner}</w:txbxContent>`;
const BOX = para('<w:jc w:val="left"/>', `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="3000000" cy="1200000"/><a:graphic><a:graphicData><wps:wsp><wps:txbx>${textBoxXml(para("", run("Boxed abstract sentence that appears once.")))}</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="position:absolute;height:94pt"><v:textbox>${textBoxXml(para("", run("Boxed abstract sentence that appears once.")))}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`);
const IMAGE = para('<w:jc w:val="center"/>', `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Picture 1" descr="Figure one"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`);

const BODY = [
  para('<w:jc w:val="center"/>', run("Centred Title Of The Study", "<w:b/>")),
  para('<w:jc w:val="both"/><w:ind w:firstLine="720"/>', run("Plain words then ") + run("italic words", "<w:i/>") + run(" and ") + run("underlined words", '<w:u w:val="single"/>') + run(" end of paragraph.")),
  para('<w:jc w:val="both"/>', run("Latin text whose complex script bold flag must not apply here.", "<w:bCs/>")),
  para('<w:bidi/><w:jc w:val="both"/>', run("هذه فقرة عربية مكتوبة من اليمين إلى اليسار", "<w:bCs/><w:rtl/>")),
  para('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>', run("First numbered item")),
  para('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>', run("Second numbered item")),
  para('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>', run("A bulleted item")),
  `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders><w:top w:val="single"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>`
    + `<w:tr>${cell("Year")}${cell("2020")}${cell("2021")}</w:tr>`
    + `<w:tr>${cell("Size", '<w:vMerge w:val="restart"/>')}${cell("108.4", '<w:gridSpan w:val="2"/>')}</w:tr>`
    + `<w:tr>${cell("", "<w:vMerge/>")}${cell("227.6")}${cell("134.8")}</w:tr></w:tbl>`,
  IMAGE,
  para("", run("Figure 01: A caption under the image")),
  BOX,
  para("", ""), para("", ""), para("", ""),
  para("", run("After the box comes this paragraph.")),
  para("", run("Line one of a broken paragraph") + "<w:r><w:br/></w:r>" + run("line two of it.")),
  para("", run("Visible words ") + run("hidden words", "<w:vanish/>")),
].join("");

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}>`
  + `<w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>`
  + `<w:abstractNum w:abstractNumId="11"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>`
  + `<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="11"/></w:num></w:numbering>`;
// 1x1 transparent PNG
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));

async function buildDocx(body = BODY) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`);
  zip.file("word/styles.xml", STYLES);
  zip.file("word/numbering.xml", NUMBERING);
  zip.file("word/media/image1.png", PNG);
  return zip.generateAsync({ type: "nodebuffer" });
}

const parseXml = (xml) => new DOMParser().parseFromString(xml, "text/xml");
const savedTextOf = async (buffer) => normalizeExtractedText(extractTextFromHtml((await mammoth.convertToHtml({ buffer })).value));
const strip = (s) => s.replace(/\s+/g, "");

let fixture;
async function load() {
  if (fixture) return fixture;
  const buffer = await buildDocx();
  const doc = await readDocxDocument(await JSZip.loadAsync(buffer), parseXml);
  fixture = { buffer, doc, text: await savedTextOf(buffer) };
  return fixture;
}

// ── structure ────────────────────────────────────────────────────────────
test("STRUCTURE: alignment, indentation, direction, run styles (complex-script bold only on Arabic), lists, table merges, image, text box once, spacers collapsed, hidden text", async () => {
  const { doc } = await load();
  const paras = docxParagraphsInOrder(doc.blocks);
  const byText = (needle) => paras.find((p) => docxParagraphFlatText(p).includes(needle));
  assert.equal(byText("Centred Title").align, "center");
  assert.equal(byText("Centred Title").inlines[0].style.bold, true);
  const justified = byText("Plain words");
  assert.equal(justified.align, "justify");
  assert.ok(justified.firstLinePx > 0, "first-line indent");
  assert.equal(justified.inlines.find((i) => i.text === "italic words").style.italic, true);
  assert.equal(justified.inlines.find((i) => i.text === "underlined words").style.underline, true);
  assert.notEqual(byText("Latin text whose").inlines[0].style.bold, true, "w:bCs does not make Latin text bold");
  const arabic = byText("هذه فقرة");
  assert.equal(arabic.rtl, true);
  assert.equal(arabic.inlines[0].style.bold, true, "w:bCs makes Arabic text bold");
  assert.deepEqual([byText("First numbered").listLabel, byText("Second numbered").listLabel, byText("A bulleted").listLabel], ["1.", "2.", "•"]);
  const table = doc.blocks.find((b) => b.kind === "table");
  assert.equal(table.rows.length, 3);
  assert.equal(table.align, "center");
  assert.equal(table.rows[1].cells[0].rowSpan, 2, "vertical merge");
  assert.equal(table.rows[1].cells[1].colSpan, 2, "column span");
  assert.equal(table.rows[2].cells.length, 2, "the merged cell is not repeated");
  const image = paras.flatMap((p) => p.inlines).find((i) => i.kind === "image");
  assert.equal(image.alt, "Figure one");
  assert.ok(doc.media.has(image.mediaPath), "image bytes read from word/media");
  assert.equal(paras.filter((p) => docxParagraphFlatText(p).includes("Boxed abstract")).length, 1, "a text box stored twice is read once");
  const boxAt = doc.blocks.findIndex((b) => b.kind === "textbox");
  assert.ok(doc.blocks[boxAt].floating);
  assert.ok(docxParagraphFlatText(doc.blocks[boxAt + 1]).includes("After the box"), "empty spacer paragraphs under the floating box are dropped");
  assert.equal(byText("hidden words").inlines.find((i) => i.text === "hidden words").style.hidden, true);
  assert.ok(docxParagraphFlatText(byText("Line one")).includes("\n"), "line break kept");
  assert.deepEqual(doc.warnings, []);
});

// ── verified placement ───────────────────────────────────────────────────
test("MAPPING: every saved line finds its paragraph and every highlight lands on exactly its own characters", async () => {
  const { doc, text } = await load();
  const phrases = ["italic words and underlined", "complex script bold", "عربية مكتوبة", "Second numbered item", "227.6", "Boxed abstract sentence", "Line one of a broken paragraph line two", "hidden words"];
  const highlights = phrases.map((ph) => {
    const flat = text.replace(/\s+/g, " ");
    assert.ok(flat.includes(ph) || text.includes(ph), `fixture text contains ${ph}`);
    const start = text.indexOf(ph) >= 0 ? text.indexOf(ph) : text.indexOf(ph.split(" ")[0]);
    return { start, end: start + (text.indexOf(ph) >= 0 ? ph.length : text.slice(start).indexOf("two") + 3) };
  });
  const map = mapHighlightsOntoDocx(doc, text, highlights);
  assert.equal(map.unmappedLines.length, 0, `unmapped: ${map.unmappedLines}`);
  assert.equal(map.placedHighlights, highlights.length);
  assert.ok(formattedManuscriptReady(map));
  // the characters under each placed mark are the highlight's own characters (whitespace aside)
  const placed = new Map();
  for (const [p, marks] of map.marks) for (const m of marks) placed.set(m.highlight, (placed.get(m.highlight) ?? "") + docxParagraphFlatText(p).slice(m.from, m.to));
  highlights.forEach((h, i) => assert.equal(strip(placed.get(i)), strip(text.slice(h.start, h.end)), `highlight ${i}`));
  // exactly one piece of every highlight carries the source-number badge
  const lasts = new Map();
  for (const marks of map.marks.values()) for (const m of marks) if (m.last) lasts.set(m.highlight, (lasts.get(m.highlight) ?? 0) + 1);
  highlights.forEach((_, i) => assert.equal(lasts.get(i), 1, `badge for highlight ${i}`));
});

test("SAFETY: a different document is refused; a saved line or highlight with no verified place makes the formatted manuscript unavailable", async () => {
  const { buffer, doc, text } = await load();
  assert.equal(await reattachedDocxMatchesReport(() => savedTextOf(buffer), text), true, "the same file matches");
  const other = await buildDocx(BODY.replace("Second numbered item", "Second numbered item, revised"));
  assert.equal(await reattachedDocxMatchesReport(() => savedTextOf(other), text), false, "an edited version is refused");
  assert.equal(await reattachedDocxMatchesReport(async () => { throw new Error("unreadable"); }, text), false);
  const extra = `${text}\nA sentence the document never contained.`;
  const map = mapHighlightsOntoDocx(doc, extra, [{ start: extra.length - 10, end: extra.length }]);
  assert.equal(map.unmappedLines.length, 1);
  assert.equal(map.unplacedHighlights.length, 1);
  assert.equal(formattedManuscriptReady(map), false, "never guesses where unmatched text or evidence goes");
});

// ── rendering ────────────────────────────────────────────────────────────
test("RENDER: the formatted column keeps the document's direction, alignment, table, image and lists, and draws each highlight with its source number", async () => {
  const { doc, text } = await load();
  const start = text.indexOf("227.6");
  const highlights = [{ start, end: start + 5, rank: 3, wikipedia: false, title: "Matched passage" }];
  const map = mapHighlightsOntoDocx(doc, text, highlights);
  const source = { doc, imageUrls: new Map([...doc.media.keys()].map((k) => [k, "blob:fixture"])), map, highlights };
  const html = renderToStaticMarkup(React.createElement(FormattedColumn, { source, slices: doc.blocks.map((_, i) => ({ block: i, kind: "whole" })) }));
  assert.match(html, /dir="rtl"/);
  assert.match(html, /text-align:center/);
  assert.match(html, /<table class="fm-table fm-table-bordered"/);
  assert.match(html, /rowSpan="2"|rowspan="2"/i);
  assert.match(html, /<img class="fm-img"[^>]*src="blob:fixture"/);
  assert.match(html, /<span class="fm-label"[^>]*>1\.<\/span>/);
  assert.match(html, new RegExp(`data-span="${start}-${start + 5}"[^>]*><span[^>]*>227\\.6</span><sup class="spr-mark-n">3</sup>`));
  assert.match(html, /class="fm-textbox"/);
});

// ── privacy and wiring ───────────────────────────────────────────────────
test("PRIVACY + WIRING: parsing and rendering never call the network themselves; the saved layout is used only when every highlight is placed, otherwise the standard manuscript prints", async () => {
  const fm = await readFile(new URL("../components/report/report-v2/formatted-manuscript.tsx", import.meta.url), "utf8");
  const parser = await readFile(new URL("../lib/docx-document.ts", import.meta.url), "utf8");
  for (const [name, src] of [["formatted-manuscript", fm], ["docx-document", parser]]) {
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|sendBeacon|navigator\.sendBeacon/, `${name} sends nothing anywhere`);
  }
  assert.match(fm, /if \(!formattedManuscriptReady\(map\)\) \{[\s\S]*?return null;/, "an unplaceable highlight means the standard manuscript");
  const shell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /type="file"/, "the reader is never asked for a file");
  assert.match(shell, /releaseFormattedManuscript\(current\)/, "image URLs released when the page goes away");
});
