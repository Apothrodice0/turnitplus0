import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { tokens, grams, gramHash } from "../lib/similarity-core.ts";
import {
  computeArchiveFingerprint,
  winnow,
  archiveShingleHashes,
  WINNOW_WINDOW,
  FINGERPRINT_SHINGLE_SIZE,
  MAX_FINGERPRINTS_PER_DOCUMENT,
  ARCHIVE_COMPACT_FINGERPRINT_VERSION,
} from "../lib/archive-fingerprint.ts";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";
import { PHRASE_FALLBACK_BUDGET, PHRASE_FALLBACK_FANOUT_GATE } from "../lib/archive-phrase-fallback.ts";
import { MIN_PERSISTED_DF } from "../lib/archive-df-bands.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { baselineB, normalizeArchiveResult } from "./helpers/archive-baseline-b.mjs";

/**
 * 100k-scale architecture, slice 2B — the permanent regression suite for the
 * scalable archive matcher. Synthetic fixtures only (corpus/ is gitignored),
 * so this runs anywhere including CI. The real 321-document Baseline-B parity
 * (11/11, 7/7, 14/14) lives in tests/archive-corpus-real.local.test.mjs,
 * which skips when corpus/ is absent.
 */

// ── deterministic synthetic text ───────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Globally-unique, informative (len>=5, not COMMON_WORDS) tokens. */
const uniq = (ns, i) => `zx${ns}q${i.toString(36)}w`;
function distinctiveDoc(ns, wordCount) {
  const w = [];
  for (let i = 0; i < wordCount; i += 1) w.push(uniq(ns, i));
  return w.join(" ");
}
/** ns-namespaced filler that still varies (so winnowing has a real sequence). */
function filler(ns, wordCount, seed) {
  const rand = mulberry32(seed);
  const w = [];
  for (let i = 0; i < wordCount; i += 1) w.push(`fl${ns}k${Math.floor(rand() * wordCount).toString(36)}z`);
  return w.join(" ");
}

// ══════════════════════════════════════════════════════════════════════════
// UNIT — no database
// ══════════════════════════════════════════════════════════════════════════

test("fingerprint: deterministic — same canonical text twice yields the identical fingerprint set", () => {
  const text = `${distinctiveDoc(1, 400)} ${filler(1, 400, 7)}`;
  const a = computeArchiveFingerprint(text);
  const b = computeArchiveFingerprint(text);
  assert.deepEqual(
    a.fingerprints.map((f) => f.hash).sort(),
    b.fingerprints.map((f) => f.hash).sort(),
    "fingerprint hash set must be byte-identical across runs",
  );
  assert.equal(a.rawGramCount, b.rawGramCount);
  assert.equal(a.trimmedByHardCap, b.trimmedByHardCap);
});

test("fingerprint: hard cap — a pathologically long document never exceeds MAX_FINGERPRINTS_PER_DOCUMENT", () => {
  const veryLong = filler(2, 60_000, 42); // ~60k words → far past the cap's natural trigger
  const fp = computeArchiveFingerprint(veryLong);
  assert.ok(fp.fingerprints.length <= MAX_FINGERPRINTS_PER_DOCUMENT, `got ${fp.fingerprints.length} fingerprints, cap is ${MAX_FINGERPRINTS_PER_DOCUMENT}`);
  assert.equal(fp.trimmedByHardCap, true, "a 60k-word document must trip the hard-cap trim");
  // the trim is deterministic (lowest-hash-first), so two runs agree exactly
  assert.deepEqual(fp.fingerprints.map((f) => f.hash), computeArchiveFingerprint(veryLong).fingerprints.map((f) => f.hash));
});

test("fingerprint: winnow selects the rightmost minimum and never the same position twice in a row", () => {
  const seq = ["05", "05", "01", "09", "01", "01", "07"]; // ties at value "01"
  const sel = winnow(seq, 3);
  // every selection's hash equals the sequence value at its position
  for (const s of sel) assert.equal(seq[s.position], s.hash);
  for (let i = 1; i < sel.length; i += 1) assert.notEqual(sel[i].position, sel[i - 1].position);
});

test("fingerprint: the winnowing recall guarantee — a verbatim run of >= WINNOW_WINDOW + 4 words always contributes a shared fingerprint", () => {
  // host kept well under the hard-cap trigger (~8k grams) so the guarantee,
  // not the trim, is what's under test here.
  const passage = distinctiveDoc(3, WINNOW_WINDOW + 200); // comfortably above the guarantee boundary
  const doc = `${filler(30, 2800, 3)} ${passage} ${filler(31, 2800, 4)}`;
  const fp = computeArchiveFingerprint(doc);
  assert.equal(fp.trimmedByHardCap, false, "sanity: this host must not hit the hard cap");
  const fpSet = new Set(fp.fingerprints.map((f) => f.hash));
  const passageGramHashes = grams(tokens(passage), FINGERPRINT_SHINGLE_SIZE).map((g) => gramHash(g));
  assert.ok(passageGramHashes.some((h) => fpSet.has(h)), "an above-threshold verbatim passage must intersect the document's fingerprint set");
});

test("reconstruction parity: archiveShingleHashes(canonicalText) == the exact 5-gram hash set an old full-shingle write would have stored", () => {
  const text = `${distinctiveDoc(4, 300)} some shared common academic phrasing appears here ${distinctiveDoc(5, 300)}`;
  const canonical = canonicalizeText(text);
  const viaHelper = archiveShingleHashes(canonical);
  const manual = new Set();
  for (const gram of grams(tokens(canonical), FINGERPRINT_SHINGLE_SIZE)) manual.add(gramHash(gram));
  assert.deepEqual([...viaHelper].sort(), [...manual].sort());
});

// ══════════════════════════════════════════════════════════════════════════
// DB — synthetic archive, Baseline-B parity + bounds
// ══════════════════════════════════════════════════════════════════════════

const dbFile = path.join(process.cwd(), "test_archive_scalable_index.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
});

const MDF = 12; // the archive build's maximumDocumentFrequency in production
const MATCHING = { maximumDocumentFrequency: MDF, minimumMatchedWords: 5 };
const FIRST_SEEN_AT = "2020-01-01 00:00:00";
const CORPUS_VERSION = "test-scalable-v1";

// Shared 5-word runs (informative: every token len>=5, none in COMMON_WORDS).
const SECONDARY_SPAN = "quartzite bryophyte lodestar palimpsest zephyrous"; // DF 2 (source + secondary)
const SIXWORD_SPAN = "cormorant thicket sextant marmoset obsidian cindery"; // DF 2, 6 words
const BOILERPLATE = distinctiveDoc(900, 120); // 120-word run shared by 15 docs → DF 15 → df-band → stop
const TIE_PASSAGE = distinctiveDoc(901, WINNOW_WINDOW + 10); // >= guarantee, verbatim in two docs

// Distinctive sources — sized so an ~80-word excerpt of one self-excludes it
// (containment >= 0.75), exactly like the real 321-corpus excerpt cases,
// while a diluted query does not.
const SOURCE_A = `${distinctiveDoc(10, 170)} ${SECONDARY_SPAN} ${distinctiveDoc(11, 170)}`;
const SECONDARY_A = `${distinctiveDoc(12, 200)} ${SECONDARY_SPAN} ${distinctiveDoc(13, 200)}`;
const SOURCE_B = `${distinctiveDoc(14, 170)} ${SIXWORD_SPAN} ${distinctiveDoc(15, 170)}`;
const SECONDARY_B = `${distinctiveDoc(16, 200)} ${SIXWORD_SPAN} ${distinctiveDoc(17, 200)}`;

const ARCHIVE_DOCS = [
  { id: "arc-source-a", title: "Source A", body: SOURCE_A },
  { id: "arc-secondary-a", title: "Secondary Co-Source A", body: SECONDARY_A },
  { id: "arc-source-b", title: "Source B", body: SOURCE_B },
  { id: "arc-secondary-b", title: "Secondary Co-Source B", body: SECONDARY_B },
  { id: "arc-tie-lo", title: "Tie Winner (lower archive_order)", body: `${distinctiveDoc(20, 400)} ${TIE_PASSAGE} ${distinctiveDoc(21, 400)}` },
  { id: "arc-tie-hi", title: "Tie Loser (higher archive_order)", body: `${distinctiveDoc(22, 400)} ${TIE_PASSAGE} ${distinctiveDoc(23, 400)}` },
];
// 15 boilerplate-carrying docs (DF of BOILERPLATE's interior grams = 15).
for (let i = 0; i < 15; i += 1) {
  ARCHIVE_DOCS.push({ id: `arc-boiler-${i}`, title: `Boilerplate Carrier ${i}`, body: `${distinctiveDoc(100 + i, 700)} ${BOILERPLATE}` });
}
// Short-span planted docs — normal (~5,500w) and long (>10k w, hard-cap regime).
const SPANS = [5, 6, 10, 20, 37, 50, 89];
const plantedInfo = [];
for (const host of [{ k: "normal", w: 5500 }, { k: "long10k", w: 10500 }]) {
  for (const span of SPANS) {
    const ns = 500 + plantedInfo.length;
    const passage = distinctiveDoc(ns, span);
    const half = Math.floor((host.w - span) / 2);
    const body = `${filler(ns, half, ns)} ${passage} ${filler(ns + 5000, host.w - span - half, ns + 1)}`;
    const id = `arc-planted-${host.k}-${span}`;
    ARCHIVE_DOCS.push({ id, title: `Planted ${host.k} span=${span}`, body });
    plantedInfo.push({ id, host: host.k, span, passage });
  }
}

for (const [order, doc] of ARCHIVE_DOCS.entries()) {
  const r = await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.title, originalSimilarity: null, text: doc.body, archiveOrder: order }, {
    corpusVersion: CORPUS_VERSION,
    firstSeenAt: FIRST_SEEN_AT,
  });
  assert.equal(r.status, "SEEDED", `fresh seed for ${doc.id}`);
}
const rebuildSummary = await rebuildArchiveScalableIndex(client);

async function runMatcher(text, matchingParameters = MATCHING) {
  return matchAgainstArchiveCorpus(client, text, { maximumDocumentFrequency: MDF, matchingParameters });
}
async function assertParity(label, text, matchingParameters = MATCHING) {
  const b = await baselineB(client, text, { maximumDocumentFrequency: MDF, matchingParameters });
  const m = await runMatcher(text, matchingParameters);
  assert.deepEqual(
    normalizeArchiveResult(m),
    normalizeArchiveResult(b),
    `${label}: matchAgainstArchiveCorpus must reproduce Baseline B exactly`,
  );
  return { b, m };
}

// Deliberately short framing (~9 words each) so an 80-word excerpt of a
// source pushes whole-query containment past scoreAgainstArchive's 0.75
// self-exclusion threshold — exactly like the real 321-corpus excerpt cases
// — while a 40-word excerpt stays comfortably below it.
const FRAME_PRE = "an unrelated opening about a different topic precedes this";
const FRAME_POST = "an unrelated closing about another matter follows this today";
const excerpt = (body, start, n) => tokens(body).slice(start, start + n).join(" ");

test("build summary: the deterministic rebuild produced compact fingerprints (not full shingles), an FTS entry per doc, and a bounded df-band table", () => {
  assert.equal(rebuildSummary.versions.compactFingerprint, ARCHIVE_COMPACT_FINGERPRINT_VERSION);
  assert.equal(rebuildSummary.fingerprints.documents, ARCHIVE_DOCS.length);
  assert.equal(rebuildSummary.phraseIndex.documents, ARCHIVE_DOCS.length);
  // ~120 fingerprint rows/doc — nowhere near a full 5-gram write.
  assert.ok(rebuildSummary.fingerprints.fingerprintRows < ARCHIVE_DOCS.length * MAX_FINGERPRINTS_PER_DOCUMENT);
  assert.ok(rebuildSummary.fingerprints.fingerprintRows > ARCHIVE_DOCS.length * 40);
  // df-band persists ONLY DF >= 13. Our BOILERPLATE (DF 15) qualifies; nothing else does.
  assert.equal(rebuildSummary.dfBands.minPersistedDf, MIN_PERSISTED_DF);
  assert.ok(rebuildSummary.dfBands.persistedRows > 0, "the DF-15 boilerplate must produce df-band rows");
  assert.equal(rebuildSummary.dfBands.histogram.df13_20 + rebuildSummary.dfBands.histogram.df21plus, rebuildSummary.dfBands.persistedRows);
});

test("no old archive full-shingle rows are written by the seed / rebuild path", async () => {
  const shingleRows = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE fingerprint_version = ?",
    args: ["archive-shingle-v1"],
  });
  assert.equal(Number(shingleRows.rows[0].c), 0, "the archive seed path must write ZERO corpus_document_shingles rows under the old namespace");
});

// ── the 6 fixed-probe analogs ──────────────────────────────────────────────
test("fixed probe: exact verbatim re-upload of an archive document (source self-excludes; only a 5-word co-source scores; both paths identical)", async () => {
  const { b, m } = await assertParity("exact-copy", ARCHIVE_DOCS[0].body); // SOURCE_A verbatim
  assert.ok(!m.sources.some((s) => s.name === "Source A"), "an exact re-upload self-excludes its own source (containment >= 0.75)");
  assert.ok(b.sources.some((s) => s.name === "Secondary Co-Source A"), "sanity: B still surfaces the 5-word co-source evidence");
});
test("fixed probe: a distinctive 45-word passage embedded in otherwise-new text is preserved as evidence", async () => {
  const text = `${FRAME_PRE} ${excerpt(SOURCE_B, 10, 45)} ${FRAME_POST}`;
  const { b, m } = await assertParity("distinctive-partial", text);
  assert.ok(b.matchedWordCount > 0, "sanity: the partial copy is actually detected by B");
  assert.ok(m.sources.some((s) => s.name === "Source B"), "the distinctive passage's source is preserved, not self-excluded");
});
test("fixed probe: a two-source mixed copy", async () => {
  const text = `${FRAME_PRE} ${excerpt(SOURCE_A, 10, 45)} a short connecting sentence links two unrelated excerpts together ${excerpt(SOURCE_B, 10, 45)} ${FRAME_POST}`;
  const { m } = await assertParity("mixed", text);
  assert.ok(m.sources.some((s) => s.name === "Source A") && m.sources.some((s) => s.name === "Source B"), "both mixed sources are attributed");
});
test("fixed probe: a boilerplate-heavy query (DF-15 run) contributes no similarity", async () => {
  const { b } = await assertParity("boilerplate", `${FRAME_PRE} ${BOILERPLATE} ${FRAME_POST}`);
  assert.equal(b.matchedWordCount, 0, "sanity: B excludes the over-common boilerplate entirely");
});
test("fixed probe: a genuine no-match control", async () => {
  const { b, m } = await assertParity("no-match", `${distinctiveDoc(99999, 120)}`);
  assert.equal(b.score, 0);
  assert.equal(m.score, 0);
  assert.equal(m.sources.length, 0);
});
test("fixed probe: an archive_order tie is broken toward the lower archive_order in both paths", async () => {
  const text = `${FRAME_PRE} ${distinctiveDoc(60001, 60)} ${TIE_PASSAGE} ${distinctiveDoc(60002, 60)} ${FRAME_POST}`;
  const { m } = await assertParity("tie", text);
  assert.ok(m.sources.length >= 1, "the tie passage must score (query diluted below the self-exclusion threshold)");
  assert.equal(m.sources[0].name, "Tie Winner (lower archive_order)", "the lower archive_order wins the winner-take-all tie");
});

// ── secondary-miss recovery (the "7 misses" structural case) ───────────────
test("secondary-miss recovery: an 80-word excerpt of a source whose only OTHER evidence is a 5-word co-source span", async () => {
  const start = tokens(SOURCE_A).indexOf(tokens(SECONDARY_SPAN)[0]);
  const text = `${FRAME_PRE} ${excerpt(SOURCE_A, Math.max(0, start - 40), 80)} ${FRAME_POST}`;
  const { b, m } = await assertParity("secondary-5word", text);
  assert.ok(b.sources.some((s) => s.name === "Secondary Co-Source A"), "sanity: B recovers the 5-word co-source");
  assert.ok(m.sources.some((s) => s.name === "Secondary Co-Source A"), "the matcher's phrase fallback must recover the 5-word co-source");
  assert.ok(!m.sources.some((s) => s.name === "Source A"), "the excerpt's own source is self-excluded, not attributed");
});
test("secondary-miss recovery: the 6-word co-source variant", async () => {
  const start = tokens(SOURCE_B).indexOf(tokens(SIXWORD_SPAN)[0]);
  const text = `${FRAME_PRE} ${excerpt(SOURCE_B, Math.max(0, start - 40), 80)} ${FRAME_POST}`;
  const { m } = await assertParity("secondary-6word", text);
  assert.ok(m.sources.some((s) => s.name === "Secondary Co-Source B"), "the phrase fallback must recover the 6-word co-source");
});

// ── short-span stress: 5/6/10/20/37/50/89 in normal + 10k host ────────────
for (const p of plantedInfo) {
  test(`short-span stress: a planted ${p.span}-word passage in a ${p.host} host document — matcher == Baseline B`, async () => {
    const text = `${FRAME_PRE} ${p.passage} ${FRAME_POST}`;
    const { b, m } = await assertParity(`stress-${p.host}-${p.span}`, text);
    // For spans up to ~50 the planted doc scores; at 89 the query is mostly
    // the passage so the planted doc self-excludes — in BOTH paths.
    const bHasPlanted = b.sources.some((s) => s.name === `Planted ${p.host} span=${p.span}`);
    const mHasPlanted = m.sources.some((s) => s.name === `Planted ${p.host} span=${p.span}`);
    assert.equal(mHasPlanted, bHasPlanted, "the matcher and B agree on whether the planted doc is a scoring source");
  });
}

test("short-span stress: the isolated single-5-word planted match — which compact fingerprints cannot guarantee — is recovered by the phrase fallback", async () => {
  const p5 = plantedInfo.find((x) => x.host === "normal" && x.span === 5);
  const text = `${FRAME_PRE} ${p5.passage} ${FRAME_POST}`;
  const m = await runMatcher(text);
  assert.ok(m.sources.some((s) => s.name === "Planted normal span=5"), "a lone 5-word overlap must still surface as archive evidence");
});

// ── bounds ────────────────────────────────────────────────────────────────
test("phrase budget is hard-bounded at 16, and admitted phrase fan-out never exceeds the internal gate", async () => {
  // a query stuffed with many short distinctive spans from several sources
  const text = [FRAME_PRE, ...plantedInfo.filter((p) => p.host === "normal").map((p) => p.passage), SECONDARY_SPAN, SIXWORD_SPAN, FRAME_POST].join(" ");
  const m = await runMatcher(text);
  assert.ok(m.archiveDiscovery.phraseProbeCount <= PHRASE_FALLBACK_BUDGET, `phrase probe count ${m.archiveDiscovery.phraseProbeCount} must be <= ${PHRASE_FALLBACK_BUDGET}`);
  assert.ok(m.archiveDiscovery.admittedPhraseProbeCount <= PHRASE_FALLBACK_BUDGET);
  assert.ok(
    m.archiveDiscovery.maxAdmittedPhraseFanOut <= PHRASE_FALLBACK_FANOUT_GATE,
    `admitted fan-out ${m.archiveDiscovery.maxAdmittedPhraseFanOut} must be <= gate ${PHRASE_FALLBACK_FANOUT_GATE}`,
  );
});

// ── global DF independence from candidate breadth ─────────────────────────
test("global DF pruning does not depend on how many candidates were discovered", async () => {
  // The DF-15 boilerplate is stop evidence globally. A query of ONLY the
  // boilerplate discovers ~15 candidates; the matcher and B both score it 0.
  const many = await assertParity("df-independence-broad", `${FRAME_PRE} ${BOILERPLATE} ${FRAME_POST}`);
  assert.equal(many.m.matchedWordCount, 0);
  // The SAME boilerplate embedded next to a distinctive Source B excerpt:
  // Source B scores, the boilerplate still contributes nothing, even though
  // the discovered candidate set is now dominated by Source B, not the 15
  // boilerplate carriers.
  const mixed = await assertParity(
    "df-independence-narrow",
    `${FRAME_PRE} ${excerpt(SOURCE_B, 300, 80)} ${BOILERPLATE} ${FRAME_POST}`,
  );
  assert.ok(mixed.b.matchedWordCount > 0);
  assert.ok(!mixed.m.sources.some((s) => s.name.startsWith("Boilerplate Carrier")), "no boilerplate carrier is ever attributed a match");
});

// ── false-self-exclusion regression ──────────────────────────────────────
test("false-self-exclusion regression: an exact re-upload self-excludes its source; a genuine partial copy does NOT", async () => {
  const exact = await runMatcher(ARCHIVE_DOCS[2].body); // Source B verbatim
  assert.ok(!exact.sources.some((s) => s.name === "Source B"), "an exact re-upload excludes its own source (containment >= 0.75)");

  const partialText = `${distinctiveDoc(77777, 200)} ${excerpt(SOURCE_B, 10, 90)} ${distinctiveDoc(77778, 200)}`;
  const partial = await runMatcher(partialText);
  assert.ok(partial.sources.some((s) => s.name === "Source B"), "a genuine partial copy must NOT be falsely self-excluded — Source B is real evidence here");
  const b = await baselineB(client, partialText, { maximumDocumentFrequency: MDF, matchingParameters: MATCHING });
  assert.deepEqual(normalizeArchiveResult(partial), normalizeArchiveResult(b));
});

// ── shared representation: archive path must not damage the historical corpus ──
test("shared canonical representation: seeding it as an archive source does not touch its historical corpus_document_shingles or its maturity", async () => {
  const rawText = `${distinctiveDoc(4242, 350)} shared representation fixture body continues for a while ${distinctiveDoc(4243, 350)}`;
  const accountId = "acct-shared-rep-fixture";
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
  // 1) a genuine, RECENT user submission creates the representation + its
  //    historical corpus shingles (CORPUS_FINGERPRINT_VERSION, first_seen_at = now).
  const identity = await createDocumentIdentity(client, { accountId, title: "Shared Rep Fixture", author: null, rawText });
  const submission = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  assert.equal(submission.status, "INDEXED");
  const historicalShinglesBefore = Number((await client.execute({
    sql: "SELECT COUNT(*) c FROM corpus_document_shingles WHERE representation_id = ?",
    args: [submission.representationId],
  })).rows[0].c);
  assert.ok(historicalShinglesBefore > 0, "the historical submission wrote real shingles");

  // 2) seed an archive document with byte-identical text — dedup reuses the row.
  const seeded = await seedArchiveDocument(client, { archiveArticleId: "arc-shared-rep", title: "Shared Rep Archive Doc", originalSimilarity: null, text: rawText, archiveOrder: 9999 }, {
    corpusVersion: CORPUS_VERSION,
    firstSeenAt: FIRST_SEEN_AT,
  });
  assert.equal(seeded.representationId, submission.representationId, "seedArchiveDocument reused the exact historical representation");
  await rebuildArchiveScalableIndex(client);

  // 3) the historical shingles are UNCHANGED — the archive path added
  //    fingerprint/phrase rows keyed by representation_id, never deleted anything.
  const historicalShinglesAfter = Number((await client.execute({
    sql: "SELECT COUNT(*) c FROM corpus_document_shingles WHERE representation_id = ?",
    args: [submission.representationId],
  })).rows[0].c);
  assert.equal(historicalShinglesAfter, historicalShinglesBefore, "seeding as an archive source must not add/remove historical corpus_document_shingles");

  // 4) archive matching finds it immediately (no maturity wait)…
  const archiveQuery = `${FRAME_PRE} ${excerpt(rawText, 0, 45)} ${FRAME_POST}`;
  const archiveResult = await runMatcher(archiveQuery);
  assert.ok(archiveResult.sources.some((s) => s.name === "Shared Rep Archive Doc"), "archive matching finds the reused representation immediately");

  // 5) …while ordinary historical matching still treats it as immature.
  const historical = await matchAgainstUserSubmissionCorpus(client, { accountId: null, canonicalText: canonicalizeText(archiveQuery) });
  if (historical.status === "MATCHED") {
    assert.ok(!historical.matches.some((mm) => mm.matchedRepresentationId === submission.representationId), "historical matching must not surface the still-immature representation");
  } else {
    assert.equal(historical.status, "NO_HISTORICAL_MATCH");
  }
});

// ── independent-of-account / SELF ────────────────────────────────────────
test("archive evidence is structurally unreachable by any SELF/account concept", async () => {
  const text = `${FRAME_PRE} ${excerpt(SOURCE_B, 10, 45)} ${FRAME_POST}`;
  const m = await matchAgainstArchiveCorpus(client, text, { maximumDocumentFrequency: MDF, matchingParameters: MATCHING });
  assert.ok(m.sources.length > 0, "archive evidence survives with no account/SELF context available to suppress it");
});
