import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient, LibsqlError } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";
import { analyzeArchiveOnServer } from "../lib/archive-server-analysis.ts";
import { createArchiveReadRetryClient } from "../lib/archive-read-retry.ts";

/**
 * The bounded read-retry layer wired through the REAL server matcher against a
 * synthetic seeded archive (local libsql file, CI-safe — no Turso). Proves:
 *
 *   - matchAgainstArchiveCorpus runs on the retry wrapper (not the raw client);
 *   - a transient read failure in ANY matcher read stage — doc count, DF-band
 *     load, compact discovery, candidate order/text, FTS phrase probe,
 *     co-source adjacency — recovers on retry and yields the byte-identical
 *     result the no-failure path produces;
 *   - every stage shares ONE per-request retry budget;
 *   - retry exhaustion still throws (fail-closed);
 *   - a non-retriable DB error still throws immediately, no retry.
 *
 * All backoff sleeps are stubbed (sleep: () => {}), so nothing waits.
 */

const repo = path.resolve(".");
const dbFile = path.join(repo, "test_archive_read_retry_matcher.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repo, "drizzle"));

const uniq = (ns, i) => `zr${ns}x${i.toString(36)}w`;
const distinctive = (ns, n) => Array.from({ length: n }, (_, i) => uniq(ns, i)).join(" ");

// rr-a / rr-b share a 150-word run -> a query overlapping it triggers compact
// discovery + the FTS phrase-probe path without self-excluding.
const SHARED = distinctive(9000, 150);
// rr-d / rr-e are near-duplicates -> a whole-doc query self-excludes BOTH,
// opening the G1s gate so the co-source adjacency read actually runs.
const NEARDUP = distinctive(6000, 520);

const DOCS = [
  { id: "rr-a", title: "Retry Source A", body: `${distinctive(1, 300)} ${SHARED} ${distinctive(2, 300)}` },
  { id: "rr-b", title: "Retry Peer B", body: `${distinctive(3, 400)} ${SHARED} ${distinctive(4, 400)}` },
  { id: "rr-c", title: "Retry Unrelated C", body: distinctive(5, 800) },
  { id: "rr-d", title: "Retry Near-dup D", body: `${NEARDUP} ${distinctive(10, 24)}` },
  { id: "rr-e", title: "Retry Near-dup E", body: `${NEARDUP} ${distinctive(11, 24)}` },
];
for (const [order, d] of DOCS.entries()) {
  const r = await seedArchiveDocument(
    client,
    { archiveArticleId: d.id, title: d.title, originalSimilarity: null, text: d.body, archiveOrder: order },
    { corpusVersion: "retry-matcher-v1", firstSeenAt: "2020-01-01 00:00:00" },
  );
  assert.equal(r.status, "SEEDED");
}
const rebuild = await rebuildArchiveScalableIndex(client);
assert.ok(rebuild.cosources.edgeRows >= 1, "the near-dup pair produces at least one co-source edge");

const MDF = 12;
const MP = undefined;
const PROBE = `Opening framing sentence. ${distinctive(3, 400)} ${SHARED} A separate unrelated closing sentence here.`;

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
});

function httpError(status) {
  const cause = Object.assign(new Error(`Server returned HTTP status ${status}`), { name: "HttpServerError", status });
  return new LibsqlError(`Server returned HTTP status ${status}`, "SERVER_ERROR", undefined, undefined, cause);
}

/** Delegates to the real client, but the first time it sees a SQL matching a
 *  fault's pattern it throws that fault once (then lets the retry through). */
function faultInjector(realClient, faults) {
  const fired = new Set();
  const seen = [];
  return {
    seen,
    firedCount: () => fired.size,
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      seen.push(sql);
      for (const [idx, f] of faults.entries()) {
        if (!fired.has(idx) && f.pattern.test(sql)) { fired.add(idx); throw f.error; }
      }
      return realClient.execute(stmt);
    },
  };
}

const NO_WAIT = { sleep: async () => {}, random: () => 0.5 };
const norm = (m) => JSON.stringify(m, Object.keys(m).sort());

let CLEAN;
test("baseline: matchAgainstArchiveCorpus over a plain client (no faults)", async () => {
  CLEAN = await matchAgainstArchiveCorpus(client, PROBE, { maximumDocumentFrequency: MDF, matchingParameters: MP });
  assert.ok(CLEAN.score > 0, "the shared run scores > 0");
  assert.ok(CLEAN.sources.length >= 1);
});

test("a transient failure in FOUR different matcher read stages recovers from ONE shared budget, yielding the identical result", async () => {
  const base = faultInjector(client, [
    { pattern: /FROM archive_hash_df_bands/i, error: httpError(502) },          // DF-band load
    { pattern: /FROM archive_document_fingerprints/i, error: httpError(503) },   // compact discovery
    { pattern: /archive_phrase_fts\s+MATCH/i, error: httpError(504) },           // an FTS phrase probe
    { pattern: /FROM corpus_document_representations/i, error: httpError(502) },  // candidate text reconstruction
  ]);
  const { client: retry, state } = createArchiveReadRetryClient(base, NO_WAIT);
  const recovered = await matchAgainstArchiveCorpus(retry, PROBE, { maximumDocumentFrequency: MDF, matchingParameters: MP });

  assert.equal(norm(recovered), norm(CLEAN), "recovered result is byte-identical to the no-failure path");
  assert.equal(base.firedCount(), 4, "all four injected faults were actually hit");
  assert.equal(state.retriesConsumed, 4, "4 stages each recovered on retry, from ONE shared budget");
  assert.equal(state.retriesRemaining, 6 - 4);
});

test("phrase-fallback FTS reads draw from the SAME request budget as the compact reads", async () => {
  // pre-spend 5 of the 6 shared retries on the compact/DF stages, then fail a
  // phrase probe: only 1 retry left, it is used, and the next transient failure
  // anywhere would propagate.
  const base = faultInjector(client, [
    { pattern: /FROM archive_hash_df_bands/i, error: httpError(502) },
    { pattern: /FROM archive_document_representations WHERE fingerprint_version/i, error: httpError(502) },
    { pattern: /FROM corpus_document_representations/i, error: httpError(503) },
    { pattern: /archive_phrase_fts\s+MATCH/i, error: httpError(504) },
  ]);
  const { client: retry, state } = createArchiveReadRetryClient(base, NO_WAIT);
  const out = await matchAgainstArchiveCorpus(retry, PROBE, { maximumDocumentFrequency: MDF, matchingParameters: MP });
  assert.equal(norm(out), norm(CLEAN));
  assert.equal(base.firedCount(), 4);
  assert.ok(state.retriesConsumed === 4 && state.retriesRemaining === 2,
    "compact-stage and phrase-stage retries came out of the same counter");
  assert.ok(base.seen.some((s) => /archive_phrase_fts\s+MATCH/i.test(s)), "a phrase probe really ran");
});

test("with ARCHIVE_COSOURCE_EXPANSION_ENABLED=true, the co-source adjacency read shares the SAME request budget", async () => {
  process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED = "true";
  try {
    const wholeD = DOCS[3].body; // near-dup of rr-e -> G1s gate opens -> loadCosources runs
    const cleanD = await matchAgainstArchiveCorpus(client, wholeD, { maximumDocumentFrequency: MDF, matchingParameters: MP });
    assert.ok(cleanD.archiveDiscovery.cosource, "co-source diagnostics present with the flag on");

    const base = faultInjector(client, [
      { pattern: /FROM archive_hash_df_bands/i, error: httpError(503) },        // an early stage
      { pattern: /FROM archive_document_cosources/i, error: httpError(504) },   // the co-source adjacency read
    ]);
    const { client: retry, state } = createArchiveReadRetryClient(base, NO_WAIT);
    const recoveredD = await matchAgainstArchiveCorpus(retry, wholeD, { maximumDocumentFrequency: MDF, matchingParameters: MP });

    assert.equal(norm(recoveredD), norm(cleanD));
    assert.ok(base.seen.some((s) => /FROM archive_document_cosources/i.test(s)), "the co-source adjacency table was queried");
    assert.equal(base.firedCount(), 2, "both the early-stage and the co-source fault were hit");
    assert.equal(state.retriesConsumed, 2, "the co-source read's retry came out of the same shared budget as the earlier stage");
  } finally {
    delete process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
  }
});

test("retry exhaustion still rejects matchAgainstArchiveCorpus (fail-closed) — no browser fallback exists here", async () => {
  const alwaysFailDfBand = {
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (/FROM archive_hash_df_bands/i.test(sql)) throw httpError(502);
      return client.execute(stmt);
    },
  };
  const { client: retry, state } = createArchiveReadRetryClient(alwaysFailDfBand, NO_WAIT);
  await assert.rejects(
    () => matchAgainstArchiveCorpus(retry, PROBE, { maximumDocumentFrequency: MDF, matchingParameters: MP }),
    /HTTP status 502/,
  );
  assert.equal(state.retriesConsumed, 2, "exactly the per-read cap of 2, then the error propagates");
  assert.equal(state.retriesRemaining, 4);
});

test("a non-retriable DB error rejects matchAgainstArchiveCorpus immediately — zero retries", async () => {
  const base = faultInjector(client, [
    { pattern: /FROM archive_document_fingerprints/i, error: new LibsqlError("no such table: archive_document_fingerprints", "SQLITE_UNKNOWN") },
  ]);
  const { client: retry, state } = createArchiveReadRetryClient(base, NO_WAIT);
  await assert.rejects(
    () => matchAgainstArchiveCorpus(retry, PROBE, { maximumDocumentFrequency: MDF, matchingParameters: MP }),
    /no such table/,
  );
  assert.equal(state.retriesConsumed, 0);
  assert.equal(base.firedCount(), 1);
});

test("analyzeArchiveOnServer recovers a transient read failure end-to-end and reports it in readRetry (server-only)", async () => {
  process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
  try {
    const base = faultInjector(client, [
      { pattern: /FROM archive_hash_df_bands/i, error: httpError(503) },
      { pattern: /archive_phrase_fts\s+MATCH/i, error: httpError(502) },
    ]);
    const out = await analyzeArchiveOnServer(base, PROBE, { readRetry: NO_WAIT });
    assert.ok(out.result.score > 0, "analysis still produced a real result");
    assert.equal(out.readRetry.retriesConsumed, 2);
    assert.equal(out.readRetry.retriesRemaining, 4);
    assert.equal("readRetry" in out.result, false, "retry accounting never leaks into the public result");
  } finally {
    delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  }
});

test("analyzeArchiveOnServer with no transient failures reports zero retries and no added latency", async () => {
  process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
  try {
    let sleepCalls = 0;
    const out = await analyzeArchiveOnServer(client, PROBE, {
      readRetry: { sleep: async () => { sleepCalls += 1; }, random: () => 0.5 },
    });
    assert.equal(out.readRetry.retriesConsumed, 0);
    assert.equal(out.readRetry.retriesRemaining, 6);
    assert.equal(sleepCalls, 0, "a healthy request schedules no backoff at all");
  } finally {
    delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  }
});
