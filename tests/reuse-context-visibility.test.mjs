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
import { isE8sReuseContextAllowlisted } from "../lib/e8s-visibility.ts";
import * as declareRoute from "../app/api/reuse-context/declare/route.ts";
import * as withdrawRoute from "../app/api/reuse-context/withdraw/route.ts";
import * as revokeRoute from "../app/api/reuse-context/revoke/route.ts";
import * as confirmRoute from "../app/api/reuse-context/confirm/route.ts";
import * as rejectRoute from "../app/api/reuse-context/reject/route.ts";
import * as reportRoute from "../app/api/reports/[id]/route.ts";

/**
 * Default-off E8S_REUSE_CONTEXT_ALLOWLIST gate (lib/e8s-visibility.ts) in
 * front of the four reuse-context mutation routes and the reuseContext
 * envelope on GET /api/reports/[id]. Disposable local SQLite.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_reuse_context_visibility.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const c = `${dbFile}${suffix}`;
  if (fs.existsSync(c)) fs.unlinkSync(c);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  for (const suffix of ["", "-wal", "-shm"]) {
    const c = `${dbFile}${suffix}`;
    try { fs.unlinkSync(c); } catch { /* ignore */ }
  }
});

let n = 0;
async function createAccount(prefix) {
  n += 1;
  const id = `${prefix}-${n}`;
  await client.execute({ sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [id, `${id}@v.test`, id, "h"] });
  return { id, token: await createSession(client, id) };
}
async function indexSub(accountId, rawText) {
  const identity = await createDocumentIdentity(client, { accountId, title: "d", author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return identity;
}
async function seed(accountId, documentIdentityId, rawText) {
  n += 1;
  const reportId = `v-${n}`;
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, document_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, `d-${n}`, `s-${n}`, "d", new Date().toISOString(), 20, 0, "Low", JSON.stringify({ text: rawText }), accountId, documentIdentityId],
  });
  return reportId;
}
let ip = 0;
async function post(mod, url, token, body) {
  ip += 1; const ipv = `v-${ip}`; await resetRateForTest(ipv);
  const headers = { "content-type": "application/json", "x-forwarded-for": ipv, origin: "http://localhost", host: "localhost" };
  if (token) headers.cookie = `tp_session_v1=${token}`;
  return mod.POST(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
}
async function reportGet(reportId, token) {
  ip += 1; const ipv = `v-${ip}`; await resetRateForTest(ipv);
  const headers = { "x-forwarded-for": ipv };
  if (token) headers.cookie = `tp_session_v1=${token}`;
  return reportRoute.GET(new Request(`http://localhost/api/reports/${reportId}`, { headers }), { params: Promise.resolve({ id: reportId }) });
}

const D_URL = "http://localhost/api/reuse-context/declare";
const MUTATIONS = [
  ["declare", declareRoute, D_URL, { declaredContext: "SUPERVISOR_COPY" }],
  ["withdraw", withdrawRoute, "http://localhost/api/reuse-context/withdraw", { actionRef: "a".repeat(64) }],
  ["revoke", revokeRoute, "http://localhost/api/reuse-context/revoke", { actionRef: "a".repeat(64) }],
  ["confirm", confirmRoute, "http://localhost/api/reuse-context/confirm", { actionRef: "a".repeat(64) }],
  ["reject", rejectRoute, "http://localhost/api/reuse-context/reject", { actionRef: "a".repeat(64) }],
];

// --- pure unit ----------------------------------------------------------

test("isE8sReuseContextAllowlisted: unset / empty / whitespace / null / '' all fail closed", () => {
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  assert.equal(isE8sReuseContextAllowlisted("acct"), false);
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = "";
  assert.equal(isE8sReuseContextAllowlisted("acct"), false);
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = "   ";
  assert.equal(isE8sReuseContextAllowlisted("acct"), false);
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = ",,,";
  assert.equal(isE8sReuseContextAllowlisted(""), false);
  assert.equal(isE8sReuseContextAllowlisted(null), false);
});

test("isE8sReuseContextAllowlisted: exact Set membership only, trimmed; no substring/prefix match", () => {
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = "  acct-1  , acct-2 ";
  assert.equal(isE8sReuseContextAllowlisted("acct-1"), true);
  assert.equal(isE8sReuseContextAllowlisted("acct-2"), true);
  assert.equal(isE8sReuseContextAllowlisted("acct-11"), false);
  assert.equal(isE8sReuseContextAllowlisted("acct"), false);
});

test("isE8sReuseContextAllowlisted: read fresh from process.env every call (no module caching)", () => {
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  assert.equal(isE8sReuseContextAllowlisted("z"), false);
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = "z";
  assert.equal(isE8sReuseContextAllowlisted("z"), true);
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  assert.equal(isE8sReuseContextAllowlisted("z"), false);
});

// --- mutation route gate ---------------------------------------------

for (const [name, mod, url, extra] of MUTATIONS) {
  test(`gate: ${name} returns the generic hidden 404 for a non-allowlisted session`, async () => {
    delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
    const acct = await createAccount(`gate-${name}`);
    const res = await post(mod, url, acct.token, { reportId: "irrelevant", ...extra });
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(await res.json()), ["error"]);
  });
}

test("gate: session auth is preserved — no cookie still 401, never 404 substituted by the allowlist", async () => {
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = "anyone";
  const res = await post(declareRoute, D_URL, null, { reportId: "x", declaredContext: "SUPERVISOR_COPY" });
  assert.equal(res.status, 401);
});

test("gate: an allowlisted session passes the gate and reaches real route behavior", async () => {
  const original = await createAccount("gate-ok-orig");
  const reuser = await createAccount("gate-ok-reuse");
  const text = "visibility gate fixture body text canonicalizes into stable shingles here";
  await indexSub(original.id, text);
  const reuserIdentity = await indexSub(reuser.id, text);
  const reportId = await seed(reuser.id, reuserIdentity.id, text);
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = reuser.id;
  const res = await post(declareRoute, D_URL, reuser.token, { reportId, declaredContext: "SUPERVISOR_COPY" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "DECLARED");
});

// --- GET envelope gate ---------------------------------------------

test("GET /api/reports/[id]: reuseContext is absent for a non-allowlisted owner, present once allowlisted", async () => {
  const original = await createAccount("env-gate-orig");
  const reuser = await createAccount("env-gate-reuse");
  const text = "envelope gate fixture body text canonicalizes for the matcher to work";
  await indexSub(original.id, text);
  const reuserIdentity = await indexSub(reuser.id, text);
  const reportId = await seed(reuser.id, reuserIdentity.id, text);

  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  const off = await (await reportGet(reportId, reuser.token)).json();
  assert.equal(off.reuseContext, undefined, "no envelope for a non-allowlisted account");
  assert.ok(off.payload, "the report itself still loads");

  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = reuser.id;
  const on = await (await reportGet(reportId, reuser.token)).json();
  assert.ok(on.reuseContext, "envelope present once allowlisted");
  assert.equal(on.reuseContext.reportId, reportId);
});

// --- structural ---------------------------------------------------

test("STRUCTURAL: lib/e8s-visibility.ts references no scoring identifier and never logs the allowlist", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const src = strip(fs.readFileSync(path.join(repoRoot, "lib/e8s-visibility.ts"), "utf8"));
  assert.doesNotMatch(src, /archiveScore|aiScore|verifiedSimilarity|\.score\b|\bscore\s*[:=]/i);
  assert.doesNotMatch(src, /console\.(log|error|warn|debug)/);
});
