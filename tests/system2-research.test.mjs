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
import { minimalDocx, reportTextOf } from "./helpers/minimal-docx.mjs";

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
    calls.push({ auth: req.headers.authorization, ext: req.headers["x-file-extension"], bypass: req.headers["x-vercel-protection-bypass"] ?? null, oidc: req.headers["x-vercel-trusted-oidc-idp-token"] ?? null, bytes: Buffer.concat(chunks).length });
    if (backendMode === "fail") { res.writeHead(500); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service_id: "stub", label: "RESEARCH-ONLY", state: "CONSERVATIVE_WITHIN_RANGE", estimate_shown: true, research_only: true, conservative_estimate_percent: 8, final_text: "Conservative System 2 research estimate: about 8%.", warnings: ["English-only test."], language_check: { clearly_english: backendMode !== "not-english" }, diagnostics: { delta_pp: 4.5 }, internal_secret_field: "must-not-pass" }));
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
// A real Word document; each report saves the text the browser extracts from it (the route checks the upload is the report's own).
const DOCX_BYTES = await minimalDocx(["System 2 synthetic manuscript.", "A second paragraph of ordinary English text for the route tests."]);
const OTHER_DOCX = await minimalDocx(["A different manuscript that belongs to no report."]);
const REPORT_TEXT = await reportTextOf(DOCX_BYTES);
async function insertReport(id, userId, { text = REPORT_TEXT, room = 0, savedAt = null } = {}) {
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute({
    sql: "INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, room_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [id, `dev-${id}`, `sub-${id}`, "Synthetic report", new Date().toISOString(), 500, 3, "low", JSON.stringify({ text }), userId, room],
  });
  if (savedAt) await client.execute({ sql: "UPDATE saved_reports SET saved_at = ? WHERE id = ?", args: [savedAt, id] });
  client.close();
}
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
await insertReport("s2-owner-failing", owner.userId);
await insertReport("s2-owner-mismatch", owner.userId);
await insertReport("s2-owner-not-english", owner.userId);
await insertReport("s2-owner-old", owner.userId, { savedAt: "2026-01-01 00:00:00" });

test("config: enabled only with flag, https/loopback URL and a >= 32-char key; production needs its own switch; subscribers their own", () => {
  const base = { S2_RESEARCH_ENABLED: "1", S2_RESEARCH_OWNER_EMAILS: OWNER, S2_INFERENCE_URL: "https://backend.example/api/analyze", S2_INFERENCE_KEY: KEY, VERCEL_ENV: "preview" };
  assert.equal(S2.system2Config(base).enabled, true);
  assert.equal(S2.system2Config(base).subscribersEnabled, false, "subscribers only with S2_SUBSCRIBERS_ENABLED");
  assert.equal(S2.system2Config({ ...base, S2_SUBSCRIBERS_ENABLED: "1" }).subscribersEnabled, true);
  assert.equal(S2.system2Config({ ...base, VERCEL_ENV: "production" }).enabled, false, "production: off without S2_PRODUCTION_ENABLED");
  assert.equal(S2.system2Config({ ...base, VERCEL_ENV: "production", S2_PRODUCTION_ENABLED: "true" }).enabled, false);
  assert.equal(S2.system2Config({ ...base, VERCEL_ENV: "production", S2_PRODUCTION_ENABLED: "1" }).enabled, true);
  assert.equal(S2.system2Config({ ...base, S2_RESEARCH_ENABLED: "true" }).enabled, false);
  assert.equal(S2.system2Config({ ...base, S2_RESEARCH_OWNER_EMAILS: "" }).enabled, true, "the allowlist is optional (administrators qualify)");
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
  assert.equal((await call("s2-owner-report", { cookie: owner.cookie })).status, 404, "production without its own switch");
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
  assert.equal(calls[0].oidc, null, "outside Vercel (VERCEL unset) no OIDC token is requested or sent");
  // the accepted estimate is stored with the owner's own report (lib/system2-estimate-record.ts), and the browser is told so
  assert.equal(body.persisted, true);
  const db = createClient({ url: `file:${dbFile}` });
  const storedOf = async (id) => JSON.parse(String((await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE id = ?", args: [id] })).rows[0].payload_json)).system2Estimate;
  assert.equal((await storedOf("s2-owner-report")).conservative_estimate_percent, 8);
  assert.equal(await storedOf("s2-other-report"), undefined, "no other report is touched");
  const again = await call("s2-owner-report", { cookie: owner.cookie });
  assert.equal(again.status, 409); assert.equal((await again.json()).state, "ALREADY_RECORDED", "one estimate per report");
  assert.equal(calls.length, 1, "a repeat never reaches the backend");
  backendMode = "fail";
  const failed = await call("s2-owner-failing", { cookie: owner.cookie });
  assert.equal(failed.status, 502); assert.equal((await failed.json()).state, "UNAVAILABLE");
  assert.equal(await storedOf("s2-owner-failing"), undefined, "a failure stores nothing");
  assert.equal((await storedOf("s2-owner-report")).conservative_estimate_percent, 8);
  db.close();
  backendMode = "ok";
});

test("route: only the report's own document, only right after its save; nothing is sent otherwise", async () => {
  configureEnv(); calls.length = 0; backendMode = "ok";
  const mismatch = await call("s2-owner-mismatch", { cookie: owner.cookie, body: OTHER_DOCX });
  assert.equal(mismatch.status, 422); assert.equal((await mismatch.json()).state, "DOCUMENT_MISMATCH", "another document's estimate can never be attached");
  const unreadable = await call("s2-owner-mismatch", { cookie: owner.cookie, body: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) });
  assert.equal(unreadable.status, 422, "a zip that is not a readable Word document");
  const old = await call("s2-owner-old", { cookie: owner.cookie });
  assert.equal(old.status, 409); assert.equal((await old.json()).state, "REQUEST_WINDOW_CLOSED", "an old report is never re-estimated");
  const notSent = await route.POST(new Request("http://localhost/api/reports/s2-owner-mismatch/system2", { method: "POST", headers: { cookie: `tp_session_v1=${owner.cookie}`, "x-s2-consent": "granted", "x-s2-not-sent": "UNSUPPORTED_FILE_TYPE" } }), { params: Promise.resolve({ id: "s2-owner-mismatch" }) });
  assert.equal(notSent.status, 200); assert.equal((await notSent.json()).state, "UNSUPPORTED_FILE_TYPE", "a kept file is only recorded as ineligible");
  assert.equal(calls.length, 0, "the backend was never called");
  const ok = await call("s2-owner-mismatch", { cookie: owner.cookie });
  assert.equal(ok.status, 200, "the same report with its own document still works");
});

test("route: an estimate for text that is not clearly English is never used, stored or returned; System 1 stays the result", async () => {
  configureEnv(); calls.length = 0; backendMode = "not-english";
  const res = await call("s2-owner-not-english", { cookie: owner.cookie });
  backendMode = "ok";
  assert.equal(res.status, 200); assert.equal(calls.length, 1);
  const body = await res.json();
  assert.equal(body.state, "NOT_CLEARLY_ENGLISH"); assert.equal(body.estimate_shown, false); assert.equal(body.persisted, false);
  assert.equal(body.conservative_estimate_percent, undefined, "no number reaches the browser");
  const db = createClient({ url: `file:${dbFile}` });
  const payload = JSON.parse(String((await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE id = ?", args: ["s2-owner-not-english"] })).rows[0].payload_json));
  db.close();
  assert.equal(payload.system2Estimate, undefined);
  assert.equal(S2.isClearlyEnglishResult({ language_check: { clearly_english: true } }), true);
  assert.equal(S2.isClearlyEnglishResult({ language_check: { clearly_english: false } }), false);
  assert.equal(S2.isClearlyEnglishResult({}), false, "an unknown language is never accepted");
});

test("Trusted Sources: the Vercel OIDC token is sent in x-vercel-trusted-oidc-idp-token, with the bearer key, and never returned", async () => {
  configureEnv(); calls.length = 0; backendMode = "ok";
  const config = S2.system2Config();
  const withToken = await S2.requestSystem2Inference(DOCX_BYTES, config, fetch, async () => "test-oidc-token");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].oidc, "test-oidc-token"); assert.equal(calls[0].auth, `Bearer ${KEY}`); assert.equal(calls[0].bypass, null, "no bypass secret unless explicitly configured");
  assert.ok(!JSON.stringify(withToken).includes("test-oidc-token"), "the token never appears in the result");
  await S2.requestSystem2Inference(DOCX_BYTES, config, fetch, async () => null);
  assert.equal(calls[1].oidc, null, "no token available: no header is invented");
  const saved = process.env.VERCEL; delete process.env.VERCEL;
  assert.equal(await S2.vercelOidcTokenProvider(), null, "never requests a token off Vercel");
  if (saved !== undefined) process.env.VERCEL = saved;
});

test("wiring: one analyze action, one similarity percentage; System 2 only behind the scenes, after one-time authorization", async () => {
  const roomPage = await readFile(new URL("../app/reports/rooms/[room]/page.tsx", import.meta.url), "utf8");
  assert.match(roomPage, /system2Enabled: \(await resolveSystem2Access\(client, sessionUser, \{ room, policy \}\)\)\.allowed/);
  assert.match(roomPage, /system2Enabled=\{result\.system2Enabled\}/);
  const detailPage = await readFile(new URL("../app/reports/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(detailPage, /const system2Enabled = \(await resolveSystem2Access\(client, sessionUser\)\)\.allowed;/);
  assert.match(detailPage, /system2Enabled=\{result\.status === "found" \? result\.system2Enabled : false\}/);

  const roomShell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  assert.match(roomShell, /system2Enabled = false \}: Props/);
  // owner decision 2026-10-30: no consent card, dialog or checkbox anywhere — one Generate action; the allowlisted owner's
  // file is handed to the ONE automatic request (no customer ever sends anything); the save starts it, never awaited
  assert.doesNotMatch(roomShell, /System2AuthorizationNotice|System2PermissionDialog|System2PrivacyNote|s2Authorization|extraOption=|s2Consent|type="checkbox"/);
  assert.match(roomShell, /onGenerate=\{runCheck\}/);
  assert.match(roomShell, /s2PendingRef\.current = system2Enabled \? submittedFile : null;/);
  const afterSave = roomShell.indexOf('setOccupant({ status: "processing", report: summary');
  const start = roomShell.indexOf("if (s2Pending) void requestSystem2Estimate(summary.id, s2Pending);");
  assert.ok(afterSave > 0 && start > afterSave && start - afterSave < 800, "System 2 starts right after the report is saved");
  // the original three tiles: AI, Similarity (now the one unified %), Receipt; no System 2 tile, card or button
  // customers keep the exact original tile; only the owner's wrapper feeds it the stored System 2 estimate
  assert.equal((roomShell.match(/\{system2Enabled \? <UnifiedSimilarityMetricTile report=\{occupant\.report\} room=\{room\} \/> : <SimilarityMetricTile report=\{occupant\.report\} room=\{room\} \/>\}/g) ?? []).length, 3);
  assert.doesNotMatch(roomShell, /System2MetricTile|System2ResearchPanel|SYSTEM2_ROOM_NOTE|Estimated Turnitin-like|Run System 2 estimate/);
  assert.match(roomShell, /const unified = unifySimilarity\(score, system2Estimate \?\? storedEstimate\);/);
  assert.match(roomShell, /<strong className="room-metric-value">\{unified\.percent\}%<\/strong>/);

  const detailShell = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(detailShell, /system2Enabled = false,/);
  assert.match(detailShell, /const unified = system2Estimate \? unifySimilarity\(primaryScore, system2Estimate\) : undefined;/, "a report without a stored estimate (every customer report): unified is undefined, every view unchanged");
  assert.match(detailShell, /unified=\{unified\}\r?\n\s*\/>/, "the customer workspace shows the one unified percentage");
  assert.equal((detailShell.match(/<OverviewReport report=\{report\} similarityStatus=\{effectiveSimilarityStatus\} \/>/g) ?? []).length, 3, "admin-only legacy diagnostic views keep System 1's verified figure");
  assert.match(detailShell, /<ReportV2PrintOverview report=\{report\} unified=\{unified\} \/>/);
  assert.match(detailShell, /await downloadReceipt\(report\);/);
  assert.doesNotMatch(detailShell, /System2EstimateDetail|System2ResearchPanel/);
  await assert.rejects(readFile(new URL("../components/report/system2-research-panel.tsx", import.meta.url), "utf8"), "the manual panel is removed");

  // highlights and sources stay System 1's: the V2 view only swaps the headline percentage and band
  const v2 = await readFile(new URL("../components/report/report-v2/report-v2-view.tsx", import.meta.url), "utf8");
  assert.match(v2, /<SourceCard key=\{card\.id\} card=\{card\} verifiedPercent=\{vm\.summary\.verifiedSimilarityPercent\}/, "per-source percentages stay relative to verified evidence");

  const client = await readFile(new URL("../components/report/system2-estimate.tsx", import.meta.url), "utf8");
  assert.match(client, /"x-s2-consent": "granted"/);
  assert.match(client, /extensionOf\(file\.name\) !== "\.docx"[\s\S]*?The document was not sent/, "non-Word files are never sent");
  assert.doesNotMatch(client, /Run System 2|type="checkbox"/, "no System 2 button or per-document checkbox");
  assert.doesNotMatch(client, /S2_INFERENCE|S2_RESEARCH|process\.env/, "no server configuration in client code");
  assert.doesNotMatch(client, /oidc|trusted-oidc/i, "no token handling in client code");
  const lib = await readFile(new URL("../lib/system2-research.ts", import.meta.url), "utf8");
  assert.match(lib, /import \{ getVercelOidcToken \} from "@vercel\/oidc";/);
  assert.match(lib, /headers\["x-vercel-trusted-oidc-idp-token"\] = token/);
});

test.after(() => {
  backend.close();
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(`${dbFile}${suffix}`)) try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* still open */ }
});

test("client: the automatic request sends a Word file once; other files are never sent; never throws", async () => {
  const client = await import("../components/report/system2-estimate.tsx");
  const store = new Map();
  const savedFetch = globalThis.fetch; const savedStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const sent = [];
  try {
    globalThis.fetch = async (url, init) => { sent.push({ url, headers: init.headers, bytes: init.body?.byteLength ?? null }); return new Response(JSON.stringify({ state: "CONSERVATIVE_WITHIN_RANGE", estimate_shown: true, conservative_estimate_percent: 8, final_text: "Estimated.", persisted: true }), { status: 200 }); };
    const announced = [];
    globalThis.window = { dispatchEvent: (e) => announced.push(e.detail) };
    globalThis.CustomEvent ??= class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
    const pdf = await client.requestSystem2Estimate("r-pdf", new File([new Uint8Array(10)], "paper.pdf"));
    assert.equal(pdf.estimate_shown, false); assert.equal(pdf.state, "UNSUPPORTED_FILE_TYPE");
    const big = await client.requestSystem2Estimate("r-big", new File([new Uint8Array(4_000_001)], "big.docx"));
    assert.equal(big.state, "TOO_LARGE");
    await new Promise((r) => setTimeout(r, 0));
    // the kept files are only reported to the server (recorded as ineligible): no body, never the document
    assert.deepEqual(sent.map((s) => [s.url, s.headers["x-s2-not-sent"], s.bytes]), [["/api/reports/r-pdf/system2", "UNSUPPORTED_FILE_TYPE", null], ["/api/reports/r-big/system2", "TOO_LARGE", null]]);
    sent.length = 0;
    const ok = await client.requestSystem2Estimate("r-ok", new File([DOCX_BYTES], "paper.docx"));
    assert.equal(ok.conservative_estimate_percent, 8); assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "/api/reports/r-ok/system2"); assert.equal(sent[0].headers["x-s2-consent"], "granted"); assert.equal(sent[0].bytes, DOCX_BYTES.length);
    assert.equal(store.size, 0, "nothing is kept in the browser: the server stores the estimate with the report");
    assert.deepEqual(announced, [{ reportId: "r-ok", result: ok }], "the open page is told only about a stored estimate");
    globalThis.fetch = async () => new Response(JSON.stringify({ state: "CONSERVATIVE_WITHIN_RANGE", estimate_shown: true, conservative_estimate_percent: 8, final_text: "x", persisted: false }), { status: 200 });
    await client.requestSystem2Estimate("r-unstored", new File([DOCX_BYTES], "paper.docx"));
    assert.equal(announced.length, 1, "an estimate the server did not store is never shown (System 1 stays the result)");
    globalThis.fetch = async () => { throw new Error("offline"); };
    const down = await client.requestSystem2Estimate("r-down", new File([DOCX_BYTES], "paper.docx"));
    assert.equal(down.estimate_shown, false); assert.equal(down.state, "UNAVAILABLE");
  } finally {
    globalThis.fetch = savedFetch; if (savedStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = savedStorage;
    delete globalThis.window;
  }
});

test("no consent UI exists: the System 2 module exports no dialog, notice or privacy toggle", async () => {
  const mod = await import("../components/report/system2-estimate.tsx");
  for (const name of ["System2AuthorizationNotice", "System2PermissionDialog", "System2PrivacyNote", "loadSystem2Authorization", "storeSystem2Authorization"]) {
    assert.equal(name in mod, false, `${name} is gone`);
  }
});
