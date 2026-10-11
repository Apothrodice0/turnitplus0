import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createHttpContentRetriever } from "../lib/http-content-retriever.ts";
import { DEFAULT_RETRIEVAL_SAFETY_CONFIG } from "../lib/retrieval-safety.ts";
import { createRetrievalTrace } from "../lib/retrieval-types.ts";
import { retrieveCandidateText } from "../lib/academic-search/text-retriever.ts";
import { DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, runAcademicSearch } from "../lib/academic-search/orchestrator.ts";
import { ACADEMIC_RETRIEVAL_DIAGNOSTICS_VERSION } from "../lib/academic-search/types.ts";
import { findRecentAcademicSearchRunDiagnostics, recordAcademicSearchRunDiagnostics } from "../lib/academic-search-diagnostics-repo.ts";

/**
 * Academic-search retrieval diagnostics v1 (2026-10-11 U13 investigation). A candidate the search found could fail to
 * download its text, and the diagnostics row only kept the status enum — not which host refused, with which code, or at
 * which redirect stage. These tests pin the structured detail now recorded per candidate, and prove it is observability
 * only: it never changes which URL is fetched, what text comes back, the evidence, the stats or the status, and it never
 * stores a path, query string, credential, resolved IP address or free-text error message.
 *
 * No real network: every HTTP exchange goes through the shared retriever's existing `fetcher` / `lookup` injection.
 */

// ---- DB for the persistence round-trip (set up before any test() is registered — see the TLA-race note in memory) ----
const dbFile = path.join(process.env.TURNITPLUS_TEST_DB_DIR ?? os.tmpdir(), "test_academic_search_retrieval_diagnostics.db");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbFile}${suffix}`, { force: true });
const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, path.resolve("drizzle"));
after(() => db.close());

const SUBMISSION = `
  Digital transformation in commercial banking reshapes how employees perform routine operational tasks every day.
  Branch employees reported that electronic payment platforms reduced manual processing time considerably overall.
  Continuous professional training programmes were essential for adapting staff capabilities to new banking systems.
  Managers emphasised that customer experience improvements depended on integrated digital service channels.
`;

function lookupFor(map = {}) {
  return async (hostname) => {
    const entry = map[hostname];
    if (entry instanceof Error) throw entry;
    return entry ?? [{ address: "93.184.216.34", family: 4 }];
  };
}
const html = (body, status = 200, contentType = "text/html") => new Response(body, { status, headers: { "content-type": contentType } });
const redirect = (location, status = 302) => new Response(null, { status, headers: location ? { location } : {} });
const articleHtml = `<html><body><p>${SUBMISSION}</p></body></html>`;

/** A fetcher routed by exact URL; `"abort"` waits for the abort signal, an Error is thrown, a function is called. */
function routedFetcher(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(String(url));
    const route = routes[String(url)];
    if (route === undefined) throw new Error(`unrouted URL in test: ${url}`);
    if (route === "abort") {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))));
    }
    if (route instanceof Error) throw route;
    return typeof route === "function" ? route() : route.clone();
  };
  return { fetcher, calls };
}

function retrieverFor(routes, { lookup = lookupFor(), timeoutMs = 2_000, maxRedirects } = {}) {
  const { fetcher, calls } = routedFetcher(routes);
  const safety = maxRedirects === undefined ? DEFAULT_RETRIEVAL_SAFETY_CONFIG : { ...DEFAULT_RETRIEVAL_SAFETY_CONFIG, maxRedirects };
  return { retriever: createHttpContentRetriever({ fetcher, lookup, timeoutMs, safety, allowedContentTypes: ["text/html", "application/pdf"], maxResponseBytes: 10_000_000 }), calls };
}

function candidate({ url, contributors = [{ providerId: "openaire", externalId: "oa-1" }], key = "doi:10.1/x", rank = 0 } = {}) {
  return { candidateKey: key, doi: key.startsWith("doi:") ? key.slice(4) : null, url, title: "A Candidate", authors: null, publication: null, year: null, textAvailable: false, abstract: null, contributors, rank };
}

/** Everything a stored detail must never contain (paths, query strings, secrets, IPs, raw error text). */
function assertPrivate(detail, forbidden) {
  const json = JSON.stringify(detail);
  for (const needle of forbidden) assert.ok(!json.includes(needle), `diagnostics must not contain ${JSON.stringify(needle)}: ${json}`);
  assert.ok(!("errorMessage" in detail), "no free-text error message is stored");
  for (const hop of detail.hops) assert.ok(!/[/?#@]/.test(hop.host ?? ""), `hop host must be a bare host: ${hop.host}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Successful retrieval
test("1. successful HTTP-fallback retrieval records host, 200 and no error", async () => {
  const url = "https://journal.example.org/article/1?session=SECRET123";
  const { retriever } = retrieverFor({ [url]: html(articleHtml) });
  const r = await retrieveCandidateText(candidate({ url }), {}, retriever);
  assert.equal(r.source, "http-fallback");
  assert.ok(r.text && r.text.includes("Digital transformation"));
  assert.deepEqual(r.detail, {
    providerTextAttempts: [], providerTextAttemptCount: 0, httpFallbackAttempted: true,
    attemptedHost: "journal.example.org", finalHost: "journal.example.org", httpStatusCode: 200,
    errorCategory: null, failureStage: null, redirectCount: 0, citationPdfFollowed: false,
    hops: [{ kind: "initial", host: "journal.example.org", httpStatus: 200 }], networkErrorCode: null, safetyFailure: null,
  });
  assertPrivate(r.detail, ["SECRET123", "session", "/article"]);
});

// 2-5. HTTP error codes, including the U13 shape (doi.org redirect, then the publisher refuses)
for (const [code, category] of [[403, "HTTP_403_FORBIDDEN"], [404, "HTTP_404_NOT_FOUND"], [429, "HTTP_429_RATE_LIMITED"], [500, "HTTP_5XX_SERVER_ERROR"], [503, "HTTP_5XX_SERVER_ERROR"], [401, "HTTP_401_UNAUTHORIZED"], [410, "HTTP_4XX_OTHER"]]) {
  test(`2-5. doi.org redirect then HTTP ${code} at the publisher → ${category}, stage RESPONSE_STATUS`, async () => {
    const doi = "https://doi.org/10.61093/sec.9(3).48-63.2025";
    const landing = "https://publisher.example.org/landing?token=abc123";
    const { retriever } = retrieverFor({ [doi]: redirect(landing), [landing]: html("<p>blocked</p>", code) });
    const r = await retrieveCandidateText(candidate({ url: doi }), {}, retriever);
    assert.equal(r.source, "unavailable");
    assert.equal(r.text, null);
    assert.equal(r.httpRetrievalStatus, "HTTP_ERROR", "the existing status enum is unchanged");
    const d = r.detail;
    assert.equal(d.errorCategory, category);
    assert.equal(d.failureStage, "RESPONSE_STATUS");
    assert.equal(d.httpStatusCode, code);
    assert.equal(d.attemptedHost, "doi.org");
    assert.equal(d.finalHost, "publisher.example.org");
    assert.equal(d.redirectCount, 1);
    assert.deepEqual(d.hops, [{ kind: "initial", host: "doi.org", httpStatus: 302 }, { kind: "redirect", host: "publisher.example.org", httpStatus: code }]);
    assertPrivate(d, ["token", "abc123", "/landing", "10.61093"]);
  });
}

// 6. Network timeout / network error
test("6a. network timeout → TIMEOUT at stage REQUEST, no status code", async () => {
  const url = "https://slow.example.org/paper";
  const { retriever } = retrieverFor({ [url]: "abort" }, { timeoutMs: 30 });
  const r = await retrieveCandidateText(candidate({ url }), {}, retriever);
  assert.equal(r.httpRetrievalStatus, "TIMEOUT");
  assert.equal(r.detail.errorCategory, "TIMEOUT");
  assert.equal(r.detail.failureStage, "REQUEST");
  assert.equal(r.detail.httpStatusCode, null);
  assert.deepEqual(r.detail.hops, [{ kind: "initial", host: "slow.example.org", httpStatus: null }]);
  assert.equal(r.detail.networkErrorCode, null);
});

test("6b. connection reset → NETWORK_ERROR with the bare system code only (no message, no IP)", async () => {
  const url = "https://reset.example.org/paper";
  const error = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET 203.0.113.9:443"), { code: "ECONNRESET" }) });
  const { retriever } = retrieverFor({ [url]: error });
  const r = await retrieveCandidateText(candidate({ url }), {}, retriever);
  assert.equal(r.detail.errorCategory, "NETWORK_ERROR");
  assert.equal(r.detail.failureStage, "REQUEST");
  assert.equal(r.detail.networkErrorCode, "ECONNRESET");
  assertPrivate(r.detail, ["203.0.113.9", "read ECONNRESET", "fetch failed"]);
});

// 7. Redirect failures
test("7a. redirect to a private address → UNSAFE_REDIRECT_TARGET at SAFETY_CHECK, category BLOCKED_ADDRESS, IP not stored", async () => {
  const doi = "https://doi.org/10.1/private";
  const internal = "http://internal.example.org/admin?key=zzz";
  const { retriever, calls } = retrieverFor({ [doi]: redirect(internal) }, { lookup: lookupFor({ "internal.example.org": [{ address: "10.0.0.5", family: 4 }] }) });
  const r = await retrieveCandidateText(candidate({ url: doi }), {}, retriever);
  assert.equal(r.httpRetrievalStatus, "REDIRECT_BLOCKED");
  assert.equal(r.detail.errorCategory, "UNSAFE_REDIRECT_TARGET");
  assert.equal(r.detail.failureStage, "SAFETY_CHECK");
  assert.equal(r.detail.safetyFailure, "BLOCKED_ADDRESS");
  assert.deepEqual(r.detail.hops, [{ kind: "initial", host: "doi.org", httpStatus: 302 }, { kind: "redirect", host: "internal.example.org", httpStatus: null }]);
  assert.deepEqual(calls, [doi], "the blocked target is never requested");
  assertPrivate(r.detail, ["10.0.0.5", "key=zzz", "/admin"]);
});

test("7b. the candidate URL itself fails DNS → UNSAFE_URL, DNS_FAILED, DNS error text not stored", async () => {
  const url = "https://nosuch.example.org/paper";
  const { retriever, calls } = retrieverFor({}, { lookup: lookupFor({ "nosuch.example.org": new Error("getaddrinfo ENOTFOUND nosuch.example.org") }) });
  const r = await retrieveCandidateText(candidate({ url }), {}, retriever);
  assert.equal(r.detail.errorCategory, "UNSAFE_URL");
  assert.equal(r.detail.safetyFailure, "DNS_FAILED");
  assert.equal(calls.length, 0);
  assertPrivate(r.detail, ["getaddrinfo", "ENOTFOUND"]);
});

test("7c. redirect loop beyond the limit → REDIRECT_LIMIT_EXCEEDED at stage REDIRECT", async () => {
  const a = "https://loop.example.org/a", b = "https://loop.example.org/b", c = "https://loop.example.org/c";
  const { retriever } = retrieverFor({ [a]: redirect(b), [b]: redirect(c), [c]: redirect(a) }, { maxRedirects: 2 });
  const r = await retrieveCandidateText(candidate({ url: a }), {}, retriever);
  assert.equal(r.detail.errorCategory, "REDIRECT_LIMIT_EXCEEDED");
  assert.equal(r.detail.failureStage, "REDIRECT");
  assert.equal(r.detail.redirectCount, 2, "redirects actually followed");
  assert.equal(r.detail.hops.length, 3);
});

test("7d. 3xx with no Location → HTTP_3XX_NO_LOCATION at stage REDIRECT", async () => {
  const url = "https://broken.example.org/x";
  const { retriever } = retrieverFor({ [url]: redirect(null, 301) });
  const r = await retrieveCandidateText(candidate({ url }), {}, retriever);
  assert.equal(r.httpRetrievalStatus, "HTTP_ERROR");
  assert.equal(r.detail.errorCategory, "HTTP_3XX_NO_LOCATION");
  assert.equal(r.detail.failureStage, "REDIRECT");
  assert.equal(r.detail.httpStatusCode, 301);
});

test("7e. landing page → citation_pdf_url → 403 at the PDF host: citation stage recorded, signed query not stored", async () => {
  const landing = "https://journal.example.org/article/9";
  const pdf = "https://cdn.example.org/files/paper.pdf?Signature=XYZsecret";
  const page = `<html><head><meta name="citation_pdf_url" content="${pdf}"></head><body><p>abstract only</p></body></html>`;
  const { retriever } = retrieverFor({ [landing]: html(page), [pdf]: html("denied", 403) });
  const r = await retrieveCandidateText(candidate({ url: landing }), {}, retriever);
  assert.equal(r.detail.errorCategory, "HTTP_403_FORBIDDEN");
  assert.equal(r.detail.citationPdfFollowed, true);
  assert.deepEqual(r.detail.hops, [{ kind: "initial", host: "journal.example.org", httpStatus: 200 }, { kind: "citation_pdf", host: "cdn.example.org", httpStatus: 403 }]);
  assertPrivate(r.detail, ["Signature", "XYZsecret", "paper.pdf", "/files"]);
});

// 8. Source found but text inaccessible
test("8a. no provider text and no URL → NO_TEXT_SOURCE, provider attempt recorded, no HTTP attempt", async () => {
  const providers = { "europe-pmc": { id: "europe-pmc", async search() { return []; }, async getText() { return null; } } };
  const r = await retrieveCandidateText(candidate({ url: null, contributors: [{ providerId: "europe-pmc", externalId: "PMC1" }] }), providers);
  assert.equal(r.source, "unavailable");
  assert.equal(r.httpRetrievalStatus, undefined, "no HTTP fallback status when there was no URL (unchanged)");
  assert.equal(r.detail.errorCategory, "NO_TEXT_SOURCE");
  assert.equal(r.detail.httpFallbackAttempted, false);
  assert.deepEqual(r.detail.providerTextAttempts, [{ providerId: "europe-pmc", outcome: "NO_TEXT" }]);
});

test("8b. provider getText throws, then the HTTP fallback serves an unsupported type → ERROR attempt + UNSUPPORTED_CONTENT_TYPE", async () => {
  const url = "https://repo.example.org/item/7";
  const { retriever } = retrieverFor({ [url]: html("binary", 200, "application/msword") });
  const providers = { "europe-pmc": { id: "europe-pmc", async search() { return []; }, async getText() { throw new Error("upstream 502 from https://www.ebi.ac.uk/secret-path"); } } };
  const r = await retrieveCandidateText(candidate({ url, contributors: [{ providerId: "europe-pmc", externalId: "PMC2" }] }), providers, retriever);
  assert.deepEqual(r.detail.providerTextAttempts, [{ providerId: "europe-pmc", outcome: "ERROR" }]);
  assert.equal(r.detail.errorCategory, "UNSUPPORTED_CONTENT_TYPE");
  assert.equal(r.detail.failureStage, "CONTENT_TYPE");
  assertPrivate(r.detail, ["secret-path", "upstream 502"]);
});

test("8c. provider supplies text → TEXT attempt, no HTTP attempt, no error", async () => {
  const providers = { "europe-pmc": { id: "europe-pmc", async search() { return []; }, async getText() { return SUBMISSION; } } };
  const r = await retrieveCandidateText(candidate({ url: "https://never-fetched.example.org/x", contributors: [{ providerId: "europe-pmc", externalId: "PMC3" }] }), providers);
  assert.equal(r.source, "provider");
  assert.equal(r.detail.httpFallbackAttempted, false);
  assert.equal(r.detail.errorCategory, null);
  assert.deepEqual(r.detail.providerTextAttempts, [{ providerId: "europe-pmc", outcome: "TEXT" }]);
});

test("8d. detail stays bounded: 10 provider attempts → 8 recorded, count 10", async () => {
  const providers = { "europe-pmc": { id: "europe-pmc", async search() { return []; }, async getText() { return null; } } };
  const contributors = Array.from({ length: 10 }, (_, i) => ({ providerId: "europe-pmc", externalId: `PMC${i}` }));
  const r = await retrieveCandidateText(candidate({ url: null, contributors }), providers);
  assert.equal(r.detail.providerTextAttempts.length, 8);
  assert.equal(r.detail.providerTextAttemptCount, 10);
});

// 9. Multiple candidates through the full pipeline
const okUrl = "https://journal.example.org/ok-article";
const refusedUrl = "https://doi.org/10.2/refused";
const refusedLanding = "https://blocked-publisher.example.org/paper";
function twoCandidateProvider() {
  return {
    id: "openaire",
    async search(query) {
      return [
        { providerId: "openaire", externalId: "oa-ok", title: "Digital transformation and bank employee performance", authors: null, publication: null, year: 2025, doi: "10.1/ok", url: okUrl, textAvailable: false, querySignalUsed: query.queryText, providerRelevance: null },
        { providerId: "openaire", externalId: "oa-refused", title: "Banking employees and digital service channels", authors: null, publication: null, year: 2025, doi: "10.2/refused", url: refusedUrl, textAvailable: false, querySignalUsed: query.queryText, providerRelevance: null },
      ];
    },
  };
}
const pipelineRoutes = () => ({ [okUrl]: html(articleHtml), [refusedUrl]: redirect(refusedLanding), [refusedLanding]: html("forbidden", 403) });

test("9. one candidate retrieved and evaluated, one found but not evaluated (403) — both described, only one is evidence", async () => {
  const { retriever } = retrieverFor(pipelineRoutes());
  const result = await runAcademicSearch(SUBMISSION, [twoCandidateProvider()], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, retriever);
  assert.equal(result.status, "COMPLETE_WITH_MATCHES");
  assert.deepEqual(result.evidence.map((e) => e.doi), ["10.1/ok"]);
  const byDoi = Object.fromEntries(result.retrievalDiagnostics.map((d) => [d.doi, d]));
  const ok = byDoi["10.1/ok"], refused = byDoi["10.2/refused"];
  assert.equal(ok.diagnosticsVersion, ACADEMIC_RETRIEVAL_DIAGNOSTICS_VERSION);
  assert.equal(ok.textRetrieved, true);
  assert.equal(ok.candidateEvaluated, true);
  assert.equal(ok.errorCategory, null);
  assert.equal(ok.includedAsEvidence, true);
  assert.equal(refused.textRetrieved, false);
  assert.equal(refused.candidateEvaluated, false, "found but could not be evaluated");
  assert.equal(refused.errorCategory, "HTTP_403_FORBIDDEN");
  assert.equal(refused.finalHost, "blocked-publisher.example.org");
  assert.equal(refused.httpRetrievalStatus, "HTTP_ERROR", "existing field unchanged");
  assert.equal(refused.comparisonSimilarity, null);
});

// Non-influence: the trace never changes what is fetched or returned, nor any pipeline outcome
const LATENCY = new Set(["retrievalLatencyMs", "searchLatencyMs", "textRetrievalLatencyMs", "comparisonLatencyMs", "totalLatencyMs"]);
const NEW_FIELDS = new Set(["diagnosticsVersion", "textRetrieved", "candidateEvaluated", "providerTextAttempts", "providerTextAttemptCount", "httpFallbackAttempted", "attemptedHost", "finalHost", "httpStatusCode", "errorCategory", "failureStage", "redirectCount", "citationPdfFollowed", "hops", "networkErrorCode", "safetyFailure"]);
const withoutKeys = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.has(k)));

test("non-influence (shared retriever): the same retrieve() with and without a trace returns identical results and makes identical requests", async () => {
  const scenarios = [
    { url: "https://journal.example.org/a", routes: { "https://journal.example.org/a": html(articleHtml) } },
    { url: "https://doi.org/10.3/a", routes: { "https://doi.org/10.3/a": redirect("https://p.example.org/a"), "https://p.example.org/a": html("x", 403) } },
    { url: "https://journal.example.org/c", routes: { "https://journal.example.org/c": html(`<meta name="citation_pdf_url" content="https://cdn.example.org/c.pdf">`), "https://cdn.example.org/c.pdf": html("x", 429) } },
    { url: "https://journal.example.org/t", routes: { "https://journal.example.org/t": html("x", 200, "application/zip") } },
  ];
  for (const s of scenarios) {
    const plain = retrieverFor(s.routes), traced = retrieverFor(s.routes);
    const a = await plain.retriever.retrieve({ url: s.url });
    const trace = createRetrievalTrace();
    const b = await traced.retriever.retrieve({ url: s.url, trace });
    assert.deepEqual(withoutKeys(b, new Set(["retrievedAt"])), withoutKeys(a, new Set(["retrievedAt"])), `${s.url}: identical RetrievedSource`);
    assert.deepEqual(traced.calls, plain.calls, `${s.url}: identical request sequence`);
    assert.ok(trace.hops.length >= 1);
  }
});

test("non-influence (pipeline): evidence, status, candidates, stats and the pre-existing diagnostic fields are identical with a trace-blind retriever", async () => {
  const traced = retrieverFor(pipelineRoutes());
  const blindInner = retrieverFor(pipelineRoutes());
  const blind = { id: "trace-blind", retrieve: ({ url }) => blindInner.retriever.retrieve({ url }) };
  const a = await runAcademicSearch(SUBMISSION, [twoCandidateProvider()], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, traced.retriever);
  const b = await runAcademicSearch(SUBMISSION, [twoCandidateProvider()], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, blind);
  assert.deepEqual(a.evidence, b.evidence);
  assert.equal(a.status, b.status);
  assert.deepEqual(a.candidates, b.candidates);
  assert.deepEqual(a.queries, b.queries);
  assert.deepEqual(withoutKeys(a.stats, LATENCY), withoutKeys(b.stats, LATENCY));
  assert.deepEqual(a.retrievalDiagnostics.map((d) => withoutKeys(d, new Set([...LATENCY, ...NEW_FIELDS]))), b.retrievalDiagnostics.map((d) => withoutKeys(d, new Set([...LATENCY, ...NEW_FIELDS]))));
  assert.deepEqual(traced.calls, blindInner.calls, "identical fetch sequence");
  // the pre-existing fields still come first in each entry, in their original order
  assert.deepEqual(Object.keys(a.retrievalDiagnostics[0]).slice(0, 12), ["candidateKey", "rank", "doi", "url", "title", "retrievalSource", "retrievalProviderId", "httpRetrievalStatus", "retrievalLatencyMs", "retrievedTextLength", "comparisonSimilarity", "includedAsEvidence"]);
});

// Persistence: stored in the existing JSON column, no migration; old rows (no v1 fields) still read
test("diagnostics row round-trips the new fields through the existing retrieval_diagnostics_json column; pre-v1 rows still read", async () => {
  const { retriever } = retrieverFor(pipelineRoutes());
  const run = await runAcademicSearch(SUBMISSION, [twoCandidateProvider()], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, retriever);
  const newId = await recordAcademicSearchRunDiagnostics(db, { status: run.status, stats: run.stats, queries: run.queries, candidates: run.candidates, retrievalDiagnostics: run.retrievalDiagnostics, evidence: run.evidence });
  const legacy = [{ candidateKey: "doi:10.9/old", rank: 0, doi: "10.9/old", url: "https://old.example.org", title: "Old", retrievalSource: "unavailable", retrievalProviderId: null, httpRetrievalStatus: "HTTP_ERROR", retrievalLatencyMs: 153, retrievedTextLength: null, comparisonSimilarity: null, includedAsEvidence: false }];
  const legacyId = await recordAcademicSearchRunDiagnostics(db, { status: "COMPLETE_NO_MATCHES", stats: run.stats, queries: [], candidates: [], retrievalDiagnostics: legacy, evidence: [] });
  const rows = await findRecentAcademicSearchRunDiagnostics(db, 10);
  const stored = rows.find((r) => r.id === newId), old = rows.find((r) => r.id === legacyId);
  assert.deepEqual(stored.retrievalDiagnostics, JSON.parse(JSON.stringify(run.retrievalDiagnostics)));
  assert.deepEqual(old.retrievalDiagnostics, legacy, "a row recorded before v1 reads back unchanged");
  assert.equal(old.retrievalDiagnostics[0].errorCategory, undefined);
  const bytes = JSON.stringify(stored.retrievalDiagnostics).length;
  assert.ok(bytes < 8_000, `bounded size per run (${bytes} bytes for ${stored.retrievalDiagnostics.length} entries)`);
});
