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
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";
import { tokens } from "../lib/similarity-core.ts";
import { buildImportedSimilarityEvidencePackageFile } from "../lib/imported-similarity-evidence/package.ts";
import {
  resetImportedSimilarityEvidencePackageCacheForTest,
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest,
} from "../lib/imported-similarity-evidence/index.ts";
import { makeUnitRecord } from "./helpers/imported-similarity-evidence-fixtures.mjs";
import { finalizeSelectiveCorpusAuthoritativeReport } from "../lib/selective-corpus-authoritative.ts";
import { persistSelectiveCorpusAuthoritativeFinalization } from "../lib/report-primary-similarity.ts";
import { decodeReportFromPersistence } from "../lib/report-persistence.ts";
import { expandEvidenceInterpretationFromPersistence } from "../lib/evidence-interpretation/persistence.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
// Namespace import on purpose: the shared finalized-report helper is read
// lazily inside the tests that need it, so a missing export fails ONLY those
// tests instead of failing this whole file at import time.
import * as interpretationWiring from "../lib/report-evidence-interpretation.ts";

/**
 * AUTHORITATIVE FINALIZER <-> EVIDENCE INTERPRETATION CONSISTENCY.
 *
 * INVARIANT under test: whenever the Selective Corpus authoritative finalizer
 * (lib/selective-corpus-authoritative.ts) persists a report's FINAL
 * unifiedSimilarity, the persisted evidenceInterpretation must be derived from
 * THAT SAME final unifiedSimilarity — so every customer-visible similarity
 * contribution has a truthful explanation, regardless of whether
 * SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED / SELECTIVE_CORPUS_SHADOW_ENABLED are
 * on (imported-evidence activation must not depend on those flags being off).
 *
 * WHY IT NEEDED A FIX: with the flags ON, POST persists a report that is
 * "pending" and has NO unifiedSimilarity at all, so its evidenceInterpretation
 * is built from archive-only positions (and no imported card can exist).
 * The deferred finalizer then writes unifiedSimilarity via a raw json_set that
 * touched only the similarity keys, leaving that early interpretation stale.
 *
 * Real route handlers + real finalizer + real libsql file DB (own file, in
 * the OS temp dir, removed afterwards). The deferred finalizer runs inline in
 * this harness (see lib/run-after-response.ts), so a SQLite trigger captures
 * the exact payload POST first persisted — the pending row — before the
 * finalizer overwrites it.
 */

const ANCHOR = "the distinctive constitutional framework governing judicial review procedures";
const MASK = [0, 1, 2, 4, 5, 6, 7];
const MANUSCRIPT = `This opening paragraph belongs only to this manuscript's own author and shares nothing else with any external source. ${ANCHOR}. And a closing paragraph follows with the author's own original concluding analysis and remarks, well beyond the shared passage.`;
const RWC = tokens(MANUSCRIPT).length;

const workDir = mkdtempSync(path.join(tmpdir(), "sc-auth-interp-"));
const dbFile = path.join(workDir, "sc_auth_interp.db");

function writePackage() {
  // Package METADATA only (never read by scoring); any neutral value works.
  const FIXTURE_REPORTED_PERCENT = 12;
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK, reportedSimilarityPercent: FIXTURE_REPORTED_PERCENT });
  const evidenceSets = [{
    evidenceSetId: "ES-TEST00000001",
    provenanceType: "TURNITIN_REPORT_IMPORT",
    reportSha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    reportedSimilarityPercent: FIXTURE_REPORTED_PERCENT,
    normalizationVersion: unit.normalizationVersion,
    manuscriptIdentitySha256: null,
    createdAt: "2026-09-19T00:00:00.000Z",
    unitCount: 1,
    totalScoreMaskWords: unit.scoreMaskWordCount,
  }];
  const filePath = path.join(workDir, "package.json");
  fs.writeFileSync(filePath, JSON.stringify(buildImportedSimilarityEvidencePackageFile(evidenceSets, [unit])));
  return filePath;
}

const ENV_KEYS = [
  "TURSO_DATABASE_URL",
  "CORPUS_SOURCE_MATCHING_ENABLED",
  "IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH",
  "SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED",
  "SELECTIVE_CORPUS_SHADOW_ENABLED",
  "SELECTIVE_CORPUS_ARTIFACT_PATH",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
delete process.env.SELECTIVE_CORPUS_ARTIFACT_PATH;

const db = createClient({ url: `file:${dbFile}` });
await db.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(db, path.resolve("drizzle"));
// Captures the payload POST FIRST persists for each report (an INSERT), before
// the deferred finalizer's UPDATE overwrites it. A resave is an UPDATE via
// ON CONFLICT, which does not fire this trigger, so the capture is never
// overwritten by a later save.
await db.execute("CREATE TABLE tp_test_first_write (device_key TEXT NOT NULL, id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (device_key, id))");
await db.execute(
  "CREATE TRIGGER tp_test_capture_first_write AFTER INSERT ON saved_reports BEGIN INSERT OR REPLACE INTO tp_test_first_write (device_key, id, payload_json) VALUES (NEW.device_key, NEW.id, NEW.payload_json); END",
);

const packagePath = writePackage();
function configurePackage(on) {
  if (on) process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH = packagePath;
  else delete process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH;
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
}
configurePackage(true);

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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function withAuthoritativeFlags(fn) {
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = "true";
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = "true";
  try { return await fn(); } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
    delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  }
}

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let uc = 0;
async function account() {
  uc += 1;
  await resetAuthRateForTest("scai-signup-" + uc);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "scai-signup-" + uc },
    body: JSON.stringify(withTestIdentity({ email: `scai-${uc}@example.test`, password: "scai-pw-123456", username: `scaiu${uc}`, deviceKey: `scai-dev-${uc}` })),
  }));
  assert.equal(res.status, 201);
  return { deviceKey: `scai-dev-${uc}`, cookie: cookieOf(res), tag: `scai-${uc}` };
}

async function post(acc, id, extra = {}, text = MANUSCRIPT) {
  await resetRateForTest(acc.tag + "-post");
  const wordCount = tokens(text).length;
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": acc.tag + "-post", cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "scai fixture",
      createdAt: new Date().toISOString(), wordCount, archiveScore: 0, scoreBand: "Low",
      aiScore: 2, aiTone: "low", aiStatus: "ready",
      payload: {
        version: 11, id, submissionId: "sub-" + id, title: "scai fixture", author: "", assignment: "",
        created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount, scoreBand: "Low",
        matchedWordCount: 0, sources: [], repeats: [], text,
      },
      ...extra,
    }),
  }));
}

// C2: persisted rows carry compact forms (contributions, evidenceInterpretation) — both readers decode
// exactly as the real GET/SSR boundaries do (lib/report-persistence.ts).
async function readRow(deviceKey, id) {
  const r = await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  if (!r.rows[0]) return null;
  return decodeReportFromPersistence(JSON.parse(String(r.rows[0].payload_json)));
}
async function readRawRow(deviceKey, id) {
  const r = await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  return r.rows[0] ? String(r.rows[0].payload_json) : null;
}
async function readFirstWrite(deviceKey, id) {
  const r = await db.execute({ sql: "SELECT payload_json FROM tp_test_first_write WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  return r.rows[0] ? decodeReportFromPersistence(JSON.parse(String(r.rows[0].payload_json))) : null;
}

let seq = 0;
/** Seeds a brand-new pending row whose payload is a copy of `sourcePayload` (a
 *  real, route-produced payload) with every final-score key stripped and the
 *  marker forced to "pending" — i.e. exactly the state the deferred finalizer
 *  is handed, keeping whatever interpretation POST built at that time. */
async function seedPendingClone(sourcePayload, { padFor } = {}) {
  seq += 1;
  const deviceKey = `scai-clone-dev-${seq}`;
  const id = `scai-clone-${seq}`;
  const p = structuredClone(sourcePayload);
  for (const k of ["unifiedSimilarity", "unifiedSimilarityGeneration", "corpusSourceMatchingEnabledAtComputation", "unifiedSimilarityFailed", "selectiveCorpusAuthoritativeClaimedAt"]) delete p[k];
  p.selectiveCorpusAuthoritativeStatus = "pending";
  if (padFor) {
    // padFor(baseLen) -> how many filler bytes to add so the seeded payload is an exact size.
    p.testPadding = "";
    p.testPadding = "x".repeat(padFor(JSON.stringify(p).length));
  }
  await db.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey, "sub-" + id, "clone", new Date().toISOString(), p.wordCount, 0, "Low", JSON.stringify(p), null, null],
  });
  return { deviceKey, id };
}

function completedShadowResult(ranges) {
  const verifiedEvidence = ranges.length === 0 ? [] : [{
    sourceLabel: "S1",
    matchedPassages: ranges.map(([s, e]) => ({ submittedWordStart: s, submittedWordEnd: e, matchedWordCount: e - s + 1 })),
  }];
  return { state: "COMPLETED", ...(verifiedEvidence.length > 0 ? { verifiedEvidence } : {}) };
}

async function finalize(clone, ranges) {
  const result = await finalizeSelectiveCorpusAuthoritativeReport(db, {
    reportDeviceKey: clone.deviceKey, reportId: clone.id, accountId: null, shadowResult: completedShadowResult(ranges),
  });
  assert.equal(result.outcome, "finalized", "sanity: the authoritative finalizer landed its terminal write");
  return readRow(clone.deviceKey, clone.id);
}

const sumOf = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const importedCards = (p) => p.evidenceInterpretation.sources.filter((s) => s.sourceType === "imported-similarity-evidence");

/** The whole customer-facing contract in one place: the persisted
 *  interpretation must be a disjoint partition of EXACTLY the persisted final
 *  unifiedSimilarity.matchedPositions union — same size, same positions. */
function assertInterpretationMatchesFinalScore(p, label) {
  const u = p.unifiedSimilarity;
  const ei = p.evidenceInterpretation;
  assert.ok(u, `${label}: final unifiedSimilarity is persisted`);
  assert.ok(ei, `${label}: evidenceInterpretation is persisted`);
  const union = [...u.matchedPositions].sort((a, b) => a - b);
  assert.equal(ei.matchedWordCount, union.length, `${label}: interpretation matched-word count reconciles with the final unified union`);
  assert.equal(u.uniqueMatchedWords, union.length, `${label}: (control) the score itself counts the union once`);
  const parts = Object.values(ei.positionsByKind).flat();
  assert.equal(parts.length, new Set(parts).size, `${label}: no position is partitioned twice (no double counting)`);
  assert.deepEqual([...parts].sort((a, b) => a - b), union, `${label}: the partition is EXACTLY the final union`);
  assert.equal(sumOf(ei.countsByKind), union.length, `${label}: countsByKind reconciles with the final union`);
  const passageWords = ei.passages.reduce((n, pg) => n + (pg.wordEnd - pg.wordStart + 1), 0);
  assert.equal(passageWords, union.length, `${label}: passages cover exactly the final union`);
  const passageIds = new Set(ei.passages.map((pg) => pg.id));
  const sourceIds = new Set(ei.sources.map((s) => s.id));
  assert.equal(sourceIds.size, ei.sources.length, `${label}: no duplicate source cards`);
  for (const s of ei.sources) for (const ref of s.passageRefs) assert.ok(passageIds.has(ref), `${label}: card passageRef ${ref} resolves to a real passage`);
  for (const pg of ei.passages) for (const sid of pg.sourceIds) assert.ok(sourceIds.has(sid), `${label}: passage sourceId ${sid} resolves to a real card`);
}

// One flags-OFF control POST (the validated write-time path, untouched by this
// fix) — gives the expected imported positions and the baseline interpretation.
let controlCache = null;
async function flagsOffControl() {
  if (controlCache) return controlCache;
  configurePackage(true);
  const acc = await account();
  const id = "scai-control-off";
  const res = await post(acc, id, { room: 0 });
  assert.equal(res.status, 200);
  const payload = await readRow(acc.deviceKey, id);
  controlCache = { acc, id, payload, importedPositions: payload.unifiedSimilarity.importedSimilarityEvidencePositions };
  return controlCache;
}

// ---------------------------------------------------------------------------
// 1. ROOT CAUSE, through the REAL POST route with the flags ON
// ---------------------------------------------------------------------------
test("FLAGS ON, real POST + deferred finalizer: the POST-time payload has NO unifiedSimilarity, and the FINAL persisted interpretation is derived from the FINAL score (imported card present)", async () => {
  const control = await flagsOffControl();
  configurePackage(true);
  await withAuthoritativeFlags(async () => {
    const acc = await account();
    const id = "scai-flagson-1";
    assert.equal((await post(acc, id, { room: 0 })).status, 200);

    // ORDER PROOF — what POST first persisted (before the finalizer ran):
    const pending = await readFirstWrite(acc.deviceKey, id);
    assert.equal(pending.selectiveCorpusAuthoritativeStatus, "pending");
    assert.equal(pending.unifiedSimilarity, undefined, "POST persisted the report with NO unifiedSimilarity while pending");
    assert.ok(pending.evidenceInterpretation, "POST did persist an interpretation at that time...");
    assert.equal(importedCards(pending).length, 0, "...but built from a report that had no unified score, so it can never carry the imported card");

    // FINAL state after the deferred finalizer's rewrite of unifiedSimilarity:
    const final = await readRow(acc.deviceKey, id);
    assert.equal(final.selectiveCorpusAuthoritativeStatus, "incomplete", "no artifact configured -> the finalizer lands the honest terminal 'incomplete' state");
    assert.equal(final.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, MASK.length, "the FINAL score carries the imported contribution");
    assert.deepEqual(final.unifiedSimilarity.importedSimilarityEvidencePositions, control.importedPositions);
    assertInterpretationMatchesFinalScore(final, "flags-on final");
    assert.equal(importedCards(final).length, 1, "the imported card exists alongside the imported score contribution");
    assert.equal(importedCards(final)[0].label, "Imported reference match");
    assert.equal(importedCards(final)[0].matchedWords, MASK.length);
    assert.equal(final.unifiedSimilarity.unifiedScore, control.payload.unifiedSimilarity.unifiedScore, "the headline is the same number the flags-OFF path produces — the fix changes explanation only, never the score");
  });
});

// ---------------------------------------------------------------------------
// 2. Selective Corpus evidence MATERIALLY changes the final score
// ---------------------------------------------------------------------------
test("FLAGS ON, Selective Corpus evidence materially changes the score: persisted score AND interpretation both reflect the FINAL union (incl. an overlap with imported evidence), imported card kept, nothing double-counted", async () => {
  const control = await flagsOffControl();
  configurePackage(true);
  const importedPositions = control.importedPositions;
  const firstImported = Math.min(...importedPositions);
  assert.ok(firstImported > 11, "fixture sanity: the imported span starts after the disjoint SC range [0..9] (+ a gap)");
  await withAuthoritativeFlags(async () => {
    const acc = await account();
    const id = "scai-flagson-2";
    assert.equal((await post(acc, id, { room: 0 })).status, 200);
    const pending = await readFirstWrite(acc.deviceKey, id);
    const clone = await seedPendingClone(pending);

    // Two SC ranges: one disjoint from the imported span, one OVERLAPPING its first 3 words.
    const scRanges = [[0, 9], [firstImported - 2, firstImported + 3]];
    const scPositions = new Set();
    for (const [s, e] of scRanges) for (let p = s; p <= e; p += 1) scPositions.add(p);
    const expectedUnion = [...new Set([...importedPositions, ...scPositions])].sort((a, b) => a - b);
    assert.ok(expectedUnion.length > importedPositions.length, "sanity: SC evidence really does change the union");

    const final = await finalize(clone, scRanges);
    assert.equal(final.selectiveCorpusAuthoritativeStatus, "completed");
    assert.deepEqual([...final.unifiedSimilarity.matchedPositions].sort((a, b) => a - b), expectedUnion, "the persisted FINAL score is the exact union of imported ∪ Selective Corpus");
    assert.ok(final.unifiedSimilarity.selectiveCorpusOnlyWords > 0);
    assert.ok(final.unifiedSimilarity.overlapWords >= 3, "sanity: the overlap region is scored once (overlapWords), not twice");
    assertInterpretationMatchesFinalScore(final, "SC+imported final");
    assert.equal(final.evidenceInterpretation.matchedWordCount, expectedUnion.length);
    assert.equal(importedCards(final).length, 1, "imported evidence is still admitted -> its card remains, exactly once");
    assert.equal(importedCards(final)[0].matchedWords, MASK.length, "the imported card's own count is unaffected by Selective Corpus evidence");
  });
});

// ---------------------------------------------------------------------------
// 3. Removed / no-longer-admitted evidence must not linger as a stale card
// ---------------------------------------------------------------------------
test("FLAGS ON, imported evidence NOT admitted at finalization time: a stale imported card from an earlier interpretation is never left behind", async () => {
  const control = await flagsOffControl();
  // `control.payload` is a REAL flags-OFF report: its interpretation HAS the imported card.
  assert.equal(importedCards(control.payload).length, 1, "sanity: the earlier interpretation carries an imported card");
  const clone = await seedPendingClone(control.payload);
  configurePackage(false); // the package is no longer configured when the finalizer resolves the score
  try {
    const final = await finalize(clone, []);
    assert.equal(final.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, 0, "the FINAL score has no imported contribution");
    assertInterpretationMatchesFinalScore(final, "imported-removed final");
    assert.equal(importedCards(final).length, 0, "no imported card without an imported contribution — no stale explanation of a score that is not there");
    assert.equal(final.evidenceInterpretation.matchedWordCount, 0);
  } finally {
    configurePackage(true);
  }
});

// ---------------------------------------------------------------------------
// 4. FLAGS OFF: the validated write-time path is unchanged, and the finalizer now
//    produces the SAME interpretation the write-time path would have
// ---------------------------------------------------------------------------
test("FLAGS OFF: write-time path unchanged (imported card, exact score, no marker) and a zero-evidence finalizer interpretation is IDENTICAL to the write-time interpretation", async () => {
  const control = await flagsOffControl();
  const p = control.payload;
  assert.equal(p.selectiveCorpusAuthoritativeStatus, undefined, "flags OFF: no authoritative marker is ever created");
  assert.equal(p.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, MASK.length);
  assertInterpretationMatchesFinalScore(p, "flags-off");
  assert.equal(importedCards(p).length, 1);
  assert.equal(importedCards(p)[0].label, "Imported reference match");

  // Parity: run the SAME manuscript through the finalizer with zero SC evidence.
  const clone = await seedPendingClone(p);
  const finalized = await finalize(clone, []);
  assert.deepEqual(finalized.evidenceInterpretation, p.evidenceInterpretation, "finalizer interpretation == write-time interpretation for the same final score (one semantics, two paths)");
  assert.equal(finalized.unifiedSimilarity.unifiedScore, p.unifiedSimilarity.unifiedScore);

  // Resave of the flags-OFF report stays stable, no duplicated cards.
  const before = structuredClone(p.evidenceInterpretation);
  assert.equal((await post(control.acc, control.id, {})).status, 200);
  const after = await readRow(control.acc.deviceKey, control.id);
  assert.deepEqual(after.evidenceInterpretation, before, "flags-OFF resave: interpretation byte-stable");
  assert.equal(importedCards(after).length, 1, "flags-OFF resave: no duplicate imported card");
});

// ---------------------------------------------------------------------------
// 5. Selective Corpus ONLY (no imported evidence)
// ---------------------------------------------------------------------------
test("SELECTIVE-CORPUS-ONLY (no imported package): score, positions and interpretation stay internally consistent; no card is fabricated for the unattributed passages", async () => {
  configurePackage(false);
  try {
    await withAuthoritativeFlags(async () => {
      const acc = await account();
      const id = "scai-sc-only";
      assert.equal((await post(acc, id, { room: 0 })).status, 200);
      const pending = await readFirstWrite(acc.deviceKey, id);
      const clone = await seedPendingClone(pending);

      const final = await finalize(clone, [[0, 9]]);
      assert.equal(final.unifiedSimilarity.selectiveCorpusOnlyWords, 10);
      assert.equal(final.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, 0);
      assert.deepEqual(final.unifiedSimilarity.matchedPositions, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assertInterpretationMatchesFinalScore(final, "sc-only final");
      assert.equal(final.evidenceInterpretation.matchedWordCount, 10);
      assert.equal(importedCards(final).length, 0);
      assert.equal(final.evidenceInterpretation.sources.length, 0, "Selective Corpus is not a report card producer today: its positions are explained by the partition only — no invented source card");
    });
  } finally {
    configurePackage(true);
  }
});

// ---------------------------------------------------------------------------
// 5b. ARCHIVE + USER-SUPPLIED REFERENCES — the fix is channel-agnostic
// ---------------------------------------------------------------------------
test("ARCHIVE + Selective Corpus + imported through the finalizer: every channel is in the final union and explained exactly once (archive card retained, counts reconcile)", async () => {
  const control = await flagsOffControl();
  configurePackage(true);
  const importedPositions = control.importedPositions;
  const archiveStart = Math.max(...importedPositions) + 3;
  const archivePositions = Array.from({ length: 6 }, (_, i) => archiveStart + i);
  assert.ok(archivePositions[archivePositions.length - 1] < RWC, "fixture sanity: archive range fits inside the manuscript");
  const withArchive = {
    ...structuredClone(control.payload),
    archiveMatchedPositions: archivePositions,
    sources: [{ name: "Archive Source A", type: "Publication", percent: 12, matchedWords: archivePositions.length }],
  };
  const clone = await seedPendingClone(withArchive);
  const final = await finalize(clone, [[0, 9]]);
  const expectedUnion = [...new Set([...importedPositions, ...archivePositions, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9])].sort((a, b) => a - b);
  assert.deepEqual([...final.unifiedSimilarity.matchedPositions].sort((a, b) => a - b), expectedUnion);
  assert.equal(final.unifiedSimilarity.archiveOnlyWords, archivePositions.length);
  assertInterpretationMatchesFinalScore(final, "archive+sc+imported final");
  const archiveCards = final.evidenceInterpretation.sources.filter((s) => s.sourceType === "publication");
  assert.equal(archiveCards.length, 1, "the archive card is present exactly once");
  assert.equal(archiveCards[0].matchedWords, archivePositions.length);
  assert.equal(archiveCards[0].namedSources?.[0]?.label, "Archive Source A");
  assert.equal(importedCards(final).length, 1);
});

test("USER-SUPPLIED REFERENCES via the finalizer: the final score never contained them (the finalizer's deliberate boundary), so the interpretation carries no reference card for them — persisted reference fields are left untouched", async () => {
  const control = await flagsOffControl();
  configurePackage(true);
  const refEvidence = [{
    key: "usr-ref:1", safeLabel: "my-reference.pdf", fileType: "pdf", extractionStatus: "EXTRACTED", analyzableWordCount: 500,
    matchedWords: 8, contributionPercent: 17, admitted: true, admissionReason: "ADMITTED",
    verifiedPassages: [{ submittedWordStart: 30, submittedWordEnd: 37, matchedWordCount: 8 }],
  }];
  const clone = await seedPendingClone({ ...structuredClone(control.payload), userSuppliedReferenceEvidence: refEvidence });
  const final = await finalize(clone, []);
  assert.equal(final.unifiedSimilarity.userSuppliedReferenceOnlyWords, 0, "sanity: the finalizer's score has no reference contribution");
  assert.ok(![...final.unifiedSimilarity.matchedPositions].some((p) => p >= 30 && p <= 37), "sanity: the reference-only positions are not in the final union");
  assertInterpretationMatchesFinalScore(final, "user-supplied-references final");
  assert.equal(final.evidenceInterpretation.sources.filter((s) => s.sourceType === "user-supplied-reference").length, 0, "no reference card for words the final score does not contain");
  assert.deepEqual(final.userSuppliedReferenceEvidence, refEvidence, "the persisted, server-verified reference evidence is untouched by the finalizer");
});

test("shared helper + USER-SUPPLIED REFERENCES: when the caller's score DID include the channel, its card appears (safe label only) and the partition reconciles", async () => {
  const build = interpretationWiring.buildFinalizedReportEvidenceInterpretation;
  assert.equal(typeof build, "function");
  const control = await flagsOffControl();
  const refEvidence = [{
    key: "usr-ref:1", safeLabel: "my-reference.pdf", fileType: "pdf", extractionStatus: "EXTRACTED", analyzableWordCount: 500,
    matchedWords: 8, contributionPercent: 17, admitted: true, admissionReason: "ADMITTED",
    verifiedPassages: [{ submittedWordStart: 30, submittedWordEnd: 37, matchedWordCount: 8 }],
  }];
  const unifiedSimilarity = computeUnifiedSimilarity({
    wordCount: RWC,
    userSuppliedReferenceEvidence: [{ sourceId: "usr-ref:1", matchedPassages: refEvidence[0].verifiedPassages }],
  });
  const report = { ...structuredClone(control.payload), unifiedSimilarity };
  // C2: the helper returns a result whose interpretation is in PERSISTED form (compact) — expand it as the read boundary does.
  const interpretationOf = (result) => {
    assert.equal(result.ok, true, "the helper produced a persistable interpretation");
    const expansion = expandEvidenceInterpretationFromPersistence(result.evidenceInterpretation);
    assert.notEqual(expansion.status, "unreadable");
    return expansion.value;
  };
  const withRef = interpretationOf(build(report, { userSuppliedReferenceEvidence: refEvidence }));
  assertInterpretationMatchesFinalScore({ unifiedSimilarity, evidenceInterpretation: withRef }, "helper with reference evidence");
  const refCards = withRef.sources.filter((s) => s.sourceType === "user-supplied-reference");
  assert.equal(refCards.length, 1);
  assert.equal(refCards[0].label, "my-reference.pdf");
  assert.equal(refCards[0].matchedWords, 8);
  // Without being told the score had the channel, the helper explains none of it (the positions still reconcile via the partition).
  const withoutRef = interpretationOf(build(report));
  assertInterpretationMatchesFinalScore({ unifiedSimilarity, evidenceInterpretation: withoutRef }, "helper without reference evidence");
  assert.equal(withoutRef.sources.filter((s) => s.sourceType === "user-supplied-reference").length, 0);
});

// ---------------------------------------------------------------------------
// 6. IMPORTED ONLY, through the finalizer
// ---------------------------------------------------------------------------
test("IMPORTED-ONLY via the finalizer (zero SC evidence): imported score and card unchanged, exactly one card, exactly one interpretation", async () => {
  const control = await flagsOffControl();
  configurePackage(true);
  await withAuthoritativeFlags(async () => {
    const acc = await account();
    const id = "scai-imported-only";
    assert.equal((await post(acc, id, { room: 0 })).status, 200);
    const final = await readRow(acc.deviceKey, id);
    assert.equal(final.unifiedSimilarity.selectiveCorpusOnlyWords, 0);
    assert.equal(final.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, MASK.length);
    assert.equal(final.unifiedSimilarity.unifiedScore, control.payload.unifiedSimilarity.unifiedScore);
    assertInterpretationMatchesFinalScore(final, "imported-only final");
    assert.equal(importedCards(final).length, 1);
    assert.deepEqual(final.evidenceInterpretation, control.payload.evidenceInterpretation, "same card content as the validated flags-OFF report");
    assert.equal(Object.keys(final).filter((k) => k === "evidenceInterpretation").length, 1);
  });
});

// ---------------------------------------------------------------------------
// 7. RESAVE after authoritative finalization
// ---------------------------------------------------------------------------
test("RESAVE after authoritative finalization: interpretation stays consistent with the persisted score, no duplicate/stale cards, GET serves it verbatim", async () => {
  configurePackage(true);
  await withAuthoritativeFlags(async () => {
    const acc = await account();
    const id = "scai-resave";
    assert.equal((await post(acc, id, { room: 0 })).status, 200);
    const firstFinal = await readRow(acc.deviceKey, id);
    assertInterpretationMatchesFinalScore(firstFinal, "before resave");

    assert.equal((await post(acc, id, {})).status, 200); // AI/enrichment-style resave: no room
    const afterResave = await readRow(acc.deviceKey, id);
    assert.equal(afterResave.selectiveCorpusAuthoritativeStatus, "incomplete", "terminal marker survives the resave");
    assert.equal(afterResave.unifiedSimilarity.unifiedScore, firstFinal.unifiedSimilarity.unifiedScore, "final score stable across the resave");
    assertInterpretationMatchesFinalScore(afterResave, "after resave");
    assert.equal(importedCards(afterResave).length, 1, "no duplicate imported card after the resave");
    assert.deepEqual(afterResave.evidenceInterpretation, firstFinal.evidenceInterpretation, "interpretation stable across the resave");

    await resetReadRateForTest(acc.tag + "-get");
    const res = await reportIdRoute.GET(
      new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(acc.deviceKey)}`, {
        headers: { "x-forwarded-for": acc.tag + "-get", cookie: `tp_session_v1=${acc.cookie}` },
      }),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(res.status, 200);
    const { payload } = await res.json();
    assert.deepEqual(payload.evidenceInterpretation, afterResave.evidenceInterpretation, "GET never recomputes: the customer sees exactly the persisted, final-consistent interpretation");
    assert.equal(payload.evidenceInterpretation.matchedWordCount, payload.unifiedSimilarity.matchedPositions.length);
  });
});

test("RESAVE of a finalized report that carried REAL Selective Corpus evidence: whatever score the resave persists, the interpretation is derived from that same score (never stale)", async () => {
  const control = await flagsOffControl();
  configurePackage(true);
  const clone = await seedPendingClone(control.payload);
  const finalized = await finalize(clone, [[0, 9]]);
  assertInterpretationMatchesFinalScore(finalized, "SC finalized, before resave");
  assert.ok(finalized.unifiedSimilarity.selectiveCorpusOnlyWords > 0, "sanity: the finalized score really carries SC evidence");

  // "Claim by resave": a fresh authenticated account resaves the pre-existing (never-claimed) row.
  const claimer = await account();
  const acc = { ...claimer, deviceKey: clone.deviceKey };
  await withAuthoritativeFlags(async () => {
    assert.equal((await post(acc, clone.id, {})).status, 200);
  });
  const afterResave = await readRow(clone.deviceKey, clone.id);
  assert.equal(afterResave.selectiveCorpusAuthoritativeStatus, "completed", "terminal marker survives the resave");
  // NOTE: deliberately NOT asserting the resave's SCORE here — an ordinary POST
  // resave re-resolves the score through the write-time path, which has no
  // Selective Corpus evidence to pass (a separate, pre-existing lifecycle
  // behavior outside this fix). What this fix guarantees, and this asserts, is
  // that the explanation always describes whichever final score is persisted.
  assertInterpretationMatchesFinalScore(afterResave, "SC finalized, after resave");
  assert.equal(importedCards(afterResave).length, 1, "imported card present exactly once after the resave");
});

// ---------------------------------------------------------------------------
// 8. persistSelectiveCorpusAuthoritativeFinalization write contract
// ---------------------------------------------------------------------------
test("persistSelectiveCorpusAuthoritativeFinalization: interpretation is written in the SAME atomic CAS write; undefined leaves it untouched, null is REJECTED (a score is never written while removing its explanation), a CAS loser can never overwrite it", async () => {
  const control = await flagsOffControl();
  const resolution = (extra) => ({
    unifiedSimilarity: control.payload.unifiedSimilarity,
    corpusSourceMatchingEnabled: true,
    corpusGeneration: 0,
    terminalStatus: "completed",
    ...extra,
  });
  const marker = { version: "marker", positionsByKind: {}, countsByKind: {}, matchedWordCount: 123, sources: [], passages: [], deferredKindsFolded: false };

  // undefined -> the pre-existing interpretation key is left exactly as it was.
  const a = await seedPendingClone(control.payload);
  const preexisting = (await readRow(a.deviceKey, a.id)).evidenceInterpretation;
  const wA = await persistSelectiveCorpusAuthoritativeFinalization(db, { reportDeviceKey: a.deviceKey, reportId: a.id }, resolution({}));
  assert.equal(wA.written, true);
  assert.deepEqual((await readRow(a.deviceKey, a.id)).evidenceInterpretation, preexisting, "undefined = do not touch (back-compat for direct callers)");

  // object -> replaced in the same statement as the score + the status flip.
  const b = await seedPendingClone(control.payload);
  const wB = await persistSelectiveCorpusAuthoritativeFinalization(db, { reportDeviceKey: b.deviceKey, reportId: b.id }, resolution({ evidenceInterpretation: marker }));
  assert.equal(wB.written, true);
  const rowB = await readRow(b.deviceKey, b.id);
  assert.deepEqual(rowB.evidenceInterpretation, marker);
  assert.equal(rowB.selectiveCorpusAuthoritativeStatus, "completed");
  assert.ok(rowB.unifiedSimilarity, "score and interpretation landed together");

  // a CAS loser (row already terminal) must not overwrite the winner's interpretation.
  const loser = await persistSelectiveCorpusAuthoritativeFinalization(db, { reportDeviceKey: b.deviceKey, reportId: b.id }, resolution({ terminalStatus: "incomplete", evidenceInterpretation: { ...marker, matchedWordCount: 999 } }));
  assert.equal(loser.written, false, "CAS: already-terminal row is a clean no-op");
  assert.equal((await readRow(b.deviceKey, b.id)).evidenceInterpretation.matchedWordCount, 123, "the loser's interpretation never landed");

  // C2 — null is REJECTED: this write must never land a new score while removing its explanation.
  // Nothing is written: the pending row is byte-identical, still pending, no score, interpretation intact.
  const c = await seedPendingClone(control.payload);
  assert.ok((await readRow(c.deviceKey, c.id)).evidenceInterpretation, "sanity: an interpretation exists before the attempted write");
  const rawBeforeNull = await readRawRow(c.deviceKey, c.id);
  await assert.rejects(
    () => persistSelectiveCorpusAuthoritativeFinalization(db, { reportDeviceKey: c.deviceKey, reportId: c.id }, resolution({ evidenceInterpretation: null })),
    /refusing to write a final score while removing its evidenceInterpretation/,
  );
  assert.equal(await readRawRow(c.deviceKey, c.id), rawBeforeNull, "null is rejected before any write: the row is byte-identical");
  const rowC = await readRow(c.deviceKey, c.id);
  assert.equal(rowC.selectiveCorpusAuthoritativeStatus, "pending");
  assert.equal(rowC.unifiedSimilarity, undefined, "no score was introduced without its explanation");
  assert.ok(rowC.evidenceInterpretation, "the existing interpretation was not removed");
});

// ---------------------------------------------------------------------------
// 9. Shared helper: one builder, and the existing 2,000,000-byte save limit
// ---------------------------------------------------------------------------
test("shared helper: builds via the SAME withEvidenceInterpretation as the write-time path (identical output once expanded) and FAILS CLOSED — an explicit failure, never a null/'drop it' — when the ENCODED whole final report would not fit the existing save limit", async () => {
  const build = interpretationWiring.buildFinalizedReportEvidenceInterpretation;
  assert.equal(typeof build, "function", "the shared finalized-report interpretation helper must exist");
  const control = await flagsOffControl();
  const report = control.payload;
  // R2 write gate: compact writes are opt-in; pin them ON to assert the compact persisted form (the default-OFF legacy form is asserted below)
  const viaHelper = build(report, { compactWrites: true });
  assert.equal(viaHelper.ok, true);
  assert.equal(viaHelper.compactWrites, true, "the builder reports the mode it measured, so the write persists the same form");
  const viaWriteTime = interpretationWiring.withEvidenceInterpretation(report, {
    historicalSubmissionMatch: null,
    selectiveCorpusBranch: null,
    userSuppliedReferenceEvidence: null,
  }).evidenceInterpretation;
  const expansion = expandEvidenceInterpretationFromPersistence(viaHelper.evidenceInterpretation);
  assert.equal(expansion.status, "expanded", "the helper hands back the PERSISTED (compact) form");
  assert.deepEqual(expansion.value, viaWriteTime, "no second builder: helper output (expanded) == withEvidenceInterpretation output");
  // default (gate OFF): the same explanation, in the legacy persisted form
  const viaDefault = build(report);
  assert.equal(viaDefault.ok, true);
  assert.equal(viaDefault.compactWrites, false, "compact writes are OFF by default");
  assert.equal(expandEvidenceInterpretationFromPersistence(viaDefault.evidenceInterpretation).status, "legacy", "gate OFF: the helper hands back the legacy form");
  assert.deepEqual(viaDefault.evidenceInterpretation, viaWriteTime, "and it is exactly the write-time interpretation");
  const tooSmall = build(report, { maxBytes: 10 });
  assert.deepEqual(
    { ok: tooSmall.ok, reason: tooSmall.reason, maxBytes: tooSmall.maxBytes },
    { ok: false, reason: "PERSISTED_SIZE_EXCEEDED", maxBytes: 10 },
    "does not fit -> an explicit failure; the caller must not write the score",
  );
  assert.ok(tooSmall.persistedBytes > 10, "the failure reports the measured encoded size");
  assert.equal("evidenceInterpretation" in tooSmall, false, "a failure carries nothing to persist — there is no 'persist the score and drop the interpretation' outcome");
  assert.equal(build(report, { maxBytes: MAX_REPORT_SAVE_REQUEST_BYTES }).ok, true, "the default limit is the existing, unchanged MAX_REPORT_SAVE_REQUEST_BYTES");
});

test("FLAGS ON, final report too large for the existing save limit: FAIL CLOSED — the finalizer writes NOTHING (no new score, no explanation removed), reports persistence-limit-exceeded, and the pending row is byte-identical", async () => {
  const control = await flagsOffControl();
  // A pending payload already ~100 bytes under the limit: the final score + its
  // interpretation cannot fit even in compact form.
  const clone = await seedPendingClone(control.payload, { padFor: (baseLen) => MAX_REPORT_SAVE_REQUEST_BYTES - 100 - baseLen });
  const before = await readRawRow(clone.deviceKey, clone.id);
  assert.ok((await readRow(clone.deviceKey, clone.id)).evidenceInterpretation, "sanity: the pending row carries its (archive-only) interpretation");

  const result = await finalizeSelectiveCorpusAuthoritativeReport(db, {
    reportDeviceKey: clone.deviceKey, reportId: clone.id, accountId: null, shadowResult: completedShadowResult([]),
  });
  assert.deepEqual(result, { outcome: "persistence-limit-exceeded" });

  assert.equal(await readRawRow(clone.deviceKey, clone.id), before, "nothing was written: the row is byte-identical");
  const after = await readRow(clone.deviceKey, clone.id);
  assert.equal(after.selectiveCorpusAuthoritativeStatus, "pending", "no terminal transition without an explainable score");
  assert.equal(after.unifiedSimilarity, undefined, "no unexplained score was introduced");
  assert.ok(after.evidenceInterpretation, "the prior interpretation was not removed");
});
