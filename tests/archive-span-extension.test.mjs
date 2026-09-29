import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { tokens, grams, gramHash, informativeGram, similarityScore } from "../lib/similarity-core.ts";
import { scoreAgainstArchive } from "../lib/archive-similarity-scoring.ts";
import { ARCHIVE_SHINGLE_SIZE, archiveShingleHashes } from "../lib/archive-fingerprint.ts";
import { ARCHIVE_FINGERPRINT_VERSION, seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus, ARCHIVE_MATCH_POLICY } from "../lib/archive-corpus-matching.ts";
import { loadDfBandMap, deriveStopHashSet } from "../lib/archive-df-bands.ts";
import { RARE_SEED_MAX_DF } from "../lib/archive-phrase-fallback.ts";
import { GENERIC_ACADEMIC_REGISTER_DENSITY_LIMIT } from "../lib/document-correspondence.ts";
import {
  SEED_EXTEND_ALIGNMENT_POLICY_VERSION,
  SEED_EXTEND_SEED_LENGTH,
  SEED_EXTEND_MAX_WINDOW_TOKENS_PER_SIDE,
  SEED_EXTEND_MAX_CONSECUTIVE_EDITS,
  SEED_EXTEND_RESYNC_TOKENS,
  SEED_EXTEND_MAX_EDIT_RATIO,
  SEED_EXTEND_MIN_EXACT_ALIGNED_TOKENS,
  SEED_EXTEND_MIN_DISTINCT_INFORMATIVE_WORDS,
  SEED_EXTEND_GENERIC_DENSITY_LIMIT,
  SEED_EXTEND_MIN_SCORED_ISLAND_LENGTH,
  SEED_EXTEND_MAX_ALIGNMENTS,
  alignAroundSeed,
  findSeedGrams,
  isInformativeAlignmentWord,
  seedExtendVerifiedPositions,
  verifyAlignment,
} from "../lib/seed-extend-alignment.ts";

/**
 * Bounded Archive tolerant verified-span extension (seed-extend-alignment-v1).
 * Alignment may tolerate small edits around an exact, rare, source-backed
 * seed; SCORING stays exact: only submission tokens exactly equal to the
 * aligned source token (inside an exact island >= 2) become positions, only
 * inside an admitted aligned passage, and only where an edit inside that
 * passage broke one of the token's 5-grams. The exact Archive path is
 * unchanged and runs first; the extension only adds positions from sources
 * the exact path already accepted, so a verbatim copy is byte-identical.
 * Synthetic fixtures only.
 */

// ══ fixtures (pure) ═════════════════════════════════════════════════════════
const SRC_BEFORE = "Field notes from the northern escarpment describe terraced orchards, abandoned cisterns and a narrow mule track that once connected hamlets to the weekly souk before the paved road bypassed them entirely in the late nineteen seventies.";
const PASSAGE =
  "Groundwater recharge beneath the Saharan piedmont was reconstructed from chloride profiles collected along twelve boreholes, and it was clear that most of it came from episodic flash floods rather than diffuse rainfall. " +
  "Fossil aquifer layers remained hydraulically isolated from the shallow alluvial system, so that in the end all of the modern recharge was confined to the upper horizon. " +
  "Isotopic signatures of deuterium and oxygen confirmed that palaeowater trapped beneath the evaporite crust predates the Holocene humid phase, which means that pumping from the deeper confined horizon effectively mines a nonrenewable reserve.";
const SRC_AFTER = "Later surveys by the provincial water agency recommended metering every private well and rotating extraction permits among neighbouring cooperatives during drought years, a proposal that farmers' unions contested for almost a decade.";
const SOURCE_TEXT = `${SRC_BEFORE} ${PASSAGE} ${SRC_AFTER}`;
const HOST_PRE = "Municipal libraries in coastal towns expanded evening opening hours after volunteers organised reading circles for retired dockworkers and their grandchildren every weekend.";
const HOST_POST = "Meanwhile a travelling puppet theatre toured village schools with adaptations of folk tales about clever foxes, stubborn camels and a greedy miller who lost his sacks of barley.";

const R = tokens(SOURCE_TEXT);
const P = tokens(PASSAGE);
const P_START = tokens(SRC_BEFORE).length; // passage offset inside the source
const HP = tokens(HOST_PRE);
const HQ = tokens(HOST_POST);
/** "every informative source 5-gram is rare" — the seed set the archive would
 *  supply if all these grams had archive DF 1..3. */
const allSourceSeeds = (words) => new Set(grams(words, 5).filter(informativeGram).map(gramHash));
const SEEDS = allSourceSeeds(R);
const INSERTS = ["notably", "moreover", "arguably", "crucially", "evidently", "admittedly", "incidentally", "seemingly"];
const SUBS = ["marmalade", "trombone", "zeppelin", "lighthouse", "harmonica", "saxophone", "porcupine", "tangerine"];
for (const w of [...INSERTS, ...SUBS]) assert.ok(!R.includes(w) && !HP.includes(w) && !HQ.includes(w), `${w} must be foreign to the texts`);

/**
 * Build a submission HOST_PRE + edited(P) + HOST_POST with per-token provenance.
 * kinds[i] is "orig" (with origin = source index) / "ins" / "sub" / "host".
 */
function edited(passageWords, { insertAfter = new Map(), deleteAt = new Set(), substituteAt = new Map() } = {}, { pre = HP, post = HQ } = {}) {
  const words = [];
  const kinds = [];
  const origin = [];
  const push = (w, k, o = null) => { words.push(w); kinds.push(k); origin.push(o); };
  pre.forEach((w) => push(w, "host"));
  passageWords.forEach((w, i) => {
    if (!deleteAt.has(i)) {
      if (substituteAt.has(i)) push(substituteAt.get(i), "sub");
      else push(w, "orig", P_START + i);
    }
    for (const x of insertAfter.get(i) ?? []) push(x, "ins");
  });
  post.forEach((w) => push(w, "host"));
  return { words, kinds, origin };
}
const every = (n, count, fn) => new Map([...Array(count).keys()].filter((i) => (i + 1) % n === 0).map((i) => [i, fn(i)]));
const run = (S, seeds = SEEDS, sources = [{ key: 0, words: R }], options) => seedExtendVerifiedPositions(S, sources, seeds, options);
const scoredOf = (S, seeds, sources, options) => run(S, seeds, sources, options).positionsBySource.get(0) ?? [];

/** The UNCHANGED exact Archive scorer against the single source (for "recovers more than exact"). */
function exactScorerPositions(submissionWords) {
  const sourceHashes = archiveShingleHashes(SOURCE_TEXT, 5);
  return scoreAgainstArchive(submissionWords.join(" "), {
    shingleSize: 5,
    documentCount: 1,
    maximumDocumentFrequency: 12,
    articles: [{ title: "src", sourceType: "Publication", uniqueShingleCount: sourceHashes.size }],
    getPostings: (hash) => (sourceHashes.has(hash) ? [0] : []),
  }, { minimumMatchedWords: 5 }).archiveMatchedPositions;
}

/** The scoring invariant, checked on every case: a scored position is an
 *  ORIGINAL copied token, exactly equal to its source token; nothing else. */
function assertOnlyExactSourceTokens(sub, scored, label) {
  for (const p of scored) {
    assert.equal(sub.kinds[p], "orig", `${label}: position ${p} (${sub.words[p]}) is ${sub.kinds[p]}, never scoreable`);
    assert.equal(sub.words[p], R[sub.origin[p]], `${label}: scored token equals its source token`);
  }
}
const origPositions = (sub) => sub.kinds.flatMap((k, i) => (k === "orig" ? [i] : []));
/** An edit broke one of p's 5-grams: some 5-token window containing p lies
 *  inside the copied passage (no host token) and holds an inserted /
 *  substituted token or a deletion point (consecutive copies not adjacent in
 *  the source). */
function editBroken(sub, p) {
  for (let s = p - 4; s <= p; s += 1) {
    if (s < 0 || s + 5 > sub.words.length) continue;
    const w = [...Array(5).keys()].map((k) => s + k);
    if (w.some((q) => sub.kinds[q] === "host")) continue;
    if (w.some((q) => sub.kinds[q] !== "orig")) return true;
    if (w.slice(1).some((q, k) => sub.origin[q] !== sub.origin[w[k]] + 1)) return true;
  }
  return false;
}
/** Recovery is not 100% by design. (a) A resync must be confirmed by two exact
 *  pairs holding an informative word, so a copied run of function words right
 *  after an edit ("... <edit> in the end all of <edit> ...") cannot be
 *  confirmed. (b) A token no edit broke keeps the exact path's own verdict.
 *  So every copied token missing from exact ∪ extension is either not
 *  edit-broken or a non-informative word — never an informative word an edit
 *  cut off. */
function assertMissesAreExplained(sub, union, label) {
  const unionSet = new Set(union);
  for (const p of origPositions(sub)) {
    if (unionSet.has(p) || !editBroken(sub, p)) continue;
    assert.ok(!isInformativeAlignmentWord(sub.words[p]), `${label}: missed edit-broken copied word "${sub.words[p]}" must be a non-informative word`);
  }
}
const unionWith = (exact, scored) => [...new Set([...exact, ...scored])].sort((l, r) => l - r);

const syn = (ns, n) => [...Array(n).keys()].map((i) => `zq${ns}x${i.toString(36)}v`); // informative, non-generic, unique

// All top-level DB setup and the shared matcher runs resolve BEFORE the first
// test() is registered (node:test runs a registered test immediately; an
// interleaved top-level await races it — CLIENT_CLOSED).
// ══ matcher integration (synthetic archive DB) ══════════════════════════════
const dbFile = path.join(process.cwd(), "test_archive_span_extension.db");
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
const COMMON_PASSAGE =
  "Cooperative dairies in the Tell plateau pooled refrigerated tanker routes so that in the end all of the small producers could reach the regional creamery before noon, " +
  "and it was clear that most of the savings came from shared fuel contracts rather than from any change in herd management or pasture rotation practices.";
const DISTINCT_TAIL = syn(40, 400).join(" ");
const ARCHIVE_DOCS = [
  { id: "span-src", title: "Saharan Recharge Source", body: `${SOURCE_TEXT} ${syn(41, 300).join(" ")}` },
  { id: "span-other", title: "Unrelated Archive Paper", body: `${syn(42, 500).join(" ")}` },
];
// Licence boilerplate in 15 archive documents (DF 15 > 12 -> archive stop set,
// like the real PLoS licence at DF 12-18). In one more it runs straight into
// distinctive text, so "... source are credited <distinctive>" is a DF-1 seed.
const LICENCE = "This is an open access article distributed under the terms of the Creative Commons Attribution License, which permits unrestricted use, distribution, and reproduction in any medium, provided the original author and source are credited.";
const LICENCE_TAIL = syn(70, 40);
for (let i = 0; i < 15; i += 1) ARCHIVE_DOCS.push({ id: `span-licence-${i}`, title: `Licence Carrier ${i}`, body: `${syn(110 + i, 200).join(" ")} ${LICENCE} ${syn(130 + i, 60).join(" ")}` });
ARCHIVE_DOCS.push({ id: "span-licence-src", title: "Licence Then Distinctive Source", body: `${syn(150, 200).join(" ")} ${LICENCE} ${LICENCE_TAIL.join(" ")}` });
for (let i = 0; i < 4; i += 1) ARCHIVE_DOCS.push({ id: `span-common-${i}`, title: `Common Passage Carrier ${i}`, body: `${syn(50 + i, 300).join(" ")} ${COMMON_PASSAGE} ${syn(60 + i, 200).join(" ")}` });
for (const [order, doc] of ARCHIVE_DOCS.entries()) {
  const r = await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.title, originalSimilarity: null, text: doc.body, archiveOrder: order }, {
    corpusVersion: "test-span-extension-v1",
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
async function runMatcher(text, extra = {}, matchingParameters = MATCHING) {
  const c = spy(client);
  const m = await matchAgainstArchiveCorpus(c, text, { maximumDocumentFrequency: MDF, matchingParameters, ...extra });
  return { m, log: c.log };
}
/** The UNCHANGED scorer over an explicit candidate set (verbatim port of scoreOverCandidates). */
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
const scoringFields = ({ archiveDiscovery: _d, archiveSpanExtension: _e, ...rest }) => rest;

const INSERT_COPY = edited(P, { insertAfter: every(5, P.length, (i) => [INSERTS[i % INSERTS.length]]) });
const TEXT_INSERT = INSERT_COPY.words.join(" ");
const insertRun = await runMatcher(TEXT_INSERT);
const insertExactOnly = await runMatcher(TEXT_INSERT, { spanExtension: false });
const insertRepeat = await runMatcher(TEXT_INSERT);
const DISTINCT_COPY = `${HOST_PRE} ${syn(41, 120).join(" ")} ${HOST_POST}`; // verbatim, all-informative copied words
const distinctRun = await runMatcher(DISTINCT_COPY);
const distinctExactOnly = await runMatcher(DISTINCT_COPY, { spanExtension: false });
const COMMON_COPY = edited(tokens(COMMON_PASSAGE), { insertAfter: every(5, tokens(COMMON_PASSAGE).length, () => [INSERTS[0]]) }).words.join(" ");
const commonRun = await runMatcher(COMMON_COPY);
const commonExactOnly = await runMatcher(COMMON_COPY, { spanExtension: false });
// the licence copied with one inserted word — boilerplate NEXT TO an edit
const LICENCE_EDITED = LICENCE.replace("the terms of the", `the terms ${INSERTS[0]} of the`);
const LICENCE_COPY = `${HOST_PRE} ${LICENCE_EDITED} ${LICENCE_TAIL[0]} ${HOST_POST}`;
const licenceRun = await runMatcher(LICENCE_COPY);
const licenceExactOnly = await runMatcher(LICENCE_COPY, { spanExtension: false });
// verbatim English copy WITH uninformative stretches ("so that in the end all of the ...")
const VERBATIM_COPY = `${HOST_PRE} ${PASSAGE} ${HOST_POST}`;
const verbatimRun = await runMatcher(VERBATIM_COPY);
const verbatimExactOnly = await runMatcher(VERBATIM_COPY, { spanExtension: false });

const verdictAt = (S, src, a, b, gate) => verifyAlignment(S, alignAroundSeed(S, src, a, b, { comparisons: 0 }), gate);

// ══ policy ══════════════════════════════════════════════════════════════════
test("policy: the audited numbers, unchanged", () => {
  assert.equal(SEED_EXTEND_ALIGNMENT_POLICY_VERSION, "seed-extend-alignment-v1");
  assert.equal(ARCHIVE_MATCH_POLICY.spanExtensionPolicyVersion, SEED_EXTEND_ALIGNMENT_POLICY_VERSION);
  assert.equal(SEED_EXTEND_SEED_LENGTH, ARCHIVE_SHINGLE_SIZE);
  assert.equal(SEED_EXTEND_MAX_WINDOW_TOKENS_PER_SIDE, 200);
  assert.equal(SEED_EXTEND_MAX_CONSECUTIVE_EDITS, 2);
  assert.equal(SEED_EXTEND_RESYNC_TOKENS, 2);
  assert.equal(SEED_EXTEND_MAX_EDIT_RATIO, 0.25);
  assert.equal(SEED_EXTEND_MIN_EXACT_ALIGNED_TOKENS, 12);
  assert.equal(SEED_EXTEND_MIN_DISTINCT_INFORMATIVE_WORDS, 4);
  assert.equal(SEED_EXTEND_GENERIC_DENSITY_LIMIT, 0.4);
  assert.equal(SEED_EXTEND_GENERIC_DENSITY_LIMIT, GENERIC_ACADEMIC_REGISTER_DENSITY_LIMIT);
  assert.equal(SEED_EXTEND_MIN_SCORED_ISLAND_LENGTH, 2);
  assert.equal(SEED_EXTEND_MAX_ALIGNMENTS, 512);
  assert.equal(RARE_SEED_MAX_DF, 3);
});

// ══ exact behaviour + recovery (pure) ═══════════════════════════════════════
test("exact verbatim passage: verified as evidence, but the extension contributes nothing", () => {
  const sub = edited(P);
  const v = verdictAt(sub.words, R, HP.length, P_START);
  assert.ok(v.admitted);
  assert.deepEqual(v.evidencePositions, origPositions(sub), "the whole copy is source-backed evidence");
  assert.deepEqual(v.scoredPositions, [], "no edit broke any 5-gram: the exact path's verdict stands");
  assert.equal(run(sub.words).positionsBySource.size, 0);
});

test("insertion 1-per-5 recovers exact neighbouring tokens the exact 5-gram path misses; inserted words never score", () => {
  const sub = edited(P, { insertAfter: every(5, P.length, (i) => [INSERTS[i % INSERTS.length]]) });
  const scored = scoredOf(sub.words);
  assertOnlyExactSourceTokens(sub, scored, "insert1per5");
  for (const p of scored) assert.ok(editBroken(sub, p), `contributed ${p} was edit-broken`);
  for (const [p, k] of sub.kinds.entries()) if (k === "ins") assert.ok(!scored.includes(p), "inserted token never scores");
  const exact = exactScorerPositions(sub.words);
  const union = unionWith(exact, scored);
  assertMissesAreExplained(sub, union, "insert1per5");
  assert.ok(union.length > exact.length, `extension recovers more than exact-only (${union.length} vs ${exact.length})`);
});

test("deletion 1-per-8 recovers exact neighbouring tokens; the deletion gap produces no position", () => {
  const sub = edited(P, { deleteAt: new Set([...Array(P.length).keys()].filter((i) => i % 8 === 7)) });
  const scored = scoredOf(sub.words);
  assertOnlyExactSourceTokens(sub, scored, "delete1per8");
  for (const p of scored) assert.ok(editBroken(sub, p));
  const exact = exactScorerPositions(sub.words);
  const union = unionWith(exact, scored);
  assertMissesAreExplained(sub, union, "delete1per8");
  assert.ok(union.length > exact.length, `extension recovers more than exact-only (${union.length} vs ${exact.length})`);
  assert.ok(union.length < P.length, "deleted source tokens never become positions");
});

test("substitution: the substituted word itself never scores, its exact neighbours do", () => {
  // "flash" -> substitute; its neighbours "episodic" / "floods rather" are informative
  const single = edited(P, { substituteAt: new Map([[26, SUBS[0]]]) });
  const scored = scoredOf(single.words);
  assertOnlyExactSourceTokens(single, scored, "single-substitution");
  const subPos = single.kinds.indexOf("sub");
  assert.ok(!scored.includes(subPos) && scored.includes(subPos - 1) && scored.includes(subPos + 1));
  for (const p of scored) assert.ok(Math.abs(p - subPos) <= 4, "only tokens whose 5-grams the substitution broke");

  const syn10 = edited(P, { substituteAt: every(10, P.length, (i) => SUBS[i % SUBS.length]) });
  const s10 = scoredOf(syn10.words);
  assertOnlyExactSourceTokens(syn10, s10, "syn10");
  for (const [p, k] of syn10.kinds.entries()) if (k === "sub") assert.ok(!s10.includes(p));
  const exact10 = exactScorerPositions(syn10.words);
  const union10 = unionWith(exact10, s10);
  assertMissesAreExplained(syn10, union10, "syn10");
  assert.ok(union10.length > exact10.length, "syn10 recovers more than exact-only");
  // a substitution followed by function words: "most" -> X, then "of it" cannot confirm alone
  const beforeFunctionWords = edited(P, { substituteAt: new Map([[20, SUBS[1]]]) });
  const sf = scoredOf(beforeFunctionWords.words);
  assertOnlyExactSourceTokens(beforeFunctionWords, sf, "substitution-before-function-words");
  assertMissesAreExplained(beforeFunctionWords, unionWith(exactScorerPositions(beforeFunctionWords.words), sf), "substitution-before-function-words");
});

test("alignment gaps never score: no X / I / D op position, and not the [start,end] range", () => {
  const sub = edited(P, {
    insertAfter: new Map([[10, [INSERTS[0], INSERTS[1]]], [40, [INSERTS[2]]]]),
    substituteAt: new Map([[25, SUBS[0]], [26, SUBS[1]], [60, SUBS[2]]]),
    deleteAt: new Set([50, 51, 80]),
  });
  const ops = alignAroundSeed(sub.words, R, HP.length, P_START, { comparisons: 0 });
  const verdict = verifyAlignment(sub.words, ops);
  assert.ok(verdict.admitted);
  const editPositions = new Set(ops.filter((o) => o.op !== "M" && o.a !== null).map((o) => o.a));
  assert.ok(editPositions.size > 0);
  for (const p of [...verdict.scoredPositions, ...verdict.evidencePositions]) assert.ok(!editPositions.has(p));
  assert.ok(ops.some((o) => o.op === "D"), "deletions are aligned as source-only ops");
  const start = Math.min(...verdict.scoredPositions);
  const end = Math.max(...verdict.scoredPositions);
  assert.ok(verdict.scoredPositions.length < end - start + 1, "the scored set is not the whole aligned range");
  assertOnlyExactSourceTokens(sub, verdict.scoredPositions, "mixed");
  assertOnlyExactSourceTokens(sub, verdict.evidencePositions, "mixed-evidence");
});

// ══ edit tolerance boundaries (pure) ═══════════════════════════════════════
// A 25-token copied head, a gap, then an 8-token copied tail. The gap sits
// before "episodic flash floods rather than", so every resync pair across it
// holds an informative word.
const HEAD = 25;
const TAIL = 8;
const bridgeCase = (gap) => edited(P.slice(0, HEAD + 3 + TAIL), gap);
const GAPS_TOLERATED = {
  "two insertions": { insertAfter: new Map([[HEAD - 1, [INSERTS[0], INSERTS[1]]]]) },
  "two substitutions": { substituteAt: new Map([[HEAD, SUBS[0]], [HEAD + 1, SUBS[1]]]) },
  "two deletions": { deleteAt: new Set([HEAD, HEAD + 1]) },
  "substitution + insertion": { substituteAt: new Map([[HEAD, SUBS[0]]]), insertAfter: new Map([[HEAD, [INSERTS[0]]]]) },
};
const GAPS_BREAKING = {
  "three insertions": { insertAfter: new Map([[HEAD - 1, [INSERTS[0], INSERTS[1], INSERTS[2]]]]) },
  "three substitutions": { substituteAt: new Map([[HEAD, SUBS[0]], [HEAD + 1, SUBS[1]], [HEAD + 2, SUBS[2]]]) },
  "three deletions": { deleteAt: new Set([HEAD, HEAD + 1, HEAD + 2]) },
  "two substitutions + insertion": { substituteAt: new Map([[HEAD, SUBS[0]], [HEAD + 1, SUBS[1]]]), insertAfter: new Map([[HEAD + 1, [INSERTS[0]]]]) },
};
const headOf = (sub) => origPositions(sub).filter((p) => sub.origin[p] < P_START + HEAD);
const tailOf = (sub) => origPositions(sub).slice(-TAIL);

test("two adjacent edits are tolerated: the alignment bridges them and recovers the tokens they cut off", () => {
  for (const [label, gap] of Object.entries(GAPS_TOLERATED)) {
    const sub = bridgeCase(gap);
    const v = verdictAt(sub.words, R, HP.length, P_START);
    assert.ok(v.admitted, label);
    assert.equal(v.maxConsecutiveEdits, 2, label);
    assert.ok(tailOf(sub).every((p) => v.evidencePositions.includes(p)), `${label}: the tail beyond the gap is part of the verified passage`);
    const scored = scoredOf(sub.words);
    assertOnlyExactSourceTokens(sub, scored, label);
    const head = headOf(sub);
    const firstAfterGap = origPositions(sub).find((p) => p > head[head.length - 1]);
    assert.ok(scored.includes(head[head.length - 1]) && scored.includes(firstAfterGap), `${label}: the tokens on both sides of the gap are recovered`);
    for (const p of scored) assert.ok(editBroken(sub, p), `${label}: ${p} was edit-broken`);
  }
});

test("three adjacent edits break the extension: nothing is bridged or contributed", () => {
  for (const [label, gap] of Object.entries(GAPS_BREAKING)) {
    const sub = bridgeCase(gap);
    const v = verdictAt(sub.words, R, HP.length, P_START);
    const head = headOf(sub);
    assert.deepEqual(v.evidencePositions, head, `${label}: the alignment stops at the break`);
    assert.deepEqual(v.scoredPositions, [], `${label}: the break is the alignment's end, not an in-passage edit`);
    assert.equal(run(sub.words).positionsBySource.size, 0, `${label}: the 8-token tail alone is below the 12-token floor`);
  }
});

test("leading and trailing edits sit outside the aligned passage: never scored, never an in-passage edit", () => {
  const lead = edited(P.slice(0, 30), { substituteAt: new Map([[0, SUBS[0]]]) });
  const vLead = verdictAt(lead.words, R, HP.length + 1, P_START + 1);
  assert.deepEqual(vLead.evidencePositions, origPositions(lead));
  assert.deepEqual(vLead.scoredPositions, []);
  assert.equal(run(lead.words).positionsBySource.size, 0);
  const trail = edited(P.slice(0, 30), { substituteAt: new Map([[29, SUBS[1]]]), insertAfter: new Map([[29, [INSERTS[0]]]]) });
  const ops = alignAroundSeed(trail.words, R, HP.length, P_START, { comparisons: 0 });
  assert.equal(ops[0].op, "M", "an alignment never starts on an edit");
  assert.equal(ops[ops.length - 1].op, "M", "nor ends on one");
  assert.deepEqual(verifyAlignment(trail.words, ops).evidencePositions, origPositions(trail));
  assert.equal(run(trail.words).positionsBySource.size, 0);
});

test("source / submission beginning and end: extension stops at the text bounds", () => {
  const src = tokens(PASSAGE);
  const atStart = [...src, ...HQ];
  const opsStart = alignAroundSeed(atStart, src, 0, 0, { comparisons: 0 });
  assert.equal(opsStart[0].a, 0);
  assert.deepEqual(verifyAlignment(atStart, opsStart).evidencePositions, [...src.keys()]);
  const atEnd = [...HP, ...src];
  const opsEnd = alignAroundSeed(atEnd, src, HP.length + 20, 20, { comparisons: 0 });
  assert.equal(opsEnd[opsEnd.length - 1].a, atEnd.length - 1);
  assert.deepEqual(verifyAlignment(atEnd, opsEnd).evidencePositions, [...src.keys()].map((i) => i + HP.length));
  // an edit right before the submission's end is still an in-passage edit
  const tailEdit = [...HP, ...src.slice(0, 40), INSERTS[0], ...src.slice(40, 44)];
  const s = seedExtendVerifiedPositions(tailEdit, [{ key: 0, words: src }], allSourceSeeds(src)).positionsBySource.get(0);
  assert.deepEqual(s.slice(-4), [0, 1, 2, 3].map((k) => HP.length + 41 + k), "the last copied tokens after the edit are recovered up to the end of the text");
});

test("repeated words and a duplicated source phrase align exactly", () => {
  const repeatedSrc = tokens("Nomadic herders moved their flocks very very slowly across the gravel plain toward the distant wells, resting often in the shade of acacia groves before the long climb to the summer pastures began again.");
  const drop = repeatedSrc.indexOf("very");
  const copy = [...HP, ...repeatedSrc.filter((_, i) => i !== drop), ...HQ];
  const v = verdictAt(copy, repeatedSrc, HP.length, 0);
  assert.equal(v.evidencePositions.length, repeatedSrc.length - 1, "every surviving copied token aligns exactly once");
  const ops = alignAroundSeed(copy, repeatedSrc, HP.length, 0, { comparisons: 0 });
  for (const o of ops) if (o.op === "M") assert.equal(copy[o.a], repeatedSrc[o.b]);
  assert.ok(ops.some((o) => o.op === "D"), "the dropped repetition is a deletion");
  const scored = seedExtendVerifiedPositions(copy, [{ key: 0, words: repeatedSrc }], allSourceSeeds(repeatedSrc)).positionsBySource.get(0);
  assert.ok(scored.length > 0 && scored.every((p) => Math.abs(p - (HP.length + drop)) <= 4));

  // the source holds PHRASE twice; the copy STARTS with the phrase (its first seeds
  // anchor at the phrase's first, wrong, occurrence and are rejected) and carries
  // an insertion later on
  const PHRASE = tokens("the cooperative granary ledger recorded barley");
  const D = tokens("shortfalls whenever caravans failed to reach the oasis market in autumn.");
  const dupSrc = [...tokens("Early harvest accounts open with"), ...PHRASE, ...tokens("before winter storms flooded the lower terraces entirely."), ...tokens("Much later travellers noted that"), ...PHRASE, ...D];
  const copied = [...PHRASE, ...D.slice(0, 4), INSERTS[0], ...D.slice(4)];
  const sub = [...HP, ...copied, ...HQ];
  const out = seedExtendVerifiedPositions(sub, [{ key: 0, words: dupSrc }], allSourceSeeds(dupSrc));
  assert.ok(out.stats.alignments > out.stats.admittedAlignments, "seeds anchored at the wrong occurrence were tried and rejected");
  const base = HP.length + PHRASE.length;
  assert.deepEqual(out.positionsBySource.get(0), [0, 1, 2, 3, 5, 6, 7, 8].map((k) => base + k), "exactly the tokens on both sides of the insertion");
});

test("punctuation / whitespace edits are tokens() normalisation — alignment and contributions are unchanged", () => {
  const plain = edited(P, { insertAfter: every(9, P.length, () => [INSERTS[3]]) });
  const punctText = plain.words.map((w, i) => (i % 7 === 3 ? `(${w}),` : i % 11 === 5 ? `"${w}";` : w)).map((w, i) => w + (i % 9 === 8 ? "\r\n" : i % 4 === 1 ? "\t " : "  ")).join("").trim();
  const S = tokens(punctText);
  assert.deepEqual(S, plain.words);
  assert.deepEqual(scoredOf(S), scoredOf(plain.words));
  assert.ok(scoredOf(S).length > 0);
});

// ══ admission controls (pure) ═══════════════════════════════════════════════
test("only exact islands of length >= 2 score, and only next to an in-passage edit", () => {
  const S = syn(1, 20);
  const ops = [
    ...[0, 1, 2, 3, 4, 5, 6].map((k) => ({ op: "M", a: k, b: k })),
    { op: "I", a: 7, b: null },
    { op: "M", a: 8, b: 7 }, // isolated exact pair — never scores
    { op: "X", a: 9, b: 8 },
    ...[10, 11, 12, 13, 14, 15, 16, 17].map((k) => ({ op: "M", a: k, b: k - 1 })),
  ];
  const v = verifyAlignment(S, ops);
  assert.ok(!v.evidencePositions.includes(8) && !v.scoredPositions.includes(8), "an island of 1 never scores");
  assert.deepEqual(v.evidencePositions, [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(v.scoredPositions, [3, 4, 5, 6, 10, 11, 12, 13], "within 4 tokens of an edit");
  assert.equal(v.exactPairs, 16);
});

test(">= 12 exact aligned tokens: 11 is rejected, 12 is admitted", () => {
  const src = syn(2, 60);
  const seeds = allSourceSeeds(src);
  for (const [n, admitted] of [[11, false], [12, true]]) {
    const S = [...syn(3, 30), ...src.slice(10, 16), INSERTS[0], ...src.slice(16, 10 + n), ...syn(4, 30)];
    const v = verdictAt(S, src, 30, 10);
    assert.equal(v.evidencePositions.length, n);
    assert.equal(v.admitted, admitted, `n=${n}`);
    const out = seedExtendVerifiedPositions(S, [{ key: 0, words: src }], seeds);
    assert.equal(out.positionsBySource.size, admitted ? 1 : 0, `n=${n}`);
    if (admitted) assert.deepEqual(out.positionsBySource.get(0), v.scoredPositions);
  }
});

test(">= 4 distinct informative words: a 15-token copy with 3 is rejected, with 4 admitted", () => {
  const three = tokens("zqaa zqbb zqcc of the zqaa zqbb zqcc of the zqaa zqbb zqcc of the");
  const four = tokens("zqaa zqbb zqcc of the zqaa zqbb zqdd of the zqaa zqbb zqcc of the");
  for (const [label, core, admitted] of [["three", three, false], ["four", four, true]]) {
    const src = [...syn(5, 20), ...core, ...syn(6, 20)];
    const S = [...syn(7, 20), ...core.slice(0, 6), INSERTS[1], ...core.slice(6), ...syn(8, 20)];
    const v = verdictAt(S, src, 20, 20);
    assert.equal(v.evidencePositions.length, 15, `${label}: 15 exact aligned tokens either way`);
    assert.equal(v.distinctInformativeWords, label === "three" ? 3 : 4);
    assert.equal(v.admitted, admitted, label);
    assert.equal(seedExtendVerifiedPositions(S, [{ key: 0, words: src }], allSourceSeeds(src)).positionsBySource.size, admitted ? 1 : 0, label);
  }
  assert.equal(isInformativeAlignmentWord("2019"), false, "numbers are not informative words");
  assert.equal(isInformativeAlignmentWord("with"), false, "COMMON_WORDS are not informative words");
});

test("edit ratio <= 0.25 is enforced (exactly 0.25 admitted, above rejected)", () => {
  const src = syn(9, 80);
  const seeds = new Set([gramHash(src.slice(10, 15).join(" "))]); // one seed only
  const build = (gaps) => {
    const S = [...syn(10, 20), ...src.slice(10, 15)];
    let b = 15;
    for (let g = 0; g < gaps; g += 1) { S.push(`zqins${g}w`); S.push(src[b], src[b + 1]); b += 2; }
    return [...S, ...syn(11, 20)];
  };
  const at = build(5); // 15 exact pairs, 5 insertions => 5 / 20 = 0.25
  const vAt = verdictAt(at, src, 20, 10);
  assert.equal(vAt.editRatio, 0.25);
  assert.ok(vAt.admitted);
  assert.deepEqual(seedExtendVerifiedPositions(at, [{ key: 0, words: src }], seeds).positionsBySource.get(0), vAt.scoredPositions);
  assert.equal(vAt.scoredPositions.length, 14, "every exact pair except the seed's first token, which no edit touches");
  const over = build(6); // 17 exact pairs, 6 insertions => 6 / 23 > 0.25
  const vOver = verdictAt(over, src, 20, 10);
  assert.ok(vOver.editRatio > 0.25);
  assert.ok(!vOver.admitted);
  assert.equal(seedExtendVerifiedPositions(over, [{ key: 0, words: src }], seeds).positionsBySource.size, 0);
});

test("generic academic-register density < 0.4 is enforced", () => {
  const generic = tokens("This paper presents the findings of the present study using standard analysis within the broader research scope of the discussion section.");
  const src = [...syn(12, 20), ...generic, ...syn(13, 20)];
  const S = [...syn(14, 20), ...generic.slice(0, 11), INSERTS[2], ...generic.slice(11), ...syn(15, 20)];
  const v = verdictAt(S, src, 20, 20);
  assert.ok(v.evidencePositions.length >= 12 && v.editRatio <= 0.25 && v.distinctInformativeWords >= 4, "every other control passes");
  assert.ok(v.genericDensity >= 0.4, `density ${v.genericDensity}`);
  assert.ok(!v.admitted);
  assert.equal(seedExtendVerifiedPositions(S, [{ key: 0, words: src }], allSourceSeeds(src)).positionsBySource.size, 0);
});

test("gram-frequency gate: a token whose every exact aligned 5-gram is gated is not evidence and never scores", () => {
  // distinctive 10 + archive-common stretch (13 tokens) + distinctive 10, copied verbatim
  const common = tokens("in the context of the present economic and social situation of the country");
  const src = [...syn(23, 30), ...syn(24, 10), ...common, ...syn(25, 10), ...syn(26, 30)];
  const S = [...syn(27, 10), ...syn(24, 10), ...common, ...syn(25, 10), ...syn(28, 10)];
  const gated = new Set(grams(common, 5).map(gramHash)); // windows fully inside the common stretch
  const ops = alignAroundSeed(S, src, 10, 30, { comparisons: 0 });
  const ungated = verifyAlignment(S, ops);
  const v = verifyAlignment(S, ops, (h) => gated.has(h));
  assert.equal(ungated.evidencePositions.length, 10 + common.length + 10);
  assert.ok(v.admitted, "the distinctive evidence still admits the passage");
  // positions 20..32 are the common stretch; only those covered solely by gated windows drop
  const interior = [...Array(common.length - 8).keys()].map((k) => 20 + 4 + k);
  for (const p of interior) assert.ok(!v.evidencePositions.includes(p), `interior common token ${p} is gated`);
  assert.equal(v.frequencyGatedPositions, interior.length);
  const L = common.length;
  for (const p of [20, 21, 22, 23, 20 + L - 4, 20 + L - 3, 20 + L - 2, 20 + L - 1]) assert.ok(v.evidencePositions.includes(p), `edge token ${p} is covered by a window reaching distinctive text`);

  // a rare seed at the edge of archive-common boilerplate — WITH an edit inside the
  // boilerplate — cannot admit the boilerplate
  const licence = tokens("This is an open access article distributed under the terms of the Creative Commons Attribution License, which permits unrestricted use, distribution, and reproduction in any medium, provided the original author and source are credited.");
  const lsrc = [...syn(29, 30), ...licence, ...syn(30, 30)];
  const cut = licence.indexOf("terms") + 1;
  const lsub = [...syn(31, 10), ...licence.slice(0, cut), INSERTS[0], ...licence.slice(cut), syn(30, 1)[0], ...syn(32, 10)];
  const lgated = new Set(grams(licence, 5).map(gramHash));
  const seedAt = 10 + licence.length + 1 - 4; // "source are credited <distinctive>" — rare
  const seedSet = new Set([gramHash(lsub.slice(seedAt, seedAt + 5).join(" "))]);
  const without = seedExtendVerifiedPositions(lsub, [{ key: 0, words: lsrc }], seedSet);
  assert.ok((without.positionsBySource.get(0)?.length ?? 0) > 0, "without the gate the boilerplate around the edit would be contributed");
  const withGate = seedExtendVerifiedPositions(lsub, [{ key: 0, words: lsrc }], seedSet, { isFrequencyGatedGram: (h) => lgated.has(h) });
  assert.equal(withGate.stats.admittedAlignments, 0, "with the gate: 5 evidence tokens < 12, nothing admitted");
  assert.equal(withGate.positionsBySource.size, 0);
  // short islands (< 5) have no aligned 5-gram: judged by the passage controls alone
  const shortIslands = verifyAlignment(S, [{ op: "M", a: 0, b: 0 }, { op: "M", a: 1, b: 1 }, { op: "I", a: 2, b: null }, { op: "M", a: 3, b: 2 }, { op: "M", a: 4, b: 3 }], () => true);
  assert.deepEqual(shortIslands.evidencePositions, [0, 1, 3, 4]);
  assert.deepEqual(shortIslands.scoredPositions, [0, 1, 3, 4]);
});

test("seed gate: a seed must be an informative 5-gram in the trusted (rare) seed set", () => {
  const sub = edited(P, { insertAfter: every(5, P.length, (i) => [INSERTS[i % INSERTS.length]]) });
  assert.equal(findSeedGrams(sub.words, new Set()).length, 0);
  assert.equal(run(sub.words, new Set()).positionsBySource.size, 0, "no trusted seed => no extension at all");
  // an uninformative gram is never a seed, even when it is in the set
  const uninformative = grams(sub.words, 5).find((g) => !informativeGram(g));
  assert.ok(uninformative);
  assert.equal(findSeedGrams(sub.words, new Set([gramHash(uninformative)])).length, 0);
  // a single trusted seed ("shallow alluvial system so that") verifies far beyond its own 5 words
  const one = new Set([gramHash(P.slice(40, 45).join(" "))]);
  const seeds = findSeedGrams(sub.words, one);
  assert.equal(seeds.length, 1);
  const scored = scoredOf(sub.words, one);
  assertOnlyExactSourceTokens(sub, scored, "single-seed");
  assert.ok(scored.some((p) => p < seeds[0].position - 20), "tokens well before the seed are recovered from it");
});

test("clean generic phrases and a generic phrase followed by unrelated prose never gain positions", () => {
  const phrases = ["it is important to note that the results of this study", "on the other hand the findings of the present study suggest that", "within the framework of the present research further analysis"];
  const genericSrc = tokens(`${SRC_BEFORE} ${phrases.join(". ")}. ${SRC_AFTER}`);
  for (const phrase of phrases) {
    const words = tokens(phrase);
    for (const S of [tokens(`${HOST_PRE} ${phrase} ${HOST_POST}`), [...HP, ...words.slice(0, 6), INSERTS[4], ...words.slice(6), ...HQ]]) {
      assert.equal(seedExtendVerifiedPositions(S, [{ key: 0, words: genericSrc }], allSourceSeeds(genericSrc)).positionsBySource.size, 0, phrase);
    }
  }
});

test("two nearby unrelated exact islands are never bridged", () => {
  for (const gapTokens of [0, 1, 2, 3]) {
    const S = [...HP, ...P.slice(5, 13), ...INSERTS.slice(0, gapTokens), ...P.slice(60, 68), ...HQ];
    const v = verdictAt(S, R, HP.length, P_START + 5);
    assert.deepEqual(v.evidencePositions, [...Array(8).keys()].map((k) => HP.length + k), `gap ${gapTokens}: the alignment ends with the first island`);
    assert.equal(run(S).positionsBySource.size, 0, `gap ${gapTokens}: two 8-token islands from different source offsets stay separate (< 12 each)`);
  }
});

test("overlapping seeds reaching the same passage deduplicate; a long passage is covered by bounded windows", () => {
  const withInserts = (words, tag) => words.flatMap((w, i) => ((i + 1) % 5 === 0 ? [w, `zqins${tag}${i}w`] : [w]));
  const passage = syn(20, 100);
  const S = [...syn(21, 10), ...withInserts(passage, "a"), ...syn(22, 10)];
  const out = seedExtendVerifiedPositions(S, [{ key: 0, words: passage }], allSourceSeeds(passage));
  assert.equal(out.stats.admittedAlignments, 1, "one admitted alignment covers the passage; later seeds inside it are skipped");
  assert.equal(out.stats.alignments, 1);
  assert.ok(out.stats.seedPositions > 1);
  const scored = out.positionsBySource.get(0);
  const copiedAt = (words) => words.flatMap((w, i) => (passage.includes(w) ? [i] : []));
  assert.deepEqual(scored, copiedAt(S).slice(1, -1), "every copied token once, except the first and last, whose own 5-gram no edit broke");

  const long = syn(16, 700);
  const longCopy = [...syn(17, 10), ...withInserts(long, "b"), ...syn(18, 10)];
  const all = seedExtendVerifiedPositions(longCopy, [{ key: 0, words: long }], allSourceSeeds(long));
  const longAt = longCopy.flatMap((w, i) => (long.includes(w) ? [i] : []));
  assert.deepEqual(all.positionsBySource.get(0), longAt.slice(1, -1), "every copied token exactly once across overlapping windows");
  assert.ok(all.stats.admittedAlignments >= 2, "more than one bounded window was needed");
});

test("bounded: one seed never aligns more than 200 tokens per side; alignments are capped", () => {
  const long = syn(19, 1000);
  const seedAt = 500;
  const stats = { comparisons: 0 };
  const v = verifyAlignment(long, alignAroundSeed(long, long, seedAt, seedAt, stats));
  assert.equal(v.evidencePositions[0], seedAt - SEED_EXTEND_MAX_WINDOW_TOKENS_PER_SIDE);
  assert.equal(v.evidencePositions[v.evidencePositions.length - 1], seedAt + 4 + SEED_EXTEND_MAX_WINDOW_TOKENS_PER_SIDE);
  assert.equal(v.evidencePositions.length, 2 * SEED_EXTEND_MAX_WINDOW_TOKENS_PER_SIDE + 5);
  assert.ok(stats.comparisons <= 2 * SEED_EXTEND_MAX_WINDOW_TOKENS_PER_SIDE * (1 + 2 * 9));
  const capped = seedExtendVerifiedPositions(tokens(`${HOST_PRE} ${PASSAGE}`), [{ key: 0, words: R }], SEEDS, { maxAlignments: 0 });
  assert.equal(capped.stats.alignments, 0);
  assert.equal(capped.stats.truncated, true);
});

test("deterministic: identical input, identical result", () => {
  const sub = edited(P, { insertAfter: every(5, P.length, (i) => [INSERTS[i % 8]]), substituteAt: new Map([[33, SUBS[3]]]) });
  const a = run(sub.words);
  const b = run(sub.words);
  assert.deepEqual([...a.positionsBySource], [...b.positionsBySource]);
  assert.deepEqual(a.stats, b.stats);
});

// ══ matcher integration (synthetic archive DB) ══════════════════════════════
test("matcher: the exact-only path is still independently available and is the unchanged scorer over the retrieved set", async () => {
  const ids = finalCandidateIds(insertExactOnly.log);
  const reference = await scoreOverIds(TEXT_INSERT, ids);
  assert.deepEqual(scoringFields(insertExactOnly.m), reference);
  assert.equal(insertExactOnly.m.archiveSpanExtension.enabled, false);
  assert.equal(insertExactOnly.m.archiveSpanExtension.addedPositionCount, 0);
});

test("matcher: exact behaviour is byte/position-identical for verbatim copies (with or without uninformative stretches)", () => {
  assert.ok(verbatimRun.m.archiveSpanExtension.admittedAlignmentCount >= 1, "the verbatim copy WAS verified by the extension");
  assert.ok(verbatimExactOnly.m.archiveMatchedPositions.length < P.length, "the exact path leaves uninformative copied stretches unscored");
  assert.deepEqual(scoringFields(verbatimRun.m), scoringFields(verbatimExactOnly.m), "…and the extension leaves them that way: no edit broke them");
  assert.equal(verbatimRun.m.archiveSpanExtension.addedPositionCount, 0);
  assert.ok(distinctExactOnly.m.archiveMatchedPositions.length >= 120);
  assert.deepEqual(scoringFields(distinctRun.m), scoringFields(distinctExactOnly.m));
});

test("matcher: insert-1-per-5 copy — the extension adds only exact, edit-broken copied tokens on top of the exact result", () => {
  const exact = insertExactOnly.m.archiveMatchedPositions;
  const final = insertRun.m.archiveMatchedPositions;
  assert.ok(exact.length > 0, "the exact path verified the source");
  assert.ok(exact.every((p) => final.includes(p)), "every exact position is kept");
  const added = final.filter((p) => !exact.includes(p));
  assert.ok(added.length > 0, "the extension recovered exact neighbouring tokens");
  for (const p of added) assert.ok(editBroken(INSERT_COPY, p), `added ${p} was edit-broken`);
  assert.equal(insertRun.m.archiveSpanExtension.addedPositionCount, added.length);
  assertOnlyExactSourceTokens(INSERT_COPY, final, "matcher-insert");
  // headline math is the same unique-positions formula
  assert.equal(insertRun.m.matchedWordCount, final.length);
  assert.equal(insertRun.m.score, similarityScore(final.length, insertRun.m.wordCount));
  assert.equal(insertExactOnly.m.score, similarityScore(exact.length, insertExactOnly.m.wordCount));
  assert.equal(insertRun.m.sources.reduce((t, s) => t + s.matchedWords, 0), insertRun.m.matchedWordCount);
  assert.deepEqual(insertRun.m.sources.map((s) => s.name), insertExactOnly.m.sources.map((s) => s.name), "same contributing sources");
  for (const [i, s] of insertRun.m.sources.entries()) {
    assert.equal(s.matches, insertExactOnly.m.sources[i].matches);
    assert.deepEqual(s.phrases, insertExactOnly.m.sources[i].phrases, "phrases stay exact-span derived");
  }
});

test("matcher: discovery is untouched — same candidate set, same discovery diagnostics, no extra query", () => {
  assert.deepEqual(finalCandidateIds(insertRun.log), finalCandidateIds(insertExactOnly.log));
  assert.deepEqual(insertRun.m.archiveDiscovery, insertExactOnly.m.archiveDiscovery);
  assert.equal(insertRun.log.length, insertExactOnly.log.length, "the extension issues no query");
  assert.ok(finalCandidateIds(insertRun.log).includes(repIdByTitle.get("Saharan Recharge Source")));
});

test("matcher: an existing exact 5-word match is unchanged (below the aligned-passage floor)", async () => {
  const five = syn(41, 60).slice(20, 25).join(" ");
  const text = `${HOST_PRE} ${five} ${HOST_POST}`;
  const a = await runMatcher(text);
  const b = await runMatcher(text, { spanExtension: false });
  assert.equal(b.m.archiveMatchedPositions.length, 5, "the ordinary 5-word floor still admits it");
  assert.deepEqual(scoringFields(a.m), scoringFields(b.m));
});

test("matcher: rare seed required — a passage in 4 archive documents (DF 4 > 3) is never extended", () => {
  assert.ok(commonExactOnly.m.archiveMatchedPositions.length > 0, "the exact path still scores its exact 5-runs");
  assert.deepEqual(scoringFields(commonRun.m), scoringFields(commonExactOnly.m));
  assert.equal(commonRun.m.archiveSpanExtension.addedPositionCount, 0);
});

test("matcher: archive-common licence boilerplate next to a rare seed and an edit is never extended (frequency gate kept)", () => {
  assert.equal(licenceExactOnly.m.archiveMatchedPositions.length, 5, "the exact path scores only the DF-1 5-gram crossing out of the boilerplate");
  assert.ok(licenceRun.m.archiveSpanExtension.alignmentCount >= 1, "the rare seed did launch an alignment");
  assert.equal(licenceRun.m.archiveSpanExtension.admittedAlignmentCount, 0);
  assert.deepEqual(scoringFields(licenceRun.m), scoringFields(licenceExactOnly.m));
});

test("matcher: self-exclusion and the source minimum are unchanged — excluded / rejected sources are never extended", async () => {
  const whole = edited(tokens(ARCHIVE_DOCS[0].body), { insertAfter: every(40, tokens(ARCHIVE_DOCS[0].body).length, () => [INSERTS[1]]) }, { pre: [], post: [] }).words.join(" ");
  const self = await runMatcher(whole);
  const selfExact = await runMatcher(whole, { spanExtension: false });
  assert.ok(self.m.excludedDocuments >= 1);
  assert.deepEqual(scoringFields(self.m), scoringFields(selfExact.m));
  const strict = { ...MATCHING, minimumSourceContribution: 90 };
  const minA = await runMatcher(TEXT_INSERT, {}, strict);
  const minB = await runMatcher(TEXT_INSERT, { spanExtension: false }, strict);
  assert.equal(minB.m.archiveMatchedPositions.length, 0);
  assert.deepEqual(scoringFields(minA.m), scoringFields(minB.m));
});

test("matcher: non-raw source weighting keeps the exact result (score identity holds only for raw)", async () => {
  const containmentWeighted = { ...MATCHING, sourceWeighting: "containment" };
  const a = await runMatcher(TEXT_INSERT, {}, containmentWeighted);
  const b = await runMatcher(TEXT_INSERT, { spanExtension: false }, containmentWeighted);
  assert.equal(a.m.archiveSpanExtension.enabled, false);
  assert.deepEqual(scoringFields(a.m), scoringFields(b.m));
});

test("matcher: co-source expansion flag on — the returned result is extended the same way", async () => {
  const previous = process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
  process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED = "true";
  try {
    const on = await runMatcher(TEXT_INSERT);
    assert.deepEqual(on.m.archiveMatchedPositions, insertRun.m.archiveMatchedPositions);
    assert.ok(on.m.archiveDiscovery.cosource);
  } finally {
    if (previous === undefined) delete process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
    else process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED = previous;
  }
});

test("matcher: deterministic repeat", () => {
  assert.deepEqual(insertRepeat.m, insertRun.m);
  assert.deepEqual(finalCandidateIds(insertRepeat.log), finalCandidateIds(insertRun.log));
});

// ══ other source classes stay exact / untouched ═════════════════════════════
test("only the Archive matcher imports the extension; imported evidence and prior submissions stay exact-only", () => {
  const root = path.join(process.cwd(), "lib");
  const importers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && /seed-extend-alignment/.test(fs.readFileSync(p, "utf8"))) importers.push(path.relative(root, p).replace(/\\/g, "/"));
    }
  };
  walk(root);
  assert.deepEqual(importers.sort(), ["archive-corpus-matching.ts", "seed-extend-alignment.ts"]);
  for (const f of ["imported-similarity-evidence/matcher.ts", "report-historical-match.ts", "user-submission-corpus.ts", "user-supplied-references.ts", "selective-corpus-authoritative.ts", "unified-similarity.ts", "similarity-enrichment.ts"]) {
    assert.ok(!/from\s+["'][^"']*(seed-extend-alignment|archive-corpus-matching)["']/.test(fs.readFileSync(path.join(root, f), "utf8")), `${f} does not import the extension or the Archive matcher`);
  }
});
