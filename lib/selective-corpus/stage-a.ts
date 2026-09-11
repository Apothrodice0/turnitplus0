import type { SelectiveCorpusArtifact } from "./artifact";
import { winnowSubmissionFingerprints } from "./fingerprint";
import {
  SELECTIVE_CORPUS_STAGE_A_TOP_K,
  SELECTIVE_CORPUS_STAGE_A_MAX_POSTING_ROWS,
  SELECTIVE_CORPUS_STAGE_A_MAX_CANDIDATES,
} from "./constants";

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
 */

export type SelectiveCorpusStageACandidate = {
  ordinal: number;
  matchedFingerprints: number;
  weight: number;
};

export type SelectiveCorpusStageAResult = {
  ranked: SelectiveCorpusStageACandidate[];
  topK: SelectiveCorpusStageACandidate[];
  queryFingerprintsUsed: number;
  stoppedFingerprints: number;
  postingRowsTallied: number;
  truncated: boolean;
  rankByOrdinal: Map<number, number>;
};

export async function selectiveCorpusStageA(
  submissionText: string,
  artifact: SelectiveCorpusArtifact,
  opts: { topK?: number; maxPostingRows?: number; maxCandidates?: number } = {},
): Promise<SelectiveCorpusStageAResult> {
  const topK = opts.topK ?? SELECTIVE_CORPUS_STAGE_A_TOP_K;
  const maxPostingRows = opts.maxPostingRows ?? SELECTIVE_CORPUS_STAGE_A_MAX_POSTING_ROWS;
  const maxCandidates = opts.maxCandidates ?? SELECTIVE_CORPUS_STAGE_A_MAX_CANDIDATES;

  const { fingerprints } = winnowSubmissionFingerprints(submissionText);

  let postingRowsTallied = 0;
  let stoppedFingerprints = 0;
  let truncated = false;
  const weightByDoc = new Map<number, number>();
  const matchedByDoc = new Map<number, number>();

  // process query fingerprints grouped by shard so the file-backed reader loads
  // each shard at most once per submission (LRU-friendly). Sort is by hex hash,
  // which groups by first byte = shard; stable and deterministic. Tally order
  // does not affect the final ranking (weight + matched + ordinal tie-break).
  // Sequential awaits, deliberately not parallelized: this task only threads
  // async I/O through the existing call chain, and concurrent postings reads
  // could reorder shard-LRU touches / shard-failure observation order —
  // preserved exactly by staying sequential.
  const orderedFingerprints = [...fingerprints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const h of orderedFingerprints) {
    if (artifact.stopHashes.has(h)) {
      stoppedFingerprints += 1;
      continue;
    }
    const arr = await artifact.postingsAccessor.getPostings(h);
    if (!arr) continue;
    postingRowsTallied += arr.length;
    if (postingRowsTallied > maxPostingRows) {
      truncated = true;
      break;
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
    stoppedFingerprints,
    postingRowsTallied,
    truncated,
    rankByOrdinal,
  };
}
