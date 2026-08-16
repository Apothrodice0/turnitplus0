import assert from "node:assert/strict";
import test from "node:test";
import { createCoreAcademicSearchProvider } from "../lib/academic-search/providers/core.ts";
import {
  AcademicSearchProviderUnavailableError,
  AcademicSearchRateLimitError,
  AcademicSearchTimeoutError,
} from "../lib/academic-search/provider.ts";

/**
 * Deterministic, no-network tests — mirrors tests/discovery-crossref-provider
 * .test.mjs's mocked-fetch style. See providers/core.ts's own header comment
 * for how confident the field-name mapping tested here actually is (best
 * effort, cross-checked against two independent secondary sources, not
 * verified against a live authenticated response).
 */

function coreSearchResponse(results) {
  return { totalHits: results.length, results };
}

function fullItem(overrides = {}) {
  return {
    id: 12345,
    doi: "10.1234/example.doi",
    title: "A Study of Bioluminescent Plankton Synchronization",
    authors: [{ name: "Ada Rivers" }, { name: "Sam Cole" }],
    publisher: "Example Academic Press",
    yearPublished: 2019,
    downloadUrl: "https://example.test/download/12345.pdf",
    fullText: "Full text content of the paper goes here.",
    ...overrides,
  };
}

function createMockFetch(steps) {
  const calls = [];
  let index = 0;
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = steps[index];
    index += 1;
    if (!step) throw new Error("mock fetch called more times than configured");
    if (step.type === "network-error") throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
    if (step.type === "abort") {
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    return new Response(JSON.stringify(step.body ?? coreSearchResponse([])), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  fetcher.calls = calls;
  return fetcher;
}

const FAST_CONFIG = { timeoutMs: 100, retry: { maxAttempts: 2, baseDelayMs: 5 } };

function q(text) {
  return { queryText: text, rank: 0, sourcePassage: text };
}

// --- PARSING ---------------------------------------------------------------

test("PARSING: a well-formed CORE work item maps to a complete AcademicSearchResult", async () => {
  const fetcher = createMockFetch([{ body: coreSearchResponse([fullItem()]) }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("bioluminescent plankton synchronization"));

  assert.equal(result.providerId, "core");
  assert.equal(result.externalId, "12345");
  assert.equal(result.title, "A Study of Bioluminescent Plankton Synchronization");
  assert.deepEqual(result.authors, ["Ada Rivers", "Sam Cole"]);
  assert.equal(result.doi, "10.1234/example.doi");
  assert.equal(result.year, 2019);
  assert.equal(result.url, "https://example.test/download/12345.pdf");
  assert.equal(result.textAvailable, true);
  assert.equal(result.querySignalUsed, "bioluminescent plankton synchronization");
});

test("PARSING: missing authors array is null, not an empty array", async () => {
  const fetcher = createMockFetch([{ body: coreSearchResponse([fullItem({ authors: undefined })]) }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));
  assert.equal(result.authors, null);
});

test("PARSING: missing fullText means textAvailable is false", async () => {
  const fetcher = createMockFetch([{ body: coreSearchResponse([fullItem({ fullText: undefined })]) }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));
  assert.equal(result.textAvailable, false);
});

test("PARSING: url falls back to sourceFulltextUrls, then to a doi.org link, when downloadUrl is absent", async () => {
  const fetcher = createMockFetch([
    { body: coreSearchResponse([fullItem({ downloadUrl: undefined, sourceFulltextUrls: ["https://repo.test/item/1"] })]) },
  ]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));
  assert.equal(result.url, "https://repo.test/item/1");

  const fetcher2 = createMockFetch([{ body: coreSearchResponse([fullItem({ downloadUrl: undefined, sourceFulltextUrls: undefined })]) }]);
  const provider2 = createCoreAcademicSearchProvider({ fetcher: fetcher2, ...FAST_CONFIG });
  const [result2] = await provider2.search(q("q"));
  assert.equal(result2.url, "https://doi.org/10.1234/example.doi");
});

test("sends an Authorization: Bearer header only when an apiKey is configured", async () => {
  const fetcher = createMockFetch([{ body: coreSearchResponse([]) }, { body: coreSearchResponse([]) }]);
  const withKey = createCoreAcademicSearchProvider({ fetcher, apiKey: "secret-key", ...FAST_CONFIG });
  await withKey.search(q("q"));
  assert.equal(fetcher.calls[0].init.headers.Authorization, "Bearer secret-key");

  const withoutKey = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await withoutKey.search(q("q"));
  assert.equal(fetcher.calls[1].init.headers.Authorization, undefined);
});

// --- FAILURE HANDLING --------------------------------------------------------

test("provider timeout: HTTP 429 is classified as a rate-limit error and is never retried", async () => {
  const fetcher = createMockFetch([{ status: 429, body: {} }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchRateLimitError);
  assert.equal(fetcher.calls.length, 1, "a 429 must not be retried");
});

test("provider failure: HTTP 401 is classified as provider-unavailable (bad/missing credentials)", async () => {
  const fetcher = createMockFetch([{ status: 401, body: {} }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchProviderUnavailableError);
});

test("provider failure: repeated HTTP 500 is retried up to maxAttempts, then classified as provider-unavailable", async () => {
  const fetcher = createMockFetch([{ status: 500, body: {} }, { status: 500, body: {} }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchProviderUnavailableError);
  assert.equal(fetcher.calls.length, 2);
});

test("provider timeout: an aborted request is classified as a timeout error", async () => {
  const fetcher = createMockFetch([{ type: "abort" }, { type: "abort" }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchTimeoutError);
});

test("a network-level failure (no HTTP response at all) is classified as provider-unavailable", async () => {
  const fetcher = createMockFetch([{ type: "network-error" }, { type: "network-error" }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchProviderUnavailableError);
});

// --- getText / getMetadata ---------------------------------------------------

test("getText returns the work's fullText field when present", async () => {
  const fetcher = createMockFetch([{ body: fullItem() }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const text = await provider.getText("12345");
  assert.equal(text, "Full text content of the paper goes here.");
});

test("getText (unavailable full text): returns null, never throws, when the work has no fullText", async () => {
  const fetcher = createMockFetch([{ body: fullItem({ fullText: undefined }) }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const text = await provider.getText("12345");
  assert.equal(text, null);
});

test("getText swallows a provider-level error and returns null rather than throwing", async () => {
  const fetcher = createMockFetch([{ status: 500, body: {} }, { status: 500, body: {} }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const text = await provider.getText("12345");
  assert.equal(text, null);
});

test("getMetadata maps a work lookup the same way search results are mapped", async () => {
  const fetcher = createMockFetch([{ body: fullItem() }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const metadata = await provider.getMetadata("12345");
  assert.equal(metadata.title, "A Study of Bioluminescent Plankton Synchronization");
  assert.equal(metadata.doi, "10.1234/example.doi");
});

test("getMetadata returns null (not a throw) for an unresolvable id", async () => {
  const fetcher = createMockFetch([{ status: 404, body: {} }]);
  const provider = createCoreAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const metadata = await provider.getMetadata("does-not-exist");
  assert.equal(metadata, null);
});
