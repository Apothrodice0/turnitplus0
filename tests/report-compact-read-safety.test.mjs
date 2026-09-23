import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { register } from "node:module";
import { createClient } from "@libsql/client";
import { renderToStaticMarkup } from "react-dom/server";

// The SSR tests execute the REAL Server Components (app/reports/[id]/page.tsx and the admin inspector) under plain Node:
// next/headers / next/navigation / next/link are redirected to ./helpers/ssr-next-stubs.mjs. Register BEFORE importing any page.
register("./helpers/ssr-next-hooks.mjs", import.meta.url);

import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as developerReportRoute from "../app/api/developer/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity, grantTestAdmin, markTestAccountEmailVerified } from "./helpers/test-signup.mjs";
import { makeUnitRecord, makePackageFile } from "./helpers/imported-similarity-evidence-fixtures.mjs";
import { tokens } from "../lib/similarity-core.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { withEvidenceInterpretation, buildFinalizedReportEvidenceInterpretation } from "../lib/report-evidence-interpretation.ts";
import {
  encodeReportForPersistence,
  decodeReportFromPersistence,
  tryDecodeReportFromPersistence,
  ReportPersistenceDecodeError,
} from "../lib/report-persistence.ts";
import { isCompactEvidenceInterpretation } from "../lib/evidence-interpretation/persistence.ts";
import { isReportCompactPersistenceWriteEnabled } from "../lib/report-compact-persistence-flag.ts";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";
import { finalizeSelectiveCorpusAuthoritativeReport } from "../lib/selective-corpus-authoritative.ts";
import { persistRefreshedSimilarity } from "../lib/report-primary-similarity.ts";
import { getReportDeepDiveForDeveloper, getReportSimilarityDecisionTrace } from "../lib/developer-repo.ts";
import {
  resetImportedSimilarityEvidencePackageCacheForTest,
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest,
} from "../lib/imported-similarity-evidence/index.ts";

const ssrStubs = await import("./helpers/ssr-next-stubs.mjs");
const reportPage = await import("../app/reports/[id]/page.tsx");
const adminInspectorPage = await import("../app/admin/developer/reports/[id]/page.tsx");

/**
 * R2 — COMPACT READ SAFETY + COMPACT WRITE ROLLOUT GATE.
 *
 * Synthetic content only (no real report text, no real imported package).
 *
 *   F. write gate      — REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED: default OFF, legacy vs compact/1 persisted through the REAL write
 *                        path, no score/card/highlight difference, the decoder never depends on it
 *   W. every writer    — normal save, resave, the authoritative finalizer and the self-heal persist all obey the one gate
 *   L. size limits     — over-limit explained reports FAIL CLOSED with the gate OFF and ON
 *   R. read safety     — an unsupported/corrupt persisted interpretation is NEVER served as a normal explained report: owner GET, the real
 *                        SSR page, admin readers; contributions-only damage stays customer-safe; legacy stays untouched
 *   U. customer UX + logging
 *   X. rollout         — reader-first phases and the honest rollback limitation
 */

// ────────────────────────────────────────────────────────────────────────────
// environment
// ────────────────────────────────────────────────────────────────────────────
const FLAG = "REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED";
const workDir = mkdtempSync(path.join(tmpdir(), "r2-read-safety-"));
const dbFile = path.join(workDir, "r2.db");
const ENV_KEYS = [
  "TURSO_DATABASE_URL",
  "CORPUS_SOURCE_MATCHING_ENABLED",
  "IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH",
  "SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED",
  "SELECTIVE_CORPUS_SHADOW_ENABLED",
  "SELECTIVE_CORPUS_ARTIFACT_PATH",
  FLAG,
];
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
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Runs `fn` with the write gate pinned process-locally (undefined = unset), always restoring the previous value. */
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
const flagOff = (fn) => withFlag(undefined, fn);
const flagOn = (fn) => withFlag("true", fn);

function configurePackage(filePath) {
  if (filePath) process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH = filePath;
  else delete process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH;
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
}

// ────────────────────────────────────────────────────────────────────────────
// fixtures
// ────────────────────────────────────────────────────────────────────────────
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const makeText = (n) => Array.from({ length: n }, (_, i) => `w${i}x`).join(" ");
const jsonNormalised = (value) => JSON.parse(JSON.stringify(value));
const clone = (value) => JSON.parse(JSON.stringify(value));

function baseReport(text, over = {}) {
  const wordCount = tokens(text).length;
  return {
    version: 11, id: 1, submissionId: "s", title: "t", author: "a", assignment: "x", created: "2026-01-01T00:00:00.000Z",
    score: 0, wordCount, characterCount: text.length, pageCount: 1, fileSize: "1 KB", databaseSize: 230,
    corpusVersion: "x", scoreBand: "Low", riskStatus: "Lower", riskTarget: 0, riskCutoff: 0,
    riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 },
    features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: "en" },
    excludedDocuments: 0, matchedWordCount: 0, sources: [], repeats: [], text, ...over,
  };
}
const HSM = {
  status: "MATCHED", computedAt: "x", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x",
  matches: [
    { relationshipType: "PRIOR_SUBMISSION", matchType: "STRONG_TEXT_MATCH", matchedRepresentationId: "rep-A", containment: 0.9, matchedWordCount: 41, passageCount: 1, longestMatchWords: 41, passages: [{ submittedWordStart: 300, submittedWordEnd: 340, matchedWordCount: 41 }], historicalSubmissionCount: 0 },
    { relationshipType: "SELF", matchType: "STRONG_TEXT_MATCH", matchedRepresentationId: "rep-C", containment: 0.9, matchedWordCount: 6, passageCount: 1, longestMatchWords: 6, passages: [{ submittedWordStart: 270, submittedWordEnd: 275, matchedWordCount: 6 }], historicalSubmissionCount: 0 },
  ],
};
/** A runtime report carrying archive + prior-submission + imported channels: real interpretation AND non-empty contributions. */
function fullReport() {
  const text = makeText(420);
  const base = baseReport(text);
  const archive = [...range(10, 60), ...range(200, 230)];
  const unifiedSimilarity = computeUnifiedSimilarity({
    wordCount: base.wordCount,
    archiveMatchedPositions: archive,
    historicalSubmissionMatch: HSM,
    importedSimilarityEvidence: [
      { sourceId: "U-1", sourceAttributionState: "TURNITIN_SOURCE_MARKER_ONLY", matchedPassages: [{ submittedWordStart: 160, submittedWordEnd: 165, matchedWordCount: 6 }] },
      { sourceId: "U-2", matchedPassages: [{ submittedWordStart: 390, submittedWordEnd: 395, matchedWordCount: 6 }] },
    ],
  });
  return withEvidenceInterpretation(
    {
      ...base,
      archiveMatchedPositions: archive,
      sources: [{ name: "Wikipedia — “Photosynthesis”", type: "Internet", percent: 12, matches: 3, matchedWords: 51, phrases: [], color: "#000" }],
      unifiedSimilarity,
    },
    { historicalSubmissionMatch: HSM, selectiveCorpusBranch: null },
  );
}
const FULL = fullReport();
const { historicalSubmissionMatch: _fixtureOnly, ...FULL_ROW } = (() => ({ ...FULL, historicalSubmissionMatch: undefined }))();
assert.ok(FULL.unifiedSimilarity.contributions.length > 0, "fixture has real contributions");
assert.ok(FULL.evidenceInterpretation.passages.length > 0 && FULL.evidenceInterpretation.sources.length > 0, "fixture has a real explanation");

const LEGACY_ROW_JSON = JSON.stringify(encodeReportForPersistence(FULL_ROW, { compactWrites: false }));
const COMPACT_ROW_JSON = JSON.stringify(encodeReportForPersistence(FULL_ROW, { compactWrites: true }));

const COMPACT_LEAK_MARKERS = ['"format":"compact"', "formatVersion", "passageInterpretations", "sourceShapes", '"strings":', '"rows":', "previousUploadPositionsEncoding"];
const assertNoCompactLeak = (text, label) => {
  for (const marker of COMPACT_LEAK_MARKERS) assert.equal(text.includes(marker), false, `${label}: no compact-format internals (${marker}) may appear`);
};
/** Technical vocabulary that must never reach a customer, an unavailable page or a refusal body. */
const TECHNICAL_TERMS = ["formatVersion", "compact", "tuple", "passageInterpretations", "sourceShapes", "unsupported_compact_format", "corrupt_", "invalid_persisted_report", "UNSUPPORTED", "COUNT_MISMATCH", "MALFORMED", "evidenceInterpretation", "unifiedScore", "matchedPositions", "payload_json", "JSON"];
const assertNoTechnicalTerms = (text, label) => {
  for (const term of TECHNICAL_TERMS) assert.equal(text.includes(term), false, `${label}: must not contain "${term}"`);
};

// ────────────────────────────────────────────────────────────────────────────
// route drivers
// ────────────────────────────────────────────────────────────────────────────
const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let uc = 0;
async function account({ admin = false } = {}) {
  uc += 1;
  const email = `r2rs-${uc}@example.test`;
  await resetAuthRateForTest("r2rs-signup-" + uc);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "r2rs-signup-" + uc },
    body: JSON.stringify(withTestIdentity({ email, password: "r2rs-pw-123456", username: `r2rsu${uc}`, deviceKey: `r2rs-dev-${uc}` })),
  }));
  assert.equal(res.status, 201);
  if (admin) await grantTestAdmin(dbFile, email);
  await markTestAccountEmailVerified(dbFile, email);
  const userId = String((await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0].id);
  return { deviceKey: `r2rs-dev-${uc}`, cookie: cookieOf(res), tag: `r2rs-${uc}`, userId, email, admin };
}

let idc = 0;
const nextId = (prefix) => `${prefix}-${(idc += 1)}`;

function reportRequestBody(acc, id, { text, archiveMatchedPositions, padding, room = 0, payloadExtra = {} }) {
  const wordCount = tokens(text).length;
  return {
    deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "r2 fixture", createdAt: new Date().toISOString(),
    wordCount, archiveScore: 0, scoreBand: "Low", aiScore: 2, aiTone: "low", aiStatus: "ready", room,
    payload: {
      version: 11, id, submissionId: "sub-" + id, title: "r2 fixture", author: "", assignment: "", created: new Date().toISOString(),
      score: 0, archiveScore: 0, wordCount, scoreBand: "Low", matchedWordCount: 0,
      sources: archiveMatchedPositions ? [{ name: "Src", type: "Internet", percent: 50, matches: 1, matchedWords: archiveMatchedPositions.length, phrases: [], color: "#000" }] : [],
      repeats: [], text,
      ...(archiveMatchedPositions ? { archiveMatchedPositions } : {}),
      ...(padding !== undefined ? { testPadding: padding } : {}),
      ...payloadExtra,
    },
  };
}
async function postBody(acc, body) {
  await resetRateForTest(acc.tag + "-post");
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": acc.tag + "-post", cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify(body),
  }));
}
const post = (acc, id, opts) => postBody(acc, reportRequestBody(acc, id, opts));
/** Real POST of a small archive-only report (an interpretation, no contributions). */
const archiveOpts = (over = {}) => ({ text: makeText(400), archiveMatchedPositions: range(0, 399).filter((p) => p % 5 !== 4), ...over });

async function get(acc, id) {
  await resetReadRateForTest(acc.tag + "-get");
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}`, { headers: { "x-forwarded-for": acc.tag + "-get", cookie: `tp_session_v1=${acc.cookie}` } }),
    { params: Promise.resolve({ id }) },
  );
  const text = await res.text();
  return { status: res.status, text, payload: res.status === 200 ? JSON.parse(text).payload : null, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
async function developerGet(admin, ownerDeviceKey, id) {
  await resetRateForTest(admin.tag + "-dev");
  const res = await developerReportRoute.GET(
    new Request(`http://localhost/api/developer/reports/${id}?deviceKey=${encodeURIComponent(ownerDeviceKey)}`, { headers: { "x-forwarded-for": admin.tag + "-dev", cookie: `tp_session_v1=${admin.cookie}` } }),
    { params: Promise.resolve({ id }) },
  );
  const text = await res.text();
  return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/** The REAL customer report page (Server Component + loadOwnedReport), executed for `acc`. */
async function ssr(acc, id, searchParams = {}) {
  ssrStubs.state.cookie = acc.cookie;
  ssrStubs.state.ip = acc.tag + "-ssr";
  await resetReadRateForTest(acc.tag + "-ssr");
  try {
    const element = await reportPage.default({ params: Promise.resolve({ id }), searchParams: Promise.resolve(searchParams) });
    const shellProps = element?.props && "initialReport" in element.props ? element.props : null;
    return { kind: shellProps ? "shell" : "static", element, shellProps, html: shellProps ? null : renderToStaticMarkup(element) };
  } catch (error) {
    if (error?.digest === "NEXT_NOT_FOUND") return { kind: "not-found" };
    throw error;
  }
}
/** The REAL admin developer inspector page. */
async function adminInspector(admin, ownerDeviceKey, id) {
  ssrStubs.state.cookie = admin.cookie;
  ssrStubs.state.ip = admin.tag + "-adm";
  const element = await adminInspectorPage.default({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ deviceKey: ownerDeviceKey }) });
  return { html: renderToStaticMarkup(element) };
}

async function rawRowJson(acc, id) {
  const r = await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] });
  return r.rows[0] ? String(r.rows[0].payload_json) : null;
}
const rawRow = async (acc, id) => JSON.parse(await rawRowJson(acc, id));
async function writeRowJson(acc, id, json) {
  await db.execute({ sql: "UPDATE saved_reports SET payload_json = ? WHERE device_key = ? AND id = ?", args: [json, acc.deviceKey, id] });
}
async function seedRow(acc, id, payloadJson) {
  await db.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, acc.deviceKey, "sub-" + id, "seeded", new Date().toISOString(), 420, 0, "Low", payloadJson, acc.userId, null],
  });
}
async function corruptRow(acc, id, mutate) {
  const row = await rawRow(acc, id);
  mutate(row);
  await writeRowJson(acc, id, JSON.stringify(row));
  return row;
}

/** Captures console.error lines (decoder telemetry) for the duration of `fn`. */
async function captureErrors(fn) {
  const lines = [];
  const spy = mock.method(console, "error", (...args) => { lines.push(args.map(String).join(" ")); });
  try {
    return { result: await fn(), lines };
  } finally {
    spy.mock.restore();
  }
}

// imported-evidence package: real, small, gives NON-EMPTY contributions through the real write path
const UNITS = 40;
const MASK = [0, 1, 2, 4, 5, 6, 7];
const unitId = (i) => `RU${String(i).padStart(5, "0")}`;
const anchorOf = (i) => "abcdefgh".split("").map((c) => `u${i + 100}${c}`).join(" ");
const fillerOf = (i) => "abcdef".split("").map((c) => `f${i + 100}${c}`).join(" ");
const importedManuscript = (units) => Array.from({ length: units }, (_, i) => `${anchorOf(i)} ${fillerOf(i)}`).join(" ");
function writePackage(units, name) {
  const filePath = path.join(workDir, name);
  fs.writeFileSync(filePath, JSON.stringify(makePackageFile(Array.from({ length: units }, (_, i) => makeUnitRecord({ evidenceUnitId: unitId(i), anchorNormalizedText: anchorOf(i), scoreMaskRelativePositions: MASK })))));
  return filePath;
}
const SMALL_PACKAGE = writePackage(UNITS, "small-package.json");
const importedOpts = (over = {}) => ({ text: importedManuscript(UNITS), ...over });

const viewCounts = (payload) => {
  const view = buildReportV2ViewModel(payload);
  return { cards: view?.sources?.length ?? 0, highlights: view?.passages?.length ?? 0 };
};

// ════════════════════════════════════════════════════════════════════════════
// F. THE WRITE GATE
// ════════════════════════════════════════════════════════════════════════════
test("F1. the compact-write flag is OFF by default and only the exact string \"true\" turns it on (server-only, documented, no customer UI)", async () => {
  for (const off of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true "]) {
    await withFlag(off, () => assert.equal(isReportCompactPersistenceWriteEnabled(), false, `${JSON.stringify(off)} => OFF`));
  }
  await withFlag("true", () => assert.equal(isReportCompactPersistenceWriteEnabled(), true));
  assert.equal(process.env[FLAG], undefined, "the suite left the flag unset (default state)");

  const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8"); // cwd-independent
  assert.match(envExample, new RegExp(`^${FLAG}=$`, "m"), "documented in .env.example with an empty (OFF) value");
  // server-only: no NEXT_PUBLIC_ alias, and nothing under components/ (the browser bundle) reads it
  assert.equal(/NEXT_PUBLIC_REPORT_COMPACT/.test(envExample), false);
  const clientHits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && fs.readFileSync(full, "utf8").includes(FLAG)) clientHits.push(full.replace(/\\/g, "/"));
    }
  };
  walk("components");
  assert.deepEqual(clientHits, [], "no component (client bundle) references the flag");
});

test("F2. FLAG OFF: a real POST persists the LEGACY form (full interpretation, plain contributions array, no compact marker anywhere); GET / admin / SSR all work", async () => {
  await flagOff(async () => {
    configurePackage(SMALL_PACKAGE);
    try {
      const owner = await account();
      const id = nextId("f2");
      assert.equal((await post(owner, id, importedOpts())).status, 200);
      const rawText = await rawRowJson(owner, id);
      const raw = JSON.parse(rawText);
      assert.equal(isCompactEvidenceInterpretation(raw.evidenceInterpretation), false, "interpretation is NOT compact");
      assert.equal(raw.evidenceInterpretation.format, undefined);
      assert.ok(Array.isArray(raw.evidenceInterpretation.passages) && Array.isArray(raw.evidenceInterpretation.sources) && raw.evidenceInterpretation.passages.length > 0, "the full legacy interpretation is what was written");
      assert.ok(Array.isArray(raw.unifiedSimilarity.contributions) && raw.unifiedSimilarity.contributions.length > 0, "contributions are the plain (non-empty) array");
      for (const marker of ['"format":"compact"', "formatVersion", "passageInterpretations", "sourceShapes", '"strings":', '"rows":']) assert.equal(rawText.includes(marker), false, `no ${marker} in the stored row`);

      const asOwner = await get(owner, id);
      assert.equal(asOwner.status, 200);
      assert.ok(asOwner.payload.evidenceInterpretation.passages.length > 0);
      assert.deepEqual(asOwner.payload.unifiedSimilarity.contributions, [], "non-admin: stripped as ever");

      const admin = await account({ admin: true });
      const adminId = nextId("f2a");
      assert.equal((await post(admin, adminId, importedOpts())).status, 200);
      const asAdmin = await get(admin, adminId);
      assert.ok(asAdmin.payload.unifiedSimilarity.contributions.length > 0, "admin sees the contributions");

      const page = await ssr(owner, id);
      assert.equal(page.kind, "shell", "the real SSR page renders the report");
      assert.ok(page.shellProps.initialReport.evidenceInterpretation.passages.length > 0);
    } finally {
      configurePackage(null);
    }
  });
});

test("F3. FLAG ON: a real POST persists compact/1 (interpretation AND contributions); GET / SSR expand them; the customer response is unchanged", async () => {
  await flagOn(async () => {
    configurePackage(SMALL_PACKAGE);
    try {
      const owner = await account();
      const id = nextId("f3");
      assert.equal((await post(owner, id, importedOpts())).status, 200);
      const raw = await rawRow(owner, id);
      assert.equal(raw.evidenceInterpretation.format, "compact");
      assert.equal(raw.evidenceInterpretation.formatVersion, 1);
      assert.equal(raw.unifiedSimilarity.contributions.format, "compact");
      assert.equal(raw.unifiedSimilarity.contributions.formatVersion, 1);

      const got = await get(owner, id);
      assert.equal(got.status, 200);
      assertNoCompactLeak(got.text, "GET response");
      assert.ok(got.payload.evidenceInterpretation.passages.length > 0);
      const page = await ssr(owner, id);
      assert.equal(page.kind, "shell");
      assertNoCompactLeak(JSON.stringify(page.shellProps.initialReport), "SSR first-paint payload");
      assert.deepEqual(page.shellProps.initialReport.evidenceInterpretation, got.payload.evidenceInterpretation, "SSR and GET agree");

      const admin = await account({ admin: true });
      const adminId = nextId("f3a");
      assert.equal((await post(admin, adminId, importedOpts())).status, 200);
      const asAdmin = await get(admin, adminId);
      assert.ok(asAdmin.payload.unifiedSimilarity.contributions.length > 0, "admin expansion");
      assertNoCompactLeak(asAdmin.text, "admin GET");
      const dev = await developerGet(admin, admin.deviceKey, adminId);
      assert.equal(dev.status, 200, "the developer route expands too");
      assertNoCompactLeak(dev.text, "developer route response");
    } finally {
      configurePackage(null);
    }
  });
});

test("F4. NO scoring, card or highlight difference between the two persisted formats: the SAME report stored legacy and compact reads identically, and real saves under OFF and ON compute identically", async () => {
  // (a) one real save (gate ON), then the very same report re-encoded LEGACY under another id — served by the real GET as an admin
  configurePackage(SMALL_PACKAGE);
  try {
    const admin = await account({ admin: true });
    const compactId = nextId("f4-compact");
    const legacyId = nextId("f4-legacy");
    await flagOn(async () => assert.equal((await post(admin, compactId, importedOpts())).status, 200));
    const compactRaw = await rawRow(admin, compactId);
    assert.equal(isCompactEvidenceInterpretation(compactRaw.evidenceInterpretation), true);
    const legacyJson = JSON.stringify(encodeReportForPersistence(decodeReportFromPersistence(compactRaw), { compactWrites: false }));
    assert.equal(isCompactEvidenceInterpretation(JSON.parse(legacyJson).evidenceInterpretation), false, "fixture: legacy encoding");
    await seedRow(admin, legacyId, legacyJson);

    const dropAdminExtras = (p) => { const c = clone(p); for (const k of ["id", "submissionId", "matchClassification", "historicalSubmissionMatch"]) delete c[k]; return c; };
    const compact = (await get(admin, compactId)).payload;
    const legacy = (await get(admin, legacyId)).payload;
    assert.deepEqual(compact.unifiedSimilarity, legacy.unifiedSimilarity, "unifiedSimilarity (score, every position array, admin contributions) identical");
    assert.equal(compact.unifiedSimilarity.unifiedScore, legacy.unifiedSimilarity.unifiedScore);
    assert.deepEqual(compact.evidenceInterpretation, legacy.evidenceInterpretation, "interpretation identical");
    assert.deepEqual(viewCounts(compact), viewCounts(legacy), "cards / highlights identical");
    assert.ok(viewCounts(compact).cards > 0 && viewCounts(compact).highlights > 0);
    assert.deepEqual(dropAdminExtras(compact), dropAdminExtras(legacy), "the whole GET payload is identical across formats");
  } finally {
    configurePackage(null);
  }

  // (b) two independent real saves with the same structure (distinct tokens so neither matches the other): the gate changes only the persisted form
  const offAcc = await account();
  const onAcc = await account();
  const positions = range(0, 399).filter((p) => p % 5 !== 4);
  const textFor = (prefix) => Array.from({ length: 400 }, (_, i) => `${prefix}${i}z`).join(" ");
  const offId = nextId("f4-off");
  const onId = nextId("f4-on");
  await flagOff(async () => assert.equal((await post(offAcc, offId, { text: textFor("qa"), archiveMatchedPositions: positions })).status, 200));
  await flagOn(async () => assert.equal((await post(onAcc, onId, { text: textFor("qb"), archiveMatchedPositions: positions })).status, 200));
  assert.equal(isCompactEvidenceInterpretation((await rawRow(offAcc, offId)).evidenceInterpretation), false);
  assert.equal(isCompactEvidenceInterpretation((await rawRow(onAcc, onId)).evidenceInterpretation), true);
  const off = (await get(offAcc, offId)).payload;
  const on = (await get(onAcc, onId)).payload;
  assert.deepEqual(on.unifiedSimilarity, off.unifiedSimilarity, "identical score + positions");
  assert.deepEqual(on.evidenceInterpretation.countsByKind, off.evidenceInterpretation.countsByKind);
  assert.deepEqual(on.evidenceInterpretation.passages.map((p) => [p.wordStart, p.wordEnd, p.sourceIds]), off.evidenceInterpretation.passages.map((p) => [p.wordStart, p.wordEnd, p.sourceIds]), "the same highlighted ranges");
  assert.deepEqual(viewCounts(on), viewCounts(off));
});

test("F5. the decoder NEVER depends on the gate: the same stored rows read identically with the flag unset, \"false\" and \"true\" — FLAG OFF still reads compact/1", async () => {
  const owner = await account();
  const legacyId = nextId("f5-legacy");
  const compactId = nextId("f5-compact");
  await seedRow(owner, legacyId, LEGACY_ROW_JSON);
  await seedRow(owner, compactId, COMPACT_ROW_JSON);
  assert.equal(isCompactEvidenceInterpretation(JSON.parse(COMPACT_ROW_JSON).evidenceInterpretation), true, "fixture: really compact");
  assert.equal(isCompactEvidenceInterpretation(JSON.parse(LEGACY_ROW_JSON).evidenceInterpretation), false, "fixture: really legacy");

  const reads = [];
  for (const value of [undefined, "false", "true"]) {
    await withFlag(value, async () => {
      const l = await get(owner, legacyId);
      const c = await get(owner, compactId);
      assert.equal(l.status, 200);
      assert.equal(c.status, 200, `compact/1 row readable with the flag ${JSON.stringify(value)}`);
      assert.deepEqual(c.payload.evidenceInterpretation, l.payload.evidenceInterpretation, "compact and legacy rows decode to the same interpretation");
      assertNoCompactLeak(c.text, `compact GET (flag ${JSON.stringify(value)})`);
      const s = await ssr(owner, compactId);
      assert.equal(s.kind, "shell", `SSR reads compact/1 with the flag ${JSON.stringify(value)}`);
      reads.push(JSON.stringify(c.payload));
    });
  }
  assert.equal(new Set(reads).size, 1, "the response does not vary with the write flag");
});

// ════════════════════════════════════════════════════════════════════════════
// W. EVERY WRITER OBEYS THE ONE GATE
// ════════════════════════════════════════════════════════════════════════════
test("W1. RESAVE is covered: an AI-style resave of a report follows the CURRENT gate, so it can convert compact -> legacy and legacy -> compact, with the report identical throughout", async () => {
  const acc = await account();
  const id = nextId("w1");
  const opts = archiveOpts();
  await flagOn(async () => assert.equal((await post(acc, id, opts)).status, 200));
  assert.equal(isCompactEvidenceInterpretation((await rawRow(acc, id)).evidenceInterpretation), true, "first save: compact");
  const first = await flagOn(() => get(acc, id));

  // resave with the gate OFF: the client echoes the GET payload back
  const echo = (aiScore) => ({ ...reportRequestBody(acc, id, opts), aiScore, aiStatus: "ready", payload: { ...reportRequestBody(acc, id, opts).payload, ...first.payload, aiScore } });
  await flagOff(async () => assert.equal((await postBody(acc, echo(9))).status, 200));
  const afterOff = await rawRow(acc, id);
  assert.equal(isCompactEvidenceInterpretation(afterOff.evidenceInterpretation), false, "resave with the gate OFF rewrites the row in the legacy form");
  assert.equal(afterOff.evidenceInterpretation.format, undefined);
  const second = await flagOff(() => get(acc, id));
  assert.deepEqual(second.payload.evidenceInterpretation, first.payload.evidenceInterpretation, "the explanation is unchanged by the format switch");
  assert.equal(second.payload.unifiedSimilarity.unifiedScore, first.payload.unifiedSimilarity.unifiedScore);

  // and back: resave with the gate ON
  await flagOn(async () => assert.equal((await postBody(acc, echo(10))).status, 200));
  assert.equal(isCompactEvidenceInterpretation((await rawRow(acc, id)).evidenceInterpretation), true, "resave with the gate ON writes compact/1");
  const third = await flagOn(() => get(acc, id));
  assert.deepEqual(third.payload.evidenceInterpretation, first.payload.evidenceInterpretation);
});

/** A pending authoritative-mode row + the real finalizer, at a given gate value. */
async function finalizePending({ units, gate }) {
  configurePackage(writePackage(units, `finalizer-${units}-${idc}.json`));
  try {
    const acc = await account({ admin: true });
    const id = nextId("w2");
    const built = await flagOn(async () => {
      assert.equal((await post(acc, id, { text: importedManuscript(units) })).status, 200);
      return rawRow(acc, id);
    });
    const p = decodeReportFromPersistence(built);
    for (const k of ["unifiedSimilarity", "unifiedSimilarityGeneration", "corpusSourceMatchingEnabledAtComputation", "unifiedSimilarityFailed", "evidenceInterpretation"]) delete p[k];
    p.selectiveCorpusAuthoritativeStatus = "pending";
    const pendingId = nextId("w2-pending");
    await seedRow(acc, pendingId, JSON.stringify(p));
    const before = await rawRowJson(acc, pendingId);
    const result = await withFlag(gate, () => finalizeSelectiveCorpusAuthoritativeReport(db, { reportDeviceKey: acc.deviceKey, reportId: pendingId, accountId: acc.userId, shadowResult: { state: "COMPLETED" } }));
    return { acc, pendingId, before, after: await rawRowJson(acc, pendingId), result };
  } finally {
    configurePackage(null);
  }
}

test("W2. the AUTHORITATIVE FINALIZER obeys the gate: OFF persists the legacy interpretation + plain contributions; ON persists compact/1 — the score is identical", async () => {
  const off = await finalizePending({ units: UNITS, gate: undefined });
  assert.deepEqual(off.result, { outcome: "finalized", status: "completed" });
  const offRow = JSON.parse(off.after);
  assert.equal(offRow.selectiveCorpusAuthoritativeStatus, "completed");
  assert.equal(isCompactEvidenceInterpretation(offRow.evidenceInterpretation), false, "flag OFF: legacy interpretation");
  assert.ok(Array.isArray(offRow.evidenceInterpretation.passages) && offRow.evidenceInterpretation.passages.length > 0);
  assert.ok(Array.isArray(offRow.unifiedSimilarity.contributions) && offRow.unifiedSimilarity.contributions.length > 0, "flag OFF: plain contributions array");
  assert.equal(off.after.includes('"format":"compact"'), false);

  const on = await finalizePending({ units: UNITS, gate: "true" });
  assert.deepEqual(on.result, { outcome: "finalized", status: "completed" });
  const onRow = JSON.parse(on.after);
  assert.equal(isCompactEvidenceInterpretation(onRow.evidenceInterpretation), true, "flag ON: compact interpretation");
  assert.equal(onRow.unifiedSimilarity.contributions.format, "compact", "flag ON: compact contributions");

  const offFinal = decodeReportFromPersistence(offRow);
  const onFinal = decodeReportFromPersistence(onRow);
  assert.equal(onFinal.unifiedSimilarity.unifiedScore, offFinal.unifiedSimilarity.unifiedScore, "no score change");
  assert.deepEqual(onFinal.evidenceInterpretation, offFinal.evidenceInterpretation, "the same explanation in both formats");
});

test("W3. the self-heal / refresh writer (persistRefreshedSimilarity) obeys the gate: plain contributions with the gate OFF, compact with it ON", async () => {
  const acc = await account();
  const id = nextId("w3");
  await seedRow(acc, id, JSON.stringify({ ...baseReport(makeText(420)), archiveMatchedPositions: range(10, 60) }));
  const resolution = { unifiedSimilarity: FULL.unifiedSimilarity, failed: false, corpusSourceMatchingEnabled: true, corpusGeneration: 5 };
  await flagOff(async () => {
    assert.equal((await persistRefreshedSimilarity(db, { reportDeviceKey: acc.deviceKey, reportId: id }, resolution)).written, "resolved");
    assert.ok(Array.isArray((await rawRow(acc, id)).unifiedSimilarity.contributions), "OFF: plain array");
  });
  await flagOn(async () => {
    assert.equal((await persistRefreshedSimilarity(db, { reportDeviceKey: acc.deviceKey, reportId: id }, { ...resolution, corpusGeneration: 6 })).written, "resolved");
    assert.equal((await rawRow(acc, id)).unifiedSimilarity.contributions.format, "compact", "ON: compact");
  });
});

test("W4. STRUCTURAL — no persistence path can bypass the gate: the two compact codecs are called ONLY from the four known writers, none from app/, and the route persists only the ENCODED report", () => {
  const callers = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const rel = full.replace(/\\/g, "/");
      const src = fs.readFileSync(full, "utf8");
      const hits = (src.match(/\bcompact(?:UnifiedSimilarity|EvidenceInterpretation)ForPersistence\s*\(/g) ?? []).length;
      if (hits > 0) callers.set(rel, hits);
    }
  };
  for (const dir of ["app", "lib", "components", "worker"]) if (fs.existsSync(dir)) walk(dir);
  // definitions count their own `export function compactX(` once; every other entry is a CALL site
  const expected = new Map([
    ["lib/evidence-interpretation/persistence.ts", 1],       // definition (its own round-trip verification uses expand, not compact)
    ["lib/unified-similarity-persistence.ts", 1],            // definition
    ["lib/report-persistence.ts", 2],                        // encodeReportForPersistence — the gate-aware boundary
    ["lib/report-evidence-interpretation.ts", 2],            // buildFinalizedReportEvidenceInterpretation — resolves the mode ONCE
    ["lib/report-primary-similarity.ts", 2],                 // persistRefreshedSimilarity + persistSelectiveCorpusAuthoritativeFinalization
  ]);
  assert.deepEqual([...callers.entries()].sort(), [...expected.entries()].sort(), "an unreviewed caller of a compact codec appeared — it must go through the gate");
  for (const [file] of callers) assert.equal(file.startsWith("app/"), false, "no route calls a compact codec directly");

  const routeSrc = fs.readFileSync("app/api/reports/route.ts", "utf8");
  assert.match(routeSrc, /JSON\.stringify\(encodeReportForPersistence\(enriched \?\? obj\)\)/, "the route persists only the encoded (gated) report");
  // the gate is consulted inside the codecs by default and the finalizer hands its resolved mode to the writer
  assert.match(fs.readFileSync("lib/selective-corpus-authoritative.ts", "utf8"), /compactWrites:\s*prepared\.compactWrites/);
  assert.match(fs.readFileSync("lib/report-evidence-interpretation.ts", "utf8"), /const compactWrites = resolveCompactPersistenceWrites\(opts\)/);
  for (const file of ["lib/evidence-interpretation/persistence.ts", "lib/unified-similarity-persistence.ts"]) {
    assert.match(fs.readFileSync(file, "utf8"), /resolveCompactPersistenceWrites\(options\)/, `${file}: the codec itself consults the gate`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// L. SIZE LIMITS FAIL CLOSED, WITH THE GATE OFF AND ON
// ════════════════════════════════════════════════════════════════════════════
/** Calibrates an archive-report so PLAIN (no explanation) just fits the limit while the explained report does not. */
async function calibratedPadding(gate) {
  const calAcc = await account();
  const opts = archiveOpts({ text: makeText(300), archiveMatchedPositions: range(0, 299).filter((p) => p % 3 !== 2) });
  const calId = nextId("l-cal");
  await withFlag(gate, async () => assert.equal((await post(calAcc, calId, opts)).status, 200));
  const calRaw = await rawRowJson(calAcc, calId);
  const { evidenceInterpretation, reportCompletion, extractionDiagnostic, ...plain } = JSON.parse(calRaw);
  const plainBytes = JSON.stringify(plain).length;
  const pad = MAX_REPORT_SAVE_REQUEST_BYTES - 25 - plainBytes;
  assert.ok(calRaw.length - plainBytes > 300 && calRaw.length + pad > MAX_REPORT_SAVE_REQUEST_BYTES, "arithmetic: plain fits, explained does not");
  return { opts, pad, calAcc, calId, calRaw };
}

for (const [label, gate] of [["OFF", undefined], ["ON", "true"]]) {
  test(`L1(${label}). WRITE-TIME over the limit fails closed with the gate ${label}: 413, nothing persisted, no score without its explanation; a rejected resave leaves the prior row byte-identical`, async () => {
    const { opts, pad, calAcc, calId, calRaw } = await calibratedPadding(gate);
    const padded = (id, room) => reportRequestBody(calAcc, id, { ...opts, padding: "x".repeat(pad), room });
    assert.ok(JSON.stringify(padded("probe", 0).payload).length <= MAX_REPORT_SAVE_REQUEST_BYTES, "the client payload passes the request guard, so the PERSISTENCE guard is what is exercised");
    const firstId = nextId("l1-first");
    const res = await withFlag(gate, () => postBody(calAcc, padded(firstId, 1)));
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "Payload too large" });
    assert.equal(await rawRowJson(calAcc, firstId), null, "nothing was persisted");
    const resave = await withFlag(gate, () => postBody(calAcc, padded(calId, 0)));
    assert.equal(resave.status, 413);
    assert.equal(await rawRowJson(calAcc, calId), calRaw, "the prior report is byte-identical after the rejected resave");
    const still = await withFlag(gate, () => get(calAcc, calId));
    assert.ok(still.payload.evidenceInterpretation && still.payload.unifiedSimilarity, "score AND explanation still there");
  });
}

test("L2. a fragment-heavy report whose LEGACY form exceeds the limit: gate OFF -> rejected (413, nothing persisted, never 'score without explanation'); gate ON -> persisted compact with its full explanation", async () => {
  const UNITS_BIG = 1500;
  configurePackage(writePackage(UNITS_BIG, "big-package.json"));
  try {
    const off = await account();
    const offId = nextId("l2-off");
    const offRes = await flagOff(() => post(off, offId, { text: importedManuscript(UNITS_BIG) }));
    assert.equal(offRes.status, 413, "gate OFF: the legacy explained form is over the limit -> fail closed");
    assert.equal(await rawRowJson(off, offId), null, "nothing persisted — in particular no unexplained score");

    const on = await account();
    const onId = nextId("l2-on");
    const onRes = await flagOn(() => post(on, onId, { text: importedManuscript(UNITS_BIG) }));
    assert.equal(onRes.status, 200, "gate ON: the compact form fits");
    const raw = await rawRow(on, onId);
    assert.equal(isCompactEvidenceInterpretation(raw.evidenceInterpretation), true);
    assert.ok(decodeReportFromPersistence(raw).evidenceInterpretation.passages.length === 2 * UNITS_BIG, "the complete explanation");
  } finally {
    configurePackage(null);
  }
});

test("L3. the AUTHORITATIVE FINALIZER over the limit fails closed with the gate OFF (legacy too large) and ON (padded): outcome persistence-limit-exceeded, pending row byte-identical, no score", async () => {
  // OFF: a big fragment-heavy report only fits compact
  const off = await finalizePending({ units: 1500, gate: undefined });
  assert.deepEqual(off.result, { outcome: "persistence-limit-exceeded" });
  assert.equal(off.after, off.before, "byte-identical: nothing written");
  assert.equal(JSON.parse(off.after).unifiedSimilarity, undefined, "no score without its explanation");
  assert.equal(JSON.parse(off.after).selectiveCorpusAuthoritativeStatus, "pending");

  // (the same report finalizes with the gate ON)
  const on = await finalizePending({ units: 1500, gate: "true" });
  assert.deepEqual(on.result, { outcome: "finalized", status: "completed" });

  // ON + padding: even the compact form does not fit
  const acc = await account();
  const id = nextId("l3-pad");
  const pending = { ...baseReport(makeText(200)), archiveMatchedPositions: range(0, 79), selectiveCorpusAuthoritativeStatus: "pending" };
  const pendingReport = withEvidenceInterpretation({ ...pending, unifiedSimilarity: undefined }, { selectiveCorpusBranch: null });
  pendingReport.testPadding = "";
  pendingReport.testPadding = "x".repeat(MAX_REPORT_SAVE_REQUEST_BYTES - 100 - JSON.stringify(pendingReport).length);
  await seedRow(acc, id, JSON.stringify(pendingReport));
  const before = await rawRowJson(acc, id);
  const result = await flagOn(() => finalizeSelectiveCorpusAuthoritativeReport(db, {
    reportDeviceKey: acc.deviceKey, reportId: id, accountId: acc.userId,
    shadowResult: { state: "COMPLETED", verifiedEvidence: [{ sourceLabel: "S1", matchedPassages: [{ submittedWordStart: 100, submittedWordEnd: 120, matchedWordCount: 21 }] }] },
  }));
  assert.deepEqual(result, { outcome: "persistence-limit-exceeded" });
  assert.equal(await rawRowJson(acc, id), before);
});

test("L4. the finalizer's size check measures the mode its write then persists: the builder resolves the gate ONCE and reports it", () => {
  const finalReport = { ...FULL_ROW };
  const off = buildFinalizedReportEvidenceInterpretation(finalReport, { compactWrites: false });
  const on = buildFinalizedReportEvidenceInterpretation(finalReport, { compactWrites: true });
  assert.equal(off.ok && on.ok, true);
  assert.equal(off.compactWrites, false);
  assert.equal(on.compactWrites, true);
  assert.equal(isCompactEvidenceInterpretation(off.evidenceInterpretation), false);
  assert.equal(isCompactEvidenceInterpretation(on.evidenceInterpretation), true);
  // default = whatever the flag says (unset => legacy)
  const byDefault = buildFinalizedReportEvidenceInterpretation(finalReport);
  assert.equal(byDefault.ok && byDefault.compactWrites, false);
});

// ════════════════════════════════════════════════════════════════════════════
// R. READ SAFETY — a persisted-but-undecodable explanation is never served as a normal report
// ════════════════════════════════════════════════════════════════════════════
const firstKind = (ei) => Object.keys(ei.countsByKind).find((k) => ei.countsByKind[k] > 0);
const INTERPRETATION_DAMAGE = {
  unsupported_version: { mutate: (row) => { row.evidenceInterpretation.formatVersion = 2; }, reason: "unsupported_compact_format" },
  unknown_future_format: { mutate: (row) => { row.evidenceInterpretation = { format: "packed", formatVersion: 1 }; }, reason: "unsupported_compact_format" },
  bad_source_index: { mutate: (row) => { row.evidenceInterpretation.sources[0][1] = 99; }, reason: "corrupt_evidence_interpretation" },
  bad_passage_index: { mutate: (row) => { row.evidenceInterpretation.passages[0][2] = 50; }, reason: "corrupt_evidence_interpretation" },
  bad_compact_tuple: { mutate: (row) => { row.evidenceInterpretation.passages[0] = ["x"]; }, reason: "corrupt_evidence_interpretation" },
  out_of_range_relationship: { mutate: (row) => { row.evidenceInterpretation.passages[0].push(9999); }, reason: "corrupt_evidence_interpretation" },
  invalid_compact_metadata: { mutate: (row) => { row.evidenceInterpretation.matchedWordCount = "many"; }, reason: "corrupt_evidence_interpretation" },
  count_mismatch: { mutate: (row) => { row.evidenceInterpretation.countsByKind[firstKind(row.evidenceInterpretation)] += 1; }, reason: "corrupt_evidence_interpretation" },
  garbage_interpretation: { mutate: (row) => { row.evidenceInterpretation = "garbage"; }, reason: "corrupt_evidence_interpretation" },
};

/** One real compact report for `owner` + a byte-identical copy seeded for `admin`, damaged the same way. */
async function damagedPair(name, mutate) {
  const owner = await account();
  const admin = await account({ admin: true });
  const id = nextId(`r-${name}`);
  await flagOn(async () => assert.equal((await post(owner, id, archiveOpts())).status, 200));
  const intact = await get(owner, id);
  const row = await corruptRow(owner, id, mutate);
  await seedRow(admin, id, JSON.stringify(row));
  return { owner, admin, id, intact: intact.payload };
}

test("R1. OWNER GET fails closed for every unsupported / corrupt interpretation: a generic 503, never a 200, never the score, never a decoder internal", async () => {
  for (const [name, { mutate }] of Object.entries(INTERPRETATION_DAMAGE)) {
    const { owner, id, intact } = await damagedPair(name, mutate);
    assert.ok(intact.unifiedSimilarity.unifiedScore > 0, "fixture: the intact report has a real score");
    const { result: got } = await captureErrors(() => get(owner, id));
    assert.equal(got.status, 503, `${name}: refused`);
    assert.deepEqual(got.body, { error: "Report temporarily unavailable", code: "REPORT_TEMPORARILY_UNAVAILABLE" }, name);
    assert.equal(got.payload, null, `${name}: no payload at all`);
    assert.equal(got.text.includes(String(intact.unifiedSimilarity.unifiedScore)), false, `${name}: the score is not in the body`);
    assertNoTechnicalTerms(got.text, `${name} refusal`);
  }
});

test("R2. the REAL SSR PAGE fails closed for every unsupported / corrupt interpretation: the generic unavailable state, never the report shell, never a score", async () => {
  for (const [name, { mutate }] of Object.entries(INTERPRETATION_DAMAGE)) {
    const { owner, id, intact } = await damagedPair(name, mutate);
    const { result: page } = await captureErrors(() => ssr(owner, id));
    assert.equal(page.kind, "static", `${name}: the report shell (score + report) is NOT rendered`);
    assert.match(page.html, /temporarily unavailable/);
    assert.equal(page.html.includes(String(intact.unifiedSimilarity.unifiedScore)), false, `${name}: no score on the page`);
    assert.equal(/\d\s*%/.test(page.html), false, `${name}: no percentage on the page`);
    assertNoTechnicalTerms(page.html, `${name} unavailable page`);
    assert.match(page.html, /href="\/#reports"/, "a way back to the customer's reports");
  }
  // with ?room= the back link returns to that room
  const { owner, id } = await damagedPair("room", INTERPRETATION_DAMAGE.unsupported_version.mutate);
  const inRoom = await ssr(owner, id, { room: "2" });
  assert.match(inRoom.html, /href="\/reports\/rooms\/2"/);
});

test("R3. ADMIN readers fail closed and explicit: the developer route answers 503 with a bounded reason, the deep dive throws, the decision trace is 'not available', the inspector page says so — and none serves the payload or score", async () => {
  for (const [name, { mutate, reason }] of Object.entries(INTERPRETATION_DAMAGE)) {
    const { owner, admin, id, intact } = await damagedPair(name, mutate);
    const { result } = await captureErrors(async () => {
      const dev = await developerGet(admin, owner.deviceKey, id);
      assert.equal(dev.status, 503, `${name}: developer route refuses`);
      assert.deepEqual(dev.body, { error: "Report payload cannot be decoded safely", code: "REPORT_PAYLOAD_UNREADABLE", reason }, name);
      assert.equal(dev.text.includes("unifiedScore"), false);
      assert.equal(dev.text.includes("evidenceInterpretation"), false);

      await assert.rejects(() => getReportDeepDiveForDeveloper(db, owner.deviceKey, id), (error) => error instanceof ReportPersistenceDecodeError && error.reason === reason, `${name}: deep dive throws the typed error`);
      assert.equal(await getReportSimilarityDecisionTrace(db, owner.deviceKey, id), null, `${name}: no trace is built from a damaged payload`);

      const inspected = await adminInspector(admin, owner.deviceKey, id);
      assert.match(inspected.html, /cannot be decoded/);
      assert.match(inspected.html, new RegExp(reason), "the admin sees the bounded reason");
      assert.equal(inspected.html.includes("unifiedScore"), false, "the payload dump is not rendered");
      assert.equal(inspected.html.includes("matchedPositions"), false);
      assert.equal(/Score band|Matched words/.test(inspected.html), false, "the report overview is not rendered from a damaged row");

      // an admin session reading its OWN damaged report through the customer route is refused too
      const asOwner = await get(admin, id);
      assert.equal(asOwner.status, 503, `${name}: admin session GET refused`);
      const asSsr = await ssr(admin, id);
      assert.equal(asSsr.kind, "static");
      assert.match(asSsr.html, /temporarily unavailable/);
    });
    void result;
  }
});

test("R4. UNKNOWN VERSION (formatVersion 2 while the reader supports 1): owner, SSR and admin never receive a normal unexplained score", async () => {
  const { owner, admin, id } = await damagedPair("v2", INTERPRETATION_DAMAGE.unsupported_version.mutate);
  await captureErrors(async () => {
    assert.equal((await get(owner, id)).status, 503);
    assert.equal((await ssr(owner, id)).kind, "static");
    assert.equal((await developerGet(admin, owner.deviceKey, id)).status, 503);
    assert.equal((await get(admin, id)).status, 503);
  });
  // the row itself is untouched — nothing was deleted, emptied or recomputed
  const after = await rawRow(owner, id);
  assert.equal(after.evidenceInterpretation.formatVersion, 2, "the stored explanation is left exactly as written (a newer reader can still use it)");
  // ...and it is served normally the moment the reader understands it (simulated: restore the supported version)
  await corruptRow(owner, id, (row) => { row.evidenceInterpretation.formatVersion = 1; });
  const recovered = await get(owner, id);
  assert.equal(recovered.status, 200);
  assert.ok(recovered.payload.evidenceInterpretation.passages.length > 0);
});

test("R5. CONTRIBUTIONS-ONLY damage stays CUSTOMER-SAFE: a non-admin still gets the exact score, cards and highlights (contributions stay stripped); an admin gets an explicit refusal, never a fabricated empty list", async () => {
  configurePackage(SMALL_PACKAGE);
  try {
    const owner = await account();
    const admin = await account({ admin: true });
    const id = nextId("r5");
    await flagOn(async () => assert.equal((await post(owner, id, importedOpts())).status, 200));
    const intact = await get(owner, id);
    assert.ok(intact.payload.evidenceInterpretation.passages.length > 0);
    assert.equal((await rawRow(owner, id)).unifiedSimilarity.contributions.format, "compact", "fixture: compact contributions");

    const damages = {
      unsupported_version: (row) => { row.unifiedSimilarity.contributions.formatVersion = 99; },
      malformed_rows: (row) => { row.unifiedSimilarity.contributions.rows = [[0, 0, "a", 2, 3, 0]]; },
      bad_string_ref: (row) => { row.unifiedSimilarity.contributions.rows[0][0] = 9999; },
      unknown_family: (row) => { row.unifiedSimilarity.contributions = { format: "packed", formatVersion: 1 }; },
    };
    const intactJson = await rawRowJson(owner, id);
    for (const [name, mutate] of Object.entries(damages)) {
      const damaged = JSON.parse(intactJson);
      mutate(damaged);
      const damagedJson = JSON.stringify(damaged);
      await writeRowJson(owner, id, damagedJson);
      const adminCopyId = nextId("r5a");
      await seedRow(admin, adminCopyId, damagedJson);

      const { result: asOwner, lines } = await captureErrors(() => get(owner, id));
      assert.equal(asOwner.status, 200, `${name}: the customer report is still served`);
      assert.deepEqual(asOwner.payload.evidenceInterpretation, intact.payload.evidenceInterpretation, `${name}: explanation exact`);
      assert.equal(asOwner.payload.unifiedSimilarity.unifiedScore, intact.payload.unifiedSimilarity.unifiedScore, `${name}: score exact`);
      assert.deepEqual(viewCounts(asOwner.payload), viewCounts(intact.payload), `${name}: cards/highlights exact`);
      assert.deepEqual(asOwner.payload.unifiedSimilarity.contributions, [], `${name}: a non-admin never receives contributions`);
      assertNoCompactLeak(asOwner.text, `${name}: owner GET`);
      assert.ok(lines.some((l) => /"outcome":"served_without_contributions"/.test(l)), `${name}: the withheld diagnostics are logged, bounded`);

      const page = await ssr(owner, id);
      assert.equal(page.kind, "shell", `${name}: SSR serves the customer report`);
      assert.deepEqual(page.shellProps.initialReport.unifiedSimilarity.contributions, []);
      assert.deepEqual(page.shellProps.initialReport.evidenceInterpretation, intact.payload.evidenceInterpretation);

      const { result: asAdmin } = await captureErrors(() => get(admin, adminCopyId));
      assert.equal(asAdmin.status, 503, `${name}: an admin is served contributions, so damaged ones are an explicit refusal`);
      assert.equal(asAdmin.payload, null);
      const dev = (await captureErrors(() => developerGet(admin, admin.deviceKey, adminCopyId))).result;
      assert.equal(dev.status, 503);
      assert.match(dev.body.reason, /^(corrupt_contributions|unsupported_compact_format)$/);
      assert.equal((await captureErrors(() => getReportSimilarityDecisionTrace(db, admin.deviceKey, adminCopyId))).result, null, `${name}: no trace from damaged diagnostics`);
    }
    // the same row, intact again, is served in full to the admin (the refusal was about the damage, not the account)
    await writeRowJson(owner, id, intactJson);
    const adminIntactId = nextId("r5b");
    await seedRow(admin, adminIntactId, intactJson);
    const adminIntact = await get(admin, adminIntactId);
    assert.equal(adminIntact.status, 200);
    assert.ok(adminIntact.payload.unifiedSimilarity.contributions.length > 0);
  } finally {
    configurePackage(null);
  }
});

test("R6. LEGACY rows are untouched end to end: owner GET, the real SSR page, the developer route and the inspector page serve a legacy row exactly as before — and a pre-Report-V2 row with NO interpretation at all is still served normally (absent != undecodable)", async () => {
  const owner = await account();
  const admin = await account({ admin: true });
  const id = nextId("r6");
  await seedRow(owner, id, LEGACY_ROW_JSON);
  await seedRow(admin, id, LEGACY_ROW_JSON);

  const asOwner = await get(owner, id);
  assert.equal(asOwner.status, 200);
  assert.deepEqual(asOwner.payload.evidenceInterpretation, jsonNormalised(FULL.evidenceInterpretation));
  assert.deepEqual(asOwner.payload.unifiedSimilarity.contributions, []);
  const asAdmin = await get(admin, id);
  assert.deepEqual(asAdmin.payload.unifiedSimilarity.contributions, jsonNormalised(FULL.unifiedSimilarity.contributions), "admin: legacy contributions unchanged");

  const page = await ssr(owner, id);
  assert.equal(page.kind, "shell", "LEGACY_SSR_COMPATIBLE");
  assert.deepEqual(page.shellProps.initialReport.evidenceInterpretation, jsonNormalised(FULL.evidenceInterpretation));
  assert.equal(page.shellProps.initialReport.unifiedSimilarity.unifiedScore, FULL.unifiedSimilarity.unifiedScore);

  const dev = await developerGet(admin, admin.deviceKey, id);
  assert.equal(dev.status, 200, "LEGACY_ADMIN_COMPATIBLE (route)");
  assert.deepEqual(dev.body.report.payload.evidenceInterpretation, jsonNormalised(FULL.evidenceInterpretation));
  const inspected = await adminInspector(admin, admin.deviceKey, id);
  assert.match(inspected.html, /Report overview/, "LEGACY_ADMIN_COMPATIBLE (inspector page renders)");
  assert.equal(/cannot be decoded/.test(inspected.html), false);

  // pre-Report-V2: no interpretation / completion / extraction diagnostic at all
  const { evidenceInterpretation, reportCompletion, extractionDiagnostic, ...preV2 } = JSON.parse(LEGACY_ROW_JSON);
  const preId = nextId("r6-pre");
  await seedRow(owner, preId, JSON.stringify(preV2));
  await seedRow(admin, preId, JSON.stringify(preV2));
  const preGet = await get(owner, preId);
  assert.equal(preGet.status, 200, "an ABSENT interpretation is a legitimate legacy row, not a failure");
  assert.equal(preGet.payload.evidenceInterpretation, undefined, "and nothing is fabricated for it");
  assert.equal(preGet.payload.unifiedSimilarity.unifiedScore, FULL.unifiedSimilarity.unifiedScore);
  assert.equal((await ssr(owner, preId)).kind, "shell");
  assert.equal((await developerGet(admin, admin.deviceKey, preId)).status, 200);
});

test("R7. a malformed interpretation NEVER becomes an empty-but-valid one: every damaged compact value is refused, a genuinely EMPTY explanation stays valid, an absent one stays absent", () => {
  // a real, legitimately empty explanation (0% similarity) — valid in both persisted forms
  const empty = withEvidenceInterpretation(
    { ...baseReport(makeText(50)), unifiedSimilarity: computeUnifiedSimilarity({ wordCount: 50 }) },
    { selectiveCorpusBranch: null },
  );
  assert.equal(empty.evidenceInterpretation.passages.length + empty.evidenceInterpretation.sources.length, 0, "fixture: a truly empty explanation");
  for (const compactWrites of [false, true]) {
    const wire = JSON.parse(JSON.stringify(encodeReportForPersistence(empty, { compactWrites })));
    const decoded = tryDecodeReportFromPersistence(wire);
    assert.equal(decoded.ok, true, `empty explanation is valid (compactWrites=${compactWrites})`);
    assert.deepEqual(decoded.report.evidenceInterpretation, jsonNormalised(empty.evidenceInterpretation));
  }

  const compactWire = () => JSON.parse(JSON.stringify(encodeReportForPersistence(FULL_ROW, { compactWrites: true })));
  const damage = {
    sources_null: (ei) => { ei.sources = null; },
    passages_string: (ei) => { ei.passages = "x"; },
    passageInterpretations_object: (ei) => { ei.passageInterpretations = {}; },
    sourceShapes_missing: (ei) => { delete ei.sourceShapes; },
    countsByKind_array: (ei) => { ei.countsByKind = []; },
    countsByKind_null: (ei) => { ei.countsByKind = null; },
    deferredKindsFolded_number: (ei) => { ei.deferredKindsFolded = 1; },
    version_number: (ei) => { ei.version = 3; },
    matchedWordCount_negative: (ei) => { ei.matchedWordCount = -1; },
    matchedWordCount_fraction: (ei) => { ei.matchedWordCount = 1.5; },
    formatVersion_string: (ei) => { ei.formatVersion = "1"; },
    formatVersion_missing: (ei) => { delete ei.formatVersion; },
    source_tuple_not_array: (ei) => { ei.sources[0] = "src-1"; },
    source_shape_not_object: (ei) => { ei.sourceShapes[ei.sources[0][1]] = null; },
  };
  for (const [name, mutate] of Object.entries(damage)) {
    const wire = compactWire();
    mutate(wire.evidenceInterpretation);
    const result = tryDecodeReportFromPersistence(wire);
    assert.equal(result.ok, false, `${name}: refused — never an empty or partial interpretation`);
  }
  // absent stays absent; ok:true is only ever returned with EXACTLY the persisted explanation
  const absent = compactWire();
  delete absent.evidenceInterpretation;
  const absentResult = tryDecodeReportFromPersistence(absent);
  assert.equal(absentResult.ok && "evidenceInterpretation" in absentResult.report, false);
  const intact = tryDecodeReportFromPersistence(compactWire());
  assert.equal(intact.ok, true);
  assert.deepEqual(intact.report.evidenceInterpretation, jsonNormalised(FULL.evidenceInterpretation));
});

test("R8. compact internals NEVER leak through any successfully served surface: owner GET, SSR first paint, developer route, inspector page (compact rows, gate ON and OFF)", async () => {
  const owner = await account();
  const admin = await account({ admin: true });
  const id = nextId("r8");
  await seedRow(owner, id, COMPACT_ROW_JSON);
  await seedRow(admin, id, COMPACT_ROW_JSON);
  for (const value of [undefined, "true"]) {
    await withFlag(value, async () => {
      const label = `flag ${JSON.stringify(value)}`;
      assertNoCompactLeak((await get(owner, id)).text, `owner GET (${label})`);
      assertNoCompactLeak((await get(admin, id)).text, `admin GET (${label})`);
      const page = await ssr(owner, id);
      assert.equal(page.kind, "shell");
      assertNoCompactLeak(JSON.stringify(page.shellProps), `SSR props (${label})`);
      const dev = await developerGet(admin, admin.deviceKey, id);
      assert.equal(dev.status, 200);
      assertNoCompactLeak(dev.text, `developer route (${label})`);
      const inspected = await adminInspector(admin, admin.deviceKey, id);
      assert.match(inspected.html, /Report overview/);
      assertNoCompactLeak(inspected.html, `inspector page (${label})`);
    });
  }
  // no private provenance either, for the customer
  const owned = (await get(owner, id)).text;
  for (const privateBit of ["imported-similarity-evidence:", "U-1", "rep-A", "TURNITIN_SOURCE_MARKER_ONLY", "excluded_effective_device_self"]) {
    assert.equal(owned.includes(privateBit), false, `a customer response must not contain ${privateBit}`);
  }
});

test("R9. the decoder's server-side log carries a BOUNDED REASON ONLY: a closed event shape, never report text, ids, titles, device keys, accounts or passages", async () => {
  const { owner, admin, id } = await damagedPair("logs", INTERPRETATION_DAMAGE.count_mismatch.mutate);
  const { lines } = await captureErrors(async () => {
    await get(owner, id);
    await ssr(owner, id);
    await developerGet(admin, owner.deviceKey, id);
    await get(admin, id);
    await getReportSimilarityDecisionTrace(db, owner.deviceKey, id);
    await assert.rejects(() => getReportDeepDiveForDeveloper(db, owner.deviceKey, id));
  });
  const events = lines.filter((line) => line.includes("report_persistence_unreadable"));
  assert.ok(events.length >= 5, `every failed read logged (${events.length})`);
  for (const line of events) {
    assert.match(line, /^\{"event":"report_persistence_unreadable","reason":"(unsupported_compact_format|corrupt_evidence_interpretation|corrupt_contributions|invalid_persisted_report)","detail":"[A-Z_]+","outcome":"(refused|served_without_contributions)"\}$/, "the closed event shape");
  }
  const everything = lines.join("\n");
  for (const forbidden of ["w1x", "w2x", "r2 fixture", owner.deviceKey, admin.deviceKey, owner.email, admin.email, owner.userId, id, "Src"]) {
    assert.equal(everything.includes(forbidden), false, `logs must not contain ${JSON.stringify(forbidden)}`);
  }
  // and a corrupt-contributions log names the reason, still no content
  const a = await account();
  const cid = nextId("r9c");
  const compactObj = JSON.parse(COMPACT_ROW_JSON);
  await seedRow(a, cid, JSON.stringify({ ...compactObj, unifiedSimilarity: { ...compactObj.unifiedSimilarity, contributions: { format: "compact", formatVersion: 1, strings: "x", rows: [] } } }));
  const contribLog = await captureErrors(() => get(a, cid));
  assert.equal(contribLog.result.status, 200);
  assert.ok(contribLog.lines.some((l) => l === '{"event":"report_persistence_unreadable","reason":"corrupt_contributions","detail":"MALFORMED","outcome":"served_without_contributions"}'));
});

// ════════════════════════════════════════════════════════════════════════════
// U. CUSTOMER ERROR UX
// ════════════════════════════════════════════════════════════════════════════
test("U1. the customer sees ONE generic, non-technical 'temporarily unavailable' state (existing panel conventions, a way back) — never a number, never a technical term", async () => {
  const { ReportUnavailablePanel } = await import("../components/report/report-unavailable-panel.tsx");
  const { ReportNotFoundPanel } = await import("../components/report/report-not-found-panel.tsx");
  const React = (await import("react")).default;
  const html = renderToStaticMarkup(React.createElement(ReportUnavailablePanel));
  assert.match(html, /This report is temporarily unavailable\./);
  assert.match(html, /try again/i);
  assert.match(html, /contact support/i);
  assert.match(html, /href="\/#reports"/);
  assert.match(html, /role="status"/);
  assert.equal(/\d/.test(html), false, "no digit — hence no similarity number — can appear");
  assertNoTechnicalTerms(html, "unavailable panel");
  // same visual language as the existing not-found panel
  const notFound = renderToStaticMarkup(React.createElement(ReportNotFoundPanel));
  assert.ok(notFound.includes('class="ai-analysis-message"') && html.includes('class="ai-analysis-message"'));
  // the API refusal is a fixed, generic pair — identical for every cause
  const first = await damagedPair("u1", INTERPRETATION_DAMAGE.unsupported_version.mutate);
  const second = await damagedPair("u1b", INTERPRETATION_DAMAGE.bad_compact_tuple.mutate);
  const a = (await captureErrors(() => get(first.owner, first.id))).result;
  const b = (await captureErrors(() => get(second.owner, second.id))).result;
  assert.equal(a.text, b.text, "unsupported and corrupt are indistinguishable to the customer");
});

// ════════════════════════════════════════════════════════════════════════════
// X. READER-FIRST ROLLOUT + ROLLBACK
// ════════════════════════════════════════════════════════════════════════════
/** What a PRE-C2 reader does with a stored row: it knows only the legacy shape (JSON.parse and use it). */
function preC2ReaderCanExplain(row) {
  return Array.isArray(row.evidenceInterpretation?.passages) && Array.isArray(row.evidenceInterpretation?.sources) && Array.isArray(row.unifiedSimilarity?.contributions);
}

test("X1. READER-FIRST ROLLOUT: PHASE 1 (gate OFF) writes NO compact row; PHASE 2 (gate ON) writes compact/1 rows every current reader reads; PHASE 3 (gate OFF again) stops FUTURE compact writes yet still reads the existing compact rows", async () => {
  configurePackage(SMALL_PACKAGE);
  try {
    const admin = await account({ admin: true });
    const rowsByPhase = { 1: [], 2: [], 3: [] };
    let room = 0;
    const save = async (phase, gate) => {
      const id = nextId(`x1-p${phase}`);
      await withFlag(gate, async () => assert.equal((await post(admin, id, importedOpts({ room: room++ }))).status, 200));
      rowsByPhase[phase].push(id);
      return id;
    };

    // PHASE 1 — new code deployed everywhere, gate OFF (the default)
    const p1 = await save(1, undefined);
    const p1Raw = await rawRow(admin, p1);
    assert.equal(isCompactEvidenceInterpretation(p1Raw.evidenceInterpretation), false, "Step 21A: gate OFF prevents creation of a compact interpretation");
    assert.equal(Array.isArray(p1Raw.unifiedSimilarity.contributions), true, "...and of compact contributions");
    assert.equal(preC2ReaderCanExplain(p1Raw), true, "a pre-C2 reader (still in the fleet mid-rollout) can explain every phase-1 row");
    assert.equal((await get(admin, p1)).status, 200);

    // PHASE 2 — fleet converged, gate ON
    const p2 = await save(2, "true");
    const p2Raw = await rawRow(admin, p2);
    assert.equal(isCompactEvidenceInterpretation(p2Raw.evidenceInterpretation), true, "Step 21B: gate ON creates compact/1");
    assert.equal(p2Raw.unifiedSimilarity.contributions.format, "compact");
    for (const gate of [undefined, "true"]) {
      await withFlag(gate, async () => {
        assert.equal((await get(admin, p2)).status, 200, "every current reader reads compact/1");
        assert.equal((await ssr(admin, p2)).kind, "shell");
        assert.equal((await developerGet(admin, admin.deviceKey, p2)).status, 200);
      });
    }
    // The honest limitation: a PRE-C2 binary cannot explain a compact row. The gate protects the rollout; it does not (and cannot) rescue an old binary afterwards.
    assert.equal(preC2ReaderCanExplain(p2Raw), false, "PRE_C2_BINARY_ROLLBACK_AFTER_COMPACT_WRITES = UNSAFE (documented, not hidden)");

    // PHASE 3 — emergency stop: gate OFF again
    const p3 = await save(3, undefined);
    const p3Raw = await rawRow(admin, p3);
    assert.equal(isCompactEvidenceInterpretation(p3Raw.evidenceInterpretation), false, "Step 21C: turning the gate OFF stops FUTURE compact writes");
    assert.equal(preC2ReaderCanExplain(p3Raw), true);
    await flagOff(async () => {
      const still = await get(admin, p2);
      assert.equal(still.status, 200, "Step 21D: the current reader still reads the already-written compact/1 row with the gate OFF");
      assert.ok(still.payload.evidenceInterpretation.passages.length > 0);
      assert.equal((await ssr(admin, p2)).kind, "shell");
      assert.equal((await get(admin, p1)).status, 200);
      assert.equal((await get(admin, p3)).status, 200);
    });

    // tally: compact rows exist only from the phase where the gate was opened
    const tally = {};
    for (const [phase, ids] of Object.entries(rowsByPhase)) {
      let compactRows = 0;
      for (const id of ids) if (isCompactEvidenceInterpretation((await rawRow(admin, id)).evidenceInterpretation)) compactRows += 1;
      tally[phase] = compactRows;
    }
    assert.deepEqual(tally, { 1: 0, 2: 1, 3: 0 });
  } finally {
    configurePackage(null);
  }
});
