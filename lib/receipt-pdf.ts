import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, rgb } from "pdf-lib";

export type ReceiptData = {
  title: string;
  author?: string;
  assignment?: string;
  created?: string;
  submissionId?: string;
  wordCount: number;
  characterCount?: number;
  pageCount?: number;
  fileSize?: string;
  score: number;
  archiveScore?: number;
  databaseSize?: number;
  scoreBand: string;
  corpusVersion?: string;
  riskStatus?: string;
  riskTarget?: number;
  unified?: {
    score: number;
    label: string;
    evidenceSummary: string;
  };
};

type ReceiptFonts = { regular: Uint8Array; bold: Uint8Array };

function cleanPdfText(value: string) { return value.replace(/\s+/g, " ").trim(); }

/** Single line, ellipsized to fit maximumWidth — never overflows, may lose trailing content. */
function fitText(value: string, font: PDFFont, size: number, maximumWidth: number) {
  const cleanValue = cleanPdfText(value);
  if (font.widthOfTextAtSize(cleanValue, size) <= maximumWidth) return cleanValue;
  let shortened = cleanValue;
  while (shortened.length > 1 && font.widthOfTextAtSize(`${shortened}...`, size) > maximumWidth) shortened = shortened.slice(0, -1);
  return `${shortened}...`;
}

/**
 * Greedy word-wrap, no line count limit — every returned line is guaranteed
 * (by construction, checked against the real embedded font) to be no wider
 * than maximumWidth. A single "word" wider than maximumWidth on its own —
 * confirmed to happen in practice, not just a theoretical edge case: "File
 * name" is built from the submission title with every space replaced by an
 * underscore, so a long title becomes exactly one space-free, unbreakable
 * token — falls back to splitLongWord's character-level split instead of
 * being returned whole, so it can never be the one field that still
 * overflows the page.
 */
function splitLongWord(word: string, font: PDFFont, size: number, maximumWidth: number): string[] {
  const chunks: string[] = [];
  let remaining = word;
  while (remaining.length > 1 && font.widthOfTextAtSize(remaining, size) > maximumWidth) {
    let cut = remaining.length - 1;
    while (cut > 1 && font.widthOfTextAtSize(remaining.slice(0, cut), size) > maximumWidth) cut -= 1;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function wrapLines(value: string, font: PDFFont, size: number, maximumWidth: number): string[] {
  const words = cleanPdfText(value).split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maximumWidth) {
      line = candidate;
      continue;
    }
    if (line) { lines.push(line); line = ""; }
    if (font.widthOfTextAtSize(word, size) <= maximumWidth) {
      line = word;
    } else {
      const chunks = splitLongWord(word, font, size, maximumWidth);
      lines.push(...chunks.slice(0, -1));
      line = chunks[chunks.length - 1] ?? "";
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * Layout overflow fix: wrapLines() alone has no upper bound on how many
 * lines a pathologically long value could produce, which would push
 * whatever is drawn below it (and eventually the fixed-position footer bar)
 * off the bottom of the page — reintroducing the same class of bug as the
 * unbounded single-line disclaimer this fix replaces. Bounded here to
 * maximumLines: the first maximumLines-1 wrapped lines are kept verbatim,
 * and everything remaining is joined back into one string and ellipsized
 * (via fitText) onto the final line, so total height is always
 * deterministic and callers can safely reserve exactly maximumLines *
 * lineHeight of vertical space.
 */
function wrapText(value: string, font: PDFFont, size: number, maximumWidth: number, maximumLines: number): string[] {
  const lines = wrapLines(value, font, size, maximumWidth);
  if (lines.length <= maximumLines) return lines;
  const kept = lines.slice(0, maximumLines - 1);
  const remainder = lines.slice(maximumLines - 1).join(" ");
  kept.push(fitText(remainder, font, size, maximumWidth));
  return kept;
}

async function loadReceiptFonts(): Promise<ReceiptFonts> {
  const [regularResponse, boldResponse] = await Promise.all([fetch("/receipt-font.ttf"), fetch("/receipt-font-bold.ttf")]);
  if (!regularResponse.ok || !boldResponse.ok) throw new Error("Receipt fonts could not be loaded.");
  return { regular: new Uint8Array(await regularResponse.arrayBuffer()), bold: new Uint8Array(await boldResponse.arrayBuffer()) };
}

export async function createReceiptPdf(report: ReceiptData, suppliedFonts?: ReceiptFonts) {
  const fonts = suppliedFonts ?? await loadReceiptFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`TurnitPlus receipt - ${cleanPdfText(report.title)}`);
  pdf.setAuthor("TurnitPlus");
  pdf.setProducer("TurnitPlus");
  pdf.setCreationDate(new Date());

  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });

  // Visual polish: a restrained, professional palette — dark neutral body
  // text, a single subtle navy/blue accent (used sparingly: the title bar,
  // the badge, and one thin rule — never as a large fill color the way the
  // previous purple frame/heading/footer were), and muted gray for labels
  // and borders. Replaces the previous purple-heavy scheme entirely.
  const colors = {
    frame: rgb(0.95, 0.96, 0.97), card: rgb(1, 1, 1), border: rgb(0.85, 0.87, 0.89),
    accent: rgb(0.09, 0.24, 0.43), text: rgb(0.13, 0.15, 0.18), label: rgb(0.47, 0.49, 0.52),
    muted: rgb(0.56, 0.58, 0.61), badgeFill: rgb(0.92, 0.95, 0.98), footer: rgb(0.09, 0.24, 0.43),
    white: rgb(1, 1, 1),
  };
  const isUnified = Boolean(report.unified);
  const created = report.created ? new Date(report.created) : new Date();

  // Layout bounds fix: every text draw below is placed and width-capped
  // (fitText/wrapText) against this one content box, rather than scattered
  // magic-number widths — CONTENT_RIGHT leaves a 24pt right margin inside
  // the white card, matching the 24pt left margin from the card edge to
  // CONTENT_LEFT, so nothing drawn at CONTENT_LEFT can ever reach the card
  // edge, let alone the page edge.
  const CONTENT_LEFT = 72;
  const CONTENT_RIGHT = 540;
  const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
  const LABEL_WIDTH = 150;
  const VALUE_X = CONTENT_LEFT + LABEL_WIDTH;
  const VALUE_WIDTH = CONTENT_RIGHT - VALUE_X;
  const FOOTER_TOP = 82;

  page.drawRectangle({ x: 36, y: 36, width: 540, height: 720, color: colors.frame });
  page.drawRectangle({ x: 48, y: 52, width: 516, height: 696, color: colors.card, borderColor: colors.border, borderWidth: 1 });
  page.drawText(isUnified ? "TurnitPlus Similarity Report" : "TurnitPlus Source Overlap Report", { x: CONTENT_LEFT, y: 716, size: 14, font: bold, color: colors.accent });

  // Receipt presentation fix: a receipt can only ever be generated for a
  // report that is already fully finalized — both entry points
  // (app/reports/rooms/[room]/room-page-shell.tsx's handleDownloadReceipt,
  // components/reports/report-history-row.tsx's own handler) gate the
  // Receipt control itself behind isFullyRevealed (room) / a saved history
  // entry (already-completed by construction), so this function never runs
  // against a report that is still processing — always a finalized result.
  // Restyled as a clean status pill (light navy-tinted fill, navy border and
  // text) rather than the previous warning-yellow box, which read as an
  // alert rather than a normal completed state. Width is measured against
  // the actual label text instead of a fixed guess, so the badge is never
  // needlessly oversized.
  const badgeLabel = "FINAL RECEIPT";
  const badgePaddingX = 14;
  const badgeWidth = bold.widthOfTextAtSize(badgeLabel, 10) + badgePaddingX * 2;
  page.drawRectangle({ x: CONTENT_LEFT, y: 672, width: badgeWidth, height: 24, color: colors.badgeFill, borderColor: colors.accent, borderWidth: 1 });
  page.drawText(badgeLabel, { x: CONTENT_LEFT + badgePaddingX, y: 679, size: 10, font: bold, color: colors.accent });

  page.drawText("Receipt", { x: CONTENT_LEFT, y: 632, size: 22, font: bold, color: colors.text });
  page.drawRectangle({ x: CONTENT_LEFT, y: 620, width: CONTENT_WIDTH, height: 1.5, color: colors.accent });

  const rows: Array<{ label: string; value: string; wrap?: boolean }> = [
    { label: "Submission author", value: report.author ?? "Guest submission" },
    { label: "Assignment title", value: report.assignment ?? "Personal similarity check" },
    { label: "Submission title", value: report.title, wrap: true },
    { label: "File name", value: report.title.replace(/\s+/g, "_"), wrap: true },
    { label: "File size", value: report.fileSize ?? "—" },
    { label: "Page count", value: String(report.pageCount ?? Math.max(1, Math.ceil(report.wordCount / 450))) },
    { label: "Word count", value: report.wordCount.toLocaleString("en-US") },
    { label: "Character count", value: report.characterCount?.toLocaleString("en-US") ?? "—" },
  ];
  if (report.unified) {
    // Receipt presentation fix: report.archiveScore (the archive-only
    // component) used to also be printed here as "Similarity result
    // (component)" — a second, lower number directly beneath the real,
    // authoritative TurnitPlus Similarity figure just above. Both were
    // individually correct, but presenting two different "similarity
    // result"-labeled percentages on one ordinary-user receipt reads as the
    // system contradicting itself. The archive component is not dropped
    // from the product — it stays available exactly where it already was
    // (UnifiedSimilaritySection's own admin-gated breakdown) — only this
    // receipt's second competing headline is removed. Exactly one
    // authoritative similarity result is shown on the receipt, same as the
    // room card and report detail page already show.
    rows.push({ label: "TurnitPlus Similarity", value: `${report.unified.score}% - ${report.unified.label}` });
    // Ordinary-user simplification: the "Evidence sources" row (which
    // channel — own reference material, live academic sources, TurnitPlus
    // reference sources — contributed) is removed entirely. Which specific
    // matching channels/methods produced the result is no longer named
    // anywhere on the ordinary-user receipt at all; report.unified.evidenceSummary
    // is simply not read here any more (still computed/passed by
    // lib/document-check-pipeline.ts's downloadReceipt for now, unused by
    // this function — left as-is per this fix's own "do not change layout
    // architecture" scope, not worth a wider signature change for one
    // dropped read).
  } else {
    // No unified result exists for this report (a legacy/archive-only
    // report predating unified similarity) — archiveScore/score IS the
    // authoritative primary result here (primarySimilarityScore's own
    // fallback rule, mirrored directly since ReceiptData carries the flat
    // fields, not the full selector call). Labeled identically to the
    // unified branch above — "TurnitPlus Similarity," never "Similarity
    // result" — so every receipt shows exactly one similarity row under
    // exactly one label, regardless of which path produced the value.
    rows.push({ label: "TurnitPlus Similarity", value: `${report.archiveScore ?? report.score}% - ${report.scoreBand} similarity` });
  }
  rows.push(
    { label: "Submission date", value: created.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) },
    { label: "Submission ID", value: report.submissionId ?? "—" },
  );

  // Layout overflow fix: rows previously advanced by a fixed spacing per
  // row regardless of content, so a value could only ever render on the
  // single line the fixed spacing assumed — the reason "Evidence sources"
  // had to be silently ellipsized rather than wrapped. This cursor instead
  // advances by however many lines a row actually needs (1 for a plain
  // fitText value, up to 2 for a wrap: true value), so nothing overlaps
  // and nothing needs a fixed line-count guess.
  const LINE_HEIGHT = 13;
  const ROW_GAP = 7;
  let cursorY = 590;
  rows.forEach(({ label, value, wrap }) => {
    page.drawText(`${label}:`, { x: CONTENT_LEFT, y: cursorY, size: 10, font: regular, color: colors.label });
    const lines = wrap ? wrapText(value, bold, 10, VALUE_WIDTH, 2) : [fitText(value, bold, 10, VALUE_WIDTH)];
    lines.forEach((line, lineIndex) => {
      page.drawText(line, { x: VALUE_X, y: cursorY - lineIndex * LINE_HEIGHT, size: 10, font: bold, color: colors.text });
    });
    cursorY -= lines.length * LINE_HEIGHT + ROW_GAP;
  });

  // Layout overflow fix (the reported bug): these two sentences previously
  // rendered as single, unconstrained lines and could run past the right
  // edge of the receipt frame with nothing to catch them. Still wrapped
  // against the same CONTENT_WIDTH every other field respects, capped at 2
  // lines each (comfortably enough for the fixed copy below).
  //
  // Ordinary-user simplification: this disclaimer previously named the
  // specific matching channels ("live academic sources," "TurnitPlus
  // reference sources," "verified academic sources") and differed by
  // isUnified. Replaced with one neutral, channel-agnostic statement, the
  // same regardless of isUnified — nothing on the ordinary-user receipt
  // names own reference material, TurnitPlus reference sources, live
  // academic sources, archive/corpus/provider channels, or any other
  // matching method any more.
  const DISCLAIMER_LINE_HEIGHT = 11;
  cursorY -= 3;
  const disclaimerHeadlineLines = wrapText(
    "TurnitPlus Similarity reflects matched text identified across the sources checked for this submission.",
    bold, 8, CONTENT_WIDTH, 2,
  );
  disclaimerHeadlineLines.forEach((line, lineIndex) => {
    page.drawText(line, { x: CONTENT_LEFT, y: cursorY - lineIndex * DISCLAIMER_LINE_HEIGHT, size: 8, font: bold, color: colors.text });
  });
  cursorY -= disclaimerHeadlineLines.length * DISCLAIMER_LINE_HEIGHT + 2;
  const disclaimerDetailLines = wrapText("Review the report for the matched passages.", regular, 8, CONTENT_WIDTH, 2);
  disclaimerDetailLines.forEach((line, lineIndex) => {
    page.drawText(line, { x: CONTENT_LEFT, y: cursorY - lineIndex * DISCLAIMER_LINE_HEIGHT, size: 8, font: regular, color: colors.muted });
  });
  cursorY -= disclaimerDetailLines.length * DISCLAIMER_LINE_HEIGHT;

  // Layout overflow fix: the footer bar stays fixed at the bottom of the
  // card (matching this receipt's previous, familiar position) rather than
  // trailing the dynamic content cursor — every field above is now capped
  // (wrapText's own maximumLines, or fitText's single-line ellipsis), so
  // the worst-case content height is bounded and never reaches down to
  // FOOTER_TOP; verified directly in tests/receipt-pdf-layout.test.mjs
  // against pathologically long real-world field values, not just assumed.
  if (cursorY < FOOTER_TOP) {
    throw new Error("Receipt content overflowed into the footer area — a field's wrap/fit bound needs tightening.");
  }
  page.drawRectangle({ x: 48, y: 52, width: 516, height: 30, color: colors.footer });
  page.drawText("Generated by TurnitPlus", { x: CONTENT_LEFT, y: 63, size: 8, font: regular, color: colors.white });

  const bytes = await pdf.save();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: "application/pdf" });
}
