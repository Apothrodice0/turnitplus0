import type { Client } from "@libsql/client";
import { tokens, grams, gramHash, informativeGram } from "./similarity-core";
import { ARCHIVE_SHINGLE_SIZE } from "./archive-fingerprint";
import { loadDfBandMap, deriveStopHashSet, ARCHIVE_DF_BAND_POLICY_VERSION, SCORER_STOP_THRESHOLD } from "./archive-df-bands";

/**
 * 100k-scale architecture, slice 2D.4 — the archive-document CO-SOURCE
 * adjacency graph (drizzle/0050) and its request-time lookup.
 *
 * WHAT IT IS: a directed graph over archive documents. An edge
 * representation_id -> co_representation_id means the two documents share at
 * least ARCHIVE_COSOURCE_MIN_SHARED archive-informative, non-stop, owner-capped
 * 5-grams; each document keeps only its ARCHIVE_COSOURCE_MAX_NEIGHBORS
 * highest-sharing neighbours (deterministic tie-break — see buildCosourceAdjacencyTable).
 *
 * WHY: the bounded compact+phrase archive discovery pipeline (slices 2A/2B)
 * recovers no similarity at all when compact discovery returns ONLY
 * self-excluding candidates — the near-duplicate-collapse case. Slices
 * 2D.1-2D.3 validated a targeted fix (the "G1s" gate, implemented in
 * lib/archive-corpus-matching.ts): when the primary result genuinely
 * collapsed, take the self-excluded candidates as anchors, union their
 * co-source neighbours into the candidate set, and re-run the UNCHANGED
 * scoreAgainstArchive. This module is the derived adjacency structure that
 * makes that lookup O(anchors) instead of an O(N^2) all-pairs scan.
 *
 * DERIVED / REBUILDABLE: every row is reconstructed from
 * corpus_document_representations.canonical_text plus the archive_hash_df_bands
 * stop set — no persistent full archive shingle table is read or written
 * (archive-shingle-v1 writes stay 0). Build is offline / index-time only
 * (lib/archive-index-build.ts), never a live request path, and idempotent.
 *
 * NOT read by admissionEligibilitySql or any historical-corpus / SELF /
 * relationship / maturity predicate. lib/archive-corpus-matching.ts is the
 * sole reader, and only when isArchiveCosourceExpansionEnabled() is true.
 */

/** CO-SOURCE POLICY generation. Bump on any change to MIN_SHARED / MAX_NEIGHBORS
 *  / the owner cap / the informative-or-stop gram filter / the tie-break. Part
 *  of every archive_document_cosources row (policy_version) so a re-tune builds
 *  a new generation beside the old rows. Deliberately distinct from
 *  ARCHIVE_COMPACT_FINGERPRINT_VERSION / ARCHIVE_DF_BAND_POLICY_VERSION /
 *  ARCHIVE_PHRASE_INDEX_VERSION. Frozen at the Slice 2D.3 M2/K24 lock. */
export const ARCHIVE_COSOURCE_POLICY_VERSION = "archive-cosource-v1";

/** An edge is kept only when the two documents share at least this many
 *  archive-informative, non-stop, owner-capped 5-grams. Slice 2D.3 lock. */
export const ARCHIVE_COSOURCE_MIN_SHARED = 2;

/** Each document keeps at most this many outgoing co-source neighbours (its
 *  highest-sharing ones). Slice 2D.3 lock (K=24). Also enforced at the schema
 *  level by drizzle/0050's trg_archive_document_cosources_max_neighbors. */
export const ARCHIVE_COSOURCE_MAX_NEIGHBORS = 24;

/**
 * Informative 5-grams owned by MORE than this many archive documents are
 * excluded from co-occurrence accumulation (a common-phrasing guard that keeps
 * the build bounded toward 100k). Equal to the archive build's
 * maximumDocumentFrequency / the df-band stop threshold (SCORER_STOP_THRESHOLD,
 * 12) — the same cut the scorer and the phrase selector already use. Frozen
 * for v1 with the policy version; a change bumps ARCHIVE_COSOURCE_POLICY_VERSION.
 */
export const ARCHIVE_COSOURCE_OWNER_CAP = SCORER_STOP_THRESHOLD; // 12

const INSERT_BATCH_ROWS = 4_000;
const LOOKUP_ANCHOR_CHUNK = 400;

export type ArchiveCosourceRepresentation = {
  /** corpus_document_representations.id backing an archive document. */
  representationId: string;
  /** corpus_document_representations.canonical_text. */
  canonicalText: string;
  /** archive_document_representations.archive_order — the caller MUST pass the
   *  representations already sorted by this (ascending), then representationId
   *  ascending, so the build's tie-break is deterministic and reproduces the
   *  Slice 2D.3 prototype. */
  archiveOrder: number | null;
};

export type CosourceAdjacencyBuildResult = {
  policyVersion: string;
  minShared: number;
  maxNeighbors: number;
  ownerCap: number;
  /** total directed edges persisted for this policy generation. */
  edgeRows: number;
  documentsConsidered: number;
  documentsWithEdges: number;
  rowsPerDoc: { p50: number; p95: number; max: number; min: number };
};

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length))];
}

/**
 * Deterministic (re)build. Reproduces the EXACT Slice 2D.3 M2/K24 semantics —
 * NOT a new similarity heuristic:
 *
 *   1. Inverted informative-gram -> owner list (archive-order iteration order),
 *      so accumulation is O(sum of per-doc informative grams), never O(N^2).
 *   2. For each document, in archive-order, scan its own de-duplicated
 *      informative 5-grams; skip a gram that is in the df-band stop set OR
 *      owned by more than the owner cap; for every OTHER owner of a surviving
 *      gram, +1 its shared count (a plain Map — insertion order is the
 *      tie-break key below).
 *   3. Keep neighbours with shared count >= MIN_SHARED, sort by shared count
 *      DESCENDING (a stable sort — ties keep first-co-occurrence order), take
 *      the top MAX_NEIGHBORS.
 *
 * Replaces this policy generation's rows only (DELETE WHERE policy_version = ?
 * then INSERT); no DROP, no table ownership. Idempotent — a re-run rebuilds
 * byte-identical rows.
 */
export async function buildCosourceAdjacencyTable(
  client: Client,
  representations: ArchiveCosourceRepresentation[],
  opts: {
    policyVersion?: string;
    dfBandPolicyVersion?: string;
    minShared?: number;
    maxNeighbors?: number;
    ownerCap?: number;
  } = {},
): Promise<CosourceAdjacencyBuildResult> {
  const policyVersion = opts.policyVersion ?? ARCHIVE_COSOURCE_POLICY_VERSION;
  const minShared = opts.minShared ?? ARCHIVE_COSOURCE_MIN_SHARED;
  const maxNeighbors = opts.maxNeighbors ?? ARCHIVE_COSOURCE_MAX_NEIGHBORS;
  const ownerCap = opts.ownerCap ?? ARCHIVE_COSOURCE_OWNER_CAP;

  const { bandByHash } = await loadDfBandMap(client, {
    policyVersion: opts.dfBandPolicyVersion ?? ARCHIVE_DF_BAND_POLICY_VERSION,
  });
  const stopHashSet = deriveStopHashSet(bandByHash, ownerCap);

  // Per-doc de-duplicated informative 5-gram hash lists, computed once.
  const informativeHashesByRep: { representationId: string; hashes: string[] }[] = [];
  const owners = new Map<string, string[]>();
  for (const rep of representations) {
    const seen = new Set<string>();
    const hashes: string[] = [];
    for (const gram of grams(tokens(rep.canonicalText), ARCHIVE_SHINGLE_SIZE)) {
      if (!informativeGram(gram)) continue;
      const hash = gramHash(gram);
      if (seen.has(hash)) continue;
      seen.add(hash);
      hashes.push(hash);
      let list = owners.get(hash);
      if (!list) owners.set(hash, (list = []));
      list.push(rep.representationId);
    }
    informativeHashesByRep.push({ representationId: rep.representationId, hashes });
  }

  await client.execute({
    sql: `DELETE FROM archive_document_cosources WHERE policy_version = ?`,
    args: [policyVersion],
  });

  let edgeRows = 0;
  let documentsWithEdges = 0;
  const rowsPerDoc: number[] = [];
  let batch: { sql: string; args: (string | number)[] }[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await client.batch(batch, "write");
    batch = [];
  };

  for (const { representationId, hashes } of informativeHashesByRep) {
    const sharedCount = new Map<string, number>(); // co-representation_id -> shared gram count (insertion order = tie-break)
    for (const hash of hashes) {
      if (stopHashSet.has(hash)) continue;
      const list = owners.get(hash);
      if (!list || list.length > ownerCap) continue;
      for (const owner of list) {
        if (owner === representationId) continue;
        sharedCount.set(owner, (sharedCount.get(owner) ?? 0) + 1);
      }
    }
    const neighbours = [...sharedCount.entries()]
      .filter(([, n]) => n >= minShared)
      .sort((left, right) => right[1] - left[1])
      .slice(0, maxNeighbors);

    if (neighbours.length > 0) documentsWithEdges += 1;
    rowsPerDoc.push(neighbours.length);

    for (const [coRepresentationId, shared] of neighbours) {
      batch.push({
        sql: `INSERT INTO archive_document_cosources
              (representation_id, co_representation_id, shared_gram_count, policy_version)
              VALUES (?,?,?,?)`,
        args: [representationId, coRepresentationId, shared, policyVersion],
      });
      edgeRows += 1;
      if (batch.length >= INSERT_BATCH_ROWS) await flush();
    }
  }
  await flush();

  const sorted = rowsPerDoc.slice().sort((a, b) => a - b);
  return {
    policyVersion,
    minShared,
    maxNeighbors,
    ownerCap,
    edgeRows,
    documentsConsidered: representations.length,
    documentsWithEdges,
    rowsPerDoc: {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      min: sorted.length ? sorted[0] : 0,
    },
  };
}

/**
 * Request-time bounded lookup. Given the self-excluded archive representation
 * IDs that G1s picked as anchors, return the de-duplicated set of their
 * co-source neighbour representation IDs for `policyVersion`.
 *
 *   - only the requested anchors are queried (one IN (...) query per
 *     LOOKUP_ANCHOR_CHUNK anchors — in practice a single query, since an
 *     anchor is a self-excluding compact candidate and there are only ever a
 *     handful)
 *   - at most ARCHIVE_COSOURCE_MAX_NEIGHBORS rows per anchor (schema-enforced)
 *   - never returns an anchor itself
 *   - never an N+1-per-neighbour query
 */
export async function loadCosources(
  client: Client,
  anchorRepresentationIds: string[],
  opts: { policyVersion?: string } = {},
): Promise<string[]> {
  const policyVersion = opts.policyVersion ?? ARCHIVE_COSOURCE_POLICY_VERSION;
  const anchors = [...new Set(anchorRepresentationIds)];
  if (anchors.length === 0) return [];
  const anchorSet = new Set(anchors);
  const out = new Set<string>();
  for (let i = 0; i < anchors.length; i += LOOKUP_ANCHOR_CHUNK) {
    const slice = anchors.slice(i, i + LOOKUP_ANCHOR_CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const res = await client.execute({
      sql: `SELECT co_representation_id FROM archive_document_cosources
             WHERE policy_version = ? AND representation_id IN (${placeholders})`,
      args: [policyVersion, ...slice],
    });
    for (const row of res.rows) {
      const id = String((row as unknown as { co_representation_id: string }).co_representation_id);
      if (!anchorSet.has(id)) out.add(id);
    }
  }
  return [...out];
}

/**
 * The single gate for the whole co-source expansion feature. Read fresh on
 * every call (no caching) so a flag flip takes effect without a restart, the
 * same shape lib/device-passport-server.ts / lib/corpus-source-matching-flag.ts
 * use. Absent / anything but the exact string "true" => OFF.
 */
export function isArchiveCosourceExpansionEnabled(): boolean {
  return process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED === "true";
}
