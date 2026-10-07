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
import { phraseFallbackDiscovery, PHRASE_FALLBACK_BUDGET } from "../lib/archive-phrase-fallback.ts";
import { loadArchiveMatchConfig } from "../lib/archive-static-config.ts";

/**
 * GOLD GAP — Archive candidate discovery must not depend on whether another
 * candidate passed the per-source admission floor (0.5% of the analysed
 * words). The phrase fallback used to be fed the ADMITTED union: when analysed
 * text grew (footnotes now analysed), source A fell below the floor, its
 * verified words turned into discovery gaps, their probes took the fixed
 * 16-probe budget, and source B — which clears the floor on its own evidence —
 * was never retrieved (the Gold case: Financing Challenges -> Legal
 * Confrontation of Cyber Terrorism). It is now fed the primary pass's
 * PRE-admission verified evidence. Admission and scoring are unchanged.
 *
 * The fixture reproduces the mechanism: A's copied region is held by two
 * archive documents (5-gram DF 2 — below the persisted DF-band floor of 13, so
 * a MATCHED copy is no discovery gap, while an unmatched one is a 0.5-weight
 * probe); B's region is held by four (DF 4: probe weight 0.25, not a rare
 * seed) and shares no compact fingerprint with the submission, so B is
 * reachable only through phrase probes. Shipped matching parameters
 * (public/data/risk-calibration.json). Synthetic text only.
 */

const syn = (ns, n) => [...Array(n).keys()].map((i) => `zq${ns}x${i.toString(36)}v`);
const config = loadArchiveMatchConfig();
const P = config.matchingParameters;
const MDF = config.maximumDocumentFrequency;

// ── archive ─────────────────────────────────────────────────────────────
const A_PASSAGE = syn(501, 80);
const B_PASSAGE = syn(502, 160);
const DOCS = [
  { id: "dec-a", title: "Source A", body: [...syn(511, 300), ...A_PASSAGE, ...syn(512, 300)] },
  { id: "dec-a2", title: "Source A twin", body: [...syn(513, 250), ...A_PASSAGE, ...syn(514, 250)] },
  ...[0, 1, 2, 3].map((k) => ({ id: `dec-b${k}`, title: `Source B family ${k}`, body: [...syn(520 + k, 200 + 40 * k), ...B_PASSAGE, ...syn(530 + k, 200)] })),
  { id: "dec-other", title: "Unrelated archive paper", body: syn(540, 600) },
];

const dbFile = path.join(process.cwd(), "test_archive_discovery_admission.db");
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
    corpusVersion: "test-discovery-admission-v1",
    firstSeenAt: "2020-01-01 00:00:00",
  });
  assert.equal(r.status, "SEEDED");
}
await rebuildArchiveScalableIndex(client);
const reps = (await client.execute("SELECT representation_id, title FROM archive_document_representations")).rows;
const repId = new Map(reps.map((r) => [String(r.title), String(r.representation_id)]));
const documentCount = reps.length;
const B_IDS = [0, 1, 2, 3].map((k) => repId.get(`Source B family ${k}`));
const A_ID = repId.get("Source A");
const A2_ID = repId.get("Source A twin");

// Stored compact fingerprints, to pick a copied A window that IS compact-discoverable and a B window that is NOT.
const stored = new Set((await client.execute({ sql: "SELECT fingerprint_hash FROM archive_document_fingerprints WHERE fingerprint_version = ?", args: [ARCHIVE_COMPACT_FINGERPRINT_VERSION] })).rows.map((r) => String(r.fingerprint_hash)));
const windowHashes = (words) => grams(words, ARCHIVE_SHINGLE_SIZE).map(gramHash);
const pickWindow = (passage, length, wantFingerprint) => {
  for (let start = 0; start + length <= passage.length; start += 1) {
    const hit = windowHashes(passage.slice(start, start + length)).some((h) => stored.has(h));
    if (hit === wantFingerprint) return passage.slice(start, start + length);
  }
  return null;
};
const A_REGION = pickWindow(A_PASSAGE, 25, true);
const B_REGION = pickWindow(B_PASSAGE, 40, false);

// ── submissions: A region, host, B region, host — then 2,000 more words of unrelated host text ──
const HOST = syn(550, 8000);
const SHORT = [...A_REGION, ...HOST.slice(0, 30), ...B_REGION, ...HOST.slice(30, 3935)]; // 25 + 30 + 40 + 3,905 = 4,000 words
const LONG = [...SHORT, ...HOST.slice(3935, 5935)]; // + 2,000 = 6,000 words
const SHORT_TEXT = SHORT.join(" ");
const LONG_TEXT = LONG.join(" ");
const A_POSITIONS = [...Array(25).keys()];
const B_POSITIONS = [...Array(40).keys()].map((k) => 55 + k);

const { bandByHash } = await loadDfBandMap(client);
const stopHashSet = deriveStopHashSet(bandByHash, MDF);

function spy(inner) {
  const textQueries = [];
  return {
    textQueries,
    async execute(stmt) {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (/SELECT id, canonical_text FROM corpus_document_representations WHERE id IN/.test(sql)) textQueries.push(stmt.args.map(String));
      return inner.execute(stmt);
    },
  };
}
async function runMatcher(text) {
  const c = spy(client);
  const m = await matchAgainstArchiveCorpus(c, text, { maximumDocumentFrequency: MDF, matchingParameters: P });
  return { m, compactIds: c.textQueries[0], finalIds: c.textQueries[c.textQueries.length - 1] };
}
/** matcher step 1 over the compact set (same construction as scoreOverCandidates), with both of its discovery inputs. */
async function primaryPass(text, ids) {
  const ph = ids.map(() => "?").join(",");
  const order = (await client.execute({ sql: `SELECT representation_id, title, archive_order FROM archive_document_representations WHERE fingerprint_version = ? AND representation_id IN (${ph})`, args: [ARCHIVE_FINGERPRINT_VERSION, ...ids] })).rows;
  const texts = (await client.execute({ sql: `SELECT id, canonical_text FROM corpus_document_representations WHERE id IN (${ph})`, args: ids })).rows;
  const hs = new Map(texts.map((r) => [String(r.id), archiveShingleHashes(String(r.canonical_text), ARCHIVE_SHINGLE_SIZE)]));
  const ordered = order.slice().sort((l, r) => Number(l.archive_order) - Number(r.archive_order));
  const postings = new Map();
  ordered.forEach((row, si) => { for (const h of hs.get(String(row.representation_id))) { const l = postings.get(h); if (l) l.push(si); else postings.set(h, [si]); } });
  const articles = ordered.map((row) => ({ title: String(row.title), sourceType: "Publication", uniqueShingleCount: hs.get(String(row.representation_id)).size }));
  const detailed = scoreAgainstArchiveDetailed(text, { shingleSize: ARCHIVE_SHINGLE_SIZE, documentCount, maximumDocumentFrequency: MDF, articles, getPostings: (h) => (stopHashSet.has(h) ? [] : (postings.get(h) ?? [])) }, P);
  return { admittedUnion: detailed.result.archiveMatchedPositions, preAdmissionEvidence: detailed.verifiedEvidencePositions };
}

const shortRun = await runMatcher(SHORT_TEXT);
const longRun = await runMatcher(LONG_TEXT);
const longPrimary = await primaryPass(LONG_TEXT, longRun.compactIds);
const shortPrimary = await primaryPass(SHORT_TEXT, shortRun.compactIds);
const fallbackOn = (text, matched, compactIds) => phraseFallbackDiscovery(client, text, matched, compactIds, { stopHashSet, bandByHash });
const oldInputLong = await fallbackOn(LONG_TEXT, longPrimary.admittedUnion, longRun.compactIds);
const newInputLong = await fallbackOn(LONG_TEXT, longPrimary.preAdmissionEvidence, longRun.compactIds);
const newInputShort = await fallbackOn(SHORT_TEXT, shortPrimary.preAdmissionEvidence, shortRun.compactIds);
const floorWords = (words) => Math.ceil((P.minimumSourceContribution / 100) * words - 1e-9);

test("fixture preconditions: shipped thresholds; A is compact-discovered, B only reachable by phrase probes; A's floor flips, B's does not", () => {
  assert.equal(P.minimumSourceContribution, 0.5);
  assert.equal(PHRASE_FALLBACK_BUDGET, 16);
  assert.ok(A_REGION && B_REGION, "windows found");
  assert.equal(tokens(SHORT_TEXT).length, 4000);
  assert.equal(tokens(LONG_TEXT).length, 6000);
  assert.equal(floorWords(4000), 20);
  assert.equal(floorWords(6000), 30);
  for (const run of [shortRun, longRun]) {
    assert.ok(run.compactIds.includes(A_ID) || run.compactIds.includes(A2_ID), "A's family is compact-discovered");
    for (const id of B_IDS) assert.ok(!run.compactIds.includes(id), "no B document shares a compact fingerprint with the submission");
  }
});

test("the proven failure: with the ADMITTED union as discovery input, A dropping below the floor loses B; with pre-admission evidence it does not", () => {
  // A is verified in both texts, admitted only in the short one.
  assert.ok(A_POSITIONS.every((p) => longPrimary.preAdmissionEvidence.includes(p)), "A's words are verified evidence in the long text");
  assert.ok(A_POSITIONS.every((p) => !longPrimary.admittedUnion.includes(p)), "but A is below the 0.5% floor there");
  assert.ok(A_POSITIONS.every((p) => shortPrimary.admittedUnion.includes(p)), "and admitted in the short text");
  // old input: A's words become gaps, their probes fill the budget, B is not discovered
  assert.ok(B_IDS.every((id) => !oldInputLong.unionCandidateIds.includes(id)), "admitted-union input: B is lost");
  // new input: the same evidence in both texts -> B discovered either way
  assert.ok(B_IDS.every((id) => newInputLong.phraseCandidateIds.includes(id)), "pre-admission input: B discovered (long)");
  assert.ok(B_IDS.every((id) => newInputShort.phraseCandidateIds.includes(id)), "pre-admission input: B discovered (short)");
  assert.equal(newInputLong.probes.length, PHRASE_FALLBACK_BUDGET);
  assert.deepEqual(newInputLong.probes.slice(0, 8), newInputShort.probes.slice(0, 8), "the leading probes do not move when A's admission flips");
});

test("matcher: B's discovery is invariant to A's admission, and B still passes only its OWN admission", () => {
  for (const [name, run, words] of [["short", shortRun, 4000], ["long", longRun, 6000]]) {
    for (const id of B_IDS) assert.ok(run.finalIds.includes(id), `${name}: B family member retrieved`);
    const union = new Set(run.m.archiveMatchedPositions);
    assert.ok(B_POSITIONS.every((p) => union.has(p)), `${name}: B's 40 own words score (40 >= ${floorWords(words)})`);
    assert.equal(run.m.wordCount, words);
  }
  // A: admitted when short, below the unchanged 0.5% floor when long — its verified words then do not score
  assert.ok(A_POSITIONS.every((p) => shortRun.m.archiveMatchedPositions.includes(p)));
  assert.ok(A_POSITIONS.every((p) => !longRun.m.archiveMatchedPositions.includes(p)), "evidence used for discovery is not score evidence");
  assert.ok(longRun.m.sources.every((s) => !/^Source A/.test(s.name)));
});

test("nothing unverified scores: every scored word belongs to an admitted source's own verified evidence", () => {
  for (const run of [shortRun, longRun]) {
    const listed = new Set(run.m.sources.flatMap((s) => s.attributedRanges.flatMap(([a, b]) => [...Array(b - a + 1).keys()].map((k) => a + k))));
    assert.deepEqual([...listed].sort((x, y) => x - y), run.m.archiveMatchedPositions, "the union is exactly the listed sources' attributed words");
    const allowed = new Set([...A_POSITIONS, ...B_POSITIONS]);
    assert.ok(run.m.archiveMatchedPositions.every((p) => allowed.has(p)), "no host word scores");
  }
  assert.deepEqual(longRun.m.archiveMatchedPositions, B_POSITIONS, "long text: exactly B's recovered words");
});
