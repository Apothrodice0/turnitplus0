// Baseline B — the CORRECTNESS ORACLE for the scalable archive matcher, per
// Slice 2A.4 / 2A.5. B = EXHAUSTIVE discovery (every archive document sharing
// at least one query 5-gram, found by reconstructing every archive doc's full
// 5-gram hash set from canonical_text) + reconstructed postings + the SAME
// archive-global stop-hash DF the production matcher derives from
// archive_hash_df_bands → the UNMODIFIED scoreAgainstArchive.
//
// B is allowed to be exhaustive / slow. It is NEVER shipped — it only exists
// so tests can assert matchAgainstArchiveCorpus (compact discovery + bounded
// FTS phrase fallback + df-band pruning) reproduces it.

import { tokens, grams, gramHash } from "../../lib/similarity-core.ts";
import { scoreAgainstArchive } from "../../lib/archive-similarity-scoring.ts";
import { ARCHIVE_SHINGLE_SIZE, archiveShingleHashes } from "../../lib/archive-fingerprint.ts";
import { ARCHIVE_FINGERPRINT_VERSION } from "../../lib/archive-corpus-seed.ts";
import { loadDfBandMap, deriveStopHashSet } from "../../lib/archive-df-bands.ts";

export function normalizeArchiveResult(r) {
  return {
    score: r.score,
    matchedWordCount: r.matchedWordCount,
    archiveMatchedPositions: r.archiveMatchedPositions,
    excludedDocuments: r.excludedDocuments,
    highFrequencyShingleCount: r.highFrequencyShingleCount,
    sources: r.sources
      .map((s) => ({ name: s.name, percent: s.percent, matchedWords: s.matchedWords }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Load every archive representation's { id, archive_order, title, hashSet }. */
export async function loadArchiveDocsForBaselineB(client) {
  const rows = await client.execute(
    `SELECT a.representation_id AS id, a.title AS title, a.archive_order AS archive_order, c.canonical_text AS canonical_text
       FROM archive_document_representations a
       JOIN corpus_document_representations c ON c.id = a.representation_id`,
  );
  return rows.rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    archiveOrder: r.archive_order === null || r.archive_order === undefined ? null : Number(r.archive_order),
    hashSet: archiveShingleHashes(String(r.canonical_text), ARCHIVE_SHINGLE_SIZE),
  }));
}

/**
 * Compute Baseline B for one submission.
 * @param {import('@libsql/client').Client} client
 * @param {string} submittedText
 * @param {{ maximumDocumentFrequency: number, matchingParameters?: object, dfBandPolicyVersion?: string }} options
 */
export async function baselineB(client, submittedText, options) {
  const documentCount = Number(
    (await client.execute({
      sql: "SELECT COUNT(*) AS total FROM archive_document_representations WHERE fingerprint_version = ?",
      args: [ARCHIVE_FINGERPRINT_VERSION],
    })).rows[0].total,
  );

  const queryHashes = new Set();
  for (const gram of grams(tokens(submittedText), ARCHIVE_SHINGLE_SIZE)) queryHashes.add(gramHash(gram));

  const emptyIndex = {
    shingleSize: ARCHIVE_SHINGLE_SIZE,
    documentCount,
    maximumDocumentFrequency: options.maximumDocumentFrequency,
    articles: [],
    getPostings: () => [],
  };
  if (queryHashes.size === 0 || documentCount === 0) {
    return scoreAgainstArchive(submittedText, emptyIndex, options.matchingParameters);
  }

  const { bandByHash } = await loadDfBandMap(client, { policyVersion: options.dfBandPolicyVersion });
  const stopHashSet = deriveStopHashSet(bandByHash, options.maximumDocumentFrequency);

  const docs = await loadArchiveDocsForBaselineB(client);
  // EXHAUSTIVE: every archive doc sharing >= 1 query 5-gram.
  const candidates = docs.filter((d) => {
    for (const h of queryHashes) if (d.hashSet.has(h)) return true;
    return false;
  });
  if (candidates.length === 0) {
    return scoreAgainstArchive(submittedText, emptyIndex, options.matchingParameters);
  }

  const ordered = candidates.slice().sort((l, r) => {
    const lo = l.archiveOrder === null ? Number.POSITIVE_INFINITY : l.archiveOrder;
    const ro = r.archiveOrder === null ? Number.POSITIVE_INFINITY : r.archiveOrder;
    if (lo !== ro) return lo - ro;
    return l.id < r.id ? -1 : l.id > r.id ? 1 : 0;
  });
  const sourceIndexById = new Map(ordered.map((d, i) => [d.id, i]));
  const postingsByHash = new Map();
  for (const d of ordered) {
    const si = sourceIndexById.get(d.id);
    for (const h of d.hashSet) {
      const list = postingsByHash.get(h);
      if (list) list.push(si);
      else postingsByHash.set(h, [si]);
    }
  }
  const articles = ordered.map((d) => ({ title: d.title, sourceType: "Publication", uniqueShingleCount: d.hashSet.size }));
  const getPostings = (hash) => (stopHashSet.has(hash) ? [] : (postingsByHash.get(hash) ?? []));

  return scoreAgainstArchive(
    submittedText,
    { shingleSize: ARCHIVE_SHINGLE_SIZE, documentCount, maximumDocumentFrequency: options.maximumDocumentFrequency, articles, getPostings },
    options.matchingParameters,
  );
}
