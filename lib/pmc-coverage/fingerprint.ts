import { tokens, grams, gramHash } from "../similarity-core";
import { winnow } from "../archive-fingerprint";
import { PMC_WINNOW_WINDOW, PMC_SHINGLE_SIZE, PMC_MAX_QUERY_FINGERPRINTS } from "./constants";

/**
 * PMC OA scholarly-coverage SHADOW slice — Stage A fingerprint representation.
 *
 * Winnowing (Schleimer/Wilkerson/Aiken) over the EXISTING production 5-gram
 * hash stream (lib/similarity-core.ts gramHash). Nothing about the 5-gram
 * hashing changes — winnowing only SUBSAMPLES that hash stream, at window 15.
 * The winnow() selection function itself is imported from lib/archive-fingerprint.ts
 * (the frozen, tested SWA implementation the built-in archive already uses at
 * window 85) — this module only re-parameterizes it at window 15 and owns the
 * PMC namespace / query-side bound.
 *
 * Determinism: gramHash is a pure FNV-1a+djb2 combination over char codes, and
 * winnow()'s rightmost-minimum selection plus the deterministic lowest-hash
 * trim are pure functions of the hash sequence. No RNG anywhere. gramHash's
 * output is a fixed-width zero-padded 16-hex string, so lexicographic string
 * comparison is exactly numeric comparison.
 */

/** Deterministic hard cap: keep the `limit` entries with the numerically-lowest
 *  hash value. Only fires for pathologically long documents / submissions. */
function trimToLowestHashes(hashes: string[], limit: number): string[] {
  if (hashes.length <= limit) return hashes;
  return [...hashes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit);
}

export type PmcDocumentFingerprint = { hash: string; position: number };

/**
 * The compact winnowed fingerprint set for one PMC document's canonical text —
 * what pmc_document_fingerprints stores. `position` is the first-occurrence
 * word index of that hash among the winnowing selections (diagnostics only,
 * never persisted or read by discovery in phase 1). Deduplicated by hash.
 */
export function computePmcDocumentFingerprints(
  canonicalText: string,
  window: number = PMC_WINNOW_WINDOW,
): PmcDocumentFingerprint[] {
  const words = tokens(canonicalText);
  const hashSequence = grams(words, PMC_SHINGLE_SIZE).map((gram) => gramHash(gram));
  const selections = winnow(hashSequence, window);
  const firstByHash = new Map<string, number>();
  for (const { position, hash } of selections) {
    if (!firstByHash.has(hash)) firstByHash.set(hash, position);
  }
  return [...firstByHash.entries()].map(([hash, position]) => ({ hash, position }));
}

/** Distinct winnowed fingerprint hashes for a document — the posting-universe
 *  form pmc_document_fingerprints is seeded from. */
export function pmcDocumentFingerprintHashes(
  canonicalText: string,
  window: number = PMC_WINNOW_WINDOW,
): string[] {
  return computePmcDocumentFingerprints(canonicalText, window).map((fp) => fp.hash);
}

export type PmcQueryFingerprints = {
  /** Distinct winnowed fingerprint hashes of the submission, after the
   *  PMC_MAX_QUERY_FINGERPRINTS lowest-hash trim. */
  fingerprints: string[];
  /** Distinct winnowed fingerprints BEFORE the trim — for telemetry. */
  rawCount: number;
  /** True when the trim actually clipped the set. */
  trimmed: boolean;
};

/**
 * Winnow the SUBMISSION at window 15 and return its distinct fingerprint
 * hashes, bounded by PMC_MAX_QUERY_FINGERPRINTS (explicit maximum query
 * fingerprints — a hard bound). The DF-band stop-set filter is applied by the
 * caller (lib/pmc-coverage/repository.ts) AFTER this, so `rawCount` here is the
 * pre-stop, pre-nothing-else distinct winnow count.
 */
export function winnowSubmissionFingerprints(
  submissionText: string,
  maxFingerprints: number = PMC_MAX_QUERY_FINGERPRINTS,
  window: number = PMC_WINNOW_WINDOW,
): PmcQueryFingerprints {
  const words = tokens(submissionText);
  const hashSequence = grams(words, PMC_SHINGLE_SIZE).map((gram) => gramHash(gram));
  const distinct = [...new Set(winnow(hashSequence, window).map((s) => s.hash))];
  const trimmed = distinct.length > maxFingerprints;
  return {
    fingerprints: trimToLowestHashes(distinct, maxFingerprints),
    rawCount: distinct.length,
    trimmed,
  };
}
