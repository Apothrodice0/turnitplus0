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

function fitText(value: string, font: PDFFont, size: number, maximumWidth: number) {
  const cleanValue = cleanPdfText(value);
  if (font.widthOfTextAtSize(cleanValue, size) <= maximumWidth) return cleanValue;
  let shortened = cleanValue;
  while (shortened.length > 1 && font.widthOfTextAtSize(`${shortened}...`, size) > maximumWidth) shortened = shortened.slice(0, -1);
  return `${shortened}...`;
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
  const colors = {
    frame: rgb(0.94, 0.96, 0.97), white: rgb(1, 1, 1), brand: rgb(0.22, 0.16, 0.55),
    heading: rgb(0.32, 0.19, 0.68), text: rgb(0.12, 0.14, 0.16), label: rgb(0.46, 0.49, 0.51),
    footer: rgb(0.22, 0.16, 0.55), warning: rgb(0.98, 0.91, 0.7),
  };
  const isUnified = Boolean(report.unified);
  const created = report.created ? new Date(report.created) : new Date();

  page.drawRectangle({ x: 36, y: 36, width: 540, height: 720, color: colors.frame });
  page.drawRectangle({ x: 48, y: 52, width: 516, height: 696, color: colors.white });
  page.drawText(isUnified ? "TurnitPlus Similarity Report" : "TurnitPlus Source Overlap Report", { x: 72, y: 716, size: 15, font: bold, color: colors.brand });
  page.drawRectangle({ x: 72, y: 664, width: 244, height: 28, color: colors.warning });
  page.drawText("PROCESSING RECEIPT", { x: 84, y: 673, size: 11, font: bold, color: colors.heading });
  page.drawText("Receipt", { x: 72, y: 620, size: 26, font: regular, color: colors.heading });

  const rows: Array<[string, string]> = [
    ["Submission author", report.author ?? "Guest submission"],
    ["Assignment title", report.assignment ?? "Personal similarity check"],
    ["Submission title", report.title],
    ["File name", report.title.replace(/\s+/g, "_")],
    ["File size", report.fileSize ?? "—"],
    ["Page count", String(report.pageCount ?? Math.max(1, Math.ceil(report.wordCount / 450)))],
    ["Word count", report.wordCount.toLocaleString("en-US")],
    ["Character count", report.characterCount?.toLocaleString("en-US") ?? "—"],
  ];
  if (report.unified) {
    rows.push(["TurnitPlus Similarity", `${report.unified.score}% - ${report.unified.label}`]);
    rows.push(["Evidence sources", report.unified.evidenceSummary]);
    rows.push(["Similarity result (component)", `${report.archiveScore ?? report.score}% - ${report.scoreBand}`]);
  } else {
    rows.push(["Similarity result", `${report.archiveScore ?? report.score}% - ${report.scoreBand} similarity`]);
  }
  rows.push(
    ["Submission date", created.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })],
    ["Submission ID", report.submissionId ?? "—"],
  );

  const rowSpacing = isUnified ? 23 : 25;
  rows.forEach(([label, value], index) => {
    const y = 590 - index * rowSpacing;
    page.drawText(`${label}:`, { x: 105, y, size: 10, font: regular, color: colors.label });
    page.drawText(fitText(value, bold, 10, 310), { x: 225, y, size: 10, font: bold, color: colors.text });
  });

  const disclaimerY = 590 - rows.length * rowSpacing - 5;
  page.drawText(isUnified ? "TurnitPlus Similarity combines identified overlapping passages, live academic sources, and eligible prior submissions." : "The similarity result is based on identified overlapping passages.", { x: 72, y: disclaimerY, size: 8, font: bold, color: colors.text });
  page.drawText("Based on identified overlapping passages and verified academic sources.", { x: 72, y: disclaimerY - 13, size: 8, font: regular, color: colors.label });
  page.drawRectangle({ x: 48, y: 52, width: 516, height: 30, color: colors.footer });
  page.drawText("Generated by TurnitPlus", { x: 72, y: 63, size: 8, font: regular, color: colors.white });

  const bytes = await pdf.save();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: "application/pdf" });
}
