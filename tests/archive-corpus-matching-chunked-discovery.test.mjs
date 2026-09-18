import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { tokens, grams, gramHash } from "../lib/similarity-core.ts";
import { seedArchiveDocument, ARCHIVE_FINGERPRINT_VERSION } from "../lib/archive-corpus-seed.ts";
import { ARCHIVE_COMPACT_FINGERPRINT_VERSION } from "../lib/archive-fingerprint.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";

/**
 * Regression coverage for the compactDiscovery() SQL bound-variable-limit fix
 * (lib/archive-corpus-matching.ts): a full-text query over a very large
 * document can produce tens of thousands of unique query 5-gram hashes, one
 * bound `?` parameter per hash in a single `fingerprint_hash IN (...)` lookup
 * — which used to throw "SQLITE_ERROR: too many SQL variables" once past the
 * driver's compiled SQLITE_MAX_VARIABLE_NUMBER. compactDiscovery now chunks
 * that lookup (DISCOVERY_HASH_CHUNK = 400, same bound already used by
 * lib/archive-cosource.ts's LOOKUP_ANCHOR_CHUNK) and merges per-chunk
 * COUNT(*) totals in JS before applying the same ORDER BY / LIMIT. Synthetic
 * fixtures only, so this runs anywhere including CI.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uniq = (ns, i) => `zx${ns}q${i.toString(36)}w`;
function distinctiveDoc(ns, wordCount) {
  const w = [];
  for (let i = 0; i < wordCount; i += 1) w.push(uniq(ns, i));
  return w.join(" ");
}
function filler(ns, wordCount, seed) {
  const rand = mulberry32(seed);
  const w = [];
  for (let i = 0; i < wordCount; i += 1) w.push(`fl${ns}k${Math.floor(rand() * wordCount).toString(36)}z`);
  return w.join(" ");
}
/** Distinct, never-repeating padding tokens -- guarantees N new unique 5-grams
 *  without needing to check set membership (each numbered token differs from
 *  every other, so every window of 5 consecutive tokens is itself unique). */
function uniquePadding(ns, count) {
  const w = [];
  for (let i = 0; i < count; i += 1) w.push(`pad${ns}n${i}`);
  return w.join(" ");
}
function queryHashCount(text) {
  return new Set(grams(tokens(text), 5).map(gramHash)).size;
}

const dbFile = path.join(process.cwd(), "test_archive_chunked_discovery.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
});

const MDF = 12;
const MATCHING = { maximumDocumentFrequency: 6, minimumMatchedWords: 5 };
const FIRST_SEEN_AT = "2020-01-01 00:00:00";
const CORPUS_VERSION = "test-chunked-discovery-v1";

// A real, findable excerpt each seeded source shares with later queries.
const SPAN_A = "quartzite bryophyte lodestar palimpsest zephyrous cindery obsidian marmoset";
const SPAN_B = "cormorant thicket sextant marmoset gyrfalcon hallux keratin osprey";
const SOURCE_A = `${distinctiveDoc(1, 150)} ${SPAN_A} ${distinctiveDoc(2, 150)}`;
const SOURCE_B = `${distinctiveDoc(3, 150)} ${SPAN_B} ${distinctiveDoc(4, 150)}`;

const DOCS = [
  { id: "chunk-src-a", title: "Chunk Source A", body: SOURCE_A },
  { id: "chunk-src-b", title: "Chunk Source B", body: SOURCE_B },
  { id: "chunk-filler-1", title: "Filler 1", body: filler(50, 300, 1) },
  { id: "chunk-filler-2", title: "Filler 2", body: filler(51, 300, 2) },
];
for (const doc of DOCS) {
  await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.title, originalSimilarity: null, text: doc.body }, { corpusVersion: CORPUS_VERSION, firstSeenAt: FIRST_SEEN_AT });
}

test("chunked discovery: a query far larger than one DB-safe chunk still discovers its real source (parameter-limit avoidance)", async () => {
  // one real excerpt (SPAN_A, findable) + enough unique padding to push the
  // query comfortably past DISCOVERY_HASH_CHUNK (400) into multiple chunks.
  const text = `${filler(60, 40, 9)} ${SPAN_A} ${filler(61, 40, 10)} ${uniquePadding("big", 1500)}`;
  const hashCount = queryHashCount(text);
  assert.ok(hashCount > 400 * 2, `test fixture must span >=3 chunks, got ${hashCount} unique hashes`);
  const result = await matchAgainstArchiveCorpus(client, text, { maximumDocumentFrequency: MDF, matchingParameters: MATCHING });
  assert.ok(result.sources.some((s) => s.name === "Chunk Source A"), "the real excerpt's source must still be discovered across a chunked lookup");
});

test("chunked discovery: exact equivalence to an unchunked raw-SQL reference at 800 unique hashes (2 chunks)", async () => {
  const text = `${filler(70, 30, 11)} ${SPAN_B} ${filler(71, 30, 12)} ${uniquePadding("mid", 700)}`;
  const hashCount = queryHashCount(text);
  assert.ok(hashCount > 400 && hashCount < 999, `expected a 2-chunk-but-single-unchunked-query-safe size, got ${hashCount}`);

  // ground truth: ONE unchunked query (still safe at this size) against the same table/version
  const hashList = [...new Set(grams(tokens(text), 5).map(gramHash))];
  const placeholders = hashList.map(() => "?").join(",");
  const reference = await client.execute({
    sql: `SELECT representation_id, COUNT(*) AS shared FROM archive_document_fingerprints
          WHERE fingerprint_version = ? AND fingerprint_hash IN (${placeholders}) GROUP BY representation_id`,
    args: [ARCHIVE_COMPACT_FINGERPRINT_VERSION, ...hashList],
  });
  const referenceShared = new Map(reference.rows.map((r) => [String(r.representation_id), Number(r.shared)]));

  const result = await matchAgainstArchiveCorpus(client, text, { maximumDocumentFrequency: MDF, matchingParameters: MATCHING });
  assert.equal(result.archiveDiscovery.compactCandidateCount, referenceShared.size, "chunked discovery must find exactly the same candidate COUNT as the unchunked reference");
  assert.ok(result.sources.some((s) => s.name === "Chunk Source B"));
});

test("chunked discovery: no duplicate/missing rows exactly at the chunk boundary (399, 400, 401 unique hashes)", async () => {
  for (const target of [399, 400, 401]) {
    const text = `${SPAN_A} ${uniquePadding("bnd" + target, target)}`;
    const hashList = [...new Set(grams(tokens(text), 5).map(gramHash))];
    const placeholders = hashList.map(() => "?").join(",");
    const reference = await client.execute({
      sql: `SELECT representation_id, COUNT(*) AS shared FROM archive_document_fingerprints
            WHERE fingerprint_version = ? AND fingerprint_hash IN (${placeholders}) GROUP BY representation_id`,
      args: [ARCHIVE_COMPACT_FINGERPRINT_VERSION, ...hashList],
    });
    const refIds = new Set(reference.rows.map((r) => String(r.representation_id)));

    const result = await matchAgainstArchiveCorpus(client, text, { maximumDocumentFrequency: MDF, matchingParameters: MATCHING });
    assert.equal(result.archiveDiscovery.compactCandidateCount, refIds.size, `boundary size ${target}: candidate count must match the unchunked reference exactly (no duplicate or missing rows from the merge)`);
  }
});

test("chunked discovery: empty query and a single-hash query are both safe", async () => {
  const empty = await matchAgainstArchiveCorpus(client, "", { maximumDocumentFrequency: MDF, matchingParameters: MATCHING });
  assert.equal(empty.sources.length, 0);
  assert.equal(empty.archiveDiscovery.compactCandidateCount, 0);

  const oneWord = await matchAgainstArchiveCorpus(client, "onesingleword", { maximumDocumentFrequency: MDF, matchingParameters: MATCHING });
  assert.equal(oneWord.archiveDiscovery.compactCandidateCount, 0, "a query too short to form a single 5-gram must discover nothing, not throw");
});

test("chunked discovery: a query past the REAL SQLite bound-variable ceiling (~33k+ params) — this is what actually broke under the old unchunked query", async () => {
  // 35,000+ unique hashes: comfortably past SQLite's compiled
  // SQLITE_MAX_VARIABLE_NUMBER (32,766 on this driver) in a single IN (...) —
  // this is the exact class of query that previously threw
  // "SQLITE_ERROR: too many SQL variables" (verified against the real 3
  // formerly-blocked Archive v6 candidates, each with 36k-46k unique hashes).
  const text = `${filler(80, 30, 13)} ${SPAN_B} ${filler(81, 30, 14)} ${uniquePadding("huge", 35000)}`;
  const hashCount = queryHashCount(text);
  assert.ok(hashCount > 33000, `test fixture must exceed the real SQLite variable ceiling, got ${hashCount}`);
  const result = await matchAgainstArchiveCorpus(client, text, { maximumDocumentFrequency: MDF, matchingParameters: MATCHING });
  assert.ok(result.sources.some((s) => s.name === "Chunk Source B"), "the real excerpt's source must still be discovered even past the true SQLite parameter ceiling");
});

test("chunked discovery: a mid-loop read failure propagates (fail-closed), never a partial/silent result", async () => {
  let calls = 0;
  const failingClient = {
    execute: async (stmt) => {
      calls += 1;
      // let the first chunk succeed, then fail — proves an error part-way
      // through the chunk loop aborts the whole call rather than returning
      // whatever chunks happened to complete first.
      if (calls === 2) throw new Error("SIMULATED_TRANSIENT_READ_FAILURE");
      return client.execute(stmt);
    },
  };
  const text = `${SPAN_A} ${uniquePadding("failtest", 900)}`; // >=3 chunks, so a failure on call #2 is genuinely mid-loop
  await assert.rejects(
    () => matchAgainstArchiveCorpus(failingClient, text, { maximumDocumentFrequency: MDF, matchingParameters: MATCHING }),
    /SIMULATED_TRANSIENT_READ_FAILURE/,
    "a chunk failure must reject the whole match call, never resolve with a partial candidate set",
  );
  assert.ok(calls >= 2, "the failure must actually occur mid-loop, not before the first chunk");
});
