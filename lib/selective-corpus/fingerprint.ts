import { tokens, grams, gramHash } from "../similarity-core";
import { winnow } from "../archive-fingerprint";
import {
  SELECTIVE_CORPUS_WINNOW_WINDOW,
  SELECTIVE_CORPUS_SHINGLE_SIZE,
  SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS,
} from "./constants";

/**
 * Selective Corpus V1 SHADOW slice — Stage A fingerprint representation.
 *
 * Byte-identical to lib/pmc-coverage/fingerprint.ts: winnowing
 * (Schleimer/Wilkerson/Aiken, imported from lib/archive-fingerprint.ts) over
 * the EXISTING production 5-gram hash stream (lib/similarity-core.ts gramHash),
 * at window 15. Nothing about the 5-gram hashing changes — winnowing only
 * subsamples that stream. Pure/deterministic: no RNG.
 *
 * FINGERPRINT HITS NEVER SCORE — this module only produces the hash set Stage A
 * tallies with.
 */

function trimToLowestHashes(hashes: string[], limit: number): string[] {
  if (hashes.length <= limit) return hashes;
  return [...hashes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit);
}

/** Distinct winnowed fingerprint hashes of a document's canonical text — the
 *  posting-universe form the packed index is built from. */
export function selectiveCorpusDocumentHashes(canonicalText: string): string[] {
  const hashSequence = grams(tokens(canonicalText), SELECTIVE_CORPUS_SHINGLE_SIZE).map((g) => gramHash(g));
  return [...new Set(winnow(hashSequence, SELECTIVE_CORPUS_WINNOW_WINDOW).map((s) => s.hash))];
}

export type SelectiveCorpusQueryFingerprints = {
  fingerprints: string[];
  rawCount: number;
  trimmed: boolean;
};

/**
 * Winnow the SUBMISSION and return its distinct fingerprint hashes, bounded by
 * SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS (a pathologically long submission is
 * deterministically clipped to its numerically-lowest hashes). The stop-set
 * filter is applied by lib/selective-corpus/stage-a.ts AFTER this.
 */
export function winnowSubmissionFingerprints(
  submissionText: string,
  maxFingerprints: number = SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS,
): SelectiveCorpusQueryFingerprints {
  const hashSequence = grams(tokens(submissionText), SELECTIVE_CORPUS_SHINGLE_SIZE).map((g) => gramHash(g));
  const distinct = [...new Set(winnow(hashSequence, SELECTIVE_CORPUS_WINNOW_WINDOW).map((s) => s.hash))];
  const trimmed = distinct.length > maxFingerprints;
  return { fingerprints: trimToLowestHashes(distinct, maxFingerprints), rawCount: distinct.length, trimmed };
}

/** Distinct winnowed fingerprint hashes of an arbitrary span of submission
 *  words — used by FAMILY_GUARD to test whether a verified span recurs across
 *  the corpus. */
export function winnowWordSpanHashes(words: readonly string[]): string[] {
  const hashSequence = grams(words as string[], SELECTIVE_CORPUS_SHINGLE_SIZE).map((g) => gramHash(g));
  return [...new Set(winnow(hashSequence, SELECTIVE_CORPUS_WINNOW_WINDOW).map((s) => s.hash))];
}
