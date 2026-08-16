import assert from "node:assert/strict";
import test from "node:test";
import { rankAcademicCandidates } from "../lib/academic-search/candidate-ranker.ts";

function candidate(key, overrides = {}) {
  return {
    candidateKey: key,
    doi: null,
    url: null,
    title: "Title",
    authors: null,
    publication: null,
    year: null,
    textAvailable: false,
    contributors: [{ providerId: "mock", providerRelevance: null }],
    rank: 0,
    ...overrides,
  };
}

test("a candidate with a DOI, URL, available text, and corroborating contributors outranks a bare title-only candidate", () => {
  const strong = candidate("strong", {
    doi: "10.1/x",
    url: "https://example.com/a",
    textAvailable: true,
    contributors: [
      { providerId: "core", providerRelevance: 0.9 },
      { providerId: "mock", providerRelevance: 0.8 },
    ],
  });
  const weak = candidate("weak");

  const ranked = rankAcademicCandidates([weak, strong]);
  assert.equal(ranked[0].candidateKey, "strong");
  assert.equal(ranked[1].candidateKey, "weak");
});

test("assigns rank 0..n-1 in sorted order", () => {
  const ranked = rankAcademicCandidates([candidate("b"), candidate("a"), candidate("c")]);
  assert.deepEqual(ranked.map((c) => c.rank), [0, 1, 2]);
});

test("ties are broken deterministically by candidateKey", () => {
  const ranked = rankAcademicCandidates([candidate("zebra"), candidate("apple"), candidate("mango")]);
  assert.deepEqual(ranked.map((c) => c.candidateKey), ["apple", "mango", "zebra"]);
});

test("is deterministic across repeated calls", () => {
  const input = [candidate("b", { doi: "10.1/b" }), candidate("a"), candidate("c", { textAvailable: true })];
  const first = rankAcademicCandidates(input).map((c) => c.candidateKey);
  const second = rankAcademicCandidates(input).map((c) => c.candidateKey);
  assert.deepEqual(first, second);
});
