import assert from "node:assert/strict";
import test from "node:test";
import { gramHash, grams, tokens, tokenSpans } from "../lib/similarity-core.ts";
import { scoreAgainstArchive } from "../lib/archive-similarity-scoring.ts";
import { frameArchiveResult } from "../lib/archive-result-framing.ts";
import { findHighlightRanges } from "../components/report/similarity-report-papers.tsx";

/**
 * Archive attributedRanges, as the PRODUCTION scorer emits them: each listed
 * source carries the scored positions winner-take-all gave it, so a report can
 * highlight exactly the scored words under the right source. The field is
 * presentation only — which positions score, the union, the score and the
 * source list are the scorer's and never change. Checked here: the ranges are
 * a disjoint partition of the scored union, they survive framing, and a report
 * built from them highlights every scored word, and nothing else, under its
 * owner — including a run shorter than one shingle, which has no phrase and
 * so was never highlighted from phrases.
 */

const SYLLABLES = ["ka", "lo", "mi", "ru", "te", "sa", "no", "vi", "be", "zu", "fo", "ge"];
const word = (index) => {
  let value = "";
  for (let rest = index + SYLLABLES.length ** 2, digits = 0; digits < 3; digits += 1, rest = Math.floor(rest / SYLLABLES.length)) {
    value += SYLLABLES[rest % SYLLABLES.length];
  }
  return value;
};
const words = (from, count) => Array.from({ length: count }, (_, offset) => word(from + offset));

// Submission: host · A-only passage · host · X, where A holds X[0..29] and B
// holds X[25..30]: B's grams over the last word past A win it the final two
// positions — a 2-word B run beside a long A run, too short for a phrase.
// A carries unrelated padding so it is not self-excluded as a near-copy.
const HOST_1 = words(0, 25);
const A_ONLY = words(100, 40);
const HOST_2 = words(200, 18);
const X = words(300, 31);
const HOST_3 = words(400, 20);
const SUBMISSION = [...HOST_1, ...A_ONLY, ...HOST_2, ...X, ...HOST_3].join(" ");
const SOURCE_TEXTS = [
  [...words(1000, 150), ...A_ONLY, ...words(520, 6), ...X.slice(0, 30)].join(" "),
  [...words(600, 8), ...X.slice(25, 31), ...words(620, 8)].join(" "),
  words(700, 60).join(" "),
  words(800, 60).join(" "),
];
const TITLES = ["Source A", "Source B", "Unrelated C", "Unrelated D"];

function index() {
  const postings = new Map();
  const articles = SOURCE_TEXTS.map((text, sourceIndex) => {
    const hashes = new Set(grams(tokens(text), 5).map(gramHash));
    for (const hash of hashes) postings.set(hash, [...(postings.get(hash) ?? []), sourceIndex]);
    return { title: TITLES[sourceIndex], sourceType: "Publication", uniqueShingleCount: hashes.size };
  });
  return {
    shingleSize: 5,
    documentCount: articles.length,
    maximumDocumentFrequency: 12,
    articles,
    getPostings: (hash) => postings.get(hash) ?? [],
  };
}

const PARAMETERS = { minimumMatchedWords: 5 };
const result = scoreAgainstArchive(SUBMISSION, index(), PARAMETERS);
const expand = (ranges) => ranges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, offset) => start + offset));

test("precondition: two sources score, and one of them owns a run shorter than a shingle", () => {
  assert.deepEqual(result.sources.map((source) => source.name).sort(), ["Source A", "Source B"]);
  const short = result.sources.flatMap((source) => source.attributedRanges).filter(([start, end]) => end - start + 1 < 5);
  assert.ok(short.length > 0, "some attributed run has no phrase (shorter than the 5-word shingle)");
});

test("attributedRanges is the only field the scorer adds to a source", () => {
  for (const source of result.sources) {
    assert.deepEqual(
      Object.keys(source).sort(),
      ["attributedRanges", "color", "matchedWords", "matches", "name", "percent", "phrases", "sourceIndex", "type"],
    );
  }
});

test("each source's ranges are sorted, maximal, and sized exactly matchedWords / matches", () => {
  for (const source of result.sources) {
    source.attributedRanges.forEach(([start, end], position) => {
      assert.ok(Number.isInteger(start) && Number.isInteger(end) && start <= end, `${source.name}: well-formed range`);
      const previous = source.attributedRanges[position - 1];
      if (previous) assert.ok(start > previous[1] + 1, `${source.name}: ranges sorted and never adjacent`);
    });
    assert.equal(expand(source.attributedRanges).length, source.matchedWords, `${source.name}: size = matchedWords`);
    assert.equal(source.attributedRanges.length, source.matches, `${source.name}: one range per match`);
  }
});

test("STABLE-UNION INVARIANT: attributed ranges never overlap across sources and partition the scored union", () => {
  const owner = new Map();
  for (const source of result.sources) {
    for (const position of expand(source.attributedRanges)) {
      assert.ok(!owner.has(position), `position ${position} attributed to both ${owner.get(position)} and ${source.name}`);
      owner.set(position, source.name);
    }
  }
  assert.deepEqual([...owner.keys()].sort((left, right) => left - right), result.archiveMatchedPositions);
  assert.equal(result.matchedWordCount, owner.size);
});

test("framing carries the ranges to the report unchanged", () => {
  const framed = frameArchiveResult(SUBMISSION, result, {
    scoreBands: [{ label: "Low", minimum: 0, maximum: 100 }],
    corpusVersion: "test",
    risk: { targetThreshold: 15, archiveCutoff: 7, auc: 0, precision: 0, recall: 0, sampleSize: 0 },
  });
  assert.deepEqual(
    framed.sources.map((source) => source.attributedRanges),
    result.sources.map((source) => source.attributedRanges),
  );
});

function highlightedOwners(report) {
  const spans = tokenSpans(report.text, 2);
  const ranges = findHighlightRanges(report, { includeWikipedia: false });
  const owners = new Map();
  spans.forEach((span, position) => {
    const range = ranges.find((candidate) => span.start >= candidate.start && span.end <= candidate.end);
    if (range) owners.set(position, range.label);
  });
  return owners;
}

test("a report made from the scorer highlights exactly the scored words, each under its owner", () => {
  const report = { text: SUBMISSION, scoringNormalizationVersion: 2, sources: result.sources.map(({ sourceIndex: _index, ...source }) => source) };
  const owners = highlightedOwners(report);
  assert.deepEqual([...owners.keys()].sort((left, right) => left - right), result.archiveMatchedPositions);
  for (const source of result.sources) {
    for (const position of expand(source.attributedRanges)) assert.equal(owners.get(position), source.name, `position ${position}`);
  }
});

test("the same report without attributedRanges (an older report) keeps phrase highlighting, which misses the short run", () => {
  const legacy = {
    text: SUBMISSION,
    scoringNormalizationVersion: 2,
    sources: result.sources.map(({ sourceIndex: _index, attributedRanges: _ranges, ...source }) => source),
  };
  const highlighted = highlightedOwners(legacy);
  const missing = result.archiveMatchedPositions.filter((position) => !highlighted.has(position));
  assert.ok(missing.length > 0, "phrase fallback is the old behaviour, unchanged");
});
