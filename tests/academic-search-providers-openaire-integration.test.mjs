import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAireAcademicSearchProvider } from "../lib/academic-search/providers/openaire.ts";

/**
 * The one deliberately-separated, opt-in test that hits the real OpenAIRE
 * Graph API v3 — mirrors tests/academic-search-providers-core-integration
 * .test.mjs's own gating pattern. `npm test`'s glob (tests/*.test.mjs) would
 * otherwise pick this file up unconditionally, so it self-skips via
 * node:test's `skip` option whenever the gate is not explicitly opened.
 *
 * Unlike the CORE integration test, no API key is required — the Graph API
 * has no auth-gated tier at all (see providers/openaire.ts's header
 * comment), so the only gate here is the opt-in env var, kept purely so a
 * routine `npm test` run never depends on network access or a third party's
 * uptime.
 */

const RUN_INTEGRATION = process.env.RUN_ACADEMIC_SEARCH_INTEGRATION === "1";
const skipReason = RUN_INTEGRATION ? false : "set RUN_ACADEMIC_SEARCH_INTEGRATION=1 to run this opt-in, network-dependent test";

test(
  "LIVE: the real OpenAIRE Graph API returns at least one plausible publication for a well-known bibliographic query",
  { skip: skipReason },
  async () => {
    const provider = createOpenAireAcademicSearchProvider({ maxResultsPerRequest: 3, timeoutMs: 15_000 });
    const results = await provider.search({
      queryText: "Attention is all you need Vaswani transformer",
      rank: 0,
      sourcePassage: "Attention is all you need Vaswani transformer",
    });

    assert.ok(results.length > 0, "expected at least one candidate for a well-known, stable bibliographic query");
    const [first] = results;
    assert.equal(first.providerId, "openaire");
    assert.ok(first.externalId.length > 0);
    assert.ok(first.url === null || first.url.startsWith("https://") || first.url.startsWith("http://"));
    assert.equal(first.textAvailable, false, "OpenAIRE never claims full text directly");
  },
);

test(
  "LIVE: getMetadata resolves a real id returned by search() into the same shape",
  { skip: skipReason },
  async () => {
    const provider = createOpenAireAcademicSearchProvider({ maxResultsPerRequest: 1, timeoutMs: 15_000 });
    const [first] = await provider.search({ queryText: "CRISPR Cas9 genome editing mechanism", rank: 0, sourcePassage: "CRISPR Cas9 genome editing mechanism" });
    assert.ok(first, "expected at least one search result to look up metadata for");

    const metadata = await provider.getMetadata(first.externalId);
    assert.ok(metadata, "expected a real record to resolve");
    assert.equal(metadata.title, first.title);
  },
);
