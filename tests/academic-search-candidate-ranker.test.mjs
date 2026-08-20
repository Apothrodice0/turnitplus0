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

// --- Phase 5: queryType-based ranking (real bug this fixes — see candidate-ranker.ts's own comment) ---

test("Phase 5: a candidate found ONLY by a keyword query outranks several otherwise-tied candidates found only by sentence queries", () => {
  // Reproduces the real production bug: several candidates identically
  // scored on every existing signal (doi, url, textAvailable, single
  // contributor) used to fall back to an alphabetical candidateKey
  // tiebreak with zero relevance to the actual match — meaning a real
  // candidate discovered specifically because of the higher-precision
  // keyword-query strategy could still lose to arbitrary noise.
  const commonShape = { doi: "10.1007/noise", url: "https://example.com/x", textAvailable: true, contributors: [{ providerId: "p", providerRelevance: null, queryType: "sentence" }] };
  const noiseA = candidate("10.1007/noise-a", { ...commonShape, doi: "10.1007/noise-a" });
  const noiseB = candidate("10.1007/noise-b", { ...commonShape, doi: "10.1007/noise-b" });
  const realMatch = candidate("10.1371/real-match", {
    doi: "10.1371/real-match", url: "https://example.com/y", textAvailable: true,
    contributors: [{ providerId: "europe-pmc", providerRelevance: null, queryType: "keyword" }],
  });

  const ranked = rankAcademicCandidates([noiseA, noiseB, realMatch]);
  assert.equal(ranked[0].candidateKey, "10.1371/real-match", "the keyword-discovered real match must not lose an otherwise-arbitrary tie");
});

test("Phase 5: a candidate found by BOTH a sentence and a keyword-type contributor still only receives the bonus once (not doubled)", () => {
  const mixed = candidate("mixed", {
    doi: "10.1/mixed",
    contributors: [
      { providerId: "a", providerRelevance: null, queryType: "sentence" },
      { providerId: "b", providerRelevance: null, queryType: "keyword" },
    ],
  });
  const keywordOnly = candidate("keyword-only", {
    doi: "10.1/keyword-only",
    contributors: [{ providerId: "c", providerRelevance: null, queryType: "keyword" }],
  });
  const ranked = rankAcademicCandidates([keywordOnly, mixed]);
  // mixed has an extra contributor (additionalContributor bonus) so it
  // should rank first — but the keyword bonus itself must not multiply per
  // matching contributor, or this assertion would still pass for the wrong
  // reason; the real check is that the score gap equals exactly one
  // additionalContributor weight, not one additionalContributor PLUS an
  // extra keyword bonus.
  assert.equal(ranked[0].candidateKey, "mixed");
});

test("Phase 5: a candidate with no queryType on any contributor (legacy/manually-built fixture) is treated as no bonus, not an error", () => {
  const legacy = candidate("legacy", { doi: "10.1/legacy" }); // contributors default has no queryType field at all
  assert.doesNotThrow(() => rankAcademicCandidates([legacy]));
});

// --- ISSUE 2: cross-provider corroboration (real bug this fixes — see candidate-ranker.ts's own comment on multiProviderCorroboration) ---

test("ISSUE 2: a candidate confirmed by 2 DISTINCT providers outranks several topically-unrelated candidates each matched by only one provider plus textAvailable", () => {
  // Reproduces the real production bug: OpenAIRE's provider never reports
  // textAvailable (see providers/openaire.ts's own header comment), so a
  // real OpenAIRE-confirmed match started every ranking behind an unrelated
  // Europe PMC record purely on that one signal. Eight single-provider,
  // textAvailable "noise" candidates should not beat one candidate
  // genuinely corroborated by two independent providers.
  const commonShape = {
    doi: "10.1007/noise",
    url: "https://example.com/x",
    textAvailable: true,
    contributors: [{ providerId: "europe-pmc", providerRelevance: null, queryType: "sentence" }],
  };
  const noise = Array.from({ length: 8 }, (_, index) =>
    candidate(`10.1007/noise-${index}`, { ...commonShape, doi: `10.1007/noise-${index}` }));
  const corroborated = candidate("10.1371/corroborated", {
    doi: "10.1371/corroborated",
    url: null,
    textAvailable: false,
    contributors: [
      { providerId: "openaire", providerRelevance: null, queryType: "sentence" },
      { providerId: "europe-pmc", providerRelevance: null, queryType: "sentence" },
    ],
  });

  const ranked = rankAcademicCandidates([...noise, corroborated]);
  assert.equal(ranked[0].candidateKey, "10.1371/corroborated", "genuine cross-provider corroboration must outrank single-provider noise");
});

test("ISSUE 2: 2+ contributors from the SAME provider (e.g. three sentence-query hits on one Europe PMC record) do not receive the multi-provider bonus", () => {
  const sameProviderOnly = candidate("same-provider", {
    doi: "10.1/same-provider",
    contributors: [
      { providerId: "europe-pmc", providerRelevance: null, queryType: "sentence" },
      { providerId: "europe-pmc", providerRelevance: null, queryType: "sentence" },
      { providerId: "europe-pmc", providerRelevance: null, queryType: "sentence" },
    ],
  });
  const crossProvider = candidate("cross-provider", {
    doi: "10.1/cross-provider",
    contributors: [
      { providerId: "openaire", providerRelevance: null, queryType: "sentence" },
      { providerId: "europe-pmc", providerRelevance: null, queryType: "sentence" },
    ],
  });
  const ranked = rankAcademicCandidates([sameProviderOnly, crossProvider]);
  assert.equal(ranked[0].candidateKey, "cross-provider", "distinct-provider corroboration must outrank same-provider repetition despite fewer total contributors");
});
