import assert from "node:assert/strict";
import test from "node:test";
import { createEuropePmcAcademicSearchProvider } from "../lib/academic-search/providers/europe-pmc.ts";

/**
 * The one deliberately-separated, opt-in test that hits the real Europe PMC
 * REST API — same gating pattern as
 * tests/academic-search-providers-openaire-integration.test.mjs. No API key
 * required; the only gate is the opt-in env var.
 */

const RUN_INTEGRATION = process.env.RUN_ACADEMIC_SEARCH_INTEGRATION === "1";
const skipReason = RUN_INTEGRATION ? false : "set RUN_ACADEMIC_SEARCH_INTEGRATION=1 to run this opt-in, network-dependent test";

test(
  "LIVE: the real Europe PMC API returns at least one plausible candidate for a well-known bibliographic query",
  { skip: skipReason },
  async () => {
    const provider = createEuropePmcAcademicSearchProvider({ maxResultsPerRequest: 3, timeoutMs: 15_000 });
    const results = await provider.search({
      queryText: "attention is all you need transformer",
      rank: 0,
      sourcePassage: "attention is all you need transformer",
    });

    assert.ok(results.length > 0, "expected at least one candidate for a well-known, stable bibliographic query");
    const [first] = results;
    assert.equal(first.providerId, "europe-pmc");
    assert.ok(first.externalId.length > 0);
  },
);

test(
  "LIVE: getText retrieves and cleans real fullTextXML for a known-OA PMC article",
  { skip: skipReason },
  async () => {
    const provider = createEuropePmcAcademicSearchProvider({ maxResultsPerRequest: 5, timeoutMs: 15_000 });
    const results = await provider.search({
      queryText: "CRISPR Cas9 genome editing open access",
      rank: 0,
      sourcePassage: "CRISPR Cas9 genome editing open access",
    });

    const oaCandidate = results.find((r) => r.textAvailable);
    assert.ok(oaCandidate, "expected at least one OA, PMCID-bearing candidate in a broad CRISPR query");

    const text = await provider.getText(oaCandidate.externalId);
    assert.ok(text && text.length > 200, "expected real, non-trivial extracted prose");
    assert.ok(!text.includes("<p>"), "output must be plain text, not raw XML/HTML");
  },
);

test(
  "LIVE: getText returns null (not a throw) for a candidate the provider marked textAvailable: false",
  { skip: skipReason },
  async () => {
    const provider = createEuropePmcAcademicSearchProvider({ maxResultsPerRequest: 5, timeoutMs: 15_000 });
    const results = await provider.search({
      queryText: "monetary policy transmission emerging markets",
      rank: 0,
      sourcePassage: "monetary policy transmission emerging markets",
    });
    const closedCandidate = results.find((r) => !r.textAvailable);
    if (!closedCandidate) return; // this specific query happened to return only OA results — not a failure of the provider
    const text = await provider.getText(closedCandidate.externalId);
    assert.equal(text, null);
  },
);
