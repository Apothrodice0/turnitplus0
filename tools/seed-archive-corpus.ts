/**
 * tools/seed-archive-corpus.ts
 *
 * 100k-scale architecture, slice 1 — offline/importable CLI for seeding the
 * built-in archive (public/data/document-index.*, currently 321 documents)
 * into corpus_document_representations / corpus_document_shingles, using the
 * real production write primitives (lib/archive-corpus-seed.ts).
 *
 * OFFLINE ONLY, BY DESIGN: reads corpus/manifest.json + corpus/similarity/
 * text/*.txt, which are gitignored and restored locally from the archive's
 * own build tree — never expected to exist on a deployed server. This is a
 * one-off (or occasionally re-run) import step you run by hand against a
 * chosen database, never something a live request path calls.
 *
 * Usage:
 *   node --import tsx tools/seed-archive-corpus.ts --db-url=file:./local.db
 *   node --import tsx tools/seed-archive-corpus.ts --db-url=libsql://<preview-host> --auth-token=$TURSO_AUTH_TOKEN --dry-run
 *
 * --dry-run reads and validates the source (corpus/manifest.json entries,
 * text files present, meta.json cross-reference) and reports what WOULD be
 * seeded, without opening a database connection at all — the safe first
 * step before pointing this at any real database, Preview included. There
 * is no flag to target Production: this tool never applies migrations or
 * writes to a database URL containing "prod" (case-insensitive), matching
 * the same discipline tests/schema-drift.test.mjs already applies to
 * TURSO_DATABASE_URL.
 */

import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { loadArchiveSourceEntries, seedArchiveCorpus } from "../lib/archive-corpus-seed";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    args[key] = rest.length > 0 ? rest.join("=") : true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpusRoot = path.resolve(String(args["corpus-root"] ?? "corpus"));
  const metaPath = path.resolve(String(args["meta-path"] ?? "public/data/document-index.meta.json"));
  const dryRun = Boolean(args["dry-run"]);

  const entries = loadArchiveSourceEntries(corpusRoot, metaPath);
  const withOrder = entries.filter((entry) => entry.archiveOrder !== undefined).length;
  console.log(`Loaded ${entries.length} index-source entries from ${corpusRoot}/manifest.json.`);
  console.log(`${withOrder}/${entries.length} entries resolved an archiveOrder from ${metaPath}.`);
  if (withOrder < entries.length) {
    console.warn(
      `WARNING: ${entries.length - withOrder} entries have no archiveOrder (not found in ${metaPath}'s articles[]) ` +
      "— they will seed with a NULL archive_order, sorting after every explicitly-ordered row in " +
      "lib/archive-corpus-matching.ts's own tie-break. Confirm meta-path points at the SAME archive build " +
      "these manifest entries came from before proceeding.",
    );
  }

  if (dryRun) {
    console.log("--dry-run: no database connection opened, nothing written. Sample of what would be seeded:");
    for (const entry of entries.slice(0, 5)) {
      console.log(`  ${entry.archiveArticleId} | order=${entry.archiveOrder ?? "NULL"} | "${entry.title}" | ${entry.text.length} chars`);
    }
    if (entries.length > 5) console.log(`  ... and ${entries.length - 5} more.`);
    return;
  }

  const dbUrl = args["db-url"];
  if (typeof dbUrl !== "string") {
    throw new Error("Missing required --db-url=<url> (or use --dry-run to validate the source without a database).");
  }
  if (dbUrl.toLowerCase().includes("prod")) {
    throw new Error(`Refusing to run against a database URL containing "prod": ${dbUrl}. This tool never targets Production.`);
  }
  const authToken = typeof args["auth-token"] === "string" ? (args["auth-token"] as string) : undefined;
  const corpusVersion = typeof args["corpus-version"] === "string" ? (args["corpus-version"] as string) : undefined;
  const firstSeenAt = typeof args["first-seen-at"] === "string" ? (args["first-seen-at"] as string) : undefined;
  if (!corpusVersion || !firstSeenAt) {
    throw new Error(
      "Both --corpus-version=<archive corpusVersion, e.g. from document-index.meta.json> and " +
      "--first-seen-at=<honest SQLite-UTC timestamp, e.g. the archive build's own generatedAt> are required " +
      "— see lib/archive-corpus-seed.ts's SeedArchiveDocumentOptions.firstSeenAt for why this must be a real fact, never fabricated.",
    );
  }

  const client = createClient({ url: dbUrl, authToken });
  if (!dbUrl.startsWith("libsql://") && !dbUrl.includes("turso.io")) {
    // Local file target — apply migrations if this is a fresh file. A
    // remote (Preview/dev) database is expected to already be migrated;
    // this tool never runs migrations against a remote URL.
    await applyMigrationsLibsql(client, path.resolve("drizzle"));
  }

  console.log(`Seeding ${entries.length} documents into ${dbUrl} (corpusVersion=${corpusVersion}, firstSeenAt=${firstSeenAt})...`);
  const start = Date.now();
  const results = await seedArchiveCorpus(client, entries, { corpusVersion, firstSeenAt });
  const elapsedMs = Date.now() - start;
  const seeded = results.filter((r) => r.status === "SEEDED").length;
  const alreadySeeded = results.filter((r) => r.status === "ALREADY_SEEDED").length;
  console.log(`Done in ${elapsedMs}ms: ${seeded} newly seeded, ${alreadySeeded} already present (idempotent re-run safe).`);
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
