import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { gramHash, grams, tokens } from "../lib/similarity-core.ts";
import { scoreAgainstArchiveDetailed } from "../lib/archive-similarity-scoring.ts";
import { ARCHIVE_SHINGLE_SIZE, ARCHIVE_COMPACT_FINGERPRINT_VERSION, archiveShingleHashes } from "../lib/archive-fingerprint.ts";
import { ARCHIVE_FINGERPRINT_VERSION, seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";
import { loadDfBandMap, deriveStopHashSet } from "../lib/archive-df-bands.ts";
import { loadArchiveMatchConfig } from "../lib/archive-static-config.ts";

/**
 * GOLD GAP — Archive co-source (G1s) expansion must not depend on whether an
 * independent verified source passed the per-source admission floor (0.5% of
 * the analysed words). Its second clause used to read the primary pass's
 * ADMITTED sources: with a near-duplicate archive document self-excluded, an
 * independent source A that cleared the floor kept the gate closed, and the
 * same A below the floor (longer text) opened it and pulled A-unrelated
 * co-sources in. It now reads the primary pass's verified evidence before
 * admission. The near-duplicate collapse it exists for still opens it.
 *
 * Fixture (mirrors tests/archive-scalable-index.test.mjs's 2D.4 catastrophe):
 * two near-duplicate archive documents ND1/ND2 hold PASSAGE + COSOURCE_RUN
 * (5-gram DF 2 — every phrase-fallback slot goes to them); the co-source
 * family B (four documents) holds only COSOURCE_RUN (DF 6 with ND1/ND2: a
 * co-source edge, not compact, not a rare seed, never probed), so B is
 * reachable only through the adjacency graph. A is an independent document
 * whose copied 25-word region is compact-discovered. Shipped matching
 * parameters; expansion flag on. Synthetic text only.
 */

const syn = (ns, n) => [...Array(n).keys()].map((i) => `zq${ns}x${i.toString(36)}v`);
const config = loadArchiveMatchConfig();
const P = config.matchingParameters;
const MDF = config.maximumDocumentFrequency;

const PASSAGE = syn(601, 150);
const COSOURCE_RUN = syn(602, 7);
const A_PASSAGE = syn(603, 80);
const DOCS = [
  { id: "cos-nd-1", title: "Near-Dup One", body: [...syn(611, 20), ...PASSAGE, ...COSOURCE_RUN, ...syn(612, 10)] },
  { id: "cos-nd-2", title: "Near-Dup Two", body: [...syn(613, 20), ...PASSAGE, ...COSOURCE_RUN, ...syn(614, 10)] },
  ...[0, 1, 2, 3].map((k) => ({ id: `cos-b${k}`, title: `Co-Source B ${k}`, body: [...syn(620 + k, 320), ...COSOURCE_RUN, ...syn(630 + k, 320)] })),
  { id: "cos-a", title: "Independent A", body: [...syn(640, 300), ...A_PASSAGE, ...syn(641, 300)] },
];
const B_TITLES = DOCS.filter((d) => d.id.startsWith("cos-b")).map((d) => d.title);

const dbFile = path.join(process.cwd(), "test_archive_cosource_admission.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
});
for (const [order, doc] of DOCS.entries()) {
  const r = await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.title, originalSimilarity: null, text: doc.body.join(" "), archiveOrder: order }, {
    corpusVersion: "test-cosource-admission-v1",
    firstSeenAt: "2020-01-01 00:00:00",
  });
  assert.equal(r.status, "SEEDED");
}
await rebuildArchiveScalableIndex(client);
const reps = (await client.execute("SELECT representation_id, title FROM archive_document_representations")).rows;
const idByTitle = new Map(reps.map((r) => [String(r.title), String(r.representation_id)]));
const documentCount = reps.length;
const B_IDS = B_TITLES.map((t) => idByTitle.get(t));
const ND_IDS = ["Near-Dup One", "Near-Dup Two"].map((t) => idByTitle.get(t));
const A_ID = idByTitle.get("Independent A");

const stored = new Set((await client.execute({ sql: "SELECT fingerprint_hash FROM archive_document_fingerprints WHERE fingerprint_version = ?", args: [ARCHIVE_COMPACT_FINGERPRINT_VERSION] })).rows.map((r) => String(r.fingerprint_hash)));
let A_REGION = null;
for (let start = 0; start + 25 <= A_PASSAGE.length && !A_REGION; start += 1) {
  const w = A_PASSAGE.slice(start, start + 25);
  if (grams(w, ARCHIVE_SHINGLE_SIZE).some((g) => stored.has(gramHash(g)))) A_REGION = w;
}

// ── submissions ─────────────────────────────────────────────────────────
const HOST = syn(650, 8000);
const NEARDUP_COPY = [...PASSAGE, ...COSOURCE_RUN]; // 157 words: self-excludes ND1 and ND2
const withA = (hostWords) => [...NEARDUP_COPY, ...HOST.slice(0, 30), ...A_REGION, ...HOST.slice(30, 30 + hostWords)];
const SHORT = withA(4000 - 157 - 25 - 30); // 4,000 words: A's floor 20
const LONG = [...SHORT, ...HOST.slice(3818, 5818)]; // + 2,000 unrelated words = 6,000: A's floor 30
const CONTROL = [...NEARDUP_COPY, ...HOST.slice(0, 243)]; // near-dup only, 400 words: floor 2
const NO_NEARDUP = [...HOST.slice(0, 30), ...A_REGION, ...HOST.slice(30, 130), ...COSOURCE_RUN, ...HOST.slice(130, 400)];
const A_POSITIONS = [...Array(25).keys()].map((k) => 187 + k);
const RUN_POSITIONS = [...Array(7).keys()].map((k) => 150 + k);

const { bandByHash } = await loadDfBandMap(client);
const stopHashSet = deriveStopHashSet(bandByHash, MDF);

async function run(words, flag = "true") {
  const prev = process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
  if (flag === undefined) delete process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
  else process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED = flag;
  const textQueries = [];
  const spy = {
    async execute(stmt) {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (/SELECT id, canonical_text FROM corpus_document_representations WHERE id IN/.test(sql)) textQueries.push(stmt.args.map(String));
      return client.execute(stmt);
    },
  };
  try {
    const m = await matchAgainstArchiveCorpus(spy, words.join(" "), { maximumDocumentFrequency: MDF, matchingParameters: P });
    return { m, compactIds: textQueries[0], searchedIds: new Set(textQueries.flat()) };
  } finally {
    if (prev === undefined) delete process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
    else process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED = prev;
  }
}
/** matcher step 1 over the compact set (scoreOverCandidates construction): both forms of the gate's second clause. */
async function gateInputs(words, ids) {
  const text = words.join(" ");
  const ph = ids.map(() => "?").join(",");
  const order = (await client.execute({ sql: `SELECT representation_id, archive_order FROM archive_document_representations WHERE fingerprint_version = ? AND representation_id IN (${ph})`, args: [ARCHIVE_FINGERPRINT_VERSION, ...ids] })).rows;
  const texts = (await client.execute({ sql: `SELECT id, canonical_text FROM corpus_document_representations WHERE id IN (${ph})`, args: ids })).rows;
  const hs = new Map(texts.map((r) => [String(r.id), archiveShingleHashes(String(r.canonical_text), ARCHIVE_SHINGLE_SIZE)]));
  const ordered = order.slice().sort((l, r) => Number(l.archive_order) - Number(r.archive_order));
  const postings = new Map();
  ordered.forEach((row, si) => { for (const h of hs.get(String(row.representation_id))) { const l = postings.get(h); if (l) l.push(si); else postings.set(h, [si]); } });
  const articles = ordered.map((row) => ({ title: String(row.representation_id), sourceType: "Publication", uniqueShingleCount: hs.get(String(row.representation_id)).size }));
  const d = scoreAgainstArchiveDetailed(text, { shingleSize: ARCHIVE_SHINGLE_SIZE, documentCount, maximumDocumentFrequency: MDF, articles, getPostings: (h) => (stopHashSet.has(h) ? [] : (postings.get(h) ?? [])) }, P);
  return { admittedSourcesEmpty: d.result.sources.length === 0, preAdmissionEvidenceEmpty: d.verifiedEvidencePositions.length === 0 };
}

const short = await run(SHORT);
const long = await run(LONG);
const control = await run(CONTROL);
const noNearDup = await run(NO_NEARDUP);
const noNearDupFlagOff = await run(NO_NEARDUP, undefined);
const shortGate = await gateInputs(SHORT, short.compactIds);
const longGate = await gateInputs(LONG, long.compactIds);
const bSearched = (r) => B_IDS.some((id) => r.searchedIds.has(id));
const bScores = (r) => r.m.sources.some((s) => B_TITLES.includes(s.name));
const aScores = (r) => A_POSITIONS.every((p) => r.m.archiveMatchedPositions.includes(p));
const floorWords = (n) => Math.ceil((P.minimumSourceContribution / 100) * n - 1e-9);

test("fixture preconditions: shipped thresholds; ND1/ND2 self-exclude; A is compact-discovered; B only through the adjacency graph", () => {
  assert.equal(P.minimumSourceContribution, 0.5);
  assert.ok(A_REGION, "a compact-discoverable A window exists");
  assert.equal(tokens(SHORT.join(" ")).length, 4000);
  assert.equal(tokens(LONG.join(" ")).length, 6000);
  assert.deepEqual([floorWords(4000), floorWords(6000)], [20, 30]);
  for (const r of [short, long]) {
    assert.equal(r.m.archiveDiscovery.cosource.selfExcludedCandidateCount, 2, "ND1 and ND2 self-exclude");
    assert.ok(r.compactIds.includes(A_ID), "A is compact-discovered");
    for (const id of B_IDS) assert.ok(!r.compactIds.includes(id), "no B document is compact-discovered");
  }
  for (const id of ND_IDS) assert.ok(short.compactIds.includes(id));
});

test("the proven coupling: the OLD gate input (admitted sources) flips with A's admission; the pre-admission evidence does not", () => {
  assert.ok(aScores(short), "A clears 20 words in the short text");
  assert.ok(!aScores(long), "A is below 30 words in the long text");
  assert.equal(shortGate.admittedSourcesEmpty, false, "old input, short: A admitted -> gate closed");
  assert.equal(longGate.admittedSourcesEmpty, true, "old input, long: A below the floor -> gate would open and search B");
  assert.equal(shortGate.preAdmissionEvidenceEmpty, false);
  assert.equal(longGate.preAdmissionEvidenceEmpty, false, "A's verified evidence is the same in both texts");
});

test("after the fix: the expansion decision and B's discovery are identical in both texts; only A's admission differs", () => {
  assert.equal(short.m.archiveDiscovery.cosource.eligible, long.m.archiveDiscovery.cosource.eligible);
  assert.equal(long.m.archiveDiscovery.cosource.eligible, false, "independent verified evidence exists -> no near-duplicate collapse");
  assert.equal(short.m.archiveDiscovery.cosource.applied, false);
  assert.equal(long.m.archiveDiscovery.cosource.applied, false);
  assert.equal(bSearched(short), bSearched(long));
  assert.equal(bSearched(long), false, "B is not searched in either text");
  assert.ok(!bScores(short) && !bScores(long));
  // nothing unverified scores: in the long text A is verified but below the floor -> nothing scores at all
  assert.deepEqual(long.m.archiveMatchedPositions, [], "near-dups self-excluded, A below the floor, B not a candidate");
  assert.deepEqual(short.m.archiveMatchedPositions, A_POSITIONS, "short text: exactly A's admitted words");
});

test("the near-duplicate collapse still expands: B is searched, verified, and scores only through its own admission", () => {
  const c = control.m.archiveDiscovery.cosource;
  assert.equal(c.selfExcludedCandidateCount, 2);
  assert.equal(c.eligible, true, "only self-excluded candidates verified anything -> G1s opens, as before");
  assert.equal(c.applied, true);
  assert.ok(bSearched(control), "B retrieved through the adjacency graph");
  assert.ok(bScores(control), `B scores its own ${RUN_POSITIONS.length} verified words (>= floor ${floorWords(400)})`);
  assert.deepEqual(control.m.archiveMatchedPositions, RUN_POSITIONS, "only the co-source run scores; the self-excluded near-dups never do");
  const listed = control.m.sources.flatMap((s) => s.attributedRanges.flatMap(([a, b]) => [...Array(b - a + 1).keys()].map((k) => a + k)));
  assert.deepEqual(listed.sort((x, y) => x - y), RUN_POSITIONS, "every scored word belongs to an admitted, verified B-family source");
  assert.ok(control.m.sources.every((s) => B_TITLES.includes(s.name)));
});

test("negative: without a near-duplicate the gate never opens — no adjacency lookup, result identical to expansion off", () => {
  const c = noNearDup.m.archiveDiscovery.cosource;
  assert.equal(c.selfExcludedCandidateCount, 0);
  assert.equal(c.eligible, false);
  assert.equal(c.anchorCount, 0, "no adjacency lookup");
  assert.equal(c.applied, false);
  // B's run is an ordinary unmatched region here, so the phrase fallback may find B on its own;
  // the graph adds nothing: the matcher result equals the flag-off matcher's.
  const { archiveDiscovery: _on, ...onResult } = noNearDup.m;
  const { archiveDiscovery: _off, ...offResult } = noNearDupFlagOff.m;
  assert.deepEqual(onResult, offResult);
  assert.deepEqual([...noNearDup.searchedIds].sort(), [...noNearDupFlagOff.searchedIds].sort(), "same documents searched with expansion on and off");
});
