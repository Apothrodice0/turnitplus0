import type { Client, InStatement } from "@libsql/client";
import { tokens, grams, gramHash } from "../similarity-core";
import { winnow } from "../archive-fingerprint";
import { canonicalSha256 } from "../document-identity";
import { computePmcDocumentFingerprints } from "./fingerprint";
import {
  buildPmcDfBandTable,
  buildPmcDfBandTableFromGramSets,
  type PmcDfBandBuildResult,
} from "./df-bands";
import {
  PMC_COMPACT_FINGERPRINT_VERSION,
  PMC_DF_BAND_POLICY_VERSION,
  PMC_SHINGLE_SIZE,
  PMC_WINNOW_WINDOW,
} from "./constants";

/**
 * PMC OA scholarly-coverage SHADOW slice — deterministic, idempotent, versioned
 * seed writers for the dedicated corpus (pmc_coverage_documents /
 * pmc_document_fingerprints / pmc_hash_df_bands, drizzle/0053).
 *
 * Pure DB writers, no filesystem — tools/seed-pmc-coverage-shadow-corpus.ts
 * reads the validated 1,000-doc prototype corpus and calls these. NOTHING here
 * executes on import and nothing targets a database on its own.
 *
 * Determinism: canonical_sha256 / body_words are pure functions of
 * canonical_text; fingerprints are the distinct winnowed (w=15) hashes of the
 * production 5-gram stream; df bands are hash-sorted DF>=13 rows. Idempotency:
 * documents UPSERT on pmc_id, fingerprints INSERT OR IGNORE on the composite PK,
 * the df-band build replaces exactly its policy generation's rows. A re-run
 * against an unchanged corpus is a no-op.
 *
 * PERFORMANCE (seedPmcCoverageCorpus): the corpus state is read in TWO bulk
 * queries up front, every document's 5-gram hash stream is computed ONCE and
 * shared between winnowing and the DF tally, and a fully-seeded unchanged
 * document is SHORT-CIRCUITED before any hashing — so a re-seed of an unchanged
 * corpus issues zero fingerprint writes and skips the DF rebuild entirely. The
 * per-document helpers below are kept for callers/tests that seed one row at a
 * time; they use the same primitives and produce byte-identical rows.
 */

export type PmcCoverageSeedEntry = {
  /** PMCID accession, e.g. "PMC12247579" — the stable key. */
  pmcId: string;
  doi: string | null;
  pmid: string | null;
  title: string;
  license: string;
  citation: string | null;
  /** Front-matter-stripped article body. tokens(canonicalText) must reproduce
   *  the prototype's normalized body. */
  canonicalText: string;
  version: number;
  isRetracted: boolean;
  /** Honest OA-snapshot date (the fact the corpus was built against), not
   *  fabricated. Nullable. */
  oaSnapshotDate: string | null;
};

export type PmcCoverageSeedDocumentResult = {
  pmcId: string;
  status: "SEEDED" | "UPDATED" | "UNCHANGED";
  bodyWords: number;
  fingerprintRows: number;
};

const DOC_COLUMNS = [
  "pmc_id",
  "pmcid",
  "doi",
  "pmid",
  "title",
  "license",
  "citation",
  "canonical_text",
  "canonical_sha256",
  "body_words",
  "version",
  "is_retracted",
  "oa_snapshot_date",
] as const;
type DocColumn = (typeof DOC_COLUMNS)[number];

/** Columns the UPSERT never rewrites on conflict — identity + immutable ingested_at (not listed). */
const DOC_NO_UPDATE_ON_CONFLICT = new Set<string>(["pmc_id", "pmcid"]);

const DOC_INSERT_COLS = DOC_COLUMNS.join(", ");
const DOC_INSERT_PLACEHOLDERS = DOC_COLUMNS.map(() => "?").join(", ");
const DOC_UPDATE_SET = DOC_COLUMNS.filter((c) => !DOC_NO_UPDATE_ON_CONFLICT.has(c))
  .map((c) => `${c} = excluded.${c}`)
  .join(", ");
const DOC_UPSERT_SQL = `INSERT INTO pmc_coverage_documents (${DOC_INSERT_COLS})
  VALUES (${DOC_INSERT_PLACEHOLDERS})
  ON CONFLICT(pmc_id) DO UPDATE SET ${DOC_UPDATE_SET}`;

function docValues(entry: PmcCoverageSeedEntry, canonical: string, bodyWords: number): Record<DocColumn, string | number | null> {
  return {
    pmc_id: entry.pmcId,
    pmcid: entry.pmcId,
    doi: entry.doi,
    pmid: entry.pmid,
    title: entry.title,
    license: entry.license,
    citation: entry.citation,
    canonical_text: entry.canonicalText,
    canonical_sha256: canonical,
    body_words: bodyWords,
    version: entry.version,
    is_retracted: entry.isRetracted ? 1 : 0,
    oa_snapshot_date: entry.oaSnapshotDate,
  };
}

/** True when the persisted row already matches this entry on every seeded column. */
function docRowUnchanged(
  before: Record<string, string | number | null>,
  entry: PmcCoverageSeedEntry,
  canonical: string,
  bodyWords: number,
): boolean {
  return (
    String(before.canonical_sha256 ?? "") === canonical &&
    Number(before.body_words ?? -1) === bodyWords &&
    Number(before.version ?? -1) === entry.version &&
    Number(before.is_retracted ?? -1) === (entry.isRetracted ? 1 : 0) &&
    (before.doi ?? null) === entry.doi &&
    (before.pmid ?? null) === entry.pmid &&
    String(before.title ?? "") === entry.title &&
    String(before.license ?? "") === entry.license &&
    (before.citation ?? null) === entry.citation &&
    (before.oa_snapshot_date ?? null) === entry.oaSnapshotDate
  );
}

// ── single-document helpers (unchanged behaviour) ──────────────────────────

/**
 * UPSERT one PMC coverage document + (re)seed its winnowed fingerprints.
 * Returns UNCHANGED when the row already matched byte-for-byte on every seeded
 * column. Kept for one-row-at-a-time callers/tests — seedPmcCoverageCorpus does
 * the same work in bulk.
 */
export async function seedPmcCoverageDocument(
  client: Client,
  entry: PmcCoverageSeedEntry,
  opts: { fingerprintVersion?: string } = {},
): Promise<PmcCoverageSeedDocumentResult> {
  const fingerprintVersion = opts.fingerprintVersion ?? PMC_COMPACT_FINGERPRINT_VERSION;
  const bodyWords = tokens(entry.canonicalText).length;
  const canonical = canonicalSha256(entry.canonicalText);

  const existing = await client.execute({
    sql: `SELECT doi, pmid, title, license, citation, canonical_sha256, body_words, version, is_retracted, oa_snapshot_date
          FROM pmc_coverage_documents WHERE pmc_id = ?`,
    args: [entry.pmcId],
  });
  const before = existing.rows[0] as Record<string, string | number | null> | undefined;

  await client.execute({ sql: DOC_UPSERT_SQL, args: DOC_COLUMNS.map((c) => docValues(entry, canonical, bodyWords)[c]) });

  const fingerprintRows = await seedPmcDocumentFingerprints(client, entry.pmcId, entry.canonicalText, { fingerprintVersion });

  const status: PmcCoverageSeedDocumentResult["status"] = !before
    ? "SEEDED"
    : docRowUnchanged(before, entry, canonical, bodyWords) ? "UNCHANGED" : "UPDATED";

  return { pmcId: entry.pmcId, status, bodyWords, fingerprintRows };
}

/**
 * (Re)seed one document's winnowed fingerprint set. A single multi-row
 * INSERT OR IGNORE on the composite PK (pmc_id, fingerprint_version,
 * fingerprint_hash) — idempotent. Returns the number of DISTINCT fingerprint
 * hashes for the document.
 */
export async function seedPmcDocumentFingerprints(
  client: Client,
  pmcId: string,
  canonicalText: string,
  opts: { fingerprintVersion?: string } = {},
): Promise<number> {
  const fingerprintVersion = opts.fingerprintVersion ?? PMC_COMPACT_FINGERPRINT_VERSION;
  const hashes = computePmcDocumentFingerprints(canonicalText).map((fp) => fp.hash);
  for (const stmt of fingerprintInsertStatements(pmcId, hashes, fingerprintVersion)) {
    await client.execute(stmt);
  }
  return hashes.length;
}

/** ~500 rows per INSERT OR IGNORE statement (1500 bound params — well under the
 *  SQLite variable limit) instead of one prepared statement per fingerprint. */
const FP_ROWS_PER_STATEMENT = 500;
function fingerprintInsertStatements(pmcId: string, hashes: readonly string[], fingerprintVersion: string): InStatement[] {
  const stmts: InStatement[] = [];
  for (let i = 0; i < hashes.length; i += FP_ROWS_PER_STATEMENT) {
    const chunk = hashes.slice(i, i + FP_ROWS_PER_STATEMENT);
    stmts.push({
      sql: `INSERT OR IGNORE INTO pmc_document_fingerprints (pmc_id, fingerprint_hash, fingerprint_version)
            VALUES ${chunk.map(() => "(?,?,?)").join(",")}`,
      args: chunk.flatMap((h) => [pmcId, h, fingerprintVersion]),
    });
  }
  return stmts;
}

// ── bulk corpus seed ──────────────────────────────────────────────────────

export type PmcCoverageCorpusSeedResult = {
  documents: PmcCoverageSeedDocumentResult[];
  dfBands: PmcDfBandBuildResult & { skipped?: boolean };
  fingerprintVersion: string;
  shingleSize: number;
  /** DB round trips issued by this call (execute + batch), for perf telemetry. */
  dbCalls: number;
};

/**
 * Full deterministic seed. Byte-identical output to N sequential
 * seedPmcCoverageDocument calls + one buildPmcDfBandTable, but:
 *   - the corpus doc rows and the per-doc fingerprint counts are read in TWO
 *     bulk queries;
 *   - each document's 5-gram hash stream is computed once and reused for both
 *     winnowing and the DF tally;
 *   - a document whose persisted row matches on every seeded column AND whose
 *     fingerprint count already equals its computed count is fully skipped —
 *     no hashing beyond the sha/body-word check, no writes;
 *   - changed documents' UPSERTs + fingerprint inserts are flushed in large
 *     client.batch() writes;
 *   - the DF rebuild is skipped when nothing changed and the table already
 *     holds this policy generation's rows.
 */
export async function seedPmcCoverageCorpus(
  rawClient: Client,
  entries: readonly PmcCoverageSeedEntry[],
  opts: { fingerprintVersion?: string; dfPolicyVersion?: string } = {},
): Promise<PmcCoverageCorpusSeedResult> {
  const fingerprintVersion = opts.fingerprintVersion ?? PMC_COMPACT_FINGERPRINT_VERSION;
  const dfPolicyVersion = opts.dfPolicyVersion ?? PMC_DF_BAND_POLICY_VERSION;

  // Count every DB round trip this seed makes (including the DF helpers').
  let dbCalls = 0;
  const client = new Proxy(rawClient, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if ((prop === "execute" || prop === "batch") && typeof orig === "function") {
        return (...a: unknown[]) => { dbCalls += 1; return (orig as (...x: unknown[]) => unknown).apply(target, a); };
      }
      return typeof orig === "function" ? orig.bind(target) : orig;
    },
  }) as Client;
  const exec = (stmt: InStatement) => client.execute(stmt);
  const writeBatch = (stmts: InStatement[]) => client.batch(stmts, "write");

  const ordered = [...entries].sort((a, b) => (a.pmcId < b.pmcId ? -1 : a.pmcId > b.pmcId ? 1 : 0));

  // --- bulk read current state (2 queries) --------------------------------
  const existingDocsRes = await exec({
    sql: `SELECT pmc_id, doi, pmid, title, license, citation, canonical_sha256, body_words, version, is_retracted, oa_snapshot_date
          FROM pmc_coverage_documents`,
  });
  const existingDocs = new Map<string, Record<string, string | number | null>>();
  for (const r of existingDocsRes.rows) existingDocs.set(String((r as Record<string, unknown>).pmc_id), r as Record<string, string | number | null>);

  const fpCountRes = await exec({
    sql: `SELECT pmc_id, COUNT(*) AS c FROM pmc_document_fingerprints WHERE fingerprint_version = ? GROUP BY pmc_id`,
    args: [fingerprintVersion],
  });
  const existingFpCounts = new Map<string, number>();
  for (const r of fpCountRes.rows) existingFpCounts.set(String((r as Record<string, unknown>).pmc_id), Number((r as Record<string, unknown>).c));

  // --- classify + queue writes -------------------------------------------
  const documents: PmcCoverageSeedDocumentResult[] = [];
  const gramSetsByPmcId = new Map<string, Set<string>>(); // only for docs we hashed this run
  const pendingDocUpserts: InStatement[] = [];
  const pendingFpStatements: InStatement[] = [];
  let seededCount = 0;
  let updatedCount = 0;

  for (const entry of ordered) {
    const words = tokens(entry.canonicalText);
    const bodyWords = words.length;
    const canonical = canonicalSha256(entry.canonicalText);
    const before = existingDocs.get(entry.pmcId);
    const rowMatches = before ? docRowUnchanged(before, entry, canonical, bodyWords) : false;
    const dbFpCount = existingFpCounts.get(entry.pmcId) ?? 0;

    // Fast path: fully-seeded unchanged document — no hashing, no writes.
    if (rowMatches && dbFpCount > 0) {
      documents.push({ pmcId: entry.pmcId, status: "UNCHANGED", bodyWords, fingerprintRows: dbFpCount });
      continue;
    }

    // Compute the 5-gram hash stream ONCE; reuse for winnowing + the DF tally.
    const gramHashes = grams(words, PMC_SHINGLE_SIZE).map((g) => gramHash(g));
    const fpHashes = [...new Set(winnow(gramHashes, PMC_WINNOW_WINDOW).map((s) => s.hash))];
    gramSetsByPmcId.set(entry.pmcId, new Set(gramHashes));

    let status: PmcCoverageSeedDocumentResult["status"];
    if (!before) { status = "SEEDED"; seededCount += 1; }
    else if (rowMatches) {
      // row is fine; only the fingerprint set is missing/short — top it up, no doc rewrite.
      status = "UNCHANGED";
    } else { status = "UPDATED"; updatedCount += 1; }

    if (status !== "UNCHANGED" || dbFpCount === 0) {
      if (status !== "UNCHANGED") {
        pendingDocUpserts.push({ sql: DOC_UPSERT_SQL, args: DOC_COLUMNS.map((c) => docValues(entry, canonical, bodyWords)[c]) });
      }
      if (dbFpCount !== fpHashes.length) {
        pendingFpStatements.push(...fingerprintInsertStatements(entry.pmcId, fpHashes, fingerprintVersion));
      }
    }

    documents.push({ pmcId: entry.pmcId, status, bodyWords, fingerprintRows: fpHashes.length });
  }

  // --- flush writes in large batches ------------------------------------
  const DOC_UPSERTS_PER_BATCH = 250;
  for (let i = 0; i < pendingDocUpserts.length; i += DOC_UPSERTS_PER_BATCH) {
    await writeBatch(pendingDocUpserts.slice(i, i + DOC_UPSERTS_PER_BATCH));
  }
  const FP_STATEMENTS_PER_BATCH = 32; // each statement is already up to 500 rows
  for (let i = 0; i < pendingFpStatements.length; i += FP_STATEMENTS_PER_BATCH) {
    await writeBatch(pendingFpStatements.slice(i, i + FP_STATEMENTS_PER_BATCH));
  }

  // --- DF bands ---------------------------------------------------------
  const changed = seededCount + updatedCount;
  let dfBands: PmcDfBandBuildResult & { skipped?: boolean };
  if (changed === 0 && pendingFpStatements.length === 0) {
    // Nothing about the corpus changed — the deterministic DF rebuild would
    // reproduce exactly the rows already present. Confirm they exist, then skip.
    dbCalls += 1;
    const dfCountRes = await client.execute({
      sql: `SELECT COUNT(*) AS c, MIN(df_bucket) AS lo, MAX(df_bucket) AS hi FROM pmc_hash_df_bands WHERE policy_version = ?`,
      args: [dfPolicyVersion],
    });
    const dfRow = dfCountRes.rows[0] as Record<string, unknown>;
    const dfCount = Number(dfRow.c ?? 0);
    if (dfCount > 0) {
      dfBands = {
        policyVersion: dfPolicyVersion,
        minPersistedDf: Number(dfRow.lo ?? 0) || 13,
        persistedRows: dfCount,
        histogram: { distinct: -1, df1: -1, df2_12: -1, df13_20: -1, df21plus: -1 },
        skipped: true,
      };
    } else {
      dfBands = await buildPmcDfBandTable(client, ordered.map((e) => e.pmcId), { policyVersion: dfPolicyVersion });
    }
  } else if (gramSetsByPmcId.size === ordered.length) {
    // Every document was hashed this run (first seed, or a full change) — build
    // the DF tally from the in-memory 5-gram sets, no canonical_text re-read.
    dfBands = await buildPmcDfBandTableFromGramSets(client, gramSetsByPmcId, { policyVersion: dfPolicyVersion });
  } else {
    // Partial change — rebuild from the post-write DB state to stay correct.
    dfBands = await buildPmcDfBandTable(client, ordered.map((e) => e.pmcId), { policyVersion: dfPolicyVersion });
  }

  return { documents, dfBands, fingerprintVersion, shingleSize: PMC_SHINGLE_SIZE, dbCalls };
}
