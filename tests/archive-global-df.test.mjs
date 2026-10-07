import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { gramHash, grams, tokens } from "../lib/similarity-core.ts";
import { scoreAgainstArchiveDetailed } from "../lib/archive-similarity-scoring.ts";
import { ARCHIVE_SHINGLE_SIZE, WINNOW_WINDOW, archiveShingleHashes, computeArchiveFingerprint } from "../lib/archive-fingerprint.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus, ARCHIVE_MATCH_POLICY, ARCHIVE_RUNTIME_DF_POLICY_VERSION } from "../lib/archive-corpus-matching.ts";

/**
 * The Archive runtime DF (cap 6) and IDF are counted over the WHOLE archive,
 * never over the retrieved candidates. One true source holds a 200-word
 * passage P; a 30-word stretch C inside P is also held by other archive
 * documents ("holders"). Whether C is evidence depends only on how many
 * archive documents hold it — not on candidateLimit, on how many holders
 * discovery happened to retrieve, on candidate order, or on the display cap.
 * Synthetic fixtures only.
 */

const syn = (ns, n) => [...Array(n).keys()].map((i) => `zq${ns}x${i.toString(36)}v`); // informative, unique
const PARAMS = { minimumMatchedWords: 5, maximumDocumentFrequency: 6, minimumSourceContribution: 0.5, maximumContributingSources: 10, sourceWeighting: "raw" };
const INDEX_CAP = 12;

const HOST_A = syn(900, 300);
const HOST_B = syn(901, 300);
const PA = syn(100, 85);
const C = syn(101, 30);
const PB = syn(102, 85);
const P = [...PA, ...C, ...PB];
const SUBMISSION = [...HOST_A, ...P, ...HOST_B].join(" ");
const P_RANGE = [HOST_A.length, HOST_A.length + P.length - 1];
const C_RANGE = [HOST_A.length + PA.length, HOST_A.length + PA.length + C.length - 1];

// Holders are found deterministically: an "exposed" holder shares exactly one
// winnowed fingerprint with the submission (compact discovery retrieves it),
// a "hidden" one shares none (it is only ever counted, never retrieved).
const queryHashes = new Set(grams(tokens(SUBMISSION), ARCHIVE_SHINGLE_SIZE).map(gramHash));
const sharedFingerprints = (body) => computeArchiveFingerprint(canonicalizeText(body), WINNOW_WINDOW, "natural-overflow-hard-ceiling")
  .fingerprints.filter((entry) => queryHashes.has(entry.hash)).length;
function findHolders(exposed, count, startNamespace) {
  const found = [];
  for (let ns = startNamespace; found.length < count; ns += 2) {
    const body = [...syn(ns, 300), ...C, ...syn(ns + 1, 300)].join(" ");
    if (sharedFingerprints(body) === (exposed ? 1 : 0)) found.push(body);
    assert.ok(ns < startNamespace + 4000, "holder search exhausted");
  }
  return found;
}
const EXPOSED = findHolders(true, 8, 6000);
const HIDDEN = findHolders(false, 8, 2000);
let trueBody = null;
for (let ns = 110; !trueBody; ns += 2) {
  const body = [...syn(ns, 300), ...P, ...syn(ns + 1, 300)].join(" ");
  if (sharedFingerprints(body) >= 3) trueBody = body;
}
const TRUE = { id: "TRUE", body: trueBody };
const exposedHolders = (n) => EXPOSED.slice(0, n).map((body, i) => ({ id: `exposed-${i}`, body }));
const hiddenHolders = (n) => HIDDEN.slice(0, n).map((body, i) => ({ id: `hidden-${i}`, body }));

const inRange = (positions, [start, end]) => positions.filter((p) => p >= start && p <= end);
const trueSource = (result) => result.sources.find((source) => source.name === "TRUE");

/** The browser static-index semantics: postings over EVERY archive document. */
function fullPostingsReference(docs) {
  const hashSets = docs.map((doc) => archiveShingleHashes(canonicalizeText(doc.body), ARCHIVE_SHINGLE_SIZE));
  const postings = new Map();
  hashSets.forEach((set, sourceIndex) => {
    for (const hash of set) {
      const list = postings.get(hash);
      if (list) list.push(sourceIndex);
      else postings.set(hash, [sourceIndex]);
    }
  });
  return scoreAgainstArchiveDetailed(SUBMISSION, {
    shingleSize: ARCHIVE_SHINGLE_SIZE,
    documentCount: docs.length,
    maximumDocumentFrequency: INDEX_CAP,
    articles: docs.map((doc, i) => ({ title: doc.id, sourceType: "Publication", uniqueShingleCount: hashSets[i].size })),
    getPostings: (hash) => { const list = postings.get(hash); return !list || list.length > INDEX_CAP ? [] : list; },
  }, PARAMS).result;
}

// ══ fixture archives — every DB is built and every matcher run resolved before
// the first test() is registered (an interleaved top-level await races it). ══
const dbFiles = [];
async function withArchive(name, docs, runs) {
  const dbFile = path.join(process.cwd(), `test_archive_global_df_${name}.db`);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + suffix); } catch {} }
  dbFiles.push(dbFile);
  const client = createClient({ url: `file:${dbFile}` });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
    for (const [order, doc] of docs.entries()) {
      const seeded = await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.id, originalSimilarity: null, text: doc.body, archiveOrder: doc.order ?? order }, {
        corpusVersion: "test-archive-global-df-v1",
        firstSeenAt: "2020-01-01 00:00:00",
      });
      assert.equal(seeded.status, "SEEDED");
    }
    await rebuildArchiveScalableIndex(client);
    const results = {};
    for (const [key, options] of Object.entries(runs)) {
      const { matchingParameters, ...rest } = options;
      results[key] = await matchAgainstArchiveCorpus(client, SUBMISSION, {
        maximumDocumentFrequency: INDEX_CAP,
        matchingParameters: { ...PARAMS, ...matchingParameters },
        ...rest,
      });
    }
    return results;
  } finally {
    client.close();
  }
}
test.after(() => {
  for (const dbFile of dbFiles) for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + suffix); } catch {} }
});

// One archive: C has archive DF 9 (true source + 8 retrievable holders).
const FIXED_DOCS = [...exposedHolders(8), TRUE];
const LIMITS = [1, 6, 7, 9, 5000];
const FIXED = await withArchive("fixed", FIXED_DOCS, {
  ...Object.fromEntries(LIMITS.map((limit) => [`limit-${limit}`, { candidateLimit: limit }])),
  cap1: { matchingParameters: { maximumContributingSources: 1 } },
  capAll: { matchingParameters: { maximumContributingSources: null } },
});
const FIXED_REFERENCE = fullPostingsReference(FIXED_DOCS);
// The same archive with every archive_order reversed.
const REVERSED_DOCS = FIXED_DOCS.map((doc, i) => ({ ...doc, order: FIXED_DOCS.length - 1 - i }));
const REVERSED = await withArchive("reversed", REVERSED_DOCS, { all: {} });

// C has archive DF 9 throughout; only how many of its 8 holders are retrievable varies.
const RETRIEVED_COUNTS = [0, 5, 6, 8];
const OVER_CAP = {};
for (const exposed of RETRIEVED_COUNTS) {
  OVER_CAP[exposed] = (await withArchive(`over-${exposed}`, [...exposedHolders(exposed), ...hiddenHolders(8 - exposed), TRUE], { all: {} })).all;
}
// C has archive DF 5 (under the cap): retrieving its 4 holders must not remove it.
const UNDER_CAP = {
  0: (await withArchive("under-0", [...hiddenHolders(4), TRUE], { all: {} })).all,
  4: (await withArchive("under-4", [...exposedHolders(4), TRUE], { all: {} })).all,
};
// Only the ARCHIVE population changes, never retrieved: C's DF 6 (at the cap) vs 7 (over it).
const CORPUS_DF = {
  6: (await withArchive("corpus-6", [...hiddenHolders(5), TRUE], { all: {} })).all,
  7: (await withArchive("corpus-7", [...hiddenHolders(6), TRUE], { all: {} })).all,
};
const CORPUS_REFERENCE = { 6: fullPostingsReference([...hiddenHolders(5), TRUE]), 7: fullPostingsReference([...hiddenHolders(6), TRUE]) };

const unionCandidates = (result) => result.archiveDiscovery.unionCandidateCount;

test("policy identity: the archive-wide runtime DF has its own version", () => {
  assert.equal(ARCHIVE_MATCH_POLICY.runtimeDfPolicyVersion, ARCHIVE_RUNTIME_DF_POLICY_VERSION);
  assert.equal(ARCHIVE_RUNTIME_DF_POLICY_VERSION, "archive-runtime-df-global-v1");
});

test("A. candidateLimit 1 / 6 / 7 / 9 / 5000 never changes the true source's evidence, the union or the score", () => {
  assert.deepEqual(LIMITS.map((limit) => unionCandidates(FIXED[`limit-${limit}`])), [1, 6, 7, 9, 9], "precondition: the limit truncates retrieval");
  for (const limit of LIMITS) {
    const result = FIXED[`limit-${limit}`];
    assert.deepEqual(result.archiveMatchedPositions, FIXED_REFERENCE.archiveMatchedPositions, `union, candidateLimit ${limit}`);
    assert.equal(result.score, FIXED_REFERENCE.score, `score, candidateLimit ${limit}`);
    assert.deepEqual(trueSource(result).attributedRanges, trueSource(FIXED["limit-5000"]).attributedRanges, `true source, candidateLimit ${limit}`);
  }
  // C (archive DF 9 > 6) is not evidence at any limit; the rest of P is.
  assert.equal(inRange(FIXED["limit-1"].archiveMatchedPositions, P_RANGE).length, 178);
  assert.equal(FIXED["limit-1"].score, 22);
});

test("B. an extra retrieved holder of a gram never changes that gram's DF", () => {
  assert.deepEqual(RETRIEVED_COUNTS.map((n) => unionCandidates(OVER_CAP[n])), [1, 6, 7, 9], "precondition: retrieved holders vary");
  for (const n of RETRIEVED_COUNTS) {
    assert.deepEqual(OVER_CAP[n].archiveMatchedPositions, OVER_CAP[0].archiveMatchedPositions, `${n} of 8 holders retrieved`);
    assert.deepEqual(trueSource(OVER_CAP[n]).attributedRanges, trueSource(OVER_CAP[0]).attributedRanges, `true source, ${n} retrieved`);
    assert.equal(OVER_CAP[n].score, 22);
  }
  assert.deepEqual(UNDER_CAP[4].archiveDiscovery.unionCandidateCount, 5, "precondition: the 4 holders are retrieved");
  assert.deepEqual(UNDER_CAP[0].archiveMatchedPositions, UNDER_CAP[4].archiveMatchedPositions);
  assert.equal(inRange(UNDER_CAP[4].archiveMatchedPositions, C_RANGE).length, 30, "C under the cap stays evidence");
  assert.equal(UNDER_CAP[4].score, 25);
});

test("C. the archive's own DF crossing the runtime cap does change verification", () => {
  assert.equal(unionCandidates(CORPUS_DF[6]), 1, "precondition: no holder retrieved");
  assert.equal(unionCandidates(CORPUS_DF[7]), 1, "precondition: no holder retrieved");
  assert.equal(inRange(CORPUS_DF[6].archiveMatchedPositions, C_RANGE).length, 30, "archive DF 6: C is evidence");
  assert.equal(CORPUS_DF[6].score, 25);
  assert.equal(inRange(CORPUS_DF[7].archiveMatchedPositions, C_RANGE).length, 8, "archive DF 7: only C's edge words, covered by P's other grams, remain");
  assert.equal(CORPUS_DF[7].score, 22);
  for (const df of [6, 7]) {
    assert.deepEqual(CORPUS_DF[df].archiveMatchedPositions, CORPUS_REFERENCE[df].archiveMatchedPositions, `matches the full-postings scorer, DF ${df}`);
  }
});

test("D. candidate order never changes the evidence, the union or the score", () => {
  assert.deepEqual(REVERSED.all.archiveMatchedPositions, FIXED["limit-5000"].archiveMatchedPositions);
  assert.equal(REVERSED.all.score, FIXED["limit-5000"].score);
  assert.deepEqual(trueSource(REVERSED.all).attributedRanges, trueSource(FIXED["limit-5000"]).attributedRanges);
});

test("E. the display cap never changes the scoring union", () => {
  for (const key of ["cap1", "capAll"]) {
    assert.deepEqual(FIXED[key].archiveMatchedPositions, FIXED["limit-5000"].archiveMatchedPositions, key);
    assert.equal(FIXED[key].score, FIXED["limit-5000"].score, key);
  }
  assert.equal(FIXED.cap1.sources.length, 1);
});

// ══ IDF (attribution only) ════════════════════════════════════════════════
// Positions 5 and 6 of W are covered by X through grams g1/g2 and by Y through
// g3/g4. Three small holders H share g1/g2 (archive DF 4) and Z shares g3/g4
// (archive DF 2); none clears the per-source floor, so only X and Y are ever
// admitted. Retrieving H used to lower g1/g2's DF from 4 to 1 for X and hand
// position 5 to X; with the archive-wide DF the owner never depends on it.
test("F. IDF attribution uses the archive-wide DF, not the retrieved holders", () => {
  const W = syn(700, 9);
  const LX = syn(701, 40);
  const LY = syn(702, 40);
  const host = syn(703, 1500);
  const submission = [...host.slice(0, 100), ...W, ...host.slice(100, 200), ...LX, ...host.slice(200, 300), ...LY, ...host.slice(300)].join(" ");
  const filler = (ns) => syn(ns, 30).join(" ");
  const docs = {
    X: `${W.slice(0, 7).join(" ")} ${filler(710)} ${LX.join(" ")} ${filler(711)}`,
    Y: `${W.slice(3, 9).join(" ")} ${filler(712)} ${LY.join(" ")} ${filler(713)}`,
    Z: `${filler(714)} ${W.slice(3, 9).join(" ")} ${filler(715)}`,
    H0: `${filler(716)} ${W.slice(1, 7).join(" ")} ${filler(717)}`,
    H1: `${filler(718)} ${W.slice(1, 7).join(" ")} ${filler(719)}`,
    H2: `${filler(720)} ${W.slice(1, 7).join(" ")} ${filler(721)}`,
  };
  const names = Object.keys(docs);
  const hashSets = names.map((name) => archiveShingleHashes(docs[name], ARCHIVE_SHINGLE_SIZE));
  const archiveDf = (hash) => hashSets.filter((set) => set.has(hash)).length;
  const run = (retrieved, withArchiveDf) => {
    const sets = retrieved.map((name) => hashSets[names.indexOf(name)]);
    const postings = new Map();
    sets.forEach((set, sourceIndex) => {
      for (const hash of set) {
        const list = postings.get(hash);
        if (list) list.push(sourceIndex);
        else postings.set(hash, [sourceIndex]);
      }
    });
    return scoreAgainstArchiveDetailed(submission, {
      shingleSize: ARCHIVE_SHINGLE_SIZE,
      documentCount: names.length,
      maximumDocumentFrequency: INDEX_CAP,
      articles: retrieved.map((name, i) => ({ title: name, sourceType: "Publication", uniqueShingleCount: sets[i].size })),
      getPostings: (hash) => postings.get(hash) ?? [],
      ...(withArchiveDf ? { getDocumentFrequency: archiveDf } : {}),
    }, PARAMS).result;
  };
  const owners = (result) => Object.fromEntries(result.sources.map((source) => [source.name, source.attributedRanges]));
  const position5 = 100 + 5;
  const ownerOf = (result, position) => result.sources.find((source) => source.attributedRanges.some(([start, end]) => position >= start && position <= end))?.name;

  const without = run(["X", "Y", "Z"], true);
  const withHolders = run(["X", "Y", "Z", "H0", "H1", "H2"], true);
  assert.deepEqual(without.sources.map((source) => source.name).sort(), ["X", "Y"], "precondition: H and Z are never admitted");
  assert.deepEqual(withHolders.sources.map((source) => source.name).sort(), ["X", "Y"]);
  assert.deepEqual(owners(withHolders), owners(without));
  assert.deepEqual(withHolders.archiveMatchedPositions, without.archiveMatchedPositions);
  assert.equal(ownerOf(without, position5), "Y", "g3/g4 (DF 2) outweigh g1/g2 (DF 4)");

  // The retrieved-candidate DF (no getDocumentFrequency) is what used to flip it.
  assert.equal(ownerOf(run(["X", "Y", "Z"], false), position5), "X");
  assert.equal(ownerOf(run(["X", "Y", "Z", "H0", "H1", "H2"], false), position5), "Y");
});
