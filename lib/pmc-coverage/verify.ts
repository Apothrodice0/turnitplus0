import { archiveShingleHashes } from "../archive-fingerprint";
import {
  scoreAgainstArchive,
  type ArchiveScoringIndex,
} from "../archive-similarity-scoring";
import { PMC_SHINGLE_SIZE, PMC_MATCHING_PARAMETERS } from "./constants";
import type { PmcCandidateText } from "./repository";

/**
 * PMC OA scholarly-coverage SHADOW slice — Stage B exact verification.
 *
 * Runs the UNMODIFIED lib/archive-similarity-scoring.ts scoreAgainstArchive
 * (itself extracted VERBATIM from app/similarity-worker.ts's analyze()) over an
 * in-memory 5-gram index built from ONLY the <= 20 Stage A candidate texts.
 * Winnowing decided WHICH documents to verify; this function decides similarity
 * — the same statements, order, defaults, informativeGram filter, DF cap,
 * minimumMatchedWords, self-exclusion (containment >= 0.75) and IDF the built-in
 * archive uses.
 *
 * getPostings parity (lib/archive-corpus-matching.ts): prune iff the hash is in
 * the precomputed PMC-global stop set (pmc_hash_df_bands, threshold 6), NEVER
 * based on the local candidate count — scoreAgainstArchive's own
 * `sourceIndexes.length > runtimeMaximumDocumentFrequency` check still applies
 * on top.
 */

export type PmcStageBSource = {
  pmcId: string;
  doi: string | null;
  title: string;
  matchedWords: number;
};

export type PmcStageBResult = {
  /** The verified submission word positions scoreAgainstArchive attributed to
   *  PMC sources — sorted, deduplicated. These are the ONLY positions the
   *  counterfactual unions in. */
  verifiedPositions: number[];
  wordCount: number;
  /** Accepted contributing PMC sources (scoreAgainstArchive's aggregation
   *  survivors). */
  sources: PmcStageBSource[];
};

export function verifyPmcCandidates(
  submissionText: string,
  candidates: readonly PmcCandidateText[],
  stopHashes: ReadonlySet<string>,
  matchingParameters = PMC_MATCHING_PARAMETERS,
): PmcStageBResult {
  if (candidates.length === 0) {
    return { verifiedPositions: [], wordCount: 0, sources: [] };
  }

  const hashSetByIndex = candidates.map((c) => archiveShingleHashes(c.canonicalText, PMC_SHINGLE_SIZE));
  const postingsByHash = new Map<string, number[]>();
  hashSetByIndex.forEach((hashSet, sourceIndex) => {
    for (const hash of hashSet) {
      const list = postingsByHash.get(hash);
      if (list) list.push(sourceIndex);
      else postingsByHash.set(hash, [sourceIndex]);
    }
  });

  const index: ArchiveScoringIndex = {
    shingleSize: PMC_SHINGLE_SIZE,
    documentCount: candidates.length,
    maximumDocumentFrequency: matchingParameters.maximumDocumentFrequency,
    articles: candidates.map((c, i) => ({
      title: c.title,
      sourceType: "Publication" as const,
      uniqueShingleCount: hashSetByIndex[i].size,
    })),
    getPostings: (hash: string): number[] => {
      if (stopHashes.has(hash)) return [];
      return postingsByHash.get(hash) ?? [];
    },
  };

  const result = scoreAgainstArchive(submissionText, index, matchingParameters);

  const sources: PmcStageBSource[] = result.sources
    .map((s) => {
      const candidate = candidates[s.sourceIndex];
      if (!candidate) return null;
      return {
        pmcId: candidate.pmcId,
        doi: candidate.doi,
        title: candidate.title,
        matchedWords: s.matchedWords,
      };
    })
    .filter((s): s is PmcStageBSource => s !== null);

  return {
    verifiedPositions: [...result.archiveMatchedPositions].sort((a, b) => a - b),
    wordCount: result.wordCount,
    sources,
  };
}
