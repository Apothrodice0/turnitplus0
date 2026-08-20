import assert from "node:assert/strict";
import test from "node:test";
import { DISCOVERY_BUDGET_LIMIT } from "../lib/academic-evidence-integration.ts";
import { DEFAULT_PHRASE_EXTRACTION_CONFIG } from "../lib/academic-search/phrase-extractor.ts";
import { withRequestControl, createInMemoryAcademicSearchCache, createAcademicSearchBudget } from "../lib/academic-search/cache.ts";

/**
 * "Investigate two real detection issues" ISSUE 2 — regression coverage
 * for the discovery-budget sizing bug. See lib/academic-evidence-
 * integration.ts's own header comment on DISCOVERY_BUDGET_LIMIT for the
 * full root-cause account: the old hardcoded 40 undercounted the phrase
 * extractor's own documented worst case (maxQueries + keywordQueryCount =
 * 23 queries) x 2 providers = 46 attempts, silently starving whichever
 * queries were queued last — always the keyword-type ones, since
 * orchestrator.ts processes queries in the order it received them
 * (sentence queries first, keyword queries appended after) and a budget-
 * exhausted search() call returns [] exactly like a real "found nothing"
 * (lib/academic-search/cache.ts's own documented behavior — no error is
 * ever recorded for it). tests/pdf-docx-extraction-parity.test.mjs-style
 * real-fixture coverage for this exact scenario lives in
 * tests/academic-search-live-regression.test.mjs (opt-in, real network).
 */

test("DISCOVERY_BUDGET_LIMIT covers the phrase extractor's own documented worst-case query count against both providers", () => {
  const maxPossibleQueries = DEFAULT_PHRASE_EXTRACTION_CONFIG.maxQueries + DEFAULT_PHRASE_EXTRACTION_CONFIG.keywordQueryCount;
  const maxPossibleAttempts = maxPossibleQueries * 2; // OpenAIRE + Europe PMC
  assert.equal(maxPossibleAttempts, 46, "sanity: documents the exact real-world number this investigation found (23 queries x 2 providers)");
  assert.equal(DISCOVERY_BUDGET_LIMIT, maxPossibleAttempts, "the budget must be derived from, and cover, the documented maximum — not a smaller independently-guessed number");
});

/** A direct, low-level reproduction of the exact starvation mechanism — bypasses phrase-extraction's real (fixture-dependent) query count entirely, driving withRequestControl's budget with a controlled, known number of (query, provider) attempts in the SAME order orchestrator.ts's own Stage 2 loop uses: for each query, try every provider before moving to the next query. */
async function driveSearchAttempts(queryCount, providerCount, budgetLimit) {
  const cache = createInMemoryAcademicSearchCache();
  const discoveryBudget = createAcademicSearchBudget(budgetLimit);
  const retrievalBudget = createAcademicSearchBudget(15);
  const seenByProvider = Array.from({ length: providerCount }, () => []);
  const providers = Array.from({ length: providerCount }, (_, providerIndex) => withRequestControl(
    {
      id: `provider-${providerIndex}`,
      async search(query) {
        seenByProvider[providerIndex].push(query.queryText);
        return [];
      },
    },
    { cache, discoveryBudget, retrievalBudget },
  ));

  for (let queryIndex = 0; queryIndex < queryCount; queryIndex += 1) {
    // A distinct queryText per attempt defeats withRequestControl's cache
    // layer, which is a SEPARATE mechanism from the budget and would
    // otherwise mask starvation by serving a cached (empty) result instead
    // of ever calling search() again — exactly what a real submission's
    // distinct sentence/keyword queries already guarantee.
    const query = { queryText: `distinct query text number ${queryIndex}`, rank: queryIndex, sourcePassage: "", queryType: queryIndex >= queryCount - 3 ? "keyword" : "sentence" };
    for (const provider of providers) await provider.search(query);
  }
  return seenByProvider;
}

test("REGRESSION: a budget sized to (queries x providers) lets every attempt reach every provider — none silently starved", async () => {
  const queryCount = 23;
  const providerCount = 2;
  const seen = await driveSearchAttempts(queryCount, providerCount, queryCount * providerCount);
  for (const providerSeen of seen) {
    assert.equal(providerSeen.length, queryCount, "every provider must see every single query — this is exactly what DISCOVERY_BUDGET_LIMIT is sized to guarantee");
  }
});

test("DEMONSTRATION: the OLD 40-unit budget silently starved the tail queries (queued last — the keyword-type ones in the real pipeline) for this exact 23-query x 2-provider load", async () => {
  const queryCount = 23;
  const providerCount = 2;
  const OLD_BUDGET_VALUE = 40;
  const seen = await driveSearchAttempts(queryCount, providerCount, OLD_BUDGET_VALUE);

  const totalSeen = seen.reduce((sum, providerSeen) => sum + providerSeen.length, 0);
  const totalAttempted = queryCount * providerCount;
  assert.equal(totalAttempted, 46);
  assert.ok(totalSeen < totalAttempted, `documents the exact regression: only ${totalSeen} of ${totalAttempted} attempts reached a provider under the old budget`);
  assert.equal(totalAttempted - totalSeen, 6, "exactly the 3 keyword queries x 2 providers that this investigation found silently missing");
});
