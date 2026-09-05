import type { Client } from "@libsql/client";
import { archiveShingleHashes, ARCHIVE_SHINGLE_SIZE } from "./archive-fingerprint";

/**
 * 100k-scale architecture — compact archive-global DF-band metadata (Slice
 * 2A.5). The smallest persistent structure that lets the phrase selector and
 * the scorer's stop-hash pruning run with NO full archive-shingle table and
 * NO in-memory exhaustive DF oracle at request time.
 *
 *   archive_hash_df_bands(shingle_hash TEXT, df_bucket INT, policy_version TEXT)
 *     df_bucket 13..20 = exact archive-wide document frequency
 *     df_bucket 21     = DF >= 21   (bounded catch-all)
 *     absent           = DF in {0..12}
 *
 * The build pass reconstructs every archive document's 5-gram hash set from
 * canonical_text (transient, one-time), tallies true archive DF, and persists
 * ONLY the rows for DF >= MIN_PERSISTED_DF (13). DF 0..12 is never stored;
 * where the phrase selector needs an exact value in that band it resolves it
 * on demand from the FTS phrase index's exact fan-out
 * (lib/archive-phrase-fallback.ts's resolveQueryGramDf).
 *
 * This ONE table subsumes the stop-hash table: deriveStopHashSet(map, T)
 * = { h : df_bucket > T } exactly reproduces { h : archive-global DF(h) > T }
 * for any T <= 20, because df_bucket is exact through 20 and the overflow
 * bucket (21) is unambiguously above it. The scorer's threshold
 * (maximumDocumentFrequency, default 12) is unchanged.
 */

/** DF-POLICY generation. Bump on a threshold / bucketing / hash-representation
 *  change. Part of archive_hash_df_bands' primary key, so a policy change
 *  builds a new generation beside the old rows. Deliberately distinct from
 *  ARCHIVE_COMPACT_FINGERPRINT_VERSION and ARCHIVE_PHRASE_INDEX_VERSION so a
 *  DF-threshold change is never conflated with a fingerprint-algorithm change. */
export const ARCHIVE_DF_BAND_POLICY_VERSION = "archive-df-band-v1";

/** Exact DF stored for MIN_PERSISTED_DF..DF_BAND_MAX; DF_BAND_OVERFLOW_BUCKET
 *  means ">= DF_BAND_MAX + 1". */
export const DF_BAND_MAX = 20;
export const DF_BAND_OVERFLOW_BUCKET = DF_BAND_MAX + 1; // 21
/** Persist a row only for DF >= this. Ship value = the scorer's stop
 *  threshold + 1 (Slice 2A.5 Design 2): the table then equals the stop set,
 *  is provably bounded, and the phrase selector FTS-resolves DF 2..12.
 *  Lower toward 3 later (a pure storage <-> request-latency trade) only if
 *  real-scale telemetry shows the per-request FTS fan-out count is too high. */
export const MIN_PERSISTED_DF = 13;
/** The scorer's maximumDocumentFrequency default — unchanged. Only used as
 *  the default threshold for deriveStopHashSet; callers that pass an explicit
 *  maximumDocumentFrequency (tests, risk-calibration) override it. */
export const SCORER_STOP_THRESHOLD = 12;

export type DfBandBuildResult = {
  policyVersion: string;
  minPersistedDf: number;
  persistedRows: number;
  histogram: { distinct: number; df1: number; df2_12: number; df13_20: number; df21plus: number };
};

/**
 * Deterministic (re)build. Reconstructs each archive representation's 5-gram
 * hash set from canonical_text, tallies archive-wide DF, then replaces the
 * rows for `policyVersion` with exactly the DF >= minPersistedDf set. No
 * DROP — the table is owned by drizzle/0049; only this policy generation's
 * rows are rewritten.
 */
export async function buildDfBandTable(
  client: Client,
  representationIds: string[],
  opts: { policyVersion?: string; minPersistedDf?: number; bandMax?: number } = {},
): Promise<DfBandBuildResult> {
  const policyVersion = opts.policyVersion ?? ARCHIVE_DF_BAND_POLICY_VERSION;
  const minPersistedDf = opts.minPersistedDf ?? MIN_PERSISTED_DF;
  const bandMax = opts.bandMax ?? DF_BAND_MAX;
  const overflow = bandMax + 1;

  const globalDf = new Map<string, number>();
  const CHUNK = 200;
  for (let i = 0; i < representationIds.length; i += CHUNK) {
    const ids = representationIds.slice(i, i + CHUNK);
    const placeholders = ids.map(() => "?").join(",");
    const rows = await client.execute({
      sql: `SELECT canonical_text FROM corpus_document_representations WHERE id IN (${placeholders})`,
      args: ids,
    });
    for (const row of rows.rows) {
      const canonicalText = String((row as unknown as { canonical_text: string }).canonical_text);
      for (const h of archiveShingleHashes(canonicalText, ARCHIVE_SHINGLE_SIZE)) {
        globalDf.set(h, (globalDf.get(h) ?? 0) + 1);
      }
    }
  }

  await client.execute({ sql: `DELETE FROM archive_hash_df_bands WHERE policy_version = ?`, args: [policyVersion] });

  const hist = { distinct: globalDf.size, df1: 0, df2_12: 0, df13_20: 0, df21plus: 0 };
  let batch: { sql: string; args: (string | number)[] }[] = [];
  let persisted = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await client.batch(batch, "write");
    batch = [];
  };
  for (const [h, df] of globalDf) {
    if (df <= 1) { hist.df1 += 1; continue; }
    if (df <= 12) hist.df2_12 += 1;
    else if (df <= bandMax) hist.df13_20 += 1;
    else hist.df21plus += 1;
    if (df < minPersistedDf) continue;
    const bucket = df <= bandMax ? df : overflow;
    batch.push({
      sql: `INSERT INTO archive_hash_df_bands(shingle_hash, df_bucket, policy_version) VALUES (?,?,?)`,
      args: [h, bucket, policyVersion],
    });
    persisted += 1;
    if (batch.length >= 4000) await flush();
  }
  await flush();

  return { policyVersion, minPersistedDf, persistedRows: persisted, histogram: hist };
}

export type DfBandMap = {
  bandByHash: Map<string, number>;
  policyVersion: string;
  bandMax: number;
  overflow: number;
};

/** Request-time load — the ONLY archive-DF data a request reads directly.
 *  Small by design (~the stop set). */
export async function loadDfBandMap(
  client: Client,
  opts: { policyVersion?: string; bandMax?: number } = {},
): Promise<DfBandMap> {
  const policyVersion = opts.policyVersion ?? ARCHIVE_DF_BAND_POLICY_VERSION;
  const bandMax = opts.bandMax ?? DF_BAND_MAX;
  const rows = await client.execute({
    sql: `SELECT shingle_hash, df_bucket FROM archive_hash_df_bands WHERE policy_version = ?`,
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
 * The stop-hash set the scorer needs — derived purely from the band map.
 * `threshold` defaults to SCORER_STOP_THRESHOLD; a caller scoring with a
 * different maximumDocumentFrequency (risk calibration, tests) passes that.
 */
export function deriveStopHashSet(bandByHash: Map<string, number>, threshold: number = SCORER_STOP_THRESHOLD): Set<string> {
  const stop = new Set<string>();
  for (const [h, bucket] of bandByHash) if (bucket > threshold) stop.add(h);
  return stop;
}
