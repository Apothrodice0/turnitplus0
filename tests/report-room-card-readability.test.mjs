import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { register } from "node:module";
import React from "react";
import { createClient } from "@libsql/client";
import { renderToStaticMarkup } from "react-dom/server";

// The room page is a REAL Server Component (app/reports/rooms/[room]/page.tsx): next/headers / next/navigation / next/link are
// redirected to ./helpers/ssr-next-stubs.mjs. Register BEFORE dynamically importing it (same arrangement as the R2 SSR tests).
register("./helpers/ssr-next-hooks.mjs", import.meta.url);

import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest, resetPollRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";
import { tokens } from "../lib/similarity-core.ts";
import { similarityScoreBand } from "../lib/ai-core.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";
import { tryDecodeReportFromPersistence, isEvidenceInterpretationCustomerReadable } from "../lib/report-persistence.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { compactUnifiedSimilarityForPersistence } from "../lib/unified-similarity-persistence.ts";
import { isCompactEvidenceInterpretation } from "../lib/evidence-interpretation/persistence.ts";

const ssrStubs = await import("./helpers/ssr-next-stubs.mjs");
const roomPage = await import("../app/reports/rooms/[room]/page.tsx");
const roomShell = await import("../app/reports/rooms/[room]/room-page-shell.tsx");

/**
 * R2 — ROOM-CARD READABILITY + CUSTOMER API SCORE SAFETY.
 *
 * A room tile must never show "Similarity NN%" for a report whose persisted evidenceInterpretation cannot be decoded: the
 * detail page (owner GET / SSR) fails closed for that row, so the customer would hold a score they can neither explain nor open.
 * findRoomOccupant reads scalars through SQL json_extract for the 3-second poll; it now also asks the SAME decoder owner GET
 * uses — but only for a row whose interpretation is in a form the decoder could reject (compact / unknown `format` / non-object).
 *
 * The tile is only what is DRAWN; the JSON is what the customer RECEIVES. So for an unreadable report every customer-facing summary
 * — the room poll / SSR occupant AND the authenticated generic list (GET /api/reports) — carries NO similarity figure: archiveScore
 * and scoreBand are null, primaryScore / isUnified are absent, similarityStatus is "failed" (the existing "Unavailable" state).
 *
 * Synthetic content only (no real report text, no real imported package). The stored archive score/band are realistic (derived from
 * the matched positions) so a leak into a response is actually visible, and every expected value is READ BACK from the stored row or
 * the same report while intact — never a literal — so the tests hold whatever the scoring formula is.
 *
 *   L. legacy + valid compact/1 keep their score and link      U. every unsupported / corrupt compact form is non-numeric, in the tile AND the JSON
 *   C. contributions-only damage stays customer-safe           A. absent / null interpretation (pre-Report-V2) is unchanged
 *   P. parity with the owner-GET decoder over every shape      H. hot path: bytes, read-only, polling terminality
 *   LST. the generic customer list follows the same rule
 */

// ────────────────────────────────────────────────────────────────────────────
// environment
// ────────────────────────────────────────────────────────────────────────────
const FLAG = "REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED";
const workDir = mkdtempSync(path.join(tmpdir(), "room-card-readability-"));
const dbFile = path.join(workDir, "room-card.db");
const ENV_KEYS = ["TURSO_DATABASE_URL", "CORPUS_SOURCE_MATCHING_ENABLED", "IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH", "SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED", "SELECTIVE_CORPUS_SHADOW_ENABLED", "SELECTIVE_CORPUS_ARTIFACT_PATH", FLAG];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
for (const k of ["IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH", "SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED", "SELECTIVE_CORPUS_SHADOW_ENABLED", "SELECTIVE_CORPUS_ARTIFACT_PATH", FLAG]) delete process.env[k];

const db = createClient({ url: `file:${dbFile}` });
await db.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(db, path.resolve("drizzle"));

test.after(() => {
  db.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Runs `fn` with the compact-write gate pinned process-locally (undefined = unset), always restoring the previous value. */
async function withFlag(value, fn) {
  const previous = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  }
}

/** Captures console.error lines (the decoder's bounded telemetry) for the duration of `fn`. */
async function captureErrors(fn) {
  const lines = [];
  const spy = mock.method(console, "error", (...args) => { lines.push(args.map(String).join(" ")); });
  try {
    return { result: await fn(), lines };
  } finally {
    spy.mock.restore();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// fixtures + drivers
// ────────────────────────────────────────────────────────────────────────────
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const makeText = (n) => Array.from({ length: n }, (_, i) => `w${i}x`).join(" ");
const clone = (value) => JSON.parse(JSON.stringify(value));
const stripTags = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const COMPACT_LEAK_MARKERS = ['"format":"compact"', "formatVersion", "passageInterpretations", "sourceShapes", '"strings":', '"rows":', "previousUploadPositionsEncoding"];
const assertNoCompactLeak = (text, label) => {
  for (const marker of COMPACT_LEAK_MARKERS) assert.equal(text.includes(marker), false, `${label}: no compact-format internals (${marker}) may appear`);
};
/** Technical vocabulary that must never reach a customer, a room response or a tile. */
const TECHNICAL_TERMS = ["formatVersion", "compact", "tuple", "passageInterpretations", "sourceShapes", "unsupported_compact_format", "corrupt_", "invalid_persisted_report", "UNSUPPORTED", "COUNT_MISMATCH", "MALFORMED", "evidenceInterpretation", "unifiedScore", "matchedPositions", "payload_json", "JSON", "BAD_"];
const assertNoTechnicalTerms = (text, label) => {
  for (const term of TECHNICAL_TERMS) assert.equal(text.includes(term), false, `${label}: must not contain "${term}"`);
};

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let uc = 0;
async function account() {
  uc += 1;
  const email = `rcr-${uc}@example.test`;
  await resetAuthRateForTest("rcr-signup-" + uc);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "rcr-signup-" + uc },
    body: JSON.stringify(withTestIdentity({ email, password: "rcr-pw-123456", username: `rcru${uc}`, deviceKey: `rcr-dev-${uc}` })),
  }));
  assert.equal(res.status, 201);
  const userId = String((await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0].id);
  return { deviceKey: `rcr-dev-${uc}`, cookie: cookieOf(res), tag: `rcr-${uc}`, userId, email };
}

let idc = 0;
const nextId = () => `rcr-${(idc += 1)}`;

/** A REALISTIC stored archive score + band: the client's own archive-only result, derived from the matched positions. */
const archiveResultOf = (positions, words) => {
  const archiveScore = positions ? Math.round((100 * positions.length) / words) : 0;
  return { archiveScore, scoreBand: similarityScoreBand(archiveScore)?.label ?? "Low" };
};
function reportRequestBody(acc, id, { text, archiveMatchedPositions, padding, room = 0, aiStatus = "ready" }) {
  const wordCount = tokens(text).length;
  const { archiveScore, scoreBand } = archiveResultOf(archiveMatchedPositions, wordCount);
  return {
    deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "fixture", createdAt: new Date().toISOString(),
    wordCount, archiveScore, scoreBand, aiScore: aiStatus === "processing" ? null : 2, aiTone: "low", aiStatus, room,
    payload: {
      version: 11, id, submissionId: "sub-" + id, title: "fixture", author: "", assignment: "", created: new Date().toISOString(),
      score: archiveScore, archiveScore, wordCount, scoreBand, matchedWordCount: 0,
      sources: archiveMatchedPositions ? [{ name: "Src", type: "Internet", percent: 50, matches: 1, matchedWords: archiveMatchedPositions.length, phrases: [], color: "#000" }] : [],
      repeats: [], text,
      ...(archiveMatchedPositions ? { archiveMatchedPositions } : {}),
      ...(padding !== undefined ? { testPadding: padding } : {}),
    },
  };
}
async function post(acc, id, opts) {
  await resetRateForTest(acc.tag + "-post");
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": acc.tag + "-post", cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify(reportRequestBody(acc, id, opts)),
  }));
}
/** A real, explained (interpretation-bearing) archive-only report: matched fragments spread across the manuscript. */
const archiveOpts = (over = {}) => ({ text: makeText(400), archiveMatchedPositions: range(0, 399).filter((p) => p % 25 < 12), ...over });

async function ownerGet(acc, id) {
  await resetReadRateForTest(acc.tag + "-get");
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}`, { headers: { "x-forwarded-for": acc.tag + "-get", cookie: `tp_session_v1=${acc.cookie}` } }),
    { params: Promise.resolve({ id }) },
  );
  const text = await res.text();
  return { status: res.status, text, payload: res.status === 200 ? JSON.parse(text).payload : null };
}
/** The room poll endpoint (GET /api/reports?room=N). */
async function roomApi(acc, room) {
  await resetPollRateForTest(acc.tag + "-poll");
  const res = await reportsRoute.GET(new Request(`http://localhost/api/reports?room=${room}`, { headers: { "x-forwarded-for": acc.tag + "-poll", cookie: `tp_session_v1=${acc.cookie}` } }));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}
/** The generic customer list (GET /api/reports WITHOUT `room`), as an ordinary signed-in (non-admin) customer. */
async function listApi(acc) {
  await resetReadRateForTest(acc.tag + "-list");
  const res = await reportsRoute.GET(new Request("http://localhost/api/reports", { headers: { "x-forwarded-for": acc.tag + "-list", cookie: `tp_session_v1=${acc.cookie}` } }));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}
/** The REAL room Server Component, executed for `acc`; returns the occupant it hands the client shell as first paint. */
async function roomSsr(acc, room) {
  ssrStubs.state.cookie = acc.cookie;
  ssrStubs.state.ip = acc.tag + "-ssr";
  await resetReadRateForTest(acc.tag + "-ssr");
  const element = await roomPage.default({ params: Promise.resolve({ room: String(room) }) });
  assert.ok(element?.props && "initialOccupant" in element.props, "the room page rendered the room shell");
  return element.props.initialOccupant;
}
const tile = (report, room) => renderToStaticMarkup(React.createElement(roomShell.SimilarityMetricTile, { report, room }));

const rawRowJson = async (acc, id) => String((await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] })).rows[0].payload_json);
const rawRow = async (acc, id) => JSON.parse(await rawRowJson(acc, id));
const writeRowJson = (acc, id, json) => db.execute({ sql: "UPDATE saved_reports SET payload_json = ? WHERE device_key = ? AND id = ?", args: [json, acc.deviceKey, id] });
async function corruptRow(acc, id, mutate) {
  const row = await rawRow(acc, id);
  mutate(row);
  await writeRowJson(acc, id, JSON.stringify(row));
  return row;
}

/** The stored archive_score / score_band COLUMNS — what every customer summary is built from, and what must never be altered. */
async function storedColumns(acc, id) {
  const row = (await db.execute({ sql: "SELECT archive_score, score_band FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] })).rows[0];
  return { archiveScore: Number(row.archive_score), scoreBand: String(row.score_band) };
}

/**
 * One real report (real signup + real POST). `compact` pins the write gate for that POST; `mutate` then damages the stored row.
 * Pass `acc` to add another report (another room) to an existing account.
 */
async function makeReport({ acc: existing = null, compact = false, mutate = null, room = 0, aiStatus = "ready", opts = {} } = {}) {
  const acc = existing ?? (await account());
  const id = nextId();
  await withFlag(compact ? "true" : undefined, async () => assert.equal((await post(acc, id, { ...archiveOpts(), room, aiStatus, ...opts })).status, 200));
  const intact = await ownerGet(acc, id);
  assert.equal(intact.status, 200, "fixture: the intact report is served");
  const intactScore = intact.payload.unifiedSimilarity.unifiedScore;
  assert.ok(intactScore > 0, "fixture: the intact report has a real, non-zero score");
  const stored = await storedColumns(acc, id);
  assert.ok(stored.archiveScore > 0 && stored.scoreBand.length > 0, "fixture: a realistic stored archive score and band, so a leak into a response would be visible");
  const persisted = await rawRow(acc, id);
  assert.equal(isCompactEvidenceInterpretation(persisted.evidenceInterpretation), compact, `fixture: the interpretation is persisted ${compact ? "compact/1" : "in the legacy shape"}`);
  if (mutate) await corruptRow(acc, id, mutate);
  return { acc, id, room, intact, intactScore, stored };
}

/** Every read path a customer's room tile can come from — plus the real tile rendered from it. */
async function readRoom(acc, room = 0) {
  const direct = await findRoomOccupant(db, acc.userId, room);
  const api = await roomApi(acc, room);
  const ssr = await roomSsr(acc, room);
  assert.equal(api.status, 200);
  const html = tile(direct.report, room);
  return { direct, api, ssr, html, text: stripTags(html) };
}

/** Every value in a customer response that could be read as a similarity figure: any number except the word count and the AI score, and the score-derived band label. */
function similarityLeaves(value, key = "") {
  if (Array.isArray(value)) return value.flatMap((v) => similarityLeaves(v, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => similarityLeaves(v, k));
  if (typeof value === "number" && !/^(wordCount|aiScore)$/.test(key)) return [`${key}=${value}`];
  if (key === "scoreBand" && typeof value === "string") return [`${key}=${value}`];
  return [];
}
/** The exact key set of a healthy customer summary (room occupant report / list row) — for "valid reports are unchanged". */
const ROOM_REPORT_KEYS = ["aiScore", "aiTone", "archiveScore", "createdAt", "id", "isUnified", "primaryScore", "scoreBand", "similarityStatus", "submissionId", "title", "wordCount"];
const LIST_ROW_KEYS = ["aiScore", "aiTone", "archiveScore", "createdAt", "id", "scoreBand", "submissionId", "title", "wordCount"];

/** The room shows the real score, as a link to the report, identically on every read path — and the response carries the stored figures unchanged. */
function assertScoreShown(state, { id, room = 0, score, intactScore, stored }, label) {
  const { report } = state.direct;
  score ??= intactScore;
  assert.ok(Number.isFinite(score), `${label}: the expected score is known`);
  assert.equal(report.similarityStatus, "resolved", `${label}: resolved`);
  assert.equal(report.primaryScore, score, `${label}: the combined score is unchanged`);
  assert.equal(report.isUnified, true, `${label}: combined result`);
  if (stored) {
    assert.equal(report.archiveScore, stored.archiveScore, `${label}: archiveScore is the stored value`);
    assert.equal(report.scoreBand, stored.scoreBand, `${label}: scoreBand is the stored value`);
  }
  assert.deepEqual(Object.keys(state.api.body.report).sort(), ROOM_REPORT_KEYS, `${label}: the unchanged response shape`);
  assert.ok(state.text.includes(`${score}%`), `${label}: the tile shows the score (${state.text})`);
  assert.ok(state.html.includes(`href="/reports/${id}?room=${room}"`), `${label}: the tile still links to the report`);
  assert.deepEqual(state.api.body.report, clone(report), `${label}: the poll endpoint agrees with the direct read`);
  assert.deepEqual(clone(state.ssr.report), clone(report), `${label}: the SSR first paint agrees`);
  assertNoCompactLeak(state.api.text, label);
  assertNoTechnicalTerms(state.api.text, label);
}

/**
 * The room shows the existing non-numeric "Unavailable" tile — AND the customer RECEIVES no similarity figure: not drawn, not in the poll
 * response, not in the SSR props. (The tile is only what is drawn; the JSON is what the customer gets.)
 */
function assertUnavailable(state, _report, label) {
  const { report } = state.direct;
  assert.equal(report.similarityStatus, "failed", `${label}: the existing terminal non-numeric state`);
  assert.equal(report.archiveScore, null, `${label}: archiveScore withheld`);
  assert.equal(report.scoreBand, null, `${label}: the band (a percentage range) withheld`);
  assert.equal("primaryScore" in report, false, `${label}: no combined score`);
  assert.equal("isUnified" in report, false, `${label}: not presented as a combined result`);
  for (const [where, response] of [["direct read", report], ["poll response", state.api.body.report], ["SSR first paint", state.ssr.report]]) {
    assert.deepEqual(similarityLeaves(response), [], `${label}: the ${where} carries no similarity figure`);
    assert.equal(response.similarityStatus, "failed", `${label}: the ${where} says "failed"`);
  }
  assert.deepEqual(Object.keys(state.api.body.report).sort(), ROOM_REPORT_KEYS.filter((k) => k !== "primaryScore" && k !== "isUnified"), `${label}: same shape as a healthy summary minus the combined-result fields; no new field, no reason`);
  assert.equal(/"(primaryScore|isUnified)"/.test(state.api.text), false, `${label}: the words are not in the wire response either`);
  assert.equal(/\d/.test(state.text), false, `${label}: the tile carries no digit at all (${state.text})`);
  assert.equal(state.html.includes("%"), false, `${label}: no percentage`);
  assert.equal(/<a[\s>]/.test(state.html), false, `${label}: no click-through to a report that cannot be served`);
  assert.match(state.html, /room-metric-unavailable/, `${label}: the existing unavailable tile`);
  assert.match(state.text, /Unavailable/, `${label}: says so in plain words`);
  assert.equal(state.direct.status, "ready", `${label}: the AI half of the room is unaffected`);
  assert.equal(state.api.body.report.aiScore, report.aiScore, `${label}: AI result still present`);
  assertNoCompactLeak(state.api.text, label);
  assertNoTechnicalTerms(state.api.text, `${label} (poll response)`);
  assertNoTechnicalTerms(state.html, `${label} (tile)`);
  assertNoTechnicalTerms(JSON.stringify(state.ssr), `${label} (SSR props)`);
}

/** A row of the generic list, by report id (the report must still be listed — withholding never removes it). */
function listRowOf(list, id) {
  assert.equal(list.status, 200, "an ordinary signed-in customer can list their reports");
  const row = list.body.reports.find((r) => r.id === id);
  assert.ok(row, "the report is still listed");
  return row;
}
/** A healthy row is exactly the pre-existing 9-field shape carrying the stored figures — nothing added, nothing removed. */
function assertListRowUnchanged(list, { id, stored }, label) {
  const row = listRowOf(list, id);
  assert.deepEqual(Object.keys(row).sort(), LIST_ROW_KEYS, `${label}: the unchanged list-row shape (no status field added to a healthy row)`);
  assert.equal(row.archiveScore, stored.archiveScore, `${label}: archiveScore is the stored value`);
  assert.equal(row.scoreBand, stored.scoreBand, `${label}: scoreBand is the stored value`);
}
/** An unreadable report's row keeps its identity and non-similarity fields but carries no similarity figure, and says "failed". */
function assertListRowWithheld(list, { id }, label) {
  const row = listRowOf(list, id);
  assert.equal(row.archiveScore, null, `${label}: list archiveScore withheld`);
  assert.equal(row.scoreBand, null, `${label}: list scoreBand withheld`);
  assert.equal(row.similarityStatus, "failed", `${label}: list row says "failed" (the existing non-numeric state)`);
  assert.deepEqual(similarityLeaves(row), [], `${label}: the list row carries no similarity figure`);
  assert.deepEqual(Object.keys(row).sort(), [...LIST_ROW_KEYS, "similarityStatus"].sort(), `${label}: nothing but the existing status field is added; no reason`);
  assert.equal(row.title, "fixture", `${label}: identity kept`);
  assert.ok(Number.isFinite(row.wordCount) && row.wordCount > 0 && row.createdAt, `${label}: non-similarity fields kept`);
  assertNoCompactLeak(list.text, `${label} (list)`);
  assertNoTechnicalTerms(list.text, `${label} (list)`);
}

// ════════════════════════════════════════════════════════════════════════════
// L. HEALTHY ROWS KEEP THEIR SCORE
// ════════════════════════════════════════════════════════════════════════════
test("L1. a valid LEGACY report keeps its score, its band and its link — read through the direct query, the poll endpoint and the SSR first paint — and its list row is unchanged", async () => {
  const r = await makeReport({ compact: false });
  assertScoreShown(await readRoom(r.acc), r, "legacy");
  assertListRowUnchanged(await listApi(r.acc), r, "legacy");
});

test("L2. a valid COMPACT/1 report keeps the SAME score and link, and no compact internal reaches the response; the score equals the same report stored legacy", async () => {
  const compact = await makeReport({ compact: true });
  const legacy = await makeReport({ compact: false });
  const state = await readRoom(compact.acc);
  assertScoreShown(state, compact, "compact/1");
  assertListRowUnchanged(await listApi(compact.acc), compact, "compact/1");
  assert.equal(state.direct.report.primaryScore, (await readRoom(legacy.acc)).direct.report.primaryScore, "the persisted format changes nothing about the number");
  // exactly the response a legacy row produces: same keys, nothing added for the compact form
  assert.deepEqual(Object.keys(state.direct.report).sort(), Object.keys((await findRoomOccupant(db, legacy.acc.userId, 0)).report).sort());
});

test("L3. the compact-write gate never affects READING: a compact row shows its score with the gate unset, \"false\" and \"true\", and a damaged one is unavailable under all three — in the room AND the list", async () => {
  const healthy = await makeReport({ compact: true });
  const damaged = await makeReport({ compact: true, mutate: (row) => { row.evidenceInterpretation.formatVersion = 2; } });
  for (const value of [undefined, "", "false", "true"]) {
    await withFlag(value, async () => {
      assertScoreShown(await readRoom(healthy.acc), healthy, `gate ${JSON.stringify(value)}: healthy compact`);
      assertListRowUnchanged(await listApi(healthy.acc), healthy, `gate ${JSON.stringify(value)}: healthy compact`);
      await captureErrors(async () => {
        assertUnavailable(await readRoom(damaged.acc), damaged, `gate ${JSON.stringify(value)}: damaged compact`);
        assertListRowWithheld(await listApi(damaged.acc), damaged, `gate ${JSON.stringify(value)}: damaged compact`);
      });
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// U. UNSUPPORTED / CORRUPT COMPACT EVIDENCE IS NEVER SHOWN AS A NORMAL SCORE
// ════════════════════════════════════════════════════════════════════════════
const firstKind = (ei) => Object.keys(ei.countsByKind).find((k) => ei.countsByKind[k] > 0);
const DAMAGE = {
  unsupported_version: (row) => { row.evidenceInterpretation.formatVersion = 2; },
  unknown_future_format: (row) => { row.evidenceInterpretation = { format: "packed", formatVersion: 1 }; },
  bad_source_index: (row) => { row.evidenceInterpretation.sources[0][1] = 99; },
  bad_passage_source_relationship: (row) => { row.evidenceInterpretation.passages[0].push(9999); },
  bad_passage_interpretation_index: (row) => { row.evidenceInterpretation.passages[0][2] = 50; },
  malformed_tuple: (row) => { row.evidenceInterpretation.passages[0] = ["x"]; },
  invalid_metadata: (row) => { row.evidenceInterpretation.matchedWordCount = "many"; },
  count_mismatch: (row) => { row.evidenceInterpretation.countsByKind[firstKind(row.evidenceInterpretation)] += 1; },
  garbage_interpretation: (row) => { row.evidenceInterpretation = "garbage"; },
};

async function assertDamageIsUnavailable(names) {
  for (const name of names) {
    const r = await makeReport({ compact: true, mutate: DAMAGE[name] });
    const { result: state } = await captureErrors(() => readRoom(r.acc));
    assertUnavailable(state, r, name);
    // the generic customer list follows the same rule: still listed, no similarity figure, "failed"
    const { result: list } = await captureErrors(() => listApi(r.acc));
    assertListRowWithheld(list, r, name);
    // the detail page refuses the very same row — the tile, the JSON and the report can no longer disagree
    const { result: owner } = await captureErrors(() => ownerGet(r.acc, r.id));
    assert.equal(owner.status, 503, `${name}: the report page refuses the same row`);
    // response shaping only: the stored score and band are exactly what was saved
    assert.deepEqual(await storedColumns(r.acc, r.id), r.stored, `${name}: the stored score and band are untouched`);
  }
}

test("U1. an UNSUPPORTED compact version (formatVersion 2 while the reader supports 1) and an unknown future format never show a numeric score", async () => {
  await assertDamageIsUnavailable(["unsupported_version", "unknown_future_format"]);
});

test("U2. a corrupt SOURCE INDEX never shows a numeric score", async () => {
  await assertDamageIsUnavailable(["bad_source_index"]);
});

test("U3. a corrupt PASSAGE <-> SOURCE relationship (and passage-interpretation index) never shows a numeric score", async () => {
  await assertDamageIsUnavailable(["bad_passage_source_relationship", "bad_passage_interpretation_index"]);
});

test("U4. a MALFORMED tuple, invalid metadata, a count that does not reconcile, and a garbage interpretation never show a numeric score", async () => {
  await assertDamageIsUnavailable(["malformed_tuple", "invalid_metadata", "count_mismatch", "garbage_interpretation"]);
});

test("U5. the unavailable tile is EXACTLY the existing failed-similarity tile — nothing redesigned, nothing new — and the unavailable room is terminal (polling stops)", async () => {
  const r = await makeReport({ compact: true, mutate: DAMAGE.unsupported_version });
  const { result: state } = await captureErrors(() => readRoom(r.acc));
  // the summary a genuine persisted computation failure produces: it still carries its numbers, and its tile ignores them
  const genuineFailure = { ...state.direct.report, similarityStatus: "failed", archiveScore: r.stored.archiveScore, primaryScore: r.stored.archiveScore, isUnified: false, scoreBand: r.stored.scoreBand };
  assert.equal(state.html, tile(genuineFailure, 0), "byte-identical to the tile a genuine persisted computation failure already renders");
  // the poll effect stops on isFullyRevealed: an unreadable report must not keep a room polling forever
  assert.equal(roomShell.isFullyRevealed(state.direct), true, "AI terminal + similarity 'failed' = fully revealed");
});

test("U8. the tile never draws a number that is not there: a withheld (null) score is 'Unavailable' whatever status accompanies it — while 'pending' is still 'Calculating…'", async () => {
  const r = await makeReport({ compact: false });
  const valid = (await findRoomOccupant(db, r.acc.userId, 0)).report;
  const withheld = { ...valid, archiveScore: null, scoreBand: null };
  delete withheld.primaryScore;
  delete withheld.isUnified;
  for (const status of ["resolved", "stale", undefined]) {
    const text = stripTags(tile({ ...withheld, similarityStatus: status }, 0));
    assert.match(text, /Unavailable/, `status ${status}: says Unavailable`);
    assert.equal(/\d|null|undefined|NaN/.test(text), false, `status ${status}: no number, no "null%" (${text})`);
  }
  assert.match(stripTags(tile({ ...withheld, similarityStatus: "pending" }, 0)), /Calculating/, "a pending summary is still 'Calculating…', not Unavailable");
});

test("U9. the rule does not depend on the status: a 'pending' or genuinely 'failed' occupant with an UNREADABLE interpretation carries no similarity figure either (and keeps its status) — the same states with a readable interpretation are untouched", async () => {
  const states = {
    pending: (row) => { delete row.unifiedSimilarity; },
    failed: (row) => { delete row.unifiedSimilarity; row.unifiedSimilarityFailed = true; },
  };
  for (const [status, shape] of Object.entries(states)) {
    const unreadable = await makeReport({ compact: true, mutate: (row) => { shape(row); DAMAGE.unsupported_version(row); } });
    const readable = await makeReport({ compact: true, mutate: shape });

    const { result: withheld } = await captureErrors(async () => ({ room: await readRoom(unreadable.acc), list: await listApi(unreadable.acc) }));
    const report = withheld.room.direct.report;
    assert.equal(report.similarityStatus, status, `${status}: a transient/terminal status is not turned into something else`);
    assert.equal(report.archiveScore, null, `${status}: archiveScore withheld`);
    assert.equal(report.scoreBand, null, `${status}: scoreBand withheld`);
    for (const [where, response] of [["direct", report], ["poll response", withheld.room.api.body.report], ["SSR", withheld.room.ssr.report]]) {
      assert.deepEqual(similarityLeaves(response), [], `${status}: the ${where} carries no similarity figure`);
    }
    assert.equal(/\d/.test(withheld.room.text), false, `${status}: the tile draws no number`);
    assertListRowWithheld(withheld.list, unreadable, `${status}: list`);

    // "do not hide scores for valid reports": the same state with a readable interpretation still returns its stored figures
    const kept = await readRoom(readable.acc);
    assert.equal(kept.direct.report.similarityStatus, status);
    assert.equal(kept.direct.report.archiveScore, readable.stored.archiveScore, `${status}: a readable report keeps its stored archive score`);
    assert.equal(kept.direct.report.scoreBand, readable.stored.scoreBand, `${status}: ...and band`);
  }
});

test("U6. nothing is mutated, recomputed or removed: the row is byte-identical after many polls, the score reappears the moment the row is readable again, and the log carries a bounded reason only", async () => {
  const r = await makeReport({ compact: true, mutate: DAMAGE.unsupported_version });
  const snapshot = async () => (await db.execute({ sql: "SELECT * FROM saved_reports WHERE device_key = ? AND id = ?", args: [r.acc.deviceKey, r.id] })).rows[0];
  const before = JSON.stringify(Object.values(await snapshot()));
  const counts = async () => JSON.stringify((await db.execute("SELECT (SELECT COUNT(*) FROM saved_reports) AS r, (SELECT COUNT(*) FROM report_historical_match_snapshots) AS s")).rows[0]);
  const countsBefore = await counts();

  const { lines } = await captureErrors(async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await findRoomOccupant(db, r.acc.userId, 0)).report.similarityStatus, "failed");
      await roomApi(r.acc, 0);
      await roomSsr(r.acc, 0);
      await listApi(r.acc);
    }
  });
  assert.equal(JSON.stringify(Object.values(await snapshot())), before, "the saved row (payload, timestamps, scores) is untouched");
  assert.equal(await counts(), countsBefore, "no row deleted, no snapshot created");
  const events = lines.filter((l) => l.includes("report_persistence_unreadable")).map((l) => JSON.parse(l));
  assert.ok(events.length >= 5, "each refusal is logged");
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["detail", "event", "outcome", "reason"], "the closed event shape — no id, text or provenance");
    assert.equal(event.reason, "unsupported_compact_format");
    assert.match(event.detail, /^[A-Z_]+$/);
    assert.equal(event.outcome, "refused");
  }
  assert.equal(lines.some((l) => l.includes("w1x") || l.includes(r.id)), false, "no manuscript text or report id in the log");

  // repaired → the very next poll shows the score again (no cached verdict, nothing was persisted about the failure)
  await corruptRow(r.acc, r.id, (row) => { row.evidenceInterpretation.formatVersion = 1; });
  assertScoreShown(await readRoom(r.acc), r, "repaired");
});

test("U7. the room reports its AI half honestly whatever the similarity half is: a room still 'processing' (AI) with an unreadable interpretation shows an unavailable similarity tile, not a number", async () => {
  const r = await makeReport({ compact: true, aiStatus: "processing", mutate: DAMAGE.bad_source_index });
  const { result: state } = await captureErrors(() => readRoom(r.acc));
  assert.equal(state.direct.status, "processing");
  assert.equal(state.direct.report.similarityStatus, "failed");
  assert.equal(state.direct.report.archiveScore, null, "no similarity figure in the response while AI is still processing either");
  assert.deepEqual(similarityLeaves(state.api.body.report), []);
  assert.equal(/\d/.test(state.text), false);
  // ...and the healthy twin of the same lifecycle keeps its number while AI is processing
  const healthy = await makeReport({ compact: true, aiStatus: "processing" });
  const healthyState = await readRoom(healthy.acc);
  assert.equal(healthyState.direct.status, "processing");
  assert.equal(healthyState.direct.report.primaryScore, healthy.intactScore);
});

// ════════════════════════════════════════════════════════════════════════════
// C. CONTRIBUTIONS-ONLY DAMAGE STAYS CUSTOMER-SAFE
// ════════════════════════════════════════════════════════════════════════════
const HSM = {
  status: "MATCHED", computedAt: "x", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x",
  matches: [
    { relationshipType: "PRIOR_SUBMISSION", matchType: "STRONG_TEXT_MATCH", matchedRepresentationId: "rep-A", containment: 0.9, matchedWordCount: 41, passageCount: 1, longestMatchWords: 41, passages: [{ submittedWordStart: 300, submittedWordEnd: 340, matchedWordCount: 41 }], historicalSubmissionCount: 0 },
    { relationshipType: "SELF", matchType: "STRONG_TEXT_MATCH", matchedRepresentationId: "rep-C", containment: 0.9, matchedWordCount: 6, passageCount: 1, longestMatchWords: 6, passages: [{ submittedWordStart: 270, submittedWordEnd: 275, matchedWordCount: 6 }], historicalSubmissionCount: 0 },
  ],
};

test("C1. CONTRIBUTIONS-ONLY damage (admin diagnostics) keeps the customer's score: valid interpretation + corrupt contributions is exactly what a non-admin GET still serves", async () => {
  const r = await makeReport({ compact: true });
  // give the stored report real (non-empty) contributions, persisted compact — pure computation with inline evidence, no package configured
  const unified = computeUnifiedSimilarity({
    wordCount: 400,
    archiveMatchedPositions: [...range(10, 60), ...range(200, 230)],
    historicalSubmissionMatch: HSM,
    importedSimilarityEvidence: [
      { sourceId: "U-1", sourceAttributionState: "TURNITIN_SOURCE_MARKER_ONLY", matchedPassages: [{ submittedWordStart: 160, submittedWordEnd: 165, matchedWordCount: 6 }] },
      { sourceId: "U-2", matchedPassages: [{ submittedWordStart: 390, submittedWordEnd: 395, matchedWordCount: 6 }] },
    ],
  });
  assert.ok(unified.contributions.length > 0, "fixture: real contributions");
  await corruptRow(r.acc, r.id, (row) => { row.unifiedSimilarity = compactUnifiedSimilarityForPersistence(unified, { compactWrites: true }); });
  const seeded = await rawRow(r.acc, r.id);
  assert.equal(seeded.unifiedSimilarity.contributions.format, "compact", "fixture: compact contributions");
  const healthy = await readRoom(r.acc);
  const score = healthy.direct.report.primaryScore;
  assertScoreShown(healthy, { ...r, score }, "compact contributions, intact");

  const damages = {
    unsupported_version: (row) => { row.unifiedSimilarity.contributions.formatVersion = 99; },
    malformed_rows: (row) => { row.unifiedSimilarity.contributions.rows = [[0, 0, "a", 2, 3, 0]]; },
    bad_string_ref: (row) => { row.unifiedSimilarity.contributions.rows[0][0] = 9999; },
    unknown_family: (row) => { row.unifiedSimilarity.contributions = { format: "packed", formatVersion: 1 }; },
  };
  const intactJson = JSON.stringify(seeded);
  for (const [name, mutate] of Object.entries(damages)) {
    const damaged = JSON.parse(intactJson);
    mutate(damaged);
    await writeRowJson(r.acc, r.id, JSON.stringify(damaged));
    // the damage is real, and it is contributions-only: the strict decoder refuses, the customer decoder does not
    const strict = await captureErrors(() => tryDecodeReportFromPersistence(damaged, { requireContributions: true }));
    assert.equal(strict.result.ok, false, `${name}: contributions really are undecodable`);
    assert.equal((await captureErrors(() => tryDecodeReportFromPersistence(damaged, { requireContributions: false }))).result.ok, true, `${name}: the customer decode is fine`);

    const { result: state } = await captureErrors(() => readRoom(r.acc));
    assertScoreShown(state, { ...r, score }, `${name}: room`);
    // the generic customer list keeps the legitimate figures too — diagnostics damage hides nothing from the customer
    assertListRowUnchanged((await captureErrors(() => listApi(r.acc))).result, r, `${name}: list`);
    const { result: owner } = await captureErrors(() => ownerGet(r.acc, r.id));
    assert.equal(owner.status, 200, `${name}: the same customer's report page still serves it`);
    assert.equal(owner.payload.unifiedSimilarity.unifiedScore, score, `${name}: room and report page show the same number`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// A. LEGACY / PRE-REPORT-V2 ROWS WITH NO INTERPRETATION ARE UNCHANGED
// ════════════════════════════════════════════════════════════════════════════
test("A1. a legacy row with NO interpretation (absent, or JSON null) is not 'corrupt': it keeps its score and link exactly as before", async () => {
  for (const [name, mutate] of Object.entries({
    absent: (row) => { delete row.evidenceInterpretation; },
    json_null: (row) => { row.evidenceInterpretation = null; },
  })) {
    const r = await makeReport({ compact: false, mutate });
    const state = await readRoom(r.acc);
    assertScoreShown(state, r, name);
    assertListRowUnchanged(await listApi(r.acc), r, `${name}: list`);
    // the report page agrees: a row without an interpretation is served, not refused
    assert.equal((await ownerGet(r.acc, r.id)).status, 200, `${name}: owner GET serves it`);
  }
});

test("A2. a legacy row whose interpretation is a plain full-shape object (no `format` marker) is untouched — including one whose nested data merely contains a key named `format`", async () => {
  const r = await makeReport({ compact: false });
  const legacyRow = await rawRow(r.acc, r.id);
  assert.equal(legacyRow.evidenceInterpretation.format, undefined);
  legacyRow.evidenceInterpretation.sources = legacyRow.evidenceInterpretation.sources.map((s) => ({ ...s, format: "pdf" }));
  await writeRowJson(r.acc, r.id, JSON.stringify(legacyRow));
  assertScoreShown(await readRoom(r.acc), r, "legacy with a nested `format` key");
  assertListRowUnchanged(await listApi(r.acc), r, "legacy with a nested `format` key: list");
});

// ════════════════════════════════════════════════════════════════════════════
// P. PARITY — the tile can never disagree with the decoder owner GET uses
// ════════════════════════════════════════════════════════════════════════════
test("P1. for EVERY shape an interpretation can take, the tile is numeric exactly when the owner-GET (customer) decoder accepts the row", async () => {
  const r = await makeReport({ compact: true });
  const baseRow = await rawRow(r.acc, r.id);
  const legacyShape = tryDecodeReportFromPersistence(baseRow).report.evidenceInterpretation; // the expanded, full v1 shape
  assert.equal(legacyShape.format, undefined);
  const SHAPES = {
    absent: (row) => { delete row.evidenceInterpretation; },
    json_null: (row) => { row.evidenceInterpretation = null; },
    legacy_full: (row) => { row.evidenceInterpretation = clone(legacyShape); },
    legacy_empty_object: (row) => { row.evidenceInterpretation = {}; },
    compact_valid: () => {},
    compact_v2: (row) => { row.evidenceInterpretation.formatVersion = 2; },
    compact_v0: (row) => { row.evidenceInterpretation.formatVersion = 0; },
    compact_missing_version: (row) => { delete row.evidenceInterpretation.formatVersion; },
    unknown_family: (row) => { row.evidenceInterpretation = { format: "packed", formatVersion: 1 }; },
    format_null: (row) => { row.evidenceInterpretation = { format: null }; },
    format_false: (row) => { row.evidenceInterpretation = { format: false }; },
    format_zero: (row) => { row.evidenceInterpretation = { format: 0 }; },
    format_empty_string: (row) => { row.evidenceInterpretation = { format: "" }; },
    format_with_legacy_body: (row) => { row.evidenceInterpretation = { ...clone(legacyShape), format: "compact" }; },
    interpretation_string: (row) => { row.evidenceInterpretation = "garbage"; },
    interpretation_json_looking_string: (row) => { row.evidenceInterpretation = JSON.stringify(baseRow.evidenceInterpretation); },
    interpretation_number: (row) => { row.evidenceInterpretation = 7; },
    interpretation_true: (row) => { row.evidenceInterpretation = true; },
    interpretation_false: (row) => { row.evidenceInterpretation = false; },
    interpretation_array: (row) => { row.evidenceInterpretation = [1, 2]; },
    compact_bad_source_index: DAMAGE.bad_source_index,
    compact_malformed_tuple: DAMAGE.malformed_tuple,
    compact_missing_tables: (row) => { delete row.evidenceInterpretation.passages; },
    compact_count_mismatch: DAMAGE.count_mismatch,
  };
  let readable = 0;
  let unreadable = 0;
  await captureErrors(async () => {
    for (const [name, mutate] of Object.entries(SHAPES)) {
      const row = clone(baseRow);
      mutate(row);
      const json = JSON.stringify(row);
      await writeRowJson(r.acc, r.id, json);
      const decoderAccepts = tryDecodeReportFromPersistence(JSON.parse(json), { requireContributions: false }).ok;
      const occupant = await findRoomOccupant(db, r.acc.userId, 0);
      const listRow = listRowOf(await listApi(r.acc), r.id);
      assert.equal(occupant.report.similarityStatus === "resolved", decoderAccepts, `${name}: tile numeric <=> decoder accepts`);
      assert.equal(occupant.report.similarityStatus, decoderAccepts ? "resolved" : "failed", `${name}: only ever resolved or failed here`);
      // the JSON follows the same rule as the tile: a figure is present exactly when the decoder accepts the row — room AND list
      assert.equal(occupant.report.archiveScore !== null, decoderAccepts, `${name}: the room response carries a figure <=> decoder accepts`);
      assert.equal(listRow.archiveScore !== null && listRow.scoreBand !== null, decoderAccepts, `${name}: the list row carries a figure <=> decoder accepts`);
      if (decoderAccepts) {
        readable += 1;
        assert.equal(occupant.report.primaryScore, r.intactScore, `${name}: readable rows keep the exact score`);
        assert.equal(occupant.report.archiveScore, r.stored.archiveScore, `${name}: ...and the exact stored archive score`);
        assert.equal(listRow.archiveScore, r.stored.archiveScore, `${name}: ...in the list too`);
      } else {
        unreadable += 1;
        assert.deepEqual(similarityLeaves(occupant.report), [], `${name}: no similarity figure in the room response`);
        assert.deepEqual(similarityLeaves(listRow), [], `${name}: no similarity figure in the list row`);
      }
    }
  });
  assert.ok(readable >= 5 && unreadable >= 15, `the matrix exercises both outcomes (readable ${readable}, unreadable ${unreadable})`);
});

test("P2. isEvidenceInterpretationCustomerReadable IS the customer decoder: null is nothing-to-decode, non-JSON fails closed, and it agrees with tryDecodeReportFromPersistence on the same value", async () => {
  const r = await makeReport({ compact: true });
  const interpretation = (await rawRow(r.acc, r.id)).evidenceInterpretation;
  await captureErrors(async () => {
    assert.equal(isEvidenceInterpretationCustomerReadable(null), true);
    assert.equal(isEvidenceInterpretationCustomerReadable("{not json"), false);
    assert.equal(isEvidenceInterpretationCustomerReadable(""), false);
    for (const value of [interpretation, { ...interpretation, formatVersion: 2 }, { format: "packed" }, "garbage", 7, [1], {}]) {
      assert.equal(
        isEvidenceInterpretationCustomerReadable(JSON.stringify(value)),
        tryDecodeReportFromPersistence({ evidenceInterpretation: value }, { requireContributions: false }).ok,
        `agrees for ${JSON.stringify(value).slice(0, 40)}`,
      );
    }
  });
  // pure: the caller's data is never mutated
  const frozen = clone(interpretation);
  isEvidenceInterpretationCustomerReadable(JSON.stringify(interpretation));
  assert.deepEqual(interpretation, frozen);
});

// ════════════════════════════════════════════════════════════════════════════
// H. HOT PATH — the 3-second poll stays cheap for every row that cannot fail to decode
// ════════════════════════════════════════════════════════════════════════════
/** A client that counts every cell every query returns (approximate bytes off the wire). */
function countingClient() {
  const meter = { bytes: 0, queries: 0 };
  const cell = (v) => (v === null || v === undefined ? 4 : typeof v === "string" ? Buffer.byteLength(v) : 8);
  return {
    meter,
    client: {
      execute: async (query) => {
        const result = await db.execute(query);
        meter.queries += 1;
        for (const row of result.rows) for (const v of Object.values(row)) meter.bytes += cell(v);
        return result;
      },
    },
  };
}
const storedBytes = async (acc, id) => Number((await db.execute({ sql: "SELECT length(payload_json) AS n FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] })).rows[0].n);
const interpretationBytes = async (acc, id) => Number((await db.execute({ sql: "SELECT length(json_extract(payload_json, '$.evidenceInterpretation')) AS n FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] })).rows[0].n);

test("H1. a LEGACY (or interpretation-less) row is polled with scalars only — a large legacy report does NOT drag its payload or its interpretation across the wire", async () => {
  const legacy = await makeReport({ compact: false, opts: { padding: "x".repeat(300_000) } });
  assert.ok((await storedBytes(legacy.acc, legacy.id)) > 250_000, "fixture: a large stored legacy report");
  assert.ok((await interpretationBytes(legacy.acc, legacy.id)) > 1_000, "fixture: it carries a real full-shape interpretation");
  const noInterpretation = await makeReport({ compact: false, mutate: (row) => { delete row.evidenceInterpretation; } });

  for (const [name, r] of Object.entries({ legacy, noInterpretation })) {
    const { client, meter } = countingClient();
    const occupant = await findRoomOccupant(client, r.acc.userId, 0);
    assert.equal(occupant.report.similarityStatus, "resolved", name);
    assert.ok(meter.bytes < 2_048, `${name}: one poll returns only scalars (${meter.bytes} bytes)`);
  }
});

test("H2. a COMPACT row transfers exactly its one interpretation subtree — never the whole payload — and only that row pays for the decode", async () => {
  const compact = await makeReport({ compact: true, opts: { padding: "x".repeat(300_000) } });
  const total = await storedBytes(compact.acc, compact.id);
  const interpretation = await interpretationBytes(compact.acc, compact.id);
  assert.ok(total > 250_000 && interpretation > 1_000 && interpretation < total / 2, "fixture: a compact report whose interpretation is a small part of a large payload");
  const { client, meter } = countingClient();
  const occupant = await findRoomOccupant(client, compact.acc.userId, 0);
  assert.equal(occupant.report.primaryScore, compact.intactScore);
  assert.ok(meter.bytes >= interpretation, "the interpretation is fetched (it is what gets verified)");
  assert.ok(meter.bytes < interpretation + 2_048, `...and only that (${meter.bytes} bytes for a ${interpretation}-byte interpretation in a ${total}-byte payload)`);
});

test("H3. the check is never a separate round trip: ONE row polled while its interpretation is compact, absent and damaged issues the same queries each time — and withholding the figures reads NOT ONE byte more; an 'empty' room reads nothing extra", async () => {
  // (the number of queries also depends on the row's snapshot/generation state, so the SAME row is compared — only the interpretation changes)
  const r = await makeReport({ compact: true });
  const cost = async () => {
    const { client, meter } = countingClient();
    await captureErrors(() => findRoomOccupant(client, r.acc.userId, 0));
    return { queries: meter.queries, bytes: meter.bytes };
  };
  const compact = await cost();
  await corruptRow(r.acc, r.id, (row) => { row.evidenceInterpretation.formatVersion = 2; });
  const damaged = await cost();
  assert.equal(damaged.queries, compact.queries, "damaged: no extra round trip");
  assert.equal(damaged.bytes, compact.bytes, "damaged: the response withholding adds no read — the very bytes an intact compact row already costs");
  await corruptRow(r.acc, r.id, (row) => { delete row.evidenceInterpretation; });
  assert.equal((await cost()).queries, compact.queries, "absent: no extra round trip");
  const fresh = await account();
  const empty = countingClient();
  assert.deepEqual(await findRoomOccupant(empty.client, fresh.userId, 3), { status: "empty", report: null, cycleEndsAt: null });
  assert.equal(empty.meter.queries, 1);
});

/** Bytes returned by the authenticated list statement while `fn` runs. The route opens its own client, so the driver's prototype is metered. */
async function meterListBytes(fn) {
  const proto = Object.getPrototypeOf(db);
  assert.equal(typeof proto.execute, "function", "the driver exposes execute on its prototype");
  const original = proto.execute;
  const meter = { bytes: 0, statements: 0 };
  const cell = (v) => (v === null || v === undefined ? 4 : typeof v === "string" ? Buffer.byteLength(v) : 8);
  const spy = mock.method(proto, "execute", async function (statement, ...rest) {
    const result = await original.call(this, statement, ...rest);
    const sql = typeof statement === "string" ? statement : statement.sql;
    if (/FROM saved_reports WHERE user_id = \?\s+ORDER BY report_created_at DESC LIMIT \?/.test(sql)) {
      meter.statements += 1;
      for (const row of result.rows) for (const v of Object.values(row)) meter.bytes += cell(v);
    }
    return result;
  });
  try {
    await fn();
  } finally {
    spy.mock.restore();
  }
  return meter;
}

test("H4. the generic list obeys the same cost rule as the room poll: a legacy row transfers scalars only, a compact row its one interpretation subtree — never the payload — and there is still ONE statement", async () => {
  const legacy = await makeReport({ compact: false, opts: { padding: "x".repeat(300_000) } });
  const compact = await makeReport({ compact: true, opts: { padding: "x".repeat(300_000) } });
  const legacyMeter = await meterListBytes(() => listApi(legacy.acc));
  assert.equal(legacyMeter.statements, 1, "the list is still a single statement");
  assert.ok(legacyMeter.bytes < 2_048, `a large legacy report is listed with scalars only (${legacyMeter.bytes} bytes)`);
  const total = await storedBytes(compact.acc, compact.id);
  const interpretation = await interpretationBytes(compact.acc, compact.id);
  assert.ok(total > 250_000 && interpretation > 1_000 && interpretation < total / 2, "fixture: a compact report whose interpretation is a small part of a large payload");
  const compactMeter = await meterListBytes(() => listApi(compact.acc));
  assert.equal(compactMeter.statements, 1);
  assert.ok(compactMeter.bytes >= interpretation && compactMeter.bytes < interpretation + 2_048, `a compact row transfers its interpretation and nothing else (${compactMeter.bytes} bytes; interpretation ${interpretation}, payload ${total})`);
});

// ════════════════════════════════════════════════════════════════════════════
// LST. THE GENERIC CUSTOMER LIST (GET /api/reports WITHOUT `room`) FOLLOWS THE SAME RULE
// ════════════════════════════════════════════════════════════════════════════
test("LST1. an ordinary signed-in customer's list: healthy rows are exactly the shape they always were, the unreadable report is still listed but carries no similarity figure, and each room agrees with its list row", async () => {
  const acc = await account();
  const role = String((await db.execute({ sql: "SELECT role FROM users WHERE id = ?", args: [acc.userId] })).rows[0].role);
  assert.notEqual(role, "admin", "fixture: an ordinary customer, not an admin");
  const legacy = await makeReport({ acc, compact: false, room: 0 });
  const compact = await makeReport({ acc, compact: true, room: 1 });
  const noInterpretation = await makeReport({ acc, compact: false, room: 2, mutate: (row) => { delete row.evidenceInterpretation; } });
  const damaged = await makeReport({ acc, compact: true, room: 3, mutate: DAMAGE.unsupported_version });

  const { result: list, lines } = await captureErrors(() => listApi(acc));
  assert.equal(list.body.reports.length, 4, "every report is still listed — withholding never removes one");
  for (const [name, r] of Object.entries({ legacy, compact, noInterpretation })) assertListRowUnchanged(list, r, name);
  assertListRowWithheld(list, damaged, "unreadable");
  assert.equal(lines.filter((l) => l.includes("report_persistence_unreadable")).length, 1, "exactly the one unreadable row is logged, reason only");

  // the rooms agree with the list row for the same report
  for (const r of [legacy, compact, noInterpretation]) {
    const room = (await roomApi(acc, r.room)).body.report;
    assert.equal(room.archiveScore, listRowOf(list, r.id).archiveScore, "healthy: room and list carry the same figure");
  }
  const { result: damagedRoom } = await captureErrors(() => roomApi(acc, damaged.room));
  assert.equal(damagedRoom.body.report.archiveScore, null);
  assert.equal(listRowOf(list, damaged.id).archiveScore, null, "unreadable: room and list both withhold it");
  // the stored figures of every report are untouched
  for (const r of [legacy, compact, noInterpretation, damaged]) assert.deepEqual(await storedColumns(acc, r.id), r.stored, "the stored score and band are untouched");
});

test("LST2. the anonymous device-key list is untouched: a legacy anonymous row lists exactly as before (this correction is scoped to the authenticated customer list)", async () => {
  const deviceKey = `rcr-anon-${nextId()}`;
  const id = nextId();
  const created = new Date().toISOString();
  const { archiveScore, scoreBand } = archiveResultOf(archiveOpts().archiveMatchedPositions, 400);
  await db.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey, "sub-" + id, "anonymous fixture", created, 400, archiveScore, scoreBand, JSON.stringify({ id }), null, null],
  });
  await resetReadRateForTest("rcr-anon-list");
  const res = await reportsRoute.GET(new Request(`http://localhost/api/reports?deviceKey=${deviceKey}`, { headers: { "x-forwarded-for": "rcr-anon-list" } }));
  assert.equal(res.status, 200);
  const { reports } = await res.json();
  assert.deepEqual(reports, [{ id, submissionId: "sub-" + id, title: "anonymous fixture", createdAt: created, wordCount: 400, archiveScore, scoreBand, aiScore: null, aiTone: null }]);
});
