import assert from "node:assert/strict";
import test from "node:test";
import { createMockAcademicSearchProvider } from "../lib/academic-search/providers/mock.ts";

function query(text) {
  return { queryText: text, rank: 0, sourcePassage: text };
}

test("search returns relevant fixtures ranked by relevance, most relevant first", async () => {
  const provider = createMockAcademicSearchProvider();
  const results = await provider.search(query("self-attention mechanisms sequence transduction long-range dependencies"));
  assert.ok(results.length > 0);
  assert.equal(results[0].externalId, "mock-006");
  assert.ok(results.every((r, i) => i === 0 || results[i - 1].providerRelevance >= r.providerRelevance));
});

test("no-result handling: a query matching nothing returns an empty array, not an error", async () => {
  const provider = createMockAcademicSearchProvider();
  const results = await provider.search(query("xylophone kazoo bicycle umbrella"));
  assert.deepEqual(results, []);
});

test("every returned result carries the provider id and the query it came from", async () => {
  const provider = createMockAcademicSearchProvider({ id: "mock-a" });
  const [result] = await provider.search(query("quantum entanglement cryptographic key distribution"));
  assert.equal(result.providerId, "mock-a");
  assert.equal(result.querySignalUsed, "quantum entanglement cryptographic key distribution");
});

test("getMetadata resolves a known id and returns null for an unknown one", async () => {
  const provider = createMockAcademicSearchProvider();
  const known = await provider.getMetadata("mock-002");
  assert.equal(known.title, "Quantum Entanglement Approaches to Cryptographic Key Distribution");

  const unknown = await provider.getMetadata("does-not-exist");
  assert.equal(unknown, null);
});

test("getText returns full text when available, and null for a metadata-only fixture (unavailable full text)", async () => {
  const provider = createMockAcademicSearchProvider();
  const withText = await provider.getText("mock-006");
  assert.ok(withText && withText.toLowerCase().includes("self-attention"));

  const withoutText = await provider.getText("mock-003");
  assert.equal(withoutText, null);
});

test("is deterministic across repeated identical queries", async () => {
  const provider = createMockAcademicSearchProvider();
  const first = await provider.search(query("mycorrhizal networks forest carbon exchange"));
  const second = await provider.search(query("mycorrhizal networks forest carbon exchange"));
  assert.deepEqual(first, second);
});

test("respects maxResultsPerQuery", async () => {
  const provider = createMockAcademicSearchProvider({ maxResultsPerQuery: 1 });
  const results = await provider.search(query("journal research analysis study"));
  assert.ok(results.length <= 1);
});
