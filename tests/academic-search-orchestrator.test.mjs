import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, runAcademicSearch } from "../lib/academic-search/orchestrator.ts";
import { createMockAcademicSearchProvider } from "../lib/academic-search/providers/mock.ts";

/**
 * End-to-end pipeline tests. Every provider used here is either the real
 * providers/mock.ts fixture provider (fully offline) or a tiny inline stub
 * object implementing AcademicSearchProvider directly — never real network
 * access. The text-retrieval fallback is always given stubContentRetriever
 * below, which deterministically reports NETWORK_ERROR without touching a
 * socket, so a candidate whose provider has no getText() still can't
 * accidentally reach the real internet during a test run.
 */

const stubContentRetriever = {
  id: "stub-no-network",
  async retrieve({ url }) {
    return {
      originalUrl: url,
      finalUrl: null,
      httpStatus: null,
      contentType: null,
      retrievedAt: new Date().toISOString(),
      rawSha256: null,
      extractedText: null,
      canonicalSha256: null,
      extractorVersion: null,
      status: "NETWORK_ERROR",
      errorMessage: "stub retriever: network access disabled in tests",
    };
  },
};

const MULTI_SENTENCE_SUBMISSION = `
  Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent
  cellular lineages under variable nutrient stress conditions. Quantum entanglement based key distribution
  protocols promise theoretically unconditional security guarantees against passive eavesdropping attempts.
  Post-colonial literary criticism increasingly emphasizes transnational circulation over strictly
  national literary canons formed during the early twentieth century.
`;

function fixtureResult(overrides = {}) {
  return {
    providerId: "stub",
    externalId: "x-1",
    title: "A Stub Result",
    authors: null,
    publication: null,
    year: null,
    doi: null,
    url: null,
    textAvailable: false,
    querySignalUsed: "",
    providerRelevance: 0.5,
    ...overrides,
  };
}

test("provider timeout does not abort the whole run; other queries still produce candidates", async () => {
  const timeoutError = Object.assign(new Error("timed out"), { name: "AcademicSearchTimeoutError" });
  const flakyProvider = {
    id: "flaky",
    async search(query) {
      if (query.rank === 0) throw timeoutError;
      return [fixtureResult({ providerId: "flaky", externalId: `flaky-${query.rank}`, doi: `10.1/flaky-${query.rank}`, querySignalUsed: query.queryText })];
    },
  };

  const result = await runAcademicSearch(MULTI_SENTENCE_SUBMISSION, [flakyProvider], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever);

  assert.ok(result.stats.providerErrors.some((e) => e.kind === "TIMEOUT" && e.providerId === "flaky"));
  assert.ok(result.candidates.length > 0, "the queries that did not time out should still have produced candidates");
});

test("provider failure (an unclassified error) is recorded but never rejects the run", async () => {
  const brokenProvider = {
    id: "broken",
    async search() {
      throw new Error("boom");
    },
  };

  const result = await runAcademicSearch(MULTI_SENTENCE_SUBMISSION, [brokenProvider], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever);

  assert.ok(result.stats.providerErrors.length > 0);
  assert.ok(result.stats.providerErrors.every((e) => e.kind === "ERROR" && e.providerId === "broken"));
  assert.deepEqual(result.evidence, []);
});

test("no-result handling: a provider that finds nothing produces a valid, empty result rather than crashing", async () => {
  const emptyProvider = { id: "empty", async search() { return []; } };

  const result = await runAcademicSearch(MULTI_SENTENCE_SUBMISSION, [emptyProvider], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever);

  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.stats.candidateCountBeforeDedup, 0);
  assert.equal(result.stats.candidateCountAfterDedup, 0);
  assert.equal(result.stats.deduplicationRate, 0);
});

test("unavailable full text: a discovered candidate with no retrievable text is ranked but produces no evidence", async () => {
  const metadataOnlyProvider = {
    id: "meta-only",
    async search(query) {
      return [fixtureResult({
        providerId: "meta-only",
        externalId: "no-text-1",
        title: "Metadata Only Work",
        doi: "10.1/no-text",
        url: "https://example.test/no-text-1",
        querySignalUsed: query.queryText,
      })];
    },
    // Deliberately no getText() — this provider can locate work but never supplies text.
  };

  const result = await runAcademicSearch(MULTI_SENTENCE_SUBMISSION, [metadataOnlyProvider], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever);

  assert.ok(result.candidates.length > 0, "the candidate should still be discovered and ranked");
  assert.deepEqual(result.evidence, [], "no evidence should be produced when no text could ever be retrieved");
  assert.equal(result.stats.candidatesTextRetrieved, 0);
});

test("multiple providers returning the same DOI collapse into one candidate with both providers represented", async () => {
  const providerA = {
    id: "provider-a",
    async search(query) {
      return [fixtureResult({ providerId: "provider-a", externalId: "a-1", title: "Shared Work", doi: "10.9/shared", url: "https://example.test/shared-a", querySignalUsed: query.queryText })];
    },
  };
  const providerB = {
    id: "provider-b",
    async search(query) {
      return [fixtureResult({ providerId: "provider-b", externalId: "b-9", title: "Shared Work", doi: "https://doi.org/10.9/SHARED", url: "https://example.test/shared-b", querySignalUsed: query.queryText })];
    },
  };

  const result = await runAcademicSearch(MULTI_SENTENCE_SUBMISSION, [providerA, providerB], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever);

  const sharedCandidates = result.candidates.filter((c) => c.doi === "10.9/shared");
  assert.equal(sharedCandidates.length, 1, "both providers' results for the same DOI must dedupe into exactly one candidate");
  const distinctProviders = new Set(sharedCandidates[0].contributors.map((c) => c.providerId));
  assert.deepEqual([...distinctProviders].sort(), ["provider-a", "provider-b"]);
});

test("end-to-end POC: the mock provider finds and locally confirms a near-duplicate passage against a submission", async () => {
  const submissionText = `
    In our own review of the literature, we build on the observation that recent advances in sequence
    transduction models have relied heavily on recurrent architectures, but a growing body of literature
    demonstrates that attention mechanisms alone can capture long-range dependencies more efficiently than
    recurrence or convolution. Self-attention layers compute a weighted representation of every token in
    the input sequence relative to every other token, allowing the network to model relationships
    regardless of their distance in the sequence. We extend this line of work by proposing a lightweight
    variant suitable for streaming inference on resource-constrained edge devices.
  `;

  const provider = createMockAcademicSearchProvider();
  const result = await runAcademicSearch(submissionText, [provider], DEFAULT_ACADEMIC_SEARCH_RUN_CONFIG, stubContentRetriever);

  assert.ok(result.stats.queryCount >= 1 && result.stats.queryCount <= 20);
  assert.ok(result.evidence.length > 0, "expected at least one piece of external academic evidence");

  const top = result.evidence.find((e) => e.doi === "10.7890/cclr.2018.045");
  assert.ok(top, "expected the near-duplicate source (mock-006) to be found and reported as evidence");
  assert.ok(top.matchedPassages.length > 0);
  assert.ok(top.similarity > 0);

  // Printed (not asserted) so this run's shape can be captured for the final report's "example POC result".
  console.log("\n--- Academic Search POC example result ---");
  console.log(JSON.stringify({ stats: result.stats, evidence: result.evidence }, null, 2));
});
