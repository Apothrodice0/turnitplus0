/**
 * tools/seed-pmc-coverage-shadow-corpus.ts
 *
 * PMC OA scholarly-coverage SHADOW slice — offline CLI for seeding the
 * validated 1,000-document prototype corpus into the dedicated Turso tables
 * (pmc_coverage_documents / pmc_document_fingerprints / pmc_hash_df_bands,
 * drizzle/0053), using the deterministic/idempotent write primitives
 * (lib/pmc-coverage/seed.ts).
 *
 * OFFLINE ONLY, BY DESIGN. Reads the local research corpus at
 * D:\TurnitPlusTemp\pmc-server-matcher\corpus\ (docs.jsonl + cleantext/*.txt),
 * which is NOT part of this repo and is never expected on a deployed server.
 * This is a one-off (occasionally re-run) import you run by hand against a
 * chosen database — never something a live request path calls, and NOTHING here
 * executes on import.
 *
 * Usage:
 *   node --import tsx tools/seed-pmc-coverage-shadow-corpus.ts --dry-run
 *   node --import tsx tools/seed-pmc-coverage-shadow-corpus.ts \
 *     --db-url=file:./local.db --oa-snapshot-date=2026-08-26
 *   node --import tsx tools/seed-pmc-coverage-shadow-corpus.ts \
 *     --db-url=libsql://<preview-host> --auth-token=$TURSO_AUTH_TOKEN \
 *     --oa-snapshot-date=2026-08-26
 *
 * --dry-run (the DEFAULT when --db-url is absent) validates the source and
 * reports what WOULD be seeded without opening any database connection.
 *
 * TARGET GUARD: this tool NEVER applies migrations or writes to a database URL
 * containing "prod" (case-insensitive) — same discipline as
 * tools/seed-archive-corpus.ts and tests/schema-drift.test.mjs. There is no
 * flag to target Production.
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { seedPmcCoverageCorpus, type PmcCoverageSeedEntry } from "../lib/pmc-coverage/seed";
import { PMC_COMPACT_FINGERPRINT_VERSION, PMC_DF_BAND_POLICY_VERSION } from "../lib/pmc-coverage/constants";

const DEFAULT_PROTOTYPE_ROOT = "D:/TurnitPlusTemp/pmc-server-matcher/corpus";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    args[key] = rest.length > 0 ? rest.join("=") : true;
  }
  return args;
}

type PrototypeDocRecord = {
  pmcid: string;
  version?: number;
  pmid?: number | string | null;
  doi?: string | null;
  title?: string | null;
  license?: string | null;
  citation?: string | null;
};

/** Load the prototype corpus into deterministic PmcCoverageSeedEntry[] order. */
export function loadPmcPrototypeCorpus(
  root: string,
  oaSnapshotDate: string | null,
): PmcCoverageSeedEntry[] {
  const docsPath = path.join(root, "docs.jsonl");
  const cleanDir = path.join(root, "cleantext");
  if (!fs.existsSync(docsPath)) throw new Error(`Prototype corpus not found: ${docsPath}`);
  if (!fs.existsSync(cleanDir)) throw new Error(`Prototype clean-text dir not found: ${cleanDir}`);

  const lines = fs.readFileSync(docsPath, "utf8").split("\n").filter(Boolean);
  const entries: PmcCoverageSeedEntry[] = [];
  for (const line of lines) {
    let rec: PrototypeDocRecord;
    try {
      rec = JSON.parse(line) as PrototypeDocRecord;
    } catch {
      continue; // tolerate a partial trailing line
    }
    if (!rec.pmcid) continue;
    const textPath = path.join(cleanDir, `${rec.pmcid}.txt`);
    if (!fs.existsSync(textPath)) continue;
    const canonicalText = fs.readFileSync(textPath, "utf8");
    if (canonicalText.trim().length === 0) continue;
    entries.push({
      pmcId: rec.pmcid,
      doi: rec.doi != null && String(rec.doi).length > 0 ? String(rec.doi) : null,
      pmid: rec.pmid != null && String(rec.pmid).length > 0 ? String(rec.pmid) : null,
      title: rec.title && String(rec.title).length > 0 ? String(rec.title) : rec.pmcid,
      license: rec.license && String(rec.license).length > 0 ? String(rec.license) : "unknown",
      citation: rec.citation != null && String(rec.citation).length > 0 ? String(rec.citation) : null,
      canonicalText,
      version: Number.isInteger(rec.version) ? Number(rec.version) : 1,
      // The prototype corpus is filtered to is_retracted=false at build time;
      // retraction is applied later via a separate tombstone path.
      isRetracted: false,
      oaSnapshotDate,
    });
  }
  entries.sort((a, b) => (a.pmcId < b.pmcId ? -1 : a.pmcId > b.pmcId ? 1 : 0));
  return entries;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(String(args["corpus-root"] ?? DEFAULT_PROTOTYPE_ROOT));
  const dbUrl = typeof args["db-url"] === "string" ? (args["db-url"] as string) : undefined;
  const dryRun = Boolean(args["dry-run"]) || !dbUrl;
  const oaSnapshotDate =
    typeof args["oa-snapshot-date"] === "string" ? (args["oa-snapshot-date"] as string) : null;

  const entries = loadPmcPrototypeCorpus(root, oaSnapshotDate);
  console.log(`Loaded ${entries.length} PMC coverage entries from ${root}.`);
  console.log(
    `fingerprint_version=${PMC_COMPACT_FINGERPRINT_VERSION}, df_band_policy=${PMC_DF_BAND_POLICY_VERSION}`,
  );

  if (dryRun) {
    console.log("--dry-run: no database connection opened, nothing written. Sample of what would be seeded:");
    for (const e of entries.slice(0, 5)) {
      console.log(`  ${e.pmcId} | v${e.version} | "${e.title.slice(0, 60)}" | ${e.canonicalText.length} chars | license=${e.license}`);
    }
    if (entries.length > 5) console.log(`  ... and ${entries.length - 5} more.`);
    if (!dbUrl) console.log("(pass --db-url=<file:/libsql:> and --oa-snapshot-date=<YYYY-MM-DD> to actually seed.)");
    return;
  }

  if (dbUrl!.toLowerCase().includes("prod")) {
    throw new Error(`Refusing to run against a database URL containing "prod": ${dbUrl}. This tool never targets Production.`);
  }
  if (!oaSnapshotDate) {
    throw new Error(
      "--oa-snapshot-date=<YYYY-MM-DD> is required for an actual seed — it must be the real OA-snapshot date the prototype corpus was built against, never fabricated.",
    );
  }

  const authToken = typeof args["auth-token"] === "string" ? (args["auth-token"] as string) : undefined;
  const client = createClient({ url: dbUrl!, authToken });
  const isRemote = dbUrl!.startsWith("libsql://") || dbUrl!.includes("turso.io");
  if (!isRemote) {
    // Local file target — migrate a fresh file. A remote (Preview/dev) database
    // is expected to already be migrated; this tool never migrates a remote URL.
    await applyMigrationsLibsql(client, path.resolve("drizzle"));
  }

  console.log(`Seeding ${entries.length} documents into ${dbUrl} (oaSnapshotDate=${oaSnapshotDate})...`);
  const start = Date.now();
  const result = await seedPmcCoverageCorpus(client, entries);
  const elapsedMs = Date.now() - start;
  const seeded = result.documents.filter((d) => d.status === "SEEDED").length;
  const updated = result.documents.filter((d) => d.status === "UPDATED").length;
  const unchanged = result.documents.filter((d) => d.status === "UNCHANGED").length;
  const totalFingerprints = result.documents.reduce((t, d) => t + d.fingerprintRows, 0);
  const dfBands = result.dfBands.skipped
    ? `${result.dfBands.persistedRows} DF-band rows (unchanged — rebuild skipped)`
    : `${result.dfBands.persistedRows} DF-band rows (DF>=${result.dfBands.minPersistedDf}); histogram=${JSON.stringify(result.dfBands.histogram)}`;
  console.log(
    `Done in ${elapsedMs}ms (${result.dbCalls} DB round trips): ${seeded} seeded, ${updated} updated, ` +
    `${unchanged} unchanged; ${totalFingerprints} distinct fingerprints; ${dfBands}.`,
  );
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
