import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { laneTokensIdentity, type LaneTokensIdentity } from "./asjp-lane-tokens";

/**
 * SIX-WORD POSITIONAL INDEX (asjp-sixword-index-v1; research, local only, never on a scoring path by itself).
 *
 * Every position of every indexed article's lane tokens (the asjp-lane-tokens-v2 store: tokensForScoringNormalization
 * under normalization 2, exactly the lane's words) starts one overlapping six-word sequence ("gram"), and EVERY gram is
 * indexed: no frequency cap, no stop list, no sampling. A manuscript's grams are looked up, chained along diagonals into
 * maximal runs, and each run is verified token by token against the token store before it is reported.
 *
 * Keys: each token's UTF-8 bytes are hashed twice (two independent 32-bit hashes), and the six token hashes are mixed
 * into two 32-bit gram hashes h1, h2. bucket = the top BUCKET_BITS bits of h1; fingerprint = h2. A key is therefore 54
 * bits: two different grams share a key with probability ~2^-54, and the token verification rejects any that do.
 *
 * Files (one immutable directory per build):
 *   identity.json   format, parameters, the token store's identity (its probe identity, tokens.bin size + sha256 and
 *                   index.json sha256), the generation it was built for, counts, and sha256 of every file below
 *   docs.json       docOrd -> docId, tokenCount, base (global token position of the article's token 0), the entry's
 *                   offset/length in tokens.bin and the first checkpoint slot
 *   directory.bin   Uint32 [2^BUCKET_BITS + 1]: the first posting of each bucket
 *   postings.bin    Uint32 pairs [fingerprint, global position], sorted by (bucket, fingerprint, position)
 *   checkpoints.bin Uint32: for each article, the byte offset (within its tokens.bin entry) of every CHECKPOINT-th token,
 *                   so any token range is read without reading the whole article
 *   stats.json      gram counts, posting-list length and holder distributions, the most frequent grams
 *
 * The index never holds a word's text; it can only NOMINATE (article, position) pairs. Text always comes from the
 * token store, which is pinned by size and digest at open.
 */
export const ASJP_SIXWORD_INDEX_FORMAT = "asjp-sixword-index-v1";
export const SIXWORD_N = 6;
export const SIXWORD_BUCKET_BITS = 22;
export const SIXWORD_CHECKPOINT = 32;
const HASH_ID = "fnv1a32+fmix32 x2 per token; murmur3-body x6 + fmix32 per gram (seeds 0x9747b28c, 0x5bd1e995)";

const fmix32 = (h: number) => {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};
const mixStep = (h: number, k: number) => {
  k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593);
  h ^= k; h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
};

/**
 * Token hashes of a "\n"-joined UTF-8 token list (the token store's entry format), with each token's byte start.
 * The query side hashes Buffer.from(tokens.join("\n")) through this same function, so both sides agree exactly.
 */
export function hashTokenBytes(bytes: Uint8Array, start = 0, end = bytes.length): { a: Uint32Array; b: Uint32Array; starts: Uint32Array; count: number } {
  let count = end > start ? 1 : 0;
  for (let i = start; i < end; i += 1) if (bytes[i] === 10) count += 1;
  const a = new Uint32Array(count), b = new Uint32Array(count), starts = new Uint32Array(count);
  if (count === 0) return { a, b, starts, count };
  let ha = 0x811c9dc5, hb = 0x3c6ef372, t = 0;
  starts[0] = 0;
  for (let i = start; i < end; i += 1) {
    const c = bytes[i];
    if (c === 10) {
      a[t] = fmix32(ha); b[t] = fmix32(hb ^ 0x2545f491); t += 1; starts[t] = i + 1 - start;
      ha = 0x811c9dc5; hb = 0x3c6ef372;
      continue;
    }
    ha = Math.imul(ha ^ c, 0x01000193);
    hb = Math.imul(hb ^ c, 0x5bd1e995); hb ^= hb >>> 15;
  }
  a[t] = fmix32(ha); b[t] = fmix32(hb ^ 0x2545f491);
  return { a, b, starts, count };
}

/** The two gram hashes of the gram starting at token i (requires i + SIXWORD_N <= count). */
export function gramHashAt(a: Uint32Array, b: Uint32Array, i: number): [number, number] {
  let h1 = 0x9747b28c | 0, h2 = 0x5bd1e995 | 0;
  for (let k = 0; k < SIXWORD_N; k += 1) { h1 = mixStep(h1, a[i + k]); h2 = mixStep(h2, b[i + k]); }
  return [fmix32(h1 ^ SIXWORD_N), fmix32(h2 ^ (SIXWORD_N * 31))];
}

/** Gram keys of a token list, as the index computes them. */
export function gramKeysOf(tokens: readonly string[]): { h1: Uint32Array; h2: Uint32Array } {
  const n = Math.max(0, tokens.length - SIXWORD_N + 1);
  const h1 = new Uint32Array(n), h2 = new Uint32Array(n);
  if (n === 0) return { h1, h2 };
  const { a, b, count } = hashTokenBytes(Buffer.from(tokens.join("\n"), "utf8"));
  if (count !== tokens.length) throw new Error("a token holds a newline: not a lane token list");
  for (let i = 0; i < n; i += 1) { const [x, y] = gramHashAt(a, b, i); h1[i] = x; h2[i] = y; }
  return { h1, h2 };
}

type StoreEntry = [number, number, number, string];
export type SixwordIdentity = {
  format: string; n: number; bucketBits: number; checkpoint: number; hash: string;
  laneTokens: LaneTokensIdentity & { dir: string; tokensBinBytes: number; tokensBinSha256: string; indexJsonSha256: string };
  generation: { generationId: string | null; logicalManifestSha256: string | null };
  documents: number; tokens: number; postings: number; distinctKeys: number;
  files: Record<string, { bytes: number; sha256: string }>;
  builtAt: string; buildMs: number;
};
export type SixwordDocs = { docIds: string[]; tokenCounts: number[]; bases: number[]; storeOffsets: number[]; storeLengths: number[]; checkpointStarts: number[] };

const sha256File = (file: string) => {
  const hash = createHash("sha256"), fd = openSync(file, "r"), buffer = Buffer.allocUnsafe(1 << 22);
  try { for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (n === 0) break; hash.update(buffer.subarray(0, n)); } } finally { closeSync(fd); }
  return hash.digest("hex");
};

/**
 * Builds the index from a lane-token store (read only). Two passes: (1) stream tokens.bin in entry order, checking each
 * entry's checksum, hashing grams into PARTITIONS temporary files; (2) per partition, a stable counting sort by bucket
 * and a stable fingerprint sort within each bucket (positions stay ascending), then append to postings.bin.
 * `exclude` leaves articles out (used to build a base for the incremental-update test).
 */
export async function buildSixwordIndex(options: {
  laneTokensDir: string; outDir: string; tmpDir: string; generationId?: string | null; logicalManifestSha256?: string | null;
  partitions?: number; exclude?: ReadonlySet<string>; only?: ReadonlySet<string>; topGrams?: number; log?: (line: string) => void;
}) {
  const t0 = performance.now();
  const log = options.log ?? (() => {});
  const PB = Math.log2(options.partitions ?? 64);
  if (!Number.isInteger(PB) || PB < 1 || PB > 12) throw new Error("partitions must be a power of two in 2..4096");
  const P = 1 << PB;
  if (existsSync(path.join(options.outDir, "identity.json"))) throw new Error(`${options.outDir} already holds an index: builds are immutable`);
  mkdirSync(options.outDir, { recursive: true });
  mkdirSync(options.tmpDir, { recursive: true });
  const identityOfStore = JSON.parse(readFileSync(path.join(options.laneTokensDir, "identity.json"), "utf8")) as LaneTokensIdentity;
  const expected = laneTokensIdentity(2);
  if (identityOfStore.format !== expected.format || identityOfStore.probeSha256 !== expected.probeSha256 || identityOfStore.engineProbeSha256 !== expected.engineProbeSha256 || identityOfStore.normalization !== 2) {
    throw new Error("lane-token store was built under another tokenization than this code's normalization 2");
  }
  const indexJsonText = readFileSync(path.join(options.laneTokensDir, "index.json"));
  const storeIndex = JSON.parse(indexJsonText.toString("utf8")) as Record<string, StoreEntry>;
  const entries = Object.entries(storeIndex).sort((x, y) => x[1][0] - y[1][0]);
  const tokensBin = path.join(options.laneTokensDir, "tokens.bin");
  const fd = openSync(tokensBin, "r");
  const tokensBinBytes = fstatSync(fd).size;
  const fileHash = createHash("sha256");
  let fileCursor = 0;

  const docs: SixwordDocs = { docIds: [], tokenCounts: [], bases: [], storeOffsets: [], storeLengths: [], checkpointStarts: [] };
  const checkpoints: number[] = [];
  const parts = Array.from({ length: P }, (_, p) => ({ file: path.join(options.tmpDir, `part-${p}.bin`), fd: -1, buf: new Uint32Array(3 * 32768), n: 0, records: 0 }));
  for (const part of parts) part.fd = openSync(part.file, "w");
  const flush = (part: (typeof parts)[number]) => { if (part.n) { writeSync(part.fd, part.buf, 0, part.n * 12); part.records += part.n; part.n = 0; } };
  let base = 0, postings = 0;
  for (const [docId, [offset, length, count, digest]] of entries) {
    const bytes = Buffer.allocUnsafe(length);
    readSync(fd, bytes, 0, length, offset);
    if (offset === fileCursor) { fileHash.update(bytes); fileCursor += length; } else throw new Error(`tokens.bin entries are not contiguous at ${docId}`);
    if (createHash("sha256").update(bytes).digest("hex").slice(0, 16) !== digest) throw new Error(`token store entry ${docId} fails its checksum`);
    const skip = (options.exclude?.has(docId) ?? false) || (options.only ? !options.only.has(docId) : false);
    if (skip) continue;
    const { a, b, starts, count: tokenCount } = hashTokenBytes(bytes);
    if (tokenCount !== count) throw new Error(`token store entry ${docId}: ${tokenCount} tokens, index says ${count}`);
    docs.docIds.push(docId); docs.tokenCounts.push(count); docs.bases.push(base); docs.storeOffsets.push(offset); docs.storeLengths.push(length);
    docs.checkpointStarts.push(checkpoints.length);
    for (let t = 0; t < count; t += SIXWORD_CHECKPOINT) checkpoints.push(starts[t]);
    for (let i = 0; i + SIXWORD_N <= count; i += 1) {
      const [h1, h2] = gramHashAt(a, b, i);
      const part = parts[h1 >>> (32 - PB)];
      const k = part.n * 3;
      part.buf[k] = h1; part.buf[k + 1] = h2; part.buf[k + 2] = base + i;
      part.n += 1;
      if (part.n * 3 === part.buf.length) flush(part);
      postings += 1;
    }
    base += count;
    if (base > 0xffffffff) throw new Error("more than 2^32 tokens: widen the position field");
    if (docs.docIds.length % 5000 === 0) log(`pass 1: ${docs.docIds.length} articles, ${postings} grams, ${Math.round(performance.now() - t0)} ms`);
  }
  if (fileCursor !== tokensBinBytes) throw new Error(`tokens.bin has ${tokensBinBytes - fileCursor} bytes outside the index`);
  closeSync(fd);
  for (const part of parts) { flush(part); closeSync(part.fd); }
  const tokensBinSha256 = fileHash.digest("hex");
  const pass1Ms = Math.round(performance.now() - t0);
  log(`pass 1 done: ${docs.docIds.length} articles, ${base} tokens, ${postings} grams in ${pass1Ms} ms`);

  // pass 2
  const B = SIXWORD_BUCKET_BITS, perPart = 1 << (B - PB);
  const directory = new Uint32Array((1 << B) + 1);
  const postingsFile = path.join(options.outDir, "postings.bin");
  const out = openSync(postingsFile, "w");
  const bases = Uint32Array.from(docs.bases);
  const docOf = (g: number) => { let lo = 0, hi = bases.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (bases[mid] <= g) lo = mid; else hi = mid - 1; } return lo; };
  const postingsHist: Record<string, number> = {}, holdersHist: Record<string, number> = {};
  const bin = (v: number) => (v <= 1 ? "1" : v <= 2 ? "2" : v <= 5 ? "3-5" : v <= 10 ? "6-10" : v <= 100 ? "11-100" : v <= 1000 ? "101-1000" : v <= 10000 ? "1001-10000" : ">10000");
  const TOP = options.topGrams ?? 2000;
  const wide: Array<{ postings: number; holders: number; at: number }> = [];
  let distinctKeys = 0, written = 0, keysHeldOnce = 0, keysOneArticle = 0, postingsInMultiHolderKeys = 0;
  for (let p = 0; p < P; p += 1) {
    const part = parts[p];
    const raw = new Uint32Array(part.records * 3);
    if (part.records) { const pfd = openSync(part.file, "r"); readFully(pfd, raw, raw.byteLength, 0); closeSync(pfd); }
    rmSync(part.file);
    const n = part.records;
    const firstBucket = p * perPart;
    const counts = new Uint32Array(perPart + 1);
    for (let r = 0; r < n; r += 1) counts[(raw[r * 3] >>> (32 - B)) - firstBucket + 1] += 1;
    for (let k = 0; k < perPart; k += 1) counts[k + 1] += counts[k];
    const fp = new Uint32Array(n), pos = new Uint32Array(n), fill = counts.slice(0, perPart);
    for (let r = 0; r < n; r += 1) { const k = (raw[r * 3] >>> (32 - B)) - firstBucket; const at = fill[k]++; fp[at] = raw[r * 3 + 1]; pos[at] = raw[r * 3 + 2]; }
    for (let k = 0; k < perPart; k += 1) {
      const s = counts[k], e = counts[k + 1];
      directory[firstBucket + k] = written + s;
      if (e - s > 1) {
        if (e - s <= 48) {
          for (let x = s + 1; x < e; x += 1) { const f = fp[x], g = pos[x]; let y = x - 1; while (y >= s && fp[y] > f) { fp[y + 1] = fp[y]; pos[y + 1] = pos[y]; y -= 1; } fp[y + 1] = f; pos[y + 1] = g; }
        } else {
          const keys = new BigUint64Array(e - s);
          for (let x = s; x < e; x += 1) keys[x - s] = (BigInt(fp[x]) << 32n) | BigInt(pos[x]);
          keys.sort();
          for (let x = s; x < e; x += 1) { const v = keys[x - s]; fp[x] = Number(v >> 32n); pos[x] = Number(v & 0xffffffffn); }
        }
      }
      // statistics per key (one key = one gram, barring a 54-bit collision)
      let x = s;
      while (x < e) {
        let y = x + 1; while (y < e && fp[y] === fp[x]) y += 1;
        const c = y - x;
        let holders = 1, lastDoc = docOf(pos[x]), docEnd = lastDoc + 1 < bases.length ? bases[lastDoc + 1] : Infinity;
        for (let z = x + 1; z < y; z += 1) if (pos[z] >= docEnd) { lastDoc = docOf(pos[z]); docEnd = lastDoc + 1 < bases.length ? bases[lastDoc + 1] : Infinity; holders += 1; }
        distinctKeys += 1;
        if (c === 1) keysHeldOnce += 1;
        if (holders === 1) keysOneArticle += 1; else postingsInMultiHolderKeys += c;
        postingsHist[bin(c)] = (postingsHist[bin(c)] ?? 0) + 1;
        holdersHist[bin(holders)] = (holdersHist[bin(holders)] ?? 0) + 1;
        if (holders >= 50) wide.push({ postings: c, holders, at: pos[x] });
        x = y;
      }
    }
    const pairs = new Uint32Array(n * 2);
    for (let r = 0; r < n; r += 1) { pairs[r * 2] = fp[r]; pairs[r * 2 + 1] = pos[r]; }
    writeSync(out, pairs);
    written += n;
    if ((p + 1) % 8 === 0) log(`pass 2: partition ${p + 1}/${P}, ${written} postings, ${Math.round(performance.now() - t0)} ms`);
  }
  directory[1 << B] = written;
  closeSync(out);
  if (written !== postings) throw new Error(`wrote ${written} postings, hashed ${postings}`);

  // texts of the most widely held grams (for the report): read back from the token store
  const storeFd = openSync(tokensBin, "r");
  const textAt = (g: number) => {
    const d = docOf(g), at = g - bases[d];
    const bytes = Buffer.allocUnsafe(docs.storeLengths[d]);
    readSync(storeFd, bytes, 0, bytes.length, docs.storeOffsets[d]);
    return bytes.toString("utf8").split("\n").slice(at, at + SIXWORD_N).join(" ");
  };
  const widelyHeld = wide.length;
  const top = wide.sort((u, v) => v.holders - u.holders || v.postings - u.postings).slice(0, TOP);
  const topGrams = top.map((t) => ({ text: textAt(t.at), holders: t.holders, postings: t.postings }));
  closeSync(storeFd);

  writeFileSync(path.join(options.outDir, "directory.bin"), directory);
  writeFileSync(path.join(options.outDir, "checkpoints.bin"), Uint32Array.from(checkpoints));
  writeFileSync(path.join(options.outDir, "docs.json"), JSON.stringify(docs));
  const stats = { documents: docs.docIds.length, tokens: base, postings, distinctKeys, keysHeldBy50OrMoreArticles: widelyHeld, keysHeldOnce, keysOneArticle, postingsInMultiHolderKeys, postingsHist, holdersHist, topGrams, pass1Ms };
  writeFileSync(path.join(options.outDir, "stats.json"), JSON.stringify(stats, null, 1));
  const files: SixwordIdentity["files"] = {};
  for (const f of ["docs.json", "directory.bin", "postings.bin", "checkpoints.bin", "stats.json"]) {
    const file = path.join(options.outDir, f);
    files[f] = { bytes: fstatBytes(file), sha256: sha256File(file) };
  }
  const identity: SixwordIdentity = {
    format: ASJP_SIXWORD_INDEX_FORMAT, n: SIXWORD_N, bucketBits: B, checkpoint: SIXWORD_CHECKPOINT, hash: HASH_ID,
    laneTokens: { ...identityOfStore, dir: options.laneTokensDir.replace(/\\/g, "/"), tokensBinBytes, tokensBinSha256, indexJsonSha256: createHash("sha256").update(indexJsonText).digest("hex") },
    generation: { generationId: options.generationId ?? null, logicalManifestSha256: options.logicalManifestSha256 ?? null },
    documents: docs.docIds.length, tokens: base, postings, distinctKeys, files,
    builtAt: new Date().toISOString(), buildMs: Math.round(performance.now() - t0),
  };
  writeFileSync(path.join(options.outDir, "identity.json"), JSON.stringify(identity, null, 1));
  return identity;
}
/** readSync until `length` bytes are read (a single positioned read may return fewer). */
function readFully(fd: number, target: ArrayBufferView, length: number, position: number) {
  const view = new Uint8Array(target.buffer, target.byteOffset, length);
  let done = 0;
  while (done < length) { const n = readSync(fd, view, done, length - done, position + done); if (n === 0) throw new Error("unexpected end of file"); done += n; }
}
const fstatBytes = (file: string) => { const f = openSync(file, "r"); try { return fstatSync(f).size; } finally { closeSync(f); } };

/**
 * An open index. Lookups read one bucket of postings.bin (positioned reads; the directory, document table and
 * checkpoints are in memory: ~35 MB for the full corpus). Token text comes from the pinned token store.
 *   tombstones   docIds withdrawn after the build (takedown): their postings are dropped at lookup, before any result
 */
export class SixwordIndex {
  readonly docs: SixwordDocs;
  private readonly bases: Uint32Array;
  private readonly directory: Uint32Array;
  private readonly checkpoints: Uint32Array;
  private readonly postingsFd: number;
  private readonly tokensFd: number;
  private readonly ordOfDocId = new Map<string, number>();
  private tombstoned = new Uint8Array(0);
  lookups = 0;
  postingsRead = 0;
  tokenReads = 0;
  private constructor(readonly dir: string, readonly identity: SixwordIdentity, docs: SixwordDocs, directory: Uint32Array, checkpoints: Uint32Array, postingsFd: number, tokensFd: number) {
    this.docs = docs; this.bases = Uint32Array.from(docs.bases); this.directory = directory; this.checkpoints = checkpoints;
    this.postingsFd = postingsFd; this.tokensFd = tokensFd;
    docs.docIds.forEach((d, k) => this.ordOfDocId.set(d, k));
    this.tombstoned = new Uint8Array(docs.docIds.length);
  }
  /**
   * Opens an index; refuses one built under another format or tokenization, or whose token store changed (size, index
   * digest; `verifyTokensDigest` also re-hashes all of tokens.bin, ~1 s per GB).
   */
  static open(dir: string, options: { verifyTokensDigest?: boolean; verifyFiles?: boolean } = {}): SixwordIndex {
    const identity = JSON.parse(readFileSync(path.join(dir, "identity.json"), "utf8")) as SixwordIdentity;
    if (identity.format !== ASJP_SIXWORD_INDEX_FORMAT || identity.n !== SIXWORD_N || identity.bucketBits !== SIXWORD_BUCKET_BITS || identity.checkpoint !== SIXWORD_CHECKPOINT || identity.hash !== HASH_ID) throw new Error(`six-word index ${dir} has another format or parameters`);
    const expected = laneTokensIdentity(2);
    if (identity.laneTokens.probeSha256 !== expected.probeSha256 || identity.laneTokens.engineProbeSha256 !== expected.engineProbeSha256) throw new Error(`six-word index ${dir} was built under another tokenization`);
    const tokensDir = identity.laneTokens.dir;
    const tokensBin = path.join(tokensDir, "tokens.bin");
    const tokensFd = openSync(tokensBin, "r");
    if (fstatSync(tokensFd).size !== identity.laneTokens.tokensBinBytes) { closeSync(tokensFd); throw new Error("token store tokens.bin changed size since the build"); }
    if (createHash("sha256").update(readFileSync(path.join(tokensDir, "index.json"))).digest("hex") !== identity.laneTokens.indexJsonSha256) { closeSync(tokensFd); throw new Error("token store index.json changed since the build"); }
    if (options.verifyTokensDigest && sha256File(tokensBin) !== identity.laneTokens.tokensBinSha256) { closeSync(tokensFd); throw new Error("token store tokens.bin changed since the build"); }
    if (options.verifyFiles) for (const [f, meta] of Object.entries(identity.files)) if (sha256File(path.join(dir, f)) !== meta.sha256) { closeSync(tokensFd); throw new Error(`six-word index file ${f} changed since the build`); }
    const docs = JSON.parse(readFileSync(path.join(dir, "docs.json"), "utf8")) as SixwordDocs;
    const dirBytes = readFileSync(path.join(dir, "directory.bin"));
    const directory = new Uint32Array(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength / 4);
    const ckBytes = readFileSync(path.join(dir, "checkpoints.bin"));
    const checkpoints = new Uint32Array(ckBytes.buffer, ckBytes.byteOffset, ckBytes.byteLength / 4);
    if (directory.length !== (1 << SIXWORD_BUCKET_BITS) + 1 || directory[directory.length - 1] !== identity.postings) { closeSync(tokensFd); throw new Error("six-word directory does not match the identity"); }
    return new SixwordIndex(dir, identity, docs, directory, checkpoints, openSync(path.join(dir, "postings.bin"), "r"), tokensFd);
  }
  get documentCount() { return this.docs.docIds.length; }
  /** Withdraws articles (takedown) from every later lookup of this open index. */
  setTombstones(docIds: Iterable<string>) {
    this.tombstoned = new Uint8Array(this.docs.docIds.length);
    for (const d of docIds) { const k = this.ordOfDocId.get(d); if (k !== undefined) this.tombstoned[k] = 1; }
  }
  isTombstoned(ord: number) { return this.tombstoned[ord] === 1; }
  ordOf(docId: string) { return this.ordOfDocId.get(docId); }
  docOf(globalPosition: number) { const b = this.bases; let lo = 0, hi = b.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (b[mid] <= globalPosition) lo = mid; else hi = mid - 1; } return lo; }
  base(ord: number) { return this.bases[ord]; }
  /** Global positions holding the key (ascending), tombstoned articles removed. */
  lookup(h1: number, h2: number, scratch?: { buffer: Uint32Array }): Uint32Array {
    this.lookups += 1;
    const bucket = h1 >>> (32 - SIXWORD_BUCKET_BITS);
    const s = this.directory[bucket], e = this.directory[bucket + 1];
    if (e === s) return new Uint32Array(0);
    const need = (e - s) * 2;
    let buf = scratch?.buffer;
    if (!buf || buf.length < need) { buf = new Uint32Array(Math.max(need, 1024)); if (scratch) scratch.buffer = buf; }
    readFully(this.postingsFd, buf, need * 4, s * 8);
    this.postingsRead += e - s;
    let lo = 0, hi = e - s;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (buf[mid * 2] < h2) lo = mid + 1; else hi = mid; }
    let end = lo; while (end < e - s && buf[end * 2] === h2) end += 1;
    const out = new Uint32Array(end - lo);
    let k = 0;
    for (let x = lo; x < end; x += 1) { const g = buf[x * 2 + 1]; if (this.tombstoned.length && this.tombstoned[this.docOf(g)]) continue; out[k++] = g; }
    return k === out.length ? out : out.slice(0, k);
  }
  /** The article's lane tokens [start, end) read from the pinned token store (end clipped to the article). */
  readTokens(ord: number, start: number, end: number): string[] {
    this.tokenReads += 1;
    const count = this.docs.tokenCounts[ord];
    end = Math.min(end, count); start = Math.max(0, start);
    if (end <= start) return [];
    const c0 = Math.floor(start / SIXWORD_CHECKPOINT), c1 = Math.ceil(end / SIXWORD_CHECKPOINT);
    const ck = this.docs.checkpointStarts[ord];
    const byteStart = this.checkpoints[ck + c0];
    const lastChunk = Math.ceil(count / SIXWORD_CHECKPOINT);
    const byteEnd = c1 >= lastChunk ? this.docs.storeLengths[ord] : this.checkpoints[ck + c1] - 1;
    const bytes = Buffer.allocUnsafe(byteEnd - byteStart);
    readFully(this.tokensFd, bytes, bytes.length, this.docs.storeOffsets[ord] + byteStart);
    const words = bytes.toString("utf8").split("\n");
    return words.slice(start - c0 * SIXWORD_CHECKPOINT, end - c0 * SIXWORD_CHECKPOINT);
  }
  /** The article's whole token list (for audits). */
  readAll(ord: number): string[] { return this.readTokens(ord, 0, this.docs.tokenCounts[ord]); }
  close() { closeSync(this.postingsFd); closeSync(this.tokensFd); }
}
