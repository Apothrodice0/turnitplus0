/**
 * Corpus Engine v1 — the reader's dictionary block cache.
 *
 * A lookup reads the dictionary blocks that can hold the query's keys. At 100k
 * documents a query touches thousands of blocks across a generation's
 * segments, and the original per-segment cache (decoded blocks with bigint
 * keys, counted in blocks, 2,048 per segment) thrashed: 153 / 937 ms per
 * lookup (p50 / p95) against 11.8 / 48 ms with every block resident. This
 * cache keeps each block the reader has read and verified in a COMPACT
 * decoded form — one Uint32Array per block:
 *
 *   [ keyHi x n | keyLo x n | df x n | postingsOffset - blockPostingsOffset x n | postingsLength x n ]
 *
 * 20 bytes per dictionary entry, no bigint, searched by binary search. It is
 *
 *   - bounded by BYTES (maxBytes) and shared by every segment of the reader
 *     that owns it — one budget per generation, not one per segment;
 *   - least-recently-used, in the insertion order of a Map with numeric keys.
 *
 * GENERATION-AWARE. A cache is bound to one generation identity (generation id
 * + logical manifest hash). Binding it to another identity empties it, and a
 * reader whose identity is not the bound one neither reads from it nor writes
 * to it — it runs uncached. Within the binding, entries are keyed by
 * (segment, block); segment ids are content addresses, so a key can only ever
 * name the bytes it was filled from.
 *
 * NOT A CORRECTNESS DEPENDENCY. A block enters the cache only after it was
 * read and verified exactly as on the uncached path (length, crc32, clean
 * decode, first key), and a lookup returns the same answer with or without it;
 * tests/corpus-engine-dictionary-cache.test.mjs proves that at every budget.
 *
 * No process-wide instance exists: whoever opens a reader owns its cache.
 */

/** Bookkeeping charged per cached block on top of its typed array (Map entry, array object). */
export const DICTIONARY_CACHE_ENTRY_OVERHEAD_BYTES = 128;

/** What a reader gets when its caller does not say. The 100k benchmark's whole working set is ~250 MiB in this form. */
export const DEFAULT_DICTIONARY_CACHE_BYTES = 512 * 1024 * 1024;

export type DictionaryCacheStats = {
  boundIdentity: string | null;
  maxBytes: number;
  residentBytes: number;
  peakResidentBytes: number;
  entries: number;
  hits: number;
  misses: number;
  insertions: number;
  evictions: number;
  /** Lookups refused because the asking reader's identity is not the bound one. */
  identityBypasses: number;
  /** How many times binding a new identity emptied the cache. */
  invalidations: number;
};

/** Blocks per segment the numeric key leaves room for (2^32), far above any segment's block count. */
const BLOCK_KEY_SPACE = 4294967296;

export class DictionaryBlockCache {
  private readonly entries = new Map<number, Uint32Array>();
  private readonly segmentSlots = new Map<string, number>();
  private identity: string | null = null;
  private residentBytes = 0;
  private peakResidentBytes = 0;
  private hits = 0;
  private misses = 0;
  private insertions = 0;
  private evictions = 0;
  private identityBypasses = 0;
  private invalidations = 0;

  constructor(readonly maxBytes: number = DEFAULT_DICTIONARY_CACHE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("dictionary cache maxBytes must be a non-negative integer");
  }

  /** The identity key a reader of `generationId` / `logicalManifestSha256` binds with. */
  static identityOf(generationId: string, logicalManifestSha256: string): string {
    return `${generationId}:${logicalManifestSha256}`;
  }

  /** Serve `identity` from now on; anything cached for another identity is dropped. */
  bind(identity: string) {
    if (this.identity === identity) return;
    if (this.identity !== null) this.invalidations += 1;
    this.clear();
    this.identity = identity;
  }

  get boundIdentity() {
    return this.identity;
  }

  clear() {
    this.entries.clear();
    this.segmentSlots.clear();
    this.residentBytes = 0;
  }

  /** A small number standing for `segmentId` in this binding's keys. */
  private slotOf(segmentId: string): number {
    let slot = this.segmentSlots.get(segmentId);
    if (slot === undefined) {
      slot = this.segmentSlots.size;
      this.segmentSlots.set(segmentId, slot);
    }
    return slot;
  }

  get(identity: string, segmentId: string, block: number): Uint32Array | undefined {
    if (identity !== this.identity) {
      this.identityBypasses += 1;
      return undefined;
    }
    const key = this.slotOf(segmentId) * BLOCK_KEY_SPACE + block;
    const compact = this.entries.get(key);
    if (!compact) {
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, compact);
    this.hits += 1;
    return compact;
  }

  set(identity: string, segmentId: string, block: number, compact: Uint32Array) {
    if (identity !== this.identity) return;
    const cost = compact.byteLength + DICTIONARY_CACHE_ENTRY_OVERHEAD_BYTES;
    if (cost > this.maxBytes) return;
    const key = this.slotOf(segmentId) * BLOCK_KEY_SPACE + block;
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.residentBytes -= previous.byteLength + DICTIONARY_CACHE_ENTRY_OVERHEAD_BYTES;
    }
    while (this.residentBytes + cost > this.maxBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value as number;
      this.residentBytes -= (this.entries.get(oldest) as Uint32Array).byteLength + DICTIONARY_CACHE_ENTRY_OVERHEAD_BYTES;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
    this.entries.set(key, compact);
    this.residentBytes += cost;
    this.insertions += 1;
    if (this.residentBytes > this.peakResidentBytes) this.peakResidentBytes = this.residentBytes;
  }

  stats(): DictionaryCacheStats {
    return {
      boundIdentity: this.identity,
      maxBytes: this.maxBytes,
      residentBytes: this.residentBytes,
      peakResidentBytes: this.peakResidentBytes,
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      insertions: this.insertions,
      evictions: this.evictions,
      identityBypasses: this.identityBypasses,
      invalidations: this.invalidations,
    };
  }
}

// ── the compact block ───────────────────────────────────────────────────────

const HALF_SHIFT = BigInt(32);
const HALF_MASK = BigInt(0xffffffff);
const MAX_U32 = 0xffffffff;

/**
 * A verified decoded block in compact form; null when it cannot be represented
 * (a block whose postings span more than 4 GiB — never in practice; such a
 * block is simply served uncached).
 */
export function compactDictionaryBlock(keys: readonly bigint[], dfs: ArrayLike<number>, offsets: ArrayLike<number>, lengths: ArrayLike<number>, blockPostingsOffset: number): Uint32Array | null {
  const n = keys.length;
  const compact = new Uint32Array(5 * n);
  for (let entry = 0; entry < n; entry += 1) {
    const relative = offsets[entry] - blockPostingsOffset;
    if (relative < 0 || relative > MAX_U32 || lengths[entry] > MAX_U32 || dfs[entry] > MAX_U32) return null;
    compact[entry] = Number(keys[entry] >> HALF_SHIFT);
    compact[n + entry] = Number(keys[entry] & HALF_MASK);
    compact[2 * n + entry] = dfs[entry];
    compact[3 * n + entry] = relative;
    compact[4 * n + entry] = lengths[entry];
  }
  return compact;
}

/** Index of the entry with key (hi, lo) in a compact block, or -1. */
export function findInCompactBlock(compact: Uint32Array, hi: number, lo: number): number {
  const n = compact.length / 5;
  let low = 0;
  let high = n - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const middleHi = compact[middle];
    if (middleHi === hi) {
      const middleLo = compact[n + middle];
      if (middleLo === lo) return middle;
      if (middleLo < lo) low = middle + 1;
      else high = middle - 1;
    } else if (middleHi < hi) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

const halvesOf = new WeakMap<readonly bigint[], { hi: Uint32Array; lo: Uint32Array }>();

/** A sorted key list's uint32 halves, computed once per list (a retrieval hands the same list to every segment). */
export function keyHalves(sortedKeys: readonly bigint[]): { hi: Uint32Array; lo: Uint32Array } {
  let halves = halvesOf.get(sortedKeys);
  if (!halves) {
    halves = { hi: new Uint32Array(sortedKeys.length), lo: new Uint32Array(sortedKeys.length) };
    for (let index = 0; index < sortedKeys.length; index += 1) {
      halves.hi[index] = Number(sortedKeys[index] >> HALF_SHIFT);
      halves.lo[index] = Number(sortedKeys[index] & HALF_MASK);
    }
    halvesOf.set(sortedKeys, halves);
  }
  return halves;
}
