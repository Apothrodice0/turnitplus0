import type { SelectiveCorpusArtifact } from "./artifact";
import { winnowSubmissionFingerprints } from "./fingerprint";
import {
  SELECTIVE_CORPUS_STAGE_A_TOP_K,
  SELECTIVE_CORPUS_STAGE_A_MAX_POSTING_ROWS,
  SELECTIVE_CORPUS_STAGE_A_MAX_CANDIDATES,
  SELECTIVE_CORPUS_STAGE_A_SHARD_FETCH_CONCURRENCY,
} from "./constants";
import type { SelectiveCorpusFailureCollector } from "./shard-reader";

/**
 * Selective Corpus V1 SHADOW slice — bounded Stage A candidate discovery.
 *
 * FINGERPRINT HITS NEVER SCORE. This tallies which corpus documents share
 * winnowed fingerprints with the (stop-set-filtered, capped) submission
 * fingerprint set and returns the top-K by a DF-discounted weight — the SAME
 * `w = 1 / log2(2 + postingCount)` discount and `weight desc, matched desc,
 * ordinal asc` ordering the mixed-fulltext-index benchmark used. All actual
 * scoring is lib/selective-corpus/verify.ts running the unmodified matcher over
 * the texts a top-K ordinal points at.
 *
 * REMOTE-I/O OPTIMIZATION: a submission's winnowed fingerprints can span
 * dozens of distinct packed shards (representative natural manuscripts touch
 * 77-85; real remote evidence showed even a 35-shard submission timing out
 * over the 6s budget when each new shard required its own sequential network
 * round trip). This function prefetches shards with bounded concurrency
 * BEFORE aggregating their postings — but does so WINDOWED, one bounded
 * window of shards at a time (see WINDOWED PREFETCH below), never
 * unconditionally prefetching every distinct shard up front.
 *
 * WHY WINDOWED: an earlier version of this optimization prefetched ALL
 * distinct shards a query needed in one unbounded pass before aggregating
 * any of them. That is only safe while the total distinct-shard fanout fits
 * inside the postings accessor's own cache capacity (getStats().maxShards).
 * Once fanout exceeds that capacity, the prefetch pass's own later shards
 * evict its own earlier shards from the LRU before the aggregation pass ever
 * reaches them — proven, empirically, to double EVERY shard's physical read
 * count (not just the excess beyond capacity) once fanout > capacity, the
 * exact opposite of this optimization's purpose. Windowing bounds each
 * prefetch batch to at most the accessor's own configured capacity, so a
 * window's shards can never evict each other; each window is fully
 * aggregated (in the original, byte-for-byte-unchanged per-hash logic and
 * order) before the next window's prefetch begins. Candidate ranking,
 * truncation, and stop-hash counting are therefore identical to before this
 * optimization, independent of which shard fetch physically completes first
 * over the network within a window — see runWithBoundedConcurrency below.
 */

/** Runs `worker` over every item in `items` with at most `concurrency`
 *  invocations in flight at once — a pure scheduling primitive with no
 *  opinion about what `worker` does or the order its OWN side effects land
 *  in. `worker` must never reject (true here: SelectiveCorpusPostingsAccessor
 *  implementations never throw from getPostings — see shard-reader.ts).
 *  Exported so shadow.ts's Stage-B source-text prefetch can reuse this exact,
 *  already-proven primitive rather than duplicating a second one. */
export async function runWithBoundedConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
}

export type SelectiveCorpusStageACandidate = {
  ordinal: number;
  matchedFingerprints: number;
  weight: number;
};

export type SelectiveCorpusStageAResult = {
  ranked: SelectiveCorpusStageACandidate[];
  topK: SelectiveCorpusStageACandidate[];
  queryFingerprintsUsed: number;
  /**
   * Metadata-only, threaded straight through from winnowSubmissionFingerprints
   * (lib/selective-corpus/fingerprint.ts) — NEVER recomputed here. Distinct
   * from `truncated` below: `truncated` means Stage A's own posting/candidate
   * ENUMERATION was cut short by maxPostingRows/maxCandidates while scanning
   * the (already-capped) query fingerprint set against the corpus index.
   * queryFingerprintsRawCount/queryFingerprintsTrimmed instead describe
   * whether the SUBMISSION'S OWN winnowed fingerprint set, before any corpus
   * lookup ever started, exceeded SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS —
   * an entirely earlier, independent concept. queryFingerprintsUsed is the
   * POST-cap retained count (== fingerprints.length); queryFingerprintsRawCount
   * is the PRE-cap distinct count, so the two together tell you exactly how
   * much (if any) of the submission's own fingerprint set was clipped.
   */
  queryFingerprintsRawCount: number;
  queryFingerprintsTrimmed: boolean;
  stoppedFingerprints: number;
  postingRowsTallied: number;
  truncated: boolean;
  rankByOrdinal: Map<number, number>;
};

export async function selectiveCorpusStageA(
  submissionText: string,
  artifact: SelectiveCorpusArtifact,
  opts: { topK?: number; maxPostingRows?: number; maxCandidates?: number; shardFetchConcurrency?: number } = {},
  /** The CALLING evaluation's own failure collector (see shard-reader.ts) —
   *  any shard this call fails to read is attributed there, never to shared
   *  reader-level state. Optional so existing direct callers (equivalence
   *  tests) that do not care about degradation attribution are unaffected. */
  collector?: SelectiveCorpusFailureCollector,
): Promise<SelectiveCorpusStageAResult> {
  const topK = opts.topK ?? SELECTIVE_CORPUS_STAGE_A_TOP_K;
  const maxPostingRows = opts.maxPostingRows ?? SELECTIVE_CORPUS_STAGE_A_MAX_POSTING_ROWS;
  const maxCandidates = opts.maxCandidates ?? SELECTIVE_CORPUS_STAGE_A_MAX_CANDIDATES;
  const shardFetchConcurrency = opts.shardFetchConcurrency ?? SELECTIVE_CORPUS_STAGE_A_SHARD_FETCH_CONCURRENCY;

  const { fingerprints, rawCount: queryFingerprintsRawCount, trimmed: queryFingerprintsTrimmed } = winnowSubmissionFingerprints(submissionText);

  let postingRowsTallied = 0;
  let stoppedFingerprints = 0;
  let truncated = false;
  const weightByDoc = new Map<number, number>();
  const matchedByDoc = new Map<number, number>();

  // Sort is by hex hash, which groups by first byte = shard; stable and
  // deterministic. Tally order does not affect the final ranking (weight +
  // matched + ordinal tie-break).
  const orderedFingerprints = [...fingerprints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Group the non-stopped fingerprints by shard, preserving the SAME
  // ascending order (a hash-sorted list is already contiguous by its first
  // byte, so grouping-while-scanning reproduces the flat sorted+filtered
  // sequence exactly — shardOrder lists shards ascending, and each shard's
  // own hash list preserves its relative order within that shard).
  // stoppedFingerprints is tallied here, in the same place/order it always
  // was, before this grouping existed.
  const shardOrder: string[] = [];
  const hashesByShard = new Map<string, string[]>();
  for (const h of orderedFingerprints) {
    if (artifact.stopHashes.has(h)) {
      stoppedFingerprints += 1;
      continue;
    }
    const shard = h.slice(0, 2);
    let hashes = hashesByShard.get(shard);
    if (!hashes) {
      hashes = [];
      hashesByShard.set(shard, hashes);
      shardOrder.push(shard);
    }
    hashes.push(h);
  }

  // ---- WINDOWED PREFETCH + ORDERED AGGREGATION ----
  // Window size is derived from the postings accessor's OWN configured cache
  // capacity (getStats().maxShards — Infinity for the in-memory/equivalence
  // -test mode, which never evicts, so everything is one window there) —
  // never a hardcoded assumption. A window's shards can therefore never evict
  // each other: at most `windowSize` shards are ever prefetched before that
  // exact same set is fully aggregated. Each window's aggregation loop below
  // is the ORIGINAL, byte-for-byte-unchanged per-hash logic; only the outer
  // windowing (and the one-time shard-grouping above) is new. A row-cap
  // truncation still stops EVERYTHING immediately (the original single flat
  // loop's `break`), including any remaining/later window's prefetch —
  // `outer` labels exactly that scope.
  const cacheCapacity = artifact.postingsAccessor.getStats().maxShards;
  const windowSize = Number.isFinite(cacheCapacity)
    ? Math.max(1, Math.min(cacheCapacity, shardOrder.length || 1))
    : shardOrder.length || 1;

  outer: for (let start = 0; start < shardOrder.length; start += windowSize) {
    const windowShards = shardOrder.slice(start, start + windowSize);

    // Prefetch this window only — one representative hash per shard is
    // enough to force it into cache; the returned postings are discarded on
    // purpose. Any shard-read failure is still attributed to `collector`
    // exactly as it always was.
    await runWithBoundedConcurrency(windowShards, shardFetchConcurrency, async (shard) => {
      const hashes = hashesByShard.get(shard)!;
      await artifact.postingsAccessor.getPostings(hashes[0], collector);
    });

    // Aggregate every hash in this window, in the original ascending order —
    // every shard here is already cached (or already recorded-failed) by the
    // prefetch immediately above, so each getPostings() call here is an
    // ordinary cache hit rather than a fresh network round trip.
    for (const shard of windowShards) {
      for (const h of hashesByShard.get(shard)!) {
        const arr = await artifact.postingsAccessor.getPostings(h, collector);
        if (!arr) continue;
        postingRowsTallied += arr.length;
        if (postingRowsTallied > maxPostingRows) {
          truncated = true;
          break outer;
        }
        const w = 1 / Math.log2(2 + arr.length);
        for (const ord of arr) {
          if (!matchedByDoc.has(ord) && matchedByDoc.size >= maxCandidates) {
            truncated = true;
            continue;
          }
          matchedByDoc.set(ord, (matchedByDoc.get(ord) ?? 0) + 1);
          weightByDoc.set(ord, (weightByDoc.get(ord) ?? 0) + w);
        }
      }
    }
  }

  const ranked: SelectiveCorpusStageACandidate[] = [...matchedByDoc.keys()]
    .map((ordinal) => ({
      ordinal,
      matchedFingerprints: matchedByDoc.get(ordinal) ?? 0,
      weight: weightByDoc.get(ordinal) ?? 0,
    }))
    .sort((a, b) => b.weight - a.weight || b.matchedFingerprints - a.matchedFingerprints || a.ordinal - b.ordinal);

  const rankByOrdinal = new Map<number, number>();
  ranked.forEach((c, i) => rankByOrdinal.set(c.ordinal, i));

  return {
    ranked,
    topK: ranked.slice(0, topK),
    queryFingerprintsUsed: fingerprints.length,
    queryFingerprintsRawCount,
    queryFingerprintsTrimmed,
    stoppedFingerprints,
    postingRowsTallied,
    truncated,
    rankByOrdinal,
  };
}
