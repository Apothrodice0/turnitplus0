import assert from "node:assert/strict";
import test from "node:test";
import { deduplicateAcademicResults } from "../lib/academic-search/deduplicator.ts";
import { normalizeAcademicResult } from "../lib/academic-search/result-normalizer.ts";

function result(overrides = {}) {
  return normalizeAcademicResult({
    providerId: "mock-a",
    externalId: "id-1",
    title: "A Study of Things",
    authors: ["Ada Rivers"],
    publication: "Journal of Things",
    year: 2020,
    doi: null,
    url: null,
    textAvailable: false,
    querySignalUsed: "things",
    providerRelevance: 0.5,
    ...overrides,
  });
}

test("multiple providers returning the same DOI collapse into one candidate", () => {
  const a = result({ providerId: "core", externalId: "core-1", doi: "10.1/example" });
  const b = result({ providerId: "mock", externalId: "mock-9", doi: "https://doi.org/10.1/EXAMPLE" });
  const [candidate] = deduplicateAcademicResults([a, b]);

  assert.equal(deduplicateAcademicResults([a, b]).length, 1);
  assert.equal(candidate.contributors.length, 2);
  assert.deepEqual(
    candidate.contributors.map((c) => c.providerId).sort(),
    ["core", "mock"],
  );
});

test("different DOIs never merge, even with an identical title", () => {
  const a = result({ doi: "10.1/aaa" });
  const b = result({ doi: "10.1/bbb" });
  assert.equal(deduplicateAcademicResults([a, b]).length, 2);
});

test("falls back to canonical URL when neither result has a DOI", () => {
  const a = result({ doi: null, url: "https://example.com/paper/" });
  const b = result({ doi: null, url: "https://example.com/paper" });
  assert.equal(deduplicateAcademicResults([a, b]).length, 1);
});

test("never deduplicates on title/author alone when there is no shared identifier", () => {
  const a = result({ providerId: "core", externalId: "id-a", doi: null, url: null });
  const b = result({ providerId: "mock", externalId: "id-b", doi: null, url: null });
  assert.equal(deduplicateAcademicResults([a, b]).length, 2);
});

test("textAvailable is true if ANY contributor has usable text", () => {
  const a = result({ doi: "10.1/example", textAvailable: false });
  const b = result({ doi: "10.1/example", textAvailable: true });
  const [candidate] = deduplicateAcademicResults([a, b]);
  assert.equal(candidate.textAvailable, true);
});

test("field merge takes the first non-null value across contributors, input order", () => {
  const a = result({ doi: "10.1/example", year: null, publication: null });
  const b = result({ doi: "10.1/example", year: 2019, publication: "Fallback Journal" });
  const [candidate] = deduplicateAcademicResults([a, b]);
  assert.equal(candidate.year, 2019);
  assert.equal(candidate.publication, "Fallback Journal");
});
