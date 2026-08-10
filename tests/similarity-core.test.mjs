import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateSimilaritySources,
  acceptedSimilaritySpans,
  containment,
  detectLanguage,
  gramHash,
  grams,
  informativeGram,
  normalize,
  similarityScore,
  tokens,
} from "../lib/similarity-core.ts";

test("normalizes punctuation and accents consistently", () => {
  assert.equal(normalize("Criminalité — INTERNATIONALE!"), "criminalite internationale");
});

test("removes a trailing references section", () => {
  assert.deepEqual(tokens("Useful article text.\n\nReferences\nHidden source title"), ["useful", "article", "text"]);
});

test("creates consecutive five-word grams", () => {
  assert.deepEqual(grams(["one", "two", "three", "four", "five", "six"], 5), [
    "one two three four five",
    "two three four five six",
  ]);
});

test("requires two informative terms", () => {
  assert.equal(informativeGram("of the international criminal court"), true);
  assert.equal(informativeGram("of the law in court"), false);
});

test("hashing is stable and distinguishes grams", () => {
  assert.equal(gramHash("of the international criminal court"), "ea00e4331f0142ef");
  assert.notEqual(gramHash("first distinctive phrase here now"), gramHash("second distinctive phrase here now"));
});

test("content containment drives self-match exclusion", () => {
  assert.equal(containment(75, 100, 90) >= 0.75, true);
  assert.equal(containment(50, 100, 90) >= 0.75, false);
});

test("score counts matched positions once", () => {
  assert.equal(similarityScore(19, 100), 19);
  assert.equal(similarityScore(120, 100), 100);
});

test("accepted spans reject isolated short matches after source assignment", () => {
  const matchedBySource = new Map([
    [0, new Set([0, 1, 2, 3, 4])],
    [1, new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])],
  ]);
  const result = acceptedSimilaritySpans(matchedBySource, 8);
  assert.deepEqual([...result.acceptedPositions], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  assert.equal(result.spansBySource.has(0), false);
  assert.deepEqual(result.spansBySource.get(1), [[10, 21]]);
  assert.throws(() => acceptedSimilaritySpans(matchedBySource, 0), /positive integer/);
});

test("accepted spans remain continuous when adjacent words choose different sources", () => {
  const matchedBySource = new Map([
    [0, new Set([0, 2, 4, 6])],
    [1, new Set([1, 3, 5, 7])],
  ]);
  const result = acceptedSimilaritySpans(matchedBySource, 8);
  assert.deepEqual([...result.acceptedPositions], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(result.acceptedGlobalSpans, [[0, 7]]);
});

test("source aggregation can suppress trivial contributors and cap retained sources", () => {
  const evidence = [
    { sourceIndex: 0, positions: new Set([0, 1, 2, 3]), containment: 0.5 },
    { sourceIndex: 1, positions: new Set([4, 5]), containment: 0.25 },
    { sourceIndex: 2, positions: new Set([6]), containment: 0.1 },
  ];
  const result = aggregateSimilaritySources(evidence, 100, {
    minimumSourceContribution: 2,
    maximumContributingSources: 1,
    sourceWeighting: "raw",
  });
  assert.equal(result.score, 4);
  assert.deepEqual(result.sourceContributions.map((source) => source.sourceIndex), [0]);
  const weighted = aggregateSimilaritySources(evidence.slice(0, 1), 100, {
    minimumSourceContribution: 0,
    maximumContributingSources: null,
    sourceWeighting: "containment",
  });
  assert.equal(weighted.matchedWordEquivalent, 2);
  assert.equal(weighted.score, 2);
});

test("detects Arabic, French, English, and mixed text", () => {
  assert.equal(detectLanguage("هذا نص عربي يشرح البحث في القانون الدولي"), "Arabic");
  assert.equal(detectLanguage("Le droit de la recherche dans les universités avec une méthode claire"), "French");
  assert.equal(detectLanguage("This research paper describes international criminal law"), "English");
  assert.equal(detectLanguage("This paper يناقش القانون الدولي وطرق البحث العلمي"), "Mixed");
});

test("Arabic stopwords do not make a phrase informative by themselves", () => {
  assert.equal(informativeGram("في من على هذا التي"), false);
  assert.equal(informativeGram("القانون الدولي في المحكمة الجنائية"), true);
});
