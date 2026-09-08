import type { Client } from "@libsql/client";
import { tokens } from "../similarity-core";
import { canonicalSha256 } from "../document-identity";
import { computePmcDocumentFingerprints } from "./fingerprint";
import { buildPmcDfBandTable, type PmcDfBandBuildResult } from "./df-bands";
import { PMC_COMPACT_FINGERPRINT_VERSION, PMC_SHINGLE_SIZE } from "./constants";

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
 * canonical_text; fingerprints come from lib/pmc-coverage/fingerprint.ts (pure,
 * no RNG); df bands come from lib/pmc-coverage/df-bands.ts (hash-sorted rows).
 * Idempotency: documents UPSERT on pmc_id, fingerprints INSERT OR IGNORE on the
 * composite PK, the df-band build replaces exactly its policy generation's rows.
 * A re-run against an unchanged corpus is a no-op that produces byte-identical
 * rows.
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

/** Columns the UPSERT never rewrites on conflict — identity + immutable ingested_at (not listed). */
const DOC_NO_UPDATE_ON_CONFLICT = new Set<string>(["pmc_id", "pmcid"]);

/**
 * UPSERT one PMC coverage document + (re)seed its winnowed fingerprints.
 * Returns UNCHANGED when the row already matched byte-for-byte on every
 * seeded column (so a re-run is observably a no-op).
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
  const before = existing.rows[0] as
    | Record<string, string | number | null>
    | undefined;

  const values: Record<(typeof DOC_COLUMNS)[number], string | number | null> = {
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

  const insertCols = DOC_COLUMNS.join(", ");
  const placeholders = DOC_COLUMNS.map(() => "?").join(", ");
  const updateSet = DOC_COLUMNS.filter((c) => !DOC_NO_UPDATE_ON_CONFLICT.has(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  await client.execute({
    sql: `INSERT INTO pmc_coverage_documents (${insertCols})
          VALUES (${placeholders})
          ON CONFLICT(pmc_id) DO UPDATE SET ${updateSet}`,
    args: DOC_COLUMNS.map((c) => values[c]),
  });

  const fingerprintRows = await seedPmcDocumentFingerprints(
    client,
    entry.pmcId,
    entry.canonicalText,
    { fingerprintVersion },
  );

  let status: PmcCoverageSeedDocumentResult["status"];
  if (!before) status = "SEEDED";
  else {
    const unchanged =
      String(before.canonical_sha256 ?? "") === canonical &&
      Number(before.body_words ?? -1) === bodyWords &&
      Number(before.version ?? -1) === entry.version &&
      Number(before.is_retracted ?? -1) === (entry.isRetracted ? 1 : 0) &&
      (before.doi ?? null) === entry.doi &&
      (before.pmid ?? null) === entry.pmid &&
      String(before.title ?? "") === entry.title &&
      String(before.license ?? "") === entry.license &&
      (before.citation ?? null) === entry.citation &&
      (before.oa_snapshot_date ?? null) === entry.oaSnapshotDate;
    status = unchanged ? "UNCHANGED" : "UPDATED";
  }

  return { pmcId: entry.pmcId, status, bodyWords, fingerprintRows };
}

/**
 * (Re)seed one document's winnowed fingerprint set. INSERT OR IGNORE on the
 * composite PK (pmc_id, fingerprint_version, fingerprint_hash) — idempotent.
 * Returns the number of DISTINCT fingerprint hashes for the document (the
 * steady-state row count for this fingerprint_version).
 */
export async function seedPmcDocumentFingerprints(
  client: Client,
  pmcId: string,
  canonicalText: string,
  opts: { fingerprintVersion?: string } = {},
): Promise<number> {
  const fingerprintVersion = opts.fingerprintVersion ?? PMC_COMPACT_FINGERPRINT_VERSION;
  const fingerprints = computePmcDocumentFingerprints(canonicalText);
  const BATCH = 500;
  for (let i = 0; i < fingerprints.length; i += BATCH) {
    const slice = fingerprints.slice(i, i + BATCH);
    await client.batch(
      slice.map((fp) => ({
        sql: `INSERT OR IGNORE INTO pmc_document_fingerprints (pmc_id, fingerprint_hash, fingerprint_version)
              VALUES (?,?,?)`,
        args: [pmcId, fp.hash, fingerprintVersion],
      })),
      "write",
    );
  }
  return fingerprints.length;
}

export type PmcCoverageCorpusSeedResult = {
  documents: PmcCoverageSeedDocumentResult[];
  dfBands: PmcDfBandBuildResult;
  fingerprintVersion: string;
  shingleSize: number;
};

/**
 * Full deterministic seed: every document + its fingerprints, then a single
 * DF-band rebuild over the whole corpus. Safe to re-run.
 */
export async function seedPmcCoverageCorpus(
  client: Client,
  entries: readonly PmcCoverageSeedEntry[],
  opts: { fingerprintVersion?: string; dfPolicyVersion?: string } = {},
): Promise<PmcCoverageCorpusSeedResult> {
  const fingerprintVersion = opts.fingerprintVersion ?? PMC_COMPACT_FINGERPRINT_VERSION;
  const documents: PmcCoverageSeedDocumentResult[] = [];
  // Deterministic order: sort by pmcId so a partial re-run resumes predictably.
  const ordered = [...entries].sort((a, b) => (a.pmcId < b.pmcId ? -1 : a.pmcId > b.pmcId ? 1 : 0));
  for (const entry of ordered) {
    documents.push(await seedPmcCoverageDocument(client, entry, { fingerprintVersion }));
  }
  const dfBands = await buildPmcDfBandTable(
    client,
    ordered.map((e) => e.pmcId),
    { policyVersion: opts.dfPolicyVersion },
  );
  return { documents, dfBands, fingerprintVersion, shingleSize: PMC_SHINGLE_SIZE };
}
