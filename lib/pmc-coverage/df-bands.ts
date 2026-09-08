import type { Client } from "@libsql/client";
import type { ArchiveReadClient } from "../archive-read-retry";
import { archiveShingleHashes } from "../archive-fingerprint";
import {
  PMC_SHINGLE_SIZE,
  PMC_DF_BAND_POLICY_VERSION,
  PMC_DF_BAND_MAX,
  PMC_MIN_PERSISTED_DF,
  PMC_MATCHING_PARAMETERS,
} from "./constants";

/**
 * PMC OA scholarly-coverage SHADOW slice — compact PMC-global DF-band metadata.
 * Exact copy of lib/archive-df-bands.ts' semantics against the dedicated PMC
 * tables:
 *
 *   pmc_hash_df_bands(shingle_hash TEXT, df_bucket INT, policy_version TEXT)
 *     df_bucket 13..20 = exact PMC-corpus-wide 5-gram document frequency
 *     df_bucket 21     = DF >= 21
 *     absent           = DF in {0..12}
 *
 * REQUIRED in phase 1. This ONE table is the stop set for BOTH stages:
 *   - Stage A drops query fingerprints whose 5-gram is in it before retrieval
 *     (bounded fan-out — every surviving fingerprint fans to <= 12 docs);
 *   - Stage B's getPostings prunes the same hashes, exactly like
 *     lib/archive-corpus-matching.ts ("pruned iff in the precomputed global
 *     stop set, NEVER based on the discovered candidate count").
 * The scorer's own maximumDocumentFrequency (6) resolves the 7..12 band at
 * scoring time — no FTS phrase index in phase 1.
 */

export type PmcDfBandBuildResult = {
  policyVersion: string;
  minPersistedDf: number;
  persistedRows: number;
  histogram: { distinct: number; df1: number; df2_12: number; df13_20: number; df21plus: number };
};

/**
 * Deterministic (re)build. Reconstructs each PMC document's 5-gram hash set
 * from pmc_coverage_documents.canonical_text (transient, one-time), tallies
 * PMC-wide DF, then REPLACES the rows for `policyVersion` with exactly the
 * DF >= minPersistedDf set. No DROP — the table is owned by drizzle/0053; only
 * this policy generation's rows are rewritten. Idempotent: re-running against
 * an unchanged corpus produces byte-identical rows.
 */
export async function buildPmcDfBandTable(
  client: Client,
  pmcIds: string[],
  opts: { policyVersion?: string; minPersistedDf?: number; bandMax?: number } = {},
): Promise<PmcDfBandBuildResult> {
  const policyVersion = opts.policyVersion ?? PMC_DF_BAND_POLICY_VERSION;
  const minPersistedDf = opts.minPersistedDf ?? PMC_MIN_PERSISTED_DF;
  const bandMax = opts.bandMax ?? PMC_DF_BAND_MAX;
  const overflow = bandMax + 1;

  const globalDf = new Map<string, number>();
  const CHUNK = 200;
  for (let i = 0; i < pmcIds.length; i += CHUNK) {
    const ids = pmcIds.slice(i, i + CHUNK);
    const placeholders = ids.map(() => "?").join(",");
    const rows = await client.execute({
      sql: `SELECT canonical_text FROM pmc_coverage_documents WHERE pmc_id IN (${placeholders})`,
      args: ids,
    });
    for (const row of rows.rows) {
      const canonicalText = String((row as unknown as { canonical_text: string }).canonical_text);
      for (const h of archiveShingleHashes(canonicalText, PMC_SHINGLE_SIZE)) {
        globalDf.set(h, (globalDf.get(h) ?? 0) + 1);
      }
    }
  }

  await client.execute({
    sql: `DELETE FROM pmc_hash_df_bands WHERE policy_version = ?`,
    args: [policyVersion],
  });

  const hist = { distinct: globalDf.size, df1: 0, df2_12: 0, df13_20: 0, df21plus: 0 };
  let batch: { sql: string; args: (string | number)[] }[] = [];
  let persisted = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await client.batch(batch, "write");
    batch = [];
  };
  // Deterministic row order: sort by hash so a re-seed writes identical bytes.
  for (const h of [...globalDf.keys()].sort()) {
    const df = globalDf.get(h)!;
    if (df <= 1) { hist.df1 += 1; continue; }
    if (df <= 12) hist.df2_12 += 1;
    else if (df <= bandMax) hist.df13_20 += 1;
    else hist.df21plus += 1;
    if (df < minPersistedDf) continue;
    const bucket = df <= bandMax ? df : overflow;
    batch.push({
      sql: `INSERT INTO pmc_hash_df_bands(shingle_hash, df_bucket, policy_version) VALUES (?,?,?)`,
      args: [h, bucket, policyVersion],
    });
    persisted += 1;
    if (batch.length >= 2000) await flush();
  }
  await flush();

  return { policyVersion, minPersistedDf, persistedRows: persisted, histogram: hist };
}

export type PmcDfBandMap = {
  bandByHash: Map<string, number>;
  policyVersion: string;
  bandMax: number;
  overflow: number;
};

/** Request-time load — the ONLY PMC-DF data an evaluation reads directly. Small
 *  by design (~the stop set). Takes the narrow read-client surface so the
 *  evaluator can hand it its bounded read-retry wrapper. */
export async function loadPmcDfBandMap(
  client: ArchiveReadClient,
  opts: { policyVersion?: string; bandMax?: number } = {},
): Promise<PmcDfBandMap> {
  const policyVersion = opts.policyVersion ?? PMC_DF_BAND_POLICY_VERSION;
  const bandMax = opts.bandMax ?? PMC_DF_BAND_MAX;
  const rows = await client.execute({
    sql: `SELECT shingle_hash, df_bucket FROM pmc_hash_df_bands WHERE policy_version = ?`,
    args: [policyVersion],
  });
  const bandByHash = new Map<string, number>();
  for (const r of rows.rows) {
    const row = r as unknown as { shingle_hash: string; df_bucket: number | bigint };
    bandByHash.set(String(row.shingle_hash), Number(row.df_bucket));
  }
  return { bandByHash, policyVersion, bandMax, overflow: bandMax + 1 };
}

/**
 * The stop-hash set — derived purely from the band map. `threshold` defaults to
 * the PMC scorer's maximumDocumentFrequency (6); every persisted row
 * (bucket >= 13) is unambiguously above it, so the stop set == the persisted
 * hash set at the ship threshold.
 */
export function derivePmcStopHashSet(
  bandByHash: Map<string, number>,
  threshold: number = PMC_MATCHING_PARAMETERS.maximumDocumentFrequency,
): Set<string> {
  const stop = new Set<string>();
  for (const [h, bucket] of bandByHash) if (bucket > threshold) stop.add(h);
  return stop;
}
