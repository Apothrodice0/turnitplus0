import assert from "node:assert/strict";
import test from "node:test";
import { createCoreAcademicSearchProvider } from "../lib/academic-search/providers/core.ts";

/**
 * The one deliberately-separated, opt-in test that hits the real CORE API —
 * mirrors tests/discovery-crossref-integration.test.mjs's own gating
 * pattern exactly. `npm test`'s glob (tests/*.test.mjs) would otherwise
 * pick this file up unconditionally, so it self-skips via node:test's
 * `skip` option whenever the gate is not explicitly opened.
 *
 * Unlike the Crossref integration test, this one additionally requires a
 * real CORE_API_KEY (CORE's v3 API is key-gated — see providers/core.ts's
 * own header comment on what has and hasn't been verified about its
 * request/response shape). No submission or user text is ever sent — this
 * is a single, fixed, public bibliographic query string.
 */

const RUN_INTEGRATION = process.env.RUN_CORE_INTEGRATION === "1";
const API_KEY = process.env.CORE_API_KEY?.trim();

const skipReason = !RUN_INTEGRATION
  ? "set RUN_CORE_INTEGRATION=1 to run this opt-in, network-dependent test"
  : !API_KEY
    ? "RUN_CORE_INTEGRATION=1 is set but CORE_API_KEY is missing — CORE's v3 API requires a key"
    : false;

test(
  "LIVE: the real CORE API returns at least one plausible candidate for a well-known bibliographic query",
  { skip: skipReason },
  async () => {
    const provider = createCoreAcademicSearchProvider({ apiKey: API_KEY, maxResultsPerRequest: 3, timeoutMs: 10_000 });
    const results = await provider.search({
      queryText: "Attention is All You Need Vaswani transformer",
      rank: 0,
      sourcePassage: "Attention is All You Need Vaswani transformer",
    });

    assert.ok(results.length > 0, "expected at least one candidate for a well-known, stable bibliographic query");
    const [first] = results;
    assert.ok(first.url === null || first.url.startsWith("https://"), "any returned URL must be https");
    assert.equal(first.providerId, "core");
  },
);
