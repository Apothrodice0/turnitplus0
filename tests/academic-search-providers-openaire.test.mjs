import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAireAcademicSearchProvider } from "../lib/academic-search/providers/openaire.ts";
import {
  AcademicSearchProviderUnavailableError,
  AcademicSearchRateLimitError,
  AcademicSearchTimeoutError,
} from "../lib/academic-search/provider.ts";

/**
 * Deterministic, no-network tests — mirrors tests/academic-search-providers
 * -core.test.mjs's mocked-fetch style. Unlike that file's own field-mapping
 * caveat, the fixture shapes below are lifted directly from real HTTP 200
 * responses captured against https://api.openaire.eu/graph/v3/research-products
 * during this phase (see providers/openaire.ts's header comment).
 */

function openAireResponse(results) {
  return { header: { numFound: results.length, pageSize: results.length, page: 1 }, results };
}

function fullItem(overrides = {}) {
  return {
    id: "doi_dedup___::c5f2eb16876a2b72c436e285d57faafc",
    type: "publication",
    mainTitle: "Fast Transformer Decoding: One Write-Head is All You Need",
    authors: [{ fullName: "Noam Shazeer" }],
    publicationDate: "2019-01-01",
    publisher: null,
    container: null,
    bestAccessRight: { code: "c_abf2", label: "OPEN" },
    pids: [{ scheme: "doi", value: "10.48550/arxiv.1911.02150" }, { scheme: "arXiv", value: "1911.02150" }],
    instances: [
      { urls: ["https://dx.doi.org/10.48550/arxiv.1911.02150"], type: "Article" },
      { urls: ["http://arxiv.org/abs/1911.02150"], accessRight: { code: "c_abf2", label: "OPEN" }, type: "Preprint" },
    ],
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
    return new Response(JSON.stringify(step.body ?? openAireResponse([])), {
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

test("PARSING: a well-formed OpenAIRE publication result maps to a complete AcademicSearchResult", async () => {
  const fetcher = createMockFetch([{ body: openAireResponse([fullItem()]) }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("fast transformer decoding one write head"));

  assert.equal(result.providerId, "openaire");
  assert.equal(result.externalId, "doi_dedup___::c5f2eb16876a2b72c436e285d57faafc");
  assert.equal(result.title, "Fast Transformer Decoding: One Write-Head is All You Need");
  assert.deepEqual(result.authors, ["Noam Shazeer"]);
  assert.equal(result.doi, "10.48550/arxiv.1911.02150");
  assert.equal(result.year, 2019);
  assert.equal(result.querySignalUsed, "fast transformer decoding one write head");
  assert.equal(result.providerRelevance, null);
});

test("PARSING: url prefers an OPEN-access instance over the first instance regardless of order", async () => {
  const fetcher = createMockFetch([{
    body: openAireResponse([fullItem({
      instances: [
        { urls: ["https://closed.example/landing"], accessRight: { label: "CLOSED" } },
        { urls: ["https://arxiv.org/abs/1911.02150"], accessRight: { label: "OPEN" } },
      ],
    })]),
  }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));
  assert.equal(result.url, "https://arxiv.org/abs/1911.02150");
});

test("PARSING: url falls back to the first instance, then a doi.org link, when no OPEN instance exists", async () => {
  const fetcher = createMockFetch([
    { body: openAireResponse([fullItem({ instances: [{ urls: ["https://closed.example/landing"], accessRight: { label: "CLOSED" } }] })]) },
  ]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));
  assert.equal(result.url, "https://closed.example/landing");

  const fetcher2 = createMockFetch([{ body: openAireResponse([fullItem({ instances: [] })]) }]);
  const provider2 = createOpenAireAcademicSearchProvider({ fetcher: fetcher2, ...FAST_CONFIG });
  const [result2] = await provider2.search(q("q"));
  assert.equal(result2.url, "https://doi.org/10.48550/arxiv.1911.02150");
});

test("PARSING: publication prefers container.name (journal) over publisher", async () => {
  const fetcher = createMockFetch([{
    body: openAireResponse([fullItem({ container: { name: "ACS Omega" }, publisher: "American Chemical Society (ACS)" })]),
  }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));
  assert.equal(result.publication, "ACS Omega");
});

test("PARSING: textAvailable is always false — the Graph API never returns full text", async () => {
  const fetcher = createMockFetch([{ body: openAireResponse([fullItem()]) }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));
  assert.equal(result.textAvailable, false);
  assert.equal(provider.getText, undefined, "no getText — omitted entirely rather than always returning null");
});

test("PARSING: missing authors/pids/instances degrade to null fields, not a throw", async () => {
  const fetcher = createMockFetch([{ body: openAireResponse([fullItem({ authors: null, pids: null, instances: null })]) }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));
  assert.equal(result.authors, null);
  assert.equal(result.doi, null);
  assert.equal(result.url, null);
});

// --- REQUEST SHAPE -----------------------------------------------------------

test("search() requests type=publication by default and includes the query text", async () => {
  const fetcher = createMockFetch([{ body: openAireResponse([]) }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await provider.search(q("distinctive query phrase"));
  const url = new URL(fetcher.calls[0].url);
  assert.equal(url.searchParams.get("type"), "publication");
  assert.equal(url.searchParams.get("search"), "distinctive query phrase");
});

test("search() strips parentheses from the query text — OpenAIRE's search param treats them as query-grammar grouping and 400s on an unbalanced one", async () => {
  const fetcher = createMockFetch([{ body: openAireResponse([]) }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await provider.search(q("nitrification genes (amoA and"));
  const url = new URL(fetcher.calls[0].url);
  assert.equal(url.searchParams.get("search"), "nitrification genes amoA and");
});

test("search() strips straight double quotes from the query text — a sentence window starting/ending mid-quotation 400s with \"Mismatched quotes in input\" otherwise (found live in Phase 3.5 validation)", async () => {
  const fetcher = createMockFetch([{ body: openAireResponse([]) }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await provider.search(q('above." In implementation of this, the committee is established'));
  const url = new URL(fetcher.calls[0].url);
  assert.equal(url.searchParams.get("search"), "above. In implementation of this, the committee is established");
});

test("search() leaves a curly right double quotation mark (”) and a lone apostrophe untouched — confirmed live that only the straight ASCII quote breaks OpenAIRE's parser", async () => {
  const fetcher = createMockFetch([{ body: openAireResponse([]) }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await provider.search(q("threatened with collapse.” the field of road"));
  const url = new URL(fetcher.calls[0].url);
  assert.equal(url.searchParams.get("search"), "threatened with collapse.” the field of road");
});

test("publicationsOnly: false omits the type filter", async () => {
  const fetcher = createMockFetch([{ body: openAireResponse([]) }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, publicationsOnly: false, ...FAST_CONFIG });
  await provider.search(q("q"));
  const url = new URL(fetcher.calls[0].url);
  assert.equal(url.searchParams.has("type"), false);
});

// --- FAILURE HANDLING --------------------------------------------------------

test("provider failure: HTTP 429 is classified as a rate-limit error and is never retried", async () => {
  const fetcher = createMockFetch([{ status: 429, body: {} }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchRateLimitError);
  assert.equal(fetcher.calls.length, 1, "a 429 must not be retried");
});

test("provider failure: repeated HTTP 500 is retried up to maxAttempts, then classified as provider-unavailable", async () => {
  const fetcher = createMockFetch([{ status: 500, body: {} }, { status: 500, body: {} }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchProviderUnavailableError);
  assert.equal(fetcher.calls.length, 2);
});

test("provider timeout: an aborted request is classified as a timeout error", async () => {
  const fetcher = createMockFetch([{ type: "abort" }, { type: "abort" }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchTimeoutError);
});

test("a network-level failure (no HTTP response at all) is classified as provider-unavailable", async () => {
  const fetcher = createMockFetch([{ type: "network-error" }, { type: "network-error" }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchProviderUnavailableError);
});

// --- getMetadata ---------------------------------------------------------

test("getMetadata maps a single-record lookup the same way search results are mapped", async () => {
  const fetcher = createMockFetch([{ body: fullItem() }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const metadata = await provider.getMetadata("doi_dedup___::c5f2eb16876a2b72c436e285d57faafc");
  assert.equal(metadata.title, "Fast Transformer Decoding: One Write-Head is All You Need");
  assert.equal(metadata.doi, "10.48550/arxiv.1911.02150");
});

test("getMetadata returns null (not a throw) for an unresolvable id", async () => {
  const fetcher = createMockFetch([{ status: 404, body: {} }]);
  const provider = createOpenAireAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const metadata = await provider.getMetadata("does-not-exist");
  assert.equal(metadata, null);
  assert.equal(fetcher.calls.length, 1, "a plain 404 must not be retried");
});
