import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, runAcademicSearch } from "../lib/academic-search/orchestrator.ts";
import { DEFAULT_PHRASE_EXTRACTION_CONFIG } from "../lib/academic-search/phrase-extractor.ts";

/**
 * Regression coverage for the Stage 2 bounded-concurrency fix (production
 * audit finding: 24 queries x 2 providers = 48 fully sequential round-trips,
 * ~68s measured search latency on a real report). These tests prove the
 * three things that change requires:
 *   1. many slow providers no longer serialize the entire stage (real wall
 *      time is bounded by ceil(taskCount / concurrency), not taskCount)
 *   2. one slow/hung (query, provider) attempt does not block unrelated
 *      attempts from completing
 *   3. output is byte-for-byte equivalent to what the old strictly
 *      sequential loop produced, even when completion order is reversed
 *      relative to dispatch order (the exact case that would silently break
 *      deduplicator.ts's order-sensitive dedupKey-first-seen / firstNonNull
 *      metadata picks if slots weren't preserved by index)
 *
 * All timing here uses generous multi-hundred-ms margins specifically so
 * these assertions stay robust on a loaded CI machine, not because the real
 * effect is marginal (production measured ~5x).
 */

const stubContentRetriever = {
  id: "stub-no-network",
  async retrieve({ url }) {
    return {
      originalUrl: url, finalUrl: null, httpStatus: null, contentType: null,
      retrievedAt: new Date().toISOString(), rawSha256: null, extractedText: null,
      canonicalSha256: null, extractorVersion: null, status: "NETWORK_ERROR",
      errorMessage: "stub retriever: network access disabled in tests",
    };
  },
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixtureResult(overrides = {}) {
  return {
    providerId: "stub", externalId: "x-1", title: "A Stub Result", authors: null,
    publication: null, year: null, doi: null, url: null, textAvailable: false,
    querySignalUsed: "", providerRelevance: 0.5, ...overrides,
  };
}

/** N distinct, sufficiently long/informative real sentences so the phrase
 * extractor reliably selects exactly `count` of them under a config with
 * keyword/topic-only queries disabled — needed so searchTasks.length (and
 * therefore timing) is deterministic across runs, not dependent on
 * phrase-extractor internals this test isn't about. */
const CANDIDATE_SENTENCES = [
  "Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent cellular lineages.",
  "Quantum entanglement based key distribution protocols promise theoretically unconditional security guarantees against eavesdropping.",
  "Post-colonial literary criticism increasingly emphasizes transnational circulation over strictly national literary canons.",
  "Longitudinal ethnographic fieldwork among itinerant metalworking communities documents durable occupational kinship structures.",
  "Comparative constitutional scholarship examines federalism's uneven accommodation of indigenous self-governance arrangements.",
  "Paleoclimatic proxy reconstruction from lacustrine sediment cores constrains regional precipitation variability estimates.",
  "Computational phylogenetics increasingly incorporates horizontal gene transfer events into bacterial lineage reconstruction.",
  "Behavioral economics experiments demonstrate persistent framing effects on intertemporal consumption decisions.",
  "Astrophysical spectroscopy of distant quasars constrains cosmological baryon acoustic oscillation measurements.",
  "Urban sociolinguistic variation studies document rapid dialect leveling among second-generation immigrant populations.",
  "Neuroimaging meta-analyses reveal consistent prefrontal cortex activation during deliberate moral judgment tasks.",
  "Agricultural soil microbiome sequencing identifies previously uncharacterized nitrogen-fixing bacterial consortia.",
  "Historiographical debates surrounding early modern print culture emphasize contested authorship attribution practices.",
  "Materials science investigations of amorphous semiconductor thin films characterize anomalous charge carrier mobility.",
  "Developmental psycholinguistics research documents cross-linguistic variation in early morphosyntactic acquisition trajectories.",
];

function buildSubmission(count) {
  return CANDIDATE_SENTENCES.slice(0, count).join(" ");
}

/** keywordQueryCount/topicOnlyQueryCount forced to 0 so searchTasks.length
 * is exactly `queryCount x providers.length`, with no extra queries. */
function configForExactQueryCount(queryCount) {
  return {
    ...DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG,
    phraseExtraction: {
      ...DEFAULT_PHRASE_EXTRACTION_CONFIG,
      minQueries: queryCount,
      maxQueries: queryCount,
      keywordQueryCount: 0,
      topicOnlyQueryCount: 0,
    },
  };
}

test("PERF: many uniformly-slow (query, provider) attempts complete in roughly taskCount/concurrency time, not taskCount x delay", async () => {
  const DELAY_MS = 100;
  const QUERY_COUNT = 10;
  const config = configForExactQueryCount(QUERY_COUNT);

  const slowProvider = { id: "slow", async search() { await delay(DELAY_MS); return []; } };

  const start = Date.now();
  const result = await runAcademicSearch(buildSubmission(QUERY_COUNT), [slowProvider], config, stubContentRetriever);
  const elapsedMs = Date.now() - start;

  assert.equal(result.stats.searchAttempts, QUERY_COUNT, "sanity: exactly the expected number of attempts, none skipped");

  const sequentialEstimateMs = QUERY_COUNT * DELAY_MS; // what the old for-loop would take
  assert.ok(
    elapsedMs < sequentialEstimateMs * 0.7,
    `expected bounded-concurrency speedup (< ${Math.round(sequentialEstimateMs * 0.7)}ms), took ${elapsedMs}ms ` +
      `(fully sequential would take ~${sequentialEstimateMs}ms)`,
  );
});

test("PERF: one slow/hung attempt does not block unrelated attempts from completing well before it does", async () => {
  const QUERY_COUNT = 12;
  const config = configForExactQueryCount(QUERY_COUNT);
  const SLOW_DELAY_MS = 700;
  const FAST_DELAY_MS = 10;

  const completionOrder = [];
  const flakyProvider = {
    id: "flaky",
    async search(query) {
      // The first-attempted query (rank 0, matching this repo's existing
      // "provider timeout" test convention) simulates a hung/slow provider
      // call; every other query is fast.
      if (query.rank === 0) {
        await delay(SLOW_DELAY_MS);
        completionOrder.push("slow");
        return [];
      }
      await delay(FAST_DELAY_MS);
      completionOrder.push(`fast-${query.rank}`);
      return [];
    },
  };

  await runAcademicSearch(buildSubmission(QUERY_COUNT), [flakyProvider], config, stubContentRetriever);

  assert.equal(completionOrder.length, QUERY_COUNT);
  const slowPosition = completionOrder.indexOf("slow");
  assert.ok(
    slowPosition >= QUERY_COUNT - 2,
    `expected the slow attempt to finish near-last (fast attempts should race ahead of it), finished at position ${slowPosition} of ${QUERY_COUNT}: ${completionOrder.join(",")}`,
  );
});

test("EQUIVALENCE: output ordering matches the sequential (dispatch-order) result even when the SECOND-dispatched attempt resolves before the FIRST", async () => {
  // Both providers answer the same single query with the same DOI (shared
  // candidate) but DIFFERENT titles. Dispatch order for one query is always
  // [providerA, providerB] (query-major, then provider-minor — unchanged by
  // this fix). providerA is made deliberately SLOWER than providerB, so
  // under real concurrency providerB's result callback fires first — the
  // exact scenario that would silently corrupt output if Stage 2 wrote
  // results in completion order instead of dispatch order, since
  // deduplicator.ts's firstNonNull() picks metadata from whichever
  // contributor appears FIRST in the array it receives.
  const config = configForExactQueryCount(1);

  const providerA = {
    id: "provider-a",
    async search(query) {
      await delay(120); // slower, but dispatched FIRST
      return [fixtureResult({
        providerId: "provider-a", externalId: "a-1", title: "Title From Provider A (dispatched first)",
        doi: "10.9/shared", url: "https://example.test/shared-a", querySignalUsed: query.queryText,
      })];
    },
  };
  const providerB = {
    id: "provider-b",
    async search(query) {
      await delay(5); // faster, but dispatched SECOND — resolves before A
      return [fixtureResult({
        providerId: "provider-b", externalId: "b-9", title: "Title From Provider B (dispatched second)",
        doi: "10.9/shared", url: "https://example.test/shared-b", querySignalUsed: query.queryText,
      })];
    },
  };

  const result = await runAcademicSearch(buildSubmission(1), [providerA, providerB], config, stubContentRetriever);

  const shared = result.candidates.find((c) => c.doi === "10.9/shared");
  assert.ok(shared, "the shared-DOI candidate must still be discovered");
  assert.equal(shared.contributors.length, 2, "both providers' contributions must still be recorded");
  assert.equal(
    shared.title,
    "Title From Provider A (dispatched first)",
    "title must come from the DISPATCH-first contributor (provider-a), matching the old sequential loop's behavior, " +
      "not from whichever provider happened to resolve first under concurrency",
  );
});

test("EQUIVALENCE: providerErrors reflects only real failures, count unaffected by concurrency, same as the sequential loop would produce", async () => {
  const QUERY_COUNT = 10;
  const config = configForExactQueryCount(QUERY_COUNT);

  const halfFailingProvider = {
    id: "half-failing",
    async search(query) {
      await delay(query.rank % 3 === 0 ? 60 : 5); // staggered delays, some completing out of order
      if (query.rank % 2 === 0) throw new Error(`synthetic failure for query ${query.rank}`);
      return [];
    },
  };

  const result = await runAcademicSearch(buildSubmission(QUERY_COUNT), [halfFailingProvider], config, stubContentRetriever);

  assert.equal(result.stats.searchAttempts, QUERY_COUNT);
  const expectedFailures = Array.from({ length: QUERY_COUNT }, (_, i) => i).filter((rank) => rank % 2 === 0).length;
  assert.equal(result.stats.providerErrors.length, expectedFailures, "exactly the queries designed to fail should be recorded as errors");
  assert.ok(result.stats.providerErrors.every((e) => e.providerId === "half-failing"));
});
