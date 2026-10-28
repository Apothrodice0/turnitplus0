import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { resetAuthRateForTest } from "../lib/rate-limit.js";
import { withTestIdentity } from "./helpers/test-signup.mjs";

// Owner-only English System 2 research preview: server-side gate, report ownership, consent, local refusals, the
// server-to-server inference call (against a local stub backend) and the source wiring of the two report pages.
// The real model is never involved here (see tests/system2-research-parity.test.mjs for the opt-in parity check).

const repo = path.resolve(".");
const dbFile = path.join(repo, "test_system2_research.db");
for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(`${dbFile}${suffix}`)) fs.unlinkSync(`${dbFile}${suffix}`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const setup = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setup, path.join(repo, "drizzle"));
setup.close();

const S2 = await import("../lib/system2-research.ts");
const route = await import("../app/api/reports/[id]/system2/route.ts");
const signupRoute = await import("../app/api/auth/signup/route.ts");

const KEY = "k".repeat(40);
const OWNER = "s2-owner@example.test";
const OTHER = "s2-other@example.test";

// ---- local stub inference backend (records every call)
const calls = [];
let backendMode = "ok";
const backend = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    calls.push({ auth: req.headers.authorization, ext: req.headers["x-file-extension"], bypass: req.headers["x-vercel-protection-bypass"] ?? null, bytes: Buffer.concat(chunks).length });
    if (backendMode === "fail") { res.writeHead(500); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service_id: "stub", label: "RESEARCH-ONLY", state: "CONSERVATIVE_WITHIN_RANGE", estimate_shown: true, research_only: true, conservative_estimate_percent: 8, final_text: "Conservative System 2 research estimate: about 8%.", warnings: ["English-only test."], diagnostics: { delta_pp: 4.5 }, internal_secret_field: "must-not-pass" }));
  });
});
await new Promise((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${backend.address().port}/api/analyze`;

function configureEnv(overrides = {}) {
  Object.assign(process.env, { S2_RESEARCH_ENABLED: "1", S2_RESEARCH_OWNER_EMAILS: `Other.Person@example.test, ${OWNER.toUpperCase()}`, S2_INFERENCE_URL: backendUrl, S2_INFERENCE_KEY: KEY, VERCEL_ENV: "preview" });
  delete process.env.S2_INFERENCE_BYPASS;
  for (const [k, v] of Object.entries(overrides)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

let signupCounter = 0;
async function signup(email) {
  signupCounter += 1;
  const tag = `s2-research-signup-${signupCounter}`;
  await resetAuthRateForTest(tag);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag },
    body: JSON.stringify(withTestIdentity({ email, password: "s2-research-fixture-pw", username: `s2research${signupCounter}`, deviceKey: `s2-device-${signupCounter}` })),
  }));
  const cookie = res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/)?.[1];
  assert.ok(cookie, `signup must succeed for ${email}`);
  const client = createClient({ url: `file:${dbFile}` });
  const userId = (await client.execute({ sql: "SELECT id FROM users WHERE lower(email) = lower(?)", args: [email] })).rows[0].id;
  client.close();
  return { cookie, userId };
}
async function insertReport(id, userId) {
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute({
    sql: "INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [id, `dev-${id}`, `sub-${id}`, "Synthetic report", new Date().toISOString(), 500, 3, "low", "{}", userId],
  });
  client.close();
}

const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]); // zip magic + filler (the stub never parses it)
function call(id, { cookie, consent = true, ext = ".docx", body = DOCX_BYTES, contentLength } = {}) {
  const headers = { "x-file-extension": ext, "content-type": "application/octet-stream" };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  if (consent) headers["x-s2-consent"] = "granted";
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return route.POST(new Request(`http://localhost/api/reports/${id}/system2`, { method: "POST", headers, body }), { params: Promise.resolve({ id }) });
}

configureEnv();
const owner = await signup(OWNER);
const other = await signup(OTHER);
await insertReport("s2-owner-report", owner.userId);
await insertReport("s2-other-report", other.userId);

test("config: enabled only with flag, owners, https/loopback URL and a >= 32-char key; never in production", () => {
  const base = { S2_RESEARCH_ENABLED: "1", S2_RESEARCH_OWNER_EMAILS: OWNER, S2_INFERENCE_URL: "https://backend.example/api/analyze", S2_INFERENCE_KEY: KEY, VERCEL_ENV: "preview" };
  assert.equal(S2.system2Config(base).enabled, true);
  assert.equal(S2.system2Config({ ...base, VERCEL_ENV: "production" }).enabled, false);
  assert.equal(S2.system2Config({ ...base, S2_RESEARCH_ENABLED: "true" }).enabled, false);
  assert.equal(S2.system2Config({ ...base, S2_RESEARCH_OWNER_EMAILS: "" }).enabled, false);
  assert.equal(S2.system2Config({ ...base, S2_INFERENCE_KEY: "short" }).enabled, false);
  assert.equal(S2.system2Config({ ...base, S2_INFERENCE_URL: "http://backend.example/api/analyze" }).enabled, false, "plain http only on loopback");
  assert.equal(S2.isSystem2ResearchUser({ email: " S2-Owner@Example.Test " }, S2.system2Config(base)), true);
  assert.equal(S2.isSystem2ResearchUser({ email: OTHER }, S2.system2Config(base)), false);
  assert.equal(S2.isSystem2ResearchUser(null, S2.system2Config(base)), false);
});

test("result sanitizing: whitelisted fields only, estimate must be an integer 0-20", () => {
  const ok = S2.sanitizeSystem2Result({ state: "CONSERVATIVE_WITHIN_RANGE", estimate_shown: true, conservative_estimate_percent: 8, final_text: "x", service_id: "drop", secret: "drop" });
  assert.deepEqual(Object.keys(ok).sort(), ["conservative_estimate_percent", "estimate_shown", "final_text", "research_only", "state"]);
  assert.equal(S2.sanitizeSystem2Result({ state: "X", estimate_shown: true, conservative_estimate_percent: 21, final_text: "x" }), null);
  assert.equal(S2.sanitizeSystem2Result({ state: "X", estimate_shown: true, conservative_estimate_percent: 7.5, final_text: "x" }), null);
  assert.equal(S2.sanitizeSystem2Result("nope"), null);
});

test("local refusals use the accepted tester wording and never need the backend", () => {
  assert.equal(S2.localSystem2Refusal(".pdf", 10, DOCX_BYTES).state, "REFUSED_PDF");
  assert.equal(S2.localSystem2Refusal(".txt", 10, DOCX_BYTES).final_text, "Unsupported file type '.txt'. This local test accepts English Word (.docx) manuscripts only.");
  assert.equal(S2.localSystem2Refusal(".docx", 10, new Uint8Array([1, 2, 3, 4])).state, "NOT_READABLE");
  assert.equal(S2.localSystem2Refusal(".docx", 4_000_001, DOCX_BYTES).state, "TOO_LARGE");
  assert.equal(S2.localSystem2Refusal(".docx", 10, DOCX_BYTES), null);
});

test("route: every unauthorized path is a plain 404 and never reaches the backend", async () => {
  configureEnv(); calls.length = 0;
  assert.equal((await call("s2-owner-report", {})).status, 404, "no session");
  assert.equal((await call("s2-other-report", { cookie: other.cookie })).status, 404, "signed in but not on the owner allowlist");
  assert.equal((await call("s2-other-report", { cookie: owner.cookie })).status, 404, "owner, but another account's report");
  assert.equal((await call("does-not-exist", { cookie: owner.cookie })).status, 404, "owner, unknown report");
  configureEnv({ S2_RESEARCH_ENABLED: undefined });
  assert.equal((await call("s2-owner-report", { cookie: owner.cookie })).status, 404, "feature switch off");
  configureEnv({ VERCEL_ENV: "production" });
  assert.equal((await call("s2-owner-report", { cookie: owner.cookie })).status, 404, "never in production");
  configureEnv();
  assert.equal((await route.GET()).status, 404, "GET is not served");
  assert.equal(calls.length, 0, "the backend must not have been called");
});

test("route: consent and local refusals stop the request before any transmission", async () => {
  configureEnv(); calls.length = 0;
  const noConsent = await call("s2-owner-report", { cookie: owner.cookie, consent: false });
  assert.equal(noConsent.status, 400); assert.equal((await noConsent.json()).state, "CONSENT_REQUIRED");
  assert.equal((await (await call("s2-owner-report", { cookie: owner.cookie, ext: ".pdf" })).json()).state, "REFUSED_PDF");
  assert.equal((await (await call("s2-owner-report", { cookie: owner.cookie, ext: ".txt" })).json()).state, "UNSUPPORTED_FILE_TYPE");
  assert.equal((await (await call("s2-owner-report", { cookie: owner.cookie, body: new Uint8Array([1, 2, 3, 4, 5]) })).json()).state, "NOT_READABLE");
  const big = await call("s2-owner-report", { cookie: owner.cookie, body: new Uint8Array(10), contentLength: 4_000_001 });
  assert.equal(big.status, 413); assert.equal((await big.json()).state, "TOO_LARGE");
  assert.equal(calls.length, 0, "nothing may be transmitted without consent or for refused inputs");
});

test("route: the owner's own report is estimated server-to-server, with only whitelisted fields returned", async () => {
  configureEnv({ S2_INFERENCE_BYPASS: "bypass-secret-value" }); calls.length = 0; backendMode = "ok";
  const res = await call("s2-owner-report", { cookie: owner.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.state, "CONSERVATIVE_WITHIN_RANGE"); assert.equal(body.conservative_estimate_percent, 8); assert.equal(body.research_only, true);
  assert.equal(body.internal_secret_field, undefined); assert.equal(body.service_id, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, `Bearer ${KEY}`); assert.equal(calls[0].ext, ".docx"); assert.equal(calls[0].bypass, "bypass-secret-value"); assert.equal(calls[0].bytes, DOCX_BYTES.length);
  backendMode = "fail";
  const failed = await call("s2-owner-report", { cookie: owner.cookie });
  assert.equal(failed.status, 502); assert.equal((await failed.json()).state, "UNAVAILABLE");
  backendMode = "ok";
});

test("wiring: both report pages resolve the flag server-side; shells default it off; the panel sends consent", async () => {
  const roomPage = await readFile(new URL("../app/reports/rooms/[room]/page.tsx", import.meta.url), "utf8");
  assert.match(roomPage, /system2Enabled: isSystem2ResearchUser\(sessionUser\)/);
  assert.match(roomPage, /system2Enabled=\{result\.system2Enabled\}/);
  const detailPage = await readFile(new URL("../app/reports/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(detailPage, /system2Enabled: isSystem2ResearchUser\(sessionUser\)/);
  assert.match(detailPage, /system2Enabled=\{result\.status === "found" \? result\.system2Enabled : false\}/);
  const roomShell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  assert.match(roomShell, /system2Enabled = false \}: Props/);
  assert.match(roomShell, /\{system2Enabled && isFullyRevealed\(occupant\) && occupant\.report && \(/);
  const detailShell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(detailShell, /system2Enabled = false,/);
  assert.match(detailShell, /\{system2Enabled && mode !== "ai" && <System2ResearchPanel reportId=\{id\} \/>\}/);
  const panel = await readFile(new URL("../components/report/system2-research-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /"x-s2-consent": "granted"/);
  assert.match(panel, /disabled=\{!file \|\| !consent \|\| running\}/);
  assert.doesNotMatch(panel, /S2_INFERENCE|S2_RESEARCH|process\.env/, "no server configuration in client code");
});

test.after(() => {
  backend.close();
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(`${dbFile}${suffix}`)) try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* still open */ }
});
