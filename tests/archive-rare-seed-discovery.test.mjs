import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { tokens, grams, gramHash, informativeGram } from "../lib/similarity-core.ts";
import { scoreAgainstArchive } from "../lib/archive-similarity-scoring.ts";
import { ARCHIVE_SHINGLE_SIZE, ARCHIVE_COMPACT_FINGERPRINT_VERSION, archiveShingleHashes } from "../lib/archive-fingerprint.ts";
import { ARCHIVE_FINGERPRINT_VERSION, seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";
import { loadDfBandMap, deriveStopHashSet } from "../lib/archive-df-bands.ts";
import { phraseAnyPresent, phraseFanOut, phraseSearch } from "../lib/archive-phrase-index.ts";
import {
  phraseFallbackDiscovery,
  resolveQueryGramDf,
  resolveQueryGramDfWithRareSeeds,
  nominateRareSeedCandidates,
  wholeDocumentOrder,
  PHRASE_FALLBACK_BUDGET,
  PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS,
  DF_RESOLVE_GROUP_SIZE,
  RARE_SEED_MAX_DF,
  RARE_SEED_MIN_SUPPORT,
  RARE_SEED_WINDOW,
  RARE_SEED_MAX_CANDIDATES,
  ARCHIVE_PHRASE_FALLBACK_POLICY_VERSION,
} from "../lib/archive-phrase-fallback.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { baselineB, normalizeArchiveResult } from "./helpers/archive-baseline-b.mjs";

/**
 * Archive rare-seed discovery (archive-phrase-fallback-v2). v1 resolved
 * unmatched-region 5-gram DFs one COUNT at a time in DOCUMENT ORDER until the
 * 384-check cap, so an edited copied passage late in a long submission was
 * never checked and its source was never a candidate. v2 resolves the SAME
 * grams to the SAME values (group-tested, so novel text costs ~1 query per
 * 16 grams), spends the saved budget on a whole-document pass, and lets
 * corroborated rare (DF <= 3) exact 5-grams NOMINATE candidates. Discovery
 * only: every nominated document is retrieved and verified by the unchanged
 * scoreAgainstArchive; a seed never scores. Synthetic fixtures only.
 */

const uniq = (ns, i) => `zx${ns}q${i.toString(36)}w`;
function distinctiveDoc(ns, wordCount) {
  const w = [];
  for (let i = 0; i < wordCount; i += 1) w.push(uniq(ns, i));
  return w.join(" ");
}
const words = (text) => text.split(" ");
const insert1per5 = (ws, ns) => ws.flatMap((w, i) => ((i + 1) % 5 === 0 ? [w, `ins${ns}x${i.toString(36)}y`] : [w]));
const delete1per8 = (ws, offset = 7) => ws.filter((_, i) => i % 8 !== offset);
const punctuate = (ws) => ws.map((w, i) => (i % 7 === 3 ? `(${w}),` : i % 11 === 5 ? `"${w}";` : w)).map((w, i) => w + (i % 9 === 8 ? "\r\n" : i % 4 === 1 ? "\t " : "  ")).join("").trim();

// ── DB SETUP — every top-level await resolves before the first test() ──────
const dbFile = path.join(process.cwd(), "test_archive_rare_seed_discovery.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
});

const MDF = 12;
const MATCHING = { maximumDocumentFrequency: MDF, minimumMatchedWords: 5 };

const PASSAGE_LATE = distinctiveDoc(20, 150);
const PASSAGE_EARLY = distinctiveDoc(21, 120);
const COINCIDENCE_RUN = distinctiveDoc(22, 5);
const RUN_A = distinctiveDoc(23, 5);
const RUN_B = distinctiveDoc(24, 5);
const RUN_C = distinctiveDoc(25, 5);
const SHORT_SPAN = distinctiveDoc(26, 8); // < any winnowing guarantee
const BOILER = distinctiveDoc(900, 60); // DF 15 -> df-band table -> stop set
const COMMON6 = distinctiveDoc(901, 30); // DF 6 -> never a rare seed
const TRIPLE_COUNT = 24;

const ARCHIVE_DOCS = [
  { id: "rs-late-src", title: "Late Passage Source", body: `${distinctiveDoc(10, 300)} ${PASSAGE_LATE} ${distinctiveDoc(11, 300)}` },
  { id: "rs-early-src", title: "Early Passage Source", body: `${distinctiveDoc(12, 300)} ${PASSAGE_EARLY} ${distinctiveDoc(13, 300)}` },
  { id: "rs-coincidence-src", title: "Coincidence Source", body: `${distinctiveDoc(14, 400)} ${COINCIDENCE_RUN} ${distinctiveDoc(15, 400)}` },
  { id: "rs-three-runs-src", title: "Three Runs Source", body: `${distinctiveDoc(16, 300)} ${RUN_A} ${distinctiveDoc(17, 20)} ${RUN_B} ${distinctiveDoc(18, 20)} ${RUN_C} ${distinctiveDoc(19, 300)}` },
  { id: "rs-short-span-src", title: "Short Span Source", body: `${distinctiveDoc(27, 150)} ${SHORT_SPAN} ${distinctiveDoc(28, 150)}` },
];
for (let i = 0; i < 15; i += 1) ARCHIVE_DOCS.push({ id: `rs-boiler-${i}`, title: `Boiler Carrier ${i}`, body: `${distinctiveDoc(100 + i, 300)} ${BOILER}` });
for (let i = 0; i < 6; i += 1) ARCHIVE_DOCS.push({ id: `rs-common6-${i}`, title: `Common6 Carrier ${i}`, body: `${distinctiveDoc(200 + i, 300)} ${COMMON6}` });
for (let i = 0; i < TRIPLE_COUNT; i += 1) {
  ARCHIVE_DOCS.push({ id: `rs-triple-${i}`, title: `Triple Carrier ${i}`, body: `${distinctiveDoc(300 + i, 200)} ${distinctiveDoc(1000 + i, 5)} ${distinctiveDoc(400 + i, 30)} ${distinctiveDoc(2000 + i, 5)} ${distinctiveDoc(600 + i, 30)} ${distinctiveDoc(3000 + i, 5)} ${distinctiveDoc(500 + i, 200)}` });
}
for (const [order, doc] of ARCHIVE_DOCS.entries()) {
  const r = await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.title, originalSimilarity: null, text: doc.body, archiveOrder: order }, {
    corpusVersion: "test-rare-seed-v1",
    firstSeenAt: "2020-01-01 00:00:00",
  });
  assert.equal(r.status, "SEEDED", `fresh seed for ${doc.id}`);
}
await rebuildArchiveScalableIndex(client);

const repRows = (await client.execute("SELECT representation_id, title FROM archive_document_representations")).rows;
const repIdByTitle = new Map(repRows.map((r) => [String(r.title), String(r.representation_id)]));
const documentCount = repRows.length;
const { bandByHash } = await loadDfBandMap(client);
const stopHashSet = deriveStopHashSet(bandByHash, MDF);

/** Reads spy — records every statement the matcher issues. */
function spy(inner) {
  const log = [];
  return {
    log,
    async execute(stmt) {
      const res = await inner.execute(stmt);
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const entry = { sql };
      if (/FROM corpus_document_representations WHERE id IN/.test(sql)) entry.ids = stmt.args.map(String);
      log.push(entry);
      return res;
    },
  };
}
const finalCandidateIds = (log) => { const r = log.filter((e) => e.ids); return r.length ? r[r.length - 1].ids : []; };
const ftsQueryCount = (log) => log.filter((e) => /archive_phrase_fts\s+MATCH/i.test(e.sql)).length;
const MAX_DF_RESOLVE_QUERIES = PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS + Math.ceil(PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS / DF_RESOLVE_GROUP_SIZE);
const MAX_FTS_QUERIES = MAX_DF_RESOLVE_QUERIES + 2 * PHRASE_FALLBACK_BUDGET;

async function runMatcher(text, matchingParameters = MATCHING) {
  const c = spy(client);
  const m = await matchAgainstArchiveCorpus(c, text, { maximumDocumentFrequency: MDF, matchingParameters });
  return { m, log: c.log };
}

/** Compact fingerprints the submission shares with one representation. */
async function sharedFingerprints(text, representationId) {
  const hashes = [...new Set(grams(tokens(text), 5).map(gramHash))];
  let shared = 0;
  for (let i = 0; i < hashes.length; i += 400) {
    const chunk = hashes.slice(i, i + 400);
    const r = await client.execute({
      sql: `SELECT COUNT(*) AS c FROM archive_document_fingerprints WHERE fingerprint_version = ? AND representation_id = ? AND fingerprint_hash IN (${chunk.map(() => "?").join(",")})`,
      args: [ARCHIVE_COMPACT_FINGERPRINT_VERSION, representationId, ...chunk],
    });
    shared += Number(r.rows[0].c);
  }
  return shared;
}

/** The UNCHANGED scorer over an explicit candidate set — a verbatim port of
 *  lib/archive-corpus-matching.ts's private scoreOverCandidates. */
async function scoreOverIds(text, ids, matchingParameters = MATCHING) {
  const ph = ids.map(() => "?").join(",");
  const order = (await client.execute({ sql: `SELECT representation_id, title, archive_order FROM archive_document_representations WHERE fingerprint_version = ? AND representation_id IN (${ph})`, args: [ARCHIVE_FINGERPRINT_VERSION, ...ids] })).rows;
  const texts = (await client.execute({ sql: `SELECT id, canonical_text FROM corpus_document_representations WHERE id IN (${ph})`, args: ids })).rows;
  const hashSets = new Map(texts.map((r) => [String(r.id), archiveShingleHashes(String(r.canonical_text), ARCHIVE_SHINGLE_SIZE)]));
  const ordered = order.slice().sort((l, r) => Number(l.archive_order) - Number(r.archive_order) || (l.representation_id < r.representation_id ? -1 : 1));
  const postings = new Map();
  ordered.forEach((row, si) => { for (const h of hashSets.get(String(row.representation_id))) { const l = postings.get(h); if (l) l.push(si); else postings.set(h, [si]); } });
  const articles = ordered.map((row) => ({ title: String(row.title), sourceType: "Publication", uniqueShingleCount: hashSets.get(String(row.representation_id)).size }));
  return scoreAgainstArchive(text, { shingleSize: ARCHIVE_SHINGLE_SIZE, documentCount, maximumDocumentFrequency: MDF, articles, getPostings: (h) => (stopHashSet.has(h) ? [] : (postings.get(h) ?? [])) }, matchingParameters);
}

/** v1 reference (archive-phrase-fallback-v1, verbatim): matched grams then
 *  unmatched grams, BOTH in document order, one COUNT per check. */
async function v1ResolveQueryGramDf(queryWords, matchedPositions, maxChecks = PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS) {
  const matched = new Set(matchedPositions);
  const df = new Map();
  const seen = new Set();
  const order = [];
  let checks = 0;
  for (const wantMatched of [true, false]) {
    for (let s = 0; s + 5 <= queryWords.length; s += 1) {
      if (checks >= maxChecks) return { df, order };
      if (matched.has(s) !== wantMatched) continue;
      const w = queryWords.slice(s, s + 5);
      const h = gramHash(w.join(" "));
      if (seen.has(h) || stopHashSet.has(h)) continue;
      seen.add(h);
      if (!informativeGram(w.join(" "))) { df.set(h, 0); continue; }
      df.set(h, await phraseFanOut(client, w));
      order.push(s);
      checks += 1;
    }
  }
  return { df, order };
}
const clamp21 = (map) => new Map([...map].map(([h, v]) => [h, Math.min(v, 21)]));

// Hosts: informative words that exist in NO archive document (archive DF 0).
const HOST_A = distinctiveDoc(90001, 900);
const HOST_B = distinctiveDoc(90002, 300);
const LATE_INSERT = insert1per5(words(PASSAGE_LATE), 1).join(" ");
const TEXT_LATE_EXACT = `${HOST_A} ${PASSAGE_LATE} ${HOST_B}`;
const TEXT_LATE_INSERT = `${HOST_A} ${LATE_INSERT} ${HOST_B}`;
const TEXT_LATE_PUNCT = `${HOST_A} ${punctuate(words(PASSAGE_LATE))} ${HOST_B}`;
const TEXT_EARLY_EXACT = `${PASSAGE_EARLY} ${HOST_A}`;
const LATE_START = tokens(HOST_A).length; // 900

const LATE_SRC = "Late Passage Source";
const lateSrcId = repIdByTitle.get(LATE_SRC);
const inPassage = (positions, start, len) => positions.filter((p) => p >= start && p < start + len);

// Winnowing can still share a fingerprint with a lightly edited copy by
// chance (the audit measured 0.85 compact discovery for delete-1-per-8). Pick
// the first deletion phase whose copy shares NONE, so the test isolates the
// compact-miss case the rare-seed pass exists for (asserted again below).
let LATE_DELETE = null;
let LATE_DELETE_OFFSET = null;
for (let offset = 7; offset >= 0 && LATE_DELETE === null; offset -= 1) {
  const candidate = delete1per8(words(PASSAGE_LATE), offset).join(" ");
  if (await sharedFingerprints(`${HOST_A} ${candidate} ${HOST_B}`, lateSrcId) === 0) { LATE_DELETE = candidate; LATE_DELETE_OFFSET = offset; }
}
assert.ok(LATE_DELETE, "a delete-1-per-8 phase with no shared compact fingerprint exists");
const TEXT_LATE_DELETE = `${HOST_A} ${LATE_DELETE} ${HOST_B}`;
/** Surviving copied words that sit in a source-contiguous run of >= 5 words
 *  (a shorter run has no exact 5-gram, so it can never verify). */
const deleteVerifiableWords = (() => {
  let total = 0;
  let run = 0;
  words(PASSAGE_LATE).forEach((_, i) => {
    if (i % 8 === LATE_DELETE_OFFSET) { if (run >= 5) total += run; run = 0; } else run += 1;
  });
  return total + (run >= 5 ? run : 0);
})();

// Shared matcher runs (computed once, before any test() — see the note in
// tests/archive-scalable-index.test.mjs about top-level await vs test()).
const late = {
  exact: await runMatcher(TEXT_LATE_EXACT),
  insert: await runMatcher(TEXT_LATE_INSERT),
  delete: await runMatcher(TEXT_LATE_DELETE),
  punct: await runMatcher(TEXT_LATE_PUNCT),
};
const early = await runMatcher(TEXT_EARLY_EXACT);
const fpSharedInsert = await sharedFingerprints(TEXT_LATE_INSERT, lateSrcId);
const lateInsertRepeat = await runMatcher(TEXT_LATE_INSERT);

// ══════════════════════════════════════════════════════════════════════════
test("policy: v2 label, unchanged 384-check / 16-probe bounds, rare-seed constants", () => {
  assert.equal(ARCHIVE_PHRASE_FALLBACK_POLICY_VERSION, "archive-phrase-fallback-v2");
  assert.equal(PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS, 384);
  assert.equal(PHRASE_FALLBACK_BUDGET, 16);
  assert.equal(DF_RESOLVE_GROUP_SIZE, 16);
  assert.equal(RARE_SEED_MAX_DF, 3);
  assert.equal(RARE_SEED_MIN_SUPPORT, 3);
  assert.equal(RARE_SEED_WINDOW, 60);
  assert.equal(RARE_SEED_MAX_CANDIDATES, 16);
});

test("wholeDocumentOrder: a deterministic permutation whose prefixes cover the whole range without periodic aliasing", () => {
  for (const n of [0, 1, 2, 3, 5, 10, 97, 384, 1000, 1597, 2584, 6000]) {
    const order = wholeDocumentOrder(n);
    assert.equal(order.length, n);
    assert.deepEqual([...order].sort((a, b) => a - b), [...Array(n).keys()], `n=${n} must be a permutation`);
    assert.deepEqual(wholeDocumentOrder(n), order, "deterministic");
  }
  const n = 2000;
  const prefix = wholeDocumentOrder(n).slice(0, 64).sort((a, b) => a - b);
  const maxGap = Math.max(prefix[0], n - 1 - prefix[prefix.length - 1], ...prefix.slice(1).map((p, i) => p - prefix[i]));
  assert.ok(maxGap <= 3 * (n / 64), `a 64-block prefix leaves no gap wider than 3x the uniform spacing (got ${maxGap})`);
  const first100 = wholeDocumentOrder(1800).slice(0, 100);
  for (const period of [5, 6, 8]) {
    assert.equal(new Set(first100.map((p) => p % period)).size, period, `the first 100 picks hit every residue mod ${period}`);
  }
});

test("nominateRareSeedCandidates: >= 3 non-overlapping seeds inside one 60-token window; skips existing candidates; ranks and caps deterministically", () => {
  const seed = (position, ids) => ({ position, df: ids.length, representationIds: ids });
  assert.deepEqual(nominateRareSeedCandidates([seed(10, ["x"]), seed(20, ["x"])], []), [], "two seeds never nominate");
  assert.deepEqual(nominateRareSeedCandidates([seed(10, ["x"]), seed(12, ["x"]), seed(14, ["x"])], []), [], "overlapping seeds (one 9-word run) count once");
  assert.deepEqual(nominateRareSeedCandidates([seed(10, ["x"]), seed(15, ["x"]), seed(20, ["x"])], []), ["x"]);
  assert.deepEqual(nominateRareSeedCandidates([seed(0, ["x"]), seed(40, ["x"]), seed(80, ["x"])], []), [], "three seeds spread over 80 tokens are not one window");
  assert.deepEqual(nominateRareSeedCandidates([seed(0, ["x"]), seed(40, ["x"]), seed(59, ["x"])], []), ["x"], "window is [p, p + 60)");
  assert.deepEqual(nominateRareSeedCandidates([seed(10, ["x"]), seed(20, ["x"]), seed(30, ["x"])], ["x"]), [], "already-discovered candidates are not re-nominated");
  assert.deepEqual(
    nominateRareSeedCandidates([seed(0, ["b", "a"]), seed(9, ["a", "b"]), seed(18, ["b", "a"]), seed(27, ["b"]), seed(100, ["c"]), seed(110, ["c"]), seed(120, ["c"])], []),
    ["b", "a", "c"],
    "support desc, then id asc",
  );
  const many = [];
  for (let i = 0; i < 30; i += 1) { const id = `id-${String(i).padStart(2, "0")}`; many.push(seed(i * 100, [id]), seed(i * 100 + 10, [id]), seed(i * 100 + 20, [id])); }
  const capped = nominateRareSeedCandidates(many, []);
  assert.equal(capped.length, RARE_SEED_MAX_CANDIDATES);
  assert.deepEqual(capped, [...Array(16).keys()].map((i) => `id-${String(i).padStart(2, "0")}`));
});

test("phraseAnyPresent: one OR query is true iff at least one of its phrases has an archive document", async () => {
  const q = tokens(`${distinctiveDoc(91000, 40)} ${COINCIDENCE_RUN} ${distinctiveDoc(91001, 20)} ${RUN_A} ${BOILER.split(" ").slice(0, 8).join(" ")}`);
  const phrases = [];
  for (let s = 0; s + 5 <= q.length; s += 1) phrases.push(q.slice(s, s + 5));
  for (let i = 0; i < phrases.length; i += 7) {
    for (const size of [1, 4, 16]) {
      const block = phrases.slice(i, i + size);
      const expected = (await Promise.all(block.map((p) => phraseSearch(client, p, 1)))).some((ids) => ids.length > 0);
      assert.equal(await phraseAnyPresent(client, block), expected, `block @${i} size ${size}`);
    }
  }
  assert.equal(await phraseAnyPresent(client, []), false);
});

test("v1 DF map preserved: v2 resolves exactly v1's grams to v1's values — short AND long submissions (so probes and phrase candidates are unchanged)", async () => {
  const cases = [
    { text: `${distinctiveDoc(91002, 120)} ${PASSAGE_EARLY} ${distinctiveDoc(91003, 60)} ${COMMON6} ${COINCIDENCE_RUN}`, matchedFrom: "run" },
    { text: TEXT_LATE_INSERT, matchedFrom: "none" },
    { text: `${SHORT_SPAN} ${distinctiveDoc(91004, 1500)} ${COMMON6} ${RUN_A}`, matchedFrom: "none" },
  ];
  for (const { text, matchedFrom } of cases) {
    const q = tokens(text);
    const matched = matchedFrom === "run" ? (await runMatcher(text)).m.archiveMatchedPositions : [];
    const v1 = await v1ResolveQueryGramDf(q, matched);
    const v2 = await resolveQueryGramDf(client, q, matched, { stopHashSet });
    assert.deepEqual(clamp21(v2), clamp21(v1.df));
    assert.deepEqual([...v2.keys()], [...v1.df.keys()], "same insertion order");
  }
});

test("an early short verbatim span in a long submission is still found (v1 coverage kept)", async () => {
  const text = `${distinctiveDoc(91005, 40)} ${SHORT_SPAN} ${distinctiveDoc(91006, 1500)}`;
  const { m } = await runMatcher(text);
  assert.ok(m.sources.some((s) => s.name === "Short Span Source"));
});

test("exact passages: early and late verbatim copies are found and equal Baseline B (the exhaustive oracle)", async () => {
  for (const [label, text, title] of [["early", TEXT_EARLY_EXACT, "Early Passage Source"], ["late", TEXT_LATE_EXACT, LATE_SRC]]) {
    const { m } = label === "early" ? early : late.exact;
    const b = await baselineB(client, text, { maximumDocumentFrequency: MDF, matchingParameters: MATCHING });
    assert.deepEqual(normalizeArchiveResult(m), normalizeArchiveResult(b), `${label}: equals Baseline B`);
    assert.ok(m.sources.some((s) => s.name === title && s.matchedWords >= 115), `${label}: the source scores the copied passage`);
  }
});

test("v1 document-order DF resolution never reaches a passage past token 800 (the defect this fixes); v2 does, within the bound", async () => {
  // matchedPositions = [] — what the primary (compact) pass produces here:
  // the host has no archive match and the edited passage shares no fingerprint.
  const q = tokens(TEXT_LATE_INSERT);
  const v1 = await v1ResolveQueryGramDf(q, []);
  assert.ok(LATE_START >= 800);
  assert.equal(v1.order.length, PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS, "v1 spends the whole budget");
  assert.ok(Math.max(...v1.order) < LATE_START, "every v1 check lands before the late passage");
  const v2 = await resolveQueryGramDfWithRareSeeds(client, q, [], { stopHashSet });
  assert.ok(v2.queries <= PHRASE_FALLBACK_DF_RESOLVE_MAX_CHECKS, `novel host text is group-tested cheaply (${v2.queries} queries)`);
  assert.ok(v2.rareSeeds.some((s) => s.position >= LATE_START && s.representationIds.includes(lateSrcId)), "v2 reaches the late passage");
});

test("late edited passages (insert 1/5, delete 1/8) are now discovered — by rare seeds, not by compact fingerprints or probes", async () => {
  for (const [label, text] of [["insert1per5", TEXT_LATE_INSERT], ["delete1per8", TEXT_LATE_DELETE]]) {
    assert.equal(await sharedFingerprints(text, lateSrcId), 0, `${label}: sanity — the edited passage shares no compact fingerprint with its source`);
    const common = { stopHashSet, bandByHash };
    const withSeeds = await phraseFallbackDiscovery(client, text, [], [], common);
    const withoutSeeds = await phraseFallbackDiscovery(client, text, [], [], { ...common, rareSeedMinSupport: Number.POSITIVE_INFINITY });
    assert.ok(withSeeds.rareSeedCandidateIds.includes(lateSrcId), `${label}: rare seeds nominate the source`);
    assert.ok(!withoutSeeds.unionCandidateIds.includes(lateSrcId), `${label}: the bounded phrase probes alone do not reach it`);
    assert.deepEqual(withSeeds.phraseCandidateIds, withoutSeeds.phraseCandidateIds, `${label}: rare seeds never change the probes' own candidates`);
  }
  assert.equal(fpSharedInsert, 0);
});

test("late edited passages: the source is retrieved and ONLY its exact verified tokens score", async () => {
  const insertLen = tokens(LATE_INSERT).length;
  const deleteLen = tokens(LATE_DELETE).length;
  for (const [label, run, text, len] of [["insert1per5", late.insert, TEXT_LATE_INSERT, insertLen], ["delete1per8", late.delete, TEXT_LATE_DELETE, deleteLen]]) {
    const { m, log } = run;
    assert.ok(m.archiveDiscovery.rareSeedCandidateCount >= 1, `${label}: a rare-seed candidate was added`);
    assert.ok(finalCandidateIds(log).includes(lateSrcId), `${label}: the source's canonical_text was retrieved`);
    const src = m.sources.find((s) => s.name === LATE_SRC);
    assert.ok(src && src.matchedWords > 0, `${label}: the verified source now contributes`);
    const q = tokens(text);
    for (const p of m.archiveMatchedPositions) {
      assert.ok(p >= LATE_START && p < LATE_START + len, `${label}: no host position scores`);
      assert.ok(!q[p].startsWith("ins"), `${label}: an inserted word is never scored`);
    }
    // The ONLY route to positions is the unchanged scorer over the retrieved set.
    const independent = await scoreOverIds(text, finalCandidateIds(log));
    assert.deepEqual(normalizeArchiveResult(m), normalizeArchiveResult(independent), `${label}: positions == scorer(retrieved candidates)`);
  }
  assert.equal(
    inPassage(late.delete.m.archiveMatchedPositions, LATE_START, deleteLen).length,
    deleteVerifiableWords,
    "delete1per8: every surviving copied token in a >= 5-word source run is verified, and nothing else",
  );
});

test("punctuation/whitespace-only edits do not regress: identical result to the verbatim late passage", async () => {
  assert.deepEqual(normalizeArchiveResult(late.punct.m), normalizeArchiveResult(late.exact.m));
});

test("clean negatives: zero rare-seed candidates and zero added verified positions", async () => {
  const clean = await runMatcher(`${HOST_A} ${HOST_B}`);
  assert.equal(clean.m.score, 0);
  assert.equal(clean.m.archiveMatchedPositions.length, 0);
  assert.equal(clean.m.archiveDiscovery.rareSeedCount, 0);
  assert.equal(clean.m.archiveDiscovery.rareSeedCandidateCount, 0);
  // Isolated generic coincidences with one archive document are rare seeds
  // but never nominate: one run, and two runs from one source, stay below 3.
  for (const text of [
    `${distinctiveDoc(92001, 150)} ${COINCIDENCE_RUN} ${distinctiveDoc(92002, 150)}`,
    `${distinctiveDoc(92003, 150)} ${RUN_A} ${distinctiveDoc(92004, 10)} ${RUN_B} ${distinctiveDoc(92005, 150)}`,
  ]) {
    const d = await phraseFallbackDiscovery(client, text, [], [], { stopHashSet, bandByHash, budget: 0 });
    assert.ok(d.rareSeedCount >= 1, "sanity: the coincidence is a rare seed");
    assert.deepEqual(d.rareSeedCandidateIds, []);
    const c = await runMatcher(text);
    assert.equal(c.m.archiveDiscovery.rareSeedCandidateCount, 0);
  }
});

test("generic/common phrases never become rare seeds, and nominations and queries stay capped", async () => {
  const generic = `${distinctiveDoc(93001, 40)} ${BOILER} ${distinctiveDoc(93002, 40)} ${COMMON6} ${distinctiveDoc(93003, 40)}`;
  const g = await resolveQueryGramDfWithRareSeeds(client, tokens(generic), [], { stopHashSet });
  assert.equal(g.rareSeeds.length, 0, "DF-15 (stop) and DF-6 grams are never rare seeds");
  const gd = await phraseFallbackDiscovery(client, generic, [], [], { stopHashSet, bandByHash });
  assert.deepEqual(gd.rareSeedCandidateIds, []);
  // 24 archive documents, each corroborated by three exact runs, every block
  // of the v1 region holding an archive 5-gram: the worst case for the
  // group-tested resolution.
  const parts = [];
  for (let i = 0; i < TRIPLE_COUNT; i += 1) parts.push(distinctiveDoc(1000 + i, 5), uniq(94000, i), distinctiveDoc(2000 + i, 5), uniq(95000, i), distinctiveDoc(3000 + i, 5), uniq(96000, i));
  const triples = parts.join(" ");
  const isolated = await phraseFallbackDiscovery(client, triples, [], [], { stopHashSet, bandByHash, budget: 0 });
  assert.equal(isolated.rareSeedCandidateIds.length, RARE_SEED_MAX_CANDIDATES, "more than 16 corroborated documents -> capped at 16");
  assert.ok(isolated.dfResolveQueries <= MAX_DF_RESOLVE_QUERIES, `worst-case DF-resolution queries ${isolated.dfResolveQueries} <= ${MAX_DF_RESOLVE_QUERIES}`);
  const { m, log } = await runMatcher(triples);
  assert.ok(m.archiveDiscovery.rareSeedCandidateCount <= RARE_SEED_MAX_CANDIDATES);
  assert.ok(ftsQueryCount(log) <= MAX_FTS_QUERIES, `FTS queries ${ftsQueryCount(log)} <= ${MAX_FTS_QUERIES}`);
});

test("a source nominated by rare seeds but not admissible to the scorer contributes zero; seed positions never reach the output", async () => {
  const text = `${distinctiveDoc(96001, 150)} ${RUN_A} ${distinctiveDoc(96002, 8)} ${RUN_B} ${distinctiveDoc(96003, 8)} ${RUN_C} ${distinctiveDoc(96004, 150)}`;
  const q = tokens(text);
  const threeRunsId = repIdByTitle.get("Three Runs Source");
  const isolated = await phraseFallbackDiscovery(client, text, [], [], { stopHashSet, bandByHash, budget: 0 });
  assert.deepEqual(isolated.rareSeedCandidateIds, [threeRunsId], "three non-overlapping DF-1 seeds in one window nominate it");
  const seedPositions = [RUN_A, RUN_B, RUN_C].map((run) => q.indexOf(tokens(run)[0]));

  // The scorer's own source admission (a 15-word source is < 10% of ~340 words) rejects it.
  const strict = { ...MATCHING, minimumSourceContribution: 10 };
  const { m, log } = await runMatcher(text, strict);
  assert.ok(finalCandidateIds(log).includes(threeRunsId), "it was retrieved");
  assert.equal(m.sources.length, 0);
  assert.deepEqual(m.archiveMatchedPositions, [], "zero contribution — no seed position scores on its own");
  for (const p of seedPositions) assert.ok(!m.archiveMatchedPositions.includes(p));
  assert.deepEqual(normalizeArchiveResult(m), normalizeArchiveResult(await scoreOverIds(text, finalCandidateIds(log), strict)));

  // Under the default admission the SAME verified exact tokens (and nothing else) score.
  const { m: admitted } = await runMatcher(text);
  assert.deepEqual(admitted.archiveMatchedPositions, seedPositions.flatMap((p) => [p, p + 1, p + 2, p + 3, p + 4]));
});

test("determinism: identical input -> identical rare seeds, nomination order and result", async () => {
  const q = tokens(TEXT_LATE_INSERT);
  const a = await resolveQueryGramDfWithRareSeeds(client, q, [], { stopHashSet });
  const b = await resolveQueryGramDfWithRareSeeds(client, q, [], { stopHashSet });
  assert.deepEqual(a.rareSeeds, b.rareSeeds);
  assert.deepEqual([...a.df], [...b.df]);
  assert.equal(a.queries, b.queries);
  const d1 = await phraseFallbackDiscovery(client, TEXT_LATE_INSERT, [], [], { stopHashSet, bandByHash });
  const d2 = await phraseFallbackDiscovery(client, TEXT_LATE_INSERT, [], [], { stopHashSet, bandByHash });
  assert.deepEqual(d1, d2);
  assert.deepEqual(late.insert.m, lateInsertRepeat.m);
  assert.deepEqual(finalCandidateIds(late.insert.log), finalCandidateIds(lateInsertRepeat.log));
});

test("bounds: a long submission stays within the DF-resolution and probe query bounds", async () => {
  const long = `${distinctiveDoc(97001, 3000)} ${LATE_INSERT} ${distinctiveDoc(97002, 500)}`;
  const { m, log } = await runMatcher(long);
  assert.ok(m.archiveDiscovery.dfResolveQueries <= MAX_DF_RESOLVE_QUERIES);
  assert.ok(ftsQueryCount(log) <= MAX_FTS_QUERIES, `FTS queries ${ftsQueryCount(log)}`);
  assert.ok(m.archiveDiscovery.phraseProbeCount <= PHRASE_FALLBACK_BUDGET);
  assert.ok(m.archiveDiscovery.rareSeedCandidateCount <= RARE_SEED_MAX_CANDIDATES);
});

test("position union unchanged: verified archive positions enter computeUnifiedSimilarity as-is", () => {
  const { m } = late.insert;
  const wordCount = tokens(TEXT_LATE_INSERT).length;
  const u = computeUnifiedSimilarity({ wordCount, archiveMatchedPositions: m.archiveMatchedPositions });
  assert.deepEqual(u.matchedPositions, m.archiveMatchedPositions);
  assert.equal(u.unifiedScore, Math.min(100, Math.round((m.archiveMatchedPositions.length / wordCount) * 100)));
});
