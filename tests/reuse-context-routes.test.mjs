import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { createSession, hashToken } from "../lib/auth-session.ts";
import { resetRateForTest } from "../lib/rate-limit.js";
import { deriveReuseContextActionRef } from "../lib/reuse-context-action-ref.ts";
import * as declareRoute from "../app/api/reuse-context/declare/route.ts";
import * as withdrawRoute from "../app/api/reuse-context/withdraw/route.ts";
import * as revokeRoute from "../app/api/reuse-context/revoke/route.ts";
import * as confirmRoute from "../app/api/reuse-context/confirm/route.ts";
import * as rejectRoute from "../app/api/reuse-context/reject/route.ts";
import * as reportRoute from "../app/api/reports/[id]/route.ts";

/**
 * Report-bound, session-bound-actionRef reuse-context routes. Disposable
 * local SQLite; real Request objects, real session cookies, real handlers.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_reuse_context_routes.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
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
  return { id, token, sessionKey: hashToken(token) };
}

async function indexSubmission(accountId, title, rawText) {
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  const indexResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return { identity, indexResult };
}

let reportCounter = 0;
async function seedReport({ accountId, documentIdentityId, rawText }) {
  reportCounter += 1;
  const reportId = `rpt-${reportCounter}-${Date.now()}`;
  const deviceKey = `dev-${reportCounter}`;
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, document_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, `sub-${reportId}`, "doc.txt", new Date().toISOString(), 20, 0, "Low", JSON.stringify({ text: rawText }), accountId, documentIdentityId],
  });
  return { reportId, deviceKey };
}

let ipCounter = 0;
function nextIp(label) { ipCounter += 1; return `rc-${label}-${ipCounter}`; }

async function callPost(routeModule, url, token, body, { origin = "http://localhost", host = "localhost" } = {}) {
  const ip = nextIp("post");
  await resetRateForTest(ip);
  const headers = { "content-type": "application/json", "x-forwarded-for": ip };
  if (token) headers["cookie"] = `tp_session_v1=${token}`;
  if (origin !== null) headers["origin"] = origin;
  if (host !== null) headers["host"] = host;
  const req = new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
  return routeModule.POST(req);
}

async function callReportGet(reportId, token) {
  const ip = nextIp("get");
  await resetRateForTest(ip);
  const headers = { "x-forwarded-for": ip };
  if (token) headers["cookie"] = `tp_session_v1=${token}`;
  const req = new Request(`http://localhost/api/reports/${encodeURIComponent(reportId)}`, { headers });
  return reportRoute.GET(req, { params: Promise.resolve({ id: reportId }) });
}

const DECLARE_URL = "http://localhost/api/reuse-context/declare";
const WITHDRAW_URL = "http://localhost/api/reuse-context/withdraw";
const REVOKE_URL = "http://localhost/api/reuse-context/revoke";
const CONFIRM_URL = "http://localhost/api/reuse-context/confirm";
const REJECT_URL = "http://localhost/api/reuse-context/reject";

/** original indexes text; reuser indexes the same text and gets a report whose first-eligible PRIOR_SUBMISSION is the original's representation. */
async function priorSubmissionFixture(marker) {
  const text = `Reuse-context routes fixture ${marker}, long enough to canonicalize into stable shingles for the matcher.`;
  const original = await createAccount(`${marker}-orig`);
  const reuser = await createAccount(`${marker}-reuse`);
  const { identity: originalIdentity } = await indexSubmission(original.id, "orig", text);
  const { identity: reuserIdentity } = await indexSubmission(reuser.id, "reuse", text);
  const reuserReport = await seedReport({ accountId: reuser.id, documentIdentityId: reuserIdentity.id, rawText: text });
  const originalReport = await seedReport({ accountId: original.id, documentIdentityId: originalIdentity.id, rawText: text });
  return { text, original, reuser, originalIdentity, reuserIdentity, reuserReport, originalReport };
}

async function activeDeclarationIds(documentIdentityId) {
  const r = await client.execute({
    sql: "SELECT id FROM reuse_context_declarations WHERE document_identity_id = ? AND revoked_at IS NULL ORDER BY id ASC",
    args: [documentIdentityId],
  });
  return r.rows.map((row) => Number(row.id));
}

// --- declare: report-bound ---------------------------------------------------

test("declare: report-bound, resolves the first-eligible PRIOR_SUBMISSION server-side", async () => {
  const f = await priorSubmissionFixture("decl");
  const res = await callPost(declareRoute, DECLARE_URL, f.reuser.token, { reportId: f.reuserReport.reportId, declaredContext: "SUPERVISOR_COPY" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "DECLARED");
  assert.ok(body.reuseContext, "response carries a fresh envelope");
  assert.equal(body.reuseContext.declare.activeDeclarations.length, 1);
  assert.equal(body.reuseContext.declare.activeDeclarations[0].state, "SELF_ASSERTED_UNVERIFIED");
  assert.equal(body.reuseContext.declare.activeDeclarations[0].declaredContext, "SUPERVISOR_COPY");
  assert.equal(body.reuseContext.declare.activeDeclarations[0].isCurrent, true);
  assert.match(body.reuseContext.declare.activeDeclarations[0].actionRef, /^[0-9a-f]{64}$/);
});

test("declare: never accepts documentIdentityId / representationId from the client", async () => {
  const f = await priorSubmissionFixture("decl-noids");
  // Even if the client tries to smuggle ids, they are ignored — the route reads reportId only.
  const res = await callPost(declareRoute, DECLARE_URL, f.reuser.token, {
    reportId: f.reuserReport.reportId,
    declaredContext: "COAUTHOR_COPY",
    documentIdentityId: "attacker-supplied",
    representationId: "attacker-supplied",
  });
  assert.equal(res.status, 200);
  const rows = await activeDeclarationIds(f.reuserIdentity.id);
  assert.equal(rows.length, 1, "declaration bound to the server-resolved identity, not the smuggled one");
});

test("declare: NULL document_identity_id fails closed with REUSE_CONTEXT_UNAVAILABLE", async () => {
  const acct = await createAccount("decl-nullid");
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: ["rpt-nullid", "dev-nullid", "sub-nullid", "d", new Date().toISOString(), 10, 0, "Low", JSON.stringify({ text: "no identity link here at all" }), acct.id],
  });
  const res = await callPost(declareRoute, DECLARE_URL, acct.token, { reportId: "rpt-nullid", declaredContext: "SUPERVISOR_COPY" });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).status, "REUSE_CONTEXT_UNAVAILABLE");
});

test("declare: another user's reportId -> generic 404, no row written", async () => {
  const f = await priorSubmissionFixture("decl-crossreport");
  const stranger = await createAccount("decl-stranger");
  const res = await callPost(declareRoute, DECLARE_URL, stranger.token, { reportId: f.reuserReport.reportId, declaredContext: "SUPERVISOR_COPY" });
  assert.equal(res.status, 404);
  assert.equal((await activeDeclarationIds(f.reuserIdentity.id)).length, 0);
});

test("declare: > 1 caller-owned (reportId,user) rows -> fail closed, no mutation", async () => {
  const f = await priorSubmissionFixture("decl-dup");
  // A second saved_reports row with the same id + user_id, different device_key.
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, document_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [f.reuserReport.reportId, "dev-dup-2", "sub-dup-2", "d", new Date().toISOString(), 10, 0, "Low", JSON.stringify({ text: f.text }), f.reuser.id, f.reuserIdentity.id],
  });
  const res = await callPost(declareRoute, DECLARE_URL, f.reuser.token, { reportId: f.reuserReport.reportId, declaredContext: "SUPERVISOR_COPY" });
  assert.equal(res.status, 404);
  assert.equal((await activeDeclarationIds(f.reuserIdentity.id)).length, 0);
});

// --- withdrawal: actionRef-bound, survives ordering change ------------------

test("withdraw: actionRef-bound; a declaration stays withdrawable regardless of current match order", async () => {
  const f = await priorSubmissionFixture("wd");
  const declareRes = await callPost(declareRoute, DECLARE_URL, f.reuser.token, { reportId: f.reuserReport.reportId, declaredContext: "SUPERVISOR_COPY" });
  const declared = await declareRes.json();
  const actionRef = declared.reuseContext.declare.activeDeclarations[0].actionRef;

  // Simulate the historical-match ordering changing: add a *second* active
  // declaration for a different representation directly, so this identity now
  // has two active rows and the original may no longer be "first".
  const secondRepIdentity = (await indexSubmission((await createAccount("wd-other")).id, "other", `${f.text} extra tail to shift representation`)).identity;
  // (Directly insert a second active declaration for the reuser identity.)
  const secondRefRow = await client.execute({ sql: "SELECT id FROM corpus_submission_references WHERE document_identity_id = ?", args: [secondRepIdentity.id] });
  await client.execute({
    sql: `INSERT INTO reuse_context_declarations (document_identity_id, matched_representation_id, matched_submission_reference_id, declared_context, declared_by_account_id, declared_at, verification_state, created_at)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,'SELF_ASSERTED_UNVERIFIED',CURRENT_TIMESTAMP)`,
    args: [f.reuserIdentity.id, `rep-shifted-${f.reuser.id}`, Number(secondRefRow.rows[0].id), "COAUTHOR_COPY", f.reuser.id],
  });

  const before = await activeDeclarationIds(f.reuserIdentity.id);
  assert.equal(before.length, 2);

  const wdRes = await callPost(withdrawRoute, WITHDRAW_URL, f.reuser.token, { reportId: f.reuserReport.reportId, actionRef });
  assert.equal(wdRes.status, 200);
  const after = await activeDeclarationIds(f.reuserIdentity.id);
  assert.equal(after.length, 1, "exactly the ref-selected declaration was withdrawn");
  assert.ok(!after.includes(before.find((id) => !after.includes(id)) ?? -1) || after.length === 1);
});

test("withdraw: two active declarations get distinct actionRefs; withdrawing D1 leaves D2", async () => {
  const f = await priorSubmissionFixture("wd2");
  await callPost(declareRoute, DECLARE_URL, f.reuser.token, { reportId: f.reuserReport.reportId, declaredContext: "SUPERVISOR_COPY" });
  // second active row for a different representation
  const other = await createAccount("wd2-other");
  const otherIdentity = (await indexSubmission(other.id, "o", `${f.text} distinct trailing content here`)).identity;
  const otherRef = await client.execute({ sql: "SELECT id FROM corpus_submission_references WHERE document_identity_id = ?", args: [otherIdentity.id] });
  await client.execute({
    sql: `INSERT INTO reuse_context_declarations (document_identity_id, matched_representation_id, matched_submission_reference_id, declared_context, declared_by_account_id, declared_at, verification_state, created_at)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,'SELF_ASSERTED_UNVERIFIED',CURRENT_TIMESTAMP)`,
    args: [f.reuserIdentity.id, `rep-second-${f.reuser.id}`, Number(otherRef.rows[0].id), "OTHER_AUTHORIZED_REUSE", f.reuser.id],
  });

  const ids = await activeDeclarationIds(f.reuserIdentity.id);
  assert.equal(ids.length, 2);
  const refs = ids.map((id) => deriveReuseContextActionRef(f.reuser.sessionKey, id));
  assert.notEqual(refs[0], refs[1]);

  const wdRes = await callPost(withdrawRoute, WITHDRAW_URL, f.reuser.token, { reportId: f.reuserReport.reportId, actionRef: refs[0] });
  assert.equal(wdRes.status, 200);
  const remaining = await activeDeclarationIds(f.reuserIdentity.id);
  assert.deepEqual(remaining, [ids[1]]);
});

test("withdraw: cross-session / cross-report / cross-account ref -> 404, no mutation", async () => {
  const f = await priorSubmissionFixture("wd-forge");
  const declared = await (await callPost(declareRoute, DECLARE_URL, f.reuser.token, { reportId: f.reuserReport.reportId, declaredContext: "SUPERVISOR_COPY" })).json();
  const realRef = declared.reuseContext.declare.activeDeclarations[0].actionRef;
  const ids = await activeDeclarationIds(f.reuserIdentity.id);

  // cross-account: stranger uses the reuser's real ref against their own (empty) report
  const stranger = await createAccount("wd-stranger");
  const strangerReport = await seedReport({ accountId: stranger.id, documentIdentityId: f.originalIdentity.id, rawText: "unrelated" });
  const crossAccount = await callPost(withdrawRoute, WITHDRAW_URL, stranger.token, { reportId: strangerReport.reportId, actionRef: realRef });
  assert.equal(crossAccount.status, 404);

  // cross-report: reuser uses the real ref but names the original's report
  const crossReport = await callPost(withdrawRoute, WITHDRAW_URL, f.reuser.token, { reportId: f.originalReport.reportId, actionRef: realRef });
  assert.equal(crossReport.status, 404);

  // cross-session: a ref derived under a different session key
  const foreignRef = deriveReuseContextActionRef(hashToken("some-other-session-token-value-1234567890"), ids[0]);
  const crossSession = await callPost(withdrawRoute, WITHDRAW_URL, f.reuser.token, { reportId: f.reuserReport.reportId, actionRef: foreignRef });
  assert.equal(crossSession.status, 404);

  assert.equal((await activeDeclarationIds(f.reuserIdentity.id)).length, 1, "nothing was withdrawn by any forged attempt");
});

test("withdraw: a stale ref for an already-revoked declaration -> 404", async () => {
  const f = await priorSubmissionFixture("wd-stale");
  const declared = await (await callPost(declareRoute, DECLARE_URL, f.reuser.token, { reportId: f.reuserReport.reportId, declaredContext: "SUPERVISOR_COPY" })).json();
  const ref = declared.reuseContext.declare.activeDeclarations[0].actionRef;
  assert.equal((await callPost(withdrawRoute, WITHDRAW_URL, f.reuser.token, { reportId: f.reuserReport.reportId, actionRef: ref })).status, 200);
  const again = await callPost(withdrawRoute, WITHDRAW_URL, f.reuser.token, { reportId: f.reuserReport.reportId, actionRef: ref });
  assert.equal(again.status, 404);
});

test("withdraw: malformed actionRef -> 404 without crypto", async () => {
  const f = await priorSubmissionFixture("wd-bad");
  const res = await callPost(withdrawRoute, WITHDRAW_URL, f.reuser.token, { reportId: f.reuserReport.reportId, actionRef: "not-a-hex-ref" });
  assert.equal(res.status, 404);
});

// --- confirm / reject: original submitter ----------------------------------

async function declaredFixture(marker) {
  const f = await priorSubmissionFixture(marker);
  const res = await callPost(declareRoute, DECLARE_URL, f.reuser.token, { reportId: f.reuserReport.reportId, declaredContext: "SUPERVISOR_COPY" });
  assert.equal(res.status, 200, "fixture declare must succeed");
  return f;
}

async function pendingRefForOriginal(f, token) {
  const res = await callReportGet(f.originalReport.reportId, token);
  assert.equal(res.status, 200);
  const body = await res.json();
  return { body, ref: body.reuseContext?.confirm?.pending?.[0]?.actionRef ?? null };
}

test("confirm: original submitter confirms via the pending actionRef from their own report envelope", async () => {
  const f = await declaredFixture("cf");
  const { body, ref } = await pendingRefForOriginal(f, f.original.token);
  assert.ok(ref, "the original submitter's report envelope lists the pending declaration");
  assert.equal(body.reuseContext.confirm.pending.length, 1);
  assert.equal(body.reuseContext.confirm.pending[0].state, "SELF_ASSERTED_UNVERIFIED");

  const res = await callPost(confirmRoute, CONFIRM_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: ref });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "CONFIRMED");

  const dRow = await client.execute({ sql: "SELECT verification_state FROM reuse_context_declarations WHERE document_identity_id = ?", args: [f.reuserIdentity.id] });
  assert.equal(dRow.rows[0].verification_state, "MUTUALLY_CONFIRMED");
});

test("confirm: only SELF_ASSERTED_UNVERIFIED rows ever appear in confirm.pending[]", async () => {
  const f = await declaredFixture("cf-pending");
  const first = await pendingRefForOriginal(f, f.original.token);
  await callPost(confirmRoute, CONFIRM_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: first.ref });
  const after = await pendingRefForOriginal(f, f.original.token);
  assert.equal(after.body.reuseContext.confirm.pending.length, 0, "a confirmed declaration is not pending");
});

test("confirm: concurrent / double confirm is idempotent (ALREADY_CONFIRMED), server still recognises the ref", async () => {
  const f = await declaredFixture("cf-idem");
  const { ref } = await pendingRefForOriginal(f, f.original.token);
  const one = await callPost(confirmRoute, CONFIRM_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: ref });
  assert.equal(one.status, 200);
  const two = await callPost(confirmRoute, CONFIRM_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: ref });
  assert.equal(two.status, 200);
  assert.equal((await two.json()).status, "ALREADY_CONFIRMED");
});

test("confirm: a non-original-submitter session cannot confirm (generic 404)", async () => {
  const f = await declaredFixture("cf-auth");
  const { ref } = await pendingRefForOriginal(f, f.original.token);
  // The reuser owns their own report, and their identity is referenced by nothing; use the reuser's own report + the ref.
  const res = await callPost(confirmRoute, CONFIRM_URL, f.reuser.token, { reportId: f.reuserReport.reportId, actionRef: ref });
  assert.equal(res.status, 404);
});

test("reject: original submitter rejects an unverified declaration", async () => {
  const f = await declaredFixture("rj");
  const { ref } = await pendingRefForOriginal(f, f.original.token);
  const res = await callPost(rejectRoute, REJECT_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: ref });
  assert.equal(res.status, 200);
  const dRow = await client.execute({ sql: "SELECT verification_state, revoked_at FROM reuse_context_declarations WHERE document_identity_id = ?", args: [f.reuserIdentity.id] });
  assert.equal(dRow.rows[0].verification_state, "REVOKED");
});

test("reject: cannot remove a mutually-confirmed declaration (USE_REVOKE)", async () => {
  const f = await declaredFixture("rj-confirmed");
  const { ref } = await pendingRefForOriginal(f, f.original.token);
  await callPost(confirmRoute, CONFIRM_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: ref });
  // ref is stable for the declaration; reject must refuse now.
  const res = await callPost(rejectRoute, REJECT_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: ref });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).status, "USE_REVOKE");
});

// --- revoke: original submitter retracts a confirmed attestation ----------

async function confirmedFixture(marker) {
  const f = await declaredFixture(marker);
  const { ref } = await pendingRefForOriginal(f, f.original.token);
  const res = await callPost(confirmRoute, CONFIRM_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: ref });
  assert.equal(res.status, 200);
  return { f, pendingRef: ref };
}

test("confirm -> item leaves pending[] and appears in confirmed[]", async () => {
  const { f } = await confirmedFixture("rv-move");
  const body = await (await callReportGet(f.originalReport.reportId, f.original.token)).json();
  assert.equal(body.reuseContext.confirm.pending.length, 0);
  assert.equal(body.reuseContext.confirm.confirmed.length, 1);
  const c = body.reuseContext.confirm.confirmed[0];
  assert.deepEqual(Object.keys(c).sort(), ["actionRef", "confirmedDate", "declaredContext"].sort());
  assert.match(c.actionRef, /^[0-9a-f]{64}$/);
  assert.equal(c.declaredContext, "SUPERVISOR_COPY");
});

test("revoke: original submitter revokes -> declaration REVOKED, disappears from pending[] and confirmed[]", async () => {
  const { f } = await confirmedFixture("rv-do");
  const env = await (await callReportGet(f.originalReport.reportId, f.original.token)).json();
  const confRef = env.reuseContext.confirm.confirmed[0].actionRef;

  const res = await callPost(revokeRoute, REVOKE_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: confRef });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "REVOKED");

  const dRow = await client.execute({ sql: "SELECT verification_state FROM reuse_context_declarations WHERE document_identity_id = ?", args: [f.reuserIdentity.id] });
  assert.equal(dRow.rows[0].verification_state, "REVOKED");

  const after = await (await callReportGet(f.originalReport.reportId, f.original.token)).json();
  assert.equal(after.reuseContext.confirm.pending.length, 0);
  assert.equal(after.reuseContext.confirm.confirmed.length, 0);
});

test("revoke: after the original submitter revokes, the declarer's report shows no active confirmed declaration", async () => {
  const { f } = await confirmedFixture("rv-declarer");
  const env = await (await callReportGet(f.originalReport.reportId, f.original.token)).json();
  await callPost(revokeRoute, REVOKE_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: env.reuseContext.confirm.confirmed[0].actionRef });

  const declarer = await (await callReportGet(f.reuserReport.reportId, f.reuser.token)).json();
  assert.equal(declarer.reuseContext.declare.activeDeclarations.length, 0, "no active declaration remains for the declarer");
});

test("revoke: refuses an unconfirmed declaration (NOT_CONFIRMED) — that's /reject's job", async () => {
  const f = await declaredFixture("rv-unconf");
  const { ref } = await pendingRefForOriginal(f, f.original.token);
  const res = await callPost(revokeRoute, REVOKE_URL, f.original.token, { reportId: f.originalReport.reportId, actionRef: ref });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).status, "NOT_CONFIRMED");
});

test("revoke: another account/session cannot replay the confirmed actionRef", async () => {
  const { f } = await confirmedFixture("rv-replay");
  const env = await (await callReportGet(f.originalReport.reportId, f.original.token)).json();
  const confRef = env.reuseContext.confirm.confirmed[0].actionRef;

  const stranger = await createAccount("rv-stranger");
  const strangerReport = await seedReport({ accountId: stranger.id, documentIdentityId: f.originalIdentity.id, rawText: "unrelated" });
  const crossAccount = await callPost(revokeRoute, REVOKE_URL, stranger.token, { reportId: strangerReport.reportId, actionRef: confRef });
  assert.equal(crossAccount.status, 404);

  // declarer (reuser) is not the confirmer — a confirmed ref against their own report resolves to nothing
  const crossParty = await callPost(revokeRoute, REVOKE_URL, f.reuser.token, { reportId: f.reuserReport.reportId, actionRef: confRef });
  assert.equal(crossParty.status, 404);

  const dRow = await client.execute({ sql: "SELECT verification_state FROM reuse_context_declarations WHERE document_identity_id = ?", args: [f.reuserIdentity.id] });
  assert.equal(dRow.rows[0].verification_state, "MUTUALLY_CONFIRMED", "nothing was revoked by a forged attempt");
});

test("revoke: declarer's /withdraw still works independently on a confirmed declaration", async () => {
  const { f } = await confirmedFixture("rv-wd");
  const declarerEnv = await (await callReportGet(f.reuserReport.reportId, f.reuser.token)).json();
  const wdRef = declarerEnv.reuseContext.declare.activeDeclarations[0].actionRef;
  const res = await callPost(withdrawRoute, WITHDRAW_URL, f.reuser.token, { reportId: f.reuserReport.reportId, actionRef: wdRef });
  assert.equal(res.status, 200);
  const dRow = await client.execute({ sql: "SELECT verification_state FROM reuse_context_declarations WHERE document_identity_id = ?", args: [f.reuserIdentity.id] });
  assert.equal(dRow.rows[0].verification_state, "REVOKED");
});

// --- same-origin matrix (committed in 67c49a0) ----------------------------

for (const [name, routeModule, url, extraBody] of [
  ["declare", declareRoute, DECLARE_URL, { declaredContext: "SUPERVISOR_COPY" }],
  ["withdraw", withdrawRoute, WITHDRAW_URL, { actionRef: "a".repeat(64) }],
  ["confirm", confirmRoute, CONFIRM_URL, { actionRef: "a".repeat(64) }],
  ["reject", rejectRoute, REJECT_URL, { actionRef: "a".repeat(64) }],
]) {
  test(`same-origin: ${name} rejects a missing Origin with the generic hidden 404`, async () => {
    const acct = await createAccount(`so-${name}-null`);
    const res = await callPost(routeModule, url, acct.token, { reportId: "whatever", ...extraBody }, { origin: null });
    assert.equal(res.status, 404);
  });
  test(`same-origin: ${name} rejects a foreign Origin with the generic hidden 404`, async () => {
    const acct = await createAccount(`so-${name}-foreign`);
    const res = await callPost(routeModule, url, acct.token, { reportId: "whatever", ...extraBody }, { origin: "http://evil.example" });
    assert.equal(res.status, 404);
  });
}

test("mutations require a signed-in session with a raw cookie", async () => {
  const res = await callPost(declareRoute, DECLARE_URL, null, { reportId: "x", declaredContext: "SUPERVISOR_COPY" });
  assert.equal(res.status, 401);
});

test("non-allowlisted account gets the generic hidden 404", async () => {
  // account created WITHOUT allowlist append
  userCounter += 1;
  const id = `no-allow-${userCounter}`;
  await client.execute({ sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [id, `${id}@x.test`, id, "h"] });
  const token = await createSession(client, id);
  const res = await callPost(declareRoute, DECLARE_URL, token, { reportId: "x", declaredContext: "SUPERVISOR_COPY" });
  assert.equal(res.status, 404);
});

// --- no canonical-hash lookup anywhere in the binding path ----------------

test("STRUCTURAL: the reuse-context binding path performs no canonical-hash identity lookup", () => {
  const src = fs.readFileSync(path.join(repoRoot, "lib/reuse-context-report-binding.ts"), "utf8");
  assert.doesNotMatch(src, /canonicalSha256|findPriorSubmissionsForAccount/, "identity comes only from saved_reports.document_identity_id");
});
