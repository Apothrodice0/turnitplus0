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
import * as declareRoute from "../app/api/reuse-context/declare/route.ts";
import * as confirmRoute from "../app/api/reuse-context/confirm/route.ts";
import * as reportRoute from "../app/api/reports/[id]/route.ts";
import * as reportsRoute from "../app/api/reports/route.ts";

/**
 * Privacy + persistence boundary for the ordinary-user reuse-context flow.
 *
 * The GET /api/reports/[id] envelope and every mutation response must carry
 * NONE of: document_identity_id, representation id, matched submission
 * reference id, declaration primary key, account id, email, source_ref, raw
 * session token, session token hash. `payload` must never contain
 * reuseContext. An actionRef must only ever appear in the sibling
 * reuseContext envelope. A client-added payload.reuseContext must not be
 * persisted.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_reuse_context_privacy.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const c = `${dbFile}${suffix}`;
  if (fs.existsSync(c)) fs.unlinkSync(c);
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
    const c = `${dbFile}${suffix}`;
    try { fs.unlinkSync(c); } catch { /* ignore */ }
  }
});

let n = 0;
async function account(prefix) {
  n += 1;
  const id = `${prefix}-${n}`;
  await client.execute({ sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [id, `${id}@priv.test`, id, "h"] });
  const token = await createSession(client, id);
  const existing = process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = existing ? `${existing},${id}` : id;
  return { id, token };
}
async function indexSub(accountId, rawText) {
  const identity = await createDocumentIdentity(client, { accountId, title: "d", author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return identity;
}
async function seed(accountId, documentIdentityId, rawText) {
  n += 1;
  const reportId = `p-${n}`;
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, document_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, `d-${n}`, `s-${n}`, "d", new Date().toISOString(), 20, 0, "Low", JSON.stringify({ text: rawText }), accountId, documentIdentityId],
  });
  return reportId;
}
let ip = 0;
async function reqPost(mod, url, token, body) {
  ip += 1;
  const ipv = `priv-${ip}`;
  await resetRateForTest(ipv);
  return mod.POST(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ipv, cookie: `tp_session_v1=${token}`, origin: "http://localhost", host: "localhost" },
    body: JSON.stringify(body),
  }));
}
async function reportGet(reportId, token) {
  ip += 1;
  const ipv = `priv-${ip}`;
  await resetRateForTest(ipv);
  return reportRoute.GET(
    new Request(`http://localhost/api/reports/${reportId}`, { headers: { "x-forwarded-for": ipv, cookie: `tp_session_v1=${token}` } }),
    { params: Promise.resolve({ id: reportId }) },
  );
}

function scanForForbidden(json, forbidden) {
  const text = JSON.stringify(json);
  for (const [label, value] of Object.entries(forbidden)) {
    if (value && String(value).length >= 3 && text.includes(String(value))) {
      assert.fail(`response leaked ${label}: ${value}`);
    }
  }
}

const ALLOWED_ACTIVE_KEYS = new Set(["actionRef", "state", "declaredContext", "confirmedDate", "isCurrent"]);
const ALLOWED_PENDING_KEYS = new Set(["actionRef", "state", "declaredContext", "declaredDate"]);
const ALLOWED_CONFIRMED_KEYS = new Set(["actionRef", "declaredContext", "confirmedDate"]);
const ALLOWED_ENVELOPE_KEYS = new Set(["reportId", "declare", "confirm"]);
const ALLOWED_DECLARE_KEYS = new Set(["available", "canDeclare", "unavailableReason", "activeDeclarations"]);

function assertEnvelopeShape(env) {
  for (const k of Object.keys(env)) assert.ok(ALLOWED_ENVELOPE_KEYS.has(k), `unexpected envelope key: ${k}`);
  for (const k of Object.keys(env.declare)) assert.ok(ALLOWED_DECLARE_KEYS.has(k), `unexpected declare key: ${k}`);
  assert.deepEqual(Object.keys(env.confirm).sort(), ["confirmed", "pending"]);
  for (const d of env.declare.activeDeclarations) {
    for (const k of Object.keys(d)) assert.ok(ALLOWED_ACTIVE_KEYS.has(k), `unexpected activeDeclaration key: ${k}`);
    assert.match(d.actionRef, /^[0-9a-f]{64}$/);
  }
  for (const p of env.confirm.pending) {
    for (const k of Object.keys(p)) assert.ok(ALLOWED_PENDING_KEYS.has(k), `unexpected pending key: ${k}`);
    assert.equal(p.state, "SELF_ASSERTED_UNVERIFIED");
    assert.match(p.actionRef, /^[0-9a-f]{64}$/);
  }
  for (const c of env.confirm.confirmed) {
    for (const k of Object.keys(c)) assert.ok(ALLOWED_CONFIRMED_KEYS.has(k), `unexpected confirmed key: ${k}`);
    assert.match(c.actionRef, /^[0-9a-f]{64}$/);
  }
}

test("GET envelope + declare response carry no raw provenance identifiers", async () => {
  const text = "Privacy fixture body, canonicalizes into stable shingles for matching purposes.";
  const original = await account("orig");
  const reuser = await account("reuse");
  const originalIdentity = await indexSub(original.id, text);
  const reuserIdentity = await indexSub(reuser.id, text);
  const reuserReport = await seed(reuser.id, reuserIdentity.id, text);
  const originalReport = await seed(original.id, originalIdentity.id, text);

  const declareRes = await reqPost(declareRoute, "http://localhost/api/reuse-context/declare", reuser.token, { reportId: reuserReport, declaredContext: "SUPERVISOR_COPY" });
  assert.equal(declareRes.status, 200);
  const declareBody = await declareRes.json();

  // the real internal values from the DB
  const refRow = await client.execute({ sql: "SELECT id, matched_submission_reference_id FROM reuse_context_declarations WHERE document_identity_id = ?", args: [reuserIdentity.id] });
  const declarationId = String(refRow.rows[0].id);
  const matchedRefId = String(refRow.rows[0].matched_submission_reference_id);
  const repRow = await client.execute({ sql: "SELECT matched_representation_id FROM reuse_context_declarations WHERE document_identity_id = ?", args: [reuserIdentity.id] });
  const representationId = String(repRow.rows[0].matched_representation_id);

  const forbidden = {
    "document_identity_id (reuser)": reuserIdentity.id,
    "document_identity_id (original)": originalIdentity.id,
    "representation id": representationId,
    "matched submission reference id": matchedRefId,
    "declaration primary key": declarationId,
    "account id (reuser)": reuser.id,
    "account id (original)": original.id,
    "email": `${reuser.id}@priv.test`,
  };

  scanForForbidden(declareBody.reuseContext, forbidden);
  assertEnvelopeShape(declareBody.reuseContext);

  const declarerGet = await reportGet(reuserReport, reuser.token);
  const declarerEnv = await declarerGet.json();
  assert.ok(declarerEnv.reuseContext, "declarer report carries the sibling envelope");
  scanForForbidden(declarerEnv.reuseContext, forbidden);
  assertEnvelopeShape(declarerEnv.reuseContext);

  const originalGet = await reportGet(originalReport, original.token);
  const originalEnv = await originalGet.json();
  scanForForbidden(originalEnv.reuseContext, forbidden);
  assertEnvelopeShape(originalEnv.reuseContext);

  // payload must never carry reuseContext; actionRef only in the sibling
  assert.equal(declarerEnv.payload.reuseContext, undefined, "payload has no reuseContext");
  assert.ok(!JSON.stringify(declarerEnv.payload).includes("actionRef"), "no actionRef anywhere in payload");
  const ref = declarerEnv.reuseContext.declare.activeDeclarations[0].actionRef;
  assert.match(ref, /^[0-9a-f]{64}$/);

  // ...and after confirmation, the confirmed[] state stays id-free too
  const pendingRef = originalEnv.reuseContext.confirm.pending[0].actionRef;
  await reqPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { reportId: originalReport, actionRef: pendingRef });
  const confirmedEnv = await (await reportGet(originalReport, original.token)).json();
  scanForForbidden(confirmedEnv.reuseContext, forbidden);
  assertEnvelopeShape(confirmedEnv.reuseContext);
  assert.equal(confirmedEnv.reuseContext.confirm.confirmed.length, 1);
});

test("GET /api/reports/[id] is Cache-Control: no-store and force-dynamic", async () => {
  const acct = await account("cache");
  const identity = await indexSub(acct.id, "Cache header fixture body text for the matcher to canonicalize.");
  const reportId = await seed(acct.id, identity.id, "Cache header fixture body text for the matcher to canonicalize.");
  const res = await reportGet(reportId, acct.token);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const src = fs.readFileSync(path.join(repoRoot, "app/api/reports/[id]/route.ts"), "utf8");
  assert.match(src, /export const dynamic = 'force-dynamic'/);
});

test("persistence boundary: a client-added payload.reuseContext is not persisted", async () => {
  const acct = await account("persist");
  ip += 1;
  const ipv = `priv-${ip}`;
  await resetRateForTest(ipv);
  const reportId = `persist-${n}`;
  const malicious = {
    version: 11, id: 1, submissionId: "s", title: "t", author: "", assignment: "", created: new Date().toISOString(),
    score: 0, wordCount: 10, characterCount: 50, pageCount: 1, fileSize: "1 KB", scoreBand: "Low",
    text: "persist boundary body", sources: [], repeats: [],
    reuseContext: { reportId, declare: { available: true, canDeclare: false, activeDeclarations: [{ actionRef: "deadbeef".repeat(8), state: "MUTUALLY_CONFIRMED", declaredContext: "SUPERVISOR_COPY", isCurrent: true }] }, confirm: { pending: [] } },
  };
  const res = await reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ipv, cookie: `tp_session_v1=${acct.token}`, origin: "http://localhost", host: "localhost" },
    body: JSON.stringify({
      deviceKey: `pd-${n}`, id: reportId, submissionId: "s", title: "t", createdAt: new Date().toISOString(),
      wordCount: 10, archiveScore: 0, scoreBand: "Low", room: 0, payload: malicious,
    }),
  }));
  assert.ok(res.status === 200 || res.status === 201, `save should succeed (got ${res.status})`);

  const row = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE id = ?", args: [reportId] });
  assert.equal(row.rows.length, 1);
  const stored = JSON.parse(String(row.rows[0].payload_json));
  assert.equal(stored.reuseContext, undefined, "reuseContext stripped before persistence");
  assert.ok(!String(row.rows[0].payload_json).includes("actionRef"), "no actionRef persisted");
  assert.equal(stored.text, "persist boundary body", "the rest of the payload is stored unchanged");
});

test("STRUCTURAL: fetchRemoteReport returns only data.payload; SimilarityReport has no reuseContext field", () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const remote = fs.readFileSync(path.join(repoRoot, "lib/reports-remote.ts"), "utf8");
  const fn = stripComments(remote.slice(remote.indexOf("export async function fetchRemoteReport"), remote.indexOf("export async function fetchReportReuseContext")));
  assert.match(fn, /data\.payload/);
  assert.doesNotMatch(fn, /data\.reuseContext/);
  const types = fs.readFileSync(path.join(repoRoot, "lib/report-types.ts"), "utf8");
  const st = types.slice(types.indexOf("export type SimilarityReport"), types.indexOf("export type SimilarityReport") + 3000);
  assert.doesNotMatch(st, /^\s*reuseContext\??:/m, "SimilarityReport must not declare a reuseContext field");
});

test("STRUCTURAL: report-detail-shell holds reuseContext in separate state, never spread into report", () => {
  const shell = fs.readFileSync(path.join(repoRoot, "app/reports/[id]/report-detail-shell.tsx"), "utf8");
  assert.match(shell, /useState<ReuseContextEnvelope \| null>/);
  assert.doesNotMatch(shell, /\.\.\.reuseContext/, "reuseContext must never be spread into the report object");
  assert.doesNotMatch(shell, /storeReport\w*\([^)]*reuseContext|saveReport\w*\([^)]*reuseContext/, "reuseContext must never be passed to a store/save call");
});
