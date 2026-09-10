import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";

import {
  MAX_REFERENCE_TEXT_CHARS,
  referenceTransportBudgetError,
  REFERENCE_TOO_LARGE_MESSAGE,
} from "../lib/user-supplied-reference-constants.ts";
import { sanitizeSuppliedReferenceInputs } from "../lib/report-user-supplied-references.ts";
import { verifySuppliedReferences } from "../lib/user-supplied-references.ts";
import { extractReferenceInputs } from "../lib/document-check-pipeline.ts";
import { tokens } from "../lib/similarity-core.ts";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";

// ── DB setup FIRST (before any test) — see tests/user-supplied-references.test.mjs ──
const dbFile = path.join(path.resolve("."), "test_user_supplied_refs_notrunc.db");
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

// ── fixtures ──────────────────────────────────────────────────────────
const asciiText = (chars) => "reference body text ".repeat(Math.ceil(chars / 20)).slice(0, chars);
const input = (name, type, text) => ({ fileName: name, fileType: type, extractedText: text, extraction: null });
const entryOf = (id, name = `${id}.txt`, type = "txt") => ({
  id, file: { name }, displayName: name, fileType: type, sizeLabel: "1.0 KB", status: "ready", note: null,
});
const SHARED = Array.from({ length: 90 }, (_, i) => `distinctivephrase${i}`).join(" ");
const MANUSCRIPT = `Author opening that is theirs alone. ${SHARED} Author closing analysis.`;
const MWC = tokens(MANUSCRIPT).length;
// an over-limit reference whose first MAX_REFERENCE_TEXT_CHARS chars WOULD match
const OVERSIZE_MATCHING = `Reference intro. ${SHARED} ` + asciiText(MAX_REFERENCE_TEXT_CHARS);

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let uc = 0;
async function account() {
  uc += 1;
  await resetAuthRateForTest("nt-signup-" + uc);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "nt-signup-" + uc },
    body: JSON.stringify(withTestIdentity({ email: `nt-${uc}@example.test`, password: "nt-pw-123456", username: `ntu${uc}`, deviceKey: `nt-dev-${uc}` })),
  }));
  assert.equal(res.status, 201);
  return { deviceKey: `nt-dev-${uc}`, cookie: cookieOf(res), tag: `nt-${uc}` };
}
async function post(acc, id, extra) {
  await resetRateForTest(acc.tag + "-post");
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": acc.tag + "-post", cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "nt fixture", createdAt: new Date().toISOString(),
      wordCount: MWC, archiveScore: 0, scoreBand: "Low", aiScore: 2, aiTone: "low", aiStatus: "ready", room: 0,
      payload: { version: 11, id, submissionId: "sub-" + id, title: "nt fixture", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: MWC, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text: MANUSCRIPT },
      ...extra,
    }),
  }));
}
async function readRow(deviceKey, id) {
  const r = await dbClient.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  return r.rows[0] ? JSON.parse(String(r.rows[0].payload_json)) : null;
}
const refIn = (name, type, text) => ({ fileName: name, fileType: type, extractedText: text, extraction: { completeness: "COMPLETE", analyzableWordCount: 100, skipped: null, extractor: "x" } });

// ═══════════════════════════════════════════════════════════════════════
// 1 — exactly at the per-reference limit => accepted
// ═══════════════════════════════════════════════════════════════════════
test("1: a reference EXACTLY at MAX_REFERENCE_TEXT_CHARS is accepted (guard returns null)", () => {
  const refs = [input("edge.txt", "txt", asciiText(MAX_REFERENCE_TEXT_CHARS))];
  assert.equal(refs[0].extractedText.length, MAX_REFERENCE_TEXT_CHARS);
  assert.equal(referenceTransportBudgetError(refs), null);
  const san = sanitizeSuppliedReferenceInputs(refs);
  assert.equal(san[0].extractedText.length, MAX_REFERENCE_TEXT_CHARS, "kept verbatim");
});

// ═══════════════════════════════════════════════════════════════════════
// 2 — one char over => rejected CLIENT-SIDE (dropped to an empty FAILED input, never truncated)
// ═══════════════════════════════════════════════════════════════════════
test("2: a reference ONE char over the per-reference limit is rejected client-side — not truncated", async () => {
  const over = asciiText(MAX_REFERENCE_TEXT_CHARS + 1);
  let statuses = [];
  const inputs = await extractReferenceInputs(
    [entryOf("big")],
    (next) => { statuses = next; },
    async () => ({ text: over, extraction: { completeness: "COMPLETE", analyzableWordCount: 1, skipped: null, extractor: "x" } }),
  );
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].extractedText, "", "rejected reference is sent with EMPTY text — never a truncated prefix");
  assert.equal(inputs[0].extraction, null);
  const row = statuses.find((e) => e.id === "big");
  assert.equal(row.status, "failed");
  assert.equal(row.note, REFERENCE_TOO_LARGE_MESSAGE);
  assert.doesNotMatch(REFERENCE_TOO_LARGE_MESSAGE, /\d/, "message exposes no implementation number");
});

// ═══════════════════════════════════════════════════════════════════════
// 3 — forged server input one char over => 413 (pure guard)
// ═══════════════════════════════════════════════════════════════════════
test("3: the guard the route uses rejects a forged one-char-over reference (=> 413), never clamps it", () => {
  const forged = [input("forged.pdf", "pdf", asciiText(MAX_REFERENCE_TEXT_CHARS + 1))];
  const san = sanitizeSuppliedReferenceInputs(forged);
  assert.equal(san[0].extractedText.length, MAX_REFERENCE_TEXT_CHARS + 1, "sanitiser did NOT clamp");
  assert.equal(referenceTransportBudgetError(san), "PER_REFERENCE_TEXT");
});

// ═══════════════════════════════════════════════════════════════════════
// 4 — no substring / truncated version reaches the matcher
// ═══════════════════════════════════════════════════════════════════════
test("4: an over-limit forged reference is never truncated AND never handed to the matcher", () => {
  const forged = [input("sneak.pdf", "pdf", OVERSIZE_MATCHING)];
  const san = sanitizeSuppliedReferenceInputs(forged);
  assert.equal(san[0].extractedText, OVERSIZE_MATCHING, "exact text preserved — no prefix, no clamp");
  assert.equal(referenceTransportBudgetError(san), "PER_REFERENCE_TEXT");
  // sanity: a truncated prefix WOULD have matched — proving the guard is the protection
  const wouldMatch = verifySuppliedReferences(MANUSCRIPT, [input("x.pdf", "pdf", OVERSIZE_MATCHING.slice(0, MAX_REFERENCE_TEXT_CHARS))], MWC);
  assert.equal(wouldMatch.references[0].admitted, true, "a truncated prefix WOULD have matched — so it must never reach here");
});

// ═══════════════════════════════════════════════════════════════════════
// 6 — valid other references remain selected after a local per-reference rejection
// ═══════════════════════════════════════════════════════════════════════
test("6: after one reference is rejected for size, the other valid references stay selected and checked", async () => {
  const big = entryOf("big", "big.txt");
  const ok = entryOf("ok", "ok.txt");
  let statuses = [];
  const inputs = await extractReferenceInputs(
    [big, ok],
    (next) => { statuses = next; },
    async (file) => file === big.file
      ? ({ text: asciiText(MAX_REFERENCE_TEXT_CHARS + 5000), extraction: { completeness: "COMPLETE", analyzableWordCount: 1, skipped: null, extractor: "x" } })
      : ({ text: `Prefix. ${SHARED} Suffix.`, extraction: { completeness: "COMPLETE", analyzableWordCount: 100, skipped: null, extractor: "x" } }),
  );
  assert.equal(statuses.length, 2, "both entries remain in the list");
  assert.equal(statuses.find((e) => e.id === "big").status, "failed");
  assert.equal(statuses.find((e) => e.id === "big").note, REFERENCE_TOO_LARGE_MESSAGE);
  assert.equal(statuses.find((e) => e.id === "ok").status, "checking");
  assert.equal(inputs[0].extractedText, "");
  assert.ok(inputs[1].extractedText.includes("distinctivephrase0"), "the valid reference keeps its full text");
  assert.equal(referenceTransportBudgetError(inputs, MANUSCRIPT), null);
});

// ═══════════════════════════════════════════════════════════════════════
// 7 / 8 — aggregate + Unicode boundary guards are still intact
// ═══════════════════════════════════════════════════════════════════════
test("7: aggregate boundary — two refs each under the per-ref limit but summing over the aggregate => AGGREGATE_TEXT", () => {
  const refs = [
    input("a.txt", "txt", asciiText(MAX_REFERENCE_TEXT_CHARS)),
    input("b.txt", "txt", asciiText(1)),
  ];
  assert.equal(referenceTransportBudgetError(refs), "AGGREGATE_TEXT", "per-ref checks pass; the aggregate one fires");
});

test("8: Unicode — a single reference under the char limit but over the byte ceiling => REQUEST_BYTES (not PER_REFERENCE_TEXT, not truncated)", () => {
  const uni = (() => { let s = ""; const c = "café—“naïve” 日本語 "; while (s.length < 900_000) s += c; return s.slice(0, 900_000); })();
  const refs = [input("u.txt", "txt", uni)];
  assert.ok(refs[0].extractedText.length <= MAX_REFERENCE_TEXT_CHARS);
  assert.equal(referenceTransportBudgetError(refs), "REQUEST_BYTES");
  assert.equal(sanitizeSuppliedReferenceInputs(refs)[0].extractedText, uni, "still not truncated");
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE-LEVEL — 3 (413), 4 (no matcher), 5 (no DB write), 9 (no-ref), 10 (carry-forward)
// ═══════════════════════════════════════════════════════════════════════
test("3/4/5 (route): a forged over-per-limit reference => 413, no matcher work, NO report row", async () => {
  const acc = await account();
  const id = "nt-over-1";
  const res = await post(acc, id, { userSuppliedReferences: [refIn("sneak.pdf", "pdf", OVERSIZE_MATCHING)] });
  assert.equal(res.status, 413);
  const body = await res.text();
  assert.match(body, /Payload too large/);
  assert.doesNotMatch(body, /distinctivephrase|[a-f0-9]{64}/i, "no reference text / digest echoed");
  assert.equal(await readRow(acc.deviceKey, id), null, "no report row persisted on rejection");
});

test("5 (route): a resave that forges an over-limit reference does not corrupt an existing report", async () => {
  const acc = await account();
  const id = "nt-resave-1";
  assert.equal((await post(acc, id, { userSuppliedReferences: [refIn("ok.pdf", "pdf", `A. ${SHARED} B.`)] })).status, 200);
  const before = await readRow(acc.deviceKey, id);
  assert.equal(before.userSuppliedReferenceEvidence[0].admitted, true);

  const res = await post(acc, id, { userSuppliedReferences: [refIn("huge.pdf", "pdf", OVERSIZE_MATCHING)] });
  assert.equal(res.status, 413);
  const after = await readRow(acc.deviceKey, id);
  assert.deepEqual(after.userSuppliedReferenceEvidence, before.userSuppliedReferenceEvidence, "the prior verified evidence is untouched");
});

test("9 (route): a no-reference save is unchanged", async () => {
  const acc = await account();
  assert.equal((await post(acc, "nt-none-1", {})).status, 200);
  const p = await readRow(acc.deviceKey, "nt-none-1");
  assert.equal(p.userSuppliedReferenceEvidence, undefined);
  assert.equal(p.reportCompletion.signals.userSuppliedReference, null);
});

test("10 (route): V1.1 carry-forward resave (no new refs) is unaffected", async () => {
  const acc = await account();
  const id = "nt-cf-1";
  assert.equal((await post(acc, id, { userSuppliedReferences: [refIn("src.pdf", "pdf", `X. ${SHARED} Y.`)] })).status, 200);
  const resave = await post(acc, id, { aiScore: 8, aiTone: "review" });
  assert.equal(resave.status, 200);
  const p = await readRow(acc.deviceKey, id);
  assert.equal(p.userSuppliedReferenceEvidence[0].admitted, true, "carried forward");
  assert.equal(p.userSuppliedReferenceEvidence[0].safeLabel, "src.pdf");
});

test("route: a reference within the per-reference limit checks normally (no regression)", async () => {
  const acc = await account();
  const id = "nt-ok-1";
  assert.equal((await post(acc, id, { userSuppliedReferences: [refIn("match.pdf", "pdf", `Intro. ${SHARED} Outro.`)] })).status, 200);
  const p = await readRow(acc.deviceKey, id);
  assert.equal(p.userSuppliedReferenceEvidence[0].admitted, true);
  assert.ok(p.userSuppliedReferenceEvidence[0].matchedWords >= 60);
});
