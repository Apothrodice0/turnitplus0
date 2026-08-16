import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAcademicResult, normalizeUrl } from "../lib/academic-search/result-normalizer.ts";

function baseResult(overrides = {}) {
  return {
    providerId: "mock",
    externalId: "abc-1",
    title: "  A Study of Things  ",
    authors: ["  Ada Rivers  ", ""],
    publication: "  Journal of Things  ",
    year: 2020,
    doi: null,
    url: null,
    textAvailable: false,
    querySignalUsed: "things",
    providerRelevance: 0.5,
    ...overrides,
  };
}

test("normalizeUrl strips fragment, lowercases host, and drops a trailing slash", () => {
  assert.equal(normalizeUrl("https://Example.com/Paper/#section-2"), "https://example.com/Paper");
});

test("normalizeUrl returns null for malformed input", () => {
  assert.equal(normalizeUrl("not a url"), null);
  assert.equal(normalizeUrl(null), null);
  assert.equal(normalizeUrl(""), null);
});

test("normalizeUrl rejects non-http(s) protocols", () => {
  assert.equal(normalizeUrl("ftp://example.com/file"), null);
});

test("normalizes a bare DOI, trims and lowercases", () => {
  const result = normalizeAcademicResult(baseResult({ doi: "  10.1234/ABC.2020  " }));
  assert.equal(result.doi, "10.1234/abc.2020");
});

test("strips a full doi.org URL prefix", () => {
  const result = normalizeAcademicResult(baseResult({ doi: "https://doi.org/10.1234/ABC.2020" }));
  assert.equal(result.doi, "10.1234/abc.2020");
});

test("trims whitespace-only fields to null; blank authors are dropped", () => {
  const result = normalizeAcademicResult(baseResult());
  assert.equal(result.title, "A Study of Things");
  assert.equal(result.publication, "Journal of Things");
  assert.deepEqual(result.authors, ["Ada Rivers"]);
});

test("dedupKey prefers doi, then url, then provider:externalId", () => {
  const withDoi = normalizeAcademicResult(baseResult({ doi: "10.1/x", url: "https://example.com/a" }));
  assert.equal(withDoi.dedupKey, "doi:10.1/x");

  const withUrl = normalizeAcademicResult(baseResult({ doi: null, url: "https://example.com/a/" }));
  assert.equal(withUrl.dedupKey, "url:https://example.com/a");

  const withNeither = normalizeAcademicResult(baseResult({ doi: null, url: null }));
  assert.equal(withNeither.dedupKey, "provider:mock:abc-1");
});

test("empty authors array normalizes to null, not []", () => {
  const result = normalizeAcademicResult(baseResult({ authors: [] }));
  assert.equal(result.authors, null);
});
