import type { DocxBlock, DocxDocument, DocxInline } from "@/lib/docx-document";

/**
 * SAVED DOCUMENT LAYOUT (2026-10-21) — the versioned, storable form of a .docx's structure (lib/docx-document.ts),
 * captured in the customer's browser during the original upload and kept privately with their report so the
 * printed report can show the manuscript with its own formatting on any later download, on any device.
 *
 * What is stored: paragraphs, runs and their styles, lists, tables, text boxes and references to the document's
 * images ("media:<n>"), plus a SHA-256 of the report text the layout was verified against. Never the original
 * file. Images travel separately (report_document_media). Shared by the browser (capture, render) and the server
 * (validation), so both read the same format.
 */

export const DOCUMENT_LAYOUT_VERSION = 1;

/** Upper bounds, enforced by the browser before upload and again by the server. */
export const DOCUMENT_LAYOUT_LIMITS = {
  /** serialized layout JSON */
  layoutBytes: 1_500_000,
  /** images per report */
  mediaCount: 24,
  /** one image, after the browser has downscaled it */
  mediaBytes: 1_500_000,
  /** the whole upload request (layout + images) — under Vercel's 4.5 MB request limit */
  requestBytes: 4_000_000,
  /** nesting of tables / text boxes inside each other */
  depth: 6,
} as const;

export const DOCUMENT_LAYOUT_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type StoredDocumentLayout = {
  version: typeof DOCUMENT_LAYOUT_VERSION;
  /** SHA-256 (hex) of report.text when the layout was captured; a different text means the layout is not used */
  textSha256: string;
  layout: DocxDocument["layout"];
  warnings: string[];
  blocks: DocxBlock[];
  /** one entry per stored image, in media_index order; images that could not be stored are absent */
  media: Array<{ index: number; contentType: string }>;
};

export const mediaRef = (index: number) => `media:${index}`;

/** The storable form: image inlines point at "media:<n>" (n = position in `stored`), never at the .docx's own paths. */
export function toStoredDocumentLayout(doc: DocxDocument, textSha256: string, stored: Array<{ path: string; contentType: string }>): StoredDocumentLayout {
  const indexByPath = new Map(stored.map((m, i) => [m.path, i]));
  const mapInline = (i: DocxInline): DocxInline => {
    if (i.kind !== "image") return i;
    const index = indexByPath.get(i.mediaPath);
    return { ...i, mediaPath: index === undefined ? "media:missing" : mediaRef(index) };
  };
  const mapBlocks = (blocks: DocxBlock[]): DocxBlock[] => blocks.map((b) => {
    if (b.kind === "paragraph") return { ...b, inlines: b.inlines.map(mapInline) };
    if (b.kind === "textbox") return { ...b, blocks: mapBlocks(b.blocks) };
    return { ...b, rows: b.rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, blocks: mapBlocks(c.blocks) })) })) };
  });
  return {
    version: DOCUMENT_LAYOUT_VERSION,
    textSha256,
    layout: doc.layout,
    warnings: doc.warnings,
    blocks: mapBlocks(doc.blocks),
    media: stored.map((m, index) => ({ index, contentType: m.contentType })),
  };
}

/** Back to the renderer's model; images are addressed by their "media:<n>" reference. */
export function fromStoredDocumentLayout(stored: StoredDocumentLayout): DocxDocument {
  return { blocks: stored.blocks, layout: stored.layout, media: new Map(), warnings: stored.warnings };
}

// ── validation (server and browser) ──────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown, max = 2000) => typeof v === "string" && v.length <= max;
const optStr = (v: unknown, max = 200) => v === undefined || isStr(v, max);
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";

function validStyle(s: unknown): boolean {
  if (!isObj(s)) return false;
  return optBool(s.bold) && optBool(s.italic) && optBool(s.underline) && optBool(s.strike) && optBool(s.hidden)
    && (s.vertAlign === undefined || s.vertAlign === "superscript" || s.vertAlign === "subscript")
    && (s.sizePt === undefined || (isNum(s.sizePt) && (s.sizePt as number) > 0 && (s.sizePt as number) < 400))
    && optStr(s.font) && optStr(s.csFont)
    && (s.color === undefined || (typeof s.color === "string" && /^#[0-9a-f]{6}$/.test(s.color)));
}

function validInline(i: unknown): boolean {
  if (!isObj(i)) return false;
  if (i.kind === "text") return isStr(i.text, 100_000) && validStyle(i.style);
  if (i.kind === "break") return true;
  if (i.kind === "image") return isStr(i.mediaPath, 40) && /^media:(\d+|missing)$/.test(i.mediaPath as string) && isNum(i.widthPx) && isNum(i.heightPx) && isStr(i.alt, 2000);
  return false;
}

function validBlocks(blocks: unknown, depth: number): boolean {
  if (!Array.isArray(blocks) || depth > DOCUMENT_LAYOUT_LIMITS.depth) return false;
  return blocks.every((b) => {
    if (!isObj(b)) return false;
    if (b.kind === "paragraph") {
      return (b.align === null || ["left", "center", "right", "justify"].includes(b.align as string))
        && typeof b.rtl === "boolean"
        && ["indentLeftPx", "indentRightPx", "firstLinePx", "spaceBeforePx", "spaceAfterPx"].every((k) => isNum(b[k]))
        && (b.lineHeight === null || isNum(b.lineHeight))
        && (b.heading === null || isNum(b.heading))
        && (b.listLabel === null || isStr(b.listLabel, 40))
        && Array.isArray(b.inlines) && b.inlines.every(validInline);
    }
    if (b.kind === "textbox") return typeof b.floating === "boolean" && isNum(b.heightPx) && validBlocks(b.blocks, depth + 1);
    if (b.kind === "table") {
      return typeof b.rtl === "boolean" && typeof b.bordered === "boolean"
        && (b.widthPx === null || isNum(b.widthPx)) && (b.widthPct === null || isNum(b.widthPct))
        && (b.align === null || ["left", "center", "right"].includes(b.align as string))
        && Array.isArray(b.rows) && b.rows.every((r) => isObj(r) && typeof r.header === "boolean" && Array.isArray(r.cells)
          && r.cells.every((c) => isObj(c) && isNum(c.colSpan) && isNum(c.rowSpan)
            && (c.widthPct === null || isNum(c.widthPct))
            && (c.vAlign === null || ["top", "center", "bottom"].includes(c.vAlign as string))
            && (c.borders === null || (isObj(c.borders) && ["top", "bottom", "start", "end"].every((k) => typeof (c.borders as Record<string, unknown>)[k] === "boolean")))
            && validBlocks(c.blocks, depth + 1)));
    }
    return false;
  });
}

/** The stored layout, or null when it is not a well-formed version-1 layout. Never throws. */
export function parseStoredDocumentLayout(value: unknown): StoredDocumentLayout | null {
  try {
    if (!isObj(value) || value.version !== DOCUMENT_LAYOUT_VERSION) return null;
    if (typeof value.textSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.textSha256)) return null;
    const layout = value.layout;
    if (!isObj(layout) || !(layout.contentWidthPx === null || isNum(layout.contentWidthPx)) || !isNum(layout.baseSizePt)) return null;
    if (!Array.isArray(value.warnings) || !value.warnings.every((w) => isStr(w, 200)) || value.warnings.length > 20) return null;
    if (!Array.isArray(value.media) || value.media.length > DOCUMENT_LAYOUT_LIMITS.mediaCount) return null;
    if (!value.media.every((m, i) => isObj(m) && m.index === i && (DOCUMENT_LAYOUT_MEDIA_TYPES as readonly string[]).includes(m.contentType as string))) return null;
    if (!validBlocks(value.blocks, 0)) return null;
    return value as unknown as StoredDocumentLayout;
  } catch {
    return null;
  }
}
