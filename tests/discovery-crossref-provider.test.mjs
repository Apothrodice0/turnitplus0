import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createCrossrefDiscoveryProvider, DEFAULT_CROSSREF_PROVIDER_CONFIG } from "../lib/discovery-crossref-provider.ts";
import { DiscoveryRateLimitError, DiscoveryTimeoutError, DiscoveryProviderUnavailableError } from "../lib/discovery-providers.ts";
import { deduplicateDiscoveryResults } from "../lib/discovery-candidates.ts";

const repo = path.resolve(".");

// A fixture modeled directly on a real https://api.crossref.org/works
// response (verified against official Crossref documentation and a live
// example query before writing lib/discovery-crossref-provider.ts — see
// this phase's final report). Every field used by the provider is present
// here in its real shape (title/container-title as arrays, author objects
// with given/family, date-parts nesting).
function crossrefResponse(items) {
  return {
    status: "ok",
    "message-type": "work-list",
    "message-version": "1.0.0",
    message: { "total-results": items.length, items, "items-per-page": items.length, query: {} },
  };
}

function fullItem(overrides = {}) {
  return {
    DOI: "10.1234/example.doi",
    URL: "https://doi.org/10.1234/example.doi",
    title: ["A Study of Bioluminescent Plankton Synchronization"],
    author: [{ given: "Ada", family: "Rivers" }, { given: "Sam", family: "Cole" }],
    publisher: "Example Academic Press",
    "container-title": ["Journal of Marine Bioluminescence"],
    type: "journal-article",
    score: 80,
    "published-print": { "date-parts": [[2019, 6, 15]] },
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
    if (step.type === "raw") return new Response(step.body, { status: step.status ?? 200 });
    return new Response(JSON.stringify(step.body ?? crossrefResponse([])), { status: step.status ?? 200, headers: { "content-type": "application/json" } });
  };
  fetcher.calls = calls;
  return fetcher;
}

function requestWith(queryTexts) {
  return {
    requestId: "req-1",
    queries: queryTexts.map((queryText, i) => ({ queryText, basis: ["DISTINCTIVE_PASSAGE"], rank: i })),
    signals: { normalizedTitle: null, normalizedAuthor: null, distinctivePassages: [], canonicalHash: null, language: null },
  };
}

const FAST_CONFIG = { timeoutMs: 100, retry: { maxAttempts: 2, baseDelayMs: 10 } };

// --- PARSING / NORMALIZATION ---------------------------------------------------

test("PARSING: a well-formed Crossref item maps to a complete RawProviderResult", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem()]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["bioluminescent plankton synchronization"]));

  assert.equal(result.externalIdentifier, "10.1234/example.doi");
  assert.equal(result.externalIdentifierType, "DOI");
  assert.equal(result.url, "https://doi.org/10.1234/example.doi");
  assert.equal(result.title, "A Study of Bioluminescent Plankton Synchronization");
  assert.equal(result.author, "Ada Rivers; Sam Cole");
  assert.equal(result.publisher, "Example Academic Press");
  assert.equal(result.publicationDate, "2019-06-15");
  assert.equal(result.sourceClass, "JOURNAL_PUBLISHER");
  assert.equal(result.providerConfidence, 1, "the only item in the response should normalize to the maximum, 1");
  assert.equal(result.querySignalUsed, "bioluminescent plankton synchronization");
  assert.ok(result.discoveredAt);
});

test("PARSING: title takes the first array element; missing title array is null", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem({ title: undefined })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["q"]));
  assert.equal(result.title, null);
});

test("PARSING: more than five authors is truncated with 'et al.'", async () => {
  const manyAuthors = Array.from({ length: 7 }, (_, i) => ({ given: `First${i}`, family: `Last${i}` }));
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem({ author: manyAuthors })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["q"]));
  assert.equal(result.author, "First0 Last0; First1 Last1; First2 Last2; First3 Last3; First4 Last4 et al.");
});

test("PARSING: missing author array is null, not an empty string", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem({ author: undefined })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["q"]));
  assert.equal(result.author, null);
});

test("PARSING: container-title is used as a publisher fallback only when publisher is absent", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem({ publisher: undefined, "container-title": ["Fallback Journal Name"] })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["q"]));
  assert.equal(result.publisher, "Fallback Journal Name");
});

test("PARSING: publication date prefers published-print, then published-online, then issued, then published", async () => {
  const fetcher = createMockFetch([
    { body: crossrefResponse([fullItem({ "published-print": undefined, "published-online": { "date-parts": [[2020, 3]] }, issued: { "date-parts": [[2021]] } })]) },
  ]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["q"]));
  assert.equal(result.publicationDate, "2020-03", "published-online should win when published-print is absent");
});

test("PARSING: a year-only date-parts value formats as just the year", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem({ "published-print": undefined, issued: { "date-parts": [[2018]] } })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["q"]));
  assert.equal(result.publicationDate, "2018");
});

test("PARSING: no usable date anywhere is null, never invented", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem({ "published-print": undefined })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["q"]));
  assert.equal(result.publicationDate, null);
});

test("PARSING: URL falls back to the doi.org resolver link when Crossref's own URL field is absent", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem({ URL: undefined, DOI: "10.9/xyz" })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["q"]));
  assert.equal(result.url, "https://doi.org/10.9/xyz");
});

test("PARSING: URL and DOI both absent is null, never fabricated", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem({ URL: undefined, DOI: undefined })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["q"]));
  assert.equal(result.url, null);
  assert.equal(result.externalIdentifier, null);
  assert.equal(result.externalIdentifierType, null);
});

test("PARSING: source class — journal-article maps to JOURNAL_PUBLISHER, everything else maps to UNKNOWN, never guessed", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([
    fullItem({ DOI: "10.1/a", type: "journal-article" }),
    fullItem({ DOI: "10.1/b", type: "posted-content" }),
    fullItem({ DOI: "10.1/c", type: "book-chapter" }),
    fullItem({ DOI: "10.1/d", type: undefined }),
  ]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const results = await provider.discover(requestWith(["q"]));
  assert.deepEqual(results.map((r) => r.sourceClass), ["JOURNAL_PUBLISHER", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
});

test("PARSING: providerConfidence is normalized 0..1 relative to the highest score in the same response, never Crossref's raw unbounded score", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([
    fullItem({ DOI: "10.1/high", score: 100 }),
    fullItem({ DOI: "10.1/low", score: 25 }),
  ]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const results = await provider.discover(requestWith(["q"]));
  assert.equal(results[0].providerConfidence, 1);
  assert.equal(results[1].providerConfidence, 0.25);
});

test("PARSING: missing score normalizes to null", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem({ score: undefined })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const [result] = await provider.discover(requestWith(["q"]));
  assert.equal(result.providerConfidence, null);
});

test("PARSING: zero results is an empty array, not an error", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const results = await provider.discover(requestWith(["q"]));
  assert.deepEqual(results, []);
});

// --- REQUEST CONSTRUCTION --------------------------------------------------

test("REQUEST: uses query.bibliographic, rows, and the Crossref /works endpoint", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, maxResultsPerRequest: 7, ...FAST_CONFIG });
  await provider.discover(requestWith(["synchronized bioluminescence patterns"]));
  const calledUrl = new URL(fetcher.calls[0].url);
  assert.equal(calledUrl.origin + calledUrl.pathname, "https://api.crossref.org/works");
  assert.equal(calledUrl.searchParams.get("query.bibliographic"), "synchronized bioluminescence patterns");
  assert.equal(calledUrl.searchParams.get("rows"), "7");
});

test("REQUEST: mailto is included only when a contact email is configured", async () => {
  const withEmail = createMockFetch([{ body: crossrefResponse([]) }]);
  await createCrossrefDiscoveryProvider({ fetcher: withEmail, contactEmail: "discovery-test@example.org", ...FAST_CONFIG }).discover(requestWith(["q"]));
  assert.equal(new URL(withEmail.calls[0].url).searchParams.get("mailto"), "discovery-test@example.org");

  const withoutEmail = createMockFetch([{ body: crossrefResponse([]) }]);
  await createCrossrefDiscoveryProvider({ fetcher: withoutEmail, ...FAST_CONFIG }).discover(requestWith(["q"]));
  assert.equal(new URL(withoutEmail.calls[0].url).searchParams.has("mailto"), false);
});

test("REQUEST: sends a descriptive User-Agent header", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([]) }]);
  await createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG }).discover(requestWith(["q"]));
  assert.match(fetcher.calls[0].init.headers["User-Agent"], /TurnitPlus/);
});

test("REQUEST: never sends more than maxRequestsPerRun HTTP calls, even with more queries available", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([]) }, { body: crossrefResponse([]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, maxRequestsPerRun: 2, ...FAST_CONFIG });
  await provider.discover(requestWith(["q1", "q2", "q3", "q4", "q5", "q6"]));
  assert.equal(fetcher.calls.length, 2);
});

test("REQUEST: zero queries means zero HTTP calls", async () => {
  const fetcher = createMockFetch([]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const results = await provider.discover(requestWith([]));
  assert.deepEqual(results, []);
  assert.equal(fetcher.calls.length, 0);
});

test("REQUEST: default config bounds are conservative (matches DEFAULT_CROSSREF_PROVIDER_CONFIG)", () => {
  assert.ok(DEFAULT_CROSSREF_PROVIDER_CONFIG.maxRequestsPerRun <= 6, "must stay within (or under) E6A's own bounded query count");
  assert.ok(DEFAULT_CROSSREF_PROVIDER_CONFIG.maxResultsPerRequest <= 20, "must not request an excessive rows count per query");
});

// --- ERROR HANDLING --------------------------------------------------------

test("FAILURE: HTTP 429 is classified as DiscoveryRateLimitError and is never retried", async () => {
  const fetcher = createMockFetch([{ status: 429 }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.discover(requestWith(["q"])), DiscoveryRateLimitError);
  assert.equal(fetcher.calls.length, 1, "a 429 must not be retried");
});

test("FAILURE: HTTP 5xx is classified as DiscoveryProviderUnavailableError and IS retried up to maxAttempts", async () => {
  const fetcher = createMockFetch([{ status: 503 }, { status: 503 }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.discover(requestWith(["q"])), DiscoveryProviderUnavailableError);
  assert.equal(fetcher.calls.length, FAST_CONFIG.retry.maxAttempts);
});

test("FAILURE: HTTP 400 is a plain classified error and is NOT retried", async () => {
  const fetcher = createMockFetch([{ status: 400 }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.discover(requestWith(["q"])), /HTTP 400/);
  assert.equal(fetcher.calls.length, 1, "a 4xx is deterministic — retrying it cannot help");
});

test("FAILURE: HTTP 401/403 are handled the same as any other non-2xx status, not specially trusted", async () => {
  const fetcher401 = createMockFetch([{ status: 401 }]);
  await assert.rejects(() => createCrossrefDiscoveryProvider({ fetcher: fetcher401, ...FAST_CONFIG }).discover(requestWith(["q"])), /HTTP 401/);
  const fetcher403 = createMockFetch([{ status: 403 }]);
  await assert.rejects(() => createCrossrefDiscoveryProvider({ fetcher: fetcher403, ...FAST_CONFIG }).discover(requestWith(["q"])), /HTTP 403/);
});

test("FAILURE: HTTP 404 is handled the same as any other non-2xx status", async () => {
  const fetcher = createMockFetch([{ status: 404 }]);
  await assert.rejects(() => createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG }).discover(requestWith(["q"])), /HTTP 404/);
});

test("FAILURE: malformed JSON is reported clearly and is not retried", async () => {
  const fetcher = createMockFetch([{ type: "raw", body: "not valid json {{{" }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.discover(requestWith(["q"])), /malformed JSON/);
  assert.equal(fetcher.calls.length, 1);
});

test("FAILURE: an unexpected response shape (message.items missing) is reported clearly", async () => {
  const fetcher = createMockFetch([{ body: { status: "ok", message: {} } }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.discover(requestWith(["q"])), /unexpected response shape/);
});

test("FAILURE: a network-level failure (fetch itself rejects) is classified as DiscoveryProviderUnavailableError and IS retried", async () => {
  const fetcher = createMockFetch([{ type: "network-error" }, { type: "network-error" }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.discover(requestWith(["q"])), DiscoveryProviderUnavailableError);
  assert.equal(fetcher.calls.length, FAST_CONFIG.retry.maxAttempts);
});

test("FAILURE: a timeout is classified as DiscoveryTimeoutError", async () => {
  const fetcher = createMockFetch([{ type: "abort" }, { type: "abort" }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, timeoutMs: 20, retry: { maxAttempts: 2, baseDelayMs: 5 } });
  await assert.rejects(() => provider.discover(requestWith(["q"])), DiscoveryTimeoutError);
});

test("FAILURE: one bad query among several does not prevent the others from succeeding", async () => {
  const fetcher = createMockFetch([{ status: 400 }, { body: crossrefResponse([fullItem()]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const results = await provider.discover(requestWith(["bad query", "good query"]));
  assert.equal(results.length, 1);
  assert.equal(results[0].querySignalUsed, "good query");
});

test("FAILURE: if every query fails, discover() throws the first error rather than silently returning nothing", async () => {
  const fetcher = createMockFetch([{ status: 400 }, { status: 404 }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  await assert.rejects(() => provider.discover(requestWith(["q1", "q2"])), /HTTP 400/);
});

test("FAILURE: a rate limit hit AFTER at least one query already succeeded returns the results gathered so far instead of throwing", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem()]) }, { status: 429 }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const results = await provider.discover(requestWith(["q1", "q2"]));
  assert.equal(results.length, 1);
  assert.equal(fetcher.calls.length, 2, "the second (rate-limited) query is still attempted once, then discovery stops there");
});

// --- DEDUPLICATION via the shared E6A pipeline ---------------------------------

test("INTEGRATION: two Crossref results with the same DOI (different casing) deduplicate through lib/discovery-candidates.ts", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([fullItem({ DOI: "10.1234/Example.DOI" }), fullItem({ DOI: "10.1234/example.doi" })]) }]);
  const provider = createCrossrefDiscoveryProvider({ fetcher, ...FAST_CONFIG });
  const results = await provider.discover(requestWith(["q"]));
  const tagged = results.map((r) => ({ ...r, providerId: provider.id, providerType: provider.type }));
  const candidates = deduplicateDiscoveryResults(tagged);
  assert.equal(candidates.length, 1, "the same DOI in different casing must dedupe to one candidate");
});

// --- SECURITY (CASE I) / RUNTIME SAFETY -----------------------------------------

// Strips comments before searching code — this file's own doc comments
// legitimately name approveVerification/transitionProvenanceState in prose
// (explaining what this provider must never do), which would otherwise
// false-positive a plain substring search; same established fix as
// tests/provenance-scoring-invariance.test.mjs's stripComments.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("CASE I: lib/discovery-crossref-provider.ts never imports or calls any E5 verification/approval function", () => {
  const source = fs.readFileSync(path.join(repo, "lib", "discovery-crossref-provider.ts"), "utf8");
  const imports = source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  assert.doesNotMatch(imports, /provenance-verification-workflow/, "the Crossref provider must never import the verification workflow");
  assert.doesNotMatch(stripComments(source), /approveVerification|transitionProvenanceState/, "the Crossref provider must never call approval/transition functions");
});

test("RUNTIME SAFETY: lib/discovery-crossref-provider.ts is not imported by app/page.tsx or any client component", () => {
  const appFiles = fs.readdirSync(path.join(repo, "app"), { recursive: true })
    .filter((f) => typeof f === "string" && (f.endsWith(".tsx") || f.endsWith(".ts")))
    .map((f) => path.join(repo, "app", f));
  const offenders = [];
  for (const file of appFiles) {
    const source = fs.readFileSync(file, "utf8");
    if (/discovery-crossref-provider/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `the Crossref provider must not be reachable from app/: ${offenders.join(", ")}`);
});

test("PRIVACY: the constructed request URL never carries anything beyond the configured contact email and the bounded query text", async () => {
  const fetcher = createMockFetch([{ body: crossrefResponse([]) }]);
  await createCrossrefDiscoveryProvider({ fetcher, contactEmail: "discovery-test@example.org", ...FAST_CONFIG }).discover(requestWith(["bounded distinctive passage text"]));
  const params = [...new URL(fetcher.calls[0].url).searchParams.keys()];
  assert.deepEqual(params.sort(), ["mailto", "query.bibliographic", "rows"]);
});
