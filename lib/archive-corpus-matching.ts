import type { ArchiveReadClient } from "./archive-read-retry";
import { tokens, grams, gramHash, containment, mergeAdjacentPositions, similarityScore } from "./similarity-core";
import { scoreAgainstArchive, scoreAgainstArchiveDetailed, type ArchiveScoringResult, type ArchiveScoringMatchingParameters } from "./archive-similarity-scoring";
import { seedExtendVerifiedPositions, SEED_EXTEND_ALIGNMENT_POLICY_VERSION } from "./seed-extend-alignment";
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

/** Same batching bound as lib/archive-cosource.ts's LOOKUP_ANCHOR_CHUNK — one
 *  bound SQL parameter per query 5-gram hash means a large full-text query
 *  (tens of thousands of unique hashes) can exceed the driver's compiled
 *  SQLITE_MAX_VARIABLE_NUMBER (32,766 on this local libsql build) in a single
 *  IN (...) lookup. 400 is the same conservative ceiling already vetted
 *  elsewhere in this matcher family, comfortably under that limit even
 *  accounting for a smaller limit on a different libsql/Turso deployment. */
const DISCOVERY_HASH_CHUNK = 400;

/**
 * 100k-scale architecture — the server-side built-in-archive matcher. Slice 2B
 * replaces ONLY archive candidate DISCOVERY. The scoring algorithm
 * (lib/archive-similarity-scoring.ts's scoreAgainstArchive, ported verbatim
 * from app/similarity-worker.ts's analyze()) is UNCHANGED and still runs over
 * canonical-text-reconstructed archive grams. Read-only; never writes.
 *
 * `client` is the narrow ArchiveReadClient surface (execute() only) so the
 * server matcher can pass its bounded transient-read-retry wrapper
 * (lib/archive-read-retry.ts) — a real @libsql/client Client still satisfies
 * it, and this function's behaviour is identical either way.
 *
 * DISCOVERY PIPELINE (frozen shape, Slices 2A / 2A.4 / 2A.5):
 *   submission
 *     → compact winnowed fingerprints (archive_document_fingerprints)  → primary candidate IDs
 *     → reconstruct primary candidates' full grams from canonical_text
 *     → scoreAgainstArchive (global-DF-pruned postings)                → primary result
 *     → discovery-gap regions of the query
 *     → bounded FTS phrase fallback (budget 16, discovery-only)         → additional candidate IDs
 *       + corroborated rare-seed nominations (DF <= 3, whole-document
 *         coverage funded by group-tested DF checks, discovery-only)    → additional candidate IDs
 *     → deduplicated candidate union
 *     → reconstruct union's full grams from canonical_text
 *     → scoreAgainstArchive (SAME pruned postings)                     → final result
 *     → bounded span extension (verification only, additive)           → final positions
 *
 * SCORING UNION: the scorer's archiveMatchedPositions are the union of every
 * ADMITTED source's verified positions (self-exclusion and the per-source
 * minimum, measured on the source's own evidence). The contributing-source cap
 * only bounds the displayed `sources` list: it never removes a position, never
 * restricts the span extension, and never reaches the phrase fallback, which
 * is fed the primary result's full union.
 *
 * SPAN EXTENSION (applySpanExtension) runs after the unchanged scorer and
 * against every source that scorer ADMITTED (self-exclusion and the source
 * minimum already applied — neither is re-run or changed; the display cap does
 * not restrict it). From each exact seed — an informative, non-stop query 5-gram the
 * phrase-fallback pass resolved to an exact archive DF of 1..RARE_SEED_MAX_DF,
 * found verbatim in the source's retrieved canonical_text — it aligns the
 * submission against that text in a bounded window (lib/seed-extend-alignment.ts)
 * and admits an aligned passage only under that module's controls. It adds
 * ONLY submission positions whose token is exactly equal to the aligned source
 * token inside an exact island, and only next to an edit inside the passage
 * (a token at least one of whose 5-grams that edit broke) — a verbatim copy is
 * left exactly as the exact path scored it. The exact result's positions are
 * kept as-is and the score is the same unique-positions formula over the
 * enlarged set. The
 * scorer's gram-frequency gate still applies: a copied token whose every exact
 * aligned 5-gram is frequency-gated (stop set, or in more retrieved candidates
 * than the runtime cap) is not evidence and never scores.
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
  spanExtensionPolicyVersion: SEED_EXTEND_ALIGNMENT_POLICY_VERSION,
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
  /** false = the exact-only result (no span extension). Defaults to on. */
  spanExtension?: boolean;
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
/**
 * Chunked so a single IN (...) lookup never exceeds DISCOVERY_HASH_CHUNK bound
 * parameters (see its own doc comment) — the ONLY change from a single query:
 * each chunk's fingerprint_hash IN (...) set is a disjoint slice of the same
 * hashList, so summing each chunk's per-representation_id COUNT(*) is exactly
 * the same total COUNT(*) the unchunked query would have computed (every
 * underlying row is counted in exactly one chunk, never zero, never twice).
 * The final ORDER BY shared DESC, representation_id ASC and LIMIT are then
 * applied once over the merged totals, reproducing the unchunked query's
 * result byte-for-byte for any hashList size.
 */
async function compactDiscovery(
  client: ArchiveReadClient,
  queryHashes: Set<string>,
  compactFingerprintVersion: string,
  candidateLimit: number,
): Promise<string[]> {
  const hashList = [...queryHashes];
  if (hashList.length === 0) return [];

  const sharedByRepresentationId = new Map<string, number>();
  for (let start = 0; start < hashList.length; start += DISCOVERY_HASH_CHUNK) {
    const chunk = hashList.slice(start, start + DISCOVERY_HASH_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const res = await client.execute({
      sql: `SELECT representation_id, COUNT(*) AS shared
              FROM archive_document_fingerprints
             WHERE fingerprint_version = ? AND fingerprint_hash IN (${placeholders})
             GROUP BY representation_id`,
      args: [compactFingerprintVersion, ...chunk],
    });
    for (const row of res.rows) {
      const r = row as unknown as { representation_id: string; shared: number | bigint };
      const id = String(r.representation_id);
      sharedByRepresentationId.set(id, (sharedByRepresentationId.get(id) ?? 0) + Number(r.shared));
    }
  }

  return [...sharedByRepresentationId.entries()]
    .sort(([leftId, leftShared], [rightId, rightShared]) =>
      leftShared !== rightShared ? rightShared - leftShared : leftId < rightId ? -1 : leftId > rightId ? 1 : 0)
    .slice(0, candidateLimit)
    .map(([id]) => id);
}

type ScoreOverCandidatesResult = {
  result: ArchiveScoringResult;
  candidateIds: string[];
  /** Candidates whose whole-query 5-gram containment reached
   *  ARCHIVE_SELF_EXCLUSION_CONTAINMENT — the same set scoreAgainstArchive
   *  excludes. Used ONLY by the G1s gate; unordered. */
  selfExcludedRepresentationIds: string[];
  /** Every source the scorer admitted, in its presentation-rank order — a
   *  superset of `result.sources`, independent of the display cap. */
  admittedSourceIndexes: number[];
  /** The admitted sources that own at least one scored position. */
  contributingSourceIndexes: number[];
  /** canonical_text of the admitted sources (keyed by sourceIndex) — the
   *  retrieved text the span extension aligns against. */
  sourceTextByIndex: Map<number, string>;
  /** For each source in `sourceTextByIndex`: the query 5-gram hashes it
   *  contains — lets the span extension skip a source holding no seed gram
   *  without tokenizing its text. */
  sharedQueryHashesByIndex: Map<number, Set<string>>;
  /** For each query 5-gram hash present in any retrieved candidate: how many
   *  retrieved candidates contain it (self-excluded ones included, so it is
   *  never below the count the scorer's own runtime cap tests). Lets the span
   *  extension apply the scorer's gram-frequency gate. */
  candidateGramFrequency: Map<string, number>;
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
  client: ArchiveReadClient,
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
      admittedSourceIndexes: [],
      contributingSourceIndexes: [],
      sourceTextByIndex: new Map(),
      sharedQueryHashesByIndex: new Map(),
      candidateGramFrequency: new Map(),
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

  const { result, admittedSourceIndexes, contributingSourceIndexes } = scoreAgainstArchiveDetailed(
    submittedText,
    { shingleSize: ARCHIVE_SHINGLE_SIZE, documentCount, maximumDocumentFrequency, articles, getPostings },
    matchingParameters,
  );
  const admittedSourceIndexSet = new Set(admittedSourceIndexes);
  const sourceTextByIndex = new Map<number, string>();
  const sharedQueryHashesByIndex = new Map<number, Set<string>>();
  for (const row of textResult.rows) {
    const r = row as unknown as { id: string; canonical_text: string };
    const sourceIndex = sourceIndexByRepresentationId.get(String(r.id));
    if (sourceIndex === undefined || !admittedSourceIndexSet.has(sourceIndex)) continue;
    sourceTextByIndex.set(sourceIndex, String(r.canonical_text));
    const hashSet = hashSetByRepresentationId.get(String(r.id));
    const shared = new Set<string>();
    if (hashSet) for (const hash of queryHashes) if (hashSet.has(hash)) shared.add(hash);
    sharedQueryHashesByIndex.set(sourceIndex, shared);
  }
  const candidateGramFrequency = new Map<string, number>();
  for (const hash of queryHashes) {
    const count = postingsByHash.get(hash)?.length ?? 0;
    if (count > 0) candidateGramFrequency.set(hash, count);
  }
  return { result, candidateIds, selfExcludedRepresentationIds, admittedSourceIndexes, contributingSourceIndexes, sourceTextByIndex, sharedQueryHashesByIndex, candidateGramFrequency };
}

export type ArchiveSpanExtensionDiagnostics = {
  /** false when disabled by option or when the source weighting is not "raw"
   *  (the unique-positions score identity below holds only for raw). */
  enabled: boolean;
  /** rare (DF 1..RARE_SEED_MAX_DF), non-stop resolved query grams available as seeds */
  seedGramCount: number;
  /** submission positions whose 5-gram passed the seed gate */
  seedPositionCount: number;
  /** admitted sources holding at least one seed gram (their retrieved text was aligned against) */
  extendedSourceCount: number;
  alignmentCount: number;
  admittedAlignmentCount: number;
  /** token-pair equality checks the bounded extension performed */
  comparisonCount: number;
  /** SEED_EXTEND_MAX_ALIGNMENTS was reached */
  truncated: boolean;
  /** positions added to archiveMatchedPositions (none were in the exact result) */
  addedPositionCount: number;
};

function emptySpanExtension(enabled: boolean, seedGramCount = 0): ArchiveSpanExtensionDiagnostics {
  return {
    enabled,
    seedGramCount,
    seedPositionCount: 0,
    extendedSourceCount: 0,
    alignmentCount: 0,
    admittedAlignmentCount: 0,
    comparisonCount: 0,
    truncated: false,
    addedPositionCount: 0,
  };
}

/**
 * The additive verification step (see the SPAN EXTENSION note in the header).
 * `scored.result` is the UNCHANGED exact result. The extension aligns against
 * every admitted source (scored.admittedSourceIndexes, in presentation-rank
 * order — not only the displayed result.sources) and each new position is
 * attributed to the first of those sources whose admitted alignment contains
 * it. When nothing is added the exact result object is returned as-is.
 * Otherwise every exact position stays, and the new ones are added to
 * archiveMatchedPositions / matchedWordCount, to their source's matchedWords /
 * percent when that source is displayed (same floor formula; sources re-sorted
 * by the scorer's own comparator), and the score is similarityScore(unique
 * positions, words) — exactly aggregateSimilaritySources' raw-weighting score.
 * matches / phrases / longestMatchedSpan / containment features remain
 * exact-span derived.
 */
function applySpanExtension(
  scored: ScoreOverCandidatesResult,
  submissionWords: string[],
  seedGramHashes: ReadonlySet<string>,
  frequencyGate: { stopHashSet: ReadonlySet<string>; runtimeMaximumDocumentFrequency: number },
  enabled: boolean,
): { result: ArchiveScoringResult; diagnostics: ArchiveSpanExtensionDiagnostics } {
  const { result } = scored;
  if (!enabled || seedGramHashes.size === 0 || scored.admittedSourceIndexes.length === 0) {
    return { result, diagnostics: emptySpanExtension(enabled, seedGramHashes.size) };
  }
  // A source holding no seed gram can never launch an alignment: skip it
  // before paying for its tokenization.
  const sources = scored.admittedSourceIndexes.flatMap((sourceIndex) => {
    const text = scored.sourceTextByIndex.get(sourceIndex);
    const shared = scored.sharedQueryHashesByIndex.get(sourceIndex);
    if (text === undefined || !shared || ![...seedGramHashes].some((hash) => shared.has(hash))) return [];
    return [{ key: sourceIndex, words: tokens(text) }];
  });
  // The scorer's own gram-frequency gate (stop set, or more retrieved
  // candidates than the runtime cap): archive-common text such as licence
  // boilerplate is non-evidence for the extension exactly as for the exact path.
  const isFrequencyGatedGram = (hash: string) =>
    frequencyGate.stopHashSet.has(hash)
    || (scored.candidateGramFrequency.get(hash) ?? 0) > frequencyGate.runtimeMaximumDocumentFrequency;
  const { positionsBySource, stats } = seedExtendVerifiedPositions(submissionWords, sources, seedGramHashes, { isFrequencyGatedGram });

  const claimed = new Set(result.archiveMatchedPositions);
  const addedBySource = new Map<number, number[]>();
  for (const sourceIndex of scored.admittedSourceIndexes) {
    const added: number[] = [];
    for (const position of positionsBySource.get(sourceIndex) ?? []) {
      if (claimed.has(position)) continue;
      claimed.add(position);
      added.push(position);
    }
    if (added.length > 0) addedBySource.set(sourceIndex, added);
  }
  const addedPositionCount = claimed.size - result.archiveMatchedPositions.length;
  const diagnostics: ArchiveSpanExtensionDiagnostics = {
    enabled,
    seedGramCount: seedGramHashes.size,
    seedPositionCount: stats.seedPositions,
    extendedSourceCount: sources.length,
    alignmentCount: stats.alignments,
    admittedAlignmentCount: stats.admittedAlignments,
    comparisonCount: stats.comparisons,
    truncated: stats.truncated,
    addedPositionCount,
  };
  if (addedPositionCount === 0) return { result, diagnostics };

  const archiveMatchedPositions = [...claimed].sort((left, right) => left - right);
  const extendedSources = result.sources
    .map((source) => {
      const added = addedBySource.get(source.sourceIndex) ?? [];
      if (added.length === 0) return source;
      const matchedWords = source.matchedWords + added.length;
      const attributed = source.attributedRanges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
      return {
        ...source,
        matchedWords,
        attributedRanges: mergeAdjacentPositions([...attributed, ...added]),
        percent: Math.floor((matchedWords / Math.max(result.wordCount, 1)) * 100),
      };
    })
    .sort((left, right) => right.percent - left.percent || right.matches - left.matches);
  return {
    result: {
      ...result,
      matchedWordCount: archiveMatchedPositions.length,
      archiveMatchedPositions,
      score: similarityScore(archiveMatchedPositions.length, result.wordCount),
      sources: extendedSources,
      // A source can come to own scored words only through the extension.
      verifiedSourceCount: new Set([...scored.contributingSourceIndexes, ...addedBySource.keys()]).size,
    },
    diagnostics,
  };
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
    /** FTS queries the DF-resolution pass issued (per-gram checks + group existence queries). */
    dfResolveQueries: number;
    /** rare seeds (unmatched-region 5-grams with archive DF 1..3) found by the DF checks. */
    rareSeedCount: number;
    /** NEW candidates nominated by corroborated rare seeds (then verified by the scorer). */
    rareSeedCandidateCount: number;
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
  /** Span-extension diagnostics — server/test-only, never serialised. */
  archiveSpanExtension: ArchiveSpanExtensionDiagnostics;
};

export async function matchAgainstArchiveCorpus(
  client: ArchiveReadClient,
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
  const spanExtensionEnabled = options.spanExtension !== false
    && (options.matchingParameters?.sourceWeighting ?? "raw") === "raw";

  const emptyDiscovery = {
    compactCandidateCount: 0,
    phraseCandidateCount: 0,
    unionCandidateCount: 0,
    phraseProbeCount: 0,
    admittedPhraseProbeCount: 0,
    maxAdmittedPhraseFanOut: 0,
    dfResolveChecks: 0,
    dfResolveQueries: 0,
    rareSeedCount: 0,
    rareSeedCandidateCount: 0,
  };

  if (queryHashes.size === 0 || documentCount === 0) {
    const empty = scoreAgainstArchive(
      submittedText,
      { shingleSize: ARCHIVE_SHINGLE_SIZE, documentCount, maximumDocumentFrequency: options.maximumDocumentFrequency, articles: [], getPostings: () => [] },
      options.matchingParameters,
    );
    return { ...empty, archiveDiscovery: emptyDiscovery, archiveSpanExtension: emptySpanExtension(spanExtensionEnabled) };
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

  // 2) bounded phrase fallback — discovery only. Fed the primary result's full
  //    admitted union, so the display cap never influences discovery.
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

  // 4) span extension (verification only) — seeds are the rare, non-stop grams
  //    the fallback pass resolved; applied to whichever scored result is returned.
  const submissionWords = tokens(submittedText);
  const seedGramHashes = new Set(fallback.rareGramHashes.filter((hash) => !stopHashSet.has(hash)));
  // scoreAgainstArchive's own runtime cap: min(index cap, matchingParameters cap)
  const runtimeMaximumDocumentFrequency = Math.min(
    options.maximumDocumentFrequency,
    options.matchingParameters?.maximumDocumentFrequency ?? options.maximumDocumentFrequency,
  );
  const extend = (scored: ScoreOverCandidatesResult) =>
    applySpanExtension(scored, submissionWords, seedGramHashes, { stopHashSet, runtimeMaximumDocumentFrequency }, spanExtensionEnabled);

  const admitted = fallback.perProbe.filter((p) => p.admitted);
  const baseDiscovery = {
    compactCandidateCount: compactCandidateIds.length,
    phraseCandidateCount: fallback.phraseCandidateIds.length,
    unionCandidateCount: fallback.unionCandidateIds.length,
    phraseProbeCount: fallback.probes.length,
    admittedPhraseProbeCount: admitted.length,
    maxAdmittedPhraseFanOut: admitted.reduce((m, p) => Math.max(m, p.fanOut), 0),
    dfResolveChecks: fallback.dfResolveChecks,
    dfResolveQueries: fallback.dfResolveQueries,
    rareSeedCount: fallback.rareSeedCount,
    rareSeedCandidateCount: fallback.rareSeedCandidateIds.length,
  };

  // ── committed-B behaviour — the ONLY path when the flag is off ────────────
  // (byte-identical to the pre-2D.4 matcher: no `cosource` diagnostics field)
  if (!isArchiveCosourceExpansionEnabled()) {
    const extended = extend(final);
    return { ...extended.result, archiveDiscovery: baseDiscovery, archiveSpanExtension: extended.diagnostics };
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
    const extended = extend(final);
    return { ...extended.result, archiveDiscovery: { ...baseDiscovery, cosource: cosourceBase }, archiveSpanExtension: extended.diagnostics };
  }

  // Anchors → bounded adjacency lookup → union/dedupe with the primary
  // candidates → canonical reconstruction + UNCHANGED scoreAgainstArchive.
  const cosourceNeighborIds = await loadCosources(client, selfExcludedIds, {
    policyVersion: options.cosourcePolicyVersion,
  });
  const expandedUnionIds = [...new Set([...fallback.unionCandidateIds, ...cosourceNeighborIds])];

  if (expandedUnionIds.length === fallback.unionCandidateIds.length) {
    // adjacency added no new candidate — committed-B result stands unchanged
    const extended = extend(final);
    return {
      ...extended.result,
      archiveDiscovery: {
        ...baseDiscovery,
        cosource: { ...cosourceBase, anchorCount: selfExcludedIds.length, neighborCount: cosourceNeighborIds.length },
      },
      archiveSpanExtension: extended.diagnostics,
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
  const extended = extend(expanded);
  return {
    ...extended.result,
    archiveSpanExtension: extended.diagnostics,
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
