import assert from "node:assert/strict";
import test from "node:test";
import { getExternalAcademicEvidence } from "../lib/academic-evidence-integration.ts";

/**
 * Phase 3 STEP 9 items 5-6: provider-failure resilience at the bridge layer
 * between lib/academic-search/ and lib/report-types.ts. runAcademicSearch()
 * itself already guarantees never-throws (Phase 2's own orchestrator test
 * suite, tests/academic-search-orchestrator.test.mjs) — these tests verify
 * getExternalAcademicEvidence's own outer contract holds for the report
 * -integration caller specifically: it never rejects, and always resolves
 * to a valid { evidence, stats } shape a report can attach as-is.
 */

const MULTI_SENTENCE_TEXT = `
  Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent
  cellular lineages under variable nutrient stress conditions. Quantum entanglement based key distribution
  protocols promise theoretically unconditional security guarantees against passive eavesdropping attempts.
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

test("STEP 9.5: one provider failing does not stop the other from producing evidence", async () => {
  const brokenProvider = { id: "broken", async search() { throw new Error("network unreachable"); } };
  const workingProvider = {
    id: "working",
    async search(query) {
      return [fixtureResult({ providerId: "working", externalId: `w-${query.rank}`, doi: `10.1/working-${query.rank}`, url: `https://example.test/${query.rank}`, querySignalUsed: query.queryText })];
    },
  };

  const result = await getExternalAcademicEvidence(MULTI_SENTENCE_TEXT, [brokenProvider, workingProvider]);

  assert.equal(Array.isArray(result.evidence), true);
  assert.ok(result.stats, "stats should still be populated when at least one provider ran");
  assert.ok(result.stats.providerErrors.some((e) => e.providerId === "broken"));
  // "start the two fixes now" TASK 2: one provider down does not make this
  // a FAILED check — the working provider genuinely answered (even though,
  // with no getText() on this fixture, nothing was ever confirmed as
  // evidence, so the correct status is COMPLETE_NO_MATCHES, not FAILED).
  assert.equal(result.status, "COMPLETE_NO_MATCHES");
});

test("STEP 9.6: both providers failing still resolves (never rejects) with empty evidence and status FAILED", async () => {
  const brokenA = { id: "broken-a", async search() { throw new Error("timeout"); } };
  const brokenB = { id: "broken-b", async search() { throw new Error("rate limited"); } };

  const result = await getExternalAcademicEvidence(MULTI_SENTENCE_TEXT, [brokenA, brokenB]);

  assert.deepEqual(result.evidence, []);
  assert.ok(result.stats);
  assert.equal(result.stats.providerErrors.length > 0, true);
  // "start the two fixes now" TASK 2: a total outage must never be
  // indistinguishable from "checked, found nothing."
  assert.equal(result.status, "FAILED");
});

test("STEP 9.6b: a provider list that throws synchronously during construction still resolves via the outer try/catch, with status FAILED", async () => {
  // Simulates something going wrong before runAcademicSearch is even reached.
  const providers = new Proxy([], {
    get() {
      throw new Error("boom during provider access");
    },
  });

  const result = await getExternalAcademicEvidence(MULTI_SENTENCE_TEXT, providers);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.stats, null);
  assert.equal(result.status, "FAILED");
});

test("evidence produced by working providers already carries publication/year for report UI display", async () => {
  const provider = {
    id: "meta-rich",
    async search(query) {
      return [fixtureResult({
        providerId: "meta-rich",
        externalId: "m-1",
        title: "A Fully Described Work",
        publication: "Journal of Examples",
        year: 2021,
        doi: "10.9/meta-rich",
        url: "https://example.test/meta-rich",
        querySignalUsed: query.queryText,
      })];
    },
    async getText() {
      return "Distinctive biochemical pathway analysis reveals unexpected metabolic divergence across independent cellular lineages under variable nutrient stress conditions.";
    },
  };

  const result = await getExternalAcademicEvidence(MULTI_SENTENCE_TEXT, [provider]);
  const top = result.evidence.find((e) => e.doi === "10.9/meta-rich");
  assert.ok(top, "expected the working provider's candidate to produce evidence");
  assert.equal(top.publication, "Journal of Examples");
  assert.equal(top.year, 2021);
  assert.equal(result.status, "COMPLETE_WITH_MATCHES");
});

test("STATUS: a provider that runs cleanly and finds nothing is COMPLETE_NO_MATCHES, not FAILED", async () => {
  const emptyButWorkingProvider = { id: "empty-working", async search() { return []; } };

  const result = await getExternalAcademicEvidence(MULTI_SENTENCE_TEXT, [emptyButWorkingProvider]);

  assert.deepEqual(result.evidence, []);
  assert.equal(result.status, "COMPLETE_NO_MATCHES");
});
