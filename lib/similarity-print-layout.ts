import type { SimilarityReport } from "@/lib/report-types";
import { compareReportSources, type ReportV2SourceCard, type ReportV2ViewModel, type ManuscriptPageRange } from "@/lib/report-v2-view";

/**
 * SIMILARITY PRINT REPORT (2026-10-21) — pure layout helpers for the printed/PDF similarity report
 * (components/report/report-v2/similarity-print-report.tsx): three fixed introductory pages (cover, overview,
 * sources), then the highlighted manuscript from page 4.
 *
 * Everything here re-arranges what buildReportV2ViewModel and findHighlightRanges already computed. Nothing
 * recomputes a score, a matched position or a source attribution:
 *   - sources are RANKED by their own matched-word counts (the same order the evidence interpreter used to assign
 *     src-N ids — lib/evidence-interpretation/build-report-interpretation.ts assignOpaqueIds), and numbered by that
 *     rank everywhere in the PDF (page 3 list, manuscript highlights);
 *   - a highlight takes the best-ranked source of the evidence passage it covers;
 *   - pagination only chooses where pages break; the pages always reconstruct the manuscript text exactly.
 */

// ── palette ──────────────────────────────────────────────────────────────
/**
 * The printed report's whole palette (owner decision 2026-10-21): blue is the brand and carries structure, headings,
 * labels and every highlight; green marks completed / low-similarity states; red marks attention / high-similarity
 * states only; white, dark text and light greys do the rest. The same values are the --spr-* tokens in app/globals.css
 * (inline SVG needs them as literals).
 */
export const PRINT_PALETTE = {
  blue: "#1d4ed8",
  blueDeep: "#1e3a8a",
  green: "#15803d",
  red: "#b91c1c",
  ink: "#1f2937",
  muted: "#6b7280",
  rule: "#e5e7eb",
  track: "#d1d5db",
} as const;

/** Colour of a result band: green for low, blue for moderate, red for high. */
export function printBandColor(key: "low" | "review" | "high" | null | undefined): string {
  return key === "low" ? PRINT_PALETTE.green : key === "high" ? PRINT_PALETTE.red : PRINT_PALETTE.blue;
}

// ── source identity ──────────────────────────────────────────────────────
/** Every source highlight is brand blue; a source is told apart by its number and its underline pattern. */
export const PRINT_SOURCE_COLOR = PRINT_PALETTE.blue;
export const PRINT_SOURCE_LINES = ["solid", "dashed", "dotted", "double"] as const;
export type PrintSourceLine = (typeof PRINT_SOURCE_LINES)[number];
/** Highlight colour for a matched passage whose source could not be resolved to a ranked entry (never numbered). */
export const PRINT_UNRANKED_COLOR = PRINT_PALETTE.muted;

export type PrintSourceTone = { color: string; line: PrintSourceLine };

export function printSourceTone(rank: number): PrintSourceTone {
  const i = Math.max(0, Math.floor(rank) - 1);
  return { color: PRINT_SOURCE_COLOR, line: PRINT_SOURCE_LINES[i % PRINT_SOURCE_LINES.length] };
}

export type PrintRankedSource = ReportV2SourceCard & { rank: number; tone: PrintSourceTone };

/**
 * Sources numbered from 1 in THE report source order (compareReportSources — the same order and numbers the
 * interactive workspace shows; vm.sources is already in it, the sort only guards a hand-built view model).
 */
export function rankPrintSources(vm: Pick<ReportV2ViewModel, "sources">): PrintRankedSource[] {
  return [...vm.sources]
    .sort(compareReportSources)
    .map((source, index) => ({ ...source, rank: index + 1, tone: printSourceTone(index + 1) }));
}

/** How many ranked sources fit on page 3 (each row has a fixed height — see .spr-source-row in app/globals.css). */
export const SOURCES_PAGE_CAPACITY = 16;

export type PrintSourcesPage = { shown: PrintRankedSource[]; total: number; hidden: number };

export function printSourcesPage(ranked: PrintRankedSource[], capacity: number = SOURCES_PAGE_CAPACITY): PrintSourcesPage {
  const shown = ranked.slice(0, Math.max(0, capacity));
  return { shown, total: ranked.length, hidden: ranked.length - shown.length };
}

/**
 * The best (lowest) rank among the sources of the evidence passage that overlaps [start, end) the most, or null.
 * `passages` must carry resolved char offsets (vm.passages); ranges with no overlapping passage stay unranked.
 */
export function rankForCharRange(
  start: number,
  end: number,
  passages: ReportV2ViewModel["passages"],
  rankById: ReadonlyMap<string, number>,
): number | null {
  let best: { overlap: number; rank: number } | null = null;
  for (const p of passages) {
    if (p.charStart === null || p.charEnd === null) continue;
    const overlap = Math.min(end, p.charEnd) - Math.max(start, p.charStart);
    if (overlap <= 0) continue;
    const ranks = p.sourceIds.map((id) => rankById.get(id)).filter((r): r is number => r !== undefined);
    if (ranks.length === 0) continue;
    const rank = Math.min(...ranks);
    if (!best || overlap > best.overlap || (overlap === best.overlap && rank < best.rank)) best = { overlap, rank };
  }
  return best ? best.rank : null;
}

// ── manuscript pagination (print) ────────────────────────────────────────
/**
 * Print pages are budgeted in estimated RENDERED LINES, not words: a page of short lines (a reference list, a
 * table flattened to one cell per line) holds far fewer words than a page of prose, and a fixed word count let
 * such a page spill onto an extra, unnumbered sheet. Lines are found by simulating word wrapping with glyph
 * advance widths measured in Chrome for the real print typography (.spr-manuscript-text: Source Serif 4 / Noto
 * Naskh Arabic, 13px / 1.6, 688px column = 52.9em; ~43 lines fit a sheet). The budgets below keep a margin so an
 * estimation error never pushes a page past its sheet.
 */
export type PrintManuscriptLayout = {
  /** usable line width, in em of the manuscript font size (kept slightly under the real 52.9em) */
  lineWidthEm: number;
  /** text lines on a full manuscript page */
  linesPerPage: number;
  /** text lines on the first manuscript page (it also carries the section opener) */
  firstPageLines: number;
  /** a final fragment this short (in lines) joins the page before instead of filling a sheet of its own */
  tailLines: number;
  /** width reserved for each highlight's source-number badge, in em */
  badgeEm: number;
};

export const PRINT_MANUSCRIPT_LAYOUT: PrintManuscriptLayout = { lineWidthEm: 51.3, linesPerPage: 40, firstPageLines: 35, tailLines: 2, badgeEm: 1.5 };

/** Advance width of one character in em (Source Serif 4 / Noto Naskh Arabic, measured; rounded up). */
export function printGlyphWidthEm(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (ch === " " || ch === "\t" || c === 0xa0) return 0.24;
  if ("iljtfr.,;:'!|`’‘".includes(ch)) return 0.31;
  if (ch === "m" || ch === "w") return 0.89;
  if (ch === "M" || ch === "W") return 0.98;
  if (c >= 0x61 && c <= 0x7a) return 0.58;
  if (c >= 0x41 && c <= 0x5a) return 0.67;
  if (c >= 0x30 && c <= 0x39) return 0.54;
  if ("-–—()[]{}/\\\"“”".includes(ch)) return 0.43;
  if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0xfb50 && c <= 0xfeff)) return 0.42;
  if (c >= 0xc0 && c <= 0x24f) return 0.62;
  if (c >= 0x2e80 && c <= 0xffef) return 1.0;
  return 0.62;
}

type WrapState = { lines: number; width: number };

/** Word-wrap simulation shared by the paginator and estimatePrintLines, so tests measure exactly what pagination used. */
function printWrapper(text: string, occupiedRanges: ReadonlyArray<ManuscriptPageRange>, layout: PrintManuscriptLayout) {
  const cap = Math.max(4, layout.lineWidthEm);
  const badgeAt = new Set(occupiedRanges.filter((r) => r.end > r.start).map((r) => r.start));

  /** Lines used once [from, to) is laid out after `state` (state is updated in place). */
  const layoutRun = (from: number, to: number, state: WrapState) => {
    let p = from;
    while (p < to) {
      const ch = text[p];
      if (ch === "\n") {
        state.lines += 1;
        state.width = 0;
        p += 1;
        continue;
      }
      if (/\s/.test(ch)) {
        if (state.width > 0) state.width += printGlyphWidthEm(ch);
        p += 1;
        continue;
      }
      let q = p;
      let w = 0;
      while (q < to && !/\s/.test(text[q])) {
        w += printGlyphWidthEm(text[q]) + (badgeAt.has(q) ? layout.badgeEm : 0);
        q += 1;
      }
      if (state.width > 0 && state.width + w > cap) {
        state.lines += 1;
        state.width = 0;
      }
      if (w > cap) {
        state.lines += Math.floor(w / cap);
        w %= cap;
      }
      state.width += w;
      p = q;
    }
  };
  const total = (s: WrapState) => s.lines + (s.width > 0 ? 1 : 0);
  const linesOf = (from: number, to: number) => {
    const s = { lines: 0, width: 0 };
    layoutRun(from, to, s);
    return total(s);
  };
  return { cap, layoutRun, total, linesOf };
}

/** Estimated rendered lines of text[from, to) in the print manuscript column (badges of `occupiedRanges` included). */
export function estimatePrintLines(
  text: string,
  from: number,
  to: number,
  occupiedRanges: ReadonlyArray<ManuscriptPageRange> = [],
  layout: PrintManuscriptLayout = PRINT_MANUSCRIPT_LAYOUT,
): number {
  return printWrapper(text, occupiedRanges, layout).linesOf(from, to);
}

/**
 * Splits [0, text.length) into print pages. Guarantees (pinned in tests/similarity-print-report.test.mjs):
 *   - the pages reconstruct `text` exactly (contiguous, no dropped or duplicated characters);
 *   - every page stays within its line budget (the last page may use `tailLines` more), except where a single
 *     unbroken run is itself longer than a page;
 *   - a cut never falls inside a word;
 *   - a highlight is kept whole by breaking before it, unless that would leave the page less than 40 % full
 *     (a passage longer than a page then continues on the next page, like a long paragraph);
 *   - a page prefers to end at a paragraph break when one falls in its last quarter;
 *   - trailing whitespace, or a final fragment of at most `tailLines` lines, joins the page before it.
 */
export function paginateManuscriptForPrint(
  text: string,
  occupiedRanges: ReadonlyArray<ManuscriptPageRange>,
  layout: PrintManuscriptLayout = PRINT_MANUSCRIPT_LAYOUT,
): ManuscriptPageRange[] {
  if (text.length === 0) return [];
  const ranges = [...occupiedRanges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const { cap, layoutRun, total, linesOf } = printWrapper(text, ranges, layout);

  const pages: ManuscriptPageRange[] = [];
  let start = 0;
  while (start < text.length) {
    if (/^\s*$/.test(text.slice(start))) {
      // only whitespace remains — it joins the previous page instead of printing a blank one
      if (pages.length > 0) pages[pages.length - 1].end = text.length;
      else pages.push({ start, end: text.length });
      break;
    }
    const budget = pages.length === 0 ? layout.firstPageLines : layout.linesPerPage;
    const state: WrapState = { lines: 0, width: 0 };
    const linesAtWordStart = new Map<number, number>();
    let lastParagraphCut = -1;
    let lastParagraphCutLines = 0;
    let cut = text.length;
    let p = start;
    while (p < text.length) {
      if (text[p] === "\n") {
        const blankLine = state.width === 0;
        if (blankLine && state.lines + 1 > budget && p > start) {
          cut = p; // a blank line would overflow the sheet: it opens the next page instead
          break;
        }
        state.lines += 1;
        state.width = 0;
        p += 1;
        // a paragraph break is recorded after the whole run of newlines, so no page starts with a blank line
        if (p < text.length && text[p] !== "\n") {
          lastParagraphCut = p;
          lastParagraphCutLines = state.lines;
        }
        continue;
      }
      if (/\s/.test(text[p])) {
        if (state.width > 0) state.width += printGlyphWidthEm(text[p]);
        p += 1;
        continue;
      }
      let q = p;
      while (q < text.length && !/\s/.test(text[q])) q += 1;
      linesAtWordStart.set(p, total(state));
      const next = { ...state };
      layoutRun(p, q, next);
      if (total(next) > budget) {
        if (p > start) {
          cut = p; // the page ends before this word
        } else {
          // one unbroken run longer than the whole page: cut inside it where the page is full
          let r = p;
          let w = 0;
          while (r < q && w + printGlyphWidthEm(text[r]) <= budget * cap) w += printGlyphWidthEm(text[r++]);
          cut = Math.max(p + 1, r);
        }
        break;
      }
      state.lines = next.lines;
      state.width = next.width;
      p = q;
    }

    if (cut < text.length) {
      const insideRange = (pos: number) => ranges.some((r) => pos > r.start && pos < r.end);
      const cutAtParagraph = text[cut] === "\n" || text[cut - 1] === "\n";
      if (!cutAtParagraph && lastParagraphCut > start && lastParagraphCut <= cut && lastParagraphCutLines >= budget * 0.75 && !insideRange(lastParagraphCut)) {
        cut = lastParagraphCut;
      } else {
        const straddled = ranges.find((r) => cut > r.start && cut < r.end);
        const before = straddled ? linesAtWordStart.get(straddled.start) : undefined;
        if (straddled && straddled.start > start && before !== undefined && before >= budget * 0.4) cut = straddled.start;
      }
      // a short final fragment joins this page
      // (only a few hundred characters can fit in tailLines, so longer remainders are skipped without measuring)
      if (text.length - cut <= layout.tailLines * cap * 4 && linesOf(cut, text.length) <= layout.tailLines && linesOf(start, text.length) <= budget + layout.tailLines) cut = text.length;
    }
    if (cut <= start) cut = Math.min(text.length, start + 1); // always progress
    pages.push({ start, end: cut });
    start = cut;
  }
  return pages;
}

// ── document map (page 2) ────────────────────────────────────────────────
export type PrintDocumentMapCell = { rank: number | null; matchedShare: number };

/**
 * The manuscript as `cells` equal slices of its words: each cell carries the share of its words that matched and
 * the best-ranked source behind the most of them. Built from vm.passages' own word ranges only.
 */
export function buildPrintDocumentMap(
  vm: ReportV2ViewModel,
  totalWords: number,
  rankById: ReadonlyMap<string, number>,
  cells = 96,
): PrintDocumentMapCell[] {
  const maxEnd = vm.passages.reduce((m, p) => Math.max(m, p.wordEnd + 1), 0);
  const words = Math.max(1, totalWords, maxEnd);
  const perCell = words / cells;
  const matched = new Array<number>(cells).fill(0);
  const byRank = Array.from({ length: cells }, () => new Map<number, number>());
  for (const p of vm.passages) {
    const ranks = p.sourceIds.map((id) => rankById.get(id)).filter((r): r is number => r !== undefined);
    const rank = ranks.length ? Math.min(...ranks) : null;
    for (let w = Math.max(0, p.wordStart); w <= Math.min(words - 1, p.wordEnd); w += 1) {
      const c = Math.min(cells - 1, Math.floor(w / perCell));
      matched[c] += 1;
      if (rank !== null) byRank[c].set(rank, (byRank[c].get(rank) ?? 0) + 1);
    }
  }
  return matched.map((count, c) => {
    let rank: number | null = null;
    let most = 0;
    for (const [r, n] of byRank[c]) if (n > most || (n === most && rank !== null && r < rank)) { rank = r; most = n; }
    return { rank, matchedShare: Math.min(1, count / Math.max(1, perCell)) };
  });
}

// ── cover ────────────────────────────────────────────────────────────────
/** The account behind the report, as read server-side for the report's own owner — never invented. */
export type ReportSubmitter = {
  displayName: string | null;
  /** only a VERIFIED institution, never a self-declared one */
  institution: string | null;
};

const FILE_TYPE_LABEL: Record<string, string> = {
  pdf: "PDF document",
  docx: "Word document (DOCX)",
  txt: "Plain text",
  md: "Markdown",
  html: "HTML document",
  htm: "HTML document",
  csv: "CSV file",
};

export function printFileTypeLabel(fileName: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase();
  return ext ? FILE_TYPE_LABEL[ext] ?? null : null;
}

/** "thesis-final.docx" -> "thesis-final"; the report has no separate manuscript-title field. */
export function printDocumentTitle(fileName: string): string {
  const stem = fileName.trim().replace(/\.[a-z0-9]{1,5}$/i, "");
  return stem || fileName.trim() || "Untitled document";
}

const LANGUAGE_LABEL: Record<string, string> = {
  ar: "Arabic", arabic: "Arabic",
  en: "English", english: "English",
  fr: "French", french: "French",
  es: "Spanish", spanish: "Spanish",
  mixed: "Mixed",
};

export function printLanguageLabel(report: Pick<SimilarityReport, "features">): string | null {
  const raw = String(report.features?.detectedLanguage ?? "").trim().toLowerCase();
  return LANGUAGE_LABEL[raw] ?? null;
}

export type PrintCoverField = { label: string; value: string };

/** Cover rows, in display order; a field that is unavailable is simply absent. */
export function buildPrintCoverFields(report: SimilarityReport, submitter: ReportSubmitter | null): PrintCoverField[] {
  const fields: PrintCoverField[] = [];
  const add = (label: string, value: string | null | undefined) => {
    const v = (value ?? "").trim();
    if (v && v !== "—") fields.push({ label, value: v });
  };
  add("Submitted by", submitter?.displayName);
  add("Institution", submitter?.institution);
  add("Original file", report.title);
  add("File type", printFileTypeLabel(report.title));
  add("File size", report.fileSize);
  add("Words analyzed", report.wordCount > 0 ? report.wordCount.toLocaleString("en-US") : null);
  add("Detected language", printLanguageLabel(report));
  add("Submission ID", report.submissionId);
  return fields;
}

/** "21 October 2026, 10:25 GMT+1" in the given (or the viewer's) time zone; null for an unparseable date. */
export function formatPrintSubmittedAt(iso: string, timeZone?: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  };
  const parts = new Intl.DateTimeFormat("en-GB", options).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} ${get("timeZoneName")}`.trim();
}
