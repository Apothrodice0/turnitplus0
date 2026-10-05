import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as aiRetryRoute from '../app/api/reports/[id]/ai-retry/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest, resetPollRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';
import { completeAiAnalysis } from './helpers/complete-ai-analysis.mjs';
import { makeUnitRecord, makePackageFile } from './helpers/imported-similarity-evidence-fixtures.mjs';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import { canonicalSha256, createDocumentIdentity } from '../lib/document-identity.ts';
import { recordAcademicSearchRunDiagnostics } from '../lib/academic-search-diagnostics-repo.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { bumpCorpusMatchGeneration } from '../lib/corpus-match-generation.ts';
import { withEvidenceInterpretation } from '../lib/report-evidence-interpretation.ts';
import { decodeReportFromPersistence, encodeReportForPersistence } from '../lib/report-persistence.ts';
import { isFormatMarkedPositions } from '../lib/position-runs-persistence.ts';
import { finalizeSelectiveCorpusAuthoritativeReport, MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS } from '../lib/selective-corpus-authoritative.ts';
import {
  resetImportedSimilarityEvidencePackageCacheForTest,
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest,
} from '../lib/imported-similarity-evidence/index.ts';

/**
 * A SAVE NEVER MOVES THE FLAT SIMILARITY COLUMNS OF A FINALIZED REPORT.
 *
 * saved_reports keeps a report twice: `payload_json`, and a few flat columns the lists read without parsing it
 * (word_count, archive_score, score_band). Once the Selective Corpus finalizer has made an authoritative report terminal,
 * a save keeps the stored payload and merges only the request's AI half (tests/selective-corpus-finalized-resave.test.mjs).
 * The flat columns were still taken from the request: a forged save of a finalized report stored `archive_score = 99`
 * beside a payload that says otherwise, and the report lists showed it.
 *
 * This file pins the rule for the whole row, through the real routes, the real finalizer and the real upsert statement:
 *   - whatever a save of a terminal report carries — in the flat fields of the request, in its payload, or beside it —
 *     the flat similarity columns, every stored payload key but the AI half, the previous-submission snapshot and every
 *     other table stay exactly as they were;
 *   - what may still write them still does: the AI half of any save, every save of a report that is still pending, the
 *     finalizer, and every save of a report that is not authoritative.
 * Both compact-positions write gates are covered. Every corpus is synthetic.
 */

const ENV_KEYS = [
  'TURSO_DATABASE_URL',
  'CORPUS_SOURCE_MATCHING_ENABLED',
  'REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED',
  'REPORT_COMPACT_POSITIONS_WRITE_ENABLED',
  'IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH',
  'SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED',
  'SELECTIVE_CORPUS_SHADOW_ENABLED',
  'SELECTIVE_CORPUS_ARTIFACT_PATH',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const workDir = mkdtempSync(path.join(process.env.TURNITPLUS_TEST_DB_DIR || tmpdir(), 'sc-finalized-flat-'));
const dbFile = path.join(workDir, 'sc_finalized_flat.db');
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
process.env.REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED = 'true';
delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
delete process.env.SELECTIVE_CORPUS_ARTIFACT_PATH;

// One imported-evidence unit; only a manuscript that contains ANCHOR matches it.
const ANCHOR = 'the distinctive constitutional framework governing judicial review procedures';
const packagePath = path.join(workDir, 'package.json');
fs.writeFileSync(packagePath, JSON.stringify(makePackageFile([
  makeUnitRecord({ evidenceUnitId: 'PU0001', anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: [0, 1, 2, 4, 5, 6, 7], reportedSimilarityPercent: 12 }),
], { reportedSimilarityPercent: 12 })));
process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH = packagePath;
resetImportedSimilarityEvidencePackageCacheForTest();
resetImportedSimilarityEvidenceCandidateIndexCacheForTest();

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, path.resolve('drizzle'));

test.after(() => {
  client.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Runs `fn` with the compact-positions write gate pinned on or off, whatever the run's own setting is. */
async function withPositionsGate(on, fn) {
  const before = process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED;
  if (on) process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED = 'true';
  else delete process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED;
    else process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED = before;
  }
}
const GATES = [['off', false], ['on', true]];

// ===========================================================================
// fixtures
// ===========================================================================

const SYLLABLES = ['ka', 'lo', 'mi', 'tre', 'vun', 'sor', 'bel', 'dra', 'phi', 'quen', 'zor', 'tal', 'mer', 'nix', 'ost', 'ula', 'rin', 'vek', 'dom', 'sha', 'gri', 'pol', 'wex', 'yun'];
function words(count, seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length]);
  return out.join(' ');
}
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
const scoreBandOf = (score) => (score > 40 ? 'High' : score >= 20 ? 'Moderate' : 'Low');

let accounts = 0;
async function signUpOwner() {
  accounts += 1;
  const tag = `ff-${accounts}`, email = `ff-owner-${accounts}@example.test`, deviceKey = `ff-device-${accounts}`;
  await resetAuthRateForTest(`${tag}-signup`);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${tag}-signup` },
    body: JSON.stringify(withTestIdentity({ email, password: 'ff-owner-pw-1', username: `ffowner${accounts}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = (res.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)[1];
  const userId = String((await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  return { userId, deviceKey, cookie, tag };
}

/** The report as the browser holds it after its check: its own archive result, no server score, no AI result yet. */
function localReport(id, text, { archiveMatchedPositions = [], archiveScore = 0 } = {}) {
  return {
    version: 11, id, submissionId: `sub-${id}`, title: 'Finalized flat-column fixture', author: '', assignment: '', created: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    score: archiveScore, archiveScore, scoreBand: scoreBandOf(archiveScore), wordCount: tokensForScoringNormalization(text, 2).length, characterCount: text.length,
    matchedWordCount: archiveMatchedPositions.length, archiveMatchedPositions, scoringNormalizationVersion: 2,
    sources: [], repeats: [], text, academicEvidenceStatus: 'COMPLETE_NO_MATCHES', externalAcademicEvidence: [],
  };
}

/**
 * The row an authoritative first save persists, flat columns included: no unifiedSimilarity, the marker "pending", the AI
 * check still running, in room 0. `serverFields` are what the server stamps on the row and never returns to the browser.
 */
async function seedPending(owner, report, serverFields = {}) {
  const built = withEvidenceInterpretation({ ...report, ...serverFields }, { selectiveCorpusBranch: null });
  const payload = { ...encodeReportForPersistence(built), selectiveCorpusAuthoritativeStatus: 'pending' };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_status, payload_json, user_id, room_number)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [report.id, owner.deviceKey, report.submissionId, report.title, report.created, report.wordCount, report.archiveScore, report.scoreBand, 'processing', JSON.stringify(payload), owner.userId, 0],
  });
}

const EVALUATOR_VERSION = 'selective-corpus-shadow-v1';
const passage = (start, end) => ({ submittedWordStart: start, submittedWordEnd: end, matchedWordCount: end - start + 1 });
const completedShadow = (passages) => ({
  state: 'COMPLETED', evaluatorVersion: EVALUATOR_VERSION, corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
  verifiedEvidence: passages.length > 0 ? [{ sourceLabel: 'S1', matchedPassages: passages }] : [],
});
const partialShadow = (passages) => ({ ...completedShadow(passages), state: 'PARTIAL', degradedShardCount: 1 });
const timeoutShadow = () => ({
  state: 'TIMEOUT', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'TIMEOUT', failureMessage: 'time budget exceeded during Stage B verification',
  corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
});
const finalize = (owner, id, shadowResult) =>
  finalizeSelectiveCorpusAuthoritativeReport(client, { reportDeviceKey: owner.deviceKey, reportId: id, accountId: owner.userId, shadowResult, shadowScoringNormalizationVersion: 2 });

/**
 * A pending authoritative report the finalizer has just made terminal. Default: 3,000 words, the browser's own archive
 * result 3 % (positions 350-449), Selective Corpus passage 100-399 — final similarity 12 % (350 words).
 */
async function finalizedReport(id, text = words(3000, id.length * 131 + 7), {
  passages = [passage(100, 399)], shadow = completedShadow, archiveMatchedPositions = range(350, 449), archiveScore = 3, reportFields = {}, serverFields = {},
} = {}) {
  const owner = await signUpOwner();
  const report = { ...localReport(id, text, { archiveMatchedPositions, archiveScore }), ...reportFields };
  await seedPending(owner, report, serverFields);
  assert.equal((await finalize(owner, id, shadow(passages))).outcome, 'finalized', 'test setup sanity: the finalizer wrote the final score');
  return { owner, report };
}

const failedAiAnalysis = () => ({ status: 'error', score: null, model: 'fixture-model', engine: null, error: 'fixture model failure', passages: [] });

let requests = 0;
/**
 * POST /api/reports as the browser's AI save sends it (room-page-shell.tsx saveEnrichedAiResult): the report it holds, the
 * AI result spread over it, and the AI lifecycle state. `payload` / `body` add or replace fields of either.
 */
async function save(owner, report, { aiStatus = 'ready', aiScore = 5, aiTone = 'low', aiAnalysis = completeAiAnalysis(), payload = {}, body = {} } = {}) {
  requests += 1;
  const ip = `${owner.tag}-post-${requests}`;
  await resetRateForTest(ip);
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` },
    body: JSON.stringify({
      deviceKey: owner.deviceKey, id: report.id, submissionId: report.submissionId, title: report.title, createdAt: report.created,
      wordCount: report.wordCount, archiveScore: report.archiveScore, scoreBand: report.scoreBand,
      aiScore, aiTone, aiStatus, scoringNormalization: 2, academicSearchDiagnosticsId: null,
      payload: { ...report, ...(aiAnalysis ? { aiScore, aiAnalysis } : {}), ...payload },
      ...body,
    }),
  }));
}

const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
/** A content digest of every table: which tables did a request write? */
async function tableDigests() {
  const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((r) => String(r.name));
  const out = {};
  for (const name of tables) {
    const result = await client.execute(`SELECT * FROM "${name}"`);
    out[name] = digest(result.rows.map((r) => result.columns.map((column) => String(r[column])).join('\u0001')).join('\u0002'));
  }
  return out;
}
const rowsOf = (result) => result.rows.map((r) => Object.fromEntries(result.columns.map((column) => [column, r[column]])));

/** Everything stored for one report: every column of its row, its payload (raw and decoded), its previous-submission snapshot, and every table's digest. */
async function state(owner, id) {
  const [columns] = rowsOf(await client.execute({ sql: 'SELECT * FROM saved_reports WHERE device_key = ? AND id = ?', args: [owner.deviceKey, id] }));
  const json = String(columns.payload_json);
  return {
    columns, json, raw: JSON.parse(json),
    report: decodeReportFromPersistence(JSON.parse(json), { requireContributions: true }),
    priorSnapshot: rowsOf(await client.execute({ sql: 'SELECT * FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', args: [owner.deviceKey, id] })),
    tables: await tableDigests(),
  };
}

/** The flat columns that summarise a report's similarity for the lists. */
const FLAT_SIMILARITY_COLUMNS = ['word_count', 'archive_score', 'score_band'];
/** Set once, at the first save. */
const IMMUTABLE_COLUMNS = ['id', 'device_key', 'user_id', 'room_number', 'saved_at', 'document_identity_id', 'verified_device_passport_id'];
const AI_KEYS = ['aiAnalysis', 'aiScore'];
const flat = (s) => Object.fromEntries(FLAT_SIMILARITY_COLUMNS.map((column) => [column, s.columns[column]]));
function changedPayloadKeys(before, after) {
  const keys = new Set([...Object.keys(before.raw), ...Object.keys(after.raw)]);
  return [...keys].filter((key) => !AI_KEYS.includes(key) && JSON.stringify(before.raw[key]) !== JSON.stringify(after.raw[key])).sort();
}
const changedTables = (before, after) => Object.keys({ ...before.tables, ...after.tables }).filter((name) => before.tables[name] !== after.tables[name]).sort();

/** The invariant: nothing a save of a terminal report carries moves anything the server owns. */
function assertServerOwnedUntouched(before, after, label) {
  assert.deepEqual(flat(after), flat(before), `${label}: the flat similarity columns`);
  for (const column of IMMUTABLE_COLUMNS) assert.equal(after.columns[column], before.columns[column], `${label}: ${column}`);
  assert.deepEqual(changedPayloadKeys(before, after), [], `${label}: nothing but the AI half of the stored report changed`);
  assert.deepEqual(after.report.unifiedSimilarity, before.report.unifiedSimilarity, `${label}: the stored similarity result`);
  assert.deepEqual(after.priorSnapshot, before.priorSnapshot, `${label}: the previous-submission snapshot`);
  assert.deepEqual(changedTables(before, after).filter((name) => name !== 'saved_reports' && name !== 'rate_limit_buckets'), [], `${label}: no other table was written`);
}
function assertAiStored(after, { aiStatus, aiScore, analysisStatus }, label) {
  assert.equal(after.columns.ai_status, aiStatus, `${label}: ai_status`);
  assert.equal(after.columns.ai_score, aiScore, `${label}: ai_score`);
  assert.equal(after.raw.aiAnalysis?.status, analysisStatus, `${label}: the AI analysis is stored`);
}

const SUMMARY_KEYS = ['wordCount', 'archiveScore', 'scoreBand', 'primaryScore', 'isUnified', 'similarityStatus'];
const summaryOf = (summary) => Object.fromEntries(SUMMARY_KEYS.filter((key) => key in summary).map((key) => [key, summary[key]]));
/** What the report list (GET /api/reports) hands the owner for this report. */
async function listed(owner, id) {
  requests += 1;
  const ip = `${owner.tag}-list-${requests}`;
  await resetReadRateForTest(ip);
  const res = await reportsRoute.GET(new Request('http://localhost/api/reports', { headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` } }));
  assert.equal(res.status, 200);
  return summaryOf((await res.json()).reports.find((r) => r.id === String(id)));
}
/** What the room tile (GET /api/reports?room=0) hands the owner for its occupant. */
async function roomTile(owner) {
  requests += 1;
  const ip = `${owner.tag}-room-${requests}`;
  await resetPollRateForTest(ip);
  const res = await reportsRoute.GET(new Request('http://localhost/api/reports?room=0', { headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` } }));
  assert.equal(res.status, 200);
  return summaryOf((await res.json()).report);
}

async function index(accountId, rawText) {
  await client.execute({ sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [accountId, `${accountId}@example.test`, accountId, 'x'] });
  const identity = await createDocumentIdentity(client, { accountId, title: 't', author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
}

// ===========================================================================
// 1. the hosted finding: the flat score columns
// ===========================================================================

for (const [gate, on] of GATES) {
  test(`1. a save of a finalized report that says archiveScore 99 / "High" / one word leaves the flat columns, the report list and the room tile as the finalizer left them [compact positions ${gate}]`, async () => withPositionsGate(on, async () => {
    const id = `ff-score-${gate}`;
    const { owner, report } = await finalizedReport(id);
    const before = await state(owner, id);
    assert.equal(before.report.selectiveCorpusAuthoritativeStatus, 'completed');
    assert.equal(before.report.unifiedSimilarity.unifiedScore, 12, 'test setup sanity: 350 of 3,000 words');
    assert.equal(isFormatMarkedPositions(before.raw.unifiedSimilarity.matchedPositions), on, 'test setup sanity: the positions are stored in the form this gate writes');
    assert.deepEqual(flat(before), { word_count: 3000, archive_score: 3, score_band: 'Low' }, 'test setup sanity: the flat columns the first save wrote');
    const listBefore = await listed(owner, id);
    const tileBefore = await roomTile(owner);
    assert.deepEqual(listBefore, { wordCount: 3000, archiveScore: 3, scoreBand: 'Low' });
    assert.deepEqual(tileBefore, { wordCount: 3000, archiveScore: 3, scoreBand: 'Low', primaryScore: 12, isUnified: true, similarityStatus: 'resolved' });

    assert.equal((await save(owner, report, { body: { archiveScore: 99, scoreBand: 'High', wordCount: 1 } })).status, 200);

    const after = await state(owner, id);
    assertServerOwnedUntouched(before, after, 'forged flat score');
    assert.deepEqual(flat(after), { word_count: 3000, archive_score: 3, score_band: 'Low' });
    assert.deepEqual(await listed(owner, id), listBefore, 'the report list shows the same similarity summary');
    assert.deepEqual(await roomTile(owner), tileBefore, 'the room tile shows the same similarity summary');
    assertAiStored(after, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'the AI half of the same request');

    // Each flat field on its own, and the values a request may also legally send.
    for (const body of [{ archiveScore: 99 }, { scoreBand: 'High' }, { wordCount: 1 }, { archiveScore: 0, scoreBand: 'Moderate', wordCount: 999999 }, { archiveScore: -5 }, { archiveScore: 12.7 }]) {
      assert.equal((await save(owner, report, { body })).status, 200, JSON.stringify(body));
      assertServerOwnedUntouched(before, await state(owner, id), `forged ${JSON.stringify(body)}`);
    }
  }));
}

// ===========================================================================
// 2-5. everything else a request can carry
// ===========================================================================

test('2. forged previous-submission fields: the stored previous-submission share, its completion signal and its snapshot row are unchanged — also once the corpus holds more of the text', async () => {
  const id = 'ff-prior';
  const shared = words(120, 4201);
  const text = `${words(200, 4202)} ${shared} ${words(280, 4203)}`;
  await index('ff-prior-holder', `${words(250, 4204)} ${shared} ${words(250, 4205)}`);
  await index('ff-prior-second', `${words(300, 4208)} ${shared} ${words(300, 4209)}`);
  await matureCorpusBackings(client);
  const { owner, report } = await finalizedReport(id, text, { passages: [passage(250, 399)], archiveMatchedPositions: [], archiveScore: 0 });
  const before = await state(owner, id);
  const u = before.report.unifiedSimilarity;
  assert.ok(u.previousUploadOnlyWords > 0 && u.selectiveCorpusOnlyWords > 0 && u.overlapWords > 0, 'test setup sanity: a previous submission and the Selective Corpus both hold part of the text, and overlap');
  assert.equal(before.priorSnapshot.length, 1, 'test setup sanity: the finalizer stored the previous-submission check');
  assert.equal(before.report.reportCompletion.signals.priorSubmission, 'COMPLETE');

  const forged = {
    historicalSubmissionMatch: { status: 'NO_HISTORICAL_MATCH', matches: [], partial: true },
    unifiedSimilarity: { ...u, unifiedScore: 0, uniqueMatchedWords: 0, previousUploadOnlyWords: 0, previousUploadPositions: [], matchedPositions: [], contributions: [] },
    reportCompletion: { ...before.report.reportCompletion, state: 'PARTIAL', signals: { ...before.report.reportCompletion.signals, priorSubmission: 'PARTIAL' } },
  };
  assert.equal((await save(owner, report, { payload: forged, body: { archiveScore: 99, scoreBand: 'High', wordCount: 1 } })).status, 200);
  assertServerOwnedUntouched(before, await state(owner, id), 'forged previous-submission fields');

  // A second holder of MORE of the text enters the corpus: a re-run of the check would now find it.
  await index('ff-prior-later', `${words(100, 4206)} ${words(200, 4202)} ${shared} ${words(100, 4207)}`);
  await matureCorpusBackings(client);
  await bumpCorpusMatchGeneration(client);
  const moved = await state(owner, id);
  assert.equal((await save(owner, report, { aiScore: 6, body: { archiveScore: 55, scoreBand: 'High' } })).status, 200);
  const after = await state(owner, id);
  assertServerOwnedUntouched(moved, after, 'a save after the corpus grew');
  assert.deepEqual(after.report.unifiedSimilarity, u, 'the similarity is the one that was finalized');
  assert.deepEqual(flat(after), flat(before));
});

test('3. forged Selective Corpus fields: the terminal status, the reason, the retry count and the Selective share are unchanged, for a completed, a partial and a timed-out report', async () => {
  const forgeries = (report, u) => ({
    selectiveCorpusAuthoritativeStatus: 'pending', selectiveCorpusAuthoritativeClaimedAt: '2020-01-01 00:00:00', selectiveCorpusAuthoritativeIncompleteReason: 'FAILED', selectiveCorpusAuthoritativeTimedOutAttempts: 0,
    unifiedSimilarity: { ...u, unifiedScore: 100, uniqueMatchedWords: report.wordCount, selectiveCorpusOnlyWords: report.wordCount, selectiveCorpusPositions: range(0, report.wordCount - 1), matchedPositions: range(0, report.wordCount - 1) },
    selectiveCorpusEvidence: [{ sourceId: 'FORGED', matchedPassages: [passage(0, report.wordCount - 1)] }],
    unifiedSimilarityGeneration: 999999, unifiedSimilarityFailed: true, corpusSourceMatchingEnabledAtComputation: false,
  });
  const flatForgery = { archiveScore: 100, scoreBand: 'High', wordCount: 7 };

  const completed = await finalizedReport('ff-sc-completed');
  const partial = await finalizedReport('ff-sc-partial', undefined, { shadow: partialShadow });
  for (const [label, { owner, report }, status, reason] of [['completed', completed, 'completed', undefined], ['partial', partial, 'incomplete', 'PARTIAL_INDEX']]) {
    const before = await state(owner, report.id);
    assert.equal(before.raw.selectiveCorpusAuthoritativeStatus, status, label);
    assert.equal(before.raw.selectiveCorpusAuthoritativeIncompleteReason, reason, label);
    assert.equal((await save(owner, report, { payload: forgeries(report, before.report.unifiedSimilarity), body: flatForgery })).status, 200, label);
    const after = await state(owner, report.id);
    assertServerOwnedUntouched(before, after, `forged Selective Corpus fields (${label})`);
    assert.deepEqual(after.report.unifiedSimilarity.selectiveCorpusPositions, range(100, 349), label);
    assert.equal((await finalize(owner, report.id, timeoutShadow())).outcome, 'not-pending', `${label}: and the report was never reopened for the finalizer`);
  }

  // Every attempt timed out: terminal "incomplete" with the retry count the finalizer recorded.
  const owner = await signUpOwner();
  const report = localReport('ff-sc-timeout', words(3000, 4301), { archiveMatchedPositions: range(350, 449), archiveScore: 3 });
  await seedPending(owner, report);
  for (let i = 0; i < MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS; i += 1) await finalize(owner, report.id, timeoutShadow());
  const before = await state(owner, report.id);
  assert.equal(before.raw.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.equal(before.raw.selectiveCorpusAuthoritativeIncompleteReason, 'TIMEOUT');
  assert.equal(before.raw.selectiveCorpusAuthoritativeTimedOutAttempts, MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS - 1);
  assert.equal((await save(owner, report, { payload: forgeries(report, before.report.unifiedSimilarity), body: flatForgery })).status, 200);
  assertServerOwnedUntouched(before, await state(owner, report.id), 'forged Selective Corpus fields (timed out)');
});

test('4. forged academic and imported-evidence fields — and a real, matching academic-search handle sent beside the payload — add nothing to a finalized report', async () => {
  const id = 'ff-academic';
  const text = `${words(1500, 4401)} ${ANCHOR} ${words(1492, 4402)}`;
  const { owner, report } = await finalizedReport(id, text);
  const before = await state(owner, id);
  const u = before.report.unifiedSimilarity;
  assert.ok(u.importedSimilarityEvidenceOnlyWords > 0, 'test setup sanity: the imported unit matched the anchor');
  assert.equal(u.liveAcademicOnlyWords, 0, 'test setup sanity: no academic evidence fed the final score');

  // What /api/academic-evidence would store for THIS manuscript: a server-computed row the save route accepts by its text hash.
  const evidence = [{
    provider: 'openaire', providerId: 'ff-academic-1', title: 'Academic source', authors: ['A. Author'], publication: 'Journal', year: 2020,
    doi: '10.9999/ff-academic', url: 'https://example.org/ff-academic', similarity: 50,
    matchedPassages: [{ submittedText: 'x', submittedWordStart: 2000, submittedWordEnd: 2499, matchedWordCount: 500 }],
  }];
  const diagnosticsId = Number(await recordAcademicSearchRunDiagnostics(client, {
    status: 'COMPLETE_WITH_MATCHES',
    stats: { queryCount: 3, searchLatencyMs: 1, candidateCountBeforeDedup: 1, candidateCountAfterDedup: 1, deduplicationRate: 0, candidatesTextRetrieved: 1, textRetrievalLatencyMs: 1, comparisonLatencyMs: 1, totalLatencyMs: 3, providerErrors: [], searchAttempts: 3 },
    queries: null, candidates: null, retrievalDiagnostics: null, evidence,
    submissionCanonicalSha256: canonicalSha256(text), scoringNormalizationVersion: 2,
  }));
  const recorded = await state(owner, id);

  assert.equal((await save(owner, report, {
    body: { academicSearchDiagnosticsId: diagnosticsId, archiveScore: 29, scoreBand: 'Moderate' },
    payload: {
      externalAcademicEvidence: evidence, academicEvidenceStatus: 'COMPLETE_WITH_MATCHES', verifiedAcademicSearchDiagnosticsId: diagnosticsId,
      unifiedSimilarity: { ...u, liveAcademicOnlyWords: 500, importedSimilarityEvidenceOnlyWords: 0, importedSimilarityEvidencePositions: [], contributions: [] },
      evidenceInterpretation: null,
    },
  })).status, 200);

  const after = await state(owner, id);
  assertServerOwnedUntouched(recorded, after, 'forged academic / imported fields');
  assert.deepEqual(after.report.unifiedSimilarity, u);
  assert.deepEqual(flat(after), flat(before));
  assert.equal(after.raw.verifiedAcademicSearchDiagnosticsId, before.raw.verifiedAcademicSearchDiagnosticsId, 'no academic-search handle is attached after the fact');
  assert.equal(after.raw.academicEvidenceStatus, 'COMPLETE_NO_MATCHES');
});

for (const [gate, on] of GATES) {
  test(`5. forged matched-position and list fields are ignored, and a compact-marked list is refused with nothing written [compact positions ${gate}]`, async () => withPositionsGate(on, async () => {
    const id = `ff-positions-${gate}`;
    const { owner, report } = await finalizedReport(id);
    const before = await state(owner, id);
    assert.equal(isFormatMarkedPositions(before.raw.archiveMatchedPositions), on, 'test setup sanity: the archive positions are stored in the form this gate writes');

    const everyWord = range(0, report.wordCount - 1);
    const lists = [
      ['every word matched', { archiveMatchedPositions: everyWord, matchedWordCount: report.wordCount, score: 100, archiveScore: 100, scoreBand: 'High', sources: [{ name: 'Forged Source', type: 'Publication', percent: 100, matchedWords: report.wordCount }] }],
      ['nothing matched', { archiveMatchedPositions: [], matchedWordCount: 0, score: 0, archiveScore: 0, sources: [] }],
      ['positions beside the similarity', { unifiedSimilarity: { ...before.report.unifiedSimilarity, matchedPositions: everyWord, previousUploadPositions: everyWord, userSuppliedReferencePositions: everyWord, selectiveCorpusPositions: [], importedSimilarityEvidencePositions: everyWord } }],
      ['possible-match regions', { uncertainEvidence: { passages: [{ wordStart: 0, wordEnd: 99, reason: 'forged' }] } }],
    ];
    for (const [label, payload] of lists) {
      assert.equal((await save(owner, report, { payload, body: { archiveScore: 100, scoreBand: 'High' } })).status, 200, label);
      const after = await state(owner, id);
      assertServerOwnedUntouched(before, after, label);
      assert.deepEqual(after.report.archiveMatchedPositions, range(350, 449), label);
      assert.deepEqual(after.report.unifiedSimilarity.matchedPositions, range(100, 449), label);
    }

    // The existing contract for the persistence-only form: refused before anything is read or written.
    const stored = await state(owner, id);
    const refused = await save(owner, report, { aiScore: 9, payload: { archiveMatchedPositions: before.raw.archiveMatchedPositions && isFormatMarkedPositions(before.raw.archiveMatchedPositions) ? before.raw.archiveMatchedPositions : { format: 'compact', formatVersion: 1, runs: [[0, report.wordCount - 1]] } }, body: { archiveScore: 100 } });
    assert.equal(refused.status, 400);
    const after = await state(owner, id);
    assert.deepEqual(after.columns, stored.columns, 'the row is byte-identical, AI half and updated_at included');
  }));
}

// ===========================================================================
// 6. what a save of a terminal report still writes
// ===========================================================================

test('6. the AI half still lands on a finalized report: a result, a failure that does not displace it, a newer result, and the AI-result route — none of them moves a flat similarity column', async () => {
  const id = 'ff-ai';
  const { owner, report } = await finalizedReport(id);
  const before = await state(owner, id);
  assertAiStored(before, { aiStatus: 'processing', aiScore: null, analysisStatus: undefined }, 'test setup sanity: the AI check is still running');

  assert.equal((await save(owner, report, { aiScore: 5, aiTone: 'low' })).status, 200);
  const ready = await state(owner, id);
  assertServerOwnedUntouched(before, ready, 'AI result');
  assertAiStored(ready, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'AI result');
  assert.equal(ready.columns.ai_tone, 'low');
  assert.equal(ready.raw.aiScore, 5, 'the raw AI score is stored beside its analysis');
  assert.notEqual(ready.columns.updated_at, null);

  assert.equal((await save(owner, report, { aiStatus: 'failed', aiScore: null, aiTone: null, aiAnalysis: failedAiAnalysis() })).status, 200);
  const late = await state(owner, id);
  assert.equal(late.json, ready.json, 'a late failure does not displace the stored result');
  assertAiStored(late, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'late failure');
  assertServerOwnedUntouched(before, late, 'late failure');

  assert.equal((await save(owner, report, { aiScore: 61, aiTone: 'high' })).status, 200);
  const newer = await state(owner, id);
  assertServerOwnedUntouched(before, newer, 'newer AI result');
  assertAiStored(newer, { aiStatus: 'ready', aiScore: 61, analysisStatus: 'complete' }, 'newer AI result');
  assert.equal(newer.columns.ai_tone, 'high');

  // The narrow AI-result route writes the AI half only, as before.
  requests += 1;
  await resetRateForTest(`${owner.tag}-air-${requests}`);
  const narrow = await aiRetryRoute.POST(new Request(`http://localhost/api/reports/${id}/ai-retry`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${owner.tag}-air-${requests}`, cookie: `tp_session_v1=${owner.cookie}` },
    body: JSON.stringify({ deviceKey: owner.deviceKey, aiStatus: 'ready', aiScore: 33, aiTone: 'medium', archiveScore: 99, scoreBand: 'High', wordCount: 1, payload: { aiScore: 33, aiAnalysis: completeAiAnalysis(), archiveScore: 99 } }),
  }), { params: Promise.resolve({ id }) });
  assert.equal(narrow.status, 200);
  const viaRoute = await state(owner, id);
  assertServerOwnedUntouched(before, viaRoute, 'AI-result route');
  assertAiStored(viaRoute, { aiStatus: 'ready', aiScore: 33, analysisStatus: 'complete' }, 'AI-result route');
});

// ===========================================================================
// 7-8. reports that are not terminal are written exactly as before
// ===========================================================================

for (const [gate, on] of GATES) {
  test(`7. a pending authoritative report still progresses: its saves replace payload and flat columns together, the finalizer then writes the score, and only from then on are they held [compact positions ${gate}]`, async () => withPositionsGate(on, async () => {
    const id = `ff-pending-${gate}`;
    const owner = await signUpOwner();
    const first = localReport(id, words(3000, 4701), { archiveMatchedPositions: range(350, 449), archiveScore: 3 });
    await seedPending(owner, first);

    // The browser's next save of the same check carries a later archive result (positions 350-499, 5 %).
    const report = { ...first, archiveMatchedPositions: range(350, 499), matchedWordCount: 150, score: 5, archiveScore: 5 };
    assert.equal((await save(owner, report)).status, 200);
    const pending = await state(owner, id);
    assert.equal(pending.raw.selectiveCorpusAuthoritativeStatus, 'pending', 'a save never finalizes the report');
    assert.equal(pending.raw.unifiedSimilarity, undefined, 'and never persists a score for it');
    assert.deepEqual(flat(pending), { word_count: 3000, archive_score: 5, score_band: 'Low' }, 'the flat columns follow the payload the save stored');
    assert.deepEqual(pending.report.archiveMatchedPositions, range(350, 499));
    assertAiStored(pending, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'AI save while pending');

    assert.deepEqual(await finalize(owner, id, completedShadow([passage(100, 399)])), { outcome: 'finalized', status: 'completed' });
    const finalized = await state(owner, id);
    assert.equal(finalized.report.unifiedSimilarity.unifiedScore, 13, 'the finalizer scored the stored archive positions with the Selective Corpus evidence: 400 of 3,000 words');
    assert.deepEqual(flat(finalized), flat(pending), 'the finalizer does not write the flat columns');
    assertAiStored(finalized, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'the finalizer kept the AI result');

    assert.equal((await save(owner, first, { aiScore: 6, body: { archiveScore: 99, scoreBand: 'High', wordCount: 1 } })).status, 200);
    const after = await state(owner, id);
    assertServerOwnedUntouched(finalized, after, 'a save after the finalizer');
    assert.deepEqual(flat(after), { word_count: 3000, archive_score: 5, score_band: 'Low' });
  }));

  test(`8. a report that is not authoritative is re-analysed by a save exactly as before: new archive evidence moves the score, the payload and the flat columns [compact positions ${gate}]`, async () => withPositionsGate(on, async () => {
    const owner = await signUpOwner();
    const id = `ff-ordinary-${gate}`;
    const report = localReport(id, words(3000, 4801));

    assert.equal((await save(owner, report, { aiStatus: 'processing', aiScore: null, aiTone: null, aiAnalysis: null, body: { room: 0 } })).status, 200);
    const first = await state(owner, id);
    assert.equal(first.raw.selectiveCorpusAuthoritativeStatus, undefined, 'test setup sanity: created outside authoritative mode');
    assert.equal(first.report.unifiedSimilarity.unifiedScore, 0);
    assert.deepEqual(flat(first), { word_count: 3000, archive_score: 0, score_band: 'Low' });

    const reanalysed = { ...report, archiveMatchedPositions: range(0, 599), matchedWordCount: 600, score: 20, archiveScore: 20, scoreBand: 'Moderate' };
    assert.equal((await save(owner, reanalysed)).status, 200);
    const after = await state(owner, id);
    assert.equal(after.report.unifiedSimilarity.unifiedScore, 20, 'the save re-resolved the score: 600 of 3,000 words');
    assert.deepEqual(after.report.unifiedSimilarity.matchedPositions, range(0, 599));
    assert.deepEqual(flat(after), { word_count: 3000, archive_score: 20, score_band: 'Moderate' }, 'and the flat columns moved with it');
    assert.deepEqual(await listed(owner, id), { wordCount: 3000, archiveScore: 20, scoreBand: 'Moderate' });
    assertAiStored(after, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'ordinary AI save');
  }));
}

// ===========================================================================
// 9. the rule is part of the write itself, keyed on the terminal marker alone
// ===========================================================================

/** SAVE_REPORT_SQL exactly as the route runs it, with forged flat fields, for one incoming payload on an existing row. */
async function upsert(owner, report, incomingPayload) {
  await client.execute({
    sql: reportsRoute.SAVE_REPORT_SQL,
    args: [report.id, owner.deviceKey, report.submissionId, report.title, report.created, 1, 99, 'High', 7, 'low', 'ready', JSON.stringify(incomingPayload), owner.userId, null],
  });
}

test('9. the upsert itself holds the flat similarity columns of a terminal row — completed, incomplete, or terminal without a score — and of no other row', async () => {
  const incoming = (report) => ({ ...report, aiScore: 7, aiAnalysis: completeAiAnalysis() });

  for (const [label, shadow] of [['completed', completedShadow], ['incomplete', partialShadow]]) {
    const { owner, report } = await finalizedReport(`ff-sql-${label}`, undefined, { shadow });
    const before = await state(owner, report.id);
    await upsert(owner, report, incoming(report));
    const after = await state(owner, report.id);
    assertServerOwnedUntouched(before, after, `upsert onto a ${label} row`);
    assertAiStored(after, { aiStatus: 'ready', aiScore: 7, analysisStatus: 'complete' }, `upsert onto a ${label} row`);
  }

  // Terminal with no score at all (how a report whose similarity could not be stored ends): held as well.
  const scoreless = await signUpOwner();
  const scorelessReport = localReport('ff-sql-scoreless', words(3000, 4901), { archiveMatchedPositions: range(350, 449), archiveScore: 3 });
  await seedPending(scoreless, scorelessReport);
  await client.execute({
    sql: `UPDATE saved_reports
          SET payload_json = json_set(payload_json, '$.selectiveCorpusAuthoritativeStatus', 'incomplete', '$.selectiveCorpusAuthoritativeIncompleteReason', 'PERSISTENCE_LIMIT', '$.unifiedSimilarityFailed', json('true'))
          WHERE device_key = ? AND id = ?`,
    args: [scoreless.deviceKey, scorelessReport.id],
  });
  const scorelessBefore = await state(scoreless, scorelessReport.id);
  await upsert(scoreless, scorelessReport, incoming(scorelessReport));
  const scorelessAfter = await state(scoreless, scorelessReport.id);
  assert.deepEqual(flat(scorelessAfter), flat(scorelessBefore), 'a terminal row without a score keeps its flat columns');
  assert.deepEqual(changedPayloadKeys(scorelessBefore, scorelessAfter), []);

  // Still pending: the incoming payload replaces the stored one, and its flat summary goes with it.
  const pendingOwner = await signUpOwner();
  const pendingReport = localReport('ff-sql-pending', words(3000, 4902));
  await seedPending(pendingOwner, pendingReport);
  await upsert(pendingOwner, pendingReport, { ...incoming(pendingReport), selectiveCorpusAuthoritativeStatus: 'pending' });
  assert.deepEqual(flat(await state(pendingOwner, pendingReport.id)), { word_count: 1, archive_score: 99, score_band: 'High' }, 'a pending row is not held');

  // Never authoritative: replaced, exactly as before.
  const ordinaryOwner = await signUpOwner();
  const ordinary = localReport('ff-sql-ordinary', words(3000, 4903));
  assert.equal((await save(ordinaryOwner, ordinary, { aiStatus: 'processing', aiScore: null, aiTone: null, aiAnalysis: null, body: { room: 0 } })).status, 200);
  await upsert(ordinaryOwner, ordinary, incoming(ordinary));
  assert.deepEqual(flat(await state(ordinaryOwner, ordinary.id)), { word_count: 1, archive_score: 99, score_band: 'High' }, 'an ordinary row is not held');
});

// ===========================================================================
// 10. the real first save, then the real deferred finalizer, then the forged save
// ===========================================================================

for (const [gate, on] of GATES) {
  test(`10. first save in authoritative mode -> the deferred finalizer makes it terminal -> a forged save: the flat columns that first save wrote are the ones that stay [compact positions ${gate}]`, async () => withPositionsGate(on, async () => {
    const owner = await signUpOwner();
    const id = `ff-real-${gate}`;
    const report = localReport(id, words(3000, 5001), { archiveMatchedPositions: range(350, 449), archiveScore: 3 });
    process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
    process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
    try {
      // No Selective Corpus artifact is configured here, so the deferred finalizer (run inline: no request scope) ends the report "incomplete".
      assert.equal((await save(owner, report, { aiStatus: 'processing', aiScore: null, aiTone: null, aiAnalysis: null, body: { room: 0 } })).status, 200);
      const before = await state(owner, id);
      assert.equal(before.raw.selectiveCorpusAuthoritativeStatus, 'incomplete', 'test setup sanity: the first save was finalized');
      assert.equal(before.report.unifiedSimilarity.unifiedScore, 3, 'test setup sanity: the archive evidence alone, 100 of 3,000 words');
      assert.deepEqual(flat(before), { word_count: 3000, archive_score: 3, score_band: 'Low' });

      assert.equal((await save(owner, report, { body: { archiveScore: 99, scoreBand: 'High', wordCount: 1 }, payload: { archiveScore: 99, score: 99, scoreBand: 'High' } })).status, 200);
      const after = await state(owner, id);
      assertServerOwnedUntouched(before, after, 'forged save after the real finalizer');
      assert.deepEqual(await listed(owner, id), { wordCount: 3000, archiveScore: 3, scoreBand: 'Low' });
      assertAiStored(after, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'forged save after the real finalizer');
    } finally {
      delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
      delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
    }
  }));
}
