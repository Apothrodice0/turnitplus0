import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  addReferenceFiles,
  MAX_REFERENCE_FILES,
  MAX_REFERENCE_AGGREGATE_TEXT_CHARS,
  MAX_REFERENCE_REQUEST_BYTES,
  MAX_REFERENCE_TEXT_CHARS,
  referenceTransportBudgetError,
  utf8ByteLength,
  REFERENCE_BUDGET_MESSAGE,
} from "../lib/user-supplied-reference-constants.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";
import { sanitizeSuppliedReferenceInputs } from "../lib/report-user-supplied-references.ts";
import { tokens } from "../lib/similarity-core.ts";

// ── synthetic fixtures — LOCAL ONLY, no network ────────────────────────
const enc = new TextEncoder();
const bytesOf = (s) => enc.encode(s).length;
const asciiText = (chars) => "reference body text ".repeat(Math.ceil(chars / 20)).slice(0, chars);
// multi-byte mix: em-dash/curly-quotes (3B), accented (2B), CJK (3B) — chars != bytes
const uniText = (chars) => { let s = ""; const chunk = "café—“naïve” 日本語 "; while (s.length < chars) s += chunk; return s.slice(0, chars); };
const smallFile = (name, size = 4096) => ({ name, size });
const input = (name, type, text) => ({ fileName: name, fileType: type, extractedText: text, extraction: null });

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1 — the limits are internally consistent and sit under the request cap
// ═══════════════════════════════════════════════════════════════════════
test("limits: reference bounds are mutually consistent and well under the report-save request cap", () => {
  assert.equal(MAX_REFERENCE_FILES, 20);
  assert.equal(MAX_REFERENCE_TEXT_CHARS, MAX_REFERENCE_AGGREGATE_TEXT_CHARS, "per-ref limit is derived from the aggregate, not a duplicate literal");
  assert.ok(MAX_REFERENCE_REQUEST_BYTES < MAX_REPORT_SAVE_REQUEST_BYTES, "the reference sibling ceiling leaves room for the manuscript + envelope");
  // an all-ASCII aggregate at the char ceiling must still serialise under the byte ceiling
  const asciiAggregateBytes = bytesOf(JSON.stringify([input("a.txt", "txt", asciiText(MAX_REFERENCE_AGGREGATE_TEXT_CHARS))]));
  assert.ok(asciiAggregateBytes <= MAX_REFERENCE_REQUEST_BYTES, `ASCII aggregate ${asciiAggregateBytes}B fits the byte ceiling`);
});

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2 — stress fixtures + measurement
// ═══════════════════════════════════════════════════════════════════════
test("stress: 20 small references are accepted; a 21st is rejected before it is added", () => {
  const files = Array.from({ length: MAX_REFERENCE_FILES + 1 }, (_, i) => smallFile(`ref-${i}.pdf`));
  const { entries, rejected } = addReferenceFiles([], files);
  assert.equal(entries.length, MAX_REFERENCE_FILES);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, new RegExp(String(MAX_REFERENCE_FILES)));
});

test("stress: 20 small references' combined text is comfortably inside the transport budget", () => {
  const refs = Array.from({ length: 20 }, (_, i) => input(`ref-${i}.pdf`, "pdf", asciiText(10_000)));
  assert.equal(referenceTransportBudgetError(refs), null);
  const sibling = JSON.stringify(refs);
  assert.ok(bytesOf(sibling) < MAX_REFERENCE_REQUEST_BYTES / 2, "20 x 10k chars stays well under half the sibling budget");
});

test("NO SILENT TRUNCATION: the sanitiser NEVER clamps per-reference text — an over-limit reference is kept verbatim so the guard can reject it", () => {
  const overText = asciiText(MAX_REFERENCE_TEXT_CHARS + 500_000);
  const sanitised = sanitizeSuppliedReferenceInputs([input("huge.txt", "txt", overText)]);
  assert.equal(sanitised.length, 1);
  assert.equal(sanitised[0].extractedText.length, overText.length, "text is NOT truncated by the sanitiser");
  assert.equal(sanitised[0].extractedText, overText, "no substring / prefix — the exact text is preserved for the reject decision");
  assert.equal(referenceTransportBudgetError(sanitised), "PER_REFERENCE_TEXT", "the guard rejects it (whole request) rather than the sanitiser silently clamping");
});

test("stress: aggregate EXACTLY at the char boundary is accepted", () => {
  const refs = [input("a.txt", "txt", asciiText(MAX_REFERENCE_AGGREGATE_TEXT_CHARS))];
  assert.equal(refs[0].extractedText.length, MAX_REFERENCE_AGGREGATE_TEXT_CHARS);
  assert.equal(referenceTransportBudgetError(refs), null);
});

test("stress: aggregate ONE char over the boundary is rejected (AGGREGATE_TEXT)", () => {
  const refs = [
    input("a.txt", "txt", asciiText(MAX_REFERENCE_AGGREGATE_TEXT_CHARS - 10)),
    input("b.txt", "txt", asciiText(11)),
  ];
  assert.equal(refs.reduce((n, r) => n + r.extractedText.length, 0), MAX_REFERENCE_AGGREGATE_TEXT_CHARS + 1);
  assert.equal(referenceTransportBudgetError(refs), "AGGREGATE_TEXT");
});

test("stress: 20 refs summing over the aggregate ceiling are rejected", () => {
  const refs = Array.from({ length: 20 }, (_, i) => input(`p-${i}.pdf`, "pdf", asciiText(70_000))); // 1.4M chars
  assert.equal(referenceTransportBudgetError(refs), "AGGREGATE_TEXT");
});

// ═══════════════════════════════════════════════════════════════════════
// PHASE 5 — byte safety: chars != bytes for Unicode-heavy text
// ═══════════════════════════════════════════════════════════════════════
test("Unicode: a reference set UNDER the char ceiling but OVER the byte ceiling is rejected (REQUEST_BYTES)", () => {
  // ~1M multi-byte chars ≈ 2.4M UTF-8 bytes — passes the char check, fails bytes
  const refs = [input("thesis.txt", "txt", uniText(1_000_000))];
  assert.ok(refs[0].extractedText.length <= MAX_REFERENCE_AGGREGATE_TEXT_CHARS, "within the char ceiling");
  assert.ok(bytesOf(JSON.stringify(refs)) > MAX_REFERENCE_REQUEST_BYTES, "but over the byte ceiling");
  assert.equal(referenceTransportBudgetError(refs), "REQUEST_BYTES");
});

test("Unicode: a modest multi-byte reference set is still accepted", () => {
  const refs = [input("notes.txt", "txt", uniText(200_000))];
  assert.equal(referenceTransportBudgetError(refs), null);
});

// ═══════════════════════════════════════════════════════════════════════
// PHASE 4/5 — combined manuscript + references estimate
// ═══════════════════════════════════════════════════════════════════════
test("combined: a large manuscript leaves less room — references that fit alone are rejected alongside it", () => {
  const refs = [input("r.pdf", "pdf", asciiText(1_000_000))];
  assert.equal(referenceTransportBudgetError(refs), null, "the references fit on their own");
  const bigManuscript = asciiText(1_200_000); // ~1.2M bytes
  assert.equal(referenceTransportBudgetError(refs, bigManuscript), "REQUEST_BYTES", "combined with a big manuscript they do not");
});

test("combined: a normal manuscript + a normal reference set is accepted", () => {
  const refs = Array.from({ length: 10 }, (_, i) => input(`a-${i}.pdf`, "pdf", asciiText(40_000)));
  const manuscript = asciiText(60_000);
  assert.equal(referenceTransportBudgetError(refs, manuscript), null);
});

test("budget message never leaks a byte/char number", () => {
  assert.doesNotMatch(REFERENCE_BUDGET_MESSAGE, /\d/, "no implementation numbers in the user-facing copy");
  assert.match(REFERENCE_BUDGET_MESSAGE, /Remove one or more files/);
});

// ═══════════════════════════════════════════════════════════════════════
// PHASE 8 — the maximum accepted request stays within the chosen safe budget
// ═══════════════════════════════════════════════════════════════════════
test("PHASE 8: a manuscript + the maximum accepted reference set serialises within MAX_REPORT_SAVE_REQUEST_BYTES", () => {
  // the largest reference set the guard will accept alongside a mid-size manuscript
  const manuscript = asciiText(120_000);
  let refs = Array.from({ length: 20 }, (_, i) => input(`ref-${i}.pdf`, "pdf", asciiText(Math.floor(MAX_REFERENCE_AGGREGATE_TEXT_CHARS / 20))));
  assert.equal(referenceTransportBudgetError(refs, manuscript), null, "this set is accepted");

  const body = JSON.stringify({
    deviceKey: "dev-" + "x".repeat(30),
    id: "1700000000000", submissionId: "0000000001", title: "manuscript-final.pdf",
    createdAt: new Date().toISOString(), wordCount: 12000, archiveScore: 0, scoreBand: "Low",
    aiScore: 2, aiTone: "low", aiStatus: "ready", room: 0,
    payload: { version: 11, id: 1700000000000, text: manuscript, wordCount: 12000, sources: [], repeats: [], archiveMatchedPositions: [], scoreBand: "Low", matchedWordCount: 0 },
    academicSearchDiagnosticsId: null,
    devicePassport: { reportId: "1700000000000", challengeId: "c".repeat(40), signature: "s".repeat(96), publicKeySpki: "p".repeat(120) },
    extractionCompleteness: { completeness: "COMPLETE", analyzableWordCount: 12000, skipped: null, extractor: "plain-text" },
    userSuppliedReferences: refs,
  });
  const totalBytes = bytesOf(body);
  assert.ok(totalBytes < MAX_REPORT_SAVE_REQUEST_BYTES, `max accepted request = ${totalBytes} bytes < ${MAX_REPORT_SAVE_REQUEST_BYTES}`);
});

// ═══════════════════════════════════════════════════════════════════════
// PHASE 6 — server independently enforces; PHASE 7 — normal flows unchanged
// ═══════════════════════════════════════════════════════════════════════
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";

const dbFile = path.join(path.resolve("."), "test_user_supplied_refs_transport.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
const dbClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(dbClient, path.join(path.resolve("."), "drizzle"));
test.after(() => {
  dbClient.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

const SHARED = Array.from({ length: 90 }, (_, i) => `distinctivephrase${i}`).join(" ");
const MANUSCRIPT = `Original opening framing that belongs to the author alone here. ${SHARED} And a closing set of the author's own analysis and remarks.`;
const RWC = tokens(MANUSCRIPT).length;
const REFERENCE_MATCH = `Unrelated reference intro about another topic. ${SHARED} Unrelated reference outro sharing nothing else.`;

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let uc = 0;
async function account() {
  uc += 1;
  await resetAuthRateForTest("trn-signup-" + uc);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "trn-signup-" + uc },
    body: JSON.stringify(withTestIdentity({ email: `trn-${uc}@example.test`, password: "trn-pw-123456", username: `trnu${uc}`, deviceKey: `trn-dev-${uc}` })),
  }));
  assert.equal(res.status, 201);
  return { deviceKey: `trn-dev-${uc}`, cookie: cookieOf(res), tag: `trn-${uc}` };
}
async function post(acc, id, extra) {
  await resetRateForTest(acc.tag + "-post");
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": acc.tag + "-post", cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "trn fixture", createdAt: new Date().toISOString(),
      wordCount: RWC, archiveScore: 0, scoreBand: "Low", aiScore: 2, aiTone: "low", aiStatus: "ready", room: 0,
      payload: { version: 11, id, submissionId: "sub-" + id, title: "trn fixture", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: RWC, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text: MANUSCRIPT },
      ...extra,
    }),
  }));
}
async function readRow(deviceKey, id) {
  const r = await dbClient.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  return r.rows[0] ? JSON.parse(String(r.rows[0].payload_json)) : null;
}
const refInput = (name, type, text) => ({ fileName: name, fileType: type, extractedText: text, extraction: { completeness: "COMPLETE", analyzableWordCount: 100, skipped: null, extractor: "x" } });

test("server: a forged OVER-BUDGET userSuppliedReferences sibling is rejected 413 — no report row, no forged/partial evidence", async () => {
  const acc = await account();
  const id = "trn-over-1";
  // 20 refs x 100k chars = 2M chars aggregate — well past MAX_REFERENCE_AGGREGATE_TEXT_CHARS
  const refs = Array.from({ length: 20 }, (_, i) => refInput(`big-${i}.pdf`, "pdf", asciiText(100_000)));
  const res = await post(acc, id, { userSuppliedReferences: refs });
  assert.equal(res.status, 413);
  const p = await readRow(acc.deviceKey, id);
  assert.equal(p, null, "nothing persisted for an over-budget request");
});

test("server: a forged BYTE-over-budget sibling (Unicode) is rejected 413 before the matcher runs", async () => {
  const acc = await account();
  const id = "trn-over-2";
  const refs = [refInput("uni.txt", "txt", uniText(1_000_000))]; // under chars, over bytes
  const res = await post(acc, id, { userSuppliedReferences: refs });
  assert.equal(res.status, 413);
  assert.equal(await readRow(acc.deviceKey, id), null);
});

test("server: a reference set at the aggregate boundary is accepted and verified normally", async () => {
  const acc = await account();
  const id = "trn-ok-1";
  const res = await post(acc, id, { userSuppliedReferences: [refInput("match.pdf", "pdf", REFERENCE_MATCH)] });
  assert.equal(res.status, 200);
  const p = await readRow(acc.deviceKey, id);
  assert.equal(p.userSuppliedReferenceEvidence[0].admitted, true);
  assert.ok(p.userSuppliedReferenceEvidence[0].matchedWords >= 60);
});

test("PHASE 7: a no-reference save is byte-identical behaviour (no reference fields, no 413)", async () => {
  const acc = await account();
  const res = await post(acc, "trn-none-1", {});
  assert.equal(res.status, 200);
  const p = await readRow(acc.deviceKey, "trn-none-1");
  assert.equal(p.userSuppliedReferenceEvidence, undefined);
  assert.equal(p.userSuppliedReferenceChannel, undefined);
  assert.equal(p.reportCompletion.signals.userSuppliedReference, null);
});

test("PHASE 7: V1.1 carry-forward resave (no new refs) is unaffected by the transport guard", async () => {
  const acc = await account();
  const id = "trn-cf-1";
  const first = await post(acc, id, { userSuppliedReferences: [refInput("src.pdf", "pdf", REFERENCE_MATCH)] });
  assert.equal(first.status, 200);
  const p1 = await readRow(acc.deviceKey, id);
  assert.equal(p1.userSuppliedReferenceEvidence[0].admitted, true);

  // resave with NO userSuppliedReferences sibling — the guard must not fire,
  // the carried-forward evidence must survive
  const resave = await post(acc, id, { aiScore: 9, aiTone: "high" });
  assert.equal(resave.status, 200);
  const p2 = await readRow(acc.deviceKey, id);
  assert.equal(p2.userSuppliedReferenceEvidence[0].admitted, true, "carry-forward evidence preserved");
  assert.equal(p2.userSuppliedReferenceEvidence[0].safeLabel, "src.pdf");
});

test("PHASE 6/privacy: the 413 body is a generic 'Payload too large' — no digest, path, or reference text echoed", async () => {
  const acc = await account();
  const refs = Array.from({ length: 20 }, (_, i) => refInput(`b-${i}.pdf`, "pdf", asciiText(100_000)));
  const res = await post(acc, "trn-priv-1", { userSuppliedReferences: refs });
  assert.equal(res.status, 413);
  const body = await res.text();
  assert.match(body, /Payload too large/);
  assert.doesNotMatch(body, /reference body text|[a-f0-9]{64}|fakepath/i);
});
