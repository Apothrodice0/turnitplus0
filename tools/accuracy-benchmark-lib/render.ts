// Accuracy & Coverage Benchmark — renders composed test text into real PDF
// and DOCX files, then reads them back through the EXACT SAME production
// extraction code the app itself uses (lib/pdf-text-extraction.ts via
// pdfjs-dist, lib/docx-text-extraction.ts via mammoth), so "extraction/word
// count" in the results reflects real extraction fidelity — not this
// generator's own plain-text output.
import fs from "node:fs";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFDocument, rgb } from "pdf-lib";
import { extractDocxTextDocument } from "../../lib/docx-text-extraction";
import { extractTextFromPdfBytes } from "../../lib/e7-asjp-client";

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const FONT_SIZE = 11;
const LINE_HEIGHT = FONT_SIZE * 1.4;
const PARAGRAPH_GAP = LINE_HEIGHT * 0.6;

/**
 * Real academic papers routinely contain Greek letters and math symbols
 * (β, μ, ρ, ∗, ⟨, ≠, ...) that pdf-lib's StandardFonts (WinAnsi encoding)
 * cannot render at all — confirmed live: it threw "WinAnsi cannot encode"
 * and lost every exact-copy PDF case in the first full benchmark run. Reuse
 * the same broad-coverage embedded font + lib/receipt-pdf.ts's own fontkit
 * pattern (read from disk here instead of fetch() — this runs as a plain
 * Node script, not in a browser) rather than lossily substituting ASCII
 * approximations, which would silently change the copied content being
 * measured.
 */
let embeddedFontBytes: Uint8Array | null = null;
function loadEmbeddedFontBytes(): Uint8Array {
  embeddedFontBytes ??= new Uint8Array(fs.readFileSync(path.join(process.cwd(), "public", "receipt-font.ttf")));
  return embeddedFontBytes;
}

export async function writePdf(text: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = await document.embedFont(loadEmbeddedFontBytes(), { subset: true });
  const maxWidth = PAGE_WIDTH - MARGIN * 2;

  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureSpace = () => {
    if (y < MARGIN + LINE_HEIGHT) {
      page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };
  const drawLine = (line: string) => {
    ensureSpace();
    page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0, 0, 0) });
    y -= LINE_HEIGHT;
  };

  const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, FONT_SIZE) > maxWidth && line) {
        drawLine(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) drawLine(line);
    y -= PARAGRAPH_GAP;
  }

  return document.save();
}

export async function extractPdf(bytes: Uint8Array): Promise<string> {
  return extractTextFromPdfBytes(bytes);
}

// ---------------------------------------------------------------------------
// DOCX — a minimal, valid OOXML package (no docx-writing dependency exists
// in this codebase yet; jszip added as a devDependency for this tool only).
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export async function writeDocx(text: string): Promise<Uint8Array> {
  const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const bodyXml = paragraphs
    .map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`)
    .join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.folder("_rels")!.file(".rels", PACKAGE_RELS_XML);
  zip.folder("word")!.file("document.xml", documentXml);
  return zip.generateAsync({ type: "uint8array" });
}

export async function extractDocx(bytes: Uint8Array): Promise<string> {
  return extractDocxTextDocument(
    (input: { buffer: Buffer }) => mammoth.convertToHtml(input),
    { buffer: Buffer.from(bytes) },
  );
}
