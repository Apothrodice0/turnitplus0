import type { DocxBlock, DocxDocument, DocxParagraph } from "@/lib/docx-document";

/**
 * DOCX MANUSCRIPT MAP (2026-10-21) — places the report's highlights on the structure of the re-attached original
 * .docx (lib/docx-document.ts), for the printed report's formatted manuscript.
 *
 * Highlights are character ranges of the SAVED report text. The saved text is the document's paragraphs as the
 * upload extracted them — but not always in the document's order (Word text boxes are read where they are anchored)
 * and with whitespace normalized. So nothing here assumes global offsets agree. Each saved line is matched to a
 * DOCX paragraph with exactly the same characters (whitespace aside), preferring the next paragraph in document
 * order; a paragraph split by line breaks matches the run of saved lines it produced. Inside a matched paragraph,
 * characters correspond one to one, so a highlight lands on exactly the words it covers in the saved text.
 *
 * Fails closed: the map reports every saved line it could not place and every highlight it could not place; the
 * formatted manuscript is only offered when both are zero (formattedManuscriptReady).
 */

/** One character marks a non-text inline (an image) in a paragraph's flat text, so it has a position but no text. */
export const DOCX_OBJECT_CHAR = "￼";

export type DocxHighlightInput = { start: number; end: number };

export type DocxParagraphMark = {
  /** flat-text offsets in the paragraph (see docxParagraphFlatText) */
  from: number;
  to: number;
  /** index into the caller's highlight list */
  highlight: number;
  /** the highlight's final piece: the source-number badge goes here */
  last: boolean;
};

export type DocxManuscriptMap = {
  marks: Map<DocxParagraph, DocxParagraphMark[]>;
  storedLines: number;
  mappedLines: number;
  unmappedLines: string[];
  highlights: number;
  placedHighlights: number;
  unplacedHighlights: number[];
  /** DOCX paragraphs with text that the saved text does not contain (e.g. removed as repeated page furniture) */
  unusedParagraphs: number;
};

/** The paragraph's text in flat form: runs' text, "\n" for a line break, DOCX_OBJECT_CHAR for an image. */
export function docxParagraphFlatText(p: DocxParagraph): string {
  return p.inlines.map((i) => (i.kind === "text" ? i.text : i.kind === "break" ? "\n" : DOCX_OBJECT_CHAR)).join("");
}

/** Every paragraph in reading order: body, table cells (row by row), text boxes where they are anchored. */
export function docxParagraphsInOrder(blocks: DocxBlock[]): DocxParagraph[] {
  const out: DocxParagraph[] = [];
  const walk = (list: DocxBlock[]) => {
    for (const b of list) {
      if (b.kind === "paragraph") out.push(b);
      else if (b.kind === "textbox") walk(b.blocks);
      else for (const row of b.rows) for (const cell of row.cells) walk(cell.blocks);
    }
  };
  walk(blocks);
  return out;
}

const isSpace = (ch: string) => /\s/.test(ch);
const key = (s: string) => s.replace(/\s+/g, "").split(DOCX_OBJECT_CHAR).join("");

type StoredLine = { start: number; end: number; key: string };

const MAX_LINES_PER_PARAGRAPH = 12;

export function mapHighlightsOntoDocx(doc: DocxDocument, reportText: string, highlights: DocxHighlightInput[]): DocxManuscriptMap {
  const paragraphs = docxParagraphsInOrder(doc.blocks);
  const flat = paragraphs.map(docxParagraphFlatText);
  const paraKeys = flat.map(key);
  const byKey = new Map<string, number[]>();
  paraKeys.forEach((k, i) => {
    if (!k) return;
    const list = byKey.get(k) ?? [];
    list.push(i);
    byKey.set(k, list);
  });
  const used = new Set<number>();

  const lines: StoredLine[] = [];
  let offset = 0;
  for (const line of reportText.split("\n")) {
    const k = key(line);
    if (k) lines.push({ start: offset, end: offset + line.length, key: k });
    offset += line.length + 1;
  }

  // saved line groups -> DOCX paragraphs
  type Group = { start: number; end: number; paragraph: number };
  const groups: Group[] = [];
  const unmappedLines: string[] = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; ) {
    let best: { k: number; p: number } | null = null;
    let joined = "";
    for (let k = 1; k <= MAX_LINES_PER_PARAGRAPH && i + k - 1 < lines.length; k += 1) {
      joined += lines[i + k - 1].key;
      const candidates = (byKey.get(joined) ?? []).filter((p) => !used.has(p));
      if (candidates.length === 0) continue;
      const after = candidates.find((p) => p >= cursor);
      const pick = after ?? candidates[0];
      const better = !best || ((pick >= cursor) !== (best.p >= cursor) ? pick >= cursor : pick < best.p);
      if (better) best = { k, p: pick };
    }
    if (!best) {
      unmappedLines.push(reportText.slice(lines[i].start, lines[i].end));
      i += 1;
      continue;
    }
    used.add(best.p);
    cursor = best.p + 1;
    groups.push({ start: lines[i].start, end: lines[i + best.k - 1].end, paragraph: best.p });
    i += best.k;
  }

  // inside each group: saved character -> paragraph flat position (non-whitespace characters only)
  const marks = new Map<DocxParagraph, DocxParagraphMark[]>();
  const placedPieces = highlights.map(() => [] as Array<{ p: DocxParagraph; mark: DocxParagraphMark; storedEnd: number }>);
  const covered = highlights.map(() => 0);
  const needed = highlights.map((h) => {
    let n = 0;
    for (let c = Math.max(0, h.start); c < Math.min(reportText.length, h.end); c += 1) if (!isSpace(reportText[c])) n += 1;
    return n;
  });
  for (const g of groups) {
    const text = flat[g.paragraph];
    const storedToFlat = new Map<number, number>();
    let f = 0;
    for (let s = g.start; s < g.end; s += 1) {
      if (isSpace(reportText[s])) continue;
      while (f < text.length && (isSpace(text[f]) || text[f] === DOCX_OBJECT_CHAR)) f += 1;
      storedToFlat.set(s, f);
      f += 1;
    }
    highlights.forEach((h, hi) => {
      const a = Math.max(h.start, g.start);
      const b = Math.min(h.end, g.end);
      if (a >= b) return;
      let first = -1;
      let last = -1;
      for (let s = a; s < b; s += 1) {
        if (!storedToFlat.has(s)) continue;
        if (first < 0) first = s;
        last = s;
        covered[hi] += 1;
      }
      if (first < 0) return;
      const mark: DocxParagraphMark = { from: storedToFlat.get(first)!, to: storedToFlat.get(last)! + 1, highlight: hi, last: false };
      const p = paragraphs[g.paragraph];
      const list = marks.get(p) ?? [];
      list.push(mark);
      marks.set(p, list);
      placedPieces[hi].push({ p, mark, storedEnd: last });
    });
  }
  const unplacedHighlights: number[] = [];
  highlights.forEach((_, hi) => {
    if (covered[hi] < needed[hi]) unplacedHighlights.push(hi);
    const pieces = placedPieces[hi];
    if (pieces.length) pieces.reduce((m, x) => (x.storedEnd > m.storedEnd ? x : m)).mark.last = true;
  });
  for (const list of marks.values()) list.sort((x, y) => x.from - y.from);

  return {
    marks,
    storedLines: lines.length,
    mappedLines: lines.length - unmappedLines.length,
    unmappedLines,
    highlights: highlights.length,
    placedHighlights: highlights.length - unplacedHighlights.length,
    unplacedHighlights,
    unusedParagraphs: paraKeys.filter((k, i) => k && !used.has(i)).length,
  };
}

/** The formatted manuscript is offered only when every saved line and every highlight has a verified place. */
export function formattedManuscriptReady(map: DocxManuscriptMap): boolean {
  return map.unmappedLines.length === 0 && map.unplacedHighlights.length === 0;
}

/**
 * Same-document check: the re-attached file, run through the upload's own extraction (mammoth -> HTML -> text ->
 * normalizeExtractedText), must reproduce the saved report text exactly. `extract` is that pipeline, injected.
 */
export async function reattachedDocxMatchesReport(extract: () => Promise<string>, reportText: string): Promise<boolean> {
  try {
    return (await extract()) === reportText;
  } catch {
    return false;
  }
}
