import assert from "node:assert/strict";
import test from "node:test";
import {
  createFixtureDiscoveryProvider,
  sanitizeProviderResults,
  isUsableProviderResult,
  classifyProviderError,
  DiscoveryTimeoutError,
  DiscoveryRateLimitError,
  DiscoveryProviderUnavailableError,
} from "../lib/discovery-providers.ts";
import { normalizeUrlForDiscovery, normalizeExternalIdentifier, normalizeTitleForComparison } from "../lib/discovery-normalization.ts";

function makeResult(overrides = {}) {
  return {
    providerResultId: "r1",
    url: "https://example.org/article",
    externalIdentifier: null,
    externalIdentifierType: null,
    title: "An Article",
    author: null,
    publisher: null,
    publicationDate: null,
    sourceClass: "PUBLIC_WEBPAGE",
    providerConfidence: 0.5,
    querySignalUsed: "some query",
    discoveredAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

// --- PROVIDERS ---------------------------------------------------------------

test("PROVIDERS: createFixtureDiscoveryProvider preserves provider identity and never touches the network", async () => {
  const provider = createFixtureDiscoveryProvider({ id: "test-fixture-1", type: "ACADEMIC_INDEX", results: [makeResult()] });
  assert.equal(provider.id, "test-fixture-1");
  assert.equal(provider.type, "ACADEMIC_INDEX");
  const results = await provider.discover({ requestId: "req-1", queries: [], signals: { normalizedTitle: null, normalizedAuthor: null, distinctivePassages: [], canonicalHash: null, language: null } });
  assert.deepEqual(results, [makeResult()]);
});

test("PROVIDERS: createFixtureDiscoveryProvider supports a pure function of the request for deterministic, context-dependent fixtures", async () => {
  const provider = createFixtureDiscoveryProvider({
    id: "test-fixture-2",
    type: "WEB_SEARCH",
    results: (request) => request.queries.map((q, i) => makeResult({ providerResultId: `r${i}`, querySignalUsed: q.queryText })),
  });
  const results = await provider.discover({
    requestId: "req-2",
    queries: [{ queryText: "alpha", basis: ["DISTINCTIVE_PASSAGE"], rank: 0 }, { queryText: "beta", basis: ["DISTINCTIVE_PASSAGE"], rank: 1 }],
    signals: { normalizedTitle: null, normalizedAuthor: null, distinctivePassages: [], canonicalHash: null, language: null },
  });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.querySignalUsed), ["alpha", "beta"]);
});

test("PROVIDERS: createFixtureDiscoveryProvider rejects an unrecognized provider type", () => {
  assert.throws(() => createFixtureDiscoveryProvider({ id: "bad", type: "NOT_A_REAL_TYPE", results: [] }), /not a recognized discovery provider type/);
});

test("PROVIDERS: provider ranking (providerConfidence) passes through unchanged and is never relabeled", () => {
  const results = sanitizeProviderResults([makeResult({ providerConfidence: 0.73 })]);
  assert.equal(results[0].providerConfidence, 0.73);
  assert.ok(!("provenanceConfidence" in results[0]), "provider confidence must never be exposed under a provenance-sounding name");
});

test("PROVIDERS: malformed results are rejected safely — no crash, just filtered out", () => {
  const inputs = [
    makeResult(), // valid
    null,
    undefined,
    42,
    "a string, not a result object",
    {}, // no identifying fields, no required fields
    { url: null, externalIdentifier: null, title: null, querySignalUsed: "q", discoveredAt: "2026-08-13T00:00:00.000Z" }, // nothing identifying at all
    { url: "https://example.org/x", querySignalUsed: "", discoveredAt: "2026-08-13T00:00:00.000Z" }, // empty querySignalUsed
    makeResult({ sourceClass: "NOT_A_REAL_SOURCE_CLASS" }), // invalid controlled vocabulary value
  ];
  assert.doesNotThrow(() => sanitizeProviderResults(inputs));
  const usable = sanitizeProviderResults(inputs);
  assert.equal(usable.length, 1, "only the one fully valid result should survive sanitization");
});

test("PROVIDERS: sanitizeProviderResults never throws on non-array input", () => {
  assert.deepEqual(sanitizeProviderResults(null), []);
  assert.deepEqual(sanitizeProviderResults(undefined), []);
  assert.deepEqual(sanitizeProviderResults("not an array"), []);
});

test("PROVIDERS: a result with a URL but nothing else is still usable", () => {
  assert.equal(isUsableProviderResult(makeResult({ title: null, externalIdentifier: null, url: "https://example.org/only-url" })), true);
});

test("PROVIDERS: a result with only an external identifier (no URL) is still usable", () => {
  assert.equal(isUsableProviderResult(makeResult({ title: null, url: null, externalIdentifier: "10.1234/x", externalIdentifierType: "DOI" })), true);
});

test("PROVIDERS: classifyProviderError maps this module's own error classes to the matching attempt status", () => {
  assert.equal(classifyProviderError(new DiscoveryTimeoutError()), "TIMEOUT");
  assert.equal(classifyProviderError(new DiscoveryRateLimitError()), "RATE_LIMITED");
  assert.equal(classifyProviderError(new DiscoveryProviderUnavailableError()), "PROVIDER_UNAVAILABLE");
  assert.equal(classifyProviderError(new Error("something else broke")), "ERROR");
  assert.equal(classifyProviderError("not even an Error instance"), "ERROR");
});

// --- NORMALIZATION -------------------------------------------------------------

test("NORMALIZATION: strips known tracking parameters without changing the destination", () => {
  const normalized = normalizeUrlForDiscovery("https://Example.org/Article?utm_source=twitter&id=42&utm_campaign=x");
  assert.equal(normalized, "https://example.org/Article?id=42");
});

test("NORMALIZATION: preserves non-tracking query parameters and sorts them for a stable comparison key", () => {
  const a = normalizeUrlForDiscovery("https://example.org/article?b=2&a=1");
  const b = normalizeUrlForDiscovery("https://example.org/article?a=1&b=2");
  assert.equal(a, b);
});

test("NORMALIZATION: strips the fragment (never changes the fetched resource)", () => {
  const normalized = normalizeUrlForDiscovery("https://example.org/article#section-2");
  assert.equal(normalized, "https://example.org/article");
});

test("NORMALIZATION: removes exactly one trailing slash from a non-root path, but never touches the root", () => {
  assert.equal(normalizeUrlForDiscovery("https://example.org/article/"), "https://example.org/article");
  assert.equal(normalizeUrlForDiscovery("https://example.org/"), "https://example.org/");
});

test("NORMALIZATION: lowercases the host but leaves the path case alone (paths can be case-sensitive)", () => {
  const normalized = normalizeUrlForDiscovery("https://EXAMPLE.org/Some/Article-Path");
  assert.equal(normalized, "https://example.org/Some/Article-Path");
});

test("NORMALIZATION: malformed or unsupported URLs normalize to null rather than throwing or guessing", () => {
  assert.equal(normalizeUrlForDiscovery("not a url at all"), null);
  assert.equal(normalizeUrlForDiscovery(""), null);
  assert.equal(normalizeUrlForDiscovery(null), null);
  assert.equal(normalizeUrlForDiscovery(undefined), null);
  assert.equal(normalizeUrlForDiscovery("ftp://example.org/file.pdf"), null, "only http/https are treated as web destinations");
});

test("NORMALIZATION: DOI-like identifiers normalize consistently regardless of how they were supplied", () => {
  const bare = normalizeExternalIdentifier("DOI", "10.1234/Example.Paper");
  const url = normalizeExternalIdentifier(null, "https://doi.org/10.1234/Example.Paper");
  const dxUrl = normalizeExternalIdentifier(null, "https://dx.doi.org/10.1234/Example.Paper");
  assert.equal(bare, url);
  assert.equal(bare, dxUrl);
  assert.equal(bare, "10.1234/example.paper");
});

test("NORMALIZATION: a non-DOI identifier is only trimmed, never reinterpreted", () => {
  assert.equal(normalizeExternalIdentifier("ISBN", "  978-0-13-468599-1  "), "978-0-13-468599-1");
});

test("NORMALIZATION: null/empty identifiers normalize to null", () => {
  assert.equal(normalizeExternalIdentifier("DOI", null), null);
  assert.equal(normalizeExternalIdentifier("DOI", ""), null);
  assert.equal(normalizeExternalIdentifier("DOI", "   "), null);
});

test("NORMALIZATION: title comparison normalization reuses the same primitive discovery signals use", () => {
  assert.equal(normalizeTitleForComparison("The Rise, of Something!"), normalizeTitleForComparison("the rise of something"));
  assert.equal(normalizeTitleForComparison(null), null);
  assert.equal(normalizeTitleForComparison(""), null);
});
