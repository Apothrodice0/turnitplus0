import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Number-table candidates (asjp-numeric-index-v1). The verifier's informative-shingle filter drops number-only text,
 * so a copied numeric table never reaches the lane. This index finds candidate articles for number-dense passages; a
 * candidate is then verified exactly like any rescue candidate (exact verbatim runs, the frozen STRICT_SPAN rule),
 * so the index can only NOMINATE articles, never credit a word.
 *
 * Groups: the article's numeric tokens (lane tokens that are all digits), split where more than MAX_GAP non-numeric
 * tokens separate two numbers, read as overlapping groups of GROUP numbers. A group is INFORMATIVE only if
 *   >= MIN_DISTINCT distinct values, >= MIN_MULTI_DIGIT values of two or more digits, and not an arithmetic progression
 * (1 2 3 4 …, 2010 2011 …, 0 0 0 …: layouts, scales, years). A group held by more than MAX_DF articles is a common
 * layout and is not indexed. A manuscript nominates an article sharing >= MIN_SHARED such groups.
 */
export const ASJP_NUMERIC_INDEX_FORMAT = "asjp-numeric-index-v1";
export const NUMERIC_GROUP = 8;
export const NUMERIC_MAX_GAP = 6;
export const NUMERIC_MIN_DISTINCT = 5;
export const NUMERIC_MIN_MULTI_DIGIT = 3;
export const NUMERIC_MAX_DF = 2;
export const NUMERIC_MIN_SHARED = 2;
export const NUMERIC_MAX_CANDIDATES = 10;

const isNumber = (t: string) => /^\d+$/.test(t);
function keyOf(values: readonly string[]): number {
  const h = createHash("sha1").update(values.join(" ")).digest("hex");
  return parseInt(h.slice(0, 8), 16) * 2097152 + (parseInt(h.slice(8, 16), 16) & 0x1fffff);
}
function informative(values: readonly string[]): boolean {
  if (new Set(values).size < NUMERIC_MIN_DISTINCT) return false;
  if (values.filter((v) => v.length >= 2).length < NUMERIC_MIN_MULTI_DIGIT) return false;
  const n = values.map(Number);
  const step = n[1] - n[0];
  if (n.every((v, i) => i === 0 || v - n[i - 1] === step)) return false;
  return true;
}
/** The informative numeric groups of a token sequence, with the token position of each group's first number. */
export function numericGroups(tokens: readonly string[]): Array<{ key: number; at: number }> {
  const out: Array<{ key: number; at: number }> = [];
  let segment: number[] = [];
  const flush = () => {
    for (let i = 0; i + NUMERIC_GROUP <= segment.length; i += 1) {
      const values = segment.slice(i, i + NUMERIC_GROUP).map((p) => tokens[p]);
      if (informative(values)) out.push({ key: keyOf(values), at: segment[i] });
    }
    segment = [];
  };
  let last = -Infinity;
  for (let p = 0; p < tokens.length; p += 1) {
    if (!isNumber(tokens[p])) continue;
    if (p - last - 1 > NUMERIC_MAX_GAP) flush();
    segment.push(p);
    last = p;
  }
  flush();
  return out;
}

/** Builds the index from (docId, lane tokens) pairs. Two passes over typed arrays: no per-key object. */
export async function buildNumericIndex(dir: string, documents: AsyncIterable<{ docId: string; tokens: readonly string[] }>) {
  mkdirSync(dir, { recursive: true });
  const docIds: string[] = [];
  let keys = new Float64Array(1 << 20), docs = new Int32Array(1 << 20), n = 0;
  for await (const { docId, tokens } of documents) {
    const d = docIds.length; docIds.push(docId);
    const seen = new Set<number>();
    for (const g of numericGroups(tokens)) {
      if (seen.has(g.key)) continue;
      seen.add(g.key);
      if (n === keys.length) { const k2 = new Float64Array(n * 2); k2.set(keys); keys = k2; const d2 = new Int32Array(n * 2); d2.set(docs); docs = d2; }
      keys[n] = g.key; docs[n] = d; n += 1;
    }
  }
  const order = new Uint32Array(n).map((_, i) => i).sort((a, b) => keys[a] - keys[b] || docs[a] - docs[b]);
  const outKeys: number[] = [], outDocs: number[] = [], outStart: number[] = [];
  let i = 0, kept = 0, dropped = 0;
  while (i < n) {
    let j = i; while (j < n && keys[order[j]] === keys[order[i]]) j += 1;
    if (j - i <= NUMERIC_MAX_DF) { outKeys.push(keys[order[i]]); outStart.push(outDocs.length); for (let k = i; k < j; k += 1) outDocs.push(docs[order[k]]); kept += 1; } else dropped += 1;
    i = j;
  }
  outStart.push(outDocs.length);
  writeFileSync(path.join(dir, "keys.bin"), Buffer.from(new Float64Array(outKeys).buffer));
  writeFileSync(path.join(dir, "start.bin"), Buffer.from(new Uint32Array(outStart).buffer));
  writeFileSync(path.join(dir, "docs.bin"), Buffer.from(new Int32Array(outDocs).buffer));
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ format: ASJP_NUMERIC_INDEX_FORMAT, group: NUMERIC_GROUP, maxGap: NUMERIC_MAX_GAP, minDistinct: NUMERIC_MIN_DISTINCT, minMultiDigit: NUMERIC_MIN_MULTI_DIGIT, maxDf: NUMERIC_MAX_DF, documents: docIds.length, groups: n, keptKeys: kept, droppedCommonKeys: dropped, docIds }, null, 0));
  return { documents: docIds.length, groups: n, keptKeys: kept, droppedCommonKeys: dropped };
}

export class NumericIndex {
  private constructor(private readonly keys: Float64Array, private readonly start: Uint32Array, private readonly docs: Int32Array, private readonly docIds: string[]) {}
  static open(dir: string): NumericIndex {
    const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
    if (meta.format !== ASJP_NUMERIC_INDEX_FORMAT || meta.group !== NUMERIC_GROUP || meta.maxGap !== NUMERIC_MAX_GAP || meta.minDistinct !== NUMERIC_MIN_DISTINCT || meta.minMultiDigit !== NUMERIC_MIN_MULTI_DIGIT || meta.maxDf !== NUMERIC_MAX_DF) throw new Error(`numeric index ${dir} was built with other parameters`);
    const view = <T>(f: string, C: any): T => { const b = readFileSync(path.join(dir, f)); return new C(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
    return new NumericIndex(view("keys.bin", Float64Array), view("start.bin", Uint32Array), view("docs.bin", Int32Array), meta.docIds);
  }
  private find(key: number): number {
    let lo = 0, hi = this.keys.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >>> 1; const v = this.keys[mid]; if (v === key) return mid; if (v < key) lo = mid + 1; else hi = mid - 1; }
    return -1;
  }
  /** Articles sharing >= NUMERIC_MIN_SHARED rare informative numeric groups with the manuscript, most shared first. */
  candidates(tokens: readonly string[]): Array<{ docId: string; sharedGroups: number }> {
    const count = new Map<number, number>();
    const seen = new Set<number>();
    for (const g of numericGroups(tokens)) {
      if (seen.has(g.key)) continue;
      seen.add(g.key);
      const at = this.find(g.key);
      if (at < 0) continue;
      for (let k = this.start[at]; k < this.start[at + 1]; k += 1) count.set(this.docs[k], (count.get(this.docs[k]) ?? 0) + 1);
    }
    return [...count].filter(([, c]) => c >= NUMERIC_MIN_SHARED).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, NUMERIC_MAX_CANDIDATES).map(([d, c]) => ({ docId: this.docIds[d], sharedGroups: c }));
  }
}
