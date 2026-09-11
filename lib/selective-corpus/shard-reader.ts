import { SELECTIVE_CORPUS_HOT_SHARD_LRU } from "./constants";
import { SelectiveCorpusObjectNotFoundError, type SelectiveCorpusStorageAdapter } from "./storage-adapter";

/**
 * Selective Corpus V1 SHADOW slice — file-backed packed-shard reader.
 *
 * Replaces the full in-memory Map<hash, Uint32Array> (which expanded ~26 MB of
 * packed bytes to ~1 GB RSS because of per-entry Map / string / typed-array
 * overhead) with a bounded hot-shard LRU:
 *
 *   query hashes -> group by shard (first hash byte) -> for each needed shard,
 *   load ONLY that shard file, decode it once into dense parallel arrays,
 *   binary-search the sorted hash array -> return the entry's postings.
 *
 * NO artifact format change. The existing frozen shard files
 * (shard-<sss>.bin: [4B uint32LE entryCount] then per entry
 * [8B hash BE][varint postingCount][delta-varint doc ordinals asc], entries
 * ascending by hash) are read as-is. No sidecar file is generated — the sorted
 * key array + posting offsets are derived in memory the first time a shard
 * enters the LRU and freed when it is evicted, so at most `maxShards` shards'
 * worth of postings are ever resident.
 *
 * Exact Stage-A semantics preserved: same postings, same order, same stop-hash
 * exclusion (stop hashes are simply absent from the shard files, as before).
 */

type LoadedShard = {
  /** entryCount hash-high words, ascending (paired with lo). */
  hi: Uint32Array;
  /** entryCount hash-low words. */
  lo: Uint32Array;
  /** entryCount+1 offsets into `postings`; entry k's ordinals are [postStart[k], postStart[k+1]). */
  postStart: Uint32Array;
  /** all doc ordinals for this shard, concatenated in entry order. */
  postings: Uint32Array;
  /** approximate resident bytes. */
  bytes: number;
};

export type SelectiveCorpusShardReaderStats = {
  maxShards: number;
  shardFileReads: number;
  cacheHits: number;
  cacheMisses: number;
  shardBytesRead: number;
  residentBytes: number;
  peakResidentBytes: number;
  loadedShards: number;
  /** Shard-failure records opened over this reader's whole life (monotonic; a
   *  drain does not reset it, and a shard re-observed after a drain counts
   *  again). */
  shardLoadFailures: number;
  /** Shards sitting in the not-yet-drained failure ledger right now. */
  pendingShardFailures: number;
};

export type SelectiveCorpusShardFailureCode = "MISSING" | "UNREADABLE" | "CORRUPT";

/**
 * One packed shard that could not be loaded WHILE SERVING A QUERY (i.e. after
 * the artifact passed initialization). Surfaced through
 * SelectiveCorpusShardReader.takeShardFailures() so the shadow evaluator can
 * emit explicit PARTIAL/DEGRADED telemetry instead of silently treating that
 * shard's fingerprints as an ordinary "no postings" miss.
 */
export type SelectiveCorpusShardFailure = {
  /** shard number 0-255 (first byte of the winnowed fingerprint hash). */
  shard: number;
  code: SelectiveCorpusShardFailureCode;
  /** bounded, path-free diagnostic string. */
  message: string;
  /** getPostings() calls that hit this failed shard before the drain. */
  observations: number;
};

/**
 * Decode one packed shard. THROWS on a structurally corrupt / truncated file
 * (a shard that was overwritten or clipped after the artifact was validated) —
 * the caller records that as a SelectiveCorpusShardFailure. A well-formed EMPTY
 * shard is exactly the 4-byte header with entryCount 0 and decodes to `empty()`,
 * never a throw.
 */
function decodeShard(buf: Uint8Array): LoadedShard {
  const empty = (): LoadedShard => ({ hi: new Uint32Array(0), lo: new Uint32Array(0), postStart: new Uint32Array(1), postings: new Uint32Array(0), bytes: 0 });
  // A file too small to even hold the 4-byte entry-count header is truncated —
  // NOT an empty shard.
  if (buf.length < 4) throw new Error(`shard truncated: ${buf.length} bytes, below the 4-byte header`);
  const entryCount = (buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24)) >>> 0;
  if (entryCount === 0) return empty();
  // Header sanity: every entry is >= 8 (hash) + 1 (posting-count varint) bytes,
  // so a claimed entryCount that cannot physically fit means a corrupt header.
  if (4 + entryCount * 9 > buf.length) {
    throw new Error(`shard header claims ${entryCount} entries, impossible in ${buf.length} bytes`);
  }

  // ---- pass 1: count total postings ----
  let total = 0;
  {
    let j = 4;
    for (let e = 0; e < entryCount; e++) {
      j += 8; // hash
      let sh = 0;
      let count = 0;
      let b: number;
      do {
        b = buf[j++];
        count |= (b & 0x7f) << sh;
        sh += 7;
      } while (b & 0x80);
      count >>>= 0;
      total += count;
      for (let k = 0; k < count; k++) {
        while (buf[j++] & 0x80) {
          /* skip continuation bytes */
        }
      }
    }
    // A truncated varint stream drives `j` past the end of the buffer (reads of
    // buf[j] past the end are undefined, so every loop terminates with j > length).
    if (j > buf.length) throw new Error("shard varint stream overran the buffer (truncated/corrupt)");
  }
  // Each posting delta is >= 1 byte, so more claimed postings than the file has
  // bytes means the varint stream is garbage (and guards the Uint32Array alloc).
  if (total > buf.length) throw new Error(`shard claims ${total} postings in only ${buf.length} bytes`);

  // ---- pass 2: fill ----
  const hi = new Uint32Array(entryCount);
  const lo = new Uint32Array(entryCount);
  const postStart = new Uint32Array(entryCount + 1);
  const postings = new Uint32Array(total);
  let i = 4;
  let p = 0;
  const readVarint = (): number => {
    let sh = 0;
    let r = 0;
    let b: number;
    do {
      b = buf[i++];
      r |= (b & 0x7f) << sh;
      sh += 7;
    } while (b & 0x80);
    return r >>> 0;
  };
  for (let e = 0; e < entryCount; e++) {
    hi[e] = ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0;
    lo[e] = ((buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7]) >>> 0;
    i += 8;
    const count = readVarint();
    postStart[e] = p;
    let prev = 0;
    for (let k = 0; k < count; k++) {
      prev += readVarint();
      postings[p++] = prev;
    }
  }
  postStart[entryCount] = p;
  const bytes = hi.byteLength + lo.byteLength + postStart.byteLength + postings.byteLength;
  return { hi, lo, postStart, postings, bytes };
}

export class SelectiveCorpusShardReader {
  private readonly storage: SelectiveCorpusStorageAdapter;
  private readonly packedPrefix: string;
  private readonly maxShards: number;
  private readonly cache = new Map<number, LoadedShard>(); // insertion-ordered LRU
  /** Per-evaluation ledger of shards that failed to load at query time. Drained
   *  by takeShardFailures(). Failed loads NEVER enter `cache`, so a shard that
   *  is still broken is re-observed by the next evaluation that needs it. */
  private readonly shardFailures = new Map<number, SelectiveCorpusShardFailure>();
  private stats = {
    shardFileReads: 0,
    cacheHits: 0,
    cacheMisses: 0,
    shardBytesRead: 0,
    residentBytes: 0,
    peakResidentBytes: 0,
    shardLoadFailures: 0,
  };

  /** `packedPrefix` is an artifact-relative key prefix (default "packed") —
   *  never an absolute path; resolved against `storage`'s own root. */
  constructor(storage: SelectiveCorpusStorageAdapter, packedPrefix: string = "packed", maxShards: number = SELECTIVE_CORPUS_HOT_SHARD_LRU) {
    this.storage = storage;
    this.packedPrefix = packedPrefix;
    this.maxShards = Math.max(1, maxShards);
  }

  private shardKey(shard: number): string {
    return `${this.packedPrefix}/shard-${String(shard).padStart(3, "0")}.bin`;
  }

  private recordShardFailure(shard: number, code: SelectiveCorpusShardFailureCode, message: string): void {
    const existing = this.shardFailures.get(shard);
    if (existing) {
      existing.observations += 1;
      return;
    }
    this.shardFailures.set(shard, {
      shard,
      code,
      message: message.length > 240 ? `${message.slice(0, 237)}...` : message,
      observations: 1,
    });
    this.stats.shardLoadFailures += 1;
  }

  /**
   * Drain the per-evaluation shard-failure ledger: the shards that could not be
   * loaded at query time since the last drain (ascending), then clear it so the
   * next evaluation over this cached reader starts clean. The shadow
   * orchestrator calls this once per evaluation to decide COMPLETED vs PARTIAL.
   */
  takeShardFailures(): SelectiveCorpusShardFailure[] {
    const out = [...this.shardFailures.values()]
      .map((f) => ({ ...f }))
      .sort((a, b) => a.shard - b.shard);
    this.shardFailures.clear();
    return out;
  }

  /** Load one shard into the LRU (evicting the oldest if full). Throws when the
   *  shard file is missing / unreadable / structurally corrupt AND records the
   *  reason in the per-evaluation ledger (takeShardFailures). The caller
   *  (getPostings) still returns undefined so Stage A degrades WITHOUT throwing
   *  into the report flow — but the failure is no longer invisible. */
  private async getShard(shard: number): Promise<LoadedShard> {
    const hit = this.cache.get(shard);
    if (hit) {
      this.stats.cacheHits += 1;
      // refresh recency
      this.cache.delete(shard);
      this.cache.set(shard, hit);
      return hit;
    }

    // Already observed bad in this drain-window: fail the same way without
    // re-hitting storage (a report's hundreds of query hashes would otherwise
    // re-request the same missing shard once per hash).
    const known = this.shardFailures.get(shard);
    if (known) {
      known.observations += 1;
      throw new Error(`shard ${shard} unavailable (${known.code})`);
    }

    this.stats.cacheMisses += 1;
    const key = this.shardKey(shard);
    let raw: Uint8Array;
    try {
      raw = await this.storage.readObject(key);
    } catch (err) {
      if (err instanceof SelectiveCorpusObjectNotFoundError) {
        this.recordShardFailure(shard, "MISSING", `shard ${shard} absent at query time (removed after artifact initialization)`);
        throw new Error(`missing shard ${shard}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      this.recordShardFailure(shard, "UNREADABLE", `shard ${shard} unreadable (${message})`);
      throw new Error(`unreadable shard ${shard}`);
    }
    this.stats.shardFileReads += 1;
    this.stats.shardBytesRead += raw.length;
    let loaded: LoadedShard;
    try {
      loaded = decodeShard(raw);
    } catch (err) {
      this.recordShardFailure(shard, "CORRUPT", `shard ${shard} failed to decode: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error(`corrupt shard ${shard}`);
    }
    this.cache.set(shard, loaded);
    this.stats.residentBytes += loaded.bytes;
    while (this.cache.size > this.maxShards) {
      const oldest = this.cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      const ev = this.cache.get(oldest);
      if (ev) this.stats.residentBytes -= ev.bytes;
      this.cache.delete(oldest);
    }
    if (this.stats.residentBytes > this.stats.peakResidentBytes) {
      this.stats.peakResidentBytes = this.stats.residentBytes;
    }
    return loaded;
  }

  private static hiLo(hexHash: string): { hi: number; lo: number } {
    return {
      hi: Number.parseInt(hexHash.slice(0, 8), 16) >>> 0,
      lo: Number.parseInt(hexHash.slice(8, 16), 16) >>> 0,
    };
  }

  /** Doc ordinals sharing this exact winnowed fingerprint. undefined when the
   *  hash is not in the packed index (a stop hash, or a hash that never
   *  occurred). Byte-identical to the old Map's `.get(hash)`. */
  async getPostings(hexHash: string): Promise<Uint32Array | undefined> {
    const shard = Number.parseInt(hexHash.slice(0, 2), 16);
    if (!Number.isFinite(shard) || shard < 0 || shard > 255) return undefined;
    let s: LoadedShard;
    try {
      s = await this.getShard(shard);
    } catch {
      // Missing / unreadable / corrupt shard: Stage A still degrades to "no
      // postings for these hashes" (no throw into the report flow), but the
      // failure is now recorded in the ledger so the orchestrator classifies the
      // whole evaluation as PARTIAL rather than a silent COMPLETED. See
      // takeShardFailures().
      return undefined;
    }
    const { hi, lo } = SelectiveCorpusShardReader.hiLo(hexHash);
    // binary search the ascending (hi,lo) key array
    let a = 0;
    let b = s.hi.length - 1;
    while (a <= b) {
      const m = (a + b) >>> 1;
      const mh = s.hi[m];
      if (mh < hi) a = m + 1;
      else if (mh > hi) b = m - 1;
      else {
        const ml = s.lo[m];
        if (ml < lo) a = m + 1;
        else if (ml > lo) b = m - 1;
        else return s.postings.subarray(s.postStart[m], s.postStart[m + 1]);
      }
    }
    return undefined;
  }

  getStats(): SelectiveCorpusShardReaderStats {
    return {
      maxShards: this.maxShards,
      shardFileReads: this.stats.shardFileReads,
      cacheHits: this.stats.cacheHits,
      cacheMisses: this.stats.cacheMisses,
      shardBytesRead: this.stats.shardBytesRead,
      residentBytes: this.stats.residentBytes,
      peakResidentBytes: this.stats.peakResidentBytes,
      loadedShards: this.cache.size,
      shardLoadFailures: this.stats.shardLoadFailures,
      pendingShardFailures: this.shardFailures.size,
    };
  }

  resetStats(): void {
    this.stats = { shardFileReads: 0, cacheHits: 0, cacheMisses: 0, shardBytesRead: 0, residentBytes: this.stats.residentBytes, peakResidentBytes: this.stats.residentBytes, shardLoadFailures: 0 };
    this.shardFailures.clear();
  }
}

/** An in-memory postings accessor with the SAME interface — used ONLY by the
 *  equivalence test to compare against the file-backed reader. Never the
 *  product default. */
export class InMemoryPostingsAccessor {
  constructor(private readonly map: Map<string, Uint32Array>) {}
  /** async only to satisfy SelectiveCorpusPostingsAccessor — this mode has no I/O to await. */
  async getPostings(hexHash: string): Promise<Uint32Array | undefined> {
    return this.map.get(hexHash);
  }
  getStats(): SelectiveCorpusShardReaderStats {
    return { maxShards: Infinity, shardFileReads: 0, cacheHits: this.map.size, cacheMisses: 0, shardBytesRead: 0, residentBytes: -1, peakResidentBytes: -1, loadedShards: 256, shardLoadFailures: 0, pendingShardFailures: 0 };
  }
  /** The in-memory Map has no shard files and cannot partially fail. */
  takeShardFailures(): SelectiveCorpusShardFailure[] {
    return [];
  }
}

export type SelectiveCorpusPostingsAccessor = {
  getPostings(hexHash: string): Promise<Uint32Array | undefined>;
  /** No I/O — pure in-memory accounting, stays synchronous. */
  getStats(): SelectiveCorpusShardReaderStats;
  /** No I/O — pure ledger drain, stays synchronous. */
  takeShardFailures(): SelectiveCorpusShardFailure[];
};
