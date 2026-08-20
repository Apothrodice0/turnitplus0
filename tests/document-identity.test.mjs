import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import {
  rawSha256,
  canonicalSha256,
  createDocumentIdentity,
  findDocumentIdentitiesByRawHash,
  findDocumentIdentitiesByCanonicalHash,
  findDocumentIdentitiesByAccount,
  findPriorSubmissionsForAccount,
} from "../lib/document-identity.ts";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import { resetRateForTest } from "../lib/rate-limit.js";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_document_identity.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

// The route handlers below call getReportsDbClient(), which reads this env
// var itself — it must point at the same test database as `client` so the
// integration tests exercise identity capture against the data they can see.
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

// A real users row is required for account_id's foreign key.
await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["identity-user-1", "identity-1@example.com", "identityuser1", "hash1"],
});
await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["identity-user-2", "identity-2@example.com", "identityuser2", "hash2"],
});

// --- Hashing: deterministic, and raw/canonical are genuinely separate concepts ---

test("rawSha256 is deterministic for the same input", () => {
  const text = "Some submitted text.\r\nWith  extra   spacing.";
  assert.equal(rawSha256(text), rawSha256(text));
});

test("rawSha256 is sensitive to formatting differences canonicalSha256 ignores", () => {
  const original = "Some submitted text.\nWith extra spacing.";
  const reformatted = "Some submitted text.\r\nWith   extra   spacing.";
  assert.notEqual(rawSha256(original), rawSha256(reformatted), "raw hash must change with raw bytes");
  assert.equal(canonicalSha256(original), canonicalSha256(reformatted), "canonical hash must not change for formatting-only differences");
});

test("canonicalSha256 is deterministic for the same input", () => {
  const text = "Repeatable document text for hashing.";
  assert.equal(canonicalSha256(text), canonicalSha256(text));
});

test("raw hash and canonical hash of the same text are different concepts (not required to collide)", () => {
  const text = "Plain text with no formatting noise at all.";
  // Not asserting they differ (they may coincide for already-canonical text);
  // asserting they are computed independently and both present.
  assert.equal(typeof rawSha256(text), "string");
  assert.equal(typeof canonicalSha256(text), "string");
  assert.equal(rawSha256(text).length, 64);
  assert.equal(canonicalSha256(text).length, 64);
});

test("meaningfully different documents produce different canonical hashes", () => {
  const docA = "The committee approved the proposal on Tuesday.";
  const docB = "The committee rejected the proposal on Wednesday.";
  assert.notEqual(canonicalSha256(docA), canonicalSha256(docB));
});

// --- Repository: create + find ---

test("createDocumentIdentity stores account_id, title, author, both hashes, and created_at", async () => {
  const text = "Repository-level identity test document.";
  const result = await createDocumentIdentity(client, {
    accountId: "identity-user-1",
    title: "repo-test.pdf",
    author: null,
    rawText: text,
  });
  assert.equal(result.rawSha256, rawSha256(text));
  assert.equal(result.canonicalSha256, canonicalSha256(text));

  const row = await client.execute({
    sql: "SELECT * FROM document_identities WHERE id = ?",
    args: [result.id],
  });
  assert.equal(row.rows.length, 1);
  const stored = row.rows[0];
  assert.equal(stored.account_id, "identity-user-1");
  assert.equal(stored.title, "repo-test.pdf");
  assert.equal(stored.author, null);
  assert.equal(stored.raw_sha256, result.rawSha256);
  assert.equal(stored.canonical_sha256, result.canonicalSha256);
  assert.ok(stored.created_at, "created_at must be set");
});

test("anonymous submissions can have a null account_id", async () => {
  const text = "Anonymous submission text.";
  const result = await createDocumentIdentity(client, {
    accountId: null,
    title: "anonymous.pdf",
    author: null,
    rawText: text,
  });
  const [row] = await findDocumentIdentitiesByRawHash(client, result.rawSha256);
  assert.equal(row.accountId, null);
});

test("findDocumentIdentitiesByRawHash finds an exact raw-hash match", async () => {
  const text = "Findable-by-raw-hash document.";
  const { id, rawSha256: hash } = await createDocumentIdentity(client, {
    accountId: "identity-user-1",
    title: "find-raw.pdf",
    author: null,
    rawText: text,
  });
  const found = await findDocumentIdentitiesByRawHash(client, hash);
  assert.ok(found.some((row) => row.id === id));
});

test("findDocumentIdentitiesByCanonicalHash finds formatting-different submissions of the same document", async () => {
  const original = "Findable by canonical hash.\nSecond line.";
  const reformatted = "Findable   by canonical hash.\r\nSecond   line.";
  const first = await createDocumentIdentity(client, {
    accountId: "identity-user-1",
    title: "canon-a.pdf",
    author: null,
    rawText: original,
  });
  const second = await createDocumentIdentity(client, {
    accountId: "identity-user-2",
    title: "canon-b.pdf",
    author: null,
    rawText: reformatted,
  });
  assert.notEqual(first.rawSha256, second.rawSha256, "sanity check: raw bytes really do differ");
  assert.equal(first.canonicalSha256, second.canonicalSha256, "sanity check: canonical hash really does match");

  const found = await findDocumentIdentitiesByCanonicalHash(client, first.canonicalSha256);
  const ids = found.map((row) => row.id);
  assert.ok(ids.includes(first.id) && ids.includes(second.id));
});

test("findDocumentIdentitiesByAccount returns only that account's rows", async () => {
  const before = await findDocumentIdentitiesByAccount(client, "identity-user-1");
  const created = await createDocumentIdentity(client, {
    accountId: "identity-user-1",
    title: "account-scope.pdf",
    author: null,
    rawText: "Account-scoped find test.",
  });
  const after = await findDocumentIdentitiesByAccount(client, "identity-user-1");
  assert.equal(after.length, before.length + 1);
  assert.ok(after.every((row) => row.accountId === "identity-user-1"));
  assert.ok(after.some((row) => row.id === created.id));
});

// --- Same-account check (inert capability) ---

test("same account can be queried: a resubmission of the same document is found via findPriorSubmissionsForAccount", async () => {
  const text = "Resubmission target document for the same-account check.";
  const first = await createDocumentIdentity(client, {
    accountId: "identity-user-1",
    title: "resubmit-v1.pdf",
    author: null,
    rawText: text,
  });
  const second = await createDocumentIdentity(client, {
    accountId: "identity-user-1",
    title: "resubmit-v2.pdf",
    author: null,
    rawText: text, // literally the same document, resubmitted
  });

  const prior = await findPriorSubmissionsForAccount(client, "identity-user-1", first.canonicalSha256);
  const priorIds = prior.map((row) => row.id);
  assert.ok(priorIds.includes(first.id) && priorIds.includes(second.id), "both submissions by this account must be found");
});

test("different accounts remain distinguishable: the same document submitted by another account is not returned as this account's prior submission", async () => {
  const text = "Shared document text submitted by two different accounts.";
  const ownerSubmission = await createDocumentIdentity(client, {
    accountId: "identity-user-1",
    title: "shared-doc-owner.pdf",
    author: null,
    rawText: text,
  });
  await createDocumentIdentity(client, {
    accountId: "identity-user-2",
    title: "shared-doc-other.pdf",
    author: null,
    rawText: text,
  });

  const priorForOwner = await findPriorSubmissionsForAccount(client, "identity-user-1", ownerSubmission.canonicalSha256);
  assert.ok(priorForOwner.every((row) => row.accountId === "identity-user-1"), "must never surface another account's submission as this account's own prior submission");

  const priorForStranger = await findPriorSubmissionsForAccount(client, "identity-user-2", ownerSubmission.canonicalSha256);
  assert.ok(!priorForStranger.some((row) => row.id === ownerSubmission.id), "the other account must not see the first account's row as its own");
});

test("a brand-new document produces no prior submissions for an account that has never submitted it", async () => {
  const neverSubmitted = canonicalSha256("A document nobody has ever submitted, for this test only.");
  const prior = await findPriorSubmissionsForAccount(client, "identity-user-1", neverSubmitted);
  assert.equal(prior.length, 0);
});

// --- Integration: saving a report still works exactly as before, and now
// also produces a document_identities row as a side effect ---

test("POST /api/reports still returns the same success response and saved_reports still round-trips (existing behavior unchanged)", async () => {
  await resetRateForTest("identity-integration-post");
  const deviceKey = "identity-integration-device";
  const reportId = "identity-integration-report-1";
  const text = "Full report text flowing through the save-report endpoint.";
  const payload = {
    version: 11,
    id: reportId,
    submissionId: "sub-identity-1",
    title: "integration.pdf",
    author: "Guest submission",
    created: new Date().toISOString(),
    score: 4,
    wordCount: 9,
    text,
  };
  const req = new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "identity-integration-post" },
    body: JSON.stringify({
      deviceKey,
      id: reportId,
      submissionId: payload.submissionId,
      title: payload.title,
      createdAt: payload.created,
      wordCount: payload.wordCount,
      archiveScore: payload.score,
      scoreBand: "Low",
      aiScore: null,
      aiTone: null,
      payload,
    }),
  });
  const res = await reportsRoute.POST(req);
  assert.equal(res.status, 200, "save must still succeed exactly as before");
  const body = await res.json();
  assert.deepEqual(body, { ok: true }, "the save response shape must be unchanged");

  await resetRateForTest("identity-integration-get");
  const getReq = new Request(`http://localhost/api/reports/${reportId}?deviceKey=${encodeURIComponent(deviceKey)}`, {
    headers: { "x-forwarded-for": "identity-integration-get" },
  });
  const getRes = await reportIdRoute.GET(getReq, { params: Promise.resolve({ id: reportId }) });
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  // Phase E8C adds historicalSubmissionMatch as read-time enrichment,
  // exactly like Phase D's matchClassification already does elsewhere —
  // unlike matchClassification, it is deliberately always attached (even
  // for NO_HISTORICAL_MATCH) so the persisted snapshot's version/audit
  // metadata stays inspectable regardless of match status (this phase's
  // own task description, section 3). Phase 6 adds unifiedSimilarity as
  // the same kind of read-time enrichment (lib/unified-similarity.ts) —
  // see tests/api-reports.test.mjs's identical adjustment. Assert both
  // shapes separately, then compare the rest of the payload unchanged.
  const { historicalSubmissionMatch, unifiedSimilarity, ...getBodyWithoutHistoricalMatch } = getBody.payload;
  assert.equal(historicalSubmissionMatch?.status, "NO_HISTORICAL_MATCH");
  assert.equal(typeof historicalSubmissionMatch?.matcherVersion, "string");
  assert.ok(unifiedSimilarity, "unifiedSimilarity must also be attached as read-time enrichment");
  assert.deepEqual(getBodyWithoutHistoricalMatch, payload, "the saved report must still round-trip exactly (aside from the new E8C/Phase 6 enrichment fields), unaffected by identity capture");

  // Side effect: a document_identities row was created for this save, scoped
  // to the anonymous submission (no session cookie was sent).
  const identities = await findDocumentIdentitiesByRawHash(client, rawSha256(text));
  assert.ok(identities.some((row) => row.accountId === null && row.title === "integration.pdf"), "identity capture must have run as a side effect of the save");
});

test("a report payload without a text field saves successfully and does not throw (identity capture is best-effort)", async () => {
  await resetRateForTest("identity-integration-no-text");
  const deviceKey = "identity-integration-device-no-text";
  const reportId = "identity-integration-report-no-text";
  const payload = {
    version: 11,
    id: reportId,
    submissionId: "sub-identity-no-text",
    title: "no-text.pdf",
    created: new Date().toISOString(),
    score: 0,
    wordCount: 0,
    // no `text` field
  };
  const req = new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "identity-integration-no-text" },
    body: JSON.stringify({
      deviceKey,
      id: reportId,
      submissionId: payload.submissionId,
      title: payload.title,
      createdAt: payload.created,
      wordCount: payload.wordCount,
      archiveScore: payload.score,
      scoreBand: "Low",
      aiScore: null,
      aiTone: null,
      payload,
    }),
  });
  const res = await reportsRoute.POST(req);
  assert.equal(res.status, 200, "save must succeed even when there is no text to build an identity from");
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
