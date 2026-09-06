import type { Client } from "@libsql/client";
import { tokens, grams, gramHash, containment } from "./similarity-core";
import { scoreAgainstArchive, type ArchiveScoringResult, type ArchiveScoringMatchingParameters } from "./archive-similarity-scoring";
import { ARCHIVE_FINGERPRINT_VERSION } from "./archive-corpus-seed";
import { ARCHIVE_SHINGLE_SIZE, ARCHIVE_COMPACT_FINGERPRINT_VERSION, archiveShingleHashes } from "./archive-fingerprint";
import { loadDfBandMap, deriveStopHashSet, ARCHIVE_DF_BAND_POLICY_VERSION } from "./archive-df-bands";
import { phraseFallbackDiscovery, ARCHIVE_PHRASE_FALLBACK_POLICY_VERSION, PHRASE_FALLBACK_BUDGET } from "./archive-phrase-fallback";
import {
  loadCosources,
  isArchiveCosourceExpansionEnabled,
  ARCHIVE_COSOURCE_POLICY_VERSION,
} from "./archive-cosource";

/** The 5-gram whole-query containment at/above which a candidate is treated as
 *  the submission itself and cannot be a scoring source — scoreAgainstArchive's
 *  own self-exclusion threshold, mirrored here so the G1s gate reasons about
 *  the SAME "self-excluded" set the scorer will exclude. Computed over the full
 *  (unpruned) 5-gram sets, matching the frozen Slice 2D.3 prototype. */
const ARCHIVE_SELF_EXCLUSION_CONTAINMENT = 0.75;

/**
 * 100k-scale architecture — the server-side built-in-archive matcher. Slice 2B
 * replaces ONLY archive candidate DISCOVERY. The scoring algorithm
 * (lib/archive-similarity-scoring.ts's scoreAgainstArchive, ported verbatim
 * from app/similarity-worker.ts's analyze()) is UNCHANGED and still runs over
 * canonical-text-reconstructed archive grams. Read-only; never writes.
 *
 * DISCOVERY PIPELINE (frozen shape, Slices 2A / 2A.4 / 2A.5):
 *   submission
 *     → compact winnowed fingerprints (archive_document_fingerprints)  → primary candidate IDs
 *     → reconstruct primary candidates' full grams from canonical_text
 *     → scoreAgainstArchive (global-DF-pruned postings)                → primary result
 *     → discovery-gap regions of the query
 *     → bounded FTS phrase fallback (budget 16, discovery-only)         → additional candidate IDs
 *     → deduplicated candidate union
 *     → reconstruct union's full grams from canonical_text
 *     → scoreAgainstArchive (SAME pruned postings)                     → final result
 *
 * GLOBAL DF PRUNING is independent of how many candidates were discovered:
 * a hash is pruned iff it is in the precomputed archive-global stop set
 * ({ h : archive_hash_df_bands.df_bucket > maximumDocumentFrequency }),
 * never based on the discovered candidate count. This is the Slice 2A.2 fix —
 * with compact discovery the candidate set is small, so the browser static
 * index's build-time exclusion cannot be reproduced by a candidate-relative
 * posting-length check.
 *
 * NO FULL corpus_document_shingles PERSISTENCE is required for the archive:
 * discovery reads compact fingerprints, postings are reconstructed
 * request-locally from canonical_text, DF comes from the compact df-band
 * table (with the FTS index resolving the DF 0..12 band on demand).
 *
 * ARCHIVE ELIGIBILITY is structural: every archive_document_fingerprints row
 * is written only by the archive seed path (lib/archive-corpus-seed.ts) for a
 * representation that has an archive_document_representations row — no 7-day
 * maturity term is ever consulted, exactly as CorpusEligibilityMode "ARCHIVE"
 * specified for the old discovery path. This function has no accountId, no
 * excludeAccountId, and never imports the SELF/PRIOR_SUBMISSION/
 * TURNITPLUS_CORPUS_SOURCE relationship classifier — archive evidence is
 * structurally unreachable by any account/SELF concept.
 */

/** The version constants this matcher's behaviour is pinned to — surfaced for
 *  diagnostics / tests so a policy change is a visible, reviewed edit. */
export const ARCHIVE_MATCH_POLICY = {
  compactFingerprintVersion: ARCHIVE_COMPACT_FINGERPRINT_VERSION,
  dfBandPolicyVersion: ARCHIVE_DF_BAND_POLICY_VERSION,
  phraseFallbackPolicyVersion: ARCHIVE_PHRASE_FALLBACK_POLICY_VERSION,
  phraseFallbackBudget: PHRASE_FALLBACK_BUDGET,
  cosourcePolicyVersion: ARCHIVE_COSOURCE_POLICY_VERSION,
} as const;

export type MatchAgainstArchiveCorpusOptions = {
  /** Kept for API stability; unused since discovery moved to compact fingerprints. */
  fingerprintVersion?: string;
  /** The archive build's own maximumDocumentFrequency (public/data/document-index.meta.json).
   *  Required, never silently defaulted — it is both the scorer's index cap and the
   *  threshold that turns df_bucket rows into the stop set. */
  maximumDocumentFrequency: number;
  matchingParameters?: ArchiveScoringMatchingParameters;
  /** Candidate-discovery LIMIT — generous; compact discovery already returns
   *  only documents sharing a winnowed fingerprint. */
  candidateLimit?: number;
  /** Compact-fingerprint generation to query. Defaults to ARCHIVE_COMPACT_FINGERPRINT_VERSION. */
  compactFingerprintVersion?: string;
  /** DF-band policy generation to load. Defaults to ARCHIVE_DF_BAND_POLICY_VERSION. */
  dfBandPolicyVersion?: string;
  /** Co-source adjacency policy generation to consult when the expansion flag
   *  is on. Defaults to ARCHIVE_COSOURCE_POLICY_VERSION. */
  cosourcePolicyVersion?: string;
  /**
   * UNUSED — archive candidates are never subject to the 7-day maturity gate.
   * Accepted-but-ignored for API stability; passing either is harmless.
   */
  maturityCutoff?: string;
  asOf?: Date;
};

type CandidateOrderRow = { representation_id: string; title: string; archive_order: number | bigint | null };

function queryHashSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const gram of grams(tokens(text), ARCHIVE_SHINGLE_SIZE)) set.add(gramHash(gram));
  return set;
}

/**
 * PRIMARY candidate discovery — every archive document sharing at least one
 * winnowed compact fingerprint with the (unreduced) query 5-gram set.
 * Deterministic ORDER BY: shared count then representation_id, purely so the
 * candidateLimit cut is stable; final scoring re-orders by archive_order.
 */
async function compactDiscovery(
  client: Client,
  queryHashes: Set<string>,
  compactFingerprintVersion: string,
  candidateLimit: number,
): Promise<string[]> {
  const hashList = [...queryHashes];
  if (hashList.length === 0) return [];
  const placeholders = hashList.map(() => "?").join(",");
  const res = await client.execute({
    sql: `SELECT representation_id, COUNT(*) AS shared
            FROM archive_document_fingerprints
           WHERE fingerprint_version = ? AND fingerprint_hash IN (${placeholders})
           GROUP BY representation_id
          HAVING COUNT(*) >= 1
           ORDER BY shared DESC, representation_id ASC
           LIMIT ?`,
    args: [compactFingerprintVersion, ...hashList, candidateLimit],
  });
  return res.rows.map((r) => String((r as unknown as { representation_id: string }).representation_id));
}

type ScoreOverCandidatesResult = {
  result: ArchiveScoringResult;
  candidateIds: string[];
  /** Candidates whose whole-query 5-gram containment reached
   *  ARCHIVE_SELF_EXCLUSION_CONTAINMENT — the same set scoreAgainstArchive
   *  excludes. Used ONLY by the G1s gate; unordered. */
  selfExcludedRepresentationIds: string[];
};

/**
 * The "existing scorer" wrapper: reconstruct each candidate's full 5-gram
 * hash set from canonical_text (request-local; NO corpus_document_shingles
 * read), assign sourceIndex by archive_order (the browser static index's
 * fixed, query-independent order — reproduces its winner-take-all tie-break),
 * build a getPostings that prunes iff the hash is in the archive-global stop
 * set, then call scoreAgainstArchive UNMODIFIED.
 */
async function scoreOverCandidates(
  client: Client,
  submittedText: string,
  candidateIds: string[],
  documentCount: number,
  maximumDocumentFrequency: number,
  matchingParameters: ArchiveScoringMatchingParameters | undefined,
  stopHashSet: Set<string>,
  queryHashes: Set<string>,
): Promise<ScoreOverCandidatesResult> {
  const emptyIndex = {
    shingleSize: ARCHIVE_SHINGLE_SIZE,
    documentCount,
    maximumDocumentFrequency,
    articles: [],
    getPostings: () => [] as number[],
  };
  if (candidateIds.length === 0) {
    return {
      result: scoreAgainstArchive(submittedText, emptyIndex, matchingParameters),
      candidateIds: [],
      selfExcludedRepresentationIds: [],
    };
  }

  const placeholders = candidateIds.map(() => "?").join(",");
  const [orderResult, textResult] = await Promise.all([
    client.execute({
      sql: `SELECT representation_id, title, archive_order FROM archive_document_representations
            WHERE fingerprint_version = ? AND representation_id IN (${placeholders})`,
      args: [ARCHIVE_FINGERPRINT_VERSION, ...candidateIds],
    }),
    client.execute({
      sql: `SELECT id, canonical_text FROM corpus_document_representations WHERE id IN (${placeholders})`,
      args: candidateIds,
    }),
  ]);

  const hashSetByRepresentationId = new Map<string, Set<string>>();
  for (const row of textResult.rows) {
    const r = row as unknown as { id: string; canonical_text: string };
    hashSetByRepresentationId.set(String(r.id), archiveShingleHashes(String(r.canonical_text), ARCHIVE_SHINGLE_SIZE));
  }

  // Self-exclusion set — the SAME containment(shared, |query grams|, |source grams|)
  // >= 0.75 rule scoreAgainstArchive applies internally, computed here over the
  // full (unpruned) 5-gram sets exactly as the frozen Slice 2D.3 prototype did,
  // so the G1s gate reasons about "self-excluded" identically across runs.
  const selfExcludedRepresentationIds: string[] = [];
  for (const [representationId, hashSet] of hashSetByRepresentationId) {
    let shared = 0;
    for (const hash of queryHashes) if (hashSet.has(hash)) shared += 1;
    if (containment(shared, queryHashes.size, hashSet.size) >= ARCHIVE_SELF_EXCLUSION_CONTAINMENT) {
      selfExcludedRepresentationIds.push(representationId);
    }
  }

  const orderedCandidates = (orderResult.rows as unknown as CandidateOrderRow[]).slice().sort((left, right) => {
    const l = left.archive_order === null ? Number.POSITIVE_INFINITY : Number(left.archive_order);
    const r = right.archive_order === null ? Number.POSITIVE_INFINITY : Number(right.archive_order);
    if (l !== r) return l - r;
    return left.representation_id < right.representation_id ? -1 : left.representation_id > right.representation_id ? 1 : 0;
  });
  const sourceIndexByRepresentationId = new Map(orderedCandidates.map((row, index) => [row.representation_id, index]));
  const titleByRepresentationId = new Map(orderedCandidates.map((row) => [row.representation_id, row.title]));

  const postingsByHash = new Map<string, number[]>();
  const uniqueShingleCountByRepresentationId = new Map<string, number>();
  for (const [repId, hashSet] of hashSetByRepresentationId) {
    const sourceIndex = sourceIndexByRepresentationId.get(repId);
    if (sourceIndex === undefined) continue;
    uniqueShingleCountByRepresentationId.set(repId, hashSet.size);
    for (const hash of hashSet) {
      const list = postingsByHash.get(hash);
      if (list) list.push(sourceIndex);
      else postingsByHash.set(hash, [sourceIndex]);
    }
  }

  const articles = orderedCandidates.map((row) => ({
    title: titleByRepresentationId.get(row.representation_id) ?? row.representation_id,
    sourceType: "Publication" as const,
    uniqueShingleCount: uniqueShingleCountByRepresentationId.get(row.representation_id) ?? 0,
  }));

  // Global-DF pruning: pruned iff in the precomputed archive-global stop set,
  // NEVER based on the discovered candidate count. scoreAgainstArchive's own
  // internal `sourceIndexes.length > runtimeMaximumDocumentFrequency` check
  // still applies on top (a stricter, query-time cap from matchingParameters).
  const getPostings = (hash: string): number[] => {
    if (stopHashSet.has(hash)) return [];
    return postingsByHash.get(hash) ?? [];
  };

  const result = scoreAgainstArchive(
    submittedText,
    { shingleSize: ARCHIVE_SHINGLE_SIZE, documentCount, maximumDocumentFrequency, articles, getPostings },
    matchingParameters,
  );
  return { result, candidateIds, selfExcludedRepresentationIds };
}

export type MatchAgainstArchiveCorpusResult = ArchiveScoringResult & {
  /** Discovery diagnostics — never scoring-relevant. */
  archiveDiscovery: {
    compactCandidateCount: number;
    phraseCandidateCount: number;
    unionCandidateCount: number;
    phraseProbeCount: number;
    admittedPhraseProbeCount: number;
    maxAdmittedPhraseFanOut: number;
    dfResolveChecks: number;
    /**
     * Co-source (G1s) expansion diagnostics — present ONLY when
     * isArchiveCosourceExpansionEnabled() (absent entirely when the flag is
     * off, so the flag-off result is byte-identical to the pre-2D.4 matcher).
     * Never scoring-relevant.
     */
    cosource?: {
      /** self-excluded compact candidates (the potential G1s anchors). */
      selfExcludedCandidateCount: number;
      /** did the G1s gate open (>=1 self-excluded AND (all self-excluded OR
       *  primary produced no non-self-excluded contributing source))? */
      eligible: boolean;
      /** anchors actually queried for co-sources (0 unless eligible). */
      anchorCount: number;
      /** de-duplicated co-source neighbours returned for those anchors. */
      neighborCount: number;
      /** true iff neighbours were unioned in and the result was re-scored. */
      applied: boolean;
      /** candidate count handed to the final scoreAgainstArchive. */
      finalCandidateCount: number;
    };
  };
};

export async function matchAgainstArchiveCorpus(
  client: Client,
  submittedText: string,
  options: MatchAgainstArchiveCorpusOptions,
): Promise<MatchAgainstArchiveCorpusResult> {
  const compactFingerprintVersion = options.compactFingerprintVersion ?? ARCHIVE_COMPACT_FINGERPRINT_VERSION;
  const candidateLimit = options.candidateLimit ?? 5_000;

  const documentCountResult = await client.execute({
    sql: "SELECT COUNT(*) AS total FROM archive_document_representations WHERE fingerprint_version = ?",
    args: [ARCHIVE_FINGERPRINT_VERSION],
  });
  const documentCount = Number((documentCountResult.rows[0] as unknown as { total: number | bigint }).total);

  const queryHashes = queryHashSet(submittedText);

  const emptyDiscovery = {
    compactCandidateCount: 0,
    phraseCandidateCount: 0,
    unionCandidateCount: 0,
    phraseProbeCount: 0,
    admittedPhraseProbeCount: 0,
    maxAdmittedPhraseFanOut: 0,
    dfResolveChecks: 0,
  };

  if (queryHashes.size === 0 || documentCount === 0) {
    const empty = scoreAgainstArchive(
      submittedText,
      { shingleSize: ARCHIVE_SHINGLE_SIZE, documentCount, maximumDocumentFrequency: options.maximumDocumentFrequency, articles: [], getPostings: () => [] },
      options.matchingParameters,
    );
    return { ...empty, archiveDiscovery: emptyDiscovery };
  }

  // Archive-global DF metadata — the only DF data read directly.
  const { bandByHash } = await loadDfBandMap(client, { policyVersion: options.dfBandPolicyVersion });
  const stopHashSet = deriveStopHashSet(bandByHash, options.maximumDocumentFrequency);

  // 1) primary discovery + score
  const compactCandidateIds = await compactDiscovery(client, queryHashes, compactFingerprintVersion, candidateLimit);
  const primary = await scoreOverCandidates(
    client,
    submittedText,
    compactCandidateIds,
    documentCount,
    options.maximumDocumentFrequency,
    options.matchingParameters,
    stopHashSet,
    queryHashes,
  );

  // 2) bounded phrase fallback — discovery only
  const fallback = await phraseFallbackDiscovery(
    client,
    submittedText,
    primary.result.archiveMatchedPositions,
    compactCandidateIds,
    { stopHashSet, bandByHash },
  );

  // 3) final score over the deduplicated union (unchanged when the fallback
  //    added nothing — the union is then exactly the compact set)
  const noNewCandidates = fallback.unionCandidateIds.length === compactCandidateIds.length;
  const final = noNewCandidates
    ? primary
    : await scoreOverCandidates(
        client,
        submittedText,
        fallback.unionCandidateIds,
        documentCount,
        options.maximumDocumentFrequency,
        options.matchingParameters,
        stopHashSet,
        queryHashes,
      );

  const admitted = fallback.perProbe.filter((p) => p.admitted);
  const baseDiscovery = {
    compactCandidateCount: compactCandidateIds.length,
    phraseCandidateCount: fallback.phraseCandidateIds.length,
    unionCandidateCount: fallback.unionCandidateIds.length,
    phraseProbeCount: fallback.probes.length,
    admittedPhraseProbeCount: admitted.length,
    maxAdmittedPhraseFanOut: admitted.reduce((m, p) => Math.max(m, p.fanOut), 0),
    dfResolveChecks: fallback.dfResolveChecks,
  };

  // ── committed-B behaviour — the ONLY path when the flag is off ────────────
  // (byte-identical to the pre-2D.4 matcher: no `cosource` diagnostics field)
  if (!isArchiveCosourceExpansionEnabled()) {
    return { ...final.result, archiveDiscovery: baseDiscovery };
  }

  // ── G1s gate (frozen Slice 2D.3 semantics) ──────────────────────────────
  // Expansion is eligible iff at least one discovered candidate self-excludes
  // AND ( every discovered candidate self-excludes OR primary scoring produced
  // zero non-self-excluded contributing sources ). Only self-excluded
  // candidates may be adjacency anchors; with no self-excluded candidate there
  // is no adjacency lookup at all.
  const selfExcludedIds = primary.selfExcludedRepresentationIds;
  const everyDiscoveredCandidateSelfExcludes =
    selfExcludedIds.length >= 1 && selfExcludedIds.length === compactCandidateIds.length;
  const primaryHasNoNonSelfExcludedContributingSource = primary.result.sources.length === 0;
  const g1sEligible =
    selfExcludedIds.length >= 1
    && (everyDiscoveredCandidateSelfExcludes || primaryHasNoNonSelfExcludedContributingSource);

  const cosourceBase = {
    selfExcludedCandidateCount: selfExcludedIds.length,
    eligible: g1sEligible,
    anchorCount: 0,
    neighborCount: 0,
    applied: false,
    finalCandidateCount: fallback.unionCandidateIds.length,
  };

  if (!g1sEligible) {
    return { ...final.result, archiveDiscovery: { ...baseDiscovery, cosource: cosourceBase } };
  }

  // Anchors → bounded adjacency lookup → union/dedupe with the primary
  // candidates → canonical reconstruction + UNCHANGED scoreAgainstArchive.
  const cosourceNeighborIds = await loadCosources(client, selfExcludedIds, {
    policyVersion: options.cosourcePolicyVersion,
  });
  const expandedUnionIds = [...new Set([...fallback.unionCandidateIds, ...cosourceNeighborIds])];

  if (expandedUnionIds.length === fallback.unionCandidateIds.length) {
    // adjacency added no new candidate — committed-B result stands unchanged
    return {
      ...final.result,
      archiveDiscovery: {
        ...baseDiscovery,
        cosource: { ...cosourceBase, anchorCount: selfExcludedIds.length, neighborCount: cosourceNeighborIds.length },
      },
    };
  }

  const expanded = await scoreOverCandidates(
    client,
    submittedText,
    expandedUnionIds,
    documentCount,
    options.maximumDocumentFrequency,
    options.matchingParameters,
    stopHashSet,
    queryHashes,
  );
  return {
    ...expanded.result,
    archiveDiscovery: {
      ...baseDiscovery,
      cosource: {
        ...cosourceBase,
        anchorCount: selfExcludedIds.length,
        neighborCount: cosourceNeighborIds.length,
        applied: true,
        finalCandidateCount: expandedUnionIds.length,
      },
    },
  };
}
