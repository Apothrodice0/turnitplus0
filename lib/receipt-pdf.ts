import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, rgb } from "pdf-lib";
import { similarityScoreBand } from "@/lib/ai-core";
import { formatSimilarityPercent } from "@/lib/report-types";

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
  /** Report-redesign receipt fix: lets the receipt apply the same "<1% for a genuine positive overlap that rounds to 0" display policy the report and screen already use — never changes score/archiveScore themselves. Omitted callers keep the old plain `${score}%` text (no positive-overlap-below-1% case to fix without it). */
  matchedWordCount?: number;
  /** Visual-correction pass: the SAME "Completed" / "Needs attention" search-status text ReportV2Workspace's own toolbar already shows (vm.summary.completion.state), threaded through so the receipt's Final Result card never shows a second, independently-derived completion computation. Omitted (undefined) for a report with no V2 payload at all — there is no "search status" concept for it, so the row is left out entirely rather than guessed. */
  completionStatus?: string;
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

  // Visual-correction pass: restyled from a flat administrative-form list
  // into the same light-card / navy-accent visual language the similarity
  // report's own hero and metric cards use — modern light section cards,
  // one restrained navy accent, muted-gray labels, no heavy dark fill
  // anywhere on the page (the previous solid-navy footer bar is gone).
  const colors = {
    frame: rgb(0.95, 0.96, 0.97), card: rgb(1, 1, 1), border: rgb(0.85, 0.87, 0.89),
    accent: rgb(0.09, 0.24, 0.43), text: rgb(0.13, 0.15, 0.18), label: rgb(0.47, 0.49, 0.52),
    muted: rgb(0.56, 0.58, 0.61), badgeFill: rgb(0.92, 0.95, 0.98),
  };
  // Result-card tone, matching the exact low/moderate/high accents already
  // used across the screen report and PDF (.similarity-heading/.ai-verdict-*
  // in app/globals.css) — reused values, not a new palette.
  const BAND_TONE = {
    low: { text: rgb(0.03, 0.47, 0.65), fill: rgb(0.94, 0.97, 0.99), border: rgb(0.62, 0.81, 0.89) },
    review: { text: rgb(0.59, 0.38, 0), fill: rgb(1, 0.98, 0.91), border: rgb(0.91, 0.78, 0.42) },
    high: { text: rgb(0.7, 0.07, 0.33), fill: rgb(1, 0.95, 0.97), border: rgb(0.94, 0.71, 0.79) },
  } as const;

  const isUnified = Boolean(report.unified);
  const created = report.created ? new Date(report.created) : new Date();
  const resultScore = report.unified ? report.unified.score : (report.archiveScore ?? report.score);
  const resultLabel = report.unified ? report.unified.label : `${report.scoreBand} similarity`;
  const band = similarityScoreBand(resultScore);
  const tone = band ? BAND_TONE[band.key] : BAND_TONE.low;
  const percentText = formatSimilarityPercent(resultScore, report.matchedWordCount ?? 0);

  // Layout bounds fix (unchanged from before this pass): every text draw
  // below is placed and width-capped (fitText/wrapText) against this one
  // content box — CONTENT_RIGHT leaves a 24pt right margin inside the white
  // card, matching the 24pt left margin from the card edge to CONTENT_LEFT.
  const CONTENT_LEFT = 72;
  const CONTENT_RIGHT = 540;
  const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

  page.drawRectangle({ x: 36, y: 36, width: 540, height: 720, color: colors.frame });
  page.drawRectangle({ x: 48, y: 52, width: 516, height: 696, color: colors.card, borderColor: colors.border, borderWidth: 1 });

  // ── header: brand kicker + heading + a restrained status badge ──
  page.drawText("TURNITPLUS", { x: CONTENT_LEFT, y: 716, size: 9, font: bold, color: colors.accent });
  page.drawText("Submission Receipt", { x: CONTENT_LEFT, y: 694, size: 20, font: bold, color: colors.text });

  // Receipt presentation fix: a receipt can only ever be generated for a
  // report that is already fully finalized (both entry points gate the
  // Receipt control behind a completed result), so this function never runs
  // against a still-processing report. Restyled as a compact top-right
  // status pill (light navy-tinted fill, navy border and text) rather than
  // a left-aligned block, so it reads as a corner status the way an
  // invoice's "PAID" stamp does, instead of taking its own full row.
  const badgeLabel = "FINALIZED";
  const badgePaddingX = 12;
  const badgeWidth = bold.widthOfTextAtSize(badgeLabel, 9) + badgePaddingX * 2;
  const badgeX = CONTENT_RIGHT - badgeWidth;
  page.drawRectangle({ x: badgeX, y: 700, width: badgeWidth, height: 22, color: colors.badgeFill, borderColor: colors.accent, borderWidth: 1 });
  page.drawText(badgeLabel, { x: badgeX + badgePaddingX, y: 706.5, size: 9, font: bold, color: colors.accent });

  page.drawRectangle({ x: CONTENT_LEFT, y: 678, width: CONTENT_WIDTH, height: 1, color: colors.border });

  // ── submission title ──
  const titleLines = wrapText(report.title, bold, 14, CONTENT_WIDTH, 2);
  let cursorY = 656;
  titleLines.forEach((line, lineIndex) => {
    page.drawText(line, { x: CONTENT_LEFT, y: cursorY - lineIndex * 18, size: 14, font: bold, color: colors.text });
  });
  cursorY -= titleLines.length * 18 + 34;

  // ── two-column information grid (SUBMISSION / DOCUMENT) ──
  // Visual-correction pass: replaces the old single full-width label:value
  // list (the direct cause of most of the receipt's wasted lower-page
  // space) with the same "compact 2-column information grid" the task
  // itself calls for. Every underlying VALUE below is exactly the same
  // selector/expression the previous flat list used — only the drawn
  // position changes; no field is dropped, relabeled data, or recomputed.
  const COL_GAP = 26;
  const COL_WIDTH = (CONTENT_WIDTH - COL_GAP) / 2;
  const LEFT_X = CONTENT_LEFT;
  const RIGHT_X = CONTENT_LEFT + COL_WIDTH + COL_GAP;
  const LABEL_WIDTH_COL = 84;
  const ROW_LINE_HEIGHT = 13;
  const ROW_GAP = 13;
  const gridTop = cursorY;

  function drawColumnHeading(x: number, y: number, label: string): number {
    page.drawText(label, { x, y, size: 8.5, font: bold, color: colors.accent });
    return y - 17;
  }

  function drawGridRow(x: number, y: number, label: string, value: string, maxLines = 2): number {
    page.drawText(label, { x, y, size: 8, font: regular, color: colors.label });
    const valueWidth = COL_WIDTH - LABEL_WIDTH_COL;
    const lines = wrapText(value, bold, 9.5, valueWidth, maxLines);
    lines.forEach((line, lineIndex) => {
      page.drawText(line, { x: x + LABEL_WIDTH_COL, y: y - lineIndex * ROW_LINE_HEIGHT, size: 9.5, font: bold, color: colors.text });
    });
    return y - lines.length * ROW_LINE_HEIGHT - ROW_GAP;
  }

  let leftY = drawColumnHeading(LEFT_X, gridTop, "SUBMISSION");
  leftY = drawGridRow(LEFT_X, leftY, "Submission ID", report.submissionId ?? "—");
  leftY = drawGridRow(LEFT_X, leftY, "Submitted", created.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }));
  // Receipt presentation fix (report redesign, defect: "Guest submission"
  // shown on new receipts even though report writes now require
  // authentication): report.author is the real, authenticated account
  // identity by construction for every report created from here on (see
  // lib/document-check-pipeline.ts's analyzeText) — "—" is a defensive
  // fallback only, never a fabricated label.
  leftY = drawGridRow(LEFT_X, leftY, "Account", report.author || "—");
  // There is no real assignment concept for a personal similarity check, so
  // this row is omitted entirely (rather than shown with an invented
  // generic value) whenever assignment is genuinely blank/whitespace-only.
  if (report.assignment?.trim()) {
    leftY = drawGridRow(LEFT_X, leftY, "Assignment", report.assignment, 3);
  }

  let rightY = drawColumnHeading(RIGHT_X, gridTop, "DOCUMENT");
  rightY = drawGridRow(RIGHT_X, rightY, "Filename", report.title.replace(/\s+/g, "_"), 3);
  // Explicitly "Original pages" — never to be confused with this receipt's
  // own (always single) page count.
  rightY = drawGridRow(RIGHT_X, rightY, "Original pages", String(report.pageCount ?? Math.max(1, Math.ceil(report.wordCount / 450))));
  rightY = drawGridRow(RIGHT_X, rightY, "Words", report.wordCount.toLocaleString("en-US"));
  rightY = drawGridRow(RIGHT_X, rightY, "Characters", report.characterCount?.toLocaleString("en-US") ?? "—");
  rightY = drawGridRow(RIGHT_X, rightY, "File size", report.fileSize ?? "—");

  cursorY = Math.min(leftY, rightY) - 18;

  // ── final result card ──
  // Visual-correction pass: the report's own authoritative similarity
  // figure, now given the same "hero" prominence (one big tone-colored
  // number in a light accent card) the on-screen workspace and main report
  // surface use — instead of one more small line in the flat list above.
  //
  // Contract locked by tests/receipt-pdf-layout.test.mjs: a text item
  // trimmed to exactly "TurnitPlus Similarity:" must appear exactly once,
  // drawn immediately before a value string that starts with the exact
  // score percent — so the label is kept as its own small caption, drawn
  // right before the large percent value, with nothing drawn in between.
  const CARD_HEIGHT = 158;
  const cardTop = cursorY;
  const cardBottom = cardTop - CARD_HEIGHT;
  page.drawRectangle({ x: 48, y: cardBottom, width: 516, height: CARD_HEIGHT, color: tone.fill, borderColor: tone.border, borderWidth: 1 });
  page.drawText("FINAL RESULT", { x: CONTENT_LEFT, y: cardTop - 24, size: 8.5, font: bold, color: colors.label });
  page.drawText("TurnitPlus Similarity:", { x: CONTENT_LEFT, y: cardTop - 46, size: 9, font: regular, color: colors.label });
  page.drawText(percentText, { x: CONTENT_LEFT, y: cardTop - 108, size: 54, font: bold, color: tone.text });

  const detailX = CONTENT_LEFT + 190;
  let detailY = cardTop - 52;
  // Receipt presentation fix: report.matchedWordCount (when supplied) uses
  // the same authoritative selector the report/screen already use — never a
  // second, competing figure.
  if (typeof report.matchedWordCount === "number") {
    page.drawText(`${report.matchedWordCount.toLocaleString("en-US")} matched words`, { x: detailX, y: detailY, size: 11, font: bold, color: colors.text });
    detailY -= 18;
  }
  page.drawText(resultLabel, { x: detailX, y: detailY, size: 11, font: bold, color: tone.text });
  detailY -= 18;
  // Concise search-status line — the SAME state ReportV2Workspace's own
  // toolbar shows (vm.summary.completion.state), never independently
  // recomputed here; omitted for a report with no V2 payload at all.
  if (report.completionStatus) {
    page.drawText(report.completionStatus, { x: detailX, y: detailY, size: 9.5, font: regular, color: colors.muted });
  }

  cursorY = cardBottom - 28;

  // ── disclaimer ──
  // Layout overflow fix (unchanged mechanism from before this pass): both
  // sentences stay wrapped against CONTENT_WIDTH and capped at 2 lines each.
  //
  // Ordinary-user simplification (unchanged): one neutral, channel-agnostic
  // statement — nothing on the ordinary-user receipt names own reference
  // material, TurnitPlus reference sources, live academic sources,
  // archive/corpus/provider channels, or any other matching method.
  const DISCLAIMER_LINE_HEIGHT = 11;
  const disclaimerHeadlineLines = wrapText(
    "TurnitPlus Similarity reflects matched text identified across the sources checked for this submission.",
    bold, 8, CONTENT_WIDTH, 2,
  );
  disclaimerHeadlineLines.forEach((line, lineIndex) => {
    page.drawText(line, { x: CONTENT_LEFT, y: cursorY - lineIndex * DISCLAIMER_LINE_HEIGHT, size: 8, font: bold, color: colors.text });
  });
  cursorY -= disclaimerHeadlineLines.length * DISCLAIMER_LINE_HEIGHT + 3;
  const disclaimerDetailLines = wrapText("Review the report for the matched passages.", regular, 8, CONTENT_WIDTH, 2);
  disclaimerDetailLines.forEach((line, lineIndex) => {
    page.drawText(line, { x: CONTENT_LEFT, y: cursorY - lineIndex * DISCLAIMER_LINE_HEIGHT, size: 8, font: regular, color: colors.muted });
  });
  cursorY -= disclaimerDetailLines.length * DISCLAIMER_LINE_HEIGHT;

  // ── sign-off ──
  // Visual-correction pass: replaces the previous full-width solid-navy
  // footer bar (the "giant dark footer bar" the task explicitly flagged)
  // with a single thin rule and a small muted caption — same information,
  // no heavy fill block.
  const FOOTER_TOP = 80;
  if (cursorY < FOOTER_TOP) {
    throw new Error("Receipt content overflowed into the footer area — a field's wrap/fit bound needs tightening.");
  }
  page.drawRectangle({ x: CONTENT_LEFT, y: 68, width: CONTENT_WIDTH, height: 1, color: colors.border });
  page.drawText("Generated by TurnitPlus", { x: CONTENT_LEFT, y: 58, size: 8, font: regular, color: colors.muted });

  const bytes = await pdf.save();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: "application/pdf" });
}
