import type { ArchiveReadClient } from "../archive-read-retry";
import {
  PMC_COMPACT_FINGERPRINT_VERSION,
  PMC_STAGE_A_TOP_K,
  PMC_FINGERPRINT_QUERY_CHUNK,
  PMC_STAGE_A_MAX_POSTING_ROWS,
  PMC_STAGE_A_MAX_CANDIDATES,
} from "./constants";

/**
 * PMC OA scholarly-coverage SHADOW slice — bounded Stage A SQL retrieval + the
 * <= 20-candidate text load. Read-only; every statement opens with SELECT and
 * carries no write/DDL keyword, so the caller's lib/archive-read-retry.ts
 * wrapper recognises them as read-shaped and applies its bounded transient
 * retry budget.
 *
 * FINGERPRINT HITS NEVER SCORE HERE. This module only tallies which documents
 * share winnowed fingerprints with the (already DF-band-filtered, already
 * capped) submission fingerprint set and returns the top-K by a DF-discounted
 * weight. All scoring is lib/pmc-coverage/verify.ts running the UNMODIFIED
 * scoreAgainstArchive over the texts this module loads.
 */

export type PmcStageACandidate = {
  pmcId: string;
  matchedFingerprints: number;
  /** Sum over matched query fingerprints of 1 / log2(2 + postingCount) — the
   *  same DF-discount the prototype used; down-weights fingerprints shared by
   *  many documents so a distinctive overlap ranks above a generic one. */
  weight: number;
};

export type PmcStageAResult = {
  candidates: PmcStageACandidate[];
  /** Winnowed submission fingerprints actually issued to the DB (post stop-set,
   *  post cap). */
  queryFingerprintsUsed: number;
  /** Winnowed submission fingerprints removed by the DF-band stop set. */
  stoppedFingerprints: number;
  /** Posting rows that pointed at an is_retracted document and were skipped. */
  tombstonedHits: number;
  /** True when PMC_STAGE_A_MAX_POSTING_ROWS or PMC_STAGE_A_MAX_CANDIDATES
   *  clipped the scan. */
  truncated: boolean;
};

/** The small set of retracted PMCIDs — loaded once per evaluation so Stage A
 *  can exclude them from tallying AND count how many posting rows they
 *  accounted for, without a per-chunk join. Retractions are rare (~0.1% in the
 *  validated corpus). */
export async function loadRetractedPmcIds(client: ArchiveReadClient): Promise<Set<string>> {
  const rows = await client.execute({
    sql: `SELECT pmc_id FROM pmc_coverage_documents WHERE is_retracted = 1`,
    args: [],
  });
  const out = new Set<string>();
  for (const r of rows.rows) out.add(String((r as unknown as { pmc_id: string }).pmc_id));
  return out;
}

/**
 * DF-banded fingerprint candidate retrieval. `stopHashes` (from
 * lib/pmc-coverage/df-bands.ts derivePmcStopHashSet) removes common 5-grams
 * BEFORE any DB read, so every surviving fingerprint fans out to <= 12
 * documents. `retractedPmcIds` are tombstones — their posting rows are counted
 * (tombstonedHits) but never tallied.
 */
export async function retrievePmcStageACandidates(
  client: ArchiveReadClient,
  submissionFingerprints: readonly string[],
  stopHashes: ReadonlySet<string>,
  retractedPmcIds: ReadonlySet<string>,
  opts: {
    topK?: number;
    chunkSize?: number;
    fingerprintVersion?: string;
    maxPostingRows?: number;
    maxCandidates?: number;
  } = {},
): Promise<PmcStageAResult> {
  const topK = opts.topK ?? PMC_STAGE_A_TOP_K;
  const chunkSize = opts.chunkSize ?? PMC_FINGERPRINT_QUERY_CHUNK;
  const fingerprintVersion = opts.fingerprintVersion ?? PMC_COMPACT_FINGERPRINT_VERSION;
  const maxPostingRows = opts.maxPostingRows ?? PMC_STAGE_A_MAX_POSTING_ROWS;
  const maxCandidates = opts.maxCandidates ?? PMC_STAGE_A_MAX_CANDIDATES;

  const eligible: string[] = [];
  let stoppedFingerprints = 0;
  for (const fp of submissionFingerprints) {
    if (stopHashes.has(fp)) stoppedFingerprints += 1;
    else eligible.push(fp);
  }

  // Per-document tallies. postingCountByHash is filled from the actual returned
  // rows (DF within the corpus for hashes below the persisted band), used for
  // the DF-discount weight.
  const matchedByDoc = new Map<string, number>();
  const weightByDoc = new Map<string, number>();
  const rowsByHash = new Map<string, string[]>(); // hash -> [pmcId, ...] (post-tombstone)
  let tombstonedHits = 0;
  let postingRows = 0;
  let truncated = false;

  for (let i = 0; i < eligible.length && !truncated; i += chunkSize) {
    const chunk = eligible.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await client.execute({
      sql: `SELECT pmc_id, fingerprint_hash
            FROM pmc_document_fingerprints
            WHERE fingerprint_version = ?
              AND fingerprint_hash IN (${placeholders})`,
      args: [fingerprintVersion, ...chunk],
    });
    for (const r of result.rows) {
      const row = r as unknown as { pmc_id: string; fingerprint_hash: string };
      const pmcId = String(row.pmc_id);
      const hash = String(row.fingerprint_hash);
      postingRows += 1;
      if (postingRows > maxPostingRows) { truncated = true; break; }
      if (retractedPmcIds.has(pmcId)) { tombstonedHits += 1; continue; }
      const list = rowsByHash.get(hash);
      if (list) list.push(pmcId);
      else rowsByHash.set(hash, [pmcId]);
    }
  }

  for (const [, pmcIds] of rowsByHash) {
    const w = 1 / Math.log2(2 + pmcIds.length); // DF-discount by this hash's corpus posting count
    for (const pmcId of pmcIds) {
      if (!matchedByDoc.has(pmcId) && matchedByDoc.size >= maxCandidates) { truncated = true; continue; }
      matchedByDoc.set(pmcId, (matchedByDoc.get(pmcId) ?? 0) + 1);
      weightByDoc.set(pmcId, (weightByDoc.get(pmcId) ?? 0) + w);
    }
  }

  const candidates: PmcStageACandidate[] = [...matchedByDoc.entries()]
    .map(([pmcId, matchedFingerprints]) => ({
      pmcId,
      matchedFingerprints,
      weight: +(weightByDoc.get(pmcId) ?? 0).toFixed(6),
    }))
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        b.matchedFingerprints - a.matchedFingerprints ||
        (a.pmcId < b.pmcId ? -1 : 1),
    )
    .slice(0, topK);

  return {
    candidates,
    queryFingerprintsUsed: eligible.length,
    stoppedFingerprints,
    tombstonedHits,
    truncated,
  };
}

export type PmcCandidateText = {
  pmcId: string;
  doi: string | null;
  title: string;
  canonicalText: string;
};

/**
 * Load ONLY the top-K candidates' canonical texts for Stage B. Re-checks
 * is_retracted = 0 (belt-and-braces alongside Stage A's tombstone filter) so a
 * document retracted between Stage A and here is still excluded.
 */
export async function loadPmcCandidateTexts(
  client: ArchiveReadClient,
  pmcIds: readonly string[],
): Promise<PmcCandidateText[]> {
  if (pmcIds.length === 0) return [];
  const placeholders = pmcIds.map(() => "?").join(",");
  const result = await client.execute({
    sql: `SELECT pmc_id, doi, title, canonical_text
          FROM pmc_coverage_documents
          WHERE is_retracted = 0
            AND pmc_id IN (${placeholders})`,
    args: [...pmcIds],
  });
  const byId = new Map<string, PmcCandidateText>();
  for (const r of result.rows) {
    const row = r as unknown as {
      pmc_id: string;
      doi: string | null;
      title: string;
      canonical_text: string;
    };
    byId.set(String(row.pmc_id), {
      pmcId: String(row.pmc_id),
      doi: row.doi === null ? null : String(row.doi),
      title: String(row.title),
      canonicalText: String(row.canonical_text),
    });
  }
  // Preserve Stage A rank order.
  return pmcIds.map((id) => byId.get(id)).filter((v): v is PmcCandidateText => v !== undefined);
}
