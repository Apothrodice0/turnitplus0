import assert from "node:assert/strict";
import test from "node:test";
import { extractCandidatePhrases, DEFAULT_PHRASE_EXTRACTION_CONFIG } from "../lib/academic-search/phrase-extractor.ts";

const DISTINCTIVE_SENTENCE =
  "Photosynthetic efficiency in high-altitude alpine flora demonstrates unexpected resilience under prolonged ultraviolet radiation exposure.";
const GENERIC_SHORT_SENTENCE = "This is nice.";
const SHORT_BUT_DISTINCTIVE = "Mitochondrial biogenesis diverges.";

test("returns [] for empty input", () => {
  assert.deepEqual(extractCandidatePhrases(""), []);
  assert.deepEqual(extractCandidatePhrases("   \n\n  "), []);
});

test("rejects a generic short sentence with fewer than minInformativeWords informative words", () => {
  const queries = extractCandidatePhrases(`${GENERIC_SHORT_SENTENCE} ${DISTINCTIVE_SENTENCE}`);
  assert.ok(!queries.some((q) => q.queryText.toLowerCase().includes("this is nice")));
});

test("rejects a sentence shorter than minWordsPerPhrase even if informative", () => {
  const queries = extractCandidatePhrases(`${SHORT_BUT_DISTINCTIVE} ${DISTINCTIVE_SENTENCE}`);
  assert.ok(!queries.some((q) => q.queryText === SHORT_BUT_DISTINCTIVE));
});

test("includes a long, lexically distinctive sentence", () => {
  const queries = extractCandidatePhrases(`${GENERIC_SHORT_SENTENCE} ${DISTINCTIVE_SENTENCE}`);
  assert.ok(queries.some((q) => q.queryText.includes("Photosynthetic efficiency")));
});

test("caps output at maxQueries even for a document with many distinctive sentences", () => {
  const sentences = Array.from(
    { length: 40 },
    (_, i) => `Distinctive terminology cluster number ${i} exhibits unusually specific vocabulary combinations rarely observed elsewhere.`,
  );
  const queries = extractCandidatePhrases(sentences.join(" "));
  assert.ok(queries.length <= DEFAULT_PHRASE_EXTRACTION_CONFIG.maxQueries);
  assert.ok(queries.length >= DEFAULT_PHRASE_EXTRACTION_CONFIG.minQueries, "a long, uniformly distinctive document should reach the target minimum");
});

test("chunks an overlong sentence into windows bounded by maxWordsPerPhrase", () => {
  const words = Array.from({ length: 60 }, (_, i) => `distinctiveword${i}`);
  const longSentence = `${words.join(" ")}.`;
  const queries = extractCandidatePhrases(longSentence);
  for (const query of queries) {
    const wordCount = query.queryText.split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount <= DEFAULT_PHRASE_EXTRACTION_CONFIG.maxWordsPerPhrase, `"${query.queryText}" exceeds maxWordsPerPhrase`);
  }
});

test("deduplicates an exactly-repeated sentence", () => {
  const text = `${DISTINCTIVE_SENTENCE} Some filler paragraph text goes here to separate the repeats from each other in the document body. ${DISTINCTIVE_SENTENCE}`;
  const queries = extractCandidatePhrases(text);
  const matches = queries.filter((q) => q.queryText === DISTINCTIVE_SENTENCE);
  assert.equal(matches.length, 1);
});

test("is deterministic for identical input", () => {
  const text = `${DISTINCTIVE_SENTENCE} ${GENERIC_SHORT_SENTENCE} Another moderately distinctive sentence about cryptographic protocols and entangled photon pairs.`;
  const first = extractCandidatePhrases(text);
  const second = extractCandidatePhrases(text);
  assert.deepEqual(first, second);
});

test("assigns rank 0 to the highest-scoring candidate", () => {
  const text = `${GENERIC_SHORT_SENTENCE} ${DISTINCTIVE_SENTENCE}`;
  const queries = extractCandidatePhrases(text);
  assert.equal(queries[0]?.rank, 0);
});

test("never exceeds ~20 queries for a very large document (no full-document leakage)", () => {
  const paragraph = Array.from(
    { length: 300 },
    (_, i) => `Sentence ${i} contains reasonably unique technical vocabulary about biochemistry synthesis pathways.`,
  ).join(" ");
  const queries = extractCandidatePhrases(paragraph);
  assert.ok(queries.length <= 20);
});
