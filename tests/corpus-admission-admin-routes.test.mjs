import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createSession, SESSION_COOKIE_NAME } from "../lib/auth-session.ts";
import { resetAdminRateForTest } from "../lib/rate-limit.js";
import * as listRoute from "../app/api/admin/corpus/route.ts";
import * as detailRoute from "../app/api/admin/corpus/[id]/route.ts";
import * as previewRoute from "../app/api/admin/corpus/[id]/preview/route.ts";
import * as deactivateRoute from "../app/api/admin/corpus/[id]/deactivate/route.ts";
import * as reactivateRoute from "../app/api/admin/corpus/[id]/reactivate/route.ts";

/**
 * Behavioral coverage for the 5 admin-only corpus-admission routes, called
 * directly (mirroring tests/corpus-admission-sweep-route.test.mjs's style):
 * authorization (no session / non-admin session / admin session), CSRF/
 * same-origin enforcement on the 3 POST routes, Cache-Control: no-store on
 * every response, pagination-limit enforcement via real HTTP query params,
 * required-reason validation via real HTTP bodies, and the reactivate 409
 * conflict path via real HTTP. Every fixture is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_admin_routes.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await setupClient.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(setupClient, drizzleDir);

test.after(() => {
  setupClient.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `admin-routes-test-${ipCounter}`;
}

let userCounter = 0;
async function ensureUser(role) {
  userCounter += 1;
  const accountId = `admin-routes-account-${role}-${userCounter}`;
  await setupClient.execute({
    sql: "INSERT INTO users (id, email, username, password_hash, role) VALUES (?,?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash", role],
  });
  const token = await createSession(setupClient, accountId);
  return { accountId, token };
}

async function seedAcceptedDecision(canonicalSha256) {
  const decisionId = randomUUID();
  const hash = canonicalSha256 ?? randomUUID();
  await setupClient.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      decisionId, null, `admin-routes-seed-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 3300, "English", 0.95, hash, "v1", null, 90, "v1", "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  await setupClient.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, "retained text for the admin routes test fixture.", "v1", "LICENSED_REUSE"],
  });
  const acceptedRepresentationId = randomUUID();
  await setupClient.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [acceptedRepresentationId, decisionId, hash, 3300, "v1"],
  });
  return { decisionId, acceptedRepresentationId, canonicalSha256: hash };
}

function headersFor({ cookie, origin, host } = {}) {
  const headers = { "x-forwarded-for": nextIp() };
  if (cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
  if (origin !== undefined) headers.origin = origin;
  if (host !== undefined) headers.host = host;
  return headers;
}

async function resetRateFor(headers) {
  await resetAdminRateForTest(headers["x-forwarded-for"]);
}

async function callList(url, opts) {
  const headers = headersFor(opts);
  await resetRateFor(headers);
  return listRoute.GET(new Request(`http://localhost${url}`, { headers }));
}

async function callDetail(id, opts) {
  const headers = headersFor(opts);
  await resetRateFor(headers);
  return detailRoute.GET(new Request(`http://localhost/api/admin/corpus/${encodeURIComponent(id)}`, { headers }), { params: Promise.resolve({ id }) });
}

async function callPreview(id, opts) {
  const headers = headersFor(opts);
  await resetRateFor(headers);
  return previewRoute.POST(new Request(`http://localhost/api/admin/corpus/${encodeURIComponent(id)}/preview`, { method: "POST", headers }), { params: Promise.resolve({ id }) });
}

async function callDeactivate(id, opts, body) {
  const headers = { ...headersFor(opts), "content-type": "application/json" };
  await resetRateFor(headers);
  return deactivateRoute.POST(
    new Request(`http://localhost/api/admin/corpus/${encodeURIComponent(id)}/deactivate`, { method: "POST", headers, body: JSON.stringify(body ?? { reason: "test reason" }) }),
    { params: Promise.resolve({ id }) },
  );
}

async function callReactivate(id, opts, body) {
  const headers = { ...headersFor(opts), "content-type": "application/json" };
  await resetRateFor(headers);
  return reactivateRoute.POST(
    new Request(`http://localhost/api/admin/corpus/${encodeURIComponent(id)}/reactivate`, { method: "POST", headers, body: JSON.stringify(body ?? { reason: "test reason" }) }),
    { params: Promise.resolve({ id }) },
  );
}

const SAME_ORIGIN = { origin: "http://localhost", host: "localhost" };

// --- AUTHORIZATION: no session / non-admin session / admin session --------

test("AUTHORIZATION: GET /api/admin/corpus — no session -> 404, non-admin session -> 404, admin session -> 200", async () => {
  const { decisionId } = await seedAcceptedDecision();
  void decisionId;
  const nonAdmin = await ensureUser("user");
  const admin = await ensureUser("admin");

  const anon = await callList("/api/admin/corpus", {});
  assert.equal(anon.status, 404);

  const asUser = await callList("/api/admin/corpus", { cookie: nonAdmin.token });
  assert.equal(asUser.status, 404);

  const asAdmin = await callList("/api/admin/corpus", { cookie: admin.token });
  assert.equal(asAdmin.status, 200);
  const body = await asAdmin.json();
  assert.ok(Array.isArray(body.rows));
  assert.ok(typeof body.totalCount === "number");
});

test("AUTHORIZATION: GET /api/admin/corpus/[id] — no session -> 404, non-admin session -> 404, admin session -> 200", async () => {
  const { decisionId } = await seedAcceptedDecision();
  const nonAdmin = await ensureUser("user");
  const admin = await ensureUser("admin");

  assert.equal((await callDetail(`decision:${decisionId}`, {})).status, 404);
  assert.equal((await callDetail(`decision:${decisionId}`, { cookie: nonAdmin.token })).status, 404);

  const asAdmin = await callDetail(`decision:${decisionId}`, { cookie: admin.token });
  assert.equal(asAdmin.status, 200);
  const body = await asAdmin.json();
  assert.equal(body.decisionId, decisionId);
  assert.equal(body.hasRetainedText, true);
});

test("AUTHORIZATION: POST .../preview — no session -> 404, non-admin session -> 404, admin session -> 200 and audit-logs", async () => {
  const { decisionId } = await seedAcceptedDecision();
  const nonAdmin = await ensureUser("user");
  const admin = await ensureUser("admin");

  assert.equal((await callPreview(`decision:${decisionId}`, SAME_ORIGIN)).status, 404);
  assert.equal((await callPreview(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: nonAdmin.token })).status, 404);

  const asAdmin = await callPreview(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token });
  assert.equal(asAdmin.status, 200);
  const body = await asAdmin.json();
  assert.ok(typeof body.preview === "string");

  const audit = await setupClient.execute({ sql: "SELECT * FROM corpus_admission_admin_audit_log WHERE decision_id = ? AND action = 'view_retained_text'", args: [decisionId] });
  assert.equal(audit.rows.length, 1);
});

test("AUTHORIZATION: POST .../deactivate and .../reactivate — no session -> 404, non-admin session -> 404, admin session -> 200", async () => {
  const { decisionId } = await seedAcceptedDecision();
  const nonAdmin = await ensureUser("user");
  const admin = await ensureUser("admin");

  assert.equal((await callDeactivate(`decision:${decisionId}`, SAME_ORIGIN)).status, 404);
  assert.equal((await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: nonAdmin.token })).status, 404);

  const asAdmin = await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token });
  assert.equal(asAdmin.status, 200);
  const deactivateBody = await asAdmin.json();
  assert.equal(deactivateBody.outcome, "deactivated");

  assert.equal((await callReactivate(`decision:${decisionId}`, SAME_ORIGIN)).status, 404);
  assert.equal((await callReactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: nonAdmin.token })).status, 404);

  const asAdminReactivate = await callReactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token });
  assert.equal(asAdminReactivate.status, 200);
  assert.equal((await asAdminReactivate.json()).outcome, "reactivated");
});

// --- CSRF / same-origin -----------------------------------------------------

for (const [name, call] of [
  ["preview", callPreview],
  ["deactivate", callDeactivate],
  ["reactivate", callReactivate],
]) {
  test(`CSRF: POST .../${name} — missing Origin header -> 404`, async () => {
    const { decisionId } = await seedAcceptedDecision();
    const admin = await ensureUser("admin");
    const res = await call(`decision:${decisionId}`, { host: "localhost", cookie: admin.token });
    assert.equal(res.status, 404);
  });

  test(`CSRF: POST .../${name} — mismatched Origin -> 404`, async () => {
    const { decisionId } = await seedAcceptedDecision();
    const admin = await ensureUser("admin");
    const res = await call(`decision:${decisionId}`, { origin: "http://evil.example", host: "localhost", cookie: admin.token });
    assert.equal(res.status, 404);
  });

  test(`CSRF: POST .../${name} — matching Origin passes the CSRF check (admin session reaches the action)`, async () => {
    const { decisionId } = await seedAcceptedDecision();
    const admin = await ensureUser("admin");
    const res = await call(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token });
    assert.notEqual(res.status, 404, "a same-origin, admin-authenticated request must not be rejected as CSRF/unauthorized");
  });
}

// --- Cache-Control: no-store on every response, every route ----------------

test("CACHING: every route response carries Cache-Control: no-store, including 404s, 400s, and 200s", async () => {
  const { decisionId } = await seedAcceptedDecision();
  const admin = await ensureUser("admin");

  const responses = [
    await callList("/api/admin/corpus", {}), // 404, no session
    await callList("/api/admin/corpus", { cookie: admin.token }), // 200
    await callDetail(`decision:${decisionId}`, {}), // 404
    await callDetail(`decision:${decisionId}`, { cookie: admin.token }), // 200
    await callPreview(`decision:${decisionId}`, SAME_ORIGIN), // 404 no session
    await callPreview(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }), // 200
    await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "" }), // 400 invalid reason
  ];

  for (const res of responses) {
    assert.equal(res.headers.get("cache-control"), "no-store", `expected no-store on a ${res.status} response`);
  }
});

// --- PAGINATION-LIMIT via real HTTP query params ----------------------------

test("PAGINATION-LIMIT: GET /api/admin/corpus clamps an oversized pageSize and rejects a garbage status filter", async () => {
  const admin = await ensureUser("admin");
  for (let i = 0; i < 3; i += 1) await seedAcceptedDecision();

  const oversized = await callList("/api/admin/corpus?pageSize=999999", { cookie: admin.token });
  assert.equal(oversized.status, 200);
  const oversizedBody = await oversized.json();
  assert.ok(oversizedBody.pageSize <= 100, `pageSize must be clamped, got ${oversizedBody.pageSize}`);

  const badStatus = await callList("/api/admin/corpus?status=not-a-real-status", { cookie: admin.token });
  assert.equal(badStatus.status, 400);

  const tooLongQuery = await callList(`/api/admin/corpus?q=${"x".repeat(501)}`, { cookie: admin.token });
  assert.equal(tooLongQuery.status, 400);
});

// --- reason-required validation via real HTTP bodies ------------------------

test("REASON REQUIRED: deactivate/reactivate reject a missing or too-short reason with 400, and never mutate state", async () => {
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision();
  const admin = await ensureUser("admin");

  const noReason = await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, {});
  assert.equal(noReason.status, 400);

  const shortReason = await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "ok" });
  assert.equal(shortReason.status, 400);

  const row = await setupClient.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [acceptedRepresentationId] });
  assert.equal(row.rows[0].revoked_at, null, "a rejected (invalid-reason) request must never change the fingerprint's active state");

  const audit = await setupClient.execute({ sql: "SELECT * FROM corpus_admission_admin_audit_log WHERE decision_id = ?", args: [decisionId] });
  assert.equal(audit.rows.length, 0, "a rejected (invalid-reason) request must never write an audit row");
});

// --- reactivate conflict (409) via real HTTP --------------------------------

test("CONFLICT: POST .../reactivate returns 409 when a different active fingerprint already holds the same hash", async () => {
  const admin = await ensureUser("admin");
  const sharedHash = randomUUID();
  const original = await seedAcceptedDecision(sharedHash);
  await callDeactivate(`decision:${original.decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "superseded by a newer submission" });

  await seedAcceptedDecision(sharedHash); // the replacement becomes canonical

  const res = await callReactivate(`decision:${original.decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "trying anyway" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.outcome, "conflict");
  assert.ok(typeof body.activeConflictSourceRef === "string");
});

// --- not_found via real HTTP -------------------------------------------------

test("NOT FOUND: deactivate/reactivate on a decision with no accepted fingerprint return 404 with an explanatory error, detail route 404s on an unknown row id", async () => {
  const admin = await ensureUser("admin");
  const bareDecisionId = randomUUID();
  await setupClient.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      bareDecisionId, null, `admin-routes-bare-${randomUUID()}`, "v1", "REJECT", "[]", 0, '["NOT_ENGLISH"]',
      "txt", 500, "French", 0.9, randomUUID(), "v1", null, null, null, null, null, null, null, null, "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });

  const deactivateRes = await callDeactivate(`decision:${bareDecisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "no fingerprint to deactivate" });
  assert.equal(deactivateRes.status, 404);

  const reactivateRes = await callReactivate(`decision:${bareDecisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "no fingerprint to reactivate" });
  assert.equal(reactivateRes.status, 404);

  const detailRes = await callDetail(`decision:${randomUUID()}`, { cookie: admin.token });
  assert.equal(detailRes.status, 404);
});
