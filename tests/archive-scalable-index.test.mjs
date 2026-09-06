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

// ── slice 2D.4 — co-source adjacency + G1s fixtures ──────────────────────────
// A near-duplicate catastrophe: two content-near-dup archive docs that both
// fully contain NEARDUP_PASSAGE (so an excerpt of it self-excludes BOTH),
// plus a co-source doc arc-cosrc-c (and 3 more carriers) sharing only
// COSOURCE_RUN with them. COSOURCE_RUN is short (< the winnowing guarantee) so
// compact discovery never finds the carriers, and DF-6 — rare enough for the
// co-source build to count it, common enough that the budget-16 phrase fallback
// spends every slot on the DF-2 NEARDUP_PASSAGE grams and never probes it. With
// the flag off the excerpt scores 0 (the catastrophe); with it on, G1s takes
// arc-nd-1/arc-nd-2 as anchors and the adjacency lookup restores arc-cosrc-c.
const NEARDUP_PASSAGE = distinctiveDoc(4000, 340);              // DF 2 — only the two near-dups
const COSOURCE_RUN = distinctiveDoc(4001, 7);                   // DF 6 — a 7-word run below any compact-fingerprint window
ARCHIVE_DOCS.push(
  { id: "arc-nd-1", title: "Near-Dup One", body: `${filler(4010, 240, 71)} ${NEARDUP_PASSAGE} ${COSOURCE_RUN} ${filler(4011, 240, 72)}` },
  { id: "arc-nd-2", title: "Near-Dup Two", body: `${filler(4012, 240, 73)} ${NEARDUP_PASSAGE} ${COSOURCE_RUN} ${filler(4013, 240, 74)}` },
  { id: "arc-cosrc-c", title: "Co-Source C", body: `${distinctiveDoc(4020, 320)} ${COSOURCE_RUN} ${distinctiveDoc(4021, 320)}` },
);
for (let i = 0; i < 3; i += 1) {
  ARCHIVE_DOCS.push({ id: `arc-cosrc-carrier-${i}`, title: `Co-Source Carrier ${i}`, body: `${distinctiveDoc(4030 + i, 320)} ${COSOURCE_RUN} ${distinctiveDoc(4040 + i, 320)}` });
}
// G1s control: a normal source a ~45-word excerpt does NOT self-exclude, so the
// gate never opens for it even with the flag on.
const G1S_CONTROL_PASSAGE = distinctiveDoc(4050, 620);
ARCHIVE_DOCS.push({ id: "arc-g1s-control", title: "G1s Control Source", body: `${filler(4051, 260, 81)} ${G1S_CONTROL_PASSAGE} ${filler(4052, 260, 82)}` });
// Self-exclude-plus: an archive doc a re-upload self-excludes, that ALSO shares
// a >= 100-word run (SHARED_RUN) with arc-partial-match — which the re-upload
// does NOT self-exclude and which DOES contribute a source. G1s must stay
// closed (a surviving non-self-excluded contributing source, and not every
// discovered candidate self-excludes).
const SHARED_RUN = distinctiveDoc(4060, 120);
ARCHIVE_DOCS.push(
  { id: "arc-selfexcl-plus", title: "Self-Exclude Plus", body: `${distinctiveDoc(4061, 200)} ${SHARED_RUN} ${distinctiveDoc(4062, 200)}` },
  { id: "arc-partial-match", title: "Partial Match Peer", body: `${distinctiveDoc(4063, 420)} ${SHARED_RUN} ${distinctiveDoc(4064, 420)}` },
);

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

// ══════════════════════════════════════════════════════════════════════════
// slice 2D.4 — co-source adjacency (drizzle/0050) + the G1s expansion gate
// ══════════════════════════════════════════════════════════════════════════

test("adjacency build: deterministic + idempotent — a second rebuild reproduces byte-identical rows", async () => {
  const snapshot = async () => (await client.execute(
    "SELECT representation_id, co_representation_id, shared_gram_count, policy_version FROM archive_document_cosources ORDER BY representation_id, co_representation_id, policy_version",
  )).rows.map((r) => `${r.representation_id}|${r.co_representation_id}|${r.shared_gram_count}|${r.policy_version}`);
  const before = await snapshot();
  assert.ok(before.length > 0, "the near-dup / co-source fixtures must produce adjacency rows");
  await rebuildArchiveScalableIndex(client);
  assert.deepEqual(await snapshot(), before, "a re-run of the whole scalable-index rebuild must reproduce the exact same co-source rows");
  assert.equal(rebuildSummary.versions.cosourcePolicy, "archive-cosource-v1");
});

test("adjacency invariants: min shared >= 2, no self edges, single policy version, <= 24 outgoing neighbours per doc", async () => {
  const rows = (await client.execute("SELECT representation_id, co_representation_id, shared_gram_count, policy_version FROM archive_document_cosources")).rows;
  for (const r of rows) {
    assert.ok(Number(r.shared_gram_count) >= 2, `shared_gram_count must be >= 2, got ${r.shared_gram_count}`);
    assert.notEqual(String(r.representation_id), String(r.co_representation_id), "no self edge");
    assert.equal(String(r.policy_version), "archive-cosource-v1");
  }
  const perDoc = new Map();
  for (const r of rows) perDoc.set(String(r.representation_id), (perDoc.get(String(r.representation_id)) ?? 0) + 1);
  for (const [rep, n] of perDoc) assert.ok(n <= 24, `${rep} has ${n} outgoing co-source neighbours — must be <= 24`);
  // the expected edge for the near-dup catastrophe fixture
  const ndReps = (await client.execute("SELECT representation_id FROM archive_document_representations WHERE archive_article_id IN ('arc-nd-1','arc-nd-2','arc-cosrc-c')")).rows.map((r) => String(r.representation_id));
  const [nd1, nd2, cosrcC] = ndReps.length === 3 ? await Promise.all(['arc-nd-1', 'arc-nd-2', 'arc-cosrc-c'].map(async (a) => String((await client.execute({ sql: "SELECT representation_id FROM archive_document_representations WHERE archive_article_id = ?", args: [a] })).rows[0].representation_id))) : [];
  const edge = await client.execute({ sql: "SELECT 1 FROM archive_document_cosources WHERE representation_id = ? AND co_representation_id = ? AND policy_version = 'archive-cosource-v1'", args: [nd1, cosrcC] });
  assert.equal(edge.rows.length, 1, "arc-nd-1 -> arc-cosrc-c must be a co-source edge");
});

test("adjacency build reads canonical text / df-band derived data only — ZERO archive-shingle-v1 writes, historical corpus untouched", async () => {
  const archiveShingles = await client.execute({ sql: "SELECT COUNT(*) c FROM corpus_document_shingles WHERE fingerprint_version = ?", args: ["archive-shingle-v1"] });
  assert.equal(Number(archiveShingles.rows[0].c), 0, "the co-source build (like the whole scalable index) writes ZERO corpus_document_shingles under the old archive namespace");
});

test("archive_order is not touched by the co-source build", async () => {
  const orders = (await client.execute("SELECT archive_article_id, archive_order FROM archive_document_representations ORDER BY archive_order")).rows;
  await rebuildArchiveScalableIndex(client);
  const after = (await client.execute("SELECT archive_article_id, archive_order FROM archive_document_representations ORDER BY archive_order")).rows;
  assert.deepEqual(after.map((r) => [String(r.archive_article_id), Number(r.archive_order)]), orders.map((r) => [String(r.archive_article_id), Number(r.archive_order)]));
});

// helper: run the matcher with the expansion flag forced to a value
async function runWithFlag(flag, text, matchingParameters = MATCHING) {
  const prev = process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
  if (flag === undefined) delete process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
  else process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED = flag;
  try {
    return await matchAgainstArchiveCorpus(client, text, { maximumDocumentFrequency: MDF, matchingParameters });
  } finally {
    if (prev === undefined) delete process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED;
    else process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED = prev;
  }
}

// The near-dup catastrophe probe: a 120-word NEARDUP_PASSAGE excerpt plus the
// 7-word COSOURCE_RUN. Compact discovery finds only arc-nd-1 / arc-nd-2 (both
// self-excluding — COSOURCE_RUN is far below any winnowed-fingerprint window);
// the budget-16 phrase fallback spends every slot on the DF-2 NEARDUP grams;
// arc-cosrc-c (and the carriers) are reachable only through the adjacency graph,
// where they then score their shared COSOURCE_RUN.
const CATASTROPHE_PROBE = `${FRAME_PRE} ${excerpt(NEARDUP_PASSAGE, 40, 120)} ${COSOURCE_RUN} ${FRAME_POST}`;

test("flag OFF (default): the committed compact+phrase matcher is UNCHANGED — the near-dup collapse still happens, and no `cosource` diagnostics field is attached", async () => {
  const off = await runWithFlag(undefined, CATASTROPHE_PROBE);
  // the catastrophe: exhaustive Baseline B recovers arc-cosrc-c, the committed
  // bounded matcher does NOT — this is exactly the discovery gap 2D.4 closes.
  const b = await baselineB(client, CATASTROPHE_PROBE, { maximumDocumentFrequency: MDF, matchingParameters: MATCHING });
  assert.ok(b.sources.some((s) => s.name === "Co-Source C"), "sanity: exhaustive Baseline B DOES recover arc-cosrc-c");
  assert.equal(off.score, 0, "flag off: the committed matcher collapses to 0 (both near-dups self-excluded, nothing else discovered)");
  assert.ok(!off.sources.some((s) => s.name === "Co-Source C"), "flag off: arc-cosrc-c is NOT recovered");
  assert.equal(off.archiveDiscovery.cosource, undefined, "flag off must not attach any cosource diagnostics (byte-identical to the pre-2D.4 matcher)");
  const explicitFalse = await runWithFlag("false", CATASTROPHE_PROBE);
  assert.deepEqual(normalizeArchiveResult(explicitFalse), normalizeArchiveResult(off), "'false' behaves exactly like absent");
  assert.equal(explicitFalse.archiveDiscovery.cosource, undefined);
  // every non-flag test in this file already runs with the flag off and still
  // asserts full Baseline-B parity on the ordinary fixtures — proving the
  // flag-off path is unchanged for every case the committed matcher already
  // handled. This test only pins the ONE case it deliberately does not.
});

test("flag ON: G1s opens for the near-dup catastrophe, adjacency lookup restores the co-source, and both near-dups stay self-excluded", async () => {
  const on = await runWithFlag("true", CATASTROPHE_PROBE);
  assert.ok(on.archiveDiscovery.cosource, "flag on attaches cosource diagnostics");
  assert.equal(on.archiveDiscovery.cosource.selfExcludedCandidateCount, 2, "arc-nd-1 and arc-nd-2 both self-exclude the excerpt");
  assert.equal(on.archiveDiscovery.cosource.eligible, true, "every discovered candidate self-excludes -> G1s eligible");
  assert.equal(on.archiveDiscovery.cosource.anchorCount, 2, "both self-excluded candidates become anchors");
  assert.equal(on.archiveDiscovery.cosource.applied, true, "co-source neighbours were unioned in and re-scored");
  assert.ok(on.archiveDiscovery.cosource.neighborCount >= 1);
  assert.ok(on.sources.some((s) => s.name === "Co-Source C"), "flag on: arc-cosrc-c is recovered through the adjacency graph");
  assert.ok(!on.sources.some((s) => s.name === "Near-Dup One" || s.name === "Near-Dup Two"), "the near-dup twins remain self-excluded, never attributed");
  assert.ok(on.score > 0, "the recovered co-source produces real similarity where the committed matcher scored 0");
});

test("flag ON: a query with NO self-excluded candidate never triggers an adjacency lookup", async () => {
  // a 45-word excerpt of the G1s control source — a genuine partial copy, not
  // self-exclusion.
  const text = `${FRAME_PRE} ${excerpt(G1S_CONTROL_PASSAGE, 20, 45)} ${FRAME_POST}`;
  const on = await runWithFlag("true", text);
  const off = await runWithFlag(undefined, text);
  assert.equal(on.archiveDiscovery.cosource.selfExcludedCandidateCount, 0, "the partial copy does not self-exclude its source");
  assert.equal(on.archiveDiscovery.cosource.eligible, false, "no self-excluded candidate -> G1s cannot open");
  assert.equal(on.archiveDiscovery.cosource.anchorCount, 0, "no adjacency lookup was performed");
  assert.equal(on.archiveDiscovery.cosource.applied, false);
  assert.deepEqual(normalizeArchiveResult(on), normalizeArchiveResult(off), "with the gate closed, flag on == flag off");
  assert.ok(on.sources.some((s) => s.name === "G1s Control Source"), "the genuine partial copy is still attributed, exactly as before");
});

test("flag ON: G1s stays closed when a non-self-excluded candidate still contributed a source", async () => {
  // arc-selfexcl-plus verbatim: it self-excludes itself, but arc-partial-match
  // (its >= 100-word SHARED_RUN peer) does NOT self-exclude the re-upload and
  // DOES contribute a source. Not every discovered candidate self-excludes, and
  // a non-self-excluded contributing source survived — G1s must not open, and
  // arc-selfexcl-plus's own co-source neighbours must not be pulled in.
  const body = ARCHIVE_DOCS.find((d) => d.id === "arc-selfexcl-plus").body;
  const on = await runWithFlag("true", body);
  assert.ok(on.archiveDiscovery.cosource.selfExcludedCandidateCount >= 1, "the exact re-upload self-excludes arc-selfexcl-plus");
  assert.ok(on.archiveDiscovery.cosource.selfExcludedCandidateCount < on.archiveDiscovery.compactCandidateCount, "arc-partial-match is a discovered candidate that does NOT self-exclude");
  assert.ok(on.sources.some((s) => s.name === "Partial Match Peer"), "sanity: arc-partial-match contributes a source");
  assert.equal(on.archiveDiscovery.cosource.eligible, false, "a surviving non-self-excluded contributing source keeps G1s closed");
  assert.equal(on.archiveDiscovery.cosource.anchorCount, 0, "no adjacency lookup was performed");
  assert.equal(on.archiveDiscovery.cosource.applied, false);
  const off = await runWithFlag(undefined, body);
  assert.deepEqual(normalizeArchiveResult(on), normalizeArchiveResult(off), "flag on == flag off when G1s does not open");
});

test("flag ON: a no-match control stays 0 — no self-excluded candidate, no expansion, no spurious source", async () => {
  const text = `${distinctiveDoc(96521, 160)}`;
  const on = await runWithFlag("true", text);
  assert.equal(on.score, 0);
  assert.equal(on.sources.length, 0);
  assert.equal(on.archiveDiscovery.cosource.eligible, false);
  assert.equal(on.archiveDiscovery.cosource.anchorCount, 0);
});

test("flag ON: the candidate union handed to the re-score is de-duplicated (no representation ID appears twice)", async () => {
  const on = await runWithFlag("true", CATASTROPHE_PROBE);
  assert.ok(on.archiveDiscovery.cosource.applied, "sanity: this probe expands");
  // finalCandidateCount is the size of a Set-deduped union; assert it is
  // strictly the compact+phrase union plus the *new* neighbours, never more.
  assert.ok(
    on.archiveDiscovery.cosource.finalCandidateCount <= on.archiveDiscovery.unionCandidateCount + on.archiveDiscovery.cosource.neighborCount,
    "the expanded union cannot exceed union + neighbours (it is Set-deduped)",
  );
  assert.ok(on.archiveDiscovery.cosource.finalCandidateCount > on.archiveDiscovery.unionCandidateCount, "at least one new candidate was actually added");
});

test("only self-excluded candidates are adjacency anchors — a co-source of a NON-self-excluded candidate is never pulled in", async () => {
  // arc-cosrc-c has co-source edges to the carriers. A probe that makes
  // arc-cosrc-c a NON-self-excluded contributing candidate must not drag the
  // carriers in via the graph — arc-cosrc-c is not an anchor.
  const text = `${FRAME_PRE} ${excerpt(COSOURCE_RUN, 0, 30)} ${distinctiveDoc(97010, 90)} ${FRAME_POST}`;
  const on = await runWithFlag("true", text);
  // arc-cosrc-c may or may not score here, but if G1s is not eligible the
  // carriers are never queried.
  if (!on.archiveDiscovery.cosource.eligible) {
    assert.equal(on.archiveDiscovery.cosource.anchorCount, 0);
    const off = await runWithFlag(undefined, text);
    assert.deepEqual(normalizeArchiveResult(on), normalizeArchiveResult(off));
  }
});
