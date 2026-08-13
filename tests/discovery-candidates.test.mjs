import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import {
  buildCandidateKey,
  deduplicateDiscoveryResults,
  rankDiscoveryCandidates,
  DEFAULT_CANDIDATE_RANKING_WEIGHTS,
} from "../lib/discovery-candidates.ts";

const repo = path.resolve(".");

function tag(providerId, providerType, overrides = {}) {
  return {
    providerId,
    providerType,
    providerResultId: overrides.providerResultId ?? `${providerId}-r1`,
    url: overrides.url ?? null,
    externalIdentifier: overrides.externalIdentifier ?? null,
    externalIdentifierType: overrides.externalIdentifierType ?? null,
    title: overrides.title ?? null,
    author: overrides.author ?? null,
    publisher: overrides.publisher ?? null,
    publicationDate: overrides.publicationDate ?? null,
    sourceClass: overrides.sourceClass ?? null,
    providerConfidence: overrides.providerConfidence ?? null,
    querySignalUsed: overrides.querySignalUsed ?? "some query",
    discoveredAt: overrides.discoveredAt ?? "2026-08-13T00:00:00.000Z",
  };
}

const NO_SIGNALS = { normalizedTitle: null, normalizedAuthor: null, distinctivePassages: [], canonicalHash: null, language: null };

// --- DEDUPLICATION -------------------------------------------------------------

test("DEDUPLICATION: the same stable external identifier (in different forms) collapses to one candidate", () => {
  const results = [
    tag("provider-a", "ACADEMIC_INDEX", { externalIdentifier: "10.1234/Example", externalIdentifierType: "DOI", url: "https://journal.example/x" }),
    tag("provider-b", "WEB_SEARCH", { externalIdentifier: "https://doi.org/10.1234/EXAMPLE", externalIdentifierType: "DOI", url: "https://mirror.example/y" }),
  ];
  const candidates = deduplicateDiscoveryResults(results);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].contributingProviders.length, 2);
  assert.deepEqual(candidates[0].originalUrls.sort(), ["https://journal.example/x", "https://mirror.example/y"]);
});

test("DEDUPLICATION: the same canonical URL (differing only in tracking params/trailing slash) collapses to one candidate", () => {
  const results = [
    tag("provider-a", "WEB_SEARCH", { url: "https://example.org/article?utm_source=x" }),
    tag("provider-b", "WEB_SEARCH", { url: "https://example.org/article/" }),
  ];
  const candidates = deduplicateDiscoveryResults(results);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].contributingProviders.length, 2);
});

test("DEDUPLICATION: the same title alone is NOT deduplicated — different URLs, no identifiers, stay separate", () => {
  const results = [
    tag("provider-a", "WEB_SEARCH", { title: "A Common Title", url: "https://example.org/one" }),
    tag("provider-b", "WEB_SEARCH", { title: "A Common Title", url: "https://another.example/two" }),
  ];
  const candidates = deduplicateDiscoveryResults(results);
  assert.equal(candidates.length, 2, "matching titles must never be treated as proof of the same source");
});

test("DEDUPLICATION: the same author alone is NOT deduplicated", () => {
  const results = [
    tag("provider-a", "WEB_SEARCH", { author: "A. Researcher", url: "https://example.org/one" }),
    tag("provider-b", "WEB_SEARCH", { author: "A. Researcher", url: "https://another.example/two" }),
  ];
  const candidates = deduplicateDiscoveryResults(results);
  assert.equal(candidates.length, 2);
});

test("DEDUPLICATION: identifier priority beats a shared URL — two different identifiers at the same URL remain separate", () => {
  const results = [
    tag("provider-a", "ACADEMIC_INDEX", { externalIdentifier: "10.1/aaa", externalIdentifierType: "DOI", url: "https://shared.example/page" }),
    tag("provider-b", "ACADEMIC_INDEX", { externalIdentifier: "10.1/bbb", externalIdentifierType: "DOI", url: "https://shared.example/page" }),
  ];
  const candidates = deduplicateDiscoveryResults(results);
  assert.equal(candidates.length, 2, "differing stable identifiers must win over a coincidentally shared URL");
});

test("DEDUPLICATION: with no identifier and no URL, results fall back to a provider-specific key (no cross-provider merge is possible)", () => {
  const results = [
    tag("provider-a", "WEB_SEARCH", { providerResultId: "x1", title: "Only A Title" }),
    tag("provider-b", "WEB_SEARCH", { providerResultId: "x2", title: "Only A Title" }),
  ];
  const candidates = deduplicateDiscoveryResults(results);
  assert.equal(candidates.length, 2);
});

test("DEDUPLICATION: field merge policy is deterministic (first non-null value wins, in input order)", () => {
  const results = [
    tag("provider-a", "WEB_SEARCH", { url: "https://example.org/x", title: null, publisher: "Publisher A" }),
    tag("provider-b", "WEB_SEARCH", { url: "https://example.org/x", title: "Title From B", publisher: "Publisher B" }),
  ];
  const [candidate] = deduplicateDiscoveryResults(results);
  assert.equal(candidate.title, "Title From B", "the first NON-NULL title in input order should win");
  assert.equal(candidate.publisher, "Publisher A", "provider-a's publisher is non-null and came first, so it should win");
});

test("DEDUPLICATION: independence is USER_SUPPLIED whenever any contributing provider is USER_SUPPLIED, even alongside independent providers", () => {
  const results = [
    tag("provider-a", "ACADEMIC_INDEX", { externalIdentifier: "10.1/shared", externalIdentifierType: "DOI" }),
    tag("user", "USER_SUPPLIED", { externalIdentifier: "10.1/shared", externalIdentifierType: "DOI" }),
  ];
  const [candidate] = deduplicateDiscoveryResults(results);
  assert.equal(candidate.independence, "USER_SUPPLIED", "one non-independent contribution must taint the whole candidate");
});

test("DEDUPLICATION: independence is INDEPENDENT_DISCOVERY when no contributing provider is USER_SUPPLIED", () => {
  const results = [tag("provider-a", "ACADEMIC_INDEX", { externalIdentifier: "10.1/x", externalIdentifierType: "DOI" })];
  const [candidate] = deduplicateDiscoveryResults(results);
  assert.equal(candidate.independence, "INDEPENDENT_DISCOVERY");
});

test("DEDUPLICATION: buildCandidateKey is a pure, deterministic function of its input", () => {
  const result = tag("provider-a", "WEB_SEARCH", { url: "https://example.org/x" });
  assert.equal(buildCandidateKey(result), buildCandidateKey(result));
});

// --- RANKING ---------------------------------------------------------------

test("RANKING: rankDiscoveryCandidates is deterministic — identical input always produces the same order", () => {
  const candidates = deduplicateDiscoveryResults([
    tag("a", "WEB_SEARCH", { url: "https://example.org/one" }),
    tag("b", "ACADEMIC_INDEX", { externalIdentifier: "10.1/x", externalIdentifierType: "DOI" }),
  ]);
  const first = rankDiscoveryCandidates(candidates, NO_SIGNALS);
  const second = rankDiscoveryCandidates(candidates, NO_SIGNALS);
  assert.deepEqual(first, second);
});

test("RANKING: a candidate with a stable identifier ranks above a candidate with only a bare URL, under default weights", () => {
  const candidates = deduplicateDiscoveryResults([
    tag("a", "WEB_SEARCH", { url: "https://example.org/one" }),
    tag("b", "ACADEMIC_INDEX", { externalIdentifier: "10.1/x", externalIdentifierType: "DOI" }),
  ]);
  const ranked = rankDiscoveryCandidates(candidates, NO_SIGNALS);
  assert.equal(ranked[0].externalIdentifier, "10.1/x");
  assert.equal(ranked[0].rank, 0);
  assert.equal(ranked[1].rank, 1);
});

test("RANKING: weights are configurable — favoring provider confidence can outrank identifier presence", () => {
  const candidates = deduplicateDiscoveryResults([
    tag("a", "WEB_SEARCH", { url: "https://example.org/one", providerConfidence: 0.99 }),
    tag("b", "ACADEMIC_INDEX", { externalIdentifier: "10.1/x", externalIdentifierType: "DOI", providerConfidence: 0.01 }),
  ]);
  const heavyConfidenceWeights = { ...DEFAULT_CANDIDATE_RANKING_WEIGHTS, hasExternalIdentifier: 0, providerConfidence: 10 };
  const ranked = rankDiscoveryCandidates(candidates, NO_SIGNALS, heavyConfidenceWeights);
  assert.equal(ranked[0].contributingProviders[0].providerConfidence, 0.99, "the high-confidence-but-no-identifier candidate should now rank first");
});

test("RANKING: ties are broken deterministically by candidateKey, never by input order alone", () => {
  const candidates = deduplicateDiscoveryResults([
    tag("a", "WEB_SEARCH", { url: "https://zzz.example/one" }),
    tag("b", "WEB_SEARCH", { url: "https://aaa.example/two" }),
  ]);
  const rankedForward = rankDiscoveryCandidates(candidates, NO_SIGNALS);
  const rankedReversed = rankDiscoveryCandidates([...candidates].reverse(), NO_SIGNALS);
  assert.deepEqual(rankedForward.map((c) => c.candidateKey), rankedReversed.map((c) => c.candidateKey));
});

test("RANKING: matching the document's own title/author via signals increases a candidate's rank", () => {
  const signals = { normalizedTitle: "a shared title", normalizedAuthor: null, distinctivePassages: [], canonicalHash: null, language: null };
  const candidates = deduplicateDiscoveryResults([
    tag("a", "WEB_SEARCH", { url: "https://example.org/one", title: "Something Unrelated" }),
    tag("b", "WEB_SEARCH", { url: "https://example.org/two", title: "A Shared Title" }),
  ]);
  const ranked = rankDiscoveryCandidates(candidates, signals);
  assert.equal(ranked[0].title, "A Shared Title");
});

test("RANKING: ranking is not provenance verification — the output carries no verification/eligibility field, and the module never imports the verification policy", () => {
  const candidates = deduplicateDiscoveryResults([tag("a", "WEB_SEARCH", { url: "https://example.org/one" })]);
  const [ranked] = rankDiscoveryCandidates(candidates, NO_SIGNALS);
  assert.ok(!("eligible" in ranked));
  assert.ok(!("verified" in ranked));
  assert.ok(!("provenanceState" in ranked));
  assert.equal(typeof ranked.rank, "number");

  // Only real import statements are checked — this module's own doc
  // comments legitimately name lib/provenance-verification-policy.ts in
  // prose (explaining why USER_SUPPLIED independence is conservative), so a
  // whole-source substring search would false-positive on that; see
  // tests/provenance-scoring-invariance.test.mjs's importLines() for the
  // same, established fix.
  const source = fs.readFileSync(path.join(repo, "lib", "discovery-candidates.ts"), "utf8");
  const imports = source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  assert.doesNotMatch(imports, /provenance-verification-policy|isEligibleForVerifiedSimilarity/);
});
