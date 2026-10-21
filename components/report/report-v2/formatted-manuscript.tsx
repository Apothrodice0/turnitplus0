"use client";

import { Fragment, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SimilarityReport } from "@/lib/report-types";
import type { DocxBlock, DocxDocument, DocxInline, DocxParagraph, DocxRunStyle, DocxTable } from "@/lib/docx-document";
import {
  docxParagraphFlatText,
  formattedManuscriptReady,
  mapHighlightsOntoDocx,
  type DocxManuscriptMap,
  type DocxParagraphMark,
} from "@/lib/docx-manuscript-map";
import { PRINT_PALETTE, PRINT_UNRANKED_COLOR, printSourceTone } from "@/lib/similarity-print-layout";
import type { PrintHighlight } from "./print-highlights";

/**
 * FORMATTED MANUSCRIPT (2026-10-21) — page 4 onward of the printed similarity report, drawn from the reader's
 * re-attached original .docx instead of the saved plain text: alignment, indentation, right-to-left paragraphs,
 * headings and run styles, lists, tables (spans and merges) and images, with the report's highlights placed on the
 * exact words they cover (lib/docx-manuscript-map.ts).
 *
 * Everything happens in the reader's browser; the file is never uploaded or stored. Pages are planned by laying
 * the blocks out once in an off-screen layer with the real fonts and images, then cutting only between lines or
 * table rows, so nothing is clipped and every sheet's "Page n of N" is exact.
 */

/** Width of the manuscript column on the printed sheet (the .spr-body content width). */
export const FORMATTED_COLUMN_PX = 688;
/** Kept free at the bottom of every page, so print-time font rendering can never push a line onto a new sheet. */
const PAGE_SAFETY_PX = 26;

export type FormattedManuscriptSource = {
  doc: DocxDocument;
  imageUrls: Map<string, string>;
  map: DocxManuscriptMap;
  highlights: PrintHighlight[];
};

type Slice =
  | { block: number; kind: "whole" }
  | { block: number; kind: "lines"; from: number; to: number; first: boolean; last: boolean }
  | { block: number; kind: "rows"; rows: number[] }
  | { block: number; kind: "box"; children: number[] };

export type FormattedPlan = Slice[][];

// ── geometry ─────────────────────────────────────────────────────────────
/** Word's own proportions, scaled down (never up) to the printed column. */
function geometry(doc: DocxDocument) {
  const width = doc.layout.contentWidthPx ?? FORMATTED_COLUMN_PX;
  const scale = Math.min(1, FORMATTED_COLUMN_PX / width);
  return { scale, columnPx: Math.round(Math.min(FORMATTED_COLUMN_PX, width * scale)), basePt: doc.layout.baseSizePt };
}

function fontFamily(style: DocxRunStyle): string | undefined {
  const names = [style.font, style.csFont].filter((n): n is string => Boolean(n)).map((n) => `"${n.replace(/"/g, "")}"`);
  return names.length ? `${names.join(", ")}, var(--spr-serif)` : undefined;
}

function runCss(style: DocxRunStyle, scale: number, basePt: number): CSSProperties {
  const css: CSSProperties = { fontSize: `${((style.sizePt ?? basePt) * 96 / 72 * scale).toFixed(2)}px` };
  if (style.bold) css.fontWeight = 700;
  if (style.italic) css.fontStyle = "italic";
  const deco = [style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) css.textDecoration = deco;
  if (style.vertAlign) css.verticalAlign = style.vertAlign === "superscript" ? "super" : "sub";
  if (style.vertAlign) css.fontSize = `${((style.sizePt ?? basePt) * 96 / 72 * scale * 0.7).toFixed(2)}px`;
  const family = fontFamily(style);
  if (family) css.fontFamily = family;
  if (style.color) css.color = style.color;
  // text hidden in Word stays visible here (it was analysed), drawn the way Word shows hidden text
  if (style.hidden) {
    css.color = PRINT_PALETTE.muted;
    css.textDecoration = "underline dotted";
  }
  return css;
}

const ALIGN: Record<string, CSSProperties["textAlign"]> = { left: "start", right: "end", center: "center", justify: "justify" };

// ── rendering ────────────────────────────────────────────────────────────
type RenderCtx = { source: FormattedManuscriptSource; scale: number; basePt: number };

function MarkBadge({ highlight }: { highlight: PrintHighlight }) {
  if (highlight.wikipedia) return <sup className="spr-mark-n">W</sup>;
  return highlight.rank !== null ? <sup className="spr-mark-n">{highlight.rank}</sup> : null;
}

/** One paragraph, or the part of it between flat offsets [from, to). `data-f` carries flat offsets for measuring. */
function ParagraphView({ p, ctx, from = 0, to = Infinity, first = true, last = true }: { p: DocxParagraph; ctx: RenderCtx; from?: number; to?: number; first?: boolean; last?: boolean }) {
  const marks = ctx.source.map.marks.get(p) ?? [];
  const pieces: ReactNode[] = [];
  let o = 0;
  p.inlines.forEach((inline: DocxInline, ii) => {
    const len = inline.kind === "text" ? inline.text.length : 1;
    const a = Math.max(o, from);
    const b = Math.min(o + len, to);
    if (a < b) {
      if (inline.kind === "break") pieces.push(<br key={`b${ii}`} data-f={o} />);
      else if (inline.kind === "image") {
        const url = ctx.source.imageUrls.get(inline.mediaPath);
        const w = Math.min(FORMATTED_COLUMN_PX, Math.max(1, inline.widthPx * ctx.scale));
        const h = inline.widthPx > 0 ? (w / inline.widthPx) * inline.heightPx : inline.heightPx * ctx.scale;
        pieces.push(url
          ? <img key={`i${ii}`} className="fm-img" data-f={o} src={url} width={Math.round(w)} height={Math.round(h)} alt={inline.alt || "Figure from the original document"} />
          : <span key={`i${ii}`} className="fm-missing" data-f={o}>[image not available in the file]</span>);
      } else {
        // split the run at highlight edges
        const cuts = new Set([a, b]);
        for (const m of marks) {
          if (m.from > a && m.from < b) cuts.add(m.from);
          if (m.to > a && m.to < b) cuts.add(m.to);
        }
        const edges = [...cuts].sort((x, y) => x - y);
        const css = runCss(inline.style, ctx.scale, ctx.basePt);
        for (let k = 0; k + 1 < edges.length; k += 1) {
          const s = edges[k];
          const e = edges[k + 1];
          const text = inline.text.slice(s - o, e - o);
          const span = <span key={`t${ii}-${s}`} data-f={s} style={css}>{text}</span>;
          const mark = marks.find((m: DocxParagraphMark) => m.from <= s && m.to >= e);
          if (!mark) { pieces.push(span); continue; }
          const h = ctx.source.highlights[mark.highlight];
          const tone = h.rank !== null ? printSourceTone(h.rank) : null;
          const color = h.wikipedia ? PRINT_PALETTE.blue : tone?.color ?? PRINT_UNRANKED_COLOR;
          const line = h.wikipedia ? "dotted" : tone?.line ?? "solid";
          pieces.push(
            <mark key={`m${ii}-${s}`} className={`spr-mark spr-line-${line}`} style={{ "--spr-c": color } as CSSProperties} title={h.title} data-span={`${h.start}-${h.end}`}>
              {span}
              {mark.last && e === mark.to ? <MarkBadge highlight={h} /> : null}
            </mark>,
          );
        }
      }
    }
    o += len;
  });

  const style: CSSProperties = {
    textAlign: p.align ? ALIGN[p.align] : undefined,
    paddingInlineStart: `${(p.indentLeftPx * ctx.scale).toFixed(1)}px`,
    paddingInlineEnd: `${(p.indentRightPx * ctx.scale).toFixed(1)}px`,
    paddingTop: first ? `${(p.spaceBeforePx * ctx.scale).toFixed(1)}px` : 0,
    paddingBottom: last ? `${(p.spaceAfterPx * ctx.scale).toFixed(1)}px` : 0,
    textIndent: first ? `${(p.firstLinePx * ctx.scale).toFixed(1)}px` : 0,
    lineHeight: (p.lineHeight ?? 1) * 1.17,
    fontSize: `${(ctx.basePt * 96 / 72 * ctx.scale).toFixed(2)}px`,
  };
  // a paragraph continued on the next page keeps its justified last line
  if (!last && p.align === "justify") style.textAlignLast = "justify";
  const empty = pieces.length === 0;
  return (
    <p className="fm-p" dir={p.rtl ? "rtl" : "ltr"} style={style} role={p.heading !== null ? "heading" : undefined} aria-level={p.heading !== null ? Math.max(1, p.heading) : undefined}>
      {first && p.listLabel ? <span className="fm-label" aria-hidden="false">{p.listLabel}</span> : null}
      {empty ? " " : pieces}
    </p>
  );
}

const CELL_BORDER = `1px solid ${PRINT_PALETTE.ink}`;

function TableView({ t, ctx, rows }: { t: DocxTable; ctx: RenderCtx; rows?: number[] }) {
  const shown = rows ?? t.rows.map((_, i) => i);
  return (
    <table
      className={`fm-table${t.bordered ? " fm-table-bordered" : ""}`}
      dir={t.rtl ? "rtl" : "ltr"}
      style={{
        width: t.widthPct ? `${Math.min(100, t.widthPct)}%` : t.widthPx ? `${Math.min(FORMATTED_COLUMN_PX, t.widthPx * ctx.scale).toFixed(0)}px` : "100%",
        marginInline: t.align === "center" ? "auto" : t.align === "right" ? "auto 0" : undefined,
      }}
    >
      <tbody>
        {shown.map((ri) => (
          <tr key={ri} data-fm-row={ri}>
            {t.rows[ri].cells.map((cell, ci) => (
              <td key={ci} colSpan={cell.colSpan > 1 ? cell.colSpan : undefined} rowSpan={cell.rowSpan > 1 ? Math.min(cell.rowSpan, shown.length - shown.indexOf(ri)) : undefined}
                style={{
                  verticalAlign: cell.vAlign === "center" ? "middle" : cell.vAlign ?? "top",
                  width: cell.widthPct ? `${cell.widthPct}%` : undefined,
                  // borders the cell draws itself, when the table draws none
                  ...(!t.bordered && cell.borders ? {
                    borderTop: cell.borders.top ? CELL_BORDER : undefined,
                    borderBottom: cell.borders.bottom ? CELL_BORDER : undefined,
                    borderInlineStart: cell.borders.start ? CELL_BORDER : undefined,
                    borderInlineEnd: cell.borders.end ? CELL_BORDER : undefined,
                  } : {}),
                }}>
                {cell.blocks.map((b, bi) => <BlockView key={bi} block={b} ctx={ctx} />)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BlockView({ block, ctx, childIndexes }: { block: DocxBlock; ctx: RenderCtx; childIndexes?: number[] }) {
  if (block.kind === "paragraph") return <ParagraphView p={block} ctx={ctx} />;
  if (block.kind === "table") return <TableView t={block} ctx={ctx} />;
  const shown = childIndexes ?? block.blocks.map((_, i) => i);
  return (
    <div className="fm-textbox">
      {shown.map((i) => <div key={i} data-fm-child={i}><BlockView block={block.blocks[i]} ctx={ctx} /></div>)}
    </div>
  );
}

function SliceView({ slice, ctx }: { slice: Slice; ctx: RenderCtx }) {
  const block = ctx.source.doc.blocks[slice.block];
  if (slice.kind === "lines" && block.kind === "paragraph") {
    return <ParagraphView p={block} ctx={ctx} from={slice.from} to={slice.to} first={slice.first} last={slice.last} />;
  }
  if (slice.kind === "rows" && block.kind === "table") return <TableView t={block} ctx={ctx} rows={slice.rows} />;
  if (slice.kind === "box" && block.kind === "textbox") return <BlockView block={block} ctx={ctx} childIndexes={slice.children} />;
  return <BlockView block={block} ctx={ctx} />;
}

export function FormattedColumn({ source, slices }: { source: FormattedManuscriptSource; slices: Slice[] }) {
  const g = geometry(source.doc);
  const ctx: RenderCtx = { source, scale: g.scale, basePt: g.basePt };
  return (
    <div className="fm-column" style={{ width: g.columnPx }}>
      {slices.map((s, i) => <Fragment key={i}><SliceView slice={s} ctx={ctx} /></Fragment>)}
    </div>
  );
}

// ── page planning ────────────────────────────────────────────────────────
type Line = { flat: number; top: number; bottom: number };

/** The paragraph's rendered lines, from the positions of its words (data-f carries each piece's flat offset). */
function measureLines(el: HTMLElement): Line[] {
  const points: Array<{ flat: number; top: number; bottom: number }> = [];
  el.querySelectorAll<HTMLElement>("[data-f]").forEach((node) => {
    const base = Number(node.dataset.f);
    if (node.tagName === "IMG" || node.tagName === "BR" || node.classList.contains("fm-missing")) {
      const r = node.getBoundingClientRect();
      if (r.height > 0) points.push({ flat: base, top: r.top, bottom: r.bottom });
      return;
    }
    const text = node.firstChild;
    if (!text || text.nodeType !== 3) return;
    const value = text.textContent ?? "";
    const range = document.createRange();
    for (let i = 0; i < value.length; i += 1) {
      if (/\s/.test(value[i]) || (i > 0 && !/\s/.test(value[i - 1]))) continue;
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const r = range.getClientRects()[0];
      if (r) points.push({ flat: base + i, top: r.top, bottom: r.bottom });
    }
  });
  points.sort((a, b) => a.flat - b.flat);
  const lines: Line[] = [];
  for (const pt of points) {
    const cur = lines[lines.length - 1];
    if (cur && pt.top < cur.bottom - 2) {
      cur.top = Math.min(cur.top, pt.top);
      cur.bottom = Math.max(cur.bottom, pt.bottom);
    } else lines.push({ ...pt });
  }
  return lines;
}

function isHeadingLike(p: DocxParagraph): boolean {
  if (p.heading !== null) return true;
  const texts = p.inlines.filter((i) => i.kind === "text") as Array<Extract<DocxInline, { kind: "text" }>>;
  const chars = texts.reduce((n, t) => n + t.text.trim().length, 0);
  return chars > 0 && chars < 140 && texts.every((t) => !t.text.trim() || t.style.bold);
}

/** Cuts the measured blocks into pages: whole blocks where they fit, otherwise between lines or table rows. */
function planPages(layer: HTMLElement, source: FormattedManuscriptSource, firstAvail: number, restAvail: number): FormattedPlan {
  const blocks = source.doc.blocks;
  const els = [...layer.querySelectorAll<HTMLElement>(":scope .fm-column > [data-fm-block]")];
  const pages: FormattedPlan = [[]];
  let remaining = firstAvail - PAGE_SAFETY_PX;
  const newPage = () => {
    pages.push([]);
    remaining = restAvail - PAGE_SAFETY_PX;
  };
  const pageEmpty = () => pages[pages.length - 1].length === 0;
  const height = (el: HTMLElement) => el.getBoundingClientRect().height;

  els.forEach((el, i) => {
    const block = blocks[i];
    const h = height(el);
    if (h <= remaining) {
      // a heading-like paragraph never ends a page on its own
      const next = els[i + 1];
      if (block.kind === "paragraph" && isHeadingLike(block) && next && !pageEmpty()) {
        const nb = blocks[i + 1];
        const nextFirst = nb.kind === "paragraph" ? (measureLines(next.querySelector("p") as HTMLElement)[0]?.bottom ?? next.getBoundingClientRect().top + 24) - next.getBoundingClientRect().top : Math.min(height(next), 60);
        if (h + nextFirst > remaining) newPage();
      }
      pages[pages.length - 1].push({ block: i, kind: "whole" });
      remaining -= h;
      return;
    }
    if (block.kind === "paragraph") {
      const p = el.querySelector("p") as HTMLElement;
      const box = p.getBoundingClientRect();
      const lines = measureLines(p);
      const flatLen = docxParagraphFlatText(block).length;
      if (lines.length < 2) {
        if (!pageEmpty()) newPage();
        pages[pages.length - 1].push({ block: i, kind: "whole" });
        remaining -= h;
        return;
      }
      let a = 0;
      while (a < lines.length) {
        const top = a === 0 ? box.top : lines[a].top;
        let b = a;
        while (b < lines.length && (b + 1 === lines.length ? box.bottom : lines[b + 1].top) - top <= remaining) b += 1;
        // keep at least two lines together at a page bottom; otherwise start the paragraph on the next page
        if ((b === a || (a === 0 && b === 1 && lines.length > 2)) && !pageEmpty()) {
          newPage();
          continue;
        }
        if (b === a) b = a + 1;
        const end = b >= lines.length;
        const bottom = end ? box.bottom : lines[b].top;
        pages[pages.length - 1].push({ block: i, kind: "lines", from: a === 0 ? 0 : lines[a].flat, to: end ? flatLen : lines[b].flat, first: a === 0, last: end });
        remaining -= bottom - top;
        if (!end) newPage();
        a = b;
      }
      return;
    }
    if (block.kind === "table") {
      const rowH = [...el.querySelectorAll<HTMLTableRowElement>("tr[data-fm-row]")].map(height);
      // leading rows marked "repeat as header row" in Word are repeated on every page the table continues to
      const headerRows: number[] = [];
      for (let r = 0; r < block.rows.length && block.rows[r].header; r += 1) headerRows.push(r);
      const headerH = headerRows.reduce((s, ri) => s + rowH[ri], 0);
      // rows bound together by a vertical merge move as one group
      const groups: number[][] = [];
      for (let r = 0; r < block.rows.length; ) {
        let end = r;
        for (let k = r; k <= end; k += 1) for (const c of block.rows[k].cells) end = Math.max(end, k + c.rowSpan - 1);
        end = Math.min(end, block.rows.length - 1);
        groups.push(Array.from({ length: end - r + 1 }, (_, x) => r + x));
        r = end + 1;
      }
      let current: number[] = [];
      for (const group of groups) {
        const gh = group.reduce((s, ri) => s + rowH[ri], 0);
        if (gh > remaining && (current.length > 0 || !pageEmpty())) {
          if (current.length) pages[pages.length - 1].push({ block: i, kind: "rows", rows: current });
          newPage();
          current = headerRows.filter((ri) => !group.includes(ri));
          remaining -= current.length ? headerH : 0;
        }
        current.push(...group);
        remaining -= gh;
      }
      if (current.length) pages[pages.length - 1].push({ block: i, kind: "rows", rows: current });
      return;
    }
    // a text box that does not fit: continues on the next page between its own paragraphs, each part keeping the
    // box's border and padding
    const kidsEls = [...el.querySelectorAll<HTMLElement>(":scope > .fm-textbox > [data-fm-child]")];
    const kidH = kidsEls.map(height);
    const chrome = Math.max(0, h - kidH.reduce((s, x) => s + x, 0));
    let part: number[] = [];
    let used = chrome;
    kidH.forEach((kh, k) => {
      if (used + kh > remaining && (part.length > 0 || !pageEmpty())) {
        if (part.length) pages[pages.length - 1].push({ block: i, kind: "box", children: part });
        newPage();
        part = [];
        used = chrome;
      }
      part.push(k);
      used += kh;
    });
    if (part.length) pages[pages.length - 1].push({ block: i, kind: "box", children: part });
    remaining -= used;
  });
  return pages.filter((p, i) => p.length > 0 || i === 0);
}

/**
 * Lays the document out off screen (with a probe of the real page frame), waits for fonts and images, plans the
 * pages and hands the plan back. Rendered into document.body because the print bundle is display:none on screen.
 */
export function FormattedLayoutProbe({ source, probeFirst, probeRest, onPlan }: { source: FormattedManuscriptSource; probeFirst: ReactNode; probeRest: ReactNode; onPlan: (plan: FormattedPlan) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const g = geometry(source.doc);
  const ctx: RenderCtx = { source, scale: g.scale, basePt: g.basePt };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const layer = ref.current;
      if (!layer) return;
      try {
        await document.fonts?.ready;
      } catch {
        /* fonts API unavailable: lay out with what is loaded */
      }
      await Promise.all([...layer.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)));
      if (cancelled) return;
      const avail = (selector: string) => (layer.querySelector<HTMLElement>(`${selector} .fm-probe-fill`)?.getBoundingClientRect().height ?? 700);
      onPlan(planPages(layer, source, avail(".fm-probe-first"), avail(".fm-probe-rest")));
    })();
    return () => {
      cancelled = true;
    };
  }, [source, onPlan]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="spr-report fm-measure" ref={ref} aria-hidden="true">
      <div className="fm-probe-first">{probeFirst}</div>
      <div className="fm-probe-rest">{probeRest}</div>
      <div className="fm-column" style={{ width: g.columnPx }}>
        {source.doc.blocks.map((b, i) => <div key={i} data-fm-block={i}><BlockView block={b} ctx={ctx} /></div>)}
      </div>
    </div>,
    document.body,
  );
}

// ── preparing a re-attached file (browser only) ──────────────────────────
export type PrepareResult = { ok: true; source: FormattedManuscriptSource } | { ok: false; message: string };

export const FORMATTED_MESSAGES = {
  notDocx: "Choose the original Word file (.docx) that this report was made from.",
  unreadable: "This file could not be read as a Word document. Use Download report for the standard PDF.",
  mismatch: "This file is not the document this report was made from. Choose the same .docx you uploaded, unchanged, or use Download report for the standard PDF.",
  unplaced: "The original formatting could not be matched safely to every highlighted passage, so it is not used. Use Download report for the standard PDF.",
} as const;

/**
 * Reads the chosen file in the browser, checks it is the analysed document (the upload's own extraction must
 * reproduce the saved text exactly), parses its structure and places every highlight. Nothing leaves the device.
 */
export async function prepareFormattedManuscript(report: SimilarityReport, file: File, highlights: PrintHighlight[]): Promise<PrepareResult> {
  if (!/\.docx$/i.test(file.name)) return { ok: false, message: FORMATTED_MESSAGES.notDocx };
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { ok: false, message: FORMATTED_MESSAGES.unreadable };
  }
  const [{ extractDocxTextDocumentWithCompleteness }, { normalizeExtractedText }, mammoth, JSZip, { readDocxDocument }] = await Promise.all([
    import("@/lib/docx-text-extraction"),
    import("@/lib/extracted-text-normalization"),
    import("mammoth/mammoth.browser"),
    import("jszip").then((m) => m.default),
    import("@/lib/docx-document"),
  ]);
  const extracted = await extractDocxTextDocumentWithCompleteness(mammoth.convertToHtml, { arrayBuffer: bytes }).catch(() => null);
  if (!extracted || extracted.completeness === "FAILED") return { ok: false, message: FORMATTED_MESSAGES.unreadable };
  if (normalizeExtractedText(extracted.text) !== (report.text ?? "")) return { ok: false, message: FORMATTED_MESSAGES.mismatch };
  let doc: DocxDocument;
  try {
    const zip = await JSZip.loadAsync(bytes);
    doc = await readDocxDocument(zip, (xml) => new DOMParser().parseFromString(xml, "application/xml"));
  } catch {
    return { ok: false, message: FORMATTED_MESSAGES.unreadable };
  }
  const map = mapHighlightsOntoDocx(doc, report.text ?? "", highlights);
  if (!formattedManuscriptReady(map)) return { ok: false, message: FORMATTED_MESSAGES.unplaced };
  const imageUrls = new Map<string, string>();
  for (const [path, media] of doc.media) imageUrls.set(path, URL.createObjectURL(new Blob([media.bytes as BlobPart], { type: media.contentType })));
  return { ok: true, source: { doc, imageUrls, map, highlights } };
}

/** True when the document holds text Word hides (w:vanish) — shown dimmed in the manuscript, since it was analysed. */
export function formattedHasHiddenText(doc: DocxDocument): boolean {
  const walk = (blocks: DocxBlock[]): boolean => blocks.some((b) =>
    b.kind === "paragraph" ? b.inlines.some((i) => i.kind === "text" && i.style.hidden && i.text.trim())
      : b.kind === "textbox" ? walk(b.blocks)
        : b.rows.some((r) => r.cells.some((c) => walk(c.blocks))));
  return walk(doc.blocks);
}

export function releaseFormattedManuscript(source: FormattedManuscriptSource | null): void {
  if (!source) return;
  for (const url of source.imageUrls.values()) URL.revokeObjectURL(url);
}
