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
 *
 * EVALUATION-SCOPED FAILURE ATTRIBUTION: this reader instance, and its
 * decoded-shard LRU, are shared across every runSelectiveCorpusShadow()
 * evaluation that reuses the same cached artifact. A shard that fails to load
 * must never be attributed via reader-level, destructively-drained shared
 * state — two evaluations overlapping in time could otherwise race to "steal"
 * the same failure record via a drain, leaving one incorrectly COMPLETED even
 * though it also depended on the failed shard. Instead, getPostings() accepts
 * an OPTIONAL per-evaluation SelectiveCorpusFailureCollector (see below); on
 * any shard failure it observes (whether from a fresh physical read or a
 * cache-fast-pathed one), it records into THAT collector, non-destructively.
 * `recentFailures` below is a SEPARATE, reader-level, NEVER-drained cache used
 * ONLY to avoid a redundant physical re-read of a shard already known bad — it
 * is never itself read by any caller to decide PARTIAL/COMPLETED.
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
  /** Distinct shards this reader instance has EVER observed failing to load,
   *  over its whole life — a reader-level I/O diagnostic, monotonically
   *  non-decreasing (never reset by an evaluation). NOT an evaluation-scoped
   *  count — use a SelectiveCorpusFailureCollector for that. */
  shardLoadFailures: number;
};

export type SelectiveCorpusShardFailureCode = "MISSING" | "UNREADABLE" | "CORRUPT";

/**
 * One packed shard that could not be loaded WHILE SERVING A QUERY (i.e. after
 * the artifact passed initialization), as recorded into ONE evaluation's own
 * SelectiveCorpusFailureCollector. `observations` counts how many getPostings()
 * calls WITHIN THAT EVALUATION hit this shard — never a cross-evaluation count.
 */
export type SelectiveCorpusShardFailure = {
  /** shard number 0-255 (first byte of the winnowed fingerprint hash). */
  shard: number;
  code: SelectiveCorpusShardFailureCode;
  /** bounded, path-free diagnostic string. */
  message: string;
  /** getPostings() calls within THIS evaluation that hit this failed shard. */
  observations: number;
};

/**
 * Evaluation-scoped shard-failure attribution. One collector is created per
 * runSelectiveCorpusShadow() call (see shadow.ts) and threaded through every
 * Stage A / FAMILY_GUARD shard read that evaluation performs — including
 * reads served by an in-flight load a DIFFERENT, concurrently-running
 * evaluation happens to have started (the physical read is shared; each
 * evaluation's own attribution is not). Never destructively drained: reading
 * it twice (e.g. once at a TIMEOUT bailout, once at normal completion) always
 * returns the same evaluation's own accumulated failures.
 */
export interface SelectiveCorpusFailureCollector {
  recordFailure(shard: number, code: SelectiveCorpusShardFailureCode, message: string): void;
  /** This evaluation's own observed failures, ascending by shard number. Safe
   *  to call more than once — never clears anything. */
  getFailures(): SelectiveCorpusShardFailure[];
}

export function createSelectiveCorpusFailureCollector(): SelectiveCorpusFailureCollector {
  const failures = new Map<number, SelectiveCorpusShardFailure>();
  return {
    recordFailure(shard, code, message) {
      const existing = failures.get(shard);
      if (existing) {
        existing.observations += 1;
        return;
      }
      failures.set(shard, {
        shard,
        code,
        message: message.length > 240 ? `${message.slice(0, 237)}...` : message,
        observations: 1,
      });
    },
    getFailures() {
      return [...failures.values()].map((f) => ({ ...f })).sort((a, b) => a.shard - b.shard);
    },
  };
}

/**
 * Decode one packed shard. THROWS on a structurally corrupt / truncated file
 * (a shard that was overwritten or clipped after the artifact was validated) —
 * the caller records that into the calling evaluation's failure collector. A
 * well-formed EMPTY shard is exactly the 4-byte header with entryCount 0 and
 * decodes to `empty()`, never a throw.
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
  /** Reader-level, NEVER-drained I/O-optimization cache: shards already known
   *  to fail, so a report's hundreds of query hashes routing through the same
   *  broken shard trigger ONE physical read attempt, not one per hash. This
   *  is NOT a failure ledger for reporting purposes — see
   *  SelectiveCorpusFailureCollector for that. */
  private readonly recentFailures = new Map<number, { code: SelectiveCorpusShardFailureCode; message: string }>();
  /** Concurrency hardening: shards currently being read+decoded, so two
   *  callers racing on the SAME shard (the cache-miss check happens before
   *  an awaited storage read) share one physical read/decode instead of each
   *  independently starting one — see loadAndCacheShard's own comment. */
  private readonly inFlightLoads = new Map<number, Promise<LoadedShard>>();
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

  /** Records into the reader-level I/O-optimization cache ONLY (never an
   *  evaluation collector — callers of getShard() do that themselves, once
   *  per evaluation, from whatever this method leaves in `recentFailures`). */
  private markShardFailed(shard: number, code: SelectiveCorpusShardFailureCode, message: string): void {
    const bounded = message.length > 240 ? `${message.slice(0, 237)}...` : message;
    if (!this.recentFailures.has(shard)) {
      this.stats.shardLoadFailures += 1;
    }
    this.recentFailures.set(shard, { code, message: bounded });
  }

  /** Load one shard into the LRU (evicting the oldest if full), attributing
   *  any failure into the CALLING evaluation's own collector (if given).
   *  Never throws into the report flow — see getPostings(). */
  private async getShard(shard: number, collector?: SelectiveCorpusFailureCollector): Promise<LoadedShard> {
    const hit = this.cache.get(shard);
    if (hit) {
      this.stats.cacheHits += 1;
      // refresh recency
      this.cache.delete(shard);
      this.cache.set(shard, hit);
      return hit;
    }

    // Already known bad (I/O-optimization fast path, not an evaluation
    // ledger): skip re-hitting storage, but still tell THIS caller's own
    // evaluation collector — every evaluation that depends on a known-bad
    // shard must independently learn that, however many already have.
    const known = this.recentFailures.get(shard);
    if (known) {
      collector?.recordFailure(shard, known.code, known.message);
      throw new Error(`shard ${shard} unavailable (${known.code})`);
    }

    // A concurrent caller (possibly from a DIFFERENT evaluation) may already
    // be reading+decoding this exact shard -- share that single in-flight
    // load rather than starting a second physical read. Only the caller that
    // actually CREATES the in-flight entry owns its lifecycle (sets it up,
    // clears it in `finally`); a caller that finds an existing one just
    // awaits it and reports into its OWN collector below.
    const existing = this.inFlightLoads.get(shard);
    const loadPromise = existing ?? this.loadAndCacheShard(shard);
    if (!existing) this.inFlightLoads.set(shard, loadPromise);
    try {
      return await loadPromise;
    } catch (err) {
      // Whether this caller originated the physical read or joined an
      // already-in-flight one, loadAndCacheShard has already populated
      // `recentFailures` with the reason by the time any awaiter observes
      // the rejection (a promise only settles after its own body has
      // finished running) -- record it into THIS caller's own evaluation
      // collector. Every evaluation waiting on the shared load independently
      // learns its dependency failed, even though only one physical read
      // (and one recentFailures write) ever happened.
      const failed = this.recentFailures.get(shard);
      if (failed) collector?.recordFailure(shard, failed.code, failed.message);
      throw err;
    } finally {
      if (!existing) this.inFlightLoads.delete(shard);
    }
  }

  /** The actual read+decode+cache-population, executed exactly once per
   *  physical shard load no matter how many concurrent getShard() callers
   *  (from one or several evaluations) are waiting on it. Purely mechanical —
   *  no evaluation/collector concept here at all; see getShard(). */
  private async loadAndCacheShard(shard: number): Promise<LoadedShard> {
    this.stats.cacheMisses += 1;
    const key = this.shardKey(shard);
    let raw: Uint8Array;
    try {
      raw = await this.storage.readObject(key);
    } catch (err) {
      if (err instanceof SelectiveCorpusObjectNotFoundError) {
        this.markShardFailed(shard, "MISSING", `shard ${shard} absent at query time (removed after artifact initialization)`);
        throw new Error(`missing shard ${shard}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      this.markShardFailed(shard, "UNREADABLE", `shard ${shard} unreadable (${message})`);
      throw new Error(`unreadable shard ${shard}`);
    }
    this.stats.shardFileReads += 1;
    this.stats.shardBytesRead += raw.length;
    let loaded: LoadedShard;
    try {
      loaded = decodeShard(raw);
    } catch (err) {
      this.markShardFailed(shard, "CORRUPT", `shard ${shard} failed to decode: ${err instanceof Error ? err.message : String(err)}`);
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
   *  occurred) OR when its shard could not be loaded. `collector`, when
   *  given, is the CALLING evaluation's own SelectiveCorpusFailureCollector —
   *  any shard failure this call depends on is attributed there, never to a
   *  shared/reader-level ledger. */
  async getPostings(hexHash: string, collector?: SelectiveCorpusFailureCollector): Promise<Uint32Array | undefined> {
    const shard = Number.parseInt(hexHash.slice(0, 2), 16);
    if (!Number.isFinite(shard) || shard < 0 || shard > 255) return undefined;
    let s: LoadedShard;
    try {
      s = await this.getShard(shard, collector);
    } catch {
      // Missing / unreadable / corrupt shard: Stage A still degrades to "no
      // postings for these hashes" (no throw into the report flow), but the
      // failure has already been attributed into the calling evaluation's
      // own collector above, so the orchestrator can classify THAT
      // evaluation as PARTIAL rather than a silent COMPLETED.
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
    };
  }

  /** Resets the numeric counters only. `recentFailures` (the I/O-optimization
   *  fast-path cache) is deliberately left untouched — a shard genuinely
   *  known bad stays known bad regardless of a stats reset. */
  resetStats(): void {
    this.stats = { shardFileReads: 0, cacheHits: 0, cacheMisses: 0, shardBytesRead: 0, residentBytes: this.stats.residentBytes, peakResidentBytes: this.stats.residentBytes, shardLoadFailures: 0 };
  }
}

/** An in-memory postings accessor with the SAME interface — used ONLY by the
 *  equivalence test to compare against the file-backed reader. Never the
 *  product default. */
export class InMemoryPostingsAccessor {
  constructor(private readonly map: Map<string, Uint32Array>) {}
  /** async only to satisfy SelectiveCorpusPostingsAccessor — this mode has no
   *  I/O to await and can never fail, so `collector` is accepted for
   *  interface compatibility but never used. */
  async getPostings(hexHash: string, _collector?: SelectiveCorpusFailureCollector): Promise<Uint32Array | undefined> {
    return this.map.get(hexHash);
  }
  getStats(): SelectiveCorpusShardReaderStats {
    return { maxShards: Infinity, shardFileReads: 0, cacheHits: this.map.size, cacheMisses: 0, shardBytesRead: 0, residentBytes: -1, peakResidentBytes: -1, loadedShards: 256, shardLoadFailures: 0 };
  }
}

export type SelectiveCorpusPostingsAccessor = {
  getPostings(hexHash: string, collector?: SelectiveCorpusFailureCollector): Promise<Uint32Array | undefined>;
  /** No I/O — pure in-memory accounting, stays synchronous. */
  getStats(): SelectiveCorpusShardReaderStats;
};
