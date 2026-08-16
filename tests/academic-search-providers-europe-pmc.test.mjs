import assert from "node:assert/strict";
import test from "node:test";
import { createEuropePmcAcademicSearchProvider } from "../lib/academic-search/providers/europe-pmc.ts";
import {
  AcademicSearchProviderUnavailableError,
  AcademicSearchRateLimitError,
  AcademicSearchTimeoutError,
} from "../lib/academic-search/provider.ts";

/**
 * Deterministic, no-network tests — fixture shapes lifted directly from real
 * HTTP 200 responses captured against
 * https://www.ebi.ac.uk/europepmc/webservices/rest/ during this phase (see
 * providers/europe-pmc.ts's header comment).
 */

function epmcSearchResponse(results) {
  return { hitCount: results.length, resultList: { result: results } };
}

function oaItem(overrides = {}) {
  return {
    id: "42139240",
    source: "MED",
    pmid: "42139240",
    pmcid: "PMC13178875",
    doi: "10.1371/journal.pdig.0001424",
    title: "Cross-spectral fusion of thermal and RGB imaging for objective pain estimation.",
    authorString: "El Othmani O, Naouali S.",
    journalTitle: "PLOS Digit Health",
    pubYear: "2026",
    isOpenAccess: "Y",
    inEPMC: "Y",
    ...overrides,
  };
}

function closedItem(overrides = {}) {
  return {
    id: "PPR1296446",
    source: "PPR",
    doi: "10.64898/2026.08.09.743771",
    title: "CRISPR-FOIL: A Programmable CRISPR Tool to Engineer and Illuminate Chromatin Folding in Live Human Cells",
    authorString: "Chung Y, Willey S, He S, Wise N, Tu L.",
    pubYear: "2026",
    isOpenAccess: "N",
    inEPMC: "N",
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
    if (step.type === "xml") {
      return new Response(step.body ?? "", { status: step.status ?? 200, headers: { "content-type": "application/xml" } });
    }
    return new Response(JSON.stringify(step.body ?? epmcSearchResponse([])), {
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

test("PARSING: a well-formed OA Europe PMC result maps to a complete AcademicSearchResult", async () => {
  const fetcher = createMockFetch([{ body: epmcSearchResponse([oaItem()]) }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("cross spectral fusion thermal RGB pain"));

  assert.equal(result.providerId, "europe-pmc");
  assert.equal(result.externalId, "PMC13178875", "externalId prefers pmcid over the bare id");
  assert.equal(result.title, "Cross-spectral fusion of thermal and RGB imaging for objective pain estimation.");
  assert.deepEqual(result.authors, ["El Othmani O", "Naouali S"]);
  assert.equal(result.doi, "10.1371/journal.pdig.0001424");
  assert.equal(result.year, 2026);
  assert.equal(result.publication, "PLOS Digit Health");
  assert.equal(result.url, "https://europepmc.org/article/PMC/PMC13178875");
  assert.equal(result.textAvailable, true);
});

test("PARSING: a closed-access, PMCID-less result has textAvailable false and externalId falls back to the bare id", async () => {
  const fetcher = createMockFetch([{ body: epmcSearchResponse([closedItem()]) }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));

  assert.equal(result.externalId, "PPR1296446");
  assert.equal(result.textAvailable, false);
  assert.equal(result.url, "https://doi.org/10.64898/2026.08.09.743771");
});

test("PARSING: an OA-flagged result with no pmcid is still textAvailable: false (pmcid is required)", async () => {
  const fetcher = createMockFetch([{ body: epmcSearchResponse([oaItem({ pmcid: undefined })]) }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));
  assert.equal(result.textAvailable, false);
});

test("PARSING: missing authorString is null, not an empty array", async () => {
  const fetcher = createMockFetch([{ body: epmcSearchResponse([oaItem({ authorString: undefined })]) }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.search(q("q"));
  assert.equal(result.authors, null);
});

// --- REQUEST SHAPE -----------------------------------------------------------

test("search() sends the query text and an OA filter is only added when configured", async () => {
  const fetcher = createMockFetch([{ body: epmcSearchResponse([]) }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await provider.search(q("distinctive phrase"));
  const url = new URL(fetcher.calls[0].url);
  assert.equal(url.searchParams.get("query"), "distinctive phrase");

  const fetcher2 = createMockFetch([{ body: epmcSearchResponse([]) }]);
  const provider2 = createEuropePmcAcademicSearchProvider({ fetcher: fetcher2, extraQueryFilter: "OPEN_ACCESS:Y", ...FAST_CONFIG });
  await provider2.search(q("distinctive phrase"));
  const url2 = new URL(fetcher2.calls[0].url);
  assert.equal(url2.searchParams.get("query"), "distinctive phrase AND OPEN_ACCESS:Y");
});

// --- FAILURE HANDLING --------------------------------------------------------

test("provider failure: HTTP 429 is classified as a rate-limit error and is never retried", async () => {
  const fetcher = createMockFetch([{ status: 429, body: {} }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchRateLimitError);
  assert.equal(fetcher.calls.length, 1);
});

test("provider failure: repeated HTTP 500 is retried up to maxAttempts, then classified as provider-unavailable", async () => {
  const fetcher = createMockFetch([{ status: 500, body: {} }, { status: 500, body: {} }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchProviderUnavailableError);
  assert.equal(fetcher.calls.length, 2);
});

test("provider timeout: an aborted request is classified as a timeout error", async () => {
  const fetcher = createMockFetch([{ type: "abort" }, { type: "abort" }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchTimeoutError);
});

test("a network-level failure (no HTTP response at all) is classified as provider-unavailable", async () => {
  const fetcher = createMockFetch([{ type: "network-error" }, { type: "network-error" }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.search(q("q")), AcademicSearchProviderUnavailableError);
});

// --- getText ---------------------------------------------------------------

test("getText: a PMC-shaped externalId fetches fullTextXML and returns clean text", async () => {
  const xml = `<article><body><sec><title>1 Introduction</title><p>Pain assessment in non-verbal patients is a critical unmet need.</p></sec></body></article>`;
  const fetcher = createMockFetch([{ type: "xml", body: xml }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const text = await provider.getText("PMC13178875");
  assert.ok(text.includes("Pain assessment in non-verbal patients is a critical unmet need."));
  assert.equal(fetcher.calls[0].url.includes("/PMC13178875/fullTextXML"), true);
});

test("getText: a non-PMC externalId never makes a network call and returns null", async () => {
  const fetcher = createMockFetch([]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const text = await provider.getText("PPR1296446");
  assert.equal(text, null);
  assert.equal(fetcher.calls.length, 0, "no full-text fetch should be attempted for an article the provider never makes full text available for");
});

test("getText: a 404 (no full text for this id) resolves to null, never throws", async () => {
  const fetcher = createMockFetch([{ status: 404, type: "xml", body: "" }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const text = await provider.getText("PMC00000000");
  assert.equal(text, null);
});

test("getText swallows a provider-level error and returns null rather than throwing", async () => {
  const fetcher = createMockFetch([{ status: 500, type: "xml", body: "" }, { status: 500, type: "xml", body: "" }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const text = await provider.getText("PMC13178875");
  assert.equal(text, null);
});

// --- getMetadata -------------------------------------------------------------

test("getMetadata: a PMC-shaped id queries by PMCID, a bare id queries by EXT_ID", async () => {
  const fetcher = createMockFetch([{ body: epmcSearchResponse([oaItem()]) }, { body: epmcSearchResponse([closedItem()]) }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });

  await provider.getMetadata("PMC13178875");
  assert.ok(new URL(fetcher.calls[0].url).searchParams.get("query").includes("PMCID:PMC13178875"));

  await provider.getMetadata("PPR1296446");
  assert.ok(new URL(fetcher.calls[1].url).searchParams.get("query").includes("EXT_ID:PPR1296446"));
});

test("getMetadata returns null (not a throw) when nothing matches", async () => {
  const fetcher = createMockFetch([{ body: epmcSearchResponse([]) }]);
  const provider = createEuropePmcAcademicSearchProvider({ fetcher, ...FAST_CONFIG });
  const metadata = await provider.getMetadata("does-not-exist");
  assert.equal(metadata, null);
});
