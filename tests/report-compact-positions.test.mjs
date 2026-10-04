import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";

import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity, grantTestAdmin } from "./helpers/test-signup.mjs";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";
import { completeAiAnalysis } from "./helpers/complete-ai-analysis.mjs";
import { tokens } from "../lib/similarity-core.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { getCurrentCorpusMatchGeneration } from "../lib/corpus-match-generation.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import {
  compactUnifiedSimilarityForPersistence,
  expandUnifiedSimilarityFromPersistence,
  tryExpandUnifiedSimilarityFromPersistence,
  PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS,
} from "../lib/unified-similarity-persistence.ts";
import {
  decodeReportFromPersistence,
  encodeReportForPersistence,
  encodeReportJsonForPersistence,
  MAX_SERVED_REPORT_BYTES,
  readPersistedArchiveMatchedPositions,
  ReportPersistenceDecodeError,
  servedReportBytes,
  tryDecodeReportFromPersistence,
} from "../lib/report-persistence.ts";
import { buildFinalizedReportEvidenceInterpretation, withEvidenceInterpretation } from "../lib/report-evidence-interpretation.ts";
import { isCompactPositions } from "../lib/position-runs-persistence.ts";
import {
  REPORT_COMPACT_POSITIONS_WRITE_FLAG,
  isReportCompactPositionsWriteEnabled,
  resolveCompactPersistenceWrites,
  resolveCompactPositionWrites,
} from "../lib/report-compact-persistence-flag.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";
import { TERMINAL_AI_RESERVE_CHARS } from "../lib/ai-unavailable-state.ts";
import { finalizeSelectiveCorpusAuthoritativeReport } from "../lib/selective-corpus-authoritative.ts";
import { selfHealUnifiedSimilarity, persistSelectiveCorpusAuthoritativeUnstorable } from "../lib/report-primary-similarity.ts";
import { refreshSelectiveCorpusCompletionSignal } from "../lib/report-evidence-interpretation.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";

/**
 * COMPACT POSITIONS at the report persistence boundary (lib/position-runs-persistence.ts wired through
 * lib/unified-similarity-persistence.ts, lib/report-persistence.ts and the deferred Selective Corpus finalizer).
 *
 * The persisted report used to grow by ~6-7 characters per matched word, once per position array, so a STRONG result
 * on a long document crossed MAX_REPORT_SAVE_REQUEST_BYTES and was refused (413) although the document itself fit.
 * This file pins what replacing those arrays by exact run-length ranges may and may not do:
 *
 *   - gate OFF (the default): nothing about a persisted row changes;
 *   - gate ON: the row is smaller, and what every reader gets back — score, credited union, per-channel positions,
 *     contributions, interpretation, completion — is identical to the gate-OFF report, through the REAL routes;
 *   - every row written before the gate stays readable, unchanged;
 *   - the ceiling itself and its boundary behaviour are unchanged, and it is measured on what is actually stored;
 *   - a compact list that cannot be expanded exactly makes the report unreadable for every viewer and is never
 *     scored from, and a client cannot supply one.
 *
 * Real route handlers + real matcher + a real libsql file DB of its own (OS temp dir, removed afterwards).
 */

const POSITIONS_GATE = "REPORT_COMPACT_POSITIONS_WRITE_ENABLED";
const COMPACT_GATE = "REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED";
const POSITION_KEYS = ["matchedPositions", "previousUploadPositions", "userSuppliedReferencePositions", "selectiveCorpusPositions", "importedSimilarityEvidencePositions"];
const MAX = MAX_REPORT_SAVE_REQUEST_BYTES;

const workDir = mkdtempSync(path.join(tmpdir(), "compact-positions-"));
const dbFile = path.join(workDir, "compact_positions.db");
const ENV_KEYS = ["TURSO_DATABASE_URL", "CORPUS_SOURCE_MATCHING_ENABLED", POSITIONS_GATE, COMPACT_GATE, "SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED", "SELECTIVE_CORPUS_SHADOW_ENABLED", "ADMIN_EMAIL"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
for (const key of [POSITIONS_GATE, COMPACT_GATE, "SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED", "SELECTIVE_CORPUS_SHADOW_ENABLED"]) delete process.env[key];

// ---------------------------------------------------------------------------------------------------------------
// deterministic synthetic content (no real document, nothing sealed): 9-letter pseudo-words, none of them generic
// ---------------------------------------------------------------------------------------------------------------
const SYL = ["ka", "lo", "mi", "tre", "vun", "sor", "bel", "dra", "phi", "quen", "zor", "tal", "mer", "nix", "ost", "ula", "rin", "vek", "dom", "sha", "gri", "pol", "wex", "yun"];
function words(count, seed) {
  let s = seed >>> 0;
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYL[next() % SYL.length] + SYL[next() % SYL.length] + SYL[next() % SYL.length]);
  return out;
}
/** deepEqual for a long position list that fails FAST, naming the first difference (assert's own diff of a 300,000-element array takes minutes to render). */
function assertSamePositions(actual, expected, message = "positions") {
  assert.ok(Array.isArray(actual), message + ": an array");
  for (let i = 0; i < Math.min(actual.length, expected.length); i += 1) {
    if (actual[i] !== expected[i]) assert.fail(message + ": first difference at index " + i + ": " + actual[i] + " !== " + expected[i]);
  }
  assert.equal(actual.length, expected.length, message + ": length");
}
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
function unionOf(ranges) {
  const set = new Set();
  for (const [start, end] of ranges) for (let p = start; p <= end; p += 1) set.add(p);
  return [...set].sort((a, b) => a - b);
}

/**
 * THE MANUSCRIPT of the real-route scenario. Laid out so one save exercises every shape the task names:
 *   - TWELVE separate 34-word passages copied from ONE other-account document (ten are displayed, the two shortest of
 *     a tie become `additionalPassageRanges` — every one of them is credited);
 *   - three 40-word slices, EACH held by twenty other-account documents (sixty sources sharing the same positions);
 *   - client-relayed archive positions that OVERLAP a prior passage, are ADJACENT to another, and stand alone.
 */
const PASSAGE_WORDS = 34;
const SLICE_WORDS = 40;
const manuscriptWords = [];
const passageRanges = [];
const sliceRanges = [];
const copiedPassages = [];
manuscriptWords.push(...words(60, 1));
for (let k = 0; k < 12; k += 1) {
  const passage = words(PASSAGE_WORDS, 1000 + k);
  copiedPassages.push(passage);
  passageRanges.push([manuscriptWords.length, manuscriptWords.length + PASSAGE_WORDS - 1]);
  manuscriptWords.push(...passage, ...words(45, 2000 + k));
}
const sliceTexts = [];
for (let k = 0; k < 3; k += 1) {
  const slice = words(SLICE_WORDS, 3000 + k);
  sliceTexts.push(slice);
  sliceRanges.push([manuscriptWords.length, manuscriptWords.length + SLICE_WORDS - 1]);
  manuscriptWords.push(...slice, ...words(50, 4000 + k));
}
manuscriptWords.push(...words(80, 5));
const MANUSCRIPT = manuscriptWords.join(" ");
const WORD_COUNT = manuscriptWords.length;
// archive: overlaps passage 3 (starts 10 words before it, ends inside it); adjacent to passage 5 (starts the word
// after it ends); and a stand-alone stretch in the tail.
const ARCHIVE_RANGES = [
  [passageRanges[2][0] - 10, passageRanges[2][0] + 15],
  [passageRanges[4][1] + 1, passageRanges[4][1] + 30],
  [WORD_COUNT - 70, WORD_COUNT - 20],
];
const ARCHIVE_POSITIONS = unionOf(ARCHIVE_RANGES);
const EXPECTED_UNION = unionOf([...passageRanges, ...sliceRanges, ...ARCHIVE_RANGES]);
const SOURCE_A = copiedPassages.map((passage, k) => `${words(70, 6000 + k).join(" ")} ${passage.join(" ")}`).join(" ") + " " + words(90, 6999).join(" ");
const sliceDocument = (k, copy) => `${words(150, 9000 + k * 100 + copy).join(" ")} ${sliceTexts[k].join(" ")} ${words(150, 950000 + k * 100 + copy).join(" ")}`;

// A 12,000-word document that another account has already submitted, word for word (an exact resubmission).
const RESUBMITTED = words(12_000, 777).join(" ");
const RESUBMITTED_WORDS = 12_000;

// ---------------------------------------------------------------------------------------------------------------
// ALL database setup resolves here, before the first test() is registered (node:test starts a test as soon as it is
// registered, so setup must never be interleaved with registrations).
// ---------------------------------------------------------------------------------------------------------------
const db = createClient({ url: `file:${dbFile}` });
await db.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(db, path.resolve("drizzle"));

const seededUsers = new Set();
async function indexOtherAccountDocument(accountId, title, rawText) {
  if (!seededUsers.has(accountId)) {
    seededUsers.add(accountId);
    await db.execute({ sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"] });
  }
  const identity = await createDocumentIdentity(db, { accountId, title, author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(db, { documentIdentityId: identity.id, rawText });
}
await indexOtherAccountDocument("cp-source-a", "twelve passages", SOURCE_A);
for (let k = 0; k < 3; k += 1) for (let copy = 0; copy < 20; copy += 1) await indexOtherAccountDocument(`cp-slice-${k}-${copy}`, `slice ${k} ${copy}`, sliceDocument(k, copy));
await indexOtherAccountDocument("cp-resubmitted", "resubmitted", RESUBMITTED);
await matureCorpusBackings(db);

test.after(() => {
  db.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------
/** Runs `fn` with the two write gates pinned, restoring whatever was set before. `undefined` = unset (the default, OFF). */
async function withGates({ positions, compact = "true" }, fn) {
  const previous = { [POSITIONS_GATE]: process.env[POSITIONS_GATE], [COMPACT_GATE]: process.env[COMPACT_GATE] };
  const set = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  set(POSITIONS_GATE, positions);
  set(COMPACT_GATE, compact);
  try { return await fn(); } finally { set(POSITIONS_GATE, previous[POSITIONS_GATE]); set(COMPACT_GATE, previous[COMPACT_GATE]); }
}

/** Collects the report-save rejection telemetry (one JSON line on console.warn per rejection) emitted while `fn` runs. */
async function collectRejections(fn) {
  const original = console.warn;
  const reasons = [];
  console.warn = (...args) => {
    try {
      const event = JSON.parse(String(args[0]));
      if (event?.event === "report_save_rejected") { reasons.push(event.reason); return; }
    } catch { /* not a telemetry line */ }
    original(...args);
  };
  try { return { result: await fn(), reasons }; } finally { console.warn = original; }
}

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let accountCounter = 0;
async function account() {
  accountCounter += 1;
  const n = String(accountCounter).padStart(3, "0");
  await resetAuthRateForTest("cp-signup-" + n);
  const email = `cp-${n}@example.test`;
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "cp-signup-" + n },
    body: JSON.stringify(withTestIdentity({ email, password: "cp-password-123456", username: `cpuser${n}`, deviceKey: `cp-dev-${n}` })),
  }));
  assert.equal(res.status, 201, "test setup: signup");
  const row = await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] });
  return { deviceKey: `cp-dev-${n}`, cookie: cookieOf(res), tag: `cp-${n}`, email, userId: String(row.rows[0].id) };
}

// One timestamp for the whole run (never a hard-coded date): two saves of the same manuscript then send identical payloads.
const FIXED_CREATED = new Date().toISOString();
/** The save request a browser makes: `ai` "ready" (terminal, full ceiling) or "processing" (a first save: the ceiling less the AI reserve). */
function requestBody(acc, id, { text, archiveMatchedPositions = [], assignment = "", ai = "ready", room = 0, payloadExtra = {} }) {
  const wordCount = tokens(text).length;
  const aiFields = ai === "ready" ? { aiScore: 2, aiTone: "low", aiStatus: "ready" } : ai === "failed" ? { aiScore: null, aiTone: null, aiStatus: "failed" } : { aiScore: null, aiTone: null };
  return {
    deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "compact positions fixture", createdAt: FIXED_CREATED,
    wordCount, archiveScore: 0, scoreBand: "Low", ...aiFields, room,
    payload: {
      version: 11, id, submissionId: "sub-" + id, title: "compact positions fixture", author: "", assignment, created: FIXED_CREATED,
      score: 0, archiveScore: 0, wordCount, scoreBand: "Low", matchedWordCount: archiveMatchedPositions.length, archiveMatchedPositions,
      sources: [], repeats: [], text, ...(ai === "ready" ? { aiAnalysis: completeAiAnalysis() } : {}), ...payloadExtra,
    },
  };
}
let requestCounter = 0;
async function post(acc, body) {
  requestCounter += 1;
  await resetRateForTest(`${acc.tag}-post-${requestCounter}`);
  const res = await reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${acc.tag}-post-${requestCounter}`, cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(acc, id) {
  requestCounter += 1;
  await resetRateForTest(`${acc.tag}-get-${requestCounter}`);
  const res = await reportIdRoute.GET(new Request(`http://localhost/api/reports/${id}`, {
    headers: { "x-forwarded-for": `${acc.tag}-get-${requestCounter}`, cookie: `tp_session_v1=${acc.cookie}` },
  }), { params: Promise.resolve({ id }) });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
async function rawRow(deviceKey, id) {
  const r = await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  return r.rows[0] ? String(r.rows[0].payload_json) : null;
}
async function seedRow(deviceKey, id, payload) {
  await db.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey, "sub-" + id, "seeded", new Date().toISOString(), payload.wordCount, 0, "Low", JSON.stringify(payload), null, null],
  });
}
const completedShadowResult = (ranges) => ({
  state: "COMPLETED",
  ...(ranges.length > 0 ? { verifiedEvidence: [{ sourceLabel: "S1", matchedPassages: ranges.map(([s, e]) => ({ submittedWordStart: s, submittedWordEnd: e, matchedWordCount: e - s + 1 })) }] } : {}),
});

/**
 * A pending report whose FINAL form cannot be stored ends terminally with no score — "incomplete", reason
 * PERSISTENCE_LIMIT, unifiedSimilarityFailed, no unifiedSimilarity — with every other stored field exactly as it was,
 * the row within the ceiling, and a later finalizer run (what the recovery sweep would do) a clean no-op.
 */
async function assertFinalizedUnstorable(key, before, label) {
  const afterText = await rawRow(key.deviceKey, key.id);
  assert.ok(afterText.length <= MAX, `${label}: the terminal row (${afterText.length}) is within the ceiling`);
  const after = JSON.parse(afterText);
  assert.equal(after.selectiveCorpusAuthoritativeStatus, "incomplete", `${label}: terminal, no longer pending`);
  assert.equal(after.selectiveCorpusAuthoritativeIncompleteReason, "PERSISTENCE_LIMIT", label);
  assert.equal(after.unifiedSimilarityFailed, true, `${label}: similarity unavailable`);
  assert.equal("unifiedSimilarity" in after, false, `${label}: no score and no truncated evidence`);
  const rest = ({ selectiveCorpusAuthoritativeStatus, selectiveCorpusAuthoritativeIncompleteReason, selectiveCorpusAuthoritativeClaimedAt, unifiedSimilarityFailed, ...others }) => others;
  assert.deepEqual(rest(after), rest(JSON.parse(before)), `${label}: every other stored field exactly as it was`);
  const again = await finalizeSelectiveCorpusAuthoritativeReport(db, { reportDeviceKey: key.deviceKey, reportId: key.id, accountId: null, shadowResult: completedShadowResult([]) });
  assert.deepEqual(again, { outcome: "not-pending" }, `${label}: a later attempt finds nothing to do`);
  assert.equal(await rawRow(key.deviceKey, key.id), afterText, `${label}: and writes nothing`);
}

/** A unified result with every shape at once, from the real scorer: archive + two prior sources (one with 12 passages = 10 displayed + 2 additional ranges, overlapping/adjacent to the archive), a SELF source that is excluded, and user-supplied-reference + Selective Corpus channels. */
function richUnifiedSimilarity() {
  const passages = Array.from({ length: 10 }, (_, i) => ({ submittedText: "x", submittedWordStart: 1000 + i * 400, submittedWordEnd: 1000 + i * 400 + 119, matchedWordCount: 120 }));
  return computeUnifiedSimilarity({
    wordCount: 20_000,
    archiveMatchedPositions: unionOf([[900, 1050], [1120, 1180], [9000, 9400]]),
    externalAcademicEvidence: [],
    historicalSubmissionMatch: {
      status: "MATCHED", computedAt: FIXED_CREATED, matcherVersion: "t", fingerprintVersion: "t", canonicalizationVersion: "t",
      matches: [
        { relationshipType: "PRIOR_SUBMISSION", matchedRepresentationId: "rep-a", matchType: "STRONG_TEXT_MATCH", containment: 0.6, matchedWordCount: 1290, passageCount: 10, longestMatchWords: 120, passages, additionalPassageRanges: [[5200, 5244], [5600, 5644]], historicalSubmissionCount: 1 },
        { relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchedRepresentationId: "rep-b", matchType: "STRONG_TEXT_MATCH", containment: 0.5, matchedWordCount: 240, passageCount: 2, longestMatchWords: 120, passages: [passages[0], passages[3]], historicalSubmissionCount: 0 },
        { relationshipType: "SELF", matchedRepresentationId: "rep-self", matchType: "STRONG_TEXT_MATCH", containment: 0.9, matchedWordCount: 300, passageCount: 1, longestMatchWords: 300, passages: [{ submittedText: "x", submittedWordStart: 15_000, submittedWordEnd: 15_299, matchedWordCount: 300 }], historicalSubmissionCount: 0 },
      ],
    },
    userSuppliedReferenceEvidence: [{ referenceId: "ref-1", matchedPassages: [{ submittedWordStart: 12_000, submittedWordEnd: 12_199, matchedWordCount: 200 }] }],
    selectiveCorpusEvidence: [{ sourceLabel: "S1", matchedPassages: [{ submittedWordStart: 13_000, submittedWordEnd: 13_149, matchedWordCount: 150 }] }],
  });
}

// ===============================================================================================================
// 0. the write gate
// ===============================================================================================================
test("THE GATE: OFF unless REPORT_COMPACT_POSITIONS_WRITE_ENABLED is exactly \"true\", read fresh on every call, independent of the C2 gate, and documented", () => {
  assert.equal(REPORT_COMPACT_POSITIONS_WRITE_FLAG, POSITIONS_GATE);
  const previous = { [POSITIONS_GATE]: process.env[POSITIONS_GATE], [COMPACT_GATE]: process.env[COMPACT_GATE] };
  try {
    delete process.env[POSITIONS_GATE];
    assert.equal(isReportCompactPositionsWriteEnabled(), false, "unset => OFF");
    for (const value of ["", "1", "TRUE", "True", "yes", " true", "true ", "false"]) {
      process.env[POSITIONS_GATE] = value;
      assert.equal(isReportCompactPositionsWriteEnabled(), false, JSON.stringify(value) + " => OFF");
    }
    process.env[POSITIONS_GATE] = "true";
    assert.equal(isReportCompactPositionsWriteEnabled(), true);
    // an explicit option pins it either way; omitted follows the flag
    assert.equal(resolveCompactPositionWrites({ compactPositions: false }), false);
    assert.equal(resolveCompactPositionWrites({}), true);
    assert.equal(resolveCompactPositionWrites(), true);
    // the two gates never read each other
    delete process.env[COMPACT_GATE];
    assert.equal(resolveCompactPersistenceWrites(), false, "the positions gate does not open the C2 gate");
    delete process.env[POSITIONS_GATE];
    process.env[COMPACT_GATE] = "true";
    assert.equal(resolveCompactPositionWrites(), false, "the C2 gate does not open the positions gate");
    assert.equal(resolveCompactPositionWrites({ compactWrites: true }), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(envExample, new RegExp("^" + POSITIONS_GATE + "=$", "m"), "documented in .env.example with an empty (OFF) value");
});

// ===============================================================================================================
// 1. the unified-similarity codec
// ===============================================================================================================
test("GATE OFF (the default): a persisted unifiedSimilarity is exactly what it was — every position list a plain array", () => {
  const unified = richUnifiedSimilarity();
  assert.ok(unified.matchedPositions.length > 1500 && unified.previousUploadPositions.length > 0 && unified.userSuppliedReferencePositions.length === 200 && unified.selectiveCorpusPositions.length === 150, "test setup: a result with several channels");
  for (const compactWrites of [false, true]) {
    const implicit = compactUnifiedSimilarityForPersistence(unified, { compactWrites });
    const explicit = compactUnifiedSimilarityForPersistence(unified, { compactWrites, compactPositions: false });
    assert.equal(JSON.stringify(implicit), JSON.stringify(explicit), "unset gate == OFF");
    for (const key of POSITION_KEYS) assert.ok(Array.isArray(implicit[key]), `${key} stays an array`);
    assert.deepEqual(implicit.matchedPositions, unified.matchedPositions);
  }
  // and the env gate, read fresh on every call, is what "unset" follows
  process.env[POSITIONS_GATE] = "TRUE"; // only the exact string "true" opens it
  try { assert.ok(Array.isArray(compactUnifiedSimilarityForPersistence(unified).matchedPositions)); } finally { delete process.env[POSITIONS_GATE]; }
  process.env[POSITIONS_GATE] = "true";
  try { assert.ok(isCompactPositions(compactUnifiedSimilarityForPersistence(unified).matchedPositions)); } finally { delete process.env[POSITIONS_GATE]; }
});

test("GATE ON: every position list is persisted as ranges and expands to the IDENTICAL result — score, union, per-channel subsets, contributions (10 displayed passages + additional ranges, overlapping and adjacent ranges, sources sharing positions)", () => {
  const unified = richUnifiedSimilarity();
  const before = JSON.stringify(unified);
  for (const compactWrites of [false, true]) {
    const persisted = compactUnifiedSimilarityForPersistence(unified, { compactWrites, compactPositions: true });
    assert.equal(JSON.stringify(unified), before, "the runtime result is never mutated");
    for (const key of ["matchedPositions", "previousUploadPositions", "userSuppliedReferencePositions", "selectiveCorpusPositions"]) {
      assert.ok(isCompactPositions(persisted[key]), `${key} is compact`);
      assert.equal(persisted[key].count, unified[key].length);
    }
    assert.deepEqual(persisted.importedSimilarityEvidencePositions, [], "an empty list stays the empty array");
    assert.equal(Object.keys(persisted).join(), Object.keys(compactUnifiedSimilarityForPersistence(unified, { compactWrites, compactPositions: false })).join(), "same keys in the same order as the array form");
    assert.ok(JSON.stringify(persisted).length * 4 < JSON.stringify(compactUnifiedSimilarityForPersistence(unified, { compactWrites, compactPositions: false })).length, "and several times smaller");

    const expansion = tryExpandUnifiedSimilarityFromPersistence(JSON.parse(JSON.stringify(persisted)));
    assert.equal(expansion.status, "expanded");
    assert.deepEqual(expansion.value, unified, "decode(new) == the result that was computed");
    // …and byte for byte what a reader got from the array form of the same row, key order included: nothing downstream can tell them apart
    const fromArrays = tryExpandUnifiedSimilarityFromPersistence(JSON.parse(JSON.stringify(compactUnifiedSimilarityForPersistence(unified, { compactWrites, compactPositions: false }))));
    assert.equal(JSON.stringify(expansion.value), JSON.stringify(fromArrays.value));
    assert.equal(expansion.value.unifiedScore, unified.unifiedScore);
    assert.equal(expansion.value.uniqueMatchedWords, expansion.value.matchedPositions.length);
    assert.deepEqual(expandUnifiedSimilarityFromPersistence(JSON.parse(JSON.stringify(persisted))), unified);
  }
});

test("GATE ON + the older elision: a previous-upload-only result keeps its `previousUploadPositionsEncoding` marker beside a compact matchedPositions, and both arrays come back", () => {
  const unified = computeUnifiedSimilarity({
    wordCount: 50_000,
    historicalSubmissionMatch: {
      status: "MATCHED", computedAt: FIXED_CREATED, matcherVersion: "t", fingerprintVersion: "t", canonicalizationVersion: "t",
      matches: [{ relationshipType: "PRIOR_SUBMISSION", matchedRepresentationId: "rep-x", matchType: "EXACT_CANONICAL_MATCH", containment: 1, matchedWordCount: 50_000, passageCount: 0, longestMatchWords: 50_000, passages: [], historicalSubmissionCount: 1 }],
    },
  });
  assert.equal(unified.unifiedScore, 100);
  assert.equal(unified.matchedPositions.length, 50_000);
  const arrayForm = compactUnifiedSimilarityForPersistence(unified, { compactWrites: true, compactPositions: false });
  const persisted = compactUnifiedSimilarityForPersistence(unified, { compactWrites: true, compactPositions: true });
  assert.equal(persisted.previousUploadPositionsEncoding, PREVIOUS_UPLOAD_POSITIONS_ENCODING_MATCHED_POSITIONS);
  assert.equal("previousUploadPositions" in persisted, false);
  assert.ok(isCompactPositions(persisted.matchedPositions), "the whole-document union is persisted as ranges");
  assert.deepEqual(persisted.matchedPositions, { format: "compact", formatVersion: 1, count: 50_000, runs: [0, 50_000] });
  assert.ok(JSON.stringify(arrayForm).length > 280_000, "the array form of a whole-document match costs one number per word");
  assert.ok(JSON.stringify(persisted).length < 1_500, "the same evidence as ranges does not grow with the document");
  const expanded = tryExpandUnifiedSimilarityFromPersistence(JSON.parse(JSON.stringify(persisted)));
  assert.equal(expanded.status, "expanded");
  assert.equal(expanded.value.unifiedScore, 100);
  assertSamePositions(expanded.value.matchedPositions, unified.matchedPositions);
  assertSamePositions(expanded.value.previousUploadPositions, unified.previousUploadPositions);
  assert.deepEqual(expanded.value, unified);
  assert.notEqual(expanded.value.previousUploadPositions, expanded.value.matchedPositions, "two arrays, not one shared reference");
});

test("FAIL CLOSED: a compact position list that cannot be expanded exactly makes the WHOLE report unreadable — for a customer and for an admin alike — and is never emptied or shortened", () => {
  const unified = richUnifiedSimilarity();
  const report = { version: 11, id: 1, text: "t", wordCount: 20_000, archiveMatchedPositions: unionOf([[900, 1050], [1120, 1180], [9000, 9400]]), sources: [], repeats: [], unifiedSimilarity: unified };
  const good = JSON.stringify(encodeReportForPersistence(report, { compactWrites: true, compactPositions: true }));
  assert.equal(tryDecodeReportFromPersistence(JSON.parse(good)).ok, true, "control: the undamaged row decodes");

  const damage = {
    "count short of the runs": (list) => { list.count -= 1; },
    "count beyond the runs": (list) => { list.count += 7; },
    "a run dropped": (list) => { list.runs = list.runs.slice(0, -2); },
    "a run lengthened": (list) => { list.runs[1] += 1; },
    "runs emptied": (list) => { list.runs = []; },
    "runs not an array": (list) => { list.runs = "0,5"; },
    "a non-canonical gap": (list) => { list.runs[2] = 0; },
  };
  const silenced = console.error;
  console.error = () => {};
  try {
    for (const target of ["archiveMatchedPositions", ...POSITION_KEYS.filter((key) => key !== "importedSimilarityEvidencePositions")]) {
      for (const [name, mutate] of Object.entries(damage)) {
        const row = JSON.parse(good);
        const list = target === "archiveMatchedPositions" ? row.archiveMatchedPositions : row.unifiedSimilarity[target];
        assert.ok(isCompactPositions(list), `test setup: ${target} is compact`);
        mutate(list);
        for (const requireContributions of [true, false]) {
          assert.deepEqual(tryDecodeReportFromPersistence(row, { requireContributions }), { ok: false, reason: "corrupt_matched_positions" }, `${target}: ${name}`);
        }
        assert.throws(() => decodeReportFromPersistence(row), ReportPersistenceDecodeError);
      }
      // a version this reader does not know (a newer writer during a rolling deploy) is named as such
      const newer = JSON.parse(good);
      (target === "archiveMatchedPositions" ? newer.archiveMatchedPositions : newer.unifiedSimilarity[target]).formatVersion = 2;
      assert.deepEqual(tryDecodeReportFromPersistence(newer, { requireContributions: false }), { ok: false, reason: "unsupported_compact_format" });
      const otherFamily = JSON.parse(good);
      if (target === "archiveMatchedPositions") otherFamily.archiveMatchedPositions = { format: "bitmap-v1", data: "AAAA" };
      else otherFamily.unifiedSimilarity[target] = { format: "bitmap-v1", data: "AAAA" };
      assert.deepEqual(tryDecodeReportFromPersistence(otherFamily, { requireContributions: false }), { ok: false, reason: "unsupported_compact_format" });
    }
    // the codec-level view of the same thing
    const persisted = JSON.parse(good).unifiedSimilarity;
    persisted.matchedPositions.count += 1;
    assert.deepEqual(tryExpandUnifiedSimilarityFromPersistence(persisted), { status: "positions-unreadable", reason: "COUNT_MISMATCH" });
    assert.throws(() => expandUnifiedSimilarityFromPersistence(persisted), /positions are unreadable/);
    // the internal readers that feed stored archive positions back into scoring throw rather than score without them
    const stored = JSON.parse(good);
    stored.archiveMatchedPositions.count -= 3;
    assert.throws(() => readPersistedArchiveMatchedPositions(stored), ReportPersistenceDecodeError);
  } finally {
    console.error = silenced;
  }
});

// ===============================================================================================================
// 2. the whole-report codec: old rows, every write mode
// ===============================================================================================================
test("OLD REPORTS: every earlier persisted shape decodes to exactly the report it always did, and decoding never rewrites it", () => {
  const unified = richUnifiedSimilarity();
  const runtime = withEvidenceInterpretation(
    { version: 11, id: 7, submissionId: "s", title: "t", author: "", assignment: "", created: FIXED_CREATED, score: 3, archiveScore: 3, wordCount: 20_000, scoreBand: "Low", matchedWordCount: 613, archiveMatchedPositions: unionOf([[900, 1050], [1120, 1180], [9000, 9400]]), sources: [], repeats: [], text: words(20_000, 42).join(" "), unifiedSimilarity: unified },
    { selectiveCorpusBranch: null },
  );
  const shapes = {
    "pre-compaction row (everything expanded)": runtime,
    "legacy write (elision only, gate OFF)": encodeReportForPersistence(runtime, { compactWrites: false, compactPositions: false }),
    "C2 compact row (contributions + interpretation)": encodeReportForPersistence(runtime, { compactWrites: true, compactPositions: false }),
    "compact positions without C2": encodeReportForPersistence(runtime, { compactWrites: false, compactPositions: true }),
    "compact positions with C2": encodeReportForPersistence(runtime, { compactWrites: true, compactPositions: true }),
  };
  const sizes = {};
  for (const [name, persisted] of Object.entries(shapes)) {
    const stored = JSON.stringify(persisted);
    sizes[name] = stored.length;
    const decoded = tryDecodeReportFromPersistence(JSON.parse(stored));
    assert.equal(decoded.ok, true, name);
    assert.deepEqual(decoded.report, runtime, `${name}: decodes to the same runtime report`);
    assert.equal(JSON.stringify(decoded.report.unifiedSimilarity.matchedPositions), JSON.stringify(unified.matchedPositions));
  }
  // an array row is passed through untouched: the decoder hands back the very arrays it was given (no copy, no validation)
  const parsed = JSON.parse(JSON.stringify(shapes["legacy write (elision only, gate OFF)"]));
  const decoded = tryDecodeReportFromPersistence(parsed);
  assert.equal(decoded.report.archiveMatchedPositions, parsed.archiveMatchedPositions);
  assert.equal(decoded.report.unifiedSimilarity.matchedPositions, parsed.unifiedSimilarity.matchedPositions);
  assert.equal(readPersistedArchiveMatchedPositions(parsed), parsed.archiveMatchedPositions);
  assert.equal(readPersistedArchiveMatchedPositions({}), undefined);
  // a report with no positions anywhere (a pre-unified row) is unaffected
  assert.deepEqual(tryDecodeReportFromPersistence({ version: 11, text: "t", sources: [] }), { ok: true, report: { version: 11, text: "t", sources: [] } });
  assert.ok(sizes["compact positions with C2"] < sizes["C2 compact row (contributions + interpretation)"]);
  assert.ok(sizes["compact positions without C2"] < sizes["legacy write (elision only, gate OFF)"]);
});

test("ENCODE: only a real array is ever replaced — a missing, empty, short or unrepresentable archive list is persisted as it is", () => {
  const base = { version: 11, text: "t", wordCount: 9, sources: [], repeats: [] };
  const on = { compactWrites: true, compactPositions: true };
  assert.equal("archiveMatchedPositions" in encodeReportForPersistence(base, on), false);
  assert.deepEqual(encodeReportForPersistence({ ...base, archiveMatchedPositions: [] }, on).archiveMatchedPositions, []);
  assert.deepEqual(encodeReportForPersistence({ ...base, archiveMatchedPositions: [1, 2, 3] }, on).archiveMatchedPositions, [1, 2, 3]);
  const unsorted = [...range(50, 300), ...range(0, 40)];
  assert.deepEqual(encodeReportForPersistence({ ...base, archiveMatchedPositions: unsorted }, on).archiveMatchedPositions, unsorted, "a client-relayed list that is not sorted is kept verbatim");
  const input = { ...base, archiveMatchedPositions: range(0, 400) };
  const encoded = encodeReportForPersistence(input, on);
  assert.ok(isCompactPositions(encoded.archiveMatchedPositions));
  assert.deepEqual(input.archiveMatchedPositions, range(0, 400), "the runtime report is not mutated");
  assert.deepEqual(encodeReportForPersistence(input, { compactWrites: true, compactPositions: false }).archiveMatchedPositions, range(0, 400));
});

// ===============================================================================================================
// 3. the real routes
// ===============================================================================================================
test("REAL POST + GET: the same manuscript saved with the gate OFF and ON returns the IDENTICAL report — exact score, exact credited union, per-channel positions, interpretation and completion — while the stored row holds ranges", async () => {
  const off = await account();
  const on = await account();
  const id = "real-match-1";
  const save = (acc) => post(acc, requestBody(acc, id, { text: MANUSCRIPT, archiveMatchedPositions: ARCHIVE_POSITIONS }));

  assert.equal((await withGates({ positions: undefined }, () => save(off))).status, 200);
  assert.equal((await withGates({ positions: "true" }, () => save(on))).status, 200);

  const rawOff = JSON.parse(await rawRow(off.deviceKey, id));
  const rawOn = JSON.parse(await rawRow(on.deviceKey, id));
  // gate OFF: arrays, exactly as before
  assert.ok(Array.isArray(rawOff.archiveMatchedPositions) && Array.isArray(rawOff.unifiedSimilarity.matchedPositions) && Array.isArray(rawOff.unifiedSimilarity.previousUploadPositions));
  // gate ON: ranges
  assert.ok(isCompactPositions(rawOn.archiveMatchedPositions), "the stored archive positions are ranges");
  assert.ok(isCompactPositions(rawOn.unifiedSimilarity.matchedPositions), "the stored union is ranges");
  assert.ok(isCompactPositions(rawOn.unifiedSimilarity.previousUploadPositions), "the stored previous-upload subset is ranges");
  assert.ok(JSON.stringify(rawOn).length < JSON.stringify(rawOff).length);
  // and the two rows are the same report
  assert.deepEqual(decodeReportFromPersistence(rawOn), decodeReportFromPersistence(rawOff), "decode(gate ON row) == decode(gate OFF row)");
  assert.equal(JSON.stringify(decodeReportFromPersistence(rawOn)), JSON.stringify(decodeReportFromPersistence(rawOff)), "…byte for byte");

  const unified = decodeReportFromPersistence(rawOn).unifiedSimilarity;
  // the credited union, derived independently from where the copied text sits in the manuscript
  assert.deepEqual(unified.matchedPositions, EXPECTED_UNION, "every credited position: 12 passages of one source, 3 slices shared by 60 sources, and the archive ranges");
  assert.equal(unified.uniqueMatchedWords, EXPECTED_UNION.length);
  assert.equal(unified.unifiedScore, rawOff.unifiedSimilarity.unifiedScore);
  const sourceA = unified.contributions.filter((c) => c.evidenceStatus === "included" && passageRanges.some(([s]) => s === c.submittedWordStart));
  assert.equal(new Set(sourceA.map((c) => c.sourceId)).size, 1, "the twelve passages belong to one source");
  assert.equal(sourceA.length, 12, "all twelve passages of that source are credited (ten displayed + two additional ranges)");
  assert.equal(new Set(unified.contributions.filter((c) => c.sourceType === "previous_upload").map((c) => c.sourceId)).size, 61, "61 verified sources: the 12-passage document and 3 x 20 slice holders");

  // what the customer receives is the public shape, identical either way, with no trace of the persisted form
  const getOff = await get(off, id);
  const getOn = await get(on, id);
  assert.equal(getOff.status, 200);
  assert.equal(getOn.status, 200);
  assert.deepEqual(getOn.json.payload, getOff.json.payload, "GET returns the same report");
  assert.equal(JSON.stringify(getOn.json.payload), JSON.stringify(getOff.json.payload), "…byte for byte, key order included");
  for (const key of POSITION_KEYS) assert.ok(Array.isArray(getOn.json.payload.unifiedSimilarity[key]), `GET ${key} is an array`);
  assert.ok(Array.isArray(getOn.json.payload.archiveMatchedPositions));
  assert.deepEqual(getOn.json.payload.unifiedSimilarity.matchedPositions, EXPECTED_UNION);
  assert.deepEqual(getOn.json.payload.archiveMatchedPositions, ARCHIVE_POSITIONS);
  assert.equal(getOn.text.includes('"runs"'), false, "no compact tuple reaches a response");
  assert.equal(getOn.text.includes('"formatVersion"'), false, "no format marker reaches a response");
  assert.equal(getOn.json.payload.reportCompletion.state, "COMPLETED");
  assert.equal(getOn.json.payload.reportCompletion.signals.priorSubmission, "COMPLETE");

  // the room tile reads the row through SQL only: a compact union is still "position evidence"
  const occupant = await findRoomOccupant(db, on.userId, 0);
  assert.equal(occupant.report?.similarityStatus, "resolved");
  assert.equal(occupant.report?.primaryScore, unified.unifiedScore);
  assert.deepEqual(occupant.report, (await findRoomOccupant(db, off.userId, 0)).report, "the room summary is the same for both rows");

  // NO MIGRATION: reading a historical array row with the gate ON never rewrites it…
  const arrayRowBefore = await rawRow(off.deviceKey, id);
  assert.equal((await withGates({ positions: "true" }, () => get(off, id))).status, 200);
  assert.equal(await rawRow(off.deviceKey, id), arrayRowBefore, "a read leaves the stored row byte-identical");
  // …a later whole-report save by its owner stores it in the current form (the existing policy: a save replaces the payload)…
  assert.equal((await withGates({ positions: "true" }, () => save(off))).status, 200);
  const healed = JSON.parse(await rawRow(off.deviceKey, id));
  assert.ok(isCompactPositions(healed.unifiedSimilarity.matchedPositions) && isCompactPositions(healed.archiveMatchedPositions), "re-saved with the gate ON: ranges");
  assert.equal(JSON.stringify(decodeReportFromPersistence(healed)), JSON.stringify(decodeReportFromPersistence(rawOn)), "the same report");
  // …and STOP is safe: with the gate OFF again a save writes arrays, and rows already written as ranges stay readable.
  assert.equal((await withGates({ positions: undefined }, () => save(on))).status, 200);
  const reverted = JSON.parse(await rawRow(on.deviceKey, id));
  assert.ok(Array.isArray(reverted.unifiedSimilarity.matchedPositions) && Array.isArray(reverted.archiveMatchedPositions), "re-saved with the gate OFF: arrays");
  assert.equal(JSON.stringify(decodeReportFromPersistence(reverted)), JSON.stringify(decodeReportFromPersistence(rawOn)));
  const stillReadable = await withGates({ positions: undefined }, () => get(off, id));
  assert.equal(stillReadable.status, 200, "a range row is served with the gate OFF");
  assert.equal(JSON.stringify(stillReadable.json.payload), JSON.stringify(getOff.json.payload));
});

test("REAL GET as an ADMIN: the diagnostics an admin is served (contributions, the historical match) come from a compact-positions row unchanged", async () => {
  const admin = await account();
  await grantTestAdmin(dbFile, admin.email);
  const id = "real-match-admin";
  assert.equal((await withGates({ positions: "true" }, () => post(admin, requestBody(admin, id, { text: MANUSCRIPT, archiveMatchedPositions: ARCHIVE_POSITIONS })))).status, 200);
  const raw = JSON.parse(await rawRow(admin.deviceKey, id));
  assert.ok(isCompactPositions(raw.unifiedSimilarity.matchedPositions));
  const res = await get(admin, id);
  assert.equal(res.status, 200);
  assert.equal(res.json.payload.viewerIsAdmin, true);
  assert.deepEqual(res.json.payload.unifiedSimilarity.matchedPositions, EXPECTED_UNION);
  assert.equal(res.json.payload.unifiedSimilarity.contributions.filter((c) => c.sourceType === "previous_upload").length, 12 + 60, "one contribution per credited passage");
  assert.equal(res.text.includes('"runs"'), false);
});

test("THE CASE THIS FIXES: a whole-document match near the ceiling is refused with arrays (413, nothing stored) and saved with ranges — with the same score and the same credited positions as the unpadded control", async () => {
  // Control: the 12,000-word exact resubmission, unpadded, gate OFF — the reference result.
  const control = await account();
  assert.equal((await withGates({ positions: undefined }, () => post(control, requestBody(control, "resubmit-ctl", { text: RESUBMITTED })))).status, 200);
  const controlRaw = await rawRow(control.deviceKey, "resubmit-ctl");
  const controlUnified = decodeReportFromPersistence(JSON.parse(controlRaw)).unifiedSimilarity;
  assert.equal(controlUnified.unifiedScore, 100);
  assertSamePositions(controlUnified.matchedPositions, range(0, RESUBMITTED_WORDS - 1));
  const positionsCost = JSON.stringify(controlUnified.matchedPositions).length;
  assert.ok(positionsCost > 60_000, "the union of a 12,000-word match is ~65,000 characters as an array");

  // The same report, with other content (here: a long `assignment` field) bringing the request to within 20,000
  // characters of the ceiling. Nothing about the similarity result differs.
  const pad = MAX - 20_000 - (controlRaw.length - positionsCost);
  const body = (acc) => requestBody(acc, "resubmit-pad", { text: RESUBMITTED, assignment: "x".repeat(pad) });

  const refused = await account();
  const { result: offResult, reasons } = await collectRejections(() => withGates({ positions: undefined }, () => post(refused, body(refused))));
  assert.ok(JSON.stringify(body(refused)).length < MAX, "the REQUEST fits the ceiling");
  assert.equal(offResult.status, 413, "arrays: the persisted report is over the ceiling because of the matched positions alone");
  assert.deepEqual(offResult.body, { error: "Payload too large" });
  assert.deepEqual(reasons, ["PERSISTED_PAYLOAD_TOO_LARGE"]);
  assert.equal(await rawRow(refused.deviceKey, "resubmit-pad"), null, "nothing persisted");

  const saved = await account();
  assert.equal((await withGates({ positions: "true" }, () => post(saved, body(saved)))).status, 200, "ranges: the same report is saved");
  const savedRaw = await rawRow(saved.deviceKey, "resubmit-pad");
  assert.ok(savedRaw.length <= MAX - 19_000 && savedRaw.length >= MAX - 21_000, `the stored row (${savedRaw.length}) is the request plus a few hundred characters of evidence, not plus one number per matched word`);
  const savedUnified = decodeReportFromPersistence(JSON.parse(savedRaw)).unifiedSimilarity;
  assertSamePositions(savedUnified.matchedPositions, controlUnified.matchedPositions, "the credited union");
  assertSamePositions(savedUnified.previousUploadPositions, controlUnified.previousUploadPositions, "the previous-upload subset");
  assert.equal(JSON.stringify(savedUnified), JSON.stringify(controlUnified), "identical unified result: score, union, contributions");
  const res = await get(saved, "resubmit-pad");
  assert.equal(res.status, 200);
  assert.equal(res.json.payload.unifiedSimilarity.unifiedScore, 100);
  assertSamePositions(res.json.payload.unifiedSimilarity.matchedPositions, range(0, RESUBMITTED_WORDS - 1));
  assertSamePositions(res.json.payload.unifiedSimilarity.previousUploadPositions, range(0, RESUBMITTED_WORDS - 1));
});

test("THE CEILING IS UNCHANGED: 1,999,999 and 2,000,000 are stored, 2,000,001 is refused 413 with nothing persisted — and a first save (AI still running) keeps its reserve — gate OFF and ON alike", async () => {
  const TEXT = "A short genuine manuscript about coastal erosion patterns that matches nothing in this corpus at all and only exists to carry a padded field.";
  for (const positions of [undefined, "true"]) {
    await withGates({ positions }, async () => {
      const generationBefore = await getCurrentCorpusMatchGeneration(db);
      for (const { ai, ceiling } of [{ ai: "failed", ceiling: MAX }, { ai: "processing", ceiling: MAX - TERMINAL_AI_RESERVE_CHARS }]) {
        const label = `gate ${positions ?? "off"}, ai ${ai}`;
        const save = async (id, padLength) => {
          const acc = await account();
          const { result, reasons } = await collectRejections(() => post(acc, requestBody(acc, id, { text: TEXT, assignment: "x".repeat(padLength), ai })));
          return { ...result, reasons, raw: await rawRow(acc.deviceKey, id) };
        };
        // calibrate once: how long is the persisted row for a given pad?
        const calibration = await save("bnd-0", 1000);
        assert.equal(calibration.status, 200, label);
        const padFor = (target) => 1000 + (target - calibration.raw.length);

        const under = await save("bnd-1", padFor(ceiling - 1));
        assert.equal(under.status, 200, `${label}: one under the ceiling`);
        assert.equal(under.raw.length, ceiling - 1, `${label}: the stored row is exactly one under`);

        const at = await save("bnd-2", padFor(ceiling));
        assert.equal(at.status, 200, `${label}: exactly at the ceiling`);
        assert.equal(at.raw.length, ceiling, `${label}: the stored row is exactly the ceiling`);
        assert.doesNotThrow(() => JSON.parse(at.raw), "valid JSON");

        const over = await save("bnd-3", padFor(ceiling + 1));
        assert.equal(over.status, 413, `${label}: one over the ceiling`);
        assert.deepEqual(over.body, { error: "Payload too large" });
        assert.deepEqual(over.reasons, ["PERSISTED_PAYLOAD_TOO_LARGE"], `${label}: refused by the persisted-size check, not a request guard`);
        assert.equal(over.raw, null, `${label}: nothing persisted — no partial row, no truncated evidence`);
      }
      assert.equal(await getCurrentCorpusMatchGeneration(db), generationBefore, "test setup: nothing moved the corpus generation mid-calibration");
    });
  }
});

test("TRUST BOUNDARY: a browser cannot supply the persisted range form — a `format`-marked archive list is refused 400 before anything is read or written", async () => {
  const acc = await account();
  for (const forged of [
    { format: "compact", formatVersion: 1, count: 2_000_000, runs: [0, 2_000_000] },
    { format: "compact", formatVersion: 1, count: 5, runs: [0, 5] },
    { format: "anything" },
  ]) {
    for (const positions of [undefined, "true"]) {
      const body = requestBody(acc, "forged-1", { text: MANUSCRIPT });
      body.payload.archiveMatchedPositions = forged;
      const { result, reasons } = await collectRejections(() => withGates({ positions }, () => post(acc, body)));
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: "Invalid matched positions" });
      assert.deepEqual(reasons, ["MALFORMED_REQUEST"]);
      assert.equal(await rawRow(acc.deviceKey, "forged-1"), null, "nothing persisted");
    }
  }
  // a forged compact list inside a client `unifiedSimilarity` is simply discarded with the rest of that object, as always
  const body = requestBody(acc, "forged-2", { text: MANUSCRIPT, archiveMatchedPositions: ARCHIVE_POSITIONS, payloadExtra: { unifiedSimilarity: { version: "unified-similarity-v1", wordCount: 5, unifiedScore: 99, uniqueMatchedWords: 2_000_000, matchedPositions: { format: "compact", formatVersion: 1, count: 2_000_000, runs: [0, 2_000_000] }, contributions: [] } } });
  assert.equal((await withGates({ positions: "true" }, () => post(acc, body))).status, 200);
  const stored = decodeReportFromPersistence(JSON.parse(await rawRow(acc.deviceKey, "forged-2")));
  assert.deepEqual(stored.unifiedSimilarity.matchedPositions, EXPECTED_UNION, "the server's own union, not the forged one");
});

test("A DAMAGED STORED ROW is refused by the real GET (generic 503) for its owner — never served with fewer positions — and an undamaged neighbour is unaffected", async () => {
  const acc = await account();
  assert.equal((await withGates({ positions: "true" }, () => post(acc, requestBody(acc, "damaged-1", { text: MANUSCRIPT, archiveMatchedPositions: ARCHIVE_POSITIONS })))).status, 200);
  assert.equal((await get(acc, "damaged-1")).status, 200, "control: readable before the damage");
  await db.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.unifiedSimilarity.matchedPositions.count', 17) WHERE device_key = ? AND id = ?", args: [acc.deviceKey, "damaged-1"] });
  const silenced = console.error;
  console.error = () => {};
  try {
    const res = await get(acc, "damaged-1");
    assert.equal(res.status, 503);
    assert.equal(res.text.includes("matchedPositions"), false, "the refusal carries no report content");
    assert.equal(res.text.includes(String(EXPECTED_UNION.length)), false);
  } finally {
    console.error = silenced;
  }
});

// ===============================================================================================================
// 4. the internal readers that score from a stored row
// ===============================================================================================================
/** A pending authoritative row as POST stores it: no unifiedSimilarity yet, the interpretation built from the archive positions. */
function pendingPayload({ text, wordCount, archiveMatchedPositions, compactPositions, extra = {} }) {
  const runtime = withEvidenceInterpretation(
    { version: 11, id: 1, submissionId: "s", title: "seeded", author: "", assignment: "", created: FIXED_CREATED, score: 0, archiveScore: 0, wordCount, scoreBand: "Low", matchedWordCount: archiveMatchedPositions.length, archiveMatchedPositions, sources: [], repeats: [], text, academicEvidenceStatus: "COMPLETE_NO_MATCHES" },
    { selectiveCorpusBranch: null },
  );
  return { ...encodeReportForPersistence(runtime, { compactWrites: true, compactPositions }), selectiveCorpusAuthoritativeStatus: "pending", ...extra };
}

test("DEFERRED FINALIZER: a pending row whose archive positions are stored as ranges is finalized to the SAME final report as the array row — the stored list is expanded for scoring, left as stored, and the new union is written as ranges", async () => {
  const text = words(3000, 31).join(" ");
  const archive = unionOf([[100, 900], [905, 1400], [2500, 2600]]);
  const shadow = completedShadowResult([[1350, 1500], [2000, 2100]]); // overlaps the archive, and stands alone
  const outcomes = {};
  for (const [name, positions] of [["arrays", undefined], ["ranges", "true"]]) {
    await withGates({ positions }, async () => {
      const key = { deviceKey: `cp-fin-${name}`, id: `fin-${name}` };
      await seedRow(key.deviceKey, key.id, pendingPayload({ text, wordCount: 3000, archiveMatchedPositions: archive, compactPositions: positions === "true" }));
      const storedArchiveBefore = JSON.stringify(JSON.parse(await rawRow(key.deviceKey, key.id)).archiveMatchedPositions);
      const result = await finalizeSelectiveCorpusAuthoritativeReport(db, { reportDeviceKey: key.deviceKey, reportId: key.id, accountId: null, shadowResult: shadow });
      assert.deepEqual(result, { outcome: "finalized", status: "completed" }, name);
      const raw = JSON.parse(await rawRow(key.deviceKey, key.id));
      assert.equal(JSON.stringify(raw.archiveMatchedPositions), storedArchiveBefore, `${name}: the finalizer never rewrites the archive positions`);
      assert.equal(isCompactPositions(raw.archiveMatchedPositions), positions === "true");
      assert.equal(isCompactPositions(raw.unifiedSimilarity.matchedPositions), positions === "true");
      assert.equal(isCompactPositions(raw.unifiedSimilarity.selectiveCorpusPositions), positions === "true");
      outcomes[name] = decodeReportFromPersistence(raw);
    });
  }
  assert.deepEqual(outcomes.ranges, outcomes.arrays, "identical final report");
  assert.deepEqual(outcomes.ranges.unifiedSimilarity.matchedPositions, unionOf([[100, 900], [905, 1500], [2000, 2100], [2500, 2600]]));
  assert.deepEqual(outcomes.ranges.unifiedSimilarity.selectiveCorpusPositions, unionOf([[1401, 1500], [2000, 2100]]), "the Selective Corpus's exclusive subset");
  assert.equal(outcomes.ranges.selectiveCorpusAuthoritativeStatus, "completed");
});

test("DEFERRED FINALIZER size check: the final report is measured AS STORED — a near-ceiling row whose archive positions are stored as ranges is finalized, and ends with no score (incomplete, PERSISTENCE_LIMIT) when the final union would be written as arrays", async () => {
  // A 60,000-word document that is entirely an archive match, with other content bringing the stored pending row to
  // 3,000 characters under the ceiling. Its archive positions cost ~349,000 characters as an array and ~60 as ranges.
  const text = words(60_000, 61).join(" ");
  const archive = range(0, 59_999);
  const arrayCost = JSON.stringify(archive).length;
  assert.ok(arrayCost > 300_000);
  const seed = async (key) => {
    const payload = pendingPayload({ text, wordCount: 60_000, archiveMatchedPositions: archive, compactPositions: true, extra: { testPadding: "" } });
    payload.testPadding = "x".repeat(MAX - 3_000 - JSON.stringify(payload).length);
    assert.equal(JSON.stringify(payload).length, MAX - 3_000);
    assert.ok(isCompactPositions(payload.archiveMatchedPositions));
    await seedRow(key.deviceKey, key.id, payload);
  };

  // ranges in, ranges out: fits, although the same report with its positions expanded is ~700,000 characters over
  const fits = { deviceKey: "cp-fin-near-1", id: "fin-near-1" };
  await seed(fits);
  const finalized = await withGates({ positions: "true" }, () => finalizeSelectiveCorpusAuthoritativeReport(db, { reportDeviceKey: fits.deviceKey, reportId: fits.id, accountId: null, shadowResult: completedShadowResult([]) }));
  assert.deepEqual(finalized, { outcome: "finalized", status: "completed" });
  const finalRaw = await rawRow(fits.deviceKey, fits.id);
  assert.ok(finalRaw.length <= MAX, `the finalized row (${finalRaw.length}) is within the ceiling`);
  const final = decodeReportFromPersistence(JSON.parse(finalRaw));
  assert.equal(final.unifiedSimilarity.unifiedScore, 100);
  assertSamePositions(final.unifiedSimilarity.matchedPositions, archive);
  assert.ok(JSON.stringify(final).length > MAX + 600_000, "expanded, the same report is far over the ceiling: only the stored form is what the check may measure");

  // the same row finalized with the positions gate OFF would add the union as a ~349,000-character array: it does not
  // fit, so no score is written — the report ends "incomplete" (PERSISTENCE_LIMIT), similarity unavailable, with no
  // truncated evidence, instead of staying pending for the recovery sweep to re-run forever
  const refused = { deviceKey: "cp-fin-near-2", id: "fin-near-2" };
  await seed(refused);
  const before = await rawRow(refused.deviceKey, refused.id);
  const silenced = console.error;
  console.error = () => {};
  let outcome;
  try {
    outcome = await withGates({ positions: undefined }, () => finalizeSelectiveCorpusAuthoritativeReport(db, { reportDeviceKey: refused.deviceKey, reportId: refused.id, accountId: null, shadowResult: completedShadowResult([]) }));
  } finally {
    console.error = silenced;
  }
  assert.deepEqual(outcome, { outcome: "persistence-limit-exceeded", status: "incomplete" });
  await assertFinalizedUnstorable(refused, before, "arrays over the ceiling");

  // and the measurement itself: with the stored (range) form it is the stored size plus the new keys; without it, the expanded size
  const stored = JSON.parse(before);
  const runtime = { ...stored, archiveMatchedPositions: archive, unifiedSimilarity: computeUnifiedSimilarity({ wordCount: 60_000, archiveMatchedPositions: archive }) };
  const asStored = buildFinalizedReportEvidenceInterpretation(runtime, { compactWrites: true, compactPositions: true, storedArchiveMatchedPositions: stored.archiveMatchedPositions });
  assert.equal(asStored.ok, true);
  assert.equal(asStored.compactPositions, true);
  const asExpanded = buildFinalizedReportEvidenceInterpretation(runtime, { compactWrites: true, compactPositions: true });
  assert.equal(asExpanded.ok, false);
  assert.equal(asExpanded.reason, "PERSISTED_SIZE_EXCEEDED");
  assert.ok(asExpanded.persistedBytes > MAX + 300_000);
});

test("INTERNAL READERS never score a row whose stored positions cannot be read: the finalizer leaves it pending and untouched, the self-heal writes nothing; an intact range row self-heals to the right score", async () => {
  const text = words(3000, 71).join(" ");
  const archive = unionOf([[100, 900], [2500, 2600]]);

  // finalizer on a damaged pending row
  const damaged = { deviceKey: "cp-damaged-fin", id: "damaged-fin" };
  const pending = pendingPayload({ text, wordCount: 3000, archiveMatchedPositions: archive, compactPositions: true });
  pending.archiveMatchedPositions.count -= 5;
  await seedRow(damaged.deviceKey, damaged.id, pending);
  const before = await rawRow(damaged.deviceKey, damaged.id);
  const silenced = console.error;
  console.error = () => {};
  try {
    const result = await finalizeSelectiveCorpusAuthoritativeReport(db, { reportDeviceKey: damaged.deviceKey, reportId: damaged.id, accountId: null, shadowResult: completedShadowResult([[1000, 1100]]) });
    assert.deepEqual(result, { outcome: "gave-up" });
    assert.equal(await rawRow(damaged.deviceKey, damaged.id), before, "nothing written: no score computed without the archive evidence");

    // self-heal on a damaged ordinary row
    const healDamaged = { deviceKey: "cp-damaged-heal", id: "damaged-heal" };
    const ordinary = pendingPayload({ text, wordCount: 3000, archiveMatchedPositions: archive, compactPositions: true });
    delete ordinary.selectiveCorpusAuthoritativeStatus;
    const broken = structuredClone(ordinary);
    broken.archiveMatchedPositions.runs[1] += 1;
    await seedRow(healDamaged.deviceKey, healDamaged.id, broken);
    const healBefore = await rawRow(healDamaged.deviceKey, healDamaged.id);
    const healed = await selfHealUnifiedSimilarity(db, { reportDeviceKey: healDamaged.deviceKey, reportId: healDamaged.id, accountId: null });
    assert.notEqual(healed.outcome, "resolved");
    assert.equal(await rawRow(healDamaged.deviceKey, healDamaged.id), healBefore, "nothing written");

    // self-heal on the intact range row
    const healOk = { deviceKey: "cp-ok-heal", id: "ok-heal" };
    await seedRow(healOk.deviceKey, healOk.id, ordinary);
    const result2 = await withGates({ positions: "true" }, () => selfHealUnifiedSimilarity(db, { reportDeviceKey: healOk.deviceKey, reportId: healOk.id, accountId: null }));
    assert.equal(result2.outcome, "resolved");
    const row = JSON.parse(await rawRow(healOk.deviceKey, healOk.id));
    assert.ok(isCompactPositions(row.unifiedSimilarity.matchedPositions));
    const decoded = decodeReportFromPersistence(row);
    assert.deepEqual(decoded.unifiedSimilarity.matchedPositions, archive);
    assert.equal(decoded.unifiedSimilarity.archiveOnlyWords, archive.length);
  } finally {
    console.error = silenced;
  }
});

// ===============================================================================================================
// 5. the serving bound: ranges never admit a report a reader could not be sent
// ===============================================================================================================
/** An archive-only runtime report whose every word matched: `n` positions in each of archiveMatchedPositions and the union. */
function wholeArchiveReport(n, text = "t") {
  const archiveMatchedPositions = range(0, n - 1);
  return {
    version: 11, id: 1, submissionId: "s", title: "serving bound", author: "", assignment: "", created: FIXED_CREATED, score: 100, archiveScore: 100,
    wordCount: n, scoreBand: "High", matchedWordCount: n, archiveMatchedPositions, sources: [], repeats: [], text,
    unifiedSimilarity: computeUnifiedSimilarity({ wordCount: n, archiveMatchedPositions }),
  };
}

test("SERVING BOUND (encoder): ranges admit a report the arrays would refuse only when the report as served stays within MAX_SERVED_REPORT_BYTES; otherwise the array form comes back and the existing ceiling refuses it, exactly as before ranges", () => {
  assert.equal(MAX_SERVED_REPORT_BYTES, 4_000_000);
  const ceiling = MAX;
  const plain = (report, compactPositions) => JSON.stringify(encodeReportForPersistence(report, { compactWrites: true, compactPositions }));
  const encode = (report, compactPositions) => encodeReportJsonForPersistence(report, { ceiling, compactWrites: true, compactPositions });

  // gate OFF: the plain encoding, whatever its size
  for (const n of [10_000, 320_000]) assert.equal(encode(wholeArchiveReport(n), false), plain(wholeArchiveReport(n), false), `gate OFF, ${n}`);

  // gate ON, the array form fits too: ranges (nothing new is admitted, so nothing else is checked)
  const small = wholeArchiveReport(10_000);
  assert.equal(encode(small, true), plain(small, true));
  assert.ok(isCompactPositions(JSON.parse(encode(small, true)).archiveMatchedPositions));

  // gate ON, only the ranges fit, served within the bound: admitted as ranges
  const admitted = wholeArchiveReport(200_000);
  assert.ok(plain(admitted, false).length > ceiling, "test setup: the array form is over the ceiling");
  assert.ok(servedReportBytes(admitted) <= MAX_SERVED_REPORT_BYTES, `test setup: served ${servedReportBytes(admitted)}`);
  const admittedJson = encode(admitted, true);
  assert.equal(admittedJson, plain(admitted, true));
  assert.ok(admittedJson.length <= ceiling);
  assert.deepEqual(decodeReportFromPersistence(JSON.parse(admittedJson)), admitted, "and it decodes to the report");

  // gate ON, only the ranges fit, served over the bound: the array form — over the ceiling, refused as before ranges
  const unservable = wholeArchiveReport(320_000);
  assert.ok(plain(unservable, true).length <= ceiling, "test setup: the ranges alone would fit");
  assert.ok(servedReportBytes(unservable) > MAX_SERVED_REPORT_BYTES, `test setup: served ${servedReportBytes(unservable)}`);
  const refusedJson = encode(unservable, true);
  assert.equal(refusedJson, plain(unservable, false), "exactly the form the gate-OFF writer produces");
  assert.ok(refusedJson.length > ceiling, "which the caller's existing persisted-size check refuses");

  // the bound is measured on the report as a reader is sent it: UTF-8 bytes of the decoded report
  assert.equal(servedReportBytes({ text: "é" }), Buffer.byteLength('{"text":"é"}', "utf8"));
});

test("SERVING BOUND (route): the POST route encodes through the bounded encoder against its own persisted ceiling", () => {
  const source = fs.readFileSync(new URL("../app/api/reports/route.ts", import.meta.url), "utf8");
  assert.match(source, /return encodeReportJsonForPersistence\(enriched \?\? obj, \{ ceiling: persistedCeiling \}\);/);
  assert.doesNotMatch(source, /JSON\.stringify\(encodeReportForPersistence\(/, "no unbounded encoding path is left in the route");
});

test("SERVING BOUND (deferred finalizer): a final report only its ranges let fit is finalized when it can be served, and ends with no score (incomplete, PERSISTENCE_LIMIT) when it cannot", async () => {
  // Two-letter words keep the manuscript short while every word matches, so the report's evidence (one number per
  // matched word in each expanded list) dwarfs its text — the shape that lets ranges admit more than readers can be sent.
  const twoLetterText = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26), 97 + ((i * 7 + 3) % 26))).join(" ");
  const seed = async (key, n) => {
    const text = twoLetterText(n);
    assert.equal(tokens(text).length, n, "test setup: every two-letter token is a word");
    await seedRow(key.deviceKey, key.id, pendingPayload({ text, wordCount: n, archiveMatchedPositions: range(0, n - 1), compactPositions: true }));
    return rawRow(key.deviceKey, key.id);
  };
  const silenced = console.error;
  console.error = () => {};
  try {
    await withGates({ positions: "true", compact: "true" }, async () => {
      // 140,000 words: the array form is over the ceiling, the served report (~3.4 MB) is within the bound -> finalized
      const fits = { deviceKey: "cp-serve-1", id: "serve-1" };
      await seed(fits, 140_000);
      const finalized = await finalizeSelectiveCorpusAuthoritativeReport(db, { reportDeviceKey: fits.deviceKey, reportId: fits.id, accountId: null, shadowResult: completedShadowResult([]) });
      assert.deepEqual(finalized, { outcome: "finalized", status: "completed" });
      const finalRaw = await rawRow(fits.deviceKey, fits.id);
      assert.ok(finalRaw.length <= MAX);
      const final = decodeReportFromPersistence(JSON.parse(finalRaw));
      assert.equal(final.unifiedSimilarity.unifiedScore, 100);
      assertSamePositions(final.unifiedSimilarity.matchedPositions, range(0, 139_999));
      const served = servedReportBytes(final);
      assert.ok(served <= MAX_SERVED_REPORT_BYTES && served > MAX, `served ${served}: past the persisted ceiling, within the serving bound`);

      // 200,000 words: the served report would be ~4.8 MB -> no score is written; the report ends terminally,
      // similarity unavailable, instead of staying pending for the recovery sweep to re-run forever
      const tooBig = { deviceKey: "cp-serve-2", id: "serve-2" };
      const before = await seed(tooBig, 200_000);
      const refused = await finalizeSelectiveCorpusAuthoritativeReport(db, { reportDeviceKey: tooBig.deviceKey, reportId: tooBig.id, accountId: null, shadowResult: completedShadowResult([]) });
      assert.deepEqual(refused, { outcome: "persistence-limit-exceeded", status: "incomplete" });
      await assertFinalizedUnstorable(tooBig, before, "over the serving bound");
    });
  } finally {
    console.error = silenced;
  }
});

// ===============================================================================================================
// 6. an authoritative report whose final form cannot be stored ends terminally — never pending forever
// ===============================================================================================================
test("AUTHORITATIVE OVERFLOW IS TERMINAL through the REAL POST: the deferred finalizer ends the report 'incomplete' (PERSISTENCE_LIMIT) with no score — the owner's GET and room show it unavailable, a later whole-report resave cannot land a partial score — and with ranges the same report is finalized with its full score", async () => {
  const previous = { a: process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED, s: process.env.SELECTIVE_CORPUS_SHADOW_ENABLED };
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = "true";
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = "true";
  const silenced = console.error;
  console.error = () => {};
  try {
    // the 12,000-word exact resubmission padded to within 20,000 characters of the ceiling (see THE CASE THIS FIXES):
    // POST stores the pending row (no score yet); its final report adds the union as an array and cannot be stored.
    const control = await account();
    assert.equal((await withGates({ positions: undefined }, () => post(control, requestBody(control, "auth-ctl", { text: RESUBMITTED })))).status, 200);
    const controlRaw = JSON.parse(await rawRow(control.deviceKey, "auth-ctl"));
    const pad = MAX - 20_000 - JSON.stringify({ ...controlRaw, unifiedSimilarity: undefined }).length;
    const body = (acc, id) => requestBody(acc, id, { text: RESUBMITTED, assignment: "x".repeat(pad) });

    const arrays = await account();
    const res = await withGates({ positions: undefined }, () => post(arrays, body(arrays, "auth-over")));
    assert.equal(res.status, 200, "the pending row fits: the save itself is accepted");
    const row = JSON.parse(await rawRow(arrays.deviceKey, "auth-over"));
    assert.equal(row.selectiveCorpusAuthoritativeStatus, "incomplete", "the deferred finalizer ran (inline here) and ended it — not pending");
    assert.equal(row.selectiveCorpusAuthoritativeIncompleteReason, "PERSISTENCE_LIMIT");
    assert.equal(row.unifiedSimilarityFailed, true);
    assert.equal("unifiedSimilarity" in row, false, "no score");

    const got = await get(arrays, "auth-over");
    assert.equal(got.status, 200, "the report opens");
    assert.equal(got.json.payload.unifiedSimilarity, undefined, "no score is served");
    assert.equal(got.json.payload.unifiedSimilarityFailed, true, "the reader shows 'Similarity unavailable'");
    assert.equal(got.json.payload.reportCompletion.signals.selectiveCorpus, "PARTIAL", "and the completion says the check did not complete");
    for (const internal of ["selectiveCorpusAuthoritativeStatus", "selectiveCorpusAuthoritativeIncompleteReason"]) assert.equal(internal in got.json.payload, false, `${internal} stays server-internal`);
    const occupant = await findRoomOccupant(db, arrays.userId, 0);
    // the room decides its similarity tile from similarityStatus alone: "failed" renders "— Unavailable", never a number
    // (app/reports/rooms/[room]/room-page-shell.tsx) — the same persisted terminal state as any other failed similarity
    assert.equal(occupant.report?.similarityStatus, "failed", "the room shows it unavailable");

    // the client's whole-report resave (what the automatic AI save sends) recomputes without the Selective Corpus and,
    // as arrays, is still over the ceiling: refused, the terminal row unchanged — never a partial score
    const stored = await rawRow(arrays.deviceKey, "auth-over");
    const resave = await withGates({ positions: undefined }, () => post(arrays, body(arrays, "auth-over")));
    assert.equal(resave.status, 413);
    assert.equal(await rawRow(arrays.deviceKey, "auth-over"), stored);

    // with ranges the very same report fits and is finalized with its full score
    const ranges = await account();
    assert.equal((await withGates({ positions: "true" }, () => post(ranges, body(ranges, "auth-ranges")))).status, 200);
    const finalRow = JSON.parse(await rawRow(ranges.deviceKey, "auth-ranges"));
    assert.equal(finalRow.unifiedSimilarityFailed, false);
    const finalUnified = decodeReportFromPersistence(finalRow).unifiedSimilarity;
    assert.equal(finalUnified.unifiedScore, 100);
    assertSamePositions(finalUnified.matchedPositions, range(0, RESUBMITTED_WORDS - 1));
  } finally {
    console.error = silenced;
    for (const [key, value] of [["SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED", previous.a], ["SELECTIVE_CORPUS_SHADOW_ENABLED", previous.s]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("TERMINAL WRITE edges: compare-and-swap on the exact stored text, measured before it is written — a changed row is left alone, a row at the ceiling loses only the explanation of the score it will never show, a row that cannot take the terminal fields at all is left pending", async () => {
  const text = words(2000, 91).join(" ");
  const seedPending = async (key, extra = {}) => {
    await seedRow(key.deviceKey, key.id, pendingPayload({ text, wordCount: 2000, archiveMatchedPositions: range(10, 60), compactPositions: true, extra }));
    return rawRow(key.deviceKey, key.id);
  };
  const ids = (key) => ({ reportDeviceKey: key.deviceKey, reportId: key.id });

  // a row that changed after it was read: nothing written
  const changed = { deviceKey: "cp-term-1", id: "term-1" };
  const readText = await seedPending(changed);
  await db.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.aiScore', 4) WHERE device_key = ? AND id = ?", args: [changed.deviceKey, changed.id] });
  const current = await rawRow(changed.deviceKey, changed.id);
  assert.deepEqual(await persistSelectiveCorpusAuthoritativeUnstorable(db, ids(changed), { payloadJson: readText }), { written: false, rowsAffected: 0 });
  assert.equal(await rawRow(changed.deviceKey, changed.id), current);

  // a row that is not pending: nothing written
  const done = { deviceKey: "cp-term-2", id: "term-2" };
  const doneText = await seedPending(done, { selectiveCorpusAuthoritativeStatus: "completed" });
  assert.equal((await persistSelectiveCorpusAuthoritativeUnstorable(db, ids(done), { payloadJson: doneText })).written, false);
  assert.equal(await rawRow(done.deviceKey, done.id), doneText);

  // a pending row exactly at the ceiling: the three terminal fields only fit without the (now meaningless) explanation
  const full = { deviceKey: "cp-term-3", id: "term-3" };
  const payload = pendingPayload({ text, wordCount: 2000, archiveMatchedPositions: range(10, 60), compactPositions: true, extra: { testPadding: "" } });
  payload.testPadding = "x".repeat(MAX - JSON.stringify(payload).length);
  assert.equal(JSON.stringify(payload).length, MAX);
  await seedRow(full.deviceKey, full.id, payload);
  const fullText = await rawRow(full.deviceKey, full.id);
  assert.equal((await persistSelectiveCorpusAuthoritativeUnstorable(db, ids(full), { payloadJson: fullText })).written, true);
  const after = JSON.parse(await rawRow(full.deviceKey, full.id));
  assert.ok(JSON.stringify(after).length <= MAX);
  assert.equal(after.selectiveCorpusAuthoritativeStatus, "incomplete");
  assert.equal(after.unifiedSimilarityFailed, true);
  assert.equal("evidenceInterpretation" in after, false, "only the explanation is left out");
  assert.equal(after.testPadding, payload.testPadding);
  assert.equal(after.text, text);

  // the same at the ceiling with no explanation to leave out: nothing written, the row stays pending (the sweep may retry)
  const bare = { deviceKey: "cp-term-4", id: "term-4" };
  const { evidenceInterpretation: _ei, ...noExplanation } = payload;
  noExplanation.testPadding = "x".repeat(payload.testPadding.length + (MAX - JSON.stringify({ ...noExplanation }).length));
  assert.equal(JSON.stringify(noExplanation).length, MAX);
  await seedRow(bare.deviceKey, bare.id, noExplanation);
  const bareText = await rawRow(bare.deviceKey, bare.id);
  assert.equal((await persistSelectiveCorpusAuthoritativeUnstorable(db, ids(bare), { payloadJson: bareText })).written, false);
  assert.equal(await rawRow(bare.deviceKey, bare.id), bareText);
});

test("THE NEW REASON reaches the completion diagnostics only: PERSISTENCE_LIMIT is a known Selective Corpus incomplete reason, refreshed into the customer completion as PARTIAL and named for an admin", () => {
  const report = {
    selectiveCorpusAuthoritativeStatus: "incomplete",
    selectiveCorpusAuthoritativeIncompleteReason: "PERSISTENCE_LIMIT",
    academicEvidenceStatus: "COMPLETE_NO_MATCHES",
    reportCompletion: { state: "COMPLETED", signals: { academicSearch: "COMPLETE_NO_MATCHES", selectiveCorpus: null, extraction: "UNKNOWN", userSuppliedReferences: null, unverifiedCandidateCount: 0, priorSubmission: null }, diagnostics: [] },
  };
  refreshSelectiveCorpusCompletionSignal(report);
  assert.equal(report.reportCompletion.signals.selectiveCorpus, "PARTIAL");
  assert.ok(report.reportCompletion.diagnostics.some((d) => d.channel === "SELECTIVE_CORPUS" && d.reason === "PERSISTENCE_LIMIT"), JSON.stringify(report.reportCompletion.diagnostics));
});
