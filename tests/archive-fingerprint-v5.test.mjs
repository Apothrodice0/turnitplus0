import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { tokens, grams, gramHash } from "../lib/similarity-core.ts";
import { findReferenceSectionStart } from "../lib/reference-section.ts";
import {
  computeArchiveFingerprint,
  computeFingerprintCap,
  fingerprintCapForPolicy,
  archiveFingerprintCapPolicyForVersion,
  trimToHardCap,
  winnow,
  WINNOW_WINDOW,
  MAX_FINGERPRINTS_PER_DOCUMENT,
  NUM_POSITIONAL_STRATA,
  ARCHIVE_COMPACT_FINGERPRINT_VERSION,
  ARCHIVE_COMPACT_FINGERPRINT_VERSION_V5,
} from "../lib/archive-fingerprint.ts";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveCompactFingerprints } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus, ARCHIVE_MATCH_POLICY } from "../lib/archive-corpus-matching.ts";

/**
 * archive-compact-fp-v5 — natural-overflow hard-ceiling cap policy
 * (archive-v4-rebuild-preflight cap-policy review 20260924T132939Z).
 * Synthetic fixtures only. v5 is the default build/query generation (archive-v5-default-switch);
 * the v4 fixtures below name their generation explicitly.
 */

const V1 = "archive-compact-fp-v1";
const V4 = "archive-compact-fp-v4";
const V5 = ARCHIVE_COMPACT_FINGERPRINT_VERSION_V5;
const HARD_CEILING = "natural-overflow-hard-ceiling";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Ordinary-prose stand-in: a deterministic random-token stream. */
function randomDoc(seed, wordCount) {
  const rand = mulberry32(seed);
  const w = [];
  for (let i = 0; i < wordCount; i += 1) w.push(`ordw${Math.floor(rand() * 1e9).toString(36)}x`);
  return w.join(" ");
}
const digest = (result) => crypto.createHash("sha256").update(JSON.stringify(result.fingerprints)).digest("hex");
const hashSet = (result) => new Set(result.fingerprints.map((f) => f.hash));
const v5Of = (text) => computeArchiveFingerprint(text, WINNOW_WINDOW, HARD_CEILING);

/** Start offsets (in words) of every `length`-word window of `text` sharing no 5-gram hash with `fingerprints`. */
function undiscoverableWindows(text, fingerprints, length) {
  const gh = grams(tokens(text), 5).map((g) => gramHash(g));
  const out = [];
  for (let start = 0; start + length - 5 < gh.length; start += 1) {
    let hit = false;
    for (let k = start; k <= start + length - 5 && !hit; k += 1) hit = fingerprints.has(gh[k]);
    if (!hit) out.push(start);
  }
  return out;
}

// ~5,000-word ordinary document whose natural winnow density (118 selections)
// sits above the v4 length-scaled budget (112) — the shape behind the
// Archive769 90-word discovery regressions.
const ORDINARY = randomDoc(7, 5000);
const LONG_WORDS = randomDoc(99, 50000).split(" ");
const EXACT_1024 = LONG_WORDS.slice(0, 45246).join(" "); // natural winnow count is exactly 1024
const OVER_1024 = LONG_WORDS.join(" ");
// Golden v4 digests, computed from the unmodified pre-v5 lib/archive-fingerprint.ts (HEAD 1983b53).
const V4_GOLDEN = {
  ORDINARY: { sha256: "ea3c5bbe096be3ccbfbdf095c69f7c5d4f7ed8a91b50eb70bbde92c31952d10a", count: 112 },
  EXACT_1024: { sha256: "6b98eedd094f02c095a141b0cb481b01ec66d50308c8cc8f9c96a314f8c338bb", count: 1005 },
  OVER_1024: { sha256: "f8e93b12768b877e6101202ba43b53b9760060e03dbf88dcf5aa45c6050fc590", count: 1024 },
};
// In-prose citation pointer past the 50% mark followed by more body text: v4
// preprocessing must keep the tail (v3 stripped it).
const POINTER_TAIL = randomDoc(23, 1500);
const POINTER = `${randomDoc(21, 3000)}\n\nReferences of the Example Peace Conference, the some-principle, UN Resolutions 1397, 338, 242, discussed further in relation to events from 1991 and 1993 regarding regional diplomacy et al. (1995).\n${POINTER_TAIL}`;

// ══════════════════════════════════════════════════════════════════════════
// DB SETUP — every top-level await resolves before the first test() call
// (see tests/archive-scalable-index.test.mjs for the node:test race this avoids).
// ══════════════════════════════════════════════════════════════════════════
const dbFile = path.join(os.tmpdir(), `test_archive_fingerprint_v5_${process.pid}.db`);
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));

const DOCS = [
  { archiveArticleId: "v5-ordinary", title: "V5 Ordinary", text: ORDINARY },
  { archiveArticleId: "v5-over-1024", title: "V5 Over Ceiling", text: OVER_1024 },
  { archiveArticleId: "v5-pointer", title: "V5 Pointer Rule", text: POINTER },
];
const representationIdByArticle = new Map();
for (const [i, d] of DOCS.entries()) {
  const r = await seedArchiveDocument(
    client,
    { archiveArticleId: d.archiveArticleId, title: d.title, text: d.text, originalSimilarity: null, archiveOrder: i },
    { corpusVersion: "test-v5", firstSeenAt: "2020-01-01 00:00:00", fingerprintVersion: V4 },
  );
  representationIdByArticle.set(d.archiveArticleId, r.representationId);
}
const rowsFor = async (version) => (await client.execute({
  sql: `SELECT representation_id, fingerprint_hash, optional_position FROM archive_document_fingerprints WHERE fingerprint_version = ? ORDER BY representation_id, fingerprint_hash`,
  args: [version],
})).rows.map((r) => `${r.representation_id}|${r.fingerprint_hash}|${r.optional_position}`);
const v4RowsBeforeV5 = await rowsFor(V4);

const MATCHING = { maximumDocumentFrequency: 12, minimumMatchedWords: 5 };
const ordinaryWords = tokens(ORDINARY);
const regressionStart = undiscoverableWindows(ORDINARY, hashSet(computeArchiveFingerprint(ORDINARY)), 90)[0];
const regressionPassage = ordinaryWords.slice(regressionStart, regressionStart + 90).join(" ");
const probeText = `${randomDoc(501, 1200)} ${regressionPassage} ${randomDoc(502, 1200)}`;
const matchV5BeforeBuild = await matchAgainstArchiveCorpus(client, probeText, { ...MATCHING, compactFingerprintVersion: V5 });
const matchDefaultBeforeBuild = await matchAgainstArchiveCorpus(client, probeText, MATCHING);

const v5Build = await rebuildArchiveCompactFingerprints(client, { fingerprintVersion: V5 });
const v5RowsFirst = await rowsFor(V5);
const v5BuildRepeat = await rebuildArchiveCompactFingerprints(client, { fingerprintVersion: V5 });
const v5RowsRepeat = await rowsFor(V5);
const v4RowsAfterV5 = await rowsFor(V4);
const v5CountByRep = new Map((await client.execute({
  sql: `SELECT representation_id, COUNT(*) AS n FROM archive_document_fingerprints WHERE fingerprint_version = ? GROUP BY representation_id`,
  args: [V5],
})).rows.map((r) => [String(r.representation_id), Number(r.n)]));
const matchV4Explicit = await matchAgainstArchiveCorpus(client, probeText, { ...MATCHING, compactFingerprintVersion: V4 });
const matchV1Explicit = await matchAgainstArchiveCorpus(client, probeText, { ...MATCHING, compactFingerprintVersion: V1 });
const matchV5Explicit = await matchAgainstArchiveCorpus(client, probeText, { ...MATCHING, compactFingerprintVersion: V5 });
const matchDefault = await matchAgainstArchiveCorpus(client, probeText, MATCHING);

// Default builders: a no-option rebuild regenerates exactly the v5 generation,
// and a default seed writes v5 rows (natural count) and no v4 rows.
const defaultBuild = await rebuildArchiveCompactFingerprints(client);
const v5RowsAfterDefaultBuild = await rowsFor(V5);
const v4RowsAfterDefaultBuild = await rowsFor(V4);
const DEFAULT_SEED_TEXT = randomDoc(31, 4000);
const defaultSeed = await seedArchiveDocument(
  client,
  { archiveArticleId: "v5-default-seed", title: "V5 Default Seed", text: DEFAULT_SEED_TEXT, originalSimilarity: null, archiveOrder: DOCS.length },
  { corpusVersion: "test-v5", firstSeenAt: "2020-01-01 00:00:00" },
);
const defaultSeedRowsByVersion = new Map((await client.execute({
  sql: `SELECT fingerprint_version, COUNT(*) AS n FROM archive_document_fingerprints WHERE representation_id = ? GROUP BY fingerprint_version`,
  args: [defaultSeed.representationId],
})).rows.map((r) => [String(r.fingerprint_version), Number(r.n)]));

test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch {} }
});

// ── version / default safety ────────────────────────────────────────────────
test("default build/query generation is v5; v4 and older tags stay selectable by name", () => {
  assert.equal(ARCHIVE_COMPACT_FINGERPRINT_VERSION, V5);
  assert.equal(ARCHIVE_MATCH_POLICY.compactFingerprintVersion, V5);
  assert.equal(V5, "archive-compact-fp-v5");
  assert.equal(archiveFingerprintCapPolicyForVersion(V5), HARD_CEILING);
  for (const tag of [V4, "archive-compact-fp-v3", "archive-compact-fp-v1", "some-other-tag"]) {
    assert.equal(archiveFingerprintCapPolicyForVersion(tag), "length-scaled", tag);
  }
});

// ── v4 unchanged ────────────────────────────────────────────────────────────
test("v4: default and explicit length-scaled output match the pre-v5 golden digests byte-for-byte", () => {
  for (const [name, text] of Object.entries({ ORDINARY, EXACT_1024, OVER_1024 })) {
    const byDefault = computeArchiveFingerprint(text);
    const explicit = computeArchiveFingerprint(text, WINNOW_WINDOW, "length-scaled");
    assert.equal(digest(byDefault), V4_GOLDEN[name].sha256, name);
    assert.equal(byDefault.fingerprints.length, V4_GOLDEN[name].count, name);
    assert.deepEqual(explicit, byDefault, name);
    assert.equal(byDefault.fingerprintCap, computeFingerprintCap(tokens(text).length), name);
  }
});

// ── v5 cap behaviour ────────────────────────────────────────────────────────
test("v5: natural count below 1024 keeps every natural fingerprint (v4 trims the same document)", () => {
  const v4 = computeArchiveFingerprint(ORDINARY);
  const v5 = v5Of(ORDINARY);
  assert.ok(v4.trimmedByHardCap, "fixture must be one the v4 length-scaled budget trims");
  assert.equal(v5.trimmedByHardCap, false);
  assert.equal(v5.fingerprintCap, MAX_FINGERPRINTS_PER_DOCUMENT);
  assert.equal(v5.fingerprints.length, v5.rawWinnowSelectionCount);
  assert.equal(v5.fingerprints.length, 118);
  for (const h of hashSet(v4)) assert.ok(hashSet(v5).has(h), "below the ceiling every v4 fingerprint is also a v5 fingerprint");
});

test("v5: natural count exactly 1024 keeps all 1024", () => {
  const v5 = v5Of(EXACT_1024);
  assert.equal(v5.rawWinnowSelectionCount, 1024);
  assert.equal(v5.trimmedByHardCap, false);
  assert.equal(v5.fingerprints.length, 1024);
  assert.equal(computeArchiveFingerprint(EXACT_1024).fingerprints.length, 1005, "v4 trims this document to its length-scaled budget");
});

test("v5: natural count above 1024 is trimmed to exactly 1024 by the existing 32-strata trim", () => {
  const v5 = v5Of(OVER_1024);
  assert.ok(v5.rawWinnowSelectionCount > 1024, `natural=${v5.rawWinnowSelectionCount}`);
  assert.equal(v5.trimmedByHardCap, true);
  assert.equal(v5.fingerprints.length, 1024);

  // Re-derive the natural selection and confirm v5 is exactly trimToHardCap(natural, 1024, gramCount).
  const gramList = grams(tokens(OVER_1024), 5);
  const hashSequence = gramList.map((g) => gramHash(g));
  const expected = trimToHardCap(naturalSelections(hashSequence), 1024, gramList.length);
  assert.deepEqual(new Map(v5.fingerprints.map((f) => [f.hash, f.position])), expected);

  // Per-stratum allotment: floor(1024/32)=32 each when every stratum has enough supply.
  const perStratum = new Array(NUM_POSITIONAL_STRATA).fill(0);
  for (const f of v5.fingerprints) perStratum[Math.min(NUM_POSITIONAL_STRATA - 1, Math.floor((f.position / gramList.length) * NUM_POSITIONAL_STRATA))] += 1;
  const supply = new Array(NUM_POSITIONAL_STRATA).fill(0);
  for (const p of naturalSelections(hashSequence).values()) supply[Math.min(NUM_POSITIONAL_STRATA - 1, Math.floor((p / gramList.length) * NUM_POSITIONAL_STRATA))] += 1;
  for (let i = 0; i < NUM_POSITIONAL_STRATA; i += 1) {
    assert.ok(perStratum[i] >= Math.min(32, supply[i]), `stratum ${i}: ${perStratum[i]} < min(32, ${supply[i]})`);
    if (supply.every((s) => s >= 32)) assert.equal(perStratum[i], 32, `stratum ${i}`);
  }
});

/** computeArchiveFingerprint's own pre-trim step, via the exported winnow primitive. */
function naturalSelections(hashSequence) {
  const out = new Map();
  for (const s of winnow(hashSequence, WINNOW_WINDOW)) if (!out.has(s.hash)) out.set(s.hash, s.position);
  return out;
}

test("v5 cap policy helper: 1023 / 1024 kept whole, 1025 trimmed to 1024 (hard ceiling only)", () => {
  const cap = fingerprintCapForPolicy(HARD_CEILING, 1);
  assert.equal(cap, 1024);
  assert.equal(fingerprintCapForPolicy(HARD_CEILING, 500_000), 1024);
  for (const n of [1023, 1024, 1025]) {
    const map = new Map(Array.from({ length: n }, (_, i) => [i.toString(16).padStart(16, "0"), i * 3]));
    const kept = trimToHardCap(map, cap, n * 3);
    assert.equal(kept.size, Math.min(n, 1024), `n=${n}`);
    if (n <= 1024) assert.equal(kept, map, `n=${n} must be returned unchanged`);
  }
});

test("v5: repeat runs are value-identical", () => {
  for (const text of [ORDINARY, EXACT_1024, OVER_1024, POINTER]) {
    assert.deepEqual(v5Of(text), v5Of(text));
  }
});

// ── pointer-rule preprocessing ──────────────────────────────────────────────
test("v5 uses the same v4 citation-pointer preprocessing: the pointer is not treated as a reference section", () => {
  assert.equal(findReferenceSectionStart(POINTER), -1);
  const v4 = computeArchiveFingerprint(POINTER);
  const v5 = v5Of(POINTER);
  assert.equal(v5.rawGramCount, v4.rawGramCount);
  assert.equal(v5.rawWinnowSelectionCount, v4.rawWinnowSelectionCount);
  assert.equal(v5.rawGramCount, grams(tokens(POINTER), 5).length);
  const tailStart = tokens(POINTER).length - tokens(POINTER_TAIL).length;
  assert.ok(v5.fingerprints.some((f) => f.position >= tailStart), "text after the pointer is still fingerprinted");
  for (const h of hashSet(v4)) assert.ok(hashSet(v5).has(h));
});

// ── regression fixture ──────────────────────────────────────────────────────
test("regression: v4 density trimming leaves 90-word ordinary passages undiscoverable; v5 covers every >= WINNOW_WINDOW+4-word window", () => {
  const v4Gaps = undiscoverableWindows(ORDINARY, hashSet(computeArchiveFingerprint(ORDINARY)), 90);
  assert.ok(v4Gaps.length > 0, "v4 must drop at least one discoverable 90-word passage");
  assert.equal(undiscoverableWindows(ORDINARY, hashSet(v5Of(ORDINARY)), WINNOW_WINDOW + 4).length, 0,
    "v5 restores the winnowing guarantee for this ordinary document");
});

// ── storage + query semantics ───────────────────────────────────────────────
test("v5 build stores rows tagged archive-compact-fp-v5 with natural counts under the ceiling and 1024 above it", () => {
  assert.equal(v5Build.documents, 3);
  assert.equal(v5CountByRep.get(representationIdByArticle.get("v5-ordinary")), v5Of(ORDINARY).rawWinnowSelectionCount);
  assert.equal(v5CountByRep.get(representationIdByArticle.get("v5-pointer")), v5Of(POINTER).rawWinnowSelectionCount);
  assert.equal(v5CountByRep.get(representationIdByArticle.get("v5-over-1024")), 1024);
  assert.equal(v5RowsFirst.length, v5Build.fingerprintRows);
  assert.deepEqual(v5RowsRepeat, v5RowsFirst, "rebuild is idempotent");
  assert.equal(v5BuildRepeat.fingerprintRows, v5Build.fingerprintRows);
});

test("v5 build leaves v4 rows untouched", () => {
  assert.ok(v4RowsBeforeV5.length > 0);
  assert.deepEqual(v4RowsAfterV5, v4RowsBeforeV5);
});

test("querying v5 never reads v4 rows: before any v5 rows exist, v5 compact discovery finds nothing", () => {
  assert.equal(matchV5BeforeBuild.archiveDiscovery.compactCandidateCount, 0);
  assert.equal(matchV5BeforeBuild.sources.some((s) => s.name === "V5 Ordinary"), false);
});

test("default query never falls back to v4 rows: before any v5 rows exist, default compact discovery finds nothing", () => {
  assert.equal(matchDefaultBeforeBuild.archiveDiscovery.compactCandidateCount, 0);
  assert.equal(matchDefaultBeforeBuild.sources.some((s) => s.name === "V5 Ordinary"), false);
});

test("explicit v1 query reads only v1 rows (none here) — no fallback to the v4/v5 rows present", () => {
  assert.equal(matchV1Explicit.archiveDiscovery.compactCandidateCount, 0);
  assert.equal(matchV1Explicit.sources.some((s) => s.name === "V5 Ordinary"), false);
});

test("default query is the explicit v5 query, byte-for-byte", () => {
  assert.deepEqual(matchDefault, matchV5Explicit);
});

test("default builders write v5: no-option rebuild reproduces the v5 rows; default seed writes natural v5 rows only", () => {
  assert.equal(defaultBuild.documents, v5Build.documents);
  assert.equal(defaultBuild.fingerprintRows, v5Build.fingerprintRows);
  assert.deepEqual(v5RowsAfterDefaultBuild, v5RowsFirst);
  assert.deepEqual(v4RowsAfterDefaultBuild, v4RowsBeforeV5, "default rebuild never touches v4 rows");
  assert.equal(defaultSeed.status, "SEEDED");
  assert.deepEqual([...defaultSeedRowsByVersion.keys()], [V5]);
  assert.equal(defaultSeedRowsByVersion.get(V5), v5Of(DEFAULT_SEED_TEXT).rawWinnowSelectionCount);
});

test("regression passage: explicit v4 query misses the source; explicit v5 query discovers and scores it", () => {
  assert.equal(matchV4Explicit.archiveDiscovery.compactCandidateCount, 0);
  assert.equal(matchV4Explicit.sources.some((s) => s.name === "V5 Ordinary"), false);
  assert.equal(matchV5Explicit.archiveDiscovery.compactCandidateCount, 1);
  const source = matchV5Explicit.sources.find((s) => s.name === "V5 Ordinary");
  assert.ok(source, "v5 discovery must reach the source");
  assert.equal(source.matchedWords, 90);
});
