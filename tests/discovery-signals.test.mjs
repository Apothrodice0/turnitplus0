import assert from "node:assert/strict";
import test from "node:test";
import { generateDiscoverySignals, DEFAULT_DISCOVERY_SIGNAL_CONFIG } from "../lib/discovery-signals.ts";
import { generateDiscoveryQueries, DEFAULT_QUERY_GENERATION_CONFIG } from "../lib/discovery-query-generation.ts";
import { normalize } from "../lib/similarity-core.ts";

const DISTINCTIVE_TEXT = "Marine biologists tracking bioluminescent plankton blooms along a temperate coastline recorded synchronized flashing patterns correlated with lunar illumination cycles. Underwater camera arrays deployed across multiple depths captured flash-rate variations that intensified sharply during new-moon periods when ambient light was lowest. Researchers proposed that the synchronized bioluminescence functions as a predator-confusion mechanism rather than a simple startle reflex.";

// Every word here is either shorter than four characters or present in
// lib/similarity-core.ts's COMMON_WORDS set, so every candidate window's
// informativeCount is guaranteed to be 0 regardless of window position.
const FILLER_TEXT = Array.from({ length: 6 }, () =>
  "the a an is was are be to of in on at by for and or with as that this which le la les des une un et de du en",
).join(" ");

// --- SIGNALS -------------------------------------------------------------

test("SIGNALS: generateDiscoverySignals is deterministic — identical input produces identical output", () => {
  const input = { title: "The Rise of Bioluminescent Research", author: "J. Rivers", rawText: DISTINCTIVE_TEXT };
  const first = generateDiscoverySignals(input);
  const second = generateDiscoverySignals(input);
  assert.deepEqual(first, second);
});

test("SIGNALS: title/author normalization reuses lib/similarity-core.ts's normalize()", () => {
  const signals = generateDiscoverySignals({ title: "  The Rise, of Bioluminescent Research!  ", author: "J. Rivers", rawText: DISTINCTIVE_TEXT });
  assert.equal(signals.normalizedTitle, normalize("  The Rise, of Bioluminescent Research!  "));
  assert.equal(signals.normalizedAuthor, normalize("J. Rivers"));
});

test("SIGNALS: missing title/author normalize to null, not empty string", () => {
  const signals = generateDiscoverySignals({ title: null, author: undefined, rawText: DISTINCTIVE_TEXT });
  assert.equal(signals.normalizedTitle, null);
  assert.equal(signals.normalizedAuthor, null);
});

test("SIGNALS: distinctive passages are extracted from genuinely distinctive text", () => {
  const signals = generateDiscoverySignals({ title: null, author: null, rawText: DISTINCTIVE_TEXT });
  assert.ok(signals.distinctivePassages.length > 0, "distinctive scientific prose must yield at least one passage");
  for (const passage of signals.distinctivePassages) {
    const wordCount = passage.split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount <= DEFAULT_DISCOVERY_SIGNAL_CONFIG.passageWindowWords, `passage "${passage}" exceeds the configured window size`);
  }
});

test("SIGNALS: common/generic filler text is suppressed entirely — no distinctive passages", () => {
  const signals = generateDiscoverySignals({ title: null, author: null, rawText: FILLER_TEXT });
  assert.deepEqual(signals.distinctivePassages, [], "a document built entirely from common/short words must produce zero distinctive passages");
});

test("SIGNALS: a mix of filler and one distinctive sentence surfaces the distinctive part, not the filler", () => {
  const mixed = `${FILLER_TEXT} Marine biologists tracking bioluminescent plankton blooms recorded synchronized flashing patterns. ${FILLER_TEXT}`;
  const signals = generateDiscoverySignals({ title: null, author: null, rawText: mixed });
  assert.ok(signals.distinctivePassages.length > 0);
  assert.ok(
    signals.distinctivePassages.some((p) => /bioluminescent/i.test(p)),
    "at least one selected passage must come from the distinctive sentence, not purely from the surrounding filler",
  );
});

test("SIGNALS: the number of distinctive passages is bounded even for a very large document", () => {
  const huge = Array.from({ length: 80 }, (_, i) => `${DISTINCTIVE_TEXT} Observation cycle number ${i} recorded independently.`).join(" ");
  const signals = generateDiscoverySignals({ title: null, author: null, rawText: huge });
  assert.ok(signals.distinctivePassages.length <= DEFAULT_DISCOVERY_SIGNAL_CONFIG.maxPassages);
  assert.equal(signals.distinctivePassages.length, DEFAULT_DISCOVERY_SIGNAL_CONFIG.maxPassages, "plenty of distinctive material exists, so the cap itself should be the limiting factor");
});

test("SIGNALS: no full-document leakage — total signal text stays small regardless of document size", () => {
  const huge = Array.from({ length: 200 }, (_, i) => `${DISTINCTIVE_TEXT} Observation cycle number ${i} recorded independently.`).join(" ");
  const signals = generateDiscoverySignals({ title: null, author: null, rawText: huge });
  const totalSignalChars = signals.distinctivePassages.reduce((sum, p) => sum + p.length, 0);
  assert.ok(totalSignalChars < 2000, `total signal text (${totalSignalChars} chars) must stay small regardless of document size (${huge.length} chars)`);
  assert.ok(totalSignalChars < huge.length / 20, "signals must be a small fraction of the source document, not a near-copy of it");
});

test("SIGNALS: canonicalHash is passed through unchanged, never derived from rawText internally", () => {
  const signals = generateDiscoverySignals({ title: null, author: null, rawText: DISTINCTIVE_TEXT, canonicalHash: "deadbeef" });
  assert.equal(signals.canonicalHash, "deadbeef");
  const withoutHash = generateDiscoverySignals({ title: null, author: null, rawText: DISTINCTIVE_TEXT });
  assert.equal(withoutHash.canonicalHash, null);
});

test("SIGNALS: language is detected consistently with the rest of the codebase", () => {
  const signals = generateDiscoverySignals({ title: null, author: null, rawText: DISTINCTIVE_TEXT });
  assert.equal(signals.language, "English");
});

// --- QUERIES ---------------------------------------------------------------

test("QUERIES: generateDiscoveryQueries is deterministic — same signals always produce the same queries", () => {
  const signals = generateDiscoverySignals({ title: "A Title", author: "An Author", rawText: DISTINCTIVE_TEXT });
  const first = generateDiscoveryQueries(signals);
  const second = generateDiscoveryQueries(signals);
  assert.deepEqual(first, second);
});

test("QUERIES: the number of generated queries is bounded by maxQueries", () => {
  const manyPassageSignals = {
    normalizedTitle: null,
    normalizedAuthor: null,
    distinctivePassages: Array.from({ length: 12 }, (_, i) => `distinctive passage number ${i}`),
    canonicalHash: null,
    language: "English",
  };
  const queries = generateDiscoveryQueries(manyPassageSignals);
  assert.equal(queries.length, DEFAULT_QUERY_GENERATION_CONFIG.maxQueries);
  assert.deepEqual(queries.map((q) => q.rank), [0, 1, 2, 3, 4, 5]);
});

test("QUERIES: title alone is never sufficient — no query is generated from title with no author and no distinctive passages", () => {
  const signals = { normalizedTitle: "some title", normalizedAuthor: null, distinctivePassages: [], canonicalHash: null, language: null };
  const queries = generateDiscoveryQueries(signals);
  assert.deepEqual(queries, [], "a title alone must never produce a query");
});

test("QUERIES: author alone is never sufficient — no query is generated from author with no title and no distinctive passages", () => {
  const signals = { normalizedTitle: null, normalizedAuthor: "some author", distinctivePassages: [], canonicalHash: null, language: null };
  const queries = generateDiscoveryQueries(signals);
  assert.deepEqual(queries, [], "an author alone must never produce a query");
});

test("QUERIES: title and author together DO produce one combined query, never split into two", () => {
  const signals = { normalizedTitle: "some title", normalizedAuthor: "some author", distinctivePassages: [], canonicalHash: null, language: null };
  const queries = generateDiscoveryQueries(signals);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].basis, ["TITLE", "AUTHOR"]);
  assert.match(queries[0].queryText, /some title/);
  assert.match(queries[0].queryText, /some author/);
});

test("QUERIES: no query ever has a basis of exactly [\"TITLE\"] or exactly [\"AUTHOR\"]", () => {
  const signals = generateDiscoverySignals({ title: "A Title About Bioluminescence", author: "J. Rivers", rawText: DISTINCTIVE_TEXT });
  const queries = generateDiscoveryQueries(signals);
  assert.ok(queries.length > 0, "the fixture should actually generate some queries for this test to mean anything");
  for (const query of queries) {
    assert.notDeepEqual(query.basis, ["TITLE"]);
    assert.notDeepEqual(query.basis, ["AUTHOR"]);
  }
});

test("QUERIES: distinctive passages are never dropped in favor of a title/author query — both coexist, passages ranked first", () => {
  const signals = generateDiscoverySignals({ title: "A Title", author: "An Author", rawText: DISTINCTIVE_TEXT });
  const queries = generateDiscoveryQueries(signals);
  const passageQueries = queries.filter((q) => q.basis.includes("DISTINCTIVE_PASSAGE"));
  const titleAuthorQueries = queries.filter((q) => q.basis.includes("TITLE"));
  assert.ok(passageQueries.length > 0);
  assert.equal(titleAuthorQueries.length, 1);
  assert.ok(passageQueries[0].rank < titleAuthorQueries[0].rank, "distinctive passages must rank ahead of the title/author query");
});
