import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createProvenanceSource, findProvenanceSourceById } from "../lib/provenance-registry.ts";
import { retrieveAndCompareCandidate } from "../lib/retrieval-correspondence-bridge.ts";

/**
 * Phase E6C: the one deliberately-separated, opt-in test that performs a
 * real HTTP retrieval. Per this phase's own task description, section 28:
 * "MUST be opt-in... MUST NOT run in normal npm test... MUST use one
 * explicitly controlled public URL... MUST not use a user submission...
 * MUST not write a VERIFIED_SOURCE... MUST not modify the 230 archive."
 *
 * Uses https://example.com/ — the domain IANA reserves specifically for
 * illustrative/documentation/testing use (RFC 2606) — rather than any real
 * publisher or third-party page, so this test can never depend on, or
 * affect, anyone else's infrastructure. `submittedText` below is a fixed,
 * hardcoded placeholder, never a real user's document.
 *
 * Gated the same way as tests/discovery-crossref-integration.test.mjs: the
 * safe, network-free default is what runs whenever RUN_RETRIEVAL_INTEGRATION
 * is unset.
 */

const RUN_INTEGRATION = process.env.RUN_RETRIEVAL_INTEGRATION === "1";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_retrieval_integration.db");

test(
  "LIVE: the real HTTP retriever successfully fetches and extracts text from a stable public test page",
  { skip: RUN_INTEGRATION ? false : "set RUN_RETRIEVAL_INTEGRATION=1 to run this opt-in, network-dependent test" },
  async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = `${dbFile}${suffix}`;
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
    const client = createClient({ url: `file:${dbFile}` });
    await client.execute("PRAGMA foreign_keys = ON");
    await applyMigrationsLibsql(client, drizzleDir);

    try {
      const source = await createProvenanceSource(client, {
        provenanceState: "CANDIDATE_SOURCE",
        sourceType: "external_reference",
        title: "E6C live retrieval integration check",
        canonicalUrl: "https://example.com/",
      });

      // Fixed, non-sensitive placeholder text — never a real user submission.
      const placeholderSubmittedText = "This is a fixed placeholder document used only to exercise the retrieval and correspondence pipeline end to end. It is not a real user submission.";

      const result = await retrieveAndCompareCandidate(client, {
        sourceId: source.id,
        candidateUrl: "https://example.com/",
        submittedText: placeholderSubmittedText,
      });

      assert.equal(result.retrievalStatus, "SUCCESS");
      assert.ok(result.correspondence, "a successful retrieval must produce a correspondence result, even a weak one");
      assert.equal(result.correspondence.strongCorrespondence, false, "the placeholder text and example.com's own content are unrelated — no correspondence is expected, and none must be fabricated");

      const source_after = await findProvenanceSourceById(client, source.id);
      assert.notEqual(source_after.provenanceState, "VERIFIED_SOURCE", "this integration test must never result in a VERIFIED_SOURCE");
      assert.equal(source_after.provenanceState, "PROVENANCE_PENDING");

      // Report (per this phase's task description, section 25/28) — no
      // retrieved content is logged, only shape/status metadata.
      console.log("[E6C live integration] requests made: 1");
      console.log(`[E6C live integration] retrieval status: ${result.retrievalStatus}`);
      console.log(`[E6C live integration] evidence created: ${result.evidenceCreated.join(", ")}`);
      console.log(`[E6C live integration] correspondence method: ${result.correspondence.method}, strong: ${result.correspondence.strongCorrespondence}`);
      console.log(`[E6C live integration] resulting provenance state: ${source_after.provenanceState}`);
    } finally {
      client.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        const candidate = `${dbFile}${suffix}`;
        try { fs.unlinkSync(candidate); } catch { /* ignore */ }
      }
    }
  },
);
