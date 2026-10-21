/**
 * DOCX DOCUMENT MODEL (2026-10-21) — reads the structure of a .docx the reader re-attaches when downloading the
 * printed similarity report "with original formatting" (components/report/report-v2/formatted-manuscript.tsx).
 *
 * Runs entirely in the reader's browser: the file is never uploaded, stored or sent anywhere. Pure: the caller
 * passes the XML parser (the browser's DOMParser in the app, @xmldom/xmldom in Node tests).
 *
 * Covered: paragraph alignment, right-to-left direction, indentation, spacing and line height; headings (style
 * outline levels / "Heading n" / "Title"); bold, italic, underline, strike, super/subscript and size, resolved
 * through the style chain; numbered and bulleted lists (numbering.xml counters); tables with column spans and
 * vertical merges; inline and floating images (word/media); text boxes (read once — Word stores each twice, a
 * DrawingML copy and a VML fallback). Not covered, and reported in `warnings`: equations, embedded objects, charts,
 * footnote text, headers/footers. Never invents text: every character comes from the document's own runs.
 */

export type XmlParser = (xml: string) => Document;

export type DocxAlign = "left" | "center" | "right" | "justify";

export type DocxRunStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  vertAlign?: "superscript" | "subscript";
  /** font size in points, when the document sets one */
  sizePt?: number;
  /** the run's Latin and complex-script (e.g. Arabic) font names, as the document names them */
  font?: string;
  csFont?: string;
  /** text colour set in the document (#rrggbb), never automatic/black */
  color?: string;
  /** hidden text (w:vanish): Word does not display it, but the upload extracted and analysed it */
  hidden?: boolean;
};

/**
 * Word keeps separate bold / italic / size / font values for complex-script text (Arabic, Hebrew) — w:bCs, w:iCs,
 * w:szCs, w:rFonts/@w:cs — and applies them only to such text. Read both sets; a text inline gets the set that
 * matches its own script (scriptStyle).
 */
type RunProps = DocxRunStyle & { boldCs?: boolean; italicCs?: boolean; sizeCsPt?: number; rtlRun?: boolean };

const COMPLEX_SCRIPT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

function scriptStyle(props: RunProps, text: string): DocxRunStyle {
  const complex = props.rtlRun || COMPLEX_SCRIPT.test(text);
  const { boldCs, italicCs, sizeCsPt, rtlRun: _rtl, ...latin } = props;
  void _rtl;
  if (!complex) return latin;
  return { ...latin, bold: boldCs ?? latin.bold, italic: italicCs ?? latin.italic, sizePt: sizeCsPt ?? latin.sizePt, font: latin.csFont ?? latin.font };
}

export type DocxInline =
  | { kind: "text"; text: string; style: DocxRunStyle }
  | { kind: "break" }
  | { kind: "image"; mediaPath: string; widthPx: number; heightPx: number; alt: string };

export type DocxParagraph = {
  kind: "paragraph";
  align: DocxAlign | null;
  rtl: boolean;
  indentLeftPx: number;
  indentRightPx: number;
  /** positive = first-line indent, negative = hanging indent */
  firstLinePx: number;
  spaceBeforePx: number;
  spaceAfterPx: number;
  /** line height as a multiple, when the document sets an "auto" spacing */
  lineHeight: number | null;
  /** 1–6 for headings, 0 for the document title, null otherwise */
  heading: number | null;
  /** the list marker Word draws ("1.", "a)", "•"), never part of the paragraph's text */
  listLabel: string | null;
  inlines: DocxInline[];
};

export type DocxTableCell = {
  colSpan: number;
  rowSpan: number;
  /** borders the cell itself draws (w:tcBorders), when the table as a whole draws none */
  borders: { top: boolean; bottom: boolean; start: boolean; end: boolean } | null;
  vAlign: "top" | "center" | "bottom" | null;
  widthPct: number | null;
  blocks: DocxBlock[];
};

export type DocxTable = {
  kind: "table";
  rtl: boolean;
  bordered: boolean;
  /** the table's own width, when Word fixes one (in px, or as a percentage of the text width) */
  widthPx: number | null;
  widthPct: number | null;
  align: "left" | "center" | "right" | null;
  rows: Array<{ header: boolean; cells: DocxTableCell[] }>;
};

/**
 * A Word text box. A floating one sits over the page in Word; its height (from the file) is kept so the empty
 * paragraphs Word left underneath it as spacers can be dropped (collapseSpacers).
 */
export type DocxTextBox = { kind: "textbox"; blocks: DocxBlock[]; floating: boolean; heightPx: number };

export type DocxBlock = DocxParagraph | DocxTable | DocxTextBox;

export type DocxMedia = { bytes: Uint8Array; contentType: string };

export type DocxDocument = {
  blocks: DocxBlock[];
  /** the page text width and body text size Word lays the document out with */
  layout: { contentWidthPx: number | null; baseSizePt: number };
  media: Map<string, DocxMedia>;
  /** elements present in the file that this renderer does not draw (shown to the reader, never silently dropped) */
  warnings: string[];
};

type JSZipLike = {
  file(name: string): { async(type: "string"): Promise<string>; async(type: "uint8array"): Promise<Uint8Array> } | null;
};

// ── XML helpers ──────────────────────────────────────────────────────────
function kids(el: Element | null | undefined): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element);
  return out;
}
function child(el: Element | null | undefined, name: string): Element | null {
  return kids(el).find((k) => k.nodeName === name) ?? null;
}
function descendant(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (const k of kids(el)) {
    if (k.nodeName === name) return k;
    const d = descendant(k, name);
    if (d) return d;
  }
  return null;
}
function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const v = el.getAttribute(name);
  return v === null || v === "" ? null : v;
}
function num(el: Element | null | undefined, name: string): number | null {
  const v = attr(el, name);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}
/** w:b / w:i style on-off properties: present = on, unless w:val is 0/false/off. */
function onOff(el: Element | null): boolean | undefined {
  if (!el) return undefined;
  const v = attr(el, "w:val");
  return !(v === "0" || v === "false" || v === "off");
}
const twipsToPx = (t: number) => t / 15;

// ── styles ───────────────────────────────────────────────────────────────
type PPr = { align?: DocxAlign; rtl?: boolean; left?: number; right?: number; firstLine?: number; before?: number; after?: number; line?: number | null; outline?: number; numId?: string; ilvl?: number };
type ResolvedStyle = { p: PPr; r: RunProps; heading: number | null };

function readAlign(v: string | null): DocxAlign | undefined {
  if (!v) return undefined;
  if (v === "center") return "center";
  if (v === "both" || v === "distribute" || v === "justify") return "justify";
  if (v === "right" || v === "end") return "right";
  if (v === "left" || v === "start") return "left";
  return undefined;
}

function readPPr(pPr: Element | null): PPr {
  const out: PPr = {};
  if (!pPr) return out;
  const jc = readAlign(attr(child(pPr, "w:jc"), "w:val"));
  if (jc) out.align = jc;
  const bidi = onOff(child(pPr, "w:bidi"));
  if (bidi !== undefined) out.rtl = bidi;
  const ind = child(pPr, "w:ind");
  if (ind) {
    const left = num(ind, "w:start") ?? num(ind, "w:left");
    const right = num(ind, "w:end") ?? num(ind, "w:right");
    if (left !== null) out.left = left;
    if (right !== null) out.right = right;
    const hanging = num(ind, "w:hanging");
    const first = num(ind, "w:firstLine");
    if (hanging !== null) out.firstLine = -hanging;
    else if (first !== null) out.firstLine = first;
  }
  const sp = child(pPr, "w:spacing");
  if (sp) {
    const before = num(sp, "w:before");
    const after = num(sp, "w:after");
    if (before !== null) out.before = before;
    if (after !== null) out.after = after;
    const line = num(sp, "w:line");
    const rule = attr(sp, "w:lineRule");
    if (line !== null && (rule === null || rule === "auto")) out.line = line / 240;
    else if (line !== null) out.line = null;
  }
  const outline = num(child(pPr, "w:outlineLvl"), "w:val");
  if (outline !== null) out.outline = outline;
  const numPr = child(pPr, "w:numPr");
  if (numPr) {
    const id = attr(child(numPr, "w:numId"), "w:val");
    if (id) out.numId = id;
    const lvl = num(child(numPr, "w:ilvl"), "w:val");
    out.ilvl = lvl ?? 0;
  }
  return out;
}

function readRPr(rPr: Element | null): RunProps {
  const out: RunProps = {};
  if (!rPr) return out;
  const b = onOff(child(rPr, "w:b"));
  if (b !== undefined) out.bold = b;
  const bCs = onOff(child(rPr, "w:bCs"));
  if (bCs !== undefined) out.boldCs = bCs;
  const i = onOff(child(rPr, "w:i"));
  if (i !== undefined) out.italic = i;
  const iCs = onOff(child(rPr, "w:iCs"));
  if (iCs !== undefined) out.italicCs = iCs;
  const rtl = onOff(child(rPr, "w:rtl"));
  if (rtl !== undefined) out.rtlRun = rtl;
  const u = child(rPr, "w:u");
  if (u) out.underline = attr(u, "w:val") !== "none";
  const s = onOff(child(rPr, "w:strike")) ?? onOff(child(rPr, "w:dstrike"));
  if (s !== undefined) out.strike = s;
  const va = attr(child(rPr, "w:vertAlign"), "w:val");
  if (va === "superscript" || va === "subscript") out.vertAlign = va;
  const sz = num(child(rPr, "w:sz"), "w:val");
  if (sz !== null) out.sizePt = sz / 2;
  const szCs = num(child(rPr, "w:szCs"), "w:val");
  if (szCs !== null) out.sizeCsPt = szCs / 2;
  const fonts = child(rPr, "w:rFonts");
  const font = attr(fonts, "w:ascii") ?? attr(fonts, "w:hAnsi");
  if (font) out.font = font;
  const cs = attr(fonts, "w:cs");
  if (cs) out.csFont = cs;
  const color = attr(child(rPr, "w:color"), "w:val");
  if (color && /^[0-9a-f]{6}$/i.test(color) && color !== "000000") out.color = `#${color.toLowerCase()}`;
  const hidden = onOff(child(rPr, "w:vanish"));
  if (hidden !== undefined) out.hidden = hidden;
  return out;
}

class Styles {
  private raw = new Map<string, Element>();
  private cache = new Map<string, ResolvedStyle>();
  defaultParagraphStyle: string | null = null;
  docP: PPr = {};
  docR: RunProps = {};

  constructor(doc: Document | null) {
    const root = doc?.documentElement ?? null;
    for (const s of kids(root)) {
      if (s.nodeName === "w:style") {
        const id = attr(s, "w:styleId");
        if (id) this.raw.set(id, s);
        const isDefault = attr(s, "w:default") === "1" || attr(s, "w:default") === "true";
        if (attr(s, "w:type") === "paragraph" && isDefault) this.defaultParagraphStyle = id;
      }
      if (s.nodeName === "w:docDefaults") {
        this.docP = readPPr(child(child(s, "w:pPrDefault"), "w:pPr"));
        this.docR = readRPr(child(child(s, "w:rPrDefault"), "w:rPr"));
      }
    }
  }

  resolve(id: string | null, depth = 0): ResolvedStyle {
    if (!id || depth > 12) return { p: {}, r: {}, heading: null };
    const hit = this.cache.get(id);
    if (hit) return hit;
    const el = this.raw.get(id);
    if (!el) return { p: {}, r: {}, heading: null };
    const base = this.resolve(attr(child(el, "w:basedOn"), "w:val"), depth + 1);
    const name = (attr(child(el, "w:name"), "w:val") ?? id).toLowerCase();
    const own = readPPr(child(el, "w:pPr"));
    const p = { ...base.p, ...own };
    const r = { ...base.r, ...readRPr(child(el, "w:rPr")) };
    let heading = base.heading;
    const named = /^heading\s*(\d)$/.exec(name);
    if (named) heading = Math.min(6, Number(named[1]));
    else if (name === "title") heading = 0;
    else if (own.outline !== undefined && own.outline < 9) heading = Math.min(6, own.outline + 1);
    const out = { p, r, heading };
    this.cache.set(id, out);
    return out;
  }
}

// ── numbering ────────────────────────────────────────────────────────────
type NumLevel = { start: number; fmt: string; text: string };

const ROMAN: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
const ABJAD = ["أ", "ب", "ج", "د", "ه", "و", "ز", "ح", "ط", "ي", "ك", "ل", "م", "ن", "س", "ع", "ف", "ص", "ق", "ر", "ش", "ت", "ث", "خ", "ذ", "ض", "ظ", "غ"];
const ARABIC_ALPHA = ["أ", "ب", "ت", "ث", "ج", "ح", "خ", "د", "ذ", "ر", "ز", "س", "ش", "ص", "ض", "ط", "ظ", "ع", "غ", "ف", "ق", "ك", "ل", "م", "ن", "ه", "و", "ي"];

function formatCounter(n: number, fmt: string): string {
  switch (fmt) {
    case "lowerLetter": return letters(n).toLowerCase();
    case "upperLetter": return letters(n);
    case "lowerRoman": return roman(n);
    case "upperRoman": return roman(n).toUpperCase();
    case "decimalZero": return n < 10 ? `0${n}` : String(n);
    case "arabicAbjad": return ABJAD[(n - 1) % ABJAD.length];
    case "arabicAlpha": return ARABIC_ALPHA[(n - 1) % ARABIC_ALPHA.length];
    case "none": return "";
    default: return String(n);
  }
}
function letters(n: number): string {
  let s = "";
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(65 + ((v - 1) % 26)) + s;
  return s;
}
function roman(n: number): string {
  let s = "";
  let v = n;
  for (const [k, r] of ROMAN) while (v >= k) { s += r; v -= k; }
  return s;
}
/** Word's Symbol / Wingdings bullet codes (private-use area) and the glyphs Word draws for them. */
const SYMBOL_BULLETS: Record<number, string> = {
  0xf0b7: "•", 0xf02d: "–", 0xf0a7: "▪", 0xf0a8: "□", 0xf06e: "■", 0xf06f: "◦", 0xf0d7: "➢", 0xf0d8: "➢", 0xf076: "❖", 0xf0fc: "✓", 0xf0e0: "➔", 0xf0e8: "➔", 0xf0a1: "○", 0xf0b0: "°",
};
function bulletText(text: string): string {
  const t = text.trim();
  if (!t) return "•";
  const c = t.codePointAt(0) ?? 0;
  if (c >= 0xe000 && c <= 0xf8ff) {
    if (SYMBOL_BULLETS[c]) return SYMBOL_BULLETS[c];
    const ascii = c - 0xf000;
    return ascii > 0x20 && ascii < 0x7f ? String.fromCharCode(ascii) : "•";
  }
  if (t === "o") return "◦";
  if (t === "-") return "–";
  return t;
}

class Numbering {
  private abstract = new Map<string, Map<number, NumLevel>>();
  private nums = new Map<string, { abstractId: string; overrides: Map<number, number> }>();
  private counters = new Map<string, number[]>();

  constructor(doc: Document | null) {
    const root = doc?.documentElement ?? null;
    for (const el of kids(root)) {
      if (el.nodeName === "w:abstractNum") {
        const levels = new Map<number, NumLevel>();
        for (const lvl of kids(el)) {
          if (lvl.nodeName !== "w:lvl") continue;
          levels.set(num(lvl, "w:ilvl") ?? 0, {
            start: num(child(lvl, "w:start"), "w:val") ?? 1,
            fmt: attr(child(lvl, "w:numFmt"), "w:val") ?? "decimal",
            text: attr(child(lvl, "w:lvlText"), "w:val") ?? "",
          });
        }
        this.abstract.set(attr(el, "w:abstractNumId") ?? "", levels);
      }
      if (el.nodeName === "w:num") {
        const overrides = new Map<number, number>();
        for (const o of kids(el)) {
          if (o.nodeName !== "w:lvlOverride") continue;
          const s = num(child(o, "w:startOverride"), "w:val");
          if (s !== null) overrides.set(num(o, "w:ilvl") ?? 0, s);
        }
        this.nums.set(attr(el, "w:numId") ?? "", { abstractId: attr(child(el, "w:abstractNumId"), "w:val") ?? "", overrides });
      }
    }
  }

  /** The marker for the next paragraph of list `numId` at level `ilvl` (advances the counters). */
  next(numId: string, ilvl: number): string | null {
    if (numId === "0") return null;
    const n = this.nums.get(numId);
    const levels = n ? this.abstract.get(n.abstractId) : undefined;
    const level = levels?.get(ilvl);
    if (!n || !levels || !level) return null;
    const key = n.abstractId;
    const counters = this.counters.get(key) ?? [];
    for (let l = 0; l < ilvl; l += 1) if (counters[l] === undefined) counters[l] = (n.overrides.get(l) ?? levels.get(l)?.start ?? 1);
    counters[ilvl] = counters[ilvl] === undefined ? (n.overrides.get(ilvl) ?? level.start) : counters[ilvl] + 1;
    counters.length = ilvl + 1; // a deeper level restarts after this one
    this.counters.set(key, counters);
    if (level.fmt === "bullet") return bulletText(level.text);
    if (level.fmt === "none") return null;
    return level.text.replace(/%(\d)/g, (_, d: string) => {
      const l = Number(d) - 1;
      return formatCounter(counters[l] ?? levels.get(l)?.start ?? 1, levels.get(l)?.fmt ?? "decimal");
    });
  }
}

// ── body ─────────────────────────────────────────────────────────────────
type Ctx = { styles: Styles; numbering: Numbering; rels: Map<string, string>; mediaUsed: Set<string>; warnings: Set<string> };

const EMU_PER_PX = 9525;

function drawingImage(el: Element, ctx: Ctx): DocxInline | null {
  const blip = descendant(el, "a:blip");
  const id = attr(blip, "r:embed") ?? attr(blip, "r:link");
  const target = id ? ctx.rels.get(id) : undefined;
  if (!target) return null;
  const extent = descendant(el, "wp:extent");
  const cx = num(extent, "cx") ?? 0;
  const cy = num(extent, "cy") ?? 0;
  const docPr = descendant(el, "wp:docPr");
  ctx.mediaUsed.add(target);
  return { kind: "image", mediaPath: target, widthPx: Math.round(cx / EMU_PER_PX), heightPx: Math.round(cy / EMU_PER_PX), alt: attr(docPr, "descr") ?? attr(docPr, "title") ?? "" };
}

function vmlImage(el: Element, ctx: Ctx): DocxInline | null {
  const data = descendant(el, "v:imagedata");
  const id = attr(data, "r:id");
  const target = id ? ctx.rels.get(id) : undefined;
  if (!target) return null;
  const style = attr(descendant(el, "v:shape"), "style") ?? "";
  const pt = (k: string) => Number(new RegExp(`${k}:\\s*([\\d.]+)pt`).exec(style)?.[1] ?? NaN);
  ctx.mediaUsed.add(target);
  return { kind: "image", mediaPath: target, widthPx: Math.round((pt("width") || 300) * (96 / 72)), heightPx: Math.round((pt("height") || 200) * (96 / 72)), alt: "" };
}

/** Text box content, read once: the DrawingML copy when present, otherwise the VML fallback. */
function textBoxBlocks(el: Element, ctx: Ctx): DocxBlock[] | null {
  const content = descendant(el, "w:txbxContent");
  return content ? readBlocks(content, ctx) : null;
}

/** The text box in `el` (DrawingML or VML), with whether it floats over the page and how tall Word draws it. */
function textBox(el: Element, ctx: Ctx): DocxTextBox | null {
  const blocks = textBoxBlocks(el, ctx);
  if (!blocks) return null;
  const cy = num(descendant(el, "wp:extent"), "cy");
  const vmlStyle = attr(descendant(el, "v:shape"), "style") ?? attr(descendant(el, "v:rect"), "style") ?? "";
  const vmlHeightPt = Number(/height:\s*([\d.]+)pt/.exec(vmlStyle)?.[1] ?? NaN);
  return {
    kind: "textbox",
    blocks,
    floating: Boolean(descendant(el, "wp:anchor")) || /position:\s*absolute/.test(vmlStyle),
    heightPx: cy !== null ? Math.round(cy / EMU_PER_PX) : Number.isFinite(vmlHeightPt) ? Math.round(vmlHeightPt * (96 / 72)) : 0,
  };
}

function readParagraph(p: Element, ctx: Ctx, out: DocxBlock[]): void {
  const pPrEl = child(p, "w:pPr");
  const styleId = attr(child(pPrEl, "w:pStyle"), "w:val") ?? ctx.styles.defaultParagraphStyle;
  const style = ctx.styles.resolve(styleId);
  const pp: PPr = { ...ctx.styles.docP, ...style.p, ...readPPr(pPrEl) };
  const baseRun: RunProps = { ...ctx.styles.docR, ...style.r };
  const inlines: DocxInline[] = [];
  const boxes: DocxBlock[] = [];

  const readRun = (r: Element) => {
    const rStyleId = attr(child(child(r, "w:rPr"), "w:rStyle"), "w:val");
    const runStyle: RunProps = { ...baseRun, ...(rStyleId ? ctx.styles.resolve(rStyleId).r : {}), ...readRPr(child(r, "w:rPr")) };
    for (const c of kids(r)) {
      switch (c.nodeName) {
        case "w:t": {
          const text = c.textContent ?? "";
          inlines.push({ kind: "text", text, style: scriptStyle(runStyle, text) });
          break;
        }
        case "w:tab": inlines.push({ kind: "text", text: "\t", style: scriptStyle(runStyle, "") }); break;
        case "w:br": case "w:cr": inlines.push({ kind: "break" }); break;
        case "w:noBreakHyphen": inlines.push({ kind: "text", text: "‑", style: scriptStyle(runStyle, "") }); break;
        case "w:sym": {
          const code = parseInt(attr(c, "w:char") ?? "", 16);
          if (Number.isFinite(code)) inlines.push({ kind: "text", text: String.fromCodePoint(code >= 0xf000 ? code - 0xf000 : code), style: scriptStyle(runStyle, "") });
          break;
        }
        case "w:drawing": {
          const box = textBox(c, ctx);
          if (box) boxes.push(box);
          else {
            const img = drawingImage(c, ctx);
            if (img) inlines.push(img);
            else if (descendant(c, "c:chart")) ctx.warnings.add("a chart");
            else ctx.warnings.add("a drawing");
          }
          break;
        }
        case "mc:AlternateContent": {
          const choice = child(c, "mc:Choice");
          const fallback = child(c, "mc:Fallback");
          const box = (choice && textBox(choice, ctx)) ?? (fallback && textBox(fallback, ctx));
          if (box) { boxes.push(box); break; }
          const img = (choice && descendant(choice, "w:drawing") && drawingImage(choice, ctx)) || (fallback && vmlImage(fallback, ctx));
          if (img) inlines.push(img);
          else ctx.warnings.add("a drawing");
          break;
        }
        case "w:pict": {
          const box = textBox(c, ctx);
          if (box) boxes.push(box);
          else {
            const img = vmlImage(c, ctx);
            if (img) inlines.push(img);
          }
          break;
        }
        case "w:object": ctx.warnings.add("an embedded object (such as an equation)"); break;
        case "w:footnoteReference": case "w:endnoteReference": ctx.warnings.add("footnotes"); break;
        default: break;
      }
    }
  };
  const walk = (el: Element) => {
    for (const c of kids(el)) {
      switch (c.nodeName) {
        case "w:r": readRun(c); break;
        case "w:hyperlink": case "w:ins": case "w:smartTag": case "w:customXml": case "w:fldSimple": case "w:bdo": case "w:dir": walk(c); break;
        case "w:sdt": walk(child(c, "w:sdtContent") ?? c); break;
        case "m:oMath": case "m:oMathPara": ctx.warnings.add("an equation"); break;
        default: break; // w:del (deleted text), bookmarks, proofing marks
      }
    }
  };
  walk(p);

  const listLabel = pp.numId ? ctx.numbering.next(pp.numId, pp.ilvl ?? 0) : null;
  out.push({
    kind: "paragraph",
    align: pp.align ?? null,
    rtl: pp.rtl ?? false,
    indentLeftPx: twipsToPx(pp.left ?? 0),
    indentRightPx: twipsToPx(pp.right ?? 0),
    firstLinePx: twipsToPx(pp.firstLine ?? 0),
    spaceBeforePx: twipsToPx(pp.before ?? 0),
    spaceAfterPx: twipsToPx(pp.after ?? 0),
    lineHeight: pp.line ?? null,
    heading: pp.outline !== undefined && pp.outline < 9 && style.heading === null ? Math.min(6, pp.outline + 1) : style.heading,
    listLabel,
    inlines,
  });
  out.push(...boxes);
}

function readTable(tbl: Element, ctx: Ctx): DocxTable {
  const tblPr = child(tbl, "w:tblPr");
  const grid = kids(child(tbl, "w:tblGrid")).filter((g) => g.nodeName === "w:gridCol").map((g) => num(g, "w:w") ?? 0);
  const gridTotal = grid.reduce((a, b) => a + b, 0);
  const borders = child(tblPr, "w:tblBorders");
  const styleId = attr(child(tblPr, "w:tblStyle"), "w:val");
  const bordered = Boolean(borders && kids(borders).some((b) => attr(b, "w:val") && attr(b, "w:val") !== "none" && attr(b, "w:val") !== "nil"))
    || Boolean(styleId && /grid|table/i.test(styleId));
  const rows: DocxTable["rows"] = [];
  // vertical merges: the cell that starts a merge at grid column c, by column
  const openMerge = new Map<number, DocxTableCell>();
  for (const tr of kids(tbl)) {
    if (tr.nodeName !== "w:tr") continue;
    const header = onOff(child(child(tr, "w:trPr"), "w:tblHeader")) ?? false;
    const cells: DocxTableCell[] = [];
    let col = num(child(child(tr, "w:trPr"), "w:gridBefore"), "w:val") ?? 0;
    for (const tc of kids(tr)) {
      if (tc.nodeName !== "w:tc") continue;
      const tcPr = child(tc, "w:tcPr");
      const span = num(child(tcPr, "w:gridSpan"), "w:val") ?? 1;
      const vMergeEl = child(tcPr, "w:vMerge");
      const vMerge = vMergeEl ? (attr(vMergeEl, "w:val") ?? "continue") : null;
      if (vMerge === "continue" && openMerge.has(col)) {
        openMerge.get(col)!.rowSpan += 1;
        col += span;
        continue;
      }
      const v = attr(child(tcPr, "w:vAlign"), "w:val");
      const width = grid.slice(col, col + span).reduce((a, b) => a + b, 0);
      const tcBorders = child(tcPr, "w:tcBorders");
      const side = (...names: string[]) => names.some((n) => {
        const val = attr(child(tcBorders, n), "w:val");
        return Boolean(val && val !== "nil" && val !== "none");
      });
      const cell: DocxTableCell = {
        colSpan: span,
        rowSpan: 1,
        borders: tcBorders ? { top: side("w:top"), bottom: side("w:bottom"), start: side("w:start", "w:left"), end: side("w:end", "w:right") } : null,
        vAlign: v === "center" ? "center" : v === "bottom" ? "bottom" : v === "top" ? "top" : null,
        widthPct: gridTotal > 0 ? Math.round((width / gridTotal) * 1000) / 10 : null,
        blocks: readBlocks(tc, ctx),
      };
      if (vMerge === "restart") openMerge.set(col, cell);
      else openMerge.delete(col);
      cells.push(cell);
      col += span;
    }
    rows.push({ header, cells });
  }
  // the table's width: tblW in twips (dxa) or fiftieths of a percent (pct); without one, the grid's own total
  const tblW = child(tblPr, "w:tblW");
  const wType = attr(tblW, "w:type");
  const wRaw = attr(tblW, "w:w");
  let widthPx: number | null = null;
  let widthPct: number | null = null;
  if (wType === "pct" && wRaw) widthPct = wRaw.endsWith("%") ? Number.parseFloat(wRaw) : Number(wRaw) / 50;
  else if (wType === "dxa" && wRaw && Number(wRaw) > 0) widthPx = twipsToPx(Number(wRaw));
  else if (gridTotal > 0) widthPx = twipsToPx(gridTotal);
  const jc = attr(child(tblPr, "w:jc"), "w:val");
  const align = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "left" || jc === "start" ? "left" : null;
  return { kind: "table", rtl: onOff(child(tblPr, "w:bidiVisual")) ?? false, bordered, widthPx, widthPct: widthPct && Number.isFinite(widthPct) ? widthPct : null, align, rows };
}

/**
 * Word lays a floating text box over the page and keeps empty paragraphs underneath it to reserve its space. In
 * the reading-order layout the box itself takes that space, so those empty spacers (no text, no image) are dropped,
 * up to the box's own height. A paragraph with any text or image is never dropped.
 */
function collapseSpacers(blocks: DocxBlock[], basePt: number): DocxBlock[] {
  const out: DocxBlock[] = [];
  let budget = 0;
  for (const b of blocks) {
    if (b.kind === "textbox" && b.floating) {
      budget = b.heightPx;
      out.push(b);
      continue;
    }
    const empty = b.kind === "paragraph" && b.inlines.every((i) => i.kind === "break" || (i.kind === "text" && !i.text.trim()));
    if (empty && budget > 0) {
      const first = b.inlines.find((i) => i.kind === "text");
      const size = first && first.kind === "text" ? first.style.sizePt ?? basePt : basePt;
      const h = size * (96 / 72) * 1.17 * (b.lineHeight ?? 1) + b.spaceBeforePx + b.spaceAfterPx;
      if (h <= budget) {
        budget -= h;
        continue;
      }
    }
    if (!empty) budget = 0;
    out.push(b);
  }
  return out;
}

function readBlocks(container: Element, ctx: Ctx): DocxBlock[] {
  const out: DocxBlock[] = [];
  for (const el of kids(container)) {
    switch (el.nodeName) {
      case "w:p": readParagraph(el, ctx, out); break;
      case "w:tbl": out.push(readTable(el, ctx)); break;
      case "w:sdt": out.push(...readBlocks(child(el, "w:sdtContent") ?? el, ctx)); break;
      case "w:customXml": out.push(...readBlocks(el, ctx)); break;
      default: break;
    }
  }
  return collapseSpacers(out, ctx.styles.docR.sizePt ?? 11);
}

const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", emf: "image/emf", wmf: "image/wmf" };

/** Parses a .docx (already unzipped by the caller's JSZip instance) into the DocxDocument model. */
export async function readDocxDocument(zip: JSZipLike, parseXml: XmlParser): Promise<DocxDocument> {
  const xml = async (name: string) => {
    const f = zip.file(name);
    return f ? parseXml(await f.async("string")) : null;
  };
  const document = await xml("word/document.xml");
  if (!document) throw new Error("This file is not a Word document.");
  const relsDoc = await xml("word/_rels/document.xml.rels");
  const rels = new Map<string, string>();
  for (const r of kids(relsDoc?.documentElement)) {
    const id = attr(r, "Id");
    const target = attr(r, "Target");
    if (id && target && attr(r, "TargetMode") !== "External") rels.set(id, target.startsWith("/") ? target.slice(1) : `word/${target}`);
  }
  const ctx: Ctx = { styles: new Styles(await xml("word/styles.xml")), numbering: new Numbering(await xml("word/numbering.xml")), rels, mediaUsed: new Set(), warnings: new Set() };
  const body = child(document.documentElement, "w:body");
  const blocks = readBlocks(body ?? document.documentElement, ctx);
  const sect = child(body, "w:sectPr");
  const pageW = num(child(sect, "w:pgSz"), "w:w");
  const mar = child(sect, "w:pgMar");
  const contentTwips = pageW !== null ? pageW - (num(mar, "w:left") ?? 1440) - (num(mar, "w:right") ?? 1440) : null;
  const normal = ctx.styles.resolve(ctx.styles.defaultParagraphStyle);
  const baseSizePt = normal.r.sizePt ?? ctx.styles.docR.sizePt ?? 11;
  const media = new Map<string, DocxMedia>();
  for (const path of ctx.mediaUsed) {
    const f = zip.file(path);
    if (!f) continue;
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    if (ext === "emf" || ext === "wmf") ctx.warnings.add("a Windows metafile image (EMF/WMF), which browsers cannot draw");
    media.set(path, { bytes: await f.async("uint8array"), contentType });
  }
  return { blocks, layout: { contentWidthPx: contentTwips && contentTwips > 0 ? twipsToPx(contentTwips) : null, baseSizePt }, media, warnings: [...ctx.warnings] };
}
