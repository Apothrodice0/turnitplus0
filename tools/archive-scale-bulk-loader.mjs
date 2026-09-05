import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { archiveShingleHashes, ARCHIVE_FINGERPRINT_VERSION, ARCHIVE_EXTRACTOR_VERSION } from "../lib/archive-corpus-seed.ts";
import { CANONICALIZATION_VERSION } from "../lib/user-submission-corpus.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";

/**
 * 100k-scale architecture, slice 1 — BENCHMARK-ONLY fast bulk loader.
 *
 * NOT the production archive-import path (lib/archive-corpus-seed.ts's
 * seedArchiveDocument is that, and is what tests/archive-corpus-parity.test.mjs
 * and the real-321-document validation exercised). This script exists
 * purely to populate a large synthetic corpus quickly enough to measure
 * READ-side (candidate discovery / matching) latency at 10k-100k scale
 * within a reasonable wall-clock budget.
 *
 * Why the production path can't reach 100k in reasonable time as-is: it
 * issues ~5-6 separate sequential DB round trips per document (existence
 * check, canonical-hash lookup, representation INSERT, representation
 * SELECT-back, batched shingle write, metadata INSERT) — measured at
 * ~940ms/document against the real 321-document archive (sequential, no
 * concurrency). At that rate 100k documents would take on the order of a
 * day. This loader batches MANY documents' inserts into large, infrequent
 * client.batch() calls instead, skipping the redundant hash-collision and
 * already-seeded checks (safe here only because every synthetic id is
 * unique by construction) — a benchmark-practicality shortcut, not a
 * proposed replacement for the production import path. The production
 * path's own per-document cost is exactly the kind of thing a follow-up
 * slice should batch/parallelize for a real bulk import; this file is
 * evidence for why that follow-up matters, not a substitute for it.
 */

const DOCS_PER_BATCH = 25;
const WORDS_PER_DOC = 2_500;
const FIRST_SEEN_AT = "2020-01-01 00:00:00";
const CORPUS_VERSION = "bench-archive-v1";

const dbFile = path.resolve(process.argv[2] ?? "archive_scale_benchmark.db");
const startIndex = Number(process.argv[3]);
const endIndexExclusive = Number(process.argv[4]);

const isFreshDb = !fs.existsSync(dbFile);
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await client.execute("PRAGMA journal_mode = WAL");
// applyMigrationsLibsql re-runs EVERY drizzle/*.sql file unconditionally on
// every call (no migration-tracking table — see lib/ingest.ts's own
// applyMigrationsLibsql); at least one pre-existing early migration does not
// guard its CREATE TABLE with IF NOT EXISTS, so re-invoking it against an
// already-migrated file throws. Since this benchmark script is invoked once
// per index range (not once per whole run), only migrate a genuinely fresh
// file.
if (isFreshDb) await applyMigrationsLibsql(client, path.resolve("drizzle"));

const VOCAB = Array.from({ length: 4000 }, (_, i) => `lexeme${i.toString(36)}`);
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function syntheticDocument(index) {
  const rand = mulberry32(index + 1);
  const words = [];
  for (let i = 0; i < WORDS_PER_DOC; i += 1) words.push(VOCAB[Math.floor(rand() * VOCAB.length)]);
  return words.join(" ");
}
const start = Date.now();
let written = 0;
for (let batchStart = startIndex; batchStart < endIndexExclusive; batchStart += DOCS_PER_BATCH) {
  const batchEnd = Math.min(endIndexExclusive, batchStart + DOCS_PER_BATCH);
  const statements = [];
  for (let index = batchStart; index < batchEnd; index += 1) {
    const canonicalText = canonicalizeText(syntheticDocument(index));
    const canonicalHash = canonicalSha256(canonicalText);
    const wordCount = canonicalText.split(/\s+/).filter(Boolean).length;
    const representationId = randomUUID();
    statements.push({
      sql: `INSERT INTO corpus_document_representations
            (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at)
            VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      args: [representationId, canonicalHash, canonicalText, wordCount, null, CANONICALIZATION_VERSION, ARCHIVE_EXTRACTOR_VERSION, FIRST_SEEN_AT],
    });
    const hashes = [...archiveShingleHashes(canonicalText)];
    for (const hash of hashes) {
      statements.push({
        sql: "INSERT OR IGNORE INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
        args: [representationId, hash, ARCHIVE_FINGERPRINT_VERSION],
      });
    }
    statements.push({
      sql: `INSERT INTO archive_document_representations
            (archive_article_id, representation_id, title, source_type, original_similarity, archive_order, corpus_version, fingerprint_version, created_at)
            VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      args: [`bench-${index}`, representationId, `Synthetic Benchmark Document ${index}`, "Publication", null, index, CORPUS_VERSION, ARCHIVE_FINGERPRINT_VERSION],
    });
  }
  await client.batch(statements, "write");
  written += batchEnd - batchStart;
}
const elapsedMs = Date.now() - start;
console.log(`bulk-loaded ${written} documents (indexes ${startIndex}..${endIndexExclusive - 1}) in ${elapsedMs}ms (${Math.round((written / (elapsedMs / 1000)) * 100) / 100} docs/sec)`);
client.close();
