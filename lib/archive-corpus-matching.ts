import type { Client } from "@libsql/client";
import { tokens, grams, gramHash } from "./similarity-core";
import { scoreAgainstArchive, type ArchiveScoringResult, type ArchiveScoringMatchingParameters } from "./archive-similarity-scoring";
import { findCandidateCorpusRepresentations } from "./user-submission-corpus";
import { ARCHIVE_FINGERPRINT_VERSION, ARCHIVE_SHINGLE_SIZE } from "./archive-corpus-seed";

/**
 * 100k-scale architecture, slice 1 (server-side archive parity foundation).
 *
 * The server-side counterpart to app/similarity-worker.ts's client-side
 * static-index lookup: discovers archive candidates via the SAME scalable,
 * indexed machinery the live historical-match path uses
 * (findCandidateCorpusRepresentations), then runs the IDENTICAL scoring
 * algorithm (lib/archive-similarity-scoring.ts's scoreAgainstArchive) over
 * DB-backed postings instead of a static binary index. Read-only; never
 * writes anything. Not wired into POST /api/reports or any live scoring
 * path yet — see this slice's own task description ("do not change the
 * user-visible similarity result yet").
 *
 * DISCOVERY, NOT A FULL SCAN: the browser's static index effectively "sees"
 * every one of the archive's documents on every analysis (the whole
 * postings array is already resident in memory). This adapter instead asks
 * findCandidateCorpusRepresentations for only the archive representations
 * that share at least one 5-gram with the submission — at 100k+ archive
 * documents this is the difference between "shippable" and "not." At
 * today's 321-document archive this candidate set is, in practice, the same
 * set the browser's exclusion/scoring passes would ever assign a non-zero
 * `shared` count to anyway (see scoreAgainstArchive's own step 1: an article
 * with zero shared shingles has containment 0 and can never be excluded or
 * scored), so no accuracy is traded away at current scale — `candidateLimit`
 * just needs to stay above the true archive size, which it does by a wide
 * margin. A LATER slice should apply the same maxDF-style query-time pruning
 * lib/user-submission-corpus.ts's applyHighFrequencyShinglePruning already
 * proved out for the live corpus, once the archive itself grows large enough
 * for that to matter — see this repo's own 100k-scale architecture analysis.
 *
 * ALL 5-GRAMS, NOT JUST INFORMATIVE ONES: matches how the archive was
 * seeded (lib/archive-corpus-seed.ts) and how the browser's own static index
 * was built — see that module's header for the grep-verified reason
 * (scripts/build-document-corpus.py's informative() filter is dead code).
 *
 * getPostings is served from ONE bulk fetch of every shingle row belonging
 * to the discovered candidates (not one query per submission gram, which
 * would be thousands of round trips for a long document) — a
 * `representation_id IN (...)` scan bounded by candidate count x their own
 * shingle counts, never by total archive size. The in-repo document-
 * frequency cap (meta.json's own maximumDocumentFrequency) is then applied
 * purely in memory against that already-fetched map, reproducing the
 * browser static index's own build-time exclusion (a hash whose true
 * document frequency exceeds the cap is absent from the index and therefore
 * never returned by a lookup) without any corpus-size-proportional query.
 *
 * MATURITY: candidate discovery runs under CorpusEligibilityMode "ARCHIVE"
 * (lib/user-submission-corpus.ts), NOT "MATCHING" — a representation is an
 * archive candidate iff it has an archive_document_representations row, full
 * stop, with no 7-day maturity term at all. This is deliberate and narrower
 * than backdating first_seen_at at seed time alone would guarantee:
 * lib/archive-corpus-seed.ts's seedArchiveDocument dedupes by canonical
 * hash, so seeding an archive document whose text byte-for-byte matches an
 * EXISTING, unrelated, still-immature representation (e.g. an ordinary
 * user's submission from moments ago) reuses that row without touching its
 * first_seen_at — "ARCHIVE" mode is what still makes it immediately eligible
 * for archive matching in that case, while ordinary historical matching
 * (CorpusEligibilityMode "MATCHING", lib/user-submission-matching.ts) keeps
 * treating that same representation as immature until its own first_seen_at
 * clears the normal window. See tests/archive-corpus-parity.test.mjs's
 * "reused representation" test for the exact scenario proved end to end.
 */

export type MatchAgainstArchiveCorpusOptions = {
  fingerprintVersion?: string;
  /** The archive build's own maximumDocumentFrequency (public/data/document-index.meta.json) — required, never silently defaulted, so this can never drift from the value the browser engine actually used to build its index. */
  maximumDocumentFrequency: number;
  matchingParameters?: ArchiveScoringMatchingParameters;
  /** Candidate-discovery LIMIT — must stay >= the true archive size for exact parity (see this module's own header). Default is generous for archive sizes well past today's 321 documents. */
  candidateLimit?: number;
  /**
   * UNUSED as of the "ARCHIVE" eligibility mode (lib/user-submission-corpus.ts's
   * CorpusEligibilityMode): archive candidates are never subject to the 7-day
   * maturity gate, so no cutoff is ever computed or applied here. Kept as
   * accepted-but-ignored fields for API stability rather than removed —
   * passing either is harmless.
   */
  maturityCutoff?: string;
  asOf?: Date;
};

type CandidateShingleRow = { representation_id: string; shingle_hash: string };
type CandidateOrderRow = { representation_id: string; title: string; archive_order: number | bigint | null };

export async function matchAgainstArchiveCorpus(
  client: Client,
  submittedText: string,
  options: MatchAgainstArchiveCorpusOptions,
): Promise<ArchiveScoringResult> {
  const fingerprintVersion = options.fingerprintVersion ?? ARCHIVE_FINGERPRINT_VERSION;
  const candidateLimit = options.candidateLimit ?? 5_000;

  const queryHashes = new Set<string>();
  for (const gram of grams(tokens(submittedText), ARCHIVE_SHINGLE_SIZE)) queryHashes.add(gramHash(gram));

  const documentCountResult = await client.execute({
    sql: "SELECT COUNT(*) AS total FROM archive_document_representations WHERE fingerprint_version = ?",
    args: [fingerprintVersion],
  });
  const documentCount = Number((documentCountResult.rows[0] as unknown as { total: number | bigint }).total);

  const emptyIndex = { shingleSize: ARCHIVE_SHINGLE_SIZE, documentCount, maximumDocumentFrequency: options.maximumDocumentFrequency, articles: [], getPostings: () => [] };
  if (queryHashes.size === 0 || documentCount === 0) {
    return scoreAgainstArchive(submittedText, emptyIndex, options.matchingParameters);
  }

  const candidates = await findCandidateCorpusRepresentations(client, queryHashes, {
    fingerprintVersion,
    minSharedShingles: 1,
    limit: candidateLimit,
    // "ARCHIVE" mode (not "MATCHING"): eligibility is "has an
    // archive_document_representations row," never subject to the 7-day
    // maturity gate — see that mode's own doc comment in
    // lib/user-submission-corpus.ts for why first_seen_at can't be trusted
    // here once seedArchiveDocument reuses an existing, possibly-immature
    // representation via canonical-hash dedup.
    eligibilityMode: "ARCHIVE",
  });
  if (candidates.length === 0) {
    return scoreAgainstArchive(submittedText, emptyIndex, options.matchingParameters);
  }

  const candidateIds = candidates.map((candidate) => candidate.representationId);
  const placeholders = candidateIds.map(() => "?").join(",");
  const [orderResult, shingleResult] = await Promise.all([
    client.execute({
      sql: `SELECT representation_id, title, archive_order FROM archive_document_representations
            WHERE fingerprint_version = ? AND representation_id IN (${placeholders})`,
      args: [fingerprintVersion, ...candidateIds],
    }),
    client.execute({
      sql: `SELECT representation_id, shingle_hash FROM corpus_document_shingles
            WHERE fingerprint_version = ? AND representation_id IN (${placeholders})`,
      args: [fingerprintVersion, ...candidateIds],
    }),
  ]);

  // sourceIndex is assigned from archive_order (the browser static index's
  // own fixed, build-time, query-independent document order), NEVER from
  // this query's own "most shared shingles first" ranking — see
  // archive_document_representations.archive_order's migration comment for
  // why a query-dependent assignment would silently diverge from the
  // browser on same-score winner-take-all ties. NULL archive_order sorts
  // last; ties within that (or within an equal archive_order, which
  // shouldn't happen for real seeded data) fall back to representation_id
  // for a fully deterministic order.
  const orderedCandidates = (orderResult.rows as unknown as CandidateOrderRow[]).slice().sort((left, right) => {
    const leftOrder = left.archive_order === null ? Number.POSITIVE_INFINITY : Number(left.archive_order);
    const rightOrder = right.archive_order === null ? Number.POSITIVE_INFINITY : Number(right.archive_order);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.representation_id < right.representation_id ? -1 : left.representation_id > right.representation_id ? 1 : 0;
  });
  const sourceIndexByRepresentationId = new Map<string, number>(
    orderedCandidates.map((row, index) => [row.representation_id, index]),
  );
  const titleByRepresentationId = new Map(orderedCandidates.map((row) => [row.representation_id, row.title]));

  const postingsByHash = new Map<string, number[]>();
  const shingleCountByRepresentationId = new Map<string, number>();
  for (const row of shingleResult.rows as unknown as CandidateShingleRow[]) {
    const sourceIndex = sourceIndexByRepresentationId.get(row.representation_id);
    if (sourceIndex === undefined) continue; // defensive: cannot happen, candidateIds is the IN() list itself
    shingleCountByRepresentationId.set(row.representation_id, (shingleCountByRepresentationId.get(row.representation_id) ?? 0) + 1);
    const list = postingsByHash.get(row.shingle_hash);
    if (list) list.push(sourceIndex);
    else postingsByHash.set(row.shingle_hash, [sourceIndex]);
  }

  const articles = orderedCandidates.map((row) => ({
    title: titleByRepresentationId.get(row.representation_id) ?? row.representation_id,
    sourceType: "Publication" as const,
    uniqueShingleCount: shingleCountByRepresentationId.get(row.representation_id) ?? 0,
  }));

  const getPostings = (hash: string): number[] => {
    const postings = postingsByHash.get(hash);
    if (!postings || postings.length === 0) return [];
    // Mirrors the browser static index's own build-time exclusion: a hash
    // whose document frequency exceeds the cap is absent from the index
    // entirely, so a lookup for it finds nothing — never a truncated list.
    if (postings.length > options.maximumDocumentFrequency) return [];
    return postings;
  };

  return scoreAgainstArchive(
    submittedText,
    { shingleSize: ARCHIVE_SHINGLE_SIZE, documentCount, maximumDocumentFrequency: options.maximumDocumentFrequency, articles, getPostings },
    options.matchingParameters,
  );
}
