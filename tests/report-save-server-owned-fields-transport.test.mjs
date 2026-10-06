import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";

import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";
import { completeAiAnalysis } from "./helpers/complete-ai-analysis.mjs";
import { atServerTime } from "./helpers/report-clock.mjs";
import { tokens } from "../lib/similarity-core.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { CLIENT_UNTRUSTED_EVIDENCE_INTERPRETATION_KEYS, withEvidenceInterpretation } from "../lib/report-evidence-interpretation.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";
import { decodeReportFromPersistence } from "../lib/report-persistence.ts";
import { SERVER_OWNED_REPORT_PAYLOAD_KEYS, saveReportRemote, withoutServerOwnedReportFields } from "../lib/reports-remote.ts";

/**
 * SERVER-OWNED REPORT FIELDS DO NOT TRAVEL IN A SAVE REQUEST.
 *
 * Before a save the browser attaches its own `unifiedSimilarity` (archive + live-academic only) and its own
 * `evidenceInterpretation` / `reportCompletion` to the report it shows immediately (app/page.tsx,
 * room-page-shell.tsx). The server never reads them: POST /api/reports resets the similarity keys and strips the
 * interpretation keys from every payload, then computes its own. Sending them was pure weight — and for a report with
 * much archive evidence it was most of the request: the matched positions a second time (the browser's unified
 * union), a third time (the interpretation's positionsByKind) and an excerpt of every passage — so the REQUEST
 * crossed MAX_REPORT_SAVE_REQUEST_BYTES and the save was refused before the server saw the document, although what
 * the server would have stored fits. (`userSuppliedReferences` rode along twice the same way: once as the request's
 * sibling, the only copy the server reads, and once inside the payload.)
 *
 * What this file pins:
 *   1. the request no longer carries those fields, and carries everything else exactly as before;
 *   2. THE SERVER CANNOT TELL: for every omitted key, the row the real route persists has the same content and the
 *      same size whether the client sent a value, forged one, or sent nothing — first save, AI resave, and
 *      authoritative (pending -> finalized) alike. That is the proof the omission changes no stored report. (JSON key
 *      ORDER is the one thing that may differ: the server writes its own `unifiedSimilarity` where the client's key
 *      stood, or after the client's keys when there was none. No reader depends on key order.)
 *   3. the report that was refused at the request is now saved.
 *
 * Real route + real libsql file DB of its own (OS temp dir, removed afterwards).
 */

const MAX = MAX_REPORT_SAVE_REQUEST_BYTES;
const workDir = mkdtempSync(path.join(tmpdir(), "lean-save-"));
const dbFile = path.join(workDir, "lean_save.db");
const ENV_KEYS = ["TURSO_DATABASE_URL", "CORPUS_SOURCE_MATCHING_ENABLED", "REPORT_COMPACT_POSITIONS_WRITE_ENABLED", "REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED", "SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED", "SELECTIVE_CORPUS_SHADOW_ENABLED", "SELECTIVE_CORPUS_ARTIFACT_PATH"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
process.env.REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED = "true";
for (const key of ["REPORT_COMPACT_POSITIONS_WRITE_ENABLED", "SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED", "SELECTIVE_CORPUS_SHADOW_ENABLED", "SELECTIVE_CORPUS_ARTIFACT_PATH"]) delete process.env[key];

// All database setup resolves before the first test() is registered.
const db = createClient({ url: `file:${dbFile}` });
await db.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(db, path.resolve("drizzle"));

test.after(() => {
  db.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------------------------------------------
// fixtures: synthetic only
// ---------------------------------------------------------------------------------------------------------------
const SYL = ["ka", "lo", "mi", "tre", "vun", "sor", "bel", "dra", "phi", "quen", "zor", "tal", "mer", "nix", "ost", "ula", "rin", "vek", "dom", "sha", "gri", "pol", "wex", "yun"];
function words(count, seed) {
  let s = seed >>> 0;
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYL[next() % SYL.length] + SYL[next() % SYL.length] + SYL[next() % SYL.length]);
  return out;
}
const CREATED = new Date().toISOString();

/**
 * The report a browser holds when it saves: the archive result (positions + the scorer's own phrase chunks, 40 words
 * every 34 over each matched span — lib/archive-similarity-scoring.ts), then attachUnifiedSimilarity and
 * attachEvidenceInterpretation exactly as lib/document-check-pipeline.ts applies them.
 */
function browserReport(id, wordList, runs) {
  const text = wordList.join(" ");
  const wordCount = wordList.length;
  const archiveMatchedPositions = [];
  const phrases = [];
  for (const [start, end] of runs) {
    for (let p = start; p <= end; p += 1) archiveMatchedPositions.push(p);
    for (let cursor = start; cursor <= end; cursor += 34) {
      if (end - cursor + 1 < 5) break;
      phrases.push(wordList.slice(cursor, Math.min(end + 1, cursor + 40)).join(" "));
    }
  }
  const score = Math.floor((archiveMatchedPositions.length / wordCount) * 100);
  const base = {
    version: 11, id, submissionId: "sub-" + id, title: "lean save fixture", author: "", assignment: "", created: CREATED,
    score, archiveScore: score, wordCount, scoreBand: "Low", matchedWordCount: archiveMatchedPositions.length, archiveMatchedPositions,
    sources: runs.length > 0 ? [{ name: "Archive source", type: "Publication", color: "#d7263d", matches: runs.length, matchedWords: archiveMatchedPositions.length, phrases, percent: score }] : [],
    repeats: [], text, academicEvidenceStatus: "COMPLETE_NO_MATCHES",
  };
  const withUnified = { ...base, unifiedSimilarity: computeUnifiedSimilarity({ wordCount, archiveMatchedPositions, externalAcademicEvidence: [] }) };
  return withEvidenceInterpretation(withUnified, { selectiveCorpusBranch: null, serverExtractionDiagnostic: { completeness: "COMPLETE" } });
}
function periodicRuns(wordCount, on, period) {
  const runs = [];
  for (let start = 0; start + on <= wordCount; start += period) runs.push([start, start + on - 1]);
  return runs;
}

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let accountCounter = 0;
async function account() {
  accountCounter += 1;
  const n = String(accountCounter).padStart(3, "0");
  await resetAuthRateForTest("ls-signup-" + n);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "ls-signup-" + n },
    body: JSON.stringify(withTestIdentity({ email: `ls-${n}@example.test`, password: "ls-password-123456", username: `lsuser${n}`, deviceKey: `ls-dev-${n}` })),
  }));
  assert.equal(res.status, 201, "test setup: signup");
  return { deviceKey: `ls-dev-${n}`, cookie: cookieOf(res), tag: `ls-${n}` };
}
let requestCounter = 0;
async function post(acc, payload, { ai = "processing", room = 0 } = {}) {
  requestCounter += 1;
  await resetRateForTest(`${acc.tag}-post-${requestCounter}`);
  const aiFields = ai === "ready" ? { aiScore: 2, aiTone: "low", aiStatus: "ready" } : { aiScore: null, aiTone: null };
  const body = JSON.stringify({
    deviceKey: acc.deviceKey, id: payload.id, submissionId: payload.submissionId, title: payload.title, createdAt: CREATED,
    wordCount: payload.wordCount, archiveScore: payload.archiveScore, scoreBand: payload.scoreBand, ...aiFields, room,
    payload: ai === "ready" ? { ...payload, aiAnalysis: completeAiAnalysis() } : payload,
  });
  const original = console.warn;
  const reasons = [];
  console.warn = (...args) => {
    try { const event = JSON.parse(String(args[0])); if (event?.event === "report_save_rejected") { reasons.push(event.reason); return; } } catch { /* not telemetry */ }
    original(...args);
  };
  try {
    const res = await reportsRoute.POST(new Request("http://localhost/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `${acc.tag}-post-${requestCounter}`, cookie: `tp_session_v1=${acc.cookie}` },
      body,
    }));
    return { status: res.status, bodyUnits: body.length, reasons };
  } finally {
    console.warn = original;
  }
}
async function rawRow(deviceKey, id) {
  const r = await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  return r.rows[0] ? String(r.rows[0].payload_json) : null;
}
async function withEnv(overrides, fn) {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const set = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  for (const [key, value] of Object.entries(overrides)) set(key, value);
  try { return await fn(); } finally { for (const [key, value] of Object.entries(previous)) set(key, value); }
}

/** Runs saveReportRemote against a stubbed browser (window.localStorage + fetch) and returns the request it made. */
async function captureSave(report, summary, room) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const store = new Map();
  const requests = [];
  globalThis.window = { localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } } };
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/reports") { requests.push({ raw: String(init.body), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
    return new Response("{}", { status: 404 }); // device-passport endpoints: the attestation is fail-safe and simply absent
  };
  try {
    const result = await saveReportRemote(report, summary, null, room);
    return { result, requests };
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
}
/** A stored row with every object's keys sorted: two rows with the same content compare equal whatever order their keys were written in. */
function canonical(rowJson) {
  const sort = (value) => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
    return value;
  };
  return JSON.stringify(sort(JSON.parse(rowJson)));
}
const summaryOf = (report) => ({ id: String(report.id), submissionId: report.submissionId, title: report.title, createdAt: CREATED, wordCount: report.wordCount, archiveScore: report.archiveScore, scoreBand: report.scoreBand, aiScore: null, aiTone: null });

// ===============================================================================================================
test("THE LIST is every key the save route discards: the interpretation keys it strips plus the four similarity keys it resets", () => {
  assert.deepEqual(
    [...SERVER_OWNED_REPORT_PAYLOAD_KEYS].sort(),
    [...CLIENT_UNTRUSTED_EVIDENCE_INTERPRETATION_KEYS, "unifiedSimilarity", "unifiedSimilarityFailed", "unifiedSimilarityGeneration", "corpusSourceMatchingEnabledAtComputation"].sort(),
  );
  assert.equal(new Set(SERVER_OWNED_REPORT_PAYLOAD_KEYS).size, SERVER_OWNED_REPORT_PAYLOAD_KEYS.length);
  // nothing the server READS from a payload is on it
  for (const read of ["text", "wordCount", "archiveMatchedPositions", "archiveScore", "score", "sources", "repeats", "aiAnalysis", "aiScore", "externalAcademicEvidence", "academicEvidenceStatus", "verifiedAcademicSearchDiagnosticsId", "scoringNormalizationVersion"]) {
    assert.equal(SERVER_OWNED_REPORT_PAYLOAD_KEYS.includes(read), false, `${read} still travels`);
  }
});

test("withoutServerOwnedReportFields: a shallow copy without those keys; the same object when there is nothing to remove; the input is never mutated", () => {
  const list = words(400, 3);
  const report = browserReport("7001", list, [[20, 139], [200, 260]]);
  assert.ok(report.unifiedSimilarity && report.evidenceInterpretation && report.reportCompletion, "test setup: the browser report carries its own computed fields");
  const before = JSON.stringify(report);
  const lean = withoutServerOwnedReportFields(report);
  assert.equal(JSON.stringify(report), before, "input untouched");
  for (const key of SERVER_OWNED_REPORT_PAYLOAD_KEYS) assert.equal(key in lean, false, `${key} removed`);
  const expected = { ...report };
  for (const key of SERVER_OWNED_REPORT_PAYLOAD_KEYS) delete expected[key];
  assert.deepEqual(lean, expected, "every other field is carried exactly");
  assert.equal(lean.archiveMatchedPositions, report.archiveMatchedPositions, "shallow: the same arrays, not copies");
  assert.equal(lean.text, report.text);
  assert.equal(withoutServerOwnedReportFields(lean), lean, "nothing to remove: the very same object");
  for (const value of [null, undefined, "report", 7, [1, 2]]) assert.equal(withoutServerOwnedReportFields(value), value);
  // a key present with the value `undefined` is still removed (JSON would have dropped it anyway)
  assert.equal("unifiedSimilarity" in withoutServerOwnedReportFields({ text: "t", unifiedSimilarity: undefined }), false);
});

test("saveReportRemote: the request carries the report without the server-owned fields; the siblings read off the report (extraction completeness, supplied references) still travel, once", async () => {
  const list = words(600, 5);
  const references = [{ fileName: "ref.txt", fileType: "txt", extractedText: words(120, 9).join(" ") }];
  const report = { ...browserReport("7002", list, [[30, 189], [300, 420]]), userSuppliedReferences: references };
  const before = JSON.stringify(report);
  const { result, requests } = await captureSave(report, summaryOf(report), 2);
  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 1);
  const { body, raw } = requests[0];
  assert.equal(JSON.stringify(report), before, "the browser's own report object is unchanged (its local copy keeps everything)");
  for (const key of SERVER_OWNED_REPORT_PAYLOAD_KEYS) assert.equal(key in body.payload, false, `payload.${key} is not sent`);
  assert.deepEqual(body.payload, JSON.parse(JSON.stringify(withoutServerOwnedReportFields(report))), "everything else is sent exactly");
  assert.equal(body.payload.text, report.text);
  assert.deepEqual(body.payload.archiveMatchedPositions, report.archiveMatchedPositions);
  assert.deepEqual(body.payload.sources, report.sources);
  // siblings: read from the ORIGINAL report before the payload is prepared
  assert.deepEqual(body.extractionCompleteness, report.extractionDiagnostic, "extraction completeness still sent as the sibling");
  assert.deepEqual(body.userSuppliedReferences, references, "supplied references still sent as the sibling");
  assert.equal(raw.split(references[0].extractedText).length - 1, 1, "the reference text travels ONCE, not also inside the payload");
  assert.equal(body.room, 2);
  assert.equal(body.id, "7002");
  // and the weight that is gone
  const asBefore = JSON.stringify({ ...body, payload: JSON.parse(JSON.stringify(report)) }).length;
  assert.ok(raw.length < asBefore - JSON.stringify(report.unifiedSimilarity).length, `the request is smaller by at least the browser's unifiedSimilarity (${raw.length} vs ${asBefore})`);
});

test("THE SERVER CANNOT TELL: with every server-owned key sent, forged or absent, the real route persists the same row (same content, same size) — first save, AI resave and authoritative finalization", async () => {
  const list = words(900, 11);
  const runs = [[40, 219], [400, 520], [700, 760]];
  const sentAsToday = (id) => browserReport(id, list, runs);
  const forged = (id) => ({
    ...sentAsToday(id),
    unifiedSimilarity: { version: "unified-similarity-v1", wordCount: 900, unifiedScore: 97, uniqueMatchedWords: 870, contributions: [], matchedPositions: Array.from({ length: 870 }, (_, i) => i), previousUploadPositions: [] },
    unifiedSimilarityFailed: true, unifiedSimilarityGeneration: 999_999, corpusSourceMatchingEnabledAtComputation: false,
    evidenceInterpretation: { version: "forged", sources: [], passages: [] }, reportCompletion: { state: "COMPLETED", headline: "forged" },
    extractionDiagnostic: { completeness: "PARTIAL" }, uncertainEvidence: { passages: [{ wordStart: 0, wordEnd: 5, reason: "NON_SCORING_EVIDENCE" }] },
    userSuppliedReferenceEvidence: [{ referenceId: "forged" }], userSuppliedReferenceChannel: { state: "COMPLETED" },
    userSuppliedReferences: [{ fileName: "forged.txt", fileType: "txt", extractedText: "forged reference text" }], userSuppliedReferenceGuard: { forged: true },
  });
  const lean = (id) => withoutServerOwnedReportFields(sentAsToday(id));
  for (const key of SERVER_OWNED_REPORT_PAYLOAD_KEYS) assert.ok(key in forged("x"), `test setup: the forged payload sets ${key}`);

  const scenarios = [
    { name: "first save (AI running)", env: {}, ai: "processing" },
    { name: "AI resave (ready)", env: {}, ai: "ready" },
    { name: "compact positions gate ON", env: { REPORT_COMPACT_POSITIONS_WRITE_ENABLED: "true" }, ai: "ready" },
    { name: "authoritative Selective Corpus (pending -> finalized inline)", env: { SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED: "true", SELECTIVE_CORPUS_SHADOW_ENABLED: "true" }, ai: "ready" },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    await withEnv(scenario.env, async () => {
      const id = `800${index}`;
      const rows = {};
      // The three rows are compared whole, creation time included — and that is the server's clock at each report's
      // first save, not anything the request says. All three are therefore created at one instant of it.
      const createdAt = new Date().toISOString();
      for (const [variant, build] of [["sent as today", sentAsToday], ["forged", forged], ["lean", lean]]) {
        const acc = await account();
        const res = await atServerTime(createdAt, () => post(acc, build(id), { ai: scenario.ai }));
        assert.equal(res.status, 200, `${scenario.name} / ${variant}`);
        rows[variant] = await rawRow(acc.deviceKey, id);
        assert.ok(rows[variant], `${scenario.name} / ${variant}: persisted`);
      }
      assert.equal(canonical(rows.lean), canonical(rows["sent as today"]), `${scenario.name}: omitting the fields changes nothing that is stored`);
      assert.equal(rows.lean.length, rows["sent as today"].length, `${scenario.name}: …and the stored row is the same size`);
      assert.equal(canonical(rows.forged), canonical(rows["sent as today"]), `${scenario.name}: (control) the server never used them — a forged value is discarded the same way`);
      assert.equal(rows.forged.length, rows["sent as today"].length, `${scenario.name}: (control) …same size`);
      if (scenario.ai === "processing") assert.equal(rows.lean, rows["sent as today"], `${scenario.name}: byte-identical when no AI result is carried`);
      const stored = decodeReportFromPersistence(JSON.parse(rows.lean));
      if (scenario.name.startsWith("authoritative")) {
        assert.ok(stored.selectiveCorpusAuthoritativeStatus === "completed" || stored.selectiveCorpusAuthoritativeStatus === "incomplete", "the finalizer landed its terminal write");
      }
      assert.ok(stored.unifiedSimilarity, `${scenario.name}: the server's own unifiedSimilarity`);
      assert.equal(stored.unifiedSimilarity.uniqueMatchedWords, 180 + 121 + 61, "…computed from the archive positions the request still carries");
      assert.ok(stored.evidenceInterpretation && stored.reportCompletion, "…with its own interpretation and completion");
    });
  }
});

test("THE CASE THIS FIXES: a long document with much archive evidence is refused at the REQUEST as it was sent, and saved once the server-owned fields are left out (with positions stored as ranges)", async () => {
  // 80,000 words, 70 % archive similarity in 140-word runs.
  const list = words(80_000, 21);
  const report = browserReport("9001", list, periodicRuns(80_000, 140, 200));
  const lean = withoutServerOwnedReportFields(report);
  const sentUnits = JSON.stringify(report).length;
  const leanUnits = JSON.stringify(lean).length;
  assert.ok(sentUnits > MAX, `as sent today the payload alone is ${sentUnits} — over the ceiling`);
  assert.ok(leanUnits < MAX - 100_000, `without the server-owned fields it is ${leanUnits}`);
  assert.ok(JSON.stringify(report.unifiedSimilarity).length + JSON.stringify(report.evidenceInterpretation).length > 600_000, "the browser's unifiedSimilarity + interpretation are the difference");

  await withEnv({ REPORT_COMPACT_POSITIONS_WRITE_ENABLED: "true" }, async () => {
    const refused = await account();
    const before = await post(refused, report);
    assert.equal(before.status, 413, "as sent today: refused before the server reads the document");
    assert.ok(before.reasons.length === 1 && (before.reasons[0] === "RAW_CONTENT_LENGTH" || before.reasons[0] === "CLIENT_PAYLOAD_TOO_LARGE"), `refused by a REQUEST guard (${before.reasons})`);
    assert.equal(await rawRow(refused.deviceKey, "9001"), null);

    const saved = await account();
    const after = await post(saved, lean);
    assert.equal(after.status, 200, "lean: saved");
    const raw = await rawRow(saved.deviceKey, "9001");
    assert.ok(raw.length < MAX, `the stored row is ${raw.length}`);
    const stored = decodeReportFromPersistence(JSON.parse(raw));
    assert.equal(stored.unifiedSimilarity.unifiedScore, 70);
    assert.equal(stored.unifiedSimilarity.uniqueMatchedWords, report.archiveMatchedPositions.length);
    assert.equal(stored.unifiedSimilarity.matchedPositions.length, report.archiveMatchedPositions.length);
    assert.equal(stored.unifiedSimilarity.matchedPositions[stored.unifiedSimilarity.matchedPositions.length - 1], report.archiveMatchedPositions.at(-1));
  });
});
