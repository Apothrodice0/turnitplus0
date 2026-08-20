import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { createSession } from "../lib/auth-session.ts";
import { resetRateForTest } from "../lib/rate-limit.js";
import * as statusRoute from "../app/api/reuse-context/status/route.ts";
import * as pendingRoute from "../app/api/reuse-context/pending/route.ts";
import * as declareRoute from "../app/api/reuse-context/declare/route.ts";
import * as confirmRoute from "../app/api/reuse-context/confirm/route.ts";
import * as rejectRoute from "../app/api/reuse-context/reject/route.ts";
import * as revokeRoute from "../app/api/reuse-context/revoke/route.ts";

/**
 * Phase E8S Step 6: end-to-end tests for the real, session-authenticated
 * API routes (app/api/reuse-context/*), exercised exactly as production
 * would call them -- real Request objects, real session cookies (minted via
 * lib/auth-session.ts's own createSession, the actual production
 * mechanism), real route handlers imported and invoked directly (no Next.js
 * server needed -- see lib/auth-session.ts's own header comment on why
 * every route in this app is written against plain Request objects for
 * exactly this reason). Disposable local SQLite only; TURSO_DATABASE_URL is
 * pointed at a throwaway local file for the duration of this file, same
 * pattern as tests/report-historical-match-integration.test.mjs.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_reuse_context_routes.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
// Phase E8S Step 6.1 added a default-off allowlist gate (E8S_REUSE_CONTEXT_ALLOWLIST)
// in front of every route this file exercises. This file's own purpose is
// the FUNCTIONAL behavior of declare/confirm/reject/revoke, not the gate
// itself (that's tests/e8s-visibility.test.mjs's job) -- so every account
// createAccount() mints below is auto-appended to the allowlist, keeping
// every pre-existing test in this file passing exactly as before Step 6.1.
process.env.E8S_REUSE_CONTEXT_ALLOWLIST = "";

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
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
  const token = await createSession(client, id);
  const existing = process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = existing ? `${existing},${id}` : id;
  return { id, token };
}

async function indexSubmission(accountId, title, rawText) {
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  const indexResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return { identity, indexResult };
}

let ipCounter = 0;
function nextIp(label) {
  ipCounter += 1;
  return `rc-${label}-${ipCounter}`;
}

async function callGet(routeModule, url, token) {
  const ip = nextIp("get");
  await resetRateForTest(ip);
  const headers = { "x-forwarded-for": ip };
  if (token) headers["cookie"] = `tp_session_v1=${token}`;
  const req = new Request(url, { headers });
  return routeModule.GET(req);
}

async function callPost(routeModule, url, token, body) {
  const ip = nextIp("post");
  await resetRateForTest(ip);
  const headers = { "content-type": "application/json", "x-forwarded-for": ip };
  if (token) headers["cookie"] = `tp_session_v1=${token}`;
  const req = new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
  return routeModule.POST(req);
}

function statusUrl(documentIdentityId, representationId) {
  return `http://localhost/api/reuse-context/status?documentIdentityId=${encodeURIComponent(documentIdentityId)}&representationId=${encodeURIComponent(representationId)}`;
}
function pendingUrl(documentIdentityId) {
  return `http://localhost/api/reuse-context/pending?documentIdentityId=${encodeURIComponent(documentIdentityId)}`;
}

/** Shared fixture for the confirm/reject/revoke lifecycle tests: an original submitter and a reuser who has already declared SUPERVISOR_COPY. */
async function declaredFixture(marker) {
  const text = `Fixture body for E2E lifecycle tests, marker ${marker}, long enough to canonicalize deterministically.`;
  const original = await createAccount(`${marker}-orig`);
  const reuser = await createAccount(`${marker}-reuse`);
  const { identity: identity1, indexResult: ref1 } = await indexSubmission(original.id, "doc", text);
  const { identity: identity2 } = await indexSubmission(reuser.id, "doc", text);
  const res = await callPost(declareRoute, "http://localhost/api/reuse-context/declare", reuser.token, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredContext: "SUPERVISOR_COPY",
  });
  assert.equal(res.status, 200, `fixture declare for marker ${marker} must succeed`);
  const body = await res.json();
  return { original, reuser, identity1, identity2, ref1, declarationId: body.declaration.id };
}

test("A: PRIOR_SUBMISSION pair shows canDeclare=true -- the 'Add context' affordance", async () => {
  const text = "Fixture body for E2E test A, long enough to canonicalize deterministically.";
  const original = await createAccount("a-orig");
  const reuser = await createAccount("a-reuse");
  const { indexResult: ref1 } = await indexSubmission(original.id, "doc", text);
  const { identity: identity2 } = await indexSubmission(reuser.id, "doc", text);

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.affordance, { canDeclare: true });
  assert.equal(body.activeDeclaration, null);
});

test("B: declare supervisor copy", async () => {
  const text = "Fixture body for E2E test B.";
  const original = await createAccount("b-orig");
  const reuser = await createAccount("b-reuse");
  const { indexResult: ref1 } = await indexSubmission(original.id, "doc", text);
  const { identity: identity2 } = await indexSubmission(reuser.id, "doc", text);

  const res = await callPost(declareRoute, "http://localhost/api/reuse-context/declare", reuser.token, {
    documentIdentityId: identity2.id,
    representationId: ref1.representationId,
    declaredContext: "SUPERVISOR_COPY",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "DECLARED");
  assert.equal(body.declaration.declaredContext, "SUPERVISOR_COPY");
  assert.equal(body.declaration.verificationState, "SELF_ASSERTED_UNVERIFIED");
  assert.equal(body.declaration.confirmedAt, null);
  assert.equal(body.declaration.revokedAt, null);
});

test("C: original submitter sees confirmation panel (GET /pending)", async () => {
  const { original, identity1, declarationId } = await declaredFixture("c");
  const res = await callGet(pendingRoute, pendingUrl(identity1.id), original.token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.declarations.length, 1);
  assert.equal(body.declarations[0].id, declarationId);
  assert.equal(body.declarations[0].verificationState, "SELF_ASSERTED_UNVERIFIED");
});

test("D: original submitter confirms", async () => {
  const { original, declarationId } = await declaredFixture("d");
  const res = await callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { declarationId });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "CONFIRMED");
  assert.equal(body.declaration.verificationState, "MUTUALLY_CONFIRMED");
  assert.notEqual(body.declaration.confirmedAt, null);
});

test("E: original submitter rejects without confirming", async () => {
  const { original, declarationId } = await declaredFixture("e");
  const res = await callPost(rejectRoute, "http://localhost/api/reuse-context/reject", original.token, { declarationId });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "REVOKED");
  assert.equal(body.declaration.confirmedAt, null, "rejected without ever confirming");
  assert.notEqual(body.declaration.revokedAt, null);
});

test("E2: /reject refuses (USE_REVOKE_INSTEAD) once a declaration is already confirmed", async () => {
  const { original, declarationId } = await declaredFixture("e2");
  const confirmRes = await callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { declarationId });
  assert.equal(confirmRes.status, 200);
  const rejectRes = await callPost(rejectRoute, "http://localhost/api/reuse-context/reject", original.token, { declarationId });
  assert.equal(rejectRes.status, 409);
  const body = await rejectRes.json();
  assert.equal(body.status, "USE_REVOKE_INSTEAD");
});

test("F: declarer withdraws", async () => {
  const { reuser, declarationId } = await declaredFixture("f");
  const res = await callPost(revokeRoute, "http://localhost/api/reuse-context/revoke", reuser.token, { declarationId });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "REVOKED");
});

test("G: either party revokes after confirmation, and the audit trail retains that it was once confirmed", async () => {
  const { original, reuser, declarationId } = await declaredFixture("g");
  const confirmRes = await callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { declarationId });
  assert.equal(confirmRes.status, 200);

  const revokeRes = await callPost(revokeRoute, "http://localhost/api/reuse-context/revoke", reuser.token, { declarationId });
  assert.equal(revokeRes.status, 200);
  const body = await revokeRes.json();
  assert.equal(body.status, "REVOKED");
  assert.notEqual(body.declaration.confirmedAt, null, "confirmedAt must survive revocation -- it is a preserved historical fact");
});

test("G2: the original submitter (as confirmer) can also revoke after confirmation", async () => {
  const { original, declarationId } = await declaredFixture("g2");
  await callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { declarationId });
  const revokeRes = await callPost(revokeRoute, "http://localhost/api/reuse-context/revoke", original.token, { declarationId });
  assert.equal(revokeRes.status, 200);
  const body = await revokeRes.json();
  assert.equal(body.status, "REVOKED");
});

test("H: ambiguous pair hides Add context", async () => {
  const text = "Fixture body for E2E test H, three submitters.";
  const acct1 = await createAccount("h1");
  const acct2 = await createAccount("h2");
  const acct3 = await createAccount("h3");
  const { indexResult: ref1 } = await indexSubmission(acct1.id, "doc", text);
  await indexSubmission(acct2.id, "doc", text);
  const { identity: identity3 } = await indexSubmission(acct3.id, "doc", text);

  const res = await callGet(statusRoute, statusUrl(identity3.id, ref1.representationId), acct3.token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.affordance, { canDeclare: false, reason: "AMBIGUOUS" });
  assert.equal(body.activeDeclaration, null);
});

test("I: unresolvable pair disables confirmation after the underlying reference is gone", async () => {
  const { original, declarationId, ref1 } = await declaredFixture("i");
  // Deleting the representation cascades to corpus_submission_references (ON DELETE CASCADE) -- no cascade to reuse_context_declarations (E8S Step 2/4's own design).
  await client.execute({ sql: "DELETE FROM corpus_document_representations WHERE id = ?", args: [ref1.representationId] });

  const res = await callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { declarationId });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.status, "ORIGINAL_SUBMISSION_UNRESOLVABLE");
});

test("J: SELF never shows Add context", async () => {
  const text = "Fixture body for E2E test J, same-account resubmission.";
  const account = await createAccount("j");
  const { indexResult: ref1 } = await indexSubmission(account.id, "doc-v1", text);
  const { identity: identity2 } = await indexSubmission(account.id, "doc-v2", text);

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), account.token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.affordance, { canDeclare: false, reason: "SELF_RELATIONSHIP" });
});

test("K: third party cannot see or act on a pair they do not own", async () => {
  const { identity1, identity2, ref1, declarationId } = await declaredFixture("k");
  const stranger = await createAccount("k-stranger");

  const statusRes = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), stranger.token);
  assert.equal(statusRes.status, 403);

  const pendingRes = await callGet(pendingRoute, pendingUrl(identity1.id), stranger.token);
  assert.equal(pendingRes.status, 403);

  const declareRes = await callPost(declareRoute, "http://localhost/api/reuse-context/declare", stranger.token, {
    documentIdentityId: identity2.id, representationId: ref1.representationId, declaredContext: "OTHER_AUTHORIZED_REUSE",
  });
  assert.equal(declareRes.status, 403);
  assert.equal((await declareRes.json()).status, "DECLARER_NOT_SUBMISSION_OWNER");

  const confirmRes = await callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", stranger.token, { declarationId });
  assert.equal(confirmRes.status, 409);
  assert.equal((await confirmRes.json()).status, "NOT_ORIGINAL_SUBMITTER");

  const revokeRes = await callPost(revokeRoute, "http://localhost/api/reuse-context/revoke", stranger.token, { declarationId });
  assert.equal(revokeRes.status, 409);
  assert.equal((await revokeRes.json()).status, "NOT_AUTHORIZED_TO_REVOKE");

  const rejectRes = await callPost(rejectRoute, "http://localhost/api/reuse-context/reject", stranger.token, { declarationId });
  assert.equal(rejectRes.status, 409);
  assert.equal((await rejectRes.json()).status, "NOT_AUTHORIZED_TO_REVOKE");
});

test("K2: unauthenticated requests are rejected with 401 across every route", async () => {
  const { identity1, identity2, ref1, declarationId } = await declaredFixture("k2");
  assert.equal((await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), undefined)).status, 401);
  assert.equal((await callGet(pendingRoute, pendingUrl(identity1.id), undefined)).status, 401);
  assert.equal((await callPost(declareRoute, "http://localhost/api/reuse-context/declare", undefined, {
    documentIdentityId: identity2.id, representationId: ref1.representationId, declaredContext: "OTHER_AUTHORIZED_REUSE",
  })).status, 401);
  assert.equal((await callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", undefined, { declarationId })).status, 401);
  assert.equal((await callPost(rejectRoute, "http://localhost/api/reuse-context/reject", undefined, { declarationId })).status, 401);
  assert.equal((await callPost(revokeRoute, "http://localhost/api/reuse-context/revoke", undefined, { declarationId })).status, 401);
});

test("L (structural): no new E8S Step 6 file references score/archiveScore/aiScore/verifiedSimilarity/containment/matchedWordCount as a code identifier", () => {
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  // Reassurance prose ("It will not change your score.") is expected and
  // intentional (E8S Step 5's own copy) -- it must never trip this check,
  // which is only about CODE referencing the actual score/archiveScore/
  // aiScore/verifiedSimilarity/containment/matchedWordCount fields. camelCase
  // identifiers can never occur in natural English, so they're checked
  // as-is; the bare word "score" is only checked where it could plausibly
  // be a code reference (immediately followed by an identifier boundary
  // like `.`, `:`, `=`, `,`, `)`, or camelCase continuation), never inside
  // a sentence.
  const CODE_IDENTIFIER_PATTERN = /archiveScore|aiScore|verifiedSimilarity|matchedWordCount|\bcontainment\b|\.score\b|\bscore\s*[:=]/i;
  const files = [
    "lib/reuse-context-declarations.ts",
    "app/api/reuse-context/status/route.ts",
    "app/api/reuse-context/pending/route.ts",
    "app/api/reuse-context/declare/route.ts",
    "app/api/reuse-context/confirm/route.ts",
    "app/api/reuse-context/reject/route.ts",
    "app/api/reuse-context/revoke/route.ts",
    "components/reuse-context/reuse-context-panel.tsx",
    "components/reuse-context/original-submitter-confirmation-panel.tsx",
  ];
  for (const file of files) {
    const source = stripComments(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    assert.doesNotMatch(
      source,
      CODE_IDENTIFIER_PATTERN,
      `${file} must never reference score/archiveScore/aiScore/verifiedSimilarity/containment/matchedWordCount as a code identifier`,
    );
  }
});

test("L2 (runtime): a full declare -> confirm -> revoke cycle never touches an unrelated saved_reports row's score fields", async () => {
  const reportId = "l2-report-1";
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, saved_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [reportId, "l2-device", "l2-sub", "l2.pdf", new Date().toISOString(), 100, 37, "Low", JSON.stringify({ score: 37, archiveScore: 37, aiScore: 61 })],
  });
  const before = await client.execute({ sql: "SELECT archive_score, payload_json FROM saved_reports WHERE id = ?", args: [reportId] });

  const { original, declarationId } = await declaredFixture("l2");
  await callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { declarationId });
  await callPost(revokeRoute, "http://localhost/api/reuse-context/revoke", original.token, { declarationId });

  const after = await client.execute({ sql: "SELECT archive_score, payload_json FROM saved_reports WHERE id = ?", args: [reportId] });
  assert.deepEqual(before.rows[0], after.rows[0], "an unrelated report's score fields must be byte-identical before and after a full declaration lifecycle");
});

test("M: concurrent actions remain race-safe (duplicate declare, simultaneous confirm, simultaneous revoke)", async () => {
  const text = "Fixture body for E2E test M concurrency.";
  const original = await createAccount("m-orig");
  const reuser = await createAccount("m-reuse");
  const { indexResult: ref1 } = await indexSubmission(original.id, "doc", text);
  const { identity: identity2 } = await indexSubmission(reuser.id, "doc", text);

  const declareBody = { documentIdentityId: identity2.id, representationId: ref1.representationId, declaredContext: "COAUTHOR_COPY" };
  const [d1, d2] = await Promise.all([
    callPost(declareRoute, "http://localhost/api/reuse-context/declare", reuser.token, declareBody),
    callPost(declareRoute, "http://localhost/api/reuse-context/declare", reuser.token, declareBody),
  ]);
  const declareStatuses = [(await d1.json()).status, (await d2.json()).status].sort();
  assert.deepEqual(declareStatuses, ["ALREADY_ACTIVE", "DECLARED"]);

  const active = await client.execute({
    sql: "SELECT id FROM reuse_context_declarations WHERE document_identity_id=? AND matched_representation_id=? AND revoked_at IS NULL",
    args: [identity2.id, ref1.representationId],
  });
  assert.equal(active.rows.length, 1, "exactly one active row must survive the concurrent declare race");
  const declarationId = Number(active.rows[0].id);

  const [c1, c2] = await Promise.all([
    callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { declarationId }),
    callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { declarationId }),
  ]);
  const confirmStatuses = [(await c1.json()).status, (await c2.json()).status].sort();
  assert.deepEqual(confirmStatuses, ["ALREADY_CONFIRMED", "CONFIRMED"]);

  const [r1, r2] = await Promise.all([
    callPost(revokeRoute, "http://localhost/api/reuse-context/revoke", reuser.token, { declarationId }),
    callPost(revokeRoute, "http://localhost/api/reuse-context/revoke", original.token, { declarationId }),
  ]);
  const revokeStatuses = [(await r1.json()).status, (await r2.json()).status].sort();
  assert.deepEqual(revokeStatuses, ["ALREADY_REVOKED", "REVOKED"]);
});

test("N: report deletion does not affect the declaration -- it is anchored to document_identity, not the report", async () => {
  const { declarationId } = await declaredFixture("n");
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, saved_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: ["n-report-1", "n-device-1", "n-sub-1", "n.pdf", new Date().toISOString(), 100, 5, "Low", JSON.stringify({ score: 5, archiveScore: 5 })],
  });
  await client.execute({ sql: "DELETE FROM saved_reports WHERE id = ?", args: ["n-report-1"] });

  const raw = await client.execute({ sql: "SELECT id, verification_state FROM reuse_context_declarations WHERE id = ?", args: [declarationId] });
  assert.equal(raw.rows.length, 1);
  assert.equal(raw.rows[0].verification_state, "SELF_ASSERTED_UNVERIFIED");
});

test("O: representation deletion does not cascade to the declaration row -- audit trail preserved, reference left dangling", async () => {
  const { declarationId, ref1 } = await declaredFixture("o");
  await client.execute({ sql: "DELETE FROM corpus_document_representations WHERE id = ?", args: [ref1.representationId] });

  const raw = await client.execute({
    sql: "SELECT id, matched_representation_id, matched_submission_reference_id FROM reuse_context_declarations WHERE id = ?",
    args: [declarationId],
  });
  assert.equal(raw.rows.length, 1, "the declaration row must survive representation deletion");

  const refCheck = await client.execute({
    sql: "SELECT id FROM corpus_submission_references WHERE id = ?",
    args: [raw.rows[0].matched_submission_reference_id],
  });
  assert.equal(refCheck.rows.length, 0, "the underlying reference should be gone -- cascaded from the representation delete, per corpus_submission_references' own ON DELETE CASCADE");
});
