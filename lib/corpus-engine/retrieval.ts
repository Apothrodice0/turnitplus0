import { performance } from "node:perf_hooks";
import { computeQueryFingerprints, type QueryFingerprints } from "./fingerprints";
import { docIdToDecimal } from "./ids";
import type { CorpusGenerationReader, CorpusReaderIdentity, SegmentSlot } from "./reader";
import { toSegmentError, type DictionaryHit, type SegmentReader } from "./segment";
import { CANDIDATE_RANKING_POLICY_VERSION, RETRIEVAL_PROTOCOL_VERSION } from "./versions";

/**
 * Corpus Engine v1 — candidate retrieval (retrieval-protocol-v1) and its
 * ranking policy (candidate-ranking-v1).
 *
 * THIS LAYER ONLY NOMINATES. It answers "which source documents are worth
 * verifying". It never says a position is verified and never produces a
 * similarity number: a fingerprint hit is not evidence, and every candidate it
 * returns is handed, with its real source text, to the existing verifier.
 *
 * PROTOCOL — two phases, each sent to every active physical partition:
 *
 *   1. lookup : for the query's fingerprints, each partition answers "document
 *               frequency here + where the postings are". The coordinator SUMS
 *               them into the generation-wide df of every fingerprint.
 *   2. score  : with those global dfs (so every partition weighs a fingerprint
 *               identically), each partition computes the COMPLETE score of
 *               each of its own documents and returns bounded top lists.
 *
 * A document lives in exactly one partition, so its score is never split
 * across machines and never reassembled from other partitions' local top-N.
 * The coordinator only merges already-complete scores, deterministically.
 * In Phase 1 all partitions are in one process; the two calls are the seam a
 * network hop would go through.
 *
 * RANKING — rarity-aware and region-aware:
 *
 *   weight(f)        = 1 / log2(2 + df(f))     (the discount Stage A already uses)
 *   global(d)        = sum of weight(f) over distinct query fingerprints f in d
 *   region_r(d)      = the same sum restricted to fingerprints occurring in
 *                      submission region r (regionWords words wide)
 *
 * A whole-document total alone lets a few dominant sources (and their
 * near-copies) fill the budget while a source that contributed one short
 * passage never gets verified. So there is one list per region as well as the
 * global list, and the budget is filled by DEPTH: the best of every list, then
 * the second best of every list, and so on — global first, then regions in
 * order — skipping documents already taken. The top source of every region is
 * therefore inside the first (regions + 1) candidates whatever else matched.
 *
 * DISCOVERY-ONLY SUPPRESSION: a fingerprint whose global df exceeds
 * maxDiscoveryDocumentFrequency is not used to nominate. That can only change
 * WHICH candidates are fetched. It is invisible to verification: a retrieved
 * candidate's text goes to the verifier whole, common phrases included.
 *
 * COMPLETION: the result is COMPLETE only if every active segment answered
 * both phases. If any segment was unopenable, unreadable or corrupt the result
 * is PARTIAL and lists exactly what was not searched; if nothing could be
 * searched it is FAILED. An incomplete search is never returned as COMPLETE.
 */

export type CandidateRankingPolicy = {
  version: typeof CANDIDATE_RANKING_POLICY_VERSION;
  /** Width of a submission region in words. */
  regionWords: number;
  /** How deep each region's list goes. The global list always goes to candidateBudget. */
  regionListDepth: number;
  /** Maximum candidates returned (K). */
  candidateBudget: number;
  /** Fingerprints with a generation-wide df above this do not nominate; null = no suppression. */
  maxDiscoveryDocumentFrequency: number | null;
  /** A document needs at least this many distinct fingerprint hits to be a candidate. */
  minimumFingerprintHits: number;
  /** false = rank by the global list only (kept so region-awareness can be measured against it). */
  regionAware: boolean;
};

/**
 * The measured defaults (100k checkpoint, re-checked under
 * corpus-family-admission-v2 in the pre-1M hardening): region-aware, 200-word
 * regions, 25 per region, K = 250 — the smallest budget with no matched
 * position or score difference against the all-touched reference. The
 * algorithm (candidate-ranking-v1) is frozen; these parameters are query-time
 * and every request may name its own.
 */
export const DEFAULT_CANDIDATE_RANKING_POLICY: CandidateRankingPolicy = {
  version: CANDIDATE_RANKING_POLICY_VERSION,
  regionWords: 200,
  regionListDepth: 25,
  candidateBudget: 250,
  maxDiscoveryDocumentFrequency: null,
  minimumFingerprintHits: 1,
  regionAware: true,
};

export type RetrievalState = "COMPLETE" | "PARTIAL" | "FAILED";

export type RetrievalFailure = {
  partition: number;
  segmentId: string | null;
  phase: "open" | "lookup" | "score" | "request";
  artifact: string;
  code: string;
  message: string;
};

export type RetrievalCandidate = {
  /** 1-based position in the fused order. */
  rank: number;
  docId: bigint;
  docIdDecimal: string;
  partition: number;
  segmentId: string;
  ordinal: number;
  tokenCount: number;
  globalWeight: number;
  fingerprintHits: number;
  /** Distinct submission regions in which this document has at least one hit. */
  regionsSupported: number;
  /** 1-based rank in the global list, when within its depth. */
  globalRank: number | null;
  /** Best 1-based rank in any region list, and that region. */
  bestRegionRank: number | null;
  bestRegion: number | null;
  /** Which list put it in the result. */
  nominatedBy: "global" | "region";
};

export type RetrievalStats = {
  queryTokenCount: number;
  queryFingerprints: number;
  queryRegions: number;
  fingerprintsFound: number;
  fingerprintsSuppressed: number;
  /** Distinct documents with at least one hit — the size of the candidate map. */
  touchedDocuments: number;
  postingsDecoded: number;
  partitionsQueried: number;
  segmentsQueried: number;
  segmentsFailed: number;
  dictionaryBlocksRead: number;
  indexBytesRead: number;
  indexRangeReads: number;
  timingsMs: { fingerprint: number; lookup: number; accumulate: number; merge: number; total: number };
};

export type RetrievalResult = {
  state: RetrievalState;
  protocol: typeof RETRIEVAL_PROTOCOL_VERSION;
  identity: CorpusReaderIdentity;
  rankingPolicy: CandidateRankingPolicy;
  candidates: RetrievalCandidate[];
  failures: RetrievalFailure[];
  stats: RetrievalStats;
};

type ScoredEntry = {
  docId: bigint;
  partition: number;
  segmentId: string;
  ordinal: number;
  tokenCount: number;
  /** The weight this entry is ranked by in ITS list (whole-document, or one region's). */
  weight: number;
  /** The document's whole-submission weight, whichever list the entry is in. */
  globalWeight: number;
  hits: number;
  regionsSupported: number;
};

function compareEntries(left: ScoredEntry, right: ScoredEntry): number {
  if (left.weight !== right.weight) return right.weight - left.weight;
  if (left.hits !== right.hits) return right.hits - left.hits;
  return left.docId < right.docId ? -1 : left.docId > right.docId ? 1 : 0;
}

type PartitionScore = {
  global: ScoredEntry[];
  regions: Map<number, ScoredEntry[]>;
  touchedDocuments: number;
  postingsDecoded: number;
};

function validatePolicy(policy: CandidateRankingPolicy) {
  if (policy.version !== CANDIDATE_RANKING_POLICY_VERSION) throw new RangeError(`unsupported candidate ranking policy ${JSON.stringify(policy.version)}`);
  for (const [name, value] of [["regionWords", policy.regionWords], ["regionListDepth", policy.regionListDepth], ["candidateBudget", policy.candidateBudget], ["minimumFingerprintHits", policy.minimumFingerprintHits]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`ranking policy ${name} must be a positive integer`);
  }
  if (policy.maxDiscoveryDocumentFrequency !== null && (!Number.isInteger(policy.maxDiscoveryDocumentFrequency) || policy.maxDiscoveryDocumentFrequency < 1)) {
    throw new RangeError("ranking policy maxDiscoveryDocumentFrequency must be null or a positive integer");
  }
}

/**
 * Phase 2 for one segment: the complete score of every document of this
 * segment that shares an active fingerprint, as bounded top lists.
 * `postings[i]` is the segment's postings for active fingerprint i.
 */
function scoreSegment(
  slot: SegmentSlot,
  reader: SegmentReader,
  active: ReadonlyArray<{ weight: number; regions: readonly number[] }>,
  postings: ReadonlyArray<Uint32Array | null>,
  policy: CandidateRankingPolicy,
): PartitionScore {
  const weights = new Map<number, number>();
  const hits = new Map<number, number>();
  const regionWeights = new Map<number, Map<number, number>>();
  let postingsDecoded = 0;
  for (let index = 0; index < active.length; index += 1) {
    const list = postings[index];
    if (!list) continue;
    const { weight, regions } = active[index];
    postingsDecoded += list.length;
    for (let cursor = 0; cursor < list.length; cursor += 1) {
      const ordinal = list[cursor];
      if (slot.revokedOrdinals.size > 0 && slot.revokedOrdinals.has(ordinal)) continue;
      weights.set(ordinal, (weights.get(ordinal) ?? 0) + weight);
      hits.set(ordinal, (hits.get(ordinal) ?? 0) + 1);
    }
    if (!policy.regionAware) continue;
    for (const region of regions) {
      let byOrdinal = regionWeights.get(region);
      if (!byOrdinal) {
        byOrdinal = new Map<number, number>();
        regionWeights.set(region, byOrdinal);
      }
      for (let cursor = 0; cursor < list.length; cursor += 1) {
        const ordinal = list[cursor];
        if (slot.revokedOrdinals.size > 0 && slot.revokedOrdinals.has(ordinal)) continue;
        byOrdinal.set(ordinal, (byOrdinal.get(ordinal) ?? 0) + weight);
      }
    }
  }

  const regionsSupported = new Map<number, number>();
  for (const byOrdinal of regionWeights.values()) {
    for (const ordinal of byOrdinal.keys()) regionsSupported.set(ordinal, (regionsSupported.get(ordinal) ?? 0) + 1);
  }
  const entryOf = (ordinal: number, weight: number): ScoredEntry => ({
    docId: reader.docIds[ordinal],
    partition: slot.partition,
    segmentId: slot.segmentId,
    ordinal,
    tokenCount: reader.tokenCounts[ordinal],
    weight,
    globalWeight: weights.get(ordinal) ?? 0,
    hits: hits.get(ordinal) ?? 0,
    regionsSupported: regionsSupported.get(ordinal) ?? 0,
  });
  const eligible = (ordinal: number) => (hits.get(ordinal) ?? 0) >= policy.minimumFingerprintHits;

  const global: ScoredEntry[] = [];
  for (const [ordinal, weight] of weights) if (eligible(ordinal)) global.push(entryOf(ordinal, weight));
  global.sort(compareEntries);
  const touchedDocuments = global.length;
  global.length = Math.min(global.length, policy.candidateBudget);

  const regions = new Map<number, ScoredEntry[]>();
  const regionDepth = Math.min(policy.regionListDepth, policy.candidateBudget);
  for (const [region, byOrdinal] of regionWeights) {
    const list: ScoredEntry[] = [];
    for (const [ordinal, weight] of byOrdinal) if (eligible(ordinal)) list.push(entryOf(ordinal, weight));
    list.sort(compareEntries);
    list.length = Math.min(list.length, regionDepth);
    if (list.length > 0) regions.set(region, list);
  }
  return { global, regions, touchedDocuments, postingsDecoded };
}

/** Deterministic merge of already-complete per-segment / per-partition lists. */
function mergeLists(lists: ScoredEntry[][], depth: number): ScoredEntry[] {
  const merged = lists.length === 1 ? [...lists[0]] : lists.flat().sort(compareEntries);
  merged.length = Math.min(merged.length, depth);
  return merged;
}

export async function retrieveCandidates(
  reader: CorpusGenerationReader,
  submission: string | QueryFingerprints,
  policyOverrides: Partial<CandidateRankingPolicy> = {},
): Promise<RetrievalResult> {
  const started = performance.now();
  const policy: CandidateRankingPolicy = { ...DEFAULT_CANDIDATE_RANKING_POLICY, ...policyOverrides };
  validatePolicy(policy);
  const identity = reader.identity();
  const failures: RetrievalFailure[] = [];
  const stats: RetrievalStats = {
    queryTokenCount: 0, queryFingerprints: 0, queryRegions: 0, fingerprintsFound: 0, fingerprintsSuppressed: 0,
    touchedDocuments: 0, postingsDecoded: 0, partitionsQueried: 0, segmentsQueried: 0, segmentsFailed: 0,
    dictionaryBlocksRead: 0, indexBytesRead: 0, indexRangeReads: 0,
    timingsMs: { fingerprint: 0, lookup: 0, accumulate: 0, merge: 0, total: 0 },
  };
  const finish = (state: RetrievalState, candidates: RetrievalCandidate[]): RetrievalResult => {
    stats.timingsMs.total = performance.now() - started;
    return { state, protocol: RETRIEVAL_PROTOCOL_VERSION, identity, rankingPolicy: policy, candidates, failures, stats };
  };

  const fingerprintStarted = performance.now();
  let query: QueryFingerprints;
  if (typeof submission === "string") {
    query = computeQueryFingerprints(submission, policy.regionWords, reader.manifest.processing.normalization.version as 1 | 2);
  } else {
    query = submission;
    if (query.regionWords !== policy.regionWords || query.normalizationVersion !== reader.manifest.processing.normalization.version) {
      failures.push({ partition: -1, segmentId: null, phase: "request", artifact: "query", code: "QUERY_CONTRACT_MISMATCH", message: "query fingerprints were computed under a different region width or normalization contract than this request" });
      return finish("FAILED", []);
    }
  }
  stats.timingsMs.fingerprint = performance.now() - fingerprintStarted;
  stats.queryTokenCount = query.tokenCount;
  stats.queryFingerprints = query.fingerprints.length;
  stats.queryRegions = query.regionCount;

  const counterBaselines = reader.slots.map((slot) => (slot.reader ? { ...slot.reader.counters } : null));
  for (const slot of reader.slots) {
    if (!slot.reader && slot.failure) {
      failures.push({ partition: slot.partition, segmentId: slot.segmentId, phase: "open", artifact: slot.failure.artifact, code: slot.failure.code, message: slot.failure.message });
    }
  }
  const searchable = reader.slots.filter((slot) => slot.reader !== null);
  if (reader.slots.length > 0 && searchable.length === 0) return finish("FAILED", []);
  if (query.fingerprints.length === 0 || searchable.length === 0) return finish(failures.length === 0 ? "COMPLETE" : "PARTIAL", []);

  // ── phase 1: lookup — per-segment dictionary hits, summed into the generation-wide df ──
  const lookupStarted = performance.now();
  const keys = query.fingerprints.map((fingerprint) => fingerprint.key);
  const globalDf = new Float64Array(keys.length);
  const hitsBySlot = new Map<SegmentSlot, Array<DictionaryHit | null>>();
  // Every segment is asked at once (they are independent, and in a distributed deployment they are
  // different machines); the answers are then folded in SLOT ORDER, so nothing depends on which
  // read finished first.
  const lookups = await Promise.all(searchable.map(async (slot) => {
    try {
      return { hits: await (slot.reader as SegmentReader).lookupDictionary(keys), error: null };
    } catch (error) {
      return { hits: null, error };
    }
  }));
  searchable.forEach((slot, slotIndex) => {
    const { hits, error } = lookups[slotIndex];
    if (!hits) {
      const failure = toSegmentError(error, "dict.bin");
      failures.push({ partition: slot.partition, segmentId: slot.segmentId, phase: "lookup", artifact: failure.artifact, code: failure.code, message: failure.message });
      return;
    }
    hitsBySlot.set(slot, hits);
    for (let index = 0; index < hits.length; index += 1) {
      const hit = hits[index];
      if (hit) globalDf[index] += hit.df;
    }
  });

  const activeIndexes: number[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    if (globalDf[index] === 0) continue;
    stats.fingerprintsFound += 1;
    if (policy.maxDiscoveryDocumentFrequency !== null && globalDf[index] > policy.maxDiscoveryDocumentFrequency) {
      stats.fingerprintsSuppressed += 1;
      continue;
    }
    activeIndexes.push(index);
  }
  const active = activeIndexes.map((index) => ({ weight: 1 / Math.log2(2 + globalDf[index]), regions: query.fingerprints[index].regions }));

  // ── phase 2: score — each segment scores its own documents completely ──
  const scores: PartitionScore[] = [];
  let accumulateMs = 0;
  const partitionsSeen = new Set<number>();
  const scoredSlots = [...hitsBySlot.entries()];
  const postingsReads = await Promise.all(scoredSlots.map(async ([slot, hits]) => {
    const wanted: DictionaryHit[] = [];
    const wantedAt: number[] = [];
    for (let position = 0; position < activeIndexes.length; position += 1) {
      const hit = hits[activeIndexes[position]];
      if (hit) {
        wanted.push(hit);
        wantedAt.push(position);
      }
    }
    try {
      const lists = await (slot.reader as SegmentReader).readPostings(wanted);
      const postings = new Array<Uint32Array | null>(activeIndexes.length).fill(null);
      for (let index = 0; index < lists.length; index += 1) postings[wantedAt[index]] = lists[index];
      return { postings, error: null };
    } catch (error) {
      return { postings: null, error };
    }
  }));
  const lookupMs = performance.now() - lookupStarted;
  scoredSlots.forEach(([slot], slotIndex) => {
    const { postings, error } = postingsReads[slotIndex];
    if (!postings) {
      const failure = toSegmentError(error, "postings.bin");
      failures.push({ partition: slot.partition, segmentId: slot.segmentId, phase: "score", artifact: failure.artifact, code: failure.code, message: failure.message });
      return;
    }
    const accumulateStarted = performance.now();
    scores.push(scoreSegment(slot, slot.reader as SegmentReader, active, postings, policy));
    accumulateMs += performance.now() - accumulateStarted;
    partitionsSeen.add(slot.partition);
    stats.segmentsQueried += 1;
  });
  stats.timingsMs.lookup = lookupMs;
  stats.timingsMs.accumulate = accumulateMs;
  stats.partitionsQueried = partitionsSeen.size;
  stats.segmentsFailed = new Set(failures.map((failure) => failure.segmentId)).size;
  for (const score of scores) {
    stats.touchedDocuments += score.touchedDocuments;
    stats.postingsDecoded += score.postingsDecoded;
  }
  reader.slots.forEach((slot, index) => {
    const baseline = counterBaselines[index];
    if (!slot.reader || !baseline) return;
    stats.dictionaryBlocksRead += slot.reader.counters.dictionaryBlocksRead - baseline.dictionaryBlocksRead;
    stats.indexBytesRead += slot.reader.counters.dictionaryBytesRead - baseline.dictionaryBytesRead + slot.reader.counters.postingsBytesRead - baseline.postingsBytesRead;
    stats.indexRangeReads += slot.reader.counters.rangeReads - baseline.rangeReads;
  });

  // ── coordinator: deterministic merge, then depth-ordered fusion ──
  const mergeStarted = performance.now();
  const globalList = mergeLists(scores.map((score) => score.global), policy.candidateBudget);
  const regionDepth = Math.min(policy.regionListDepth, policy.candidateBudget);
  const regionIds = [...new Set(scores.flatMap((score) => [...score.regions.keys()]))].sort((left, right) => left - right);
  const regionLists = new Map<number, ScoredEntry[]>();
  for (const region of regionIds) {
    regionLists.set(region, mergeLists(scores.map((score) => score.regions.get(region) ?? []).filter((list) => list.length > 0), regionDepth));
  }

  const globalRankOf = new Map<bigint, number>();
  globalList.forEach((entry, index) => globalRankOf.set(entry.docId, index + 1));
  const bestRegionOf = new Map<bigint, { rank: number; region: number }>();
  for (const region of regionIds) {
    (regionLists.get(region) ?? []).forEach((entry, index) => {
      const best = bestRegionOf.get(entry.docId);
      if (!best || index + 1 < best.rank) bestRegionOf.set(entry.docId, { rank: index + 1, region });
    });
  }
  const candidates: RetrievalCandidate[] = [];
  const taken = new Set<bigint>();
  const take = (entry: ScoredEntry, nominatedBy: "global" | "region") => {
    if (taken.has(entry.docId) || candidates.length >= policy.candidateBudget) return;
    taken.add(entry.docId);
    const best = bestRegionOf.get(entry.docId) ?? null;
    candidates.push({
      rank: candidates.length + 1,
      docId: entry.docId,
      docIdDecimal: docIdToDecimal(entry.docId),
      partition: entry.partition,
      segmentId: entry.segmentId,
      ordinal: entry.ordinal,
      tokenCount: entry.tokenCount,
      globalWeight: entry.globalWeight,
      fingerprintHits: entry.hits,
      regionsSupported: entry.regionsSupported,
      globalRank: globalRankOf.get(entry.docId) ?? null,
      bestRegionRank: best ? best.rank : null,
      bestRegion: best ? best.region : null,
      nominatedBy,
    });
  };
  const maximumDepth = Math.max(globalList.length, policy.regionAware ? regionDepth : 0);
  for (let depth = 0; depth < maximumDepth && candidates.length < policy.candidateBudget; depth += 1) {
    if (depth < globalList.length) take(globalList[depth], "global");
    if (!policy.regionAware || depth >= regionDepth) continue;
    for (const region of regionIds) {
      const list = regionLists.get(region) as ScoredEntry[];
      if (depth < list.length) take(list[depth], "region");
    }
  }
  stats.timingsMs.merge = performance.now() - mergeStarted;

  return finish(failures.length === 0 ? "COMPLETE" : "PARTIAL", candidates);
}
