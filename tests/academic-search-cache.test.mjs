import assert from "node:assert/strict";
import test from "node:test";
import {
  createAcademicSearchBudget,
  createInMemoryAcademicSearchCache,
  withRequestControl,
} from "../lib/academic-search/cache.ts";

function q(text) {
  return { queryText: text, rank: 0, sourcePassage: text };
}

function countingProvider(overrides = {}) {
  const calls = { search: 0, getMetadata: 0, getText: 0 };
  return {
    calls,
    provider: {
      id: "counting",
      async search(query) {
        calls.search += 1;
        return [{ providerId: "counting", externalId: `x-${query.queryText}`, title: "T", authors: null, publication: null, year: null, doi: null, url: null, textAvailable: false, querySignalUsed: query.queryText, providerRelevance: null }];
      },
      async getMetadata(id) {
        calls.getMetadata += 1;
        return { title: `meta-${id}` };
      },
      async getText(id) {
        calls.getText += 1;
        return `text-${id}`;
      },
      ...overrides,
    },
  };
}

// --- CACHING -----------------------------------------------------------------

test("identical query -> reuse recent result: search() is only called through once per distinct query text", async () => {
  const { provider, calls } = countingProvider();
  const cache = createInMemoryAcademicSearchCache();
  const wrapped = withRequestControl(provider, { cache });

  await wrapped.search(q("same phrase"));
  await wrapped.search(q("same phrase"));
  await wrapped.search(q("different phrase"));

  assert.equal(calls.search, 2, "two distinct query texts -> two real calls, the repeat is served from cache");
  assert.equal(cache.stats.queryHits, 1);
  assert.equal(cache.stats.queryMisses, 2);
});

test("query cache key is case/whitespace-insensitive, matching how a user would re-run a near-identical search", async () => {
  const { provider, calls } = countingProvider();
  const cache = createInMemoryAcademicSearchCache();
  const wrapped = withRequestControl(provider, { cache });

  await wrapped.search(q("Some Phrase"));
  await wrapped.search(q("  some   phrase  "));

  assert.equal(calls.search, 1);
});

test("identical DOI/PMCID/externalId -> reuse metadata: getMetadata() is only called through once per id", async () => {
  const { provider, calls } = countingProvider();
  const cache = createInMemoryAcademicSearchCache();
  const wrapped = withRequestControl(provider, { cache });

  const first = await wrapped.getMetadata("10.1/shared");
  const second = await wrapped.getMetadata("10.1/shared");

  assert.equal(calls.getMetadata, 1);
  assert.deepEqual(first, second);
});

test("a cached null metadata result (id not found) is still served from cache, not retried", async () => {
  const { provider, calls } = countingProvider();
  provider.getMetadata = async () => {
    calls.getMetadata += 1;
    return null;
  };
  const cache = createInMemoryAcademicSearchCache();
  const wrapped = withRequestControl(provider, { cache });

  await wrapped.getMetadata("missing-id");
  await wrapped.getMetadata("missing-id");

  assert.equal(calls.getMetadata, 1);
});

test("don't retrieve the same text twice: getText() is only called through once per id", async () => {
  const { provider, calls } = countingProvider();
  const cache = createInMemoryAcademicSearchCache();
  const wrapped = withRequestControl(provider, { cache });

  const first = await wrapped.getText("work-1");
  const second = await wrapped.getText("work-1");

  assert.equal(calls.getText, 1);
  assert.equal(first, second);
});

test("without a cache, every call passes through to the real provider", async () => {
  const { provider, calls } = countingProvider();
  const wrapped = withRequestControl(provider, {});

  await wrapped.search(q("same"));
  await wrapped.search(q("same"));

  assert.equal(calls.search, 2);
});

test("a provider with no getMetadata/getText is wrapped without gaining either method", () => {
  const provider = { id: "search-only", async search() { return []; } };
  const wrapped = withRequestControl(provider, { cache: createInMemoryAcademicSearchCache() });
  assert.equal(wrapped.getMetadata, undefined);
  assert.equal(wrapped.getText, undefined);
});

// --- BUDGET --------------------------------------------------------------

test("per-report search budget: once exhausted, search() resolves to [] without calling the real provider", async () => {
  const { provider, calls } = countingProvider();
  const budget = createAcademicSearchBudget(2);
  const wrapped = withRequestControl(provider, { budget });

  const r1 = await wrapped.search(q("q1"));
  const r2 = await wrapped.search(q("q2"));
  const r3 = await wrapped.search(q("q3"));

  assert.equal(r1.length, 1);
  assert.equal(r2.length, 1);
  assert.deepEqual(r3, [], "budget exhausted -> empty result, not an error");
  assert.equal(calls.search, 2, "the third call must never reach the real provider");
  assert.equal(budget.exhausted, true);
});

test("a budget is shared across multiple wrapped providers in the same report run", async () => {
  const a = countingProvider();
  const b = countingProvider();
  const budget = createAcademicSearchBudget(3);
  const wrappedA = withRequestControl({ ...a.provider, id: "a" }, { budget });
  const wrappedB = withRequestControl({ ...b.provider, id: "b" }, { budget });

  await wrappedA.search(q("q1"));
  await wrappedB.search(q("q1"));
  await wrappedA.search(q("q2"));
  await wrappedB.search(q("q2")); // 4th call — over budget

  assert.equal(a.calls.search + b.calls.search, 3);
  assert.equal(budget.used, 3);
});

test("budget exhaustion never produces a providerError — it is a normal, expected stop, not a provider failure", async () => {
  const { provider } = countingProvider();
  const budget = createAcademicSearchBudget(0);
  const wrapped = withRequestControl(provider, { budget });
  const results = await wrapped.search(q("q"));
  assert.deepEqual(results, []);
});

test("cache is checked before the budget — a cache hit never consumes budget", async () => {
  const { provider, calls } = countingProvider();
  const cache = createInMemoryAcademicSearchCache();
  const budget = createAcademicSearchBudget(1);
  const wrapped = withRequestControl(provider, { cache, budget });

  await wrapped.search(q("same phrase"));
  await wrapped.search(q("same phrase"));
  await wrapped.search(q("same phrase"));

  assert.equal(calls.search, 1);
  assert.equal(budget.used, 1, "only the single real call should have consumed budget");
});
