import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { runSourceDiscoveryWorkflow } from "../lib/source-discovery-workflow.ts";
import { createDefaultDiscoveryProviderRegistry, createDefaultContentRetrieverRegistry } from "../lib/source-discovery-registries.ts";

/**
 * Phase E6D: the one deliberately-separated, opt-in test that exercises the
 * full workflow against real external services (Crossref discovery, then
 * whatever public URL it returns for retrieval). Per this phase's own task
 * description, section 28: "MUST be opt-in... bounded requests... not use
 * a user submission... not write VERIFIED_SOURCE."
 *
 * Uses a fixed, well-known, stable bibliographic query as the "controlled
 * public test document" (the same one tests/discovery-crossref-
 * integration.test.mjs already uses for the same reason) — never a real
 * user's text. Bounded to exactly one candidate and one retrieval attempt.
 * Real external content is unpredictable by nature (a publisher page might
 * redirect, block, or serve a non-HTML type) — this test tolerates any
 * outcome the workflow itself already treats as legitimate (RETRIEVAL_FAILED,
 * CORRESPONDENCE_WEAK, etc.) and only asserts the invariants that must hold
 * regardless: the workflow completes without crashing, and the result never
 * reaches VERIFIED_SOURCE.
 */

const RUN_INTEGRATION = process.env.RUN_WORKFLOW_INTEGRATION === "1";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_source_discovery_workflow_integration.db");

test(
  "LIVE: the full E6D workflow runs end to end against real Crossref discovery and real HTTP retrieval without crashing, and never reaches VERIFIED_SOURCE",
  { skip: RUN_INTEGRATION ? false : "set RUN_WORKFLOW_INTEGRATION=1 to run this opt-in, network-dependent test" },
  async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = `${dbFile}${suffix}`;
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
    const client = createClient({ url: `file:${dbFile}` });
    await client.execute("PRAGMA foreign_keys = ON");
    await applyMigrationsLibsql(client, drizzleDir);

    try {
      const discoveryProviders = createDefaultDiscoveryProviderRegistry({
        contactEmail: process.env.CROSSREF_MAILTO?.trim() || undefined,
        maxRequestsPerRun: 1,
        maxResultsPerRequest: 1,
      });
      const contentRetrievers = createDefaultContentRetrieverRegistry({ timeoutMs: 10_000 });

      const placeholderSubmittedText = "This is a fixed placeholder document used only to exercise the E6D workflow end to end against real external services. It is not a real user submission.";

      const result = await runSourceDiscoveryWorkflow(
        client,
        { submittedText: `Attention is All You Need Vaswani. ${placeholderSubmittedText}`, providerIds: ["crossref"], retrieverId: "http" },
        { maxCandidatesProcessed: 1, maxRetrievals: 1, maxDiscoveryProviders: 1, maxQueriesPerProvider: 1 },
        { discoveryProviders, contentRetrievers },
      );

      assert.equal(result.discoveryAttempts.length, 1);
      assert.ok(["OK", "NO_RESULTS", "RATE_LIMITED", "PROVIDER_UNAVAILABLE"].includes(result.discoveryAttempts[0].status));
      assert.ok(result.candidateResults.length <= 1);
      for (const candidate of result.candidateResults) {
        assert.notEqual(candidate.provenanceState, "VERIFIED_SOURCE");
      }
      assert.equal(result.verificationEligible, false, "no phase through E6D creates a complete-enough evidence set to ever report eligible here");

      console.log(`[E6D live integration] discovery attempt status: ${result.discoveryAttempts[0].status}, results: ${result.discoveryAttempts[0].resultCount}`);
      console.log(`[E6D live integration] candidates discovered: ${result.candidatesDiscovered}, processed: ${result.candidatesProcessed}`);
      for (const candidate of result.candidateResults) {
        console.log(`[E6D live integration] candidate status: ${candidate.status}, retrieval: ${candidate.retrievalStatus}, provenance: ${candidate.provenanceState}`);
      }
    } finally {
      client.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        const candidate = `${dbFile}${suffix}`;
        try { fs.unlinkSync(candidate); } catch { /* ignore */ }
      }
    }
  },
);
