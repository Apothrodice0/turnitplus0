import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import {
  seedArchiveDocument,
  ARCHIVE_FINGERPRINT_VERSION,
} from "../lib/archive-corpus-seed.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";

/**
 * 100k-scale architecture, slice 1 — scale benchmark for the DB-backed
 * archive matching adapter. One tier per invocation (resumes from whatever
 * the given DB file already has seeded), so results land incrementally:
 *
 *   node --import tsx archive_scale_benchmark.mjs <dbFile> <targetTier>
 *
 * Synthetic documents (word-salad from a fixed vocabulary, ~2,500 words
 * each) rather than real corpus/ text — this is a scale/latency benchmark,
 * not a parity test (tests/archive-corpus-parity.test.mjs covers parity,
 * already verified against the real 321-document archive too).
 *
 * Seeding uses BOUNDED CONCURRENCY purely as a benchmark-practicality
 * choice for this one-time, offline import step — it does not change what's
 * measured, which is READ-side candidate-discovery/matching latency against
 * whatever corpus size has been seeded. A handful of "planted" queries are
 * tracked so true-match recall / false-negative rate is measured against a
 * known ground truth, not just inferred from latency.
 */

const SEED_CONCURRENCY = 1;
const WORDS_PER_DOC = 2_500;
const MAXIMUM_DOCUMENT_FREQUENCY = 12;
const FIRST_SEEN_AT = "2020-01-01 00:00:00";
const CORPUS_VERSION = "bench-archive-v1";
const PLANTS_PER_TIER = 5;

const dbFile = path.resolve(process.argv[2] ?? "archive_scale_benchmark.db");
const targetTier = Number(process.argv[3] ?? 1000);

const isFreshDb = !fs.existsSync(dbFile);
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await client.execute("PRAGMA journal_mode = WAL");
// See archive_bulk_loader.mjs's own comment: applyMigrationsLibsql
// unconditionally re-runs every migration file, and at least one
// pre-existing migration lacks IF NOT EXISTS, so only migrate a fresh file.
if (isFreshDb) await applyMigrationsLibsql(client, path.resolve("drizzle"));

let roundTrips = 0;
const originalExecute = client.execute.bind(client);
client.execute = (...args) => { roundTrips += 1; return originalExecute(...args); };
const originalBatch = client.batch.bind(client);
client.batch = (...args) => { roundTrips += 1; return originalBatch(...args); };

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
function plantedPassage(plantId) {
  return `plantedmarkeralpha${plantId} plantedmarkerbeta${plantId} plantedmarkergamma${plantId} plantedmarkerdelta${plantId} plantedmarkerepsilon${plantId} plantedmarkerzeta${plantId} plantedmarkereta${plantId} plantedmarkertheta${plantId} plantedmarkeriota${plantId} plantedmarkerkappa${plantId} plantedmarkerlambda${plantId} plantedmarkermu${plantId}`;
}

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length));
  return sortedMs[index];
}

// NOTE: bulk NOISE documents (everything except the small planted set) are
// expected to already be populated up to (targetTier - PLANTS_PER_TIER) by
// archive_bulk_loader.mjs, run as a separate step for wall-clock practicality
// — see this file's own header and that script's header for why. This
// script seeds only the tier's own PLANTS_PER_TIER planted documents, via
// the REAL production seedArchiveDocument primitive (so what's actually
// being read-latency-tested, and recall-tested, went through the same
// write path parity was verified against).
const existingCountRow = await client.execute("SELECT COUNT(*) AS c FROM archive_document_representations WHERE fingerprint_version = '" + ARCHIVE_FINGERPRINT_VERSION + "'");
const alreadySeeded = Number(existingCountRow.rows[0].c);
console.log(`[tier ${targetTier}] already seeded: ${alreadySeeded}`);

if (targetTier > alreadySeeded) {
  const plantBase = targetTier - PLANTS_PER_TIER;
  if (alreadySeeded < plantBase) {
    throw new Error(`[tier ${targetTier}] expected noise documents already loaded up to ${plantBase} (run archive_bulk_loader.mjs first) — only ${alreadySeeded} present.`);
  }
  const plantedAtIndexes = new Map();
  const seedStart = Date.now();
  for (let p = 0; p < PLANTS_PER_TIER; p += 1) {
    const index = plantBase + p;
    const plantId = `${targetTier}-${p}`;
    plantedAtIndexes.set(index, plantId);
    const body = `${syntheticDocument(index)} ${plantedPassage(plantId)}`;
    await seedArchiveDocument(client, {
      archiveArticleId: `bench-${index}`,
      title: `Synthetic Benchmark Document ${index}`,
      originalSimilarity: null,
      text: body,
      archiveOrder: index,
    }, { corpusVersion: CORPUS_VERSION, firstSeenAt: FIRST_SEEN_AT });
  }
  const seedMs = Date.now() - seedStart;
  console.log(`[tier ${targetTier}] seeded ${PLANTS_PER_TIER} planted documents (production path) in ${seedMs}ms`);
  fs.writeFileSync(`${dbFile}.plants.json`, JSON.stringify([...(fs.existsSync(`${dbFile}.plants.json`) ? JSON.parse(fs.readFileSync(`${dbFile}.plants.json`, "utf8")) : []), ...plantedAtIndexes.entries()]));
} else {
  console.log(`[tier ${targetTier}] already at or past this tier (${alreadySeeded} seeded) — skipping seed, measuring reads only.`);
}

const allPlants = fs.existsSync(`${dbFile}.plants.json`) ? JSON.parse(fs.readFileSync(`${dbFile}.plants.json`, "utf8")) : [];

const latenciesMs = [];
let totalCandidateRows = 0;
let recallHits = 0;
const roundTripsBeforeReads = roundTrips;
const memBefore = process.memoryUsage().heapUsed;
const asOf = new Date("2026-09-05T00:00:00Z");

// Measure against the most recent PLANTS_PER_TIER plants (this tier's own),
// plus a few pure-noise queries for the "nothing planted" baseline.
const recentPlants = allPlants.slice(-PLANTS_PER_TIER);
for (const [plantIndex, plantId] of recentPlants) {
  const submission = `An unrelated introduction precedes this excerpt entirely, about a wholly different subject area. ${plantedPassage(plantId)} A separate, unrelated closing remark follows this excerpt in a longer submitted document today.`;
  const start = Date.now();
  const result = await matchAgainstArchiveCorpus(client, submission, {
    maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY,
    matchingParameters: { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY, minimumMatchedWords: 5 },
    asOf,
  });
  latenciesMs.push(Date.now() - start);
  totalCandidateRows += result.sources.length;
  const expectedTitle = `Synthetic Benchmark Document ${plantIndex}`;
  if (result.sources.some((s) => s.name === expectedTitle)) recallHits += 1;
}
for (let i = 0; i < PLANTS_PER_TIER; i += 1) {
  const submission = syntheticDocument(50_000_000 + i);
  const start = Date.now();
  await matchAgainstArchiveCorpus(client, submission, {
    maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY,
    matchingParameters: { maximumDocumentFrequency: MAXIMUM_DOCUMENT_FREQUENCY, minimumMatchedWords: 5 },
    asOf,
  });
  latenciesMs.push(Date.now() - start);
}

const memAfter = process.memoryUsage().heapUsed;
const sorted = [...latenciesMs].sort((a, b) => a - b);
const readRoundTrips = roundTrips - roundTripsBeforeReads;
const shingleCountRow = await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE fingerprint_version = ?", args: [ARCHIVE_FINGERPRINT_VERSION] });
const shingleCount = Number(shingleCountRow.rows[0].c);
const finalCountRow = await client.execute({ sql: "SELECT COUNT(*) AS c FROM archive_document_representations WHERE fingerprint_version = ?", args: [ARCHIVE_FINGERPRINT_VERSION] });
const finalCount = Number(finalCountRow.rows[0].c);

console.log(`[tier ${targetTier}] RESULT ` + JSON.stringify({
  actualCorpusSize: finalCount,
  readLatencyMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] || 0, samples: sorted.length },
  readRoundTripsTotal: readRoundTrips,
  readRoundTripsPerQuery: Math.round((readRoundTrips / Math.max(1, latenciesMs.length)) * 100) / 100,
  avgCandidateRowsPerPlantedQuery: Math.round((totalCandidateRows / Math.max(1, recentPlants.length)) * 100) / 100,
  recall: `${recallHits}/${recentPlants.length}`,
  falseNegativeRate: recentPlants.length ? Math.round(((recentPlants.length - recallHits) / recentPlants.length) * 1000) / 1000 : null,
  heapUsedDeltaMb: Math.round(((memAfter - memBefore) / (1024 * 1024)) * 100) / 100,
  heapUsedTotalMb: Math.round((memAfter / (1024 * 1024)) * 100) / 100,
  totalArchiveShingleRows: shingleCount,
}));

client.close();
