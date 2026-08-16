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

test("per-report discovery budget: once exhausted, search() resolves to [] without calling the real provider", async () => {
  const { provider, calls } = countingProvider();
  const discoveryBudget = createAcademicSearchBudget(2);
  const wrapped = withRequestControl(provider, { discoveryBudget });

  const r1 = await wrapped.search(q("q1"));
  const r2 = await wrapped.search(q("q2"));
  const r3 = await wrapped.search(q("q3"));

  assert.equal(r1.length, 1);
  assert.equal(r2.length, 1);
  assert.deepEqual(r3, [], "budget exhausted -> empty result, not an error");
  assert.equal(calls.search, 2, "the third call must never reach the real provider");
  assert.equal(discoveryBudget.exhausted, true);
});

test("a discovery budget is shared across multiple wrapped providers in the same report run", async () => {
  const a = countingProvider();
  const b = countingProvider();
  const discoveryBudget = createAcademicSearchBudget(3);
  const wrappedA = withRequestControl({ ...a.provider, id: "a" }, { discoveryBudget });
  const wrappedB = withRequestControl({ ...b.provider, id: "b" }, { discoveryBudget });

  await wrappedA.search(q("q1"));
  await wrappedB.search(q("q1"));
  await wrappedA.search(q("q2"));
  await wrappedB.search(q("q2")); // 4th call — over budget

  assert.equal(a.calls.search + b.calls.search, 3);
  assert.equal(discoveryBudget.used, 3);
});

test("discovery budget exhaustion never produces a providerError — it is a normal, expected stop, not a provider failure", async () => {
  const { provider } = countingProvider();
  const discoveryBudget = createAcademicSearchBudget(0);
  const wrapped = withRequestControl(provider, { discoveryBudget });
  const results = await wrapped.search(q("q"));
  assert.deepEqual(results, []);
});

test("cache is checked before the discovery budget — a cache hit never consumes budget", async () => {
  const { provider, calls } = countingProvider();
  const cache = createInMemoryAcademicSearchCache();
  const discoveryBudget = createAcademicSearchBudget(1);
  const wrapped = withRequestControl(provider, { cache, discoveryBudget });

  await wrapped.search(q("same phrase"));
  await wrapped.search(q("same phrase"));
  await wrapped.search(q("same phrase"));

  assert.equal(calls.search, 1);
  assert.equal(discoveryBudget.used, 1, "only the single real call should have consumed budget");
});

// --- PHASE 6.6 PART 1: discovery/retrieval budget separation -----------------

test("retrieval budget: once exhausted, getText() resolves to null without calling the real provider, independently of search()", async () => {
  const { provider, calls } = countingProvider();
  const retrievalBudget = createAcademicSearchBudget(1);
  const wrapped = withRequestControl(provider, { retrievalBudget });

  const first = await wrapped.getText("work-1");
  const second = await wrapped.getText("work-2");

  assert.equal(first, "text-work-1");
  assert.equal(second, null, "budget exhausted -> null, not an error");
  assert.equal(calls.getText, 1, "the second call must never reach the real provider");
  assert.equal(retrievalBudget.exhausted, true);
});

test("retrieval budget: once exhausted, getMetadata() resolves to null without calling the real provider", async () => {
  const { provider, calls } = countingProvider();
  const retrievalBudget = createAcademicSearchBudget(0);
  const wrapped = withRequestControl(provider, { retrievalBudget });

  const result = await wrapped.getMetadata("id-1");

  assert.equal(result, null);
  assert.equal(calls.getMetadata, 0);
});

test("THE BUG THIS FIXES: an exhausted discovery budget never blocks retrieval — search() and getText() draw from independent counters", async () => {
  const { provider, calls } = countingProvider();
  const discoveryBudget = createAcademicSearchBudget(0); // already exhausted
  const retrievalBudget = createAcademicSearchBudget(5); // untouched
  const wrapped = withRequestControl(provider, { discoveryBudget, retrievalBudget });

  const searchResult = await wrapped.search(q("q1"));
  const textResult = await wrapped.getText("work-1");

  assert.deepEqual(searchResult, [], "discovery is correctly exhausted");
  assert.equal(calls.search, 0);
  assert.equal(textResult, "text-work-1", "retrieval must still succeed — a starved discovery budget must never starve retrieval");
  assert.equal(calls.getText, 1);
  assert.equal(retrievalBudget.used, 1);
});

test("a long/multi-topic-shaped run (many distinct queries) can exhaust discovery entirely while every one of the bounded retrieval calls it fed still succeeds", async () => {
  const { provider, calls } = countingProvider();
  const discoveryBudget = createAcademicSearchBudget(5); // deliberately small, simulating a submission whose query count already exceeded it
  const retrievalBudget = createAcademicSearchBudget(15); // production's own real RETRIEVAL_BUDGET_LIMIT
  const wrapped = withRequestControl(provider, { discoveryBudget, retrievalBudget });

  // 23 queries, matching Phase 6.5's own real observed queryCount for a
  // longer/multi-topic submission — far more than discoveryBudget's 5.
  for (let i = 0; i < 23; i += 1) await wrapped.search(q(`query-${i}`));
  assert.equal(discoveryBudget.exhausted, true);
  assert.equal(calls.search, 5, "discovery correctly stops at its own limit");

  // The 5 candidates a real orchestrator run would still retrieve
  // (DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG.maxCandidatesToRetrieve) must all
  // succeed regardless of how exhausted discovery already is.
  for (let i = 0; i < 5; i += 1) {
    const text = await wrapped.getText(`candidate-${i}`);
    assert.equal(text, `text-candidate-${i}`, `retrieval ${i} must not be starved by discovery's exhaustion`);
  }
  assert.equal(calls.getText, 5);
  assert.equal(retrievalBudget.exhausted, false, "15-unit retrieval budget has ample headroom left for 5 real candidates");
});

test("discovery and retrieval budgets are fully independent objects — exhausting one never changes the other's own used/exhausted state", async () => {
  const { provider } = countingProvider();
  const discoveryBudget = createAcademicSearchBudget(1);
  const retrievalBudget = createAcademicSearchBudget(1);
  const wrapped = withRequestControl(provider, { discoveryBudget, retrievalBudget });

  await wrapped.search(q("q1"));
  await wrapped.search(q("q2")); // over discovery budget

  assert.equal(discoveryBudget.exhausted, true);
  assert.equal(retrievalBudget.used, 0, "retrieval budget must be completely untouched by search() calls");
  assert.equal(retrievalBudget.exhausted, false);
});
