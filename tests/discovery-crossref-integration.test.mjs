import assert from "node:assert/strict";
import test from "node:test";
import { createCrossrefDiscoveryProvider } from "../lib/discovery-crossref-provider.ts";

/**
 * Phase E6B: the one deliberately-separated, opt-in test that hits the
 * real Crossref API. Per this phase's own task description, section 18B:
 * "It MUST NOT run in normal `npm test`... require an explicit environment
 * variable such as RUN_CROSSREF_INTEGRATION=1." `npm test`'s glob
 * (`tests/*.test.mjs`) would otherwise pick this file up unconditionally,
 * so the gating happens inside the test itself via Node's test-runner
 * `skip` option — the safe, network-free default is what runs whenever
 * RUN_CROSSREF_INTEGRATION is unset, exactly like tests/schema-drift.test.mjs's
 * existing TURSO_DATABASE_URL-gated behavior.
 *
 * Exactly ONE real HTTP request is made — a single bibliographic lookup for
 * a well-known, stable, long-published paper, chosen specifically because
 * its existence in Crossref's index is extremely unlikely to ever change.
 * No private, user-submitted, or otherwise sensitive text is ever sent —
 * this is a fixed, hardcoded, public test string.
 */

const RUN_INTEGRATION = process.env.RUN_CROSSREF_INTEGRATION === "1";

test(
  "LIVE: the real Crossref API returns at least one plausible candidate for a well-known bibliographic query",
  { skip: RUN_INTEGRATION ? false : "set RUN_CROSSREF_INTEGRATION=1 to run this opt-in, network-dependent test" },
  async () => {
    const provider = createCrossrefDiscoveryProvider({
      contactEmail: process.env.CROSSREF_MAILTO?.trim() || undefined,
      maxRequestsPerRun: 1,
      maxResultsPerRequest: 3,
      timeoutMs: 10_000,
    });

    const request = {
      requestId: "e6b-live-integration-check",
      queries: [{ queryText: "Attention is All You Need Vaswani", basis: ["DISTINCTIVE_PASSAGE"], rank: 0 }],
      signals: { normalizedTitle: null, normalizedAuthor: null, distinctivePassages: [], canonicalHash: null, language: null },
    };

    const results = await provider.discover(request);

    assert.ok(results.length > 0, "expected at least one candidate for a well-known, stable bibliographic query");
    const [first] = results;
    assert.ok(first.url === null || first.url.startsWith("https://"), "any returned URL must be https");
    assert.ok(typeof first.providerConfidence === "number" || first.providerConfidence === null);
  },
);
