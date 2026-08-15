import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { getReuseContextEligibility } from "../lib/e8s-report-integration.ts";

/**
 * Phase E8S Step 11: local-only tests for the server-side read-time
 * enrichment (lib/e8s-report-integration.ts) that decides whether/what the
 * client is even handed to attempt an E8S fetch with. Same disposable-
 * local-SQLite pattern as tests/reuse-context-declarations.test.mjs.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_e8s_report_integration.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

let userCounter = 0;
async function createAccount(prefix) {
  userCounter += 1;
  const id = `${prefix}-${userCounter}`;
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [id, `${id}@example.test`, id, "not-a-real-hash"],
  });
  return id;
}

async function indexSubmission(accountId, title, rawText) {
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  const indexResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return { identity, indexResult };
}

const NO_MATCH = { status: "NO_HISTORICAL_MATCH", computedAt: new Date().toISOString(), matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v" };

test("N (server-side): non-allowlisted account gets undefined -- no ids ever handed to the client", async () => {
  const text = "Fixture body for the non-allowlisted eligibility test, long enough to canonicalize.";
  const accountId = await createAccount("n1");
  await indexSubmission(accountId, "doc", text);
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST; // explicit: nobody allowlisted

  const result = await getReuseContextEligibility(client, { accountId, rawText: text, historicalSubmissionMatch: NO_MATCH });
  assert.equal(result, undefined);
});

test("allowlisted account with a resolvable own identity gets documentIdentityId, representationId null when not PRIOR_SUBMISSION", async () => {
  const text = "Fixture body for the allowlisted-but-no-PRIOR_SUBMISSION eligibility test.";
  const accountId = await createAccount("ok1");
  await indexSubmission(accountId, "doc", text);
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = accountId;

  const result = await getReuseContextEligibility(client, { accountId, rawText: text, historicalSubmissionMatch: NO_MATCH });
  assert.ok(result);
  assert.equal(typeof result.documentIdentityId, "string");
  assert.equal(result.representationId, null);
});

test("allowlisted account with a PRIOR_SUBMISSION match gets both ids, representationId taken from the already-computed match, never recomputed", async () => {
  const text = "Fixture body for the PRIOR_SUBMISSION eligibility test, long enough to canonicalize.";
  const accountId = await createAccount("ps1");
  const { indexResult } = await indexSubmission(accountId, "doc", text);
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = accountId;

  const matched = {
    status: "MATCHED",
    computedAt: new Date().toISOString(),
    matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v",
    matches: [{
      relationshipType: "PRIOR_SUBMISSION",
      matchedRepresentationId: indexResult.representationId,
      matchType: "EXACT_CANONICAL_MATCH",
      containment: 1, matchedWordCount: 10, passageCount: 1, longestMatchWords: 10,
      passages: [], historicalSubmissionCount: 1,
    }],
  };

  const result = await getReuseContextEligibility(client, { accountId, rawText: text, historicalSubmissionMatch: matched });
  assert.ok(result);
  assert.equal(result.representationId, indexResult.representationId);
});

test("allowlisted account with a SELF match gets representationId null -- the CTA must never appear for SELF", async () => {
  const text = "Fixture body for the SELF-match eligibility test, long enough to canonicalize.";
  const accountId = await createAccount("self1");
  const { indexResult } = await indexSubmission(accountId, "doc", text);
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = accountId;

  const matchedSelf = {
    status: "MATCHED",
    computedAt: new Date().toISOString(),
    matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v",
    matches: [{
      relationshipType: "SELF",
      matchedRepresentationId: indexResult.representationId,
      matchType: "EXACT_CANONICAL_MATCH",
      containment: 1, matchedWordCount: 10, passageCount: 1, longestMatchWords: 10,
      passages: [], historicalSubmissionCount: 0,
    }],
  };

  const result = await getReuseContextEligibility(client, { accountId, rawText: text, historicalSubmissionMatch: matchedSelf });
  assert.ok(result, "documentIdentityId must still resolve (needed for the pending panel), only representationId is suppressed");
  assert.equal(result.representationId, null);
});

test("no own identity resolvable (never submitted this content) -> undefined", async () => {
  const accountId = await createAccount("noid1");
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = accountId;
  const result = await getReuseContextEligibility(client, { accountId, rawText: "text this account never actually submitted", historicalSubmissionMatch: NO_MATCH });
  assert.equal(result, undefined);
});

test("P (cross-account isolation): resolving eligibility for one account never returns another account's identity", async () => {
  const text = "Fixture body for the cross-account isolation test, shared canonical text.";
  const accountA = await createAccount("cross-a");
  const accountB = await createAccount("cross-b");
  const { identity: identityA } = await indexSubmission(accountA, "doc", text);
  const { identity: identityB } = await indexSubmission(accountB, "doc", text);
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = `${accountA},${accountB}`;

  const resultA = await getReuseContextEligibility(client, { accountId: accountA, rawText: text, historicalSubmissionMatch: NO_MATCH });
  const resultB = await getReuseContextEligibility(client, { accountId: accountB, rawText: text, historicalSubmissionMatch: NO_MATCH });

  assert.equal(resultA.documentIdentityId, identityA.id);
  assert.equal(resultB.documentIdentityId, identityB.id);
  assert.notEqual(resultA.documentIdentityId, resultB.documentIdentityId, "each account must only ever resolve to its own identity, never the other's");
});

test("Q/W (structural): lib/e8s-report-integration.ts never references score/archiveScore/aiScore/verifiedSimilarity", () => {
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  const source = stripComments(fs.readFileSync(path.join(repoRoot, "lib/e8s-report-integration.ts"), "utf8"));
  assert.doesNotMatch(source, /archiveScore|aiScore|verifiedSimilarity|\.score\b|\bscore\s*[:=]/i);
});

test("anonymous accountId (null) always returns undefined, matching isE8sReuseContextAllowlisted's own null handling", async () => {
  const result = await getReuseContextEligibility(client, { accountId: null, rawText: "irrelevant", historicalSubmissionMatch: NO_MATCH });
  assert.equal(result, undefined);
});

test("a computation failure never throws past this function (non-fatal, matches every other read-time enrichment in this codebase)", async () => {
  const accountId = await createAccount("fail1");
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = accountId;
  // malformed historicalSubmissionMatch shape should not crash the enrichment
  const result = await getReuseContextEligibility(client, { accountId, rawText: "x".repeat(50), historicalSubmissionMatch: { status: "MATCHED" } });
  // Either resolves gracefully (no own identity for this text -> undefined) or throws internally and is caught -> undefined either way.
  assert.equal(result, undefined);
});
