import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { aggregateSimilaritySources, gramHash, grams, tokens } from "../lib/similarity-core.ts";
import { scoreAgainstArchive } from "../lib/archive-similarity-scoring.ts";
import { ARCHIVE_SHINGLE_SIZE, archiveShingleHashes } from "../lib/archive-fingerprint.ts";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";
import { frameArchiveResult } from "../lib/archive-result-framing.ts";

/**
 * Archive scoring under corpus growth: the score is the union of every
 * verified position of every ADMITTED source (its own evidence passes the
 * per-source floor, measured before attribution). The contributing-source cap
 * and winner-take-all attribution only decide what is listed, and under which
 * source; neither can remove a verified position. For a fixed candidate set,
 * adding a source can therefore only add positions. Synthetic fixtures only.
 */

const syn = (ns, n) => [...Array(n).keys()].map((i) => `zq${ns}x${i.toString(36)}v`); // informative, unique
const PARAMS = { minimumMatchedWords: 5, maximumDocumentFrequency: 6, minimumSourceContribution: 0.5, maximumContributingSources: 10, sourceWeighting: "raw" };

/** An in-memory archive over explicit source texts, built the way scoreOverCandidates builds one. */
function memoryIndex(sourceTexts, { documentCount = sourceTexts.length, titles = sourceTexts.map((_, index) => `source-${index}`) } = {}) {
  const hashSets = sourceTexts.map((text) => archiveShingleHashes(text, ARCHIVE_SHINGLE_SIZE));
  const postings = new Map();
  hashSets.forEach((set, sourceIndex) => {
    for (const hash of set) {
      const list = postings.get(hash);
      if (list) list.push(sourceIndex);
      else postings.set(hash, [sourceIndex]);
    }
  });
  return {
    shingleSize: ARCHIVE_SHINGLE_SIZE,
    documentCount,
    maximumDocumentFrequency: 12,
    articles: sourceTexts.map((_, index) => ({ title: titles[index], sourceType: "Publication", uniqueShingleCount: hashSets[index].size })),
    getPostings: (hash) => postings.get(hash) ?? [],
  };
}
/** Submission = host filler + each passage separated by host filler; returns word ranges per passage. */
function compose(passages, hostNamespace) {
  const words = [];
  const ranges = [];
  let host = 0;
  const hostWords = syn(hostNamespace, 40 * (passages.length + 1));
  const pushHost = () => { words.push(...hostWords.slice(host, host + 40)); host += 40; };
  pushHost();
  for (const passage of passages) {
    ranges.push([words.length, words.length + passage.length - 1]);
    words.push(...passage);
    pushHost();
  }
  return { text: words.join(" "), ranges };
}
const range = ([start, end]) => [...Array(end - start + 1).keys()].map((k) => start + k);
const titlesOf = (result) => result.sources.map((source) => source.name);
const listedWords = (result) => Object.fromEntries(result.sources.map((source) => [source.name, source.matchedWords]));
const missingFrom = (before, after) => {
  const kept = new Set(after.archiveMatchedPositions);
  return before.archiveMatchedPositions.filter((position) => !kept.has(position));
};

// 12 sources, each holding one distinct passage (120, 115, ..., 65 words) plus its own filler.
const PASSAGES = [...Array(12).keys()].map((i) => syn(200 + i, 120 - 5 * i));
const SOURCE_TEXTS = PASSAGES.map((passage, i) => `${passage.join(" ")} ${syn(300 + i, 400).join(" ")}`);
const SOURCE_TITLES = SOURCE_TEXTS.map((_, index) => `source-${index}`);
const TWELVE = compose(PASSAGES, 900);

// ══ matcher fixture (synthetic archive DB) ══════════════════════════════════
// All top-level DB setup and matcher runs resolve BEFORE the first test() is
// registered (node:test runs a registered test immediately; an interleaved
// top-level await races it — CLIENT_CLOSED).
const INSERTS = ["notably", "moreover", "arguably", "crucially", "evidently", "admittedly", "incidentally", "seemingly"];
// The first sentence is copied verbatim (discovery finds the source, and its
// rare grams become extension seeds); the second, with function-word
// stretches, gets an insertion after every fifth word, so its uninformative
// islands are recoverable only by the span extension.
const VERBATIM_SENTENCE = "Groundwater recharge beneath the Saharan piedmont was reconstructed from chloride profiles collected along twelve boreholes, and it was clear that most of it came from episodic flash floods rather than diffuse rainfall.";
const EDITED_SENTENCE = "Fossil aquifer layers remained hydraulically isolated from the shallow alluvial system, so that in the end all of the modern recharge was confined to the upper horizon, and it was clear that most of it came from the flood years.";
const EDITED_SOURCE_PASSAGE = `${VERBATIM_SENTENCE} ${EDITED_SENTENCE}`;
const EDITED_WORDS = tokens(EDITED_SOURCE_PASSAGE);
const EDITED_COPY = [
  ...tokens(VERBATIM_SENTENCE),
  ...tokens(EDITED_SENTENCE).flatMap((word, i) => ((i + 1) % 5 === 0 ? [word, INSERTS[i % INSERTS.length]] : [word])),
];
const BIG = [...Array(10).keys()].map((i) => syn(400 + i, 160 - 5 * i));
const MATCHER_DOCS = [
  ...BIG.map((passage, i) => ({ id: `big-${i}`, title: `Big Source ${i}`, body: `${passage.join(" ")} ${syn(500 + i, 400).join(" ")}` })),
  { id: "edited", title: "Edited Source", body: `${syn(520, 300).join(" ")} ${EDITED_SOURCE_PASSAGE} ${syn(521, 300).join(" ")}` },
];
const HOST = syn(530, 1200);
// the edited copy first, so its grams are the first the fallback resolves
const MATCHER_TEXT = [...HOST.slice(0, 40), ...EDITED_COPY, ...BIG.flatMap((passage, i) => [...HOST.slice(40 + 40 * i, 80 + 40 * i), ...passage]), ...HOST.slice(500, 540)].join(" ");
const EDITED_REGION = [40, 40 + EDITED_COPY.length - 1];

const dbFile = path.join(process.cwd(), "test_archive_stable_union.db");
for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + suffix); } catch {} }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + suffix); } catch {} }
});
for (const [order, doc] of MATCHER_DOCS.entries()) {
  const seeded = await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.title, originalSimilarity: null, text: doc.body, archiveOrder: order }, {
    corpusVersion: "test-stable-union-v1",
    firstSeenAt: "2020-01-01 00:00:00",
  });
  assert.equal(seeded.status, "SEEDED");
}
await rebuildArchiveScalableIndex(client);
const canonicalTexts = (await client.execute("SELECT canonical_text FROM corpus_document_representations")).rows.map((row) => String(row.canonical_text));

function recording(inner) {
  const calls = [];
  return {
    calls,
    async execute(stmt) {
      calls.push(typeof stmt === "string" ? stmt : { sql: stmt.sql, args: (stmt.args ?? []).map(String) });
      return inner.execute(stmt);
    },
  };
}
async function runMatcher(maximumContributingSources, extra = {}) {
  const recorder = recording(client);
  const result = await matchAgainstArchiveCorpus(recorder, MATCHER_TEXT, {
    maximumDocumentFrequency: 12,
    matchingParameters: { ...PARAMS, maximumContributingSources },
    ...extra,
  });
  return { result, calls: recorder.calls };
}
const capped = await runMatcher(10);
const cappedOne = await runMatcher(1);
const uncappedRun = await runMatcher(null);
const exactOnly = await runMatcher(10, { spanExtension: false });

// ══ growth: adding a source to a fixed candidate set ═════════════════════════
test("1. adding an irrelevant source changes nothing", () => {
  const before = scoreAgainstArchive(TWELVE.text, memoryIndex(SOURCE_TEXTS), PARAMS);
  const irrelevant = syn(777, 500).join(" ");
  const appended = scoreAgainstArchive(TWELVE.text, memoryIndex([...SOURCE_TEXTS, irrelevant], { titles: [...SOURCE_TITLES, "irrelevant"] }), PARAMS);
  // inserted first: every existing source's index shifts by one
  const prepended = scoreAgainstArchive(TWELVE.text, memoryIndex([irrelevant, ...SOURCE_TEXTS], { titles: ["irrelevant", ...SOURCE_TITLES] }), PARAMS);
  // a far larger archive around the same candidates (only the IDF basis moves)
  const larger = scoreAgainstArchive(TWELVE.text, memoryIndex(SOURCE_TEXTS, { documentCount: 100_000 }), PARAMS);
  for (const after of [appended, prepended, larger]) {
    assert.deepEqual(after.archiveMatchedPositions, before.archiveMatchedPositions);
    assert.equal(after.score, before.score);
    assert.deepEqual(listedWords(after), listedWords(before));
    assert.deepEqual(titlesOf(after), titlesOf(before));
  }
});

test("2. duplicate or alias evidence cannot inflate the score", () => {
  const passage = syn(240, 60);
  const sourceText = `${passage.join(" ")} ${syn(241, 400).join(" ")}`;
  const { text, ranges } = compose([passage], 903);
  const single = scoreAgainstArchive(text, memoryIndex([sourceText]), PARAMS);
  assert.deepEqual(single.archiveMatchedPositions, range(ranges[0]));
  for (const copies of [2, 3]) {
    const aliased = scoreAgainstArchive(text, memoryIndex(Array(copies).fill(sourceText)), PARAMS);
    assert.deepEqual(aliased.archiveMatchedPositions, single.archiveMatchedPositions);
    assert.equal(aliased.score, single.score);
    // each position is counted once and listed under exactly one source
    assert.equal(aliased.matchedWordCount, single.matchedWordCount);
    assert.equal(aliased.sources.reduce((total, source) => total + source.matchedWords, 0), aliased.matchedWordCount);
  }

  // aggregation level: two sources with the same ten positions score ten words, not twenty
  const twin = (sourceIndex) => ({ sourceIndex, positions: new Set(range([0, 9])), containment: 0.1 });
  const twins = aggregateSimilaritySources([twin(0), twin(1)], 100, PARAMS, 5);
  assert.equal(twins.score, 10);
  assert.equal(twins.matchedWordEquivalent, 10);
  assert.equal(twins.acceptedPositions.size, 10);
  assert.equal(twins.admittedSources.reduce((total, source) => total + source.attributedPositions.size, 0), 10);
});

test("3. a better source over already-matched positions leaves the score unchanged", () => {
  // The old source holds P2 + P3. The new one holds only P2 and wins every
  // position of it, leaving the old source an 8-word share: under the 5% floor
  // as a share, far over it as the source's own evidence (68 words).
  const P2 = syn(271, 60);
  const P3 = syn(272, 8);
  const hostA = syn(273, 180);
  const hostB = syn(274, 150);
  const text = [...hostA, ...P2, ...P3, ...hostB].join(" ");
  const oldSource = `${syn(276, 400).join(" ")} ${P2.join(" ")} ${P3.join(" ")}`;
  const betterSource = `${P2.join(" ")} ${syn(275, 400).join(" ")}`;
  const floor = { ...PARAMS, minimumSourceContribution: 5 };
  const before = scoreAgainstArchive(text, memoryIndex([oldSource], { titles: ["old"] }), floor);
  const after = scoreAgainstArchive(text, memoryIndex([betterSource, oldSource], { titles: ["better", "old"] }), floor);
  assert.deepEqual(before.archiveMatchedPositions, range([hostA.length, hostA.length + P2.length + P3.length - 1]));
  assert.deepEqual(after.archiveMatchedPositions, before.archiveMatchedPositions);
  assert.equal(after.score, before.score);
  const oldShare = listedWords(after).old;
  assert.ok(oldShare > 0 && (oldShare / tokens(text).length) * 100 < 5, "the old source's attributed share is under the floor");
  assert.equal(listedWords(before).old, P2.length + P3.length);

  // aggregation level: B overlaps A for 20 positions it loses on weight; alone it keeps 5
  const A = { sourceIndex: 0, positions: new Set(range([0, 39])), containment: 0.2, attributionWeights: new Map(range([0, 39]).map((p) => [p, 2])) };
  const B = { sourceIndex: 1, positions: new Set([...range([20, 39]), ...range([100, 104])]), containment: 0.1, attributionWeights: new Map([...range([20, 39]), ...range([100, 104])].map((p) => [p, 1])) };
  const onePercent = { ...PARAMS, minimumSourceContribution: 1 }; // 10 of 1000 words
  const bAlone = aggregateSimilaritySources([B], 1000, onePercent, 5);
  const both = aggregateSimilaritySources([A, B], 1000, onePercent, 5);
  const bInBoth = both.admittedSources.find((source) => source.sourceIndex === 1);
  assert.ok(bInBoth, "B's own 25 positions pass the 10-word floor");
  assert.equal(bInBoth.attributedPositions.size, 5, "its winner-take-all share alone (5) would not have");
  for (const position of bAlone.acceptedPositions) assert.ok(both.acceptedPositions.has(position), `adding A must not remove B's position ${position}`);
  assert.equal(both.acceptedPositions.size, 45);
});

// one more source than the display cap: ten old sources, then a strong new one
const STRONG = syn(250, 200);
const ELEVEN = compose([...PASSAGES.slice(0, 10), STRONG], 901);
const TEN_SOURCES = SOURCE_TEXTS.slice(0, 10);
const WITH_STRONG = [...TEN_SOURCES, `${STRONG.join(" ")} ${syn(350, 400).join(" ")}`];

test("4. a source covering new positions never lowers the score", () => {
  const before = scoreAgainstArchive(ELEVEN.text, memoryIndex(TEN_SOURCES), PARAMS);
  const after = scoreAgainstArchive(ELEVEN.text, memoryIndex(WITH_STRONG), PARAMS);
  assert.deepEqual(missingFrom(before, after), [], "no verified position removed");
  assert.deepEqual(after.archiveMatchedPositions.filter((position) => !before.archiveMatchedPositions.includes(position)), range(ELEVEN.ranges[10]));
  assert.ok(after.score > before.score);
});

test("5. a new source that outranks an old useful source takes its display slot, never its positions", () => {
  const before = scoreAgainstArchive(ELEVEN.text, memoryIndex(TEN_SOURCES), PARAMS);
  const after = scoreAgainstArchive(ELEVEN.text, memoryIndex(WITH_STRONG), PARAMS);
  assert.equal(titlesOf(after)[0], "source-10", "the new source ranks first");
  assert.ok(titlesOf(before).includes("source-9"));
  assert.ok(!titlesOf(after).includes("source-9"), "the old rank-10 source is no longer listed");
  const kept = new Set(after.archiveMatchedPositions);
  for (const position of range(ELEVEN.ranges[9])) assert.ok(kept.has(position), `position ${position} of the displaced source still scores`);
});

// ══ display cap, attribution and order ═══════════════════════════════════════
test("6. display cap 1 / 10 / unlimited give the identical union and headline", () => {
  const index = memoryIndex(SOURCE_TEXTS);
  const config = {
    scoreBands: [{ label: "Low", minimum: 0, maximum: 5 }, { label: "Moderate", minimum: 6, maximum: 15 }, { label: "High", minimum: 16, maximum: 100 }],
    corpusVersion: "test",
    risk: { targetThreshold: 15, archiveCutoff: 8, auc: 0.7867, precision: 0.4955, recall: 0.7746, sampleSize: 284 },
  };
  const allPassagePositions = TWELVE.ranges.flatMap(range);
  const unlimited = scoreAgainstArchive(TWELVE.text, index, { ...PARAMS, maximumContributingSources: null });
  assert.deepEqual(unlimited.archiveMatchedPositions, allPassagePositions);
  assert.equal(unlimited.sources.length, 12);
  for (const cap of [1, 3, 10]) {
    const result = scoreAgainstArchive(TWELVE.text, index, { ...PARAMS, maximumContributingSources: cap });
    assert.deepEqual(result.archiveMatchedPositions, allPassagePositions);
    assert.equal(result.matchedWordCount, unlimited.matchedWordCount);
    assert.equal(result.score, unlimited.score);
    // only the returned list is bounded
    assert.equal(result.sources.length, cap);
    const framed = frameArchiveResult(TWELVE.text, result, config);
    assert.equal(framed.sources.length, cap);
    assert.equal(framed.score, unlimited.score);
  }
  // ranks 11 and 12 (the two smallest passages) are not listed at cap 10, but they score
  const capped10 = scoreAgainstArchive(TWELVE.text, index, PARAMS);
  assert.ok(!titlesOf(capped10).includes("source-10") && !titlesOf(capped10).includes("source-11"));
});

test("7. a change of attribution owner leaves the union unchanged", () => {
  // Two sources share a passage (exact ties there); each also has its own passage.
  const shared = syn(260, 60);
  const ownA = syn(261, 30);
  const ownB = syn(262, 20);
  const textA = `${shared.join(" ")} ${ownA.join(" ")} ${syn(263, 400).join(" ")}`;
  const textB = `${ownB.join(" ")} ${shared.join(" ")} ${syn(264, 400).join(" ")}`;
  const { text } = compose([shared, ownA, ownB], 902);
  const aFirst = scoreAgainstArchive(text, memoryIndex([textA, textB], { titles: ["A", "B"] }), PARAMS);
  const bFirst = scoreAgainstArchive(text, memoryIndex([textB, textA], { titles: ["B", "A"] }), PARAMS);
  // the shared passage is listed under whichever source sits first
  assert.deepEqual(listedWords(aFirst), { A: 90, B: 20 });
  assert.deepEqual(listedWords(bFirst), { B: 80, A: 30 });
  assert.deepEqual(aFirst.archiveMatchedPositions, bFirst.archiveMatchedPositions);
  assert.equal(aFirst.score, bFirst.score);

  // the same at the aggregation level: flipping the attribution weights moves ownership only
  const evidence = (weightA, weightB) => [
    { sourceIndex: 0, positions: new Set([0, 1, 2, 3, 4, 5, 6, 7]), containment: 0.1, attributionWeights: new Map([...Array(8).keys()].map((p) => [p, weightA])) },
    { sourceIndex: 1, positions: new Set([4, 5, 6, 7, 8, 9, 10, 11]), containment: 0.1, attributionWeights: new Map([...Array(8).keys()].map((p) => [p + 4, weightB])) },
  ];
  const zeroWins = aggregateSimilaritySources(evidence(2, 1), 100, PARAMS, 5);
  const oneWins = aggregateSimilaritySources(evidence(1, 2), 100, PARAMS, 5);
  assert.deepEqual([...zeroWins.acceptedPositions], [...oneWins.acceptedPositions]);
  assert.equal(zeroWins.score, 12);
  assert.equal(oneWins.score, 12);
  const attributed = (result, sourceIndex) => result.admittedSources.find((source) => source.sourceIndex === sourceIndex).attributedPositions.size;
  assert.deepEqual([attributed(zeroWins, 0), attributed(zeroWins, 1)], [8, 4]);
  assert.deepEqual([attributed(oneWins, 0), attributed(oneWins, 1)], [4, 8]);
});

test("8. source insertion order does not change the score", () => {
  const reference = scoreAgainstArchive(TWELVE.text, memoryIndex(SOURCE_TEXTS), PARAMS);
  const orders = [
    [...Array(12).keys()].reverse(),
    [...Array(12).keys()].map((i) => (i + 5) % 12),
    [7, 2, 11, 0, 9, 4, 1, 10, 6, 3, 8, 5],
  ];
  for (const order of orders) {
    const result = scoreAgainstArchive(TWELVE.text, memoryIndex(order.map((i) => SOURCE_TEXTS[i]), { titles: order.map((i) => SOURCE_TITLES[i]) }), PARAMS);
    assert.deepEqual(result.archiveMatchedPositions, reference.archiveMatchedPositions);
    assert.equal(result.score, reference.score);
    // these sources do not overlap, so the listed sources and their order hold as well
    assert.deepEqual(titlesOf(result), titlesOf(reference));
    assert.deepEqual(listedWords(result), listedWords(reference));
  }

  // overlapping sources, evidence handed to the aggregation in either order
  const X = { sourceIndex: 3, positions: new Set(range([0, 19])), containment: 0.3 };
  const Y = { sourceIndex: 8, positions: new Set(range([10, 34])), containment: 0.2 };
  const forward = aggregateSimilaritySources([X, Y], 200, PARAMS, 5);
  const backward = aggregateSimilaritySources([Y, X], 200, PARAMS, 5);
  assert.deepEqual([...backward.acceptedPositions].sort((left, right) => left - right), [...forward.acceptedPositions].sort((left, right) => left - right));
  assert.equal(backward.score, forward.score);
  assert.deepEqual(backward.sourceContributions.map((source) => [source.sourceIndex, source.attributedPositions.size]), forward.sourceContributions.map((source) => [source.sourceIndex, source.attributedPositions.size]));
});

test("9. exact ties are deterministic and never reach the score", () => {
  // Position 10 is covered by X's grams with DFs (1, 1, 2) and Y's with (2, 1, 1), in document order.
  const words = syn(280, 20);
  const gramAt = (start) => gramHash(words.slice(start, start + 5).join(" "));
  const X = 1;
  const Y = 0;
  const postings = new Map([[gramAt(6), [X]], [gramAt(7), [X]], [gramAt(8), [Y, X]], [gramAt(9), [Y]], [gramAt(10), [Y]]]);
  const idf = (N, df) => Math.log((N + 1) / (df + 1)) + 1;
  const documentOrderDiffers = (N) => (idf(N, 1) + idf(N, 1)) + idf(N, 2) !== (idf(N, 2) + idf(N, 1)) + idf(N, 1);
  assert.ok(documentOrderDiffers(769) && !documentOrderDiffers(770), "the fixture is float-order sensitive");
  const owners = new Set();
  for (let N = 2; N <= 2000; N += 1) {
    const result = scoreAgainstArchive(words.join(" "), {
      shingleSize: 5,
      documentCount: N,
      maximumDocumentFrequency: 12,
      articles: [{ title: "Y", sourceType: "Publication", uniqueShingleCount: 1000 }, { title: "X", sourceType: "Publication", uniqueShingleCount: 1000 }],
      getPostings: (hash) => postings.get(hash) ?? [],
    }, PARAMS);
    assert.deepEqual(result.archiveMatchedPositions, range([6, 14]));
    assert.equal(result.score, 45);
    owners.add(result.sources.map((source) => `${source.name}:${source.matchedWords}`).join(","));
  }
  // the exact tie at position 10 always goes to the lower sourceIndex (Y)
  assert.deepEqual([...owners], ["Y:5,X:4"]);
});

test("10. no position is matched without a verified, admitted source", () => {
  // nothing retrieved, nothing matched
  assert.deepEqual(scoreAgainstArchive(TWELVE.text, memoryIndex([]), PARAMS).archiveMatchedPositions, []);
  // a source that is the submission itself is excluded and verifies nothing
  const self = scoreAgainstArchive(TWELVE.text, memoryIndex([TWELVE.text]), PARAMS);
  assert.equal(self.excludedDocuments, 1);
  assert.deepEqual(self.archiveMatchedPositions, []);
  // a source under the floor holds verbatim text and still contributes no position:
  // at 5% of 1,630 words the four smallest passages (80, 75, 70, 65 words) are not admitted
  const strict = scoreAgainstArchive(TWELVE.text, memoryIndex(SOURCE_TEXTS), { ...PARAMS, minimumSourceContribution: 5, maximumContributingSources: null });
  assert.equal(tokens(TWELVE.text).length, 1630);
  assert.deepEqual(strict.archiveMatchedPositions, TWELVE.ranges.slice(0, 8).flatMap(range));
  assert.deepEqual(titlesOf(strict).sort(), SOURCE_TITLES.slice(0, 8).sort());

  // matcher: every exact position is a verbatim 5-gram of a retrieved source text;
  // the span extension adds copied source tokens only, never an inserted word
  const query = tokens(MATCHER_TEXT);
  const sourceGrams = new Set(canonicalTexts.flatMap((text) => grams(tokens(text), 5)));
  const covered = new Set();
  grams(query, 5).forEach((gram, start) => { if (sourceGrams.has(gram)) for (let k = 0; k < 5; k += 1) covered.add(start + k); });
  for (const position of exactOnly.result.archiveMatchedPositions) assert.ok(covered.has(position), `exact position ${position} is verbatim source text`);
  const exact = new Set(exactOnly.result.archiveMatchedPositions);
  for (const position of capped.result.archiveMatchedPositions) {
    if (exact.has(position)) continue;
    assert.ok(!INSERTS.includes(query[position]), `inserted word at ${position} never scores`);
    assert.ok(EDITED_WORDS.includes(query[position]));
  }
  for (const position of exact) assert.ok(capped.result.archiveMatchedPositions.includes(position), "extension is additive");
});

// ══ matcher integration ═══════════════════════════════════════════════════════
test("the phrase fallback and every archive query are independent of the display cap", () => {
  assert.deepEqual(cappedOne.calls, capped.calls);
  assert.deepEqual(uncappedRun.calls, capped.calls);
  assert.deepEqual(cappedOne.result.archiveDiscovery, capped.result.archiveDiscovery);
  assert.deepEqual(uncappedRun.result.archiveDiscovery, capped.result.archiveDiscovery);
  assert.deepEqual(cappedOne.result.archiveMatchedPositions, capped.result.archiveMatchedPositions);
  assert.deepEqual(uncappedRun.result.archiveMatchedPositions, capped.result.archiveMatchedPositions);
  assert.equal(cappedOne.result.score, capped.result.score);
  assert.equal(uncappedRun.result.score, capped.result.score);
  assert.deepEqual([cappedOne.result.sources.length, capped.result.sources.length, uncappedRun.result.sources.length], [1, 10, 11]);
});

test("the span extension runs for an admitted source ranked outside the displayed top 10", () => {
  assert.ok(!titlesOf(capped.result).includes("Edited Source"), "the edited source is ranked 11th");
  assert.ok(titlesOf(uncappedRun.result).includes("Edited Source"));
  const exact = new Set(exactOnly.result.archiveMatchedPositions);
  const added = capped.result.archiveMatchedPositions.filter((position) => !exact.has(position));
  assert.ok(added.length > 0, "extension added positions");
  assert.ok(capped.result.archiveSpanExtension.addedPositionCount === added.length);
  for (const position of added) assert.ok(position >= EDITED_REGION[0] && position <= EDITED_REGION[1], `added position ${position} lies in the edited copy`);
  assert.deepEqual(capped.result.archiveSpanExtension, uncappedRun.result.archiveSpanExtension);
  assert.deepEqual(cappedOne.result.archiveSpanExtension, capped.result.archiveSpanExtension);
  assert.equal(capped.result.score, uncappedRun.result.score);
});
