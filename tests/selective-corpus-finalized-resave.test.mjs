import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as aiRetryRoute from '../app/api/reports/[id]/ai-retry/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';
import { completeAiAnalysis } from './helpers/complete-ai-analysis.mjs';
import { makeUnitRecord, makePackageFile } from './helpers/imported-similarity-evidence-fixtures.mjs';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import { canonicalSha256, createDocumentIdentity } from '../lib/document-identity.ts';
import { recordAcademicSearchRunDiagnostics } from '../lib/academic-search-diagnostics-repo.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { bumpCorpusMatchGeneration } from '../lib/corpus-match-generation.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';
import { withEvidenceInterpretation } from '../lib/report-evidence-interpretation.ts';
import { decodeReportFromPersistence, encodeReportForPersistence } from '../lib/report-persistence.ts';
import { MAX_REPORT_SAVE_REQUEST_BYTES, persistedPayloadSize } from '../lib/report-transport-limits.ts';
import { AI_SAVE_OUTCOME_SIZE_UNAVAILABLE, AI_UNAVAILABLE_REASON_REPORT_SIZE } from '../lib/ai-unavailable-state.ts';
import { finalizeSelectiveCorpusAuthoritativeReport, MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS } from '../lib/selective-corpus-authoritative.ts';
import {
  resetImportedSimilarityEvidencePackageCacheForTest,
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest,
} from '../lib/imported-similarity-evidence/index.ts';

/**
 * A SAVE NEVER REPLACES THE SIMILARITY THE SELECTIVE CORPUS FINALIZER WROTE.
 *
 * An authoritative report is persisted "pending" with no score; the deferred
 * finalizer (lib/selective-corpus-authoritative.ts) writes its one final
 * unifiedSimilarity — the only resolution that ever has the Selective Corpus
 * evidence — and makes it terminal ("completed" / "incomplete"). The browser
 * then saves the report again when its AI analysis finishes (POST /api/reports,
 * the whole report plus the AI result). That save used to re-resolve the score
 * through the ordinary write-time path, which has no Selective Corpus evidence
 * to pass, and store the result over the finalizer's: a finalized 10 % read 0 %
 * with every Selective Corpus position gone, the report still "completed".
 *
 * This file pins the rule that replaced it — for a terminal report the stored
 * payload is kept and only the request's AI half is merged — through the real
 * routes, the real finalizer and the real upsert statement:
 *   - an AI save in every shape a browser sends it (its own stale score, a
 *     forged one, none at all) leaves every stored field but the AI half
 *     byte-identical, for every evidence channel and every completion state;
 *   - a client can neither remove nor add Selective Corpus positions;
 *   - what is still allowed to write a score still does: the finalizer on a
 *     pending report, and an ordinary save of a report that is not authoritative;
 *   - the row a save persists is the one whose size was checked.
 * Compact persistence is ON, as in Production. Every corpus is synthetic.
 */

const ENV_KEYS = [
  'TURSO_DATABASE_URL',
  'CORPUS_SOURCE_MATCHING_ENABLED',
  'REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED',
  'IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH',
  'SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED',
  'SELECTIVE_CORPUS_SHADOW_ENABLED',
  'SELECTIVE_CORPUS_ARTIFACT_PATH',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const workDir = mkdtempSync(path.join(process.env.TURNITPLUS_TEST_DB_DIR || tmpdir(), 'sc-finalized-resave-'));
const dbFile = path.join(workDir, 'sc_finalized_resave.db');
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
process.env.REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED = 'true';
delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
delete process.env.SELECTIVE_CORPUS_ARTIFACT_PATH;

// One imported-evidence unit; only a manuscript that contains ANCHOR matches it.
const ANCHOR = 'the distinctive constitutional framework governing judicial review procedures';
const ANCHOR_MASK = [0, 1, 2, 4, 5, 6, 7];
const packagePath = path.join(workDir, 'package.json');
fs.writeFileSync(packagePath, JSON.stringify(makePackageFile([
  makeUnitRecord({ evidenceUnitId: 'PU0001', anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: ANCHOR_MASK, reportedSimilarityPercent: 12 }),
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

let accounts = 0;
async function signUpOwner({ admin = false } = {}) {
  accounts += 1;
  const tag = `fr-${accounts}`, email = `fr-owner-${accounts}@example.test`, deviceKey = `fr-device-${accounts}`;
  await resetAuthRateForTest(`${tag}-signup`);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${tag}-signup` },
    body: JSON.stringify(withTestIdentity({ email, password: 'fr-owner-pw-1', username: `frowner${accounts}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = (res.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)[1];
  const userId = String((await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  if (admin) await client.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [userId] });
  return { userId, deviceKey, cookie, tag };
}

/** The report as the browser holds it after its check: archive evidence only, no server score, no AI result yet. */
function localReport(id, text, { archiveMatchedPositions = [] } = {}) {
  return {
    version: 11, id, submissionId: `sub-${id}`, title: 'Finalized resave fixture', author: '', assignment: '', created: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    score: 0, archiveScore: 0, scoreBand: 'Low', wordCount: tokensForScoringNormalization(text, 2).length, characterCount: text.length,
    matchedWordCount: archiveMatchedPositions.length, archiveMatchedPositions, scoringNormalizationVersion: 2,
    sources: [], repeats: [], text, academicEvidenceStatus: 'COMPLETE_NO_MATCHES', externalAcademicEvidence: [],
  };
}

/**
 * The row an authoritative first save persists: no unifiedSimilarity, the marker "pending", the AI check still running.
 * `serverFields` are what the server stamps on the row and never returns to the browser.
 */
async function seedPending(owner, report, serverFields = {}) {
  const built = withEvidenceInterpretation({ ...report, ...serverFields }, { selectiveCorpusBranch: null });
  const payload = { ...encodeReportForPersistence(built), selectiveCorpusAuthoritativeStatus: 'pending' };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_status, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [report.id, owner.deviceKey, report.submissionId, report.title, report.created, report.wordCount, 0, 'Low', 'processing', JSON.stringify(payload), owner.userId, null],
  });
}

const EVALUATOR_VERSION = 'selective-corpus-shadow-v1';
const passage = (start, end) => ({ submittedWordStart: start, submittedWordEnd: end, matchedWordCount: end - start + 1 });
const completedShadow = (passages) => ({
  state: 'COMPLETED', evaluatorVersion: EVALUATOR_VERSION, corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
  verifiedEvidence: passages.length > 0 ? [{ sourceLabel: 'PMC-TEST-1', matchedPassages: passages }] : [],
});
const partialShadow = (passages) => ({ ...completedShadow(passages), state: 'PARTIAL', degradedShardCount: 1 });
const timeoutShadow = () => ({
  state: 'TIMEOUT', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'TIMEOUT', failureMessage: 'time budget exceeded during Stage B verification',
  corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
});
const finalize = (owner, id, shadowResult) =>
  finalizeSelectiveCorpusAuthoritativeReport(client, { reportDeviceKey: owner.deviceKey, reportId: id, accountId: owner.userId, shadowResult, shadowScoringNormalizationVersion: 2 });

/** A pending authoritative report the finalizer has just made terminal with these Selective Corpus passages. */
async function finalizedReport(id, text, { passages = [passage(100, 399)], shadow = completedShadow, archiveMatchedPositions, admin = false, reportFields = {}, serverFields = {} } = {}) {
  const owner = await signUpOwner({ admin });
  const report = { ...localReport(id, text, { archiveMatchedPositions }), ...reportFields };
  await seedPending(owner, report, serverFields);
  assert.equal((await finalize(owner, id, shadow(passages))).outcome, 'finalized', 'test setup sanity: the finalizer wrote the final score');
  return { owner, report };
}

const failedAiAnalysis = () => ({ status: 'error', score: null, model: 'fixture-model', engine: null, error: 'fixture model failure', passages: [] });

let saves = 0;
/**
 * POST /api/reports as the browser's AI save sends it (room-page-shell.tsx saveEnrichedAiResult): the report it holds,
 * the AI result spread over it, and the AI lifecycle state. `payload` / `body` add or replace fields of either.
 */
async function save(owner, report, { aiStatus = 'ready', aiScore = 5, aiTone = 'low', aiAnalysis = completeAiAnalysis(), payload = {}, body = {} } = {}) {
  saves += 1;
  const ip = `${owner.tag}-post-${saves}`;
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
const failedSave = (owner, report, extra = {}) => save(owner, report, { aiStatus: 'failed', aiScore: null, aiTone: null, aiAnalysis: failedAiAnalysis(), ...extra });

/** The stored row: the raw payload, its decoded form (compact persistence), and the flat AI columns. */
async function row(owner, id) {
  const r = await client.execute({ sql: 'SELECT payload_json, ai_status, ai_score FROM saved_reports WHERE device_key = ? AND id = ?', args: [owner.deviceKey, id] });
  const json = String(r.rows[0].payload_json);
  return {
    json,
    raw: JSON.parse(json),
    report: decodeReportFromPersistence(JSON.parse(json), { requireContributions: true }),
    aiStatus: r.rows[0].ai_status,
    aiScore: r.rows[0].ai_score === null ? null : Number(r.rows[0].ai_score),
  };
}
async function getAsOwner(owner, id) {
  await resetReadRateForTest(`${owner.tag}-get`);
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(owner.deviceKey)}`, { headers: { 'x-forwarded-for': `${owner.tag}-get`, cookie: `tp_session_v1=${owner.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  assert.equal(res.status, 200);
  return (await res.json()).payload;
}

const AI_KEYS = ['aiAnalysis', 'aiScore'];
/** The top-level stored keys, the AI half aside, whose JSON differs between two reads of a row. */
function changedSimilarityKeys(before, after) {
  const keys = new Set([...Object.keys(before.raw), ...Object.keys(after.raw)]);
  return [...keys].filter((key) => !AI_KEYS.includes(key) && JSON.stringify(before.raw[key]) !== JSON.stringify(after.raw[key])).sort();
}
/** The invariant: an AI save leaves the stored similarity state — score, union, every channel, completion, stamps — exactly as it was. */
function assertSimilarityUntouched(before, after, label) {
  const b = before.report.unifiedSimilarity, a = after.report.unifiedSimilarity;
  assert.ok(a, `${label}: the final score is still stored`);
  assert.equal(a.unifiedScore, b.unifiedScore, `${label}: similarity score`);
  assert.equal(a.selectiveCorpusOnlyWords, b.selectiveCorpusOnlyWords, `${label}: Selective Corpus matched words`);
  assert.deepEqual(a.selectiveCorpusPositions, b.selectiveCorpusPositions, `${label}: Selective Corpus positions`);
  assert.deepEqual(a.matchedPositions, b.matchedPositions, `${label}: matched-position union`);
  assert.deepEqual(a.contributions, b.contributions, `${label}: per-source attribution`);
  assert.deepEqual(after.report.reportCompletion, before.report.reportCompletion, `${label}: completion`);
  assert.equal(after.report.selectiveCorpusAuthoritativeStatus, before.report.selectiveCorpusAuthoritativeStatus, `${label}: terminal status`);
  assert.deepEqual(changedSimilarityKeys(before, after), [], `${label}: nothing but the AI half of the stored report changed`);
}
function assertAiStored(after, { aiStatus, aiScore, analysisStatus }, label) {
  assert.equal(after.aiStatus, aiStatus, `${label}: ai_status`);
  assert.equal(after.aiScore, aiScore, `${label}: ai_score`);
  assert.equal(after.raw.aiAnalysis?.status, analysisStatus, `${label}: the AI analysis is stored`);
}

async function index(accountId, rawText) {
  await client.execute({ sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [accountId, `${accountId}@example.test`, accountId, 'x'] });
  const identity = await createDocumentIdentity(client, { accountId, title: 't', author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  const stored = await client.execute({ sql: 'SELECT representation_id FROM corpus_submission_references WHERE document_identity_id = ?', args: [identity.id] });
  return String(stored.rows[0].representation_id);
}
/** A 600-word submission whose 120-word passage (words 200-319) two other accounts hold; prior PARTIAL = the second holder is over the per-candidate size limit, so it is discovered but never verified. */
async function priorFixture(seed, prior) {
  const shared = words(120, seed * 101 + 1);
  const submission = `${words(200, seed * 101 + 2)} ${shared} ${words(280, seed * 101 + 3)}`;
  await index(`fr-other-${seed}`, `${words(250, seed * 101 + 4)} ${shared} ${words(250, seed * 101 + 5)}`);
  const second = await index(`fr-second-${seed}`, `${words(300, seed * 101 + 6)} ${shared} ${words(300, seed * 101 + 7)}`);
  await matureCorpusBackings(client);
  if (prior === 'PARTIAL') await client.execute({ sql: 'UPDATE corpus_document_representations SET word_count = 999999 WHERE id = ?', args: [second] });
  return submission;
}

// ===========================================================================
// 1-3. the AI save, in every shape a browser sends it
// ===========================================================================

test('1. finalized Selective Corpus 10 % -> the AI save stores the AI result and leaves the score, the positions and the report a customer reads exactly as finalized', async () => {
  const id = 'fr-ai-ready';
  const { owner, report } = await finalizedReport(id, words(3000, 11));
  const before = await row(owner, id);
  assert.equal(before.report.selectiveCorpusAuthoritativeStatus, 'completed');
  assert.equal(before.report.unifiedSimilarity.unifiedScore, 10, 'test setup sanity: 300 of 3,000 words');
  assert.deepEqual(before.report.unifiedSimilarity.selectiveCorpusPositions, range(100, 399));
  const seenBefore = await getAsOwner(owner, id);

  assert.equal((await save(owner, report)).status, 200);

  const after = await row(owner, id);
  assertSimilarityUntouched(before, after, 'AI save');
  assert.equal(after.report.unifiedSimilarity.unifiedScore, 10);
  assert.deepEqual(after.report.unifiedSimilarity.selectiveCorpusPositions, range(100, 399));
  assertAiStored(after, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'AI save');
  assert.equal(after.raw.aiScore, 5, 'the raw AI score is stored beside its analysis');

  const seenAfter = await getAsOwner(owner, id);
  assert.equal(seenAfter.unifiedSimilarity.unifiedScore, 10);
  assert.deepEqual(seenAfter.unifiedSimilarity, seenBefore.unifiedSimilarity, 'the customer reads the same similarity result');
  assert.deepEqual(seenAfter.evidenceInterpretation, seenBefore.evidenceInterpretation, 'and the same explanation of it');
  assert.deepEqual(seenAfter.reportCompletion, seenBefore.reportCompletion);
  assert.equal(seenAfter.reportCompletion.state, 'COMPLETED');
  assert.equal(seenAfter.reportCompletion.signals.selectiveCorpus, 'COMPLETED');
});

test("2. a stale client that says 0 % — the browser's own archive-only score, or forged stamps, or a corpus that moved on since — cannot lower the finalized 10 %", async () => {
  const id = 'fr-stale';
  const { owner, report } = await finalizedReport(id, words(3000, 12));
  const before = await row(owner, id);
  assert.equal(before.report.unifiedSimilarity.unifiedScore, 10);

  // What a browser at this commit really sends: the score and explanation it computed itself, with no Selective Corpus.
  const browserScore = computeUnifiedSimilarity({ wordCount: report.wordCount, archiveMatchedPositions: report.archiveMatchedPositions });
  assert.equal(browserScore.unifiedScore, 0, "test setup sanity: the browser's own copy says 0 %");
  const browserCopy = withEvidenceInterpretation({ ...report, unifiedSimilarity: browserScore }, { selectiveCorpusBranch: null });
  assert.equal((await save(owner, report, { payload: { unifiedSimilarity: browserCopy.unifiedSimilarity, evidenceInterpretation: browserCopy.evidenceInterpretation, reportCompletion: browserCopy.reportCompletion } })).status, 200);
  assertSimilarityUntouched(before, await row(owner, id), "the browser's own 0 %");

  // The same, claiming to be newer than anything stored.
  assert.equal((await save(owner, report, {
    aiScore: 6,
    payload: { unifiedSimilarity: browserScore, unifiedSimilarityGeneration: 999999, unifiedSimilarityFailed: false, corpusSourceMatchingEnabledAtComputation: true },
  })).status, 200);
  assertSimilarityUntouched(before, await row(owner, id), 'a forged newer generation');

  // The corpus really did move on: this save's own resolution now runs at a newer generation than the stored score.
  await bumpCorpusMatchGeneration(client);
  assert.equal((await save(owner, report, { aiScore: 7 })).status, 200);
  const after = await row(owner, id);
  assertSimilarityUntouched(before, after, 'a save after the corpus generation moved');
  assert.equal(after.report.unifiedSimilarityGeneration, before.report.unifiedSimilarityGeneration, 'the stored score keeps the generation it was computed at');
  assertAiStored(after, { aiStatus: 'ready', aiScore: 7, analysisStatus: 'complete' }, 'each save still stored its AI result');
});

test('3. a save that carries no similarity state at all (the lean request) leaves the finalized 10 % in place', async () => {
  const id = 'fr-lean';
  const { owner, report } = await finalizedReport(id, words(3000, 13));
  const before = await row(owner, id);
  const lean = { ...report };
  for (const key of ['unifiedSimilarity', 'unifiedSimilarityFailed', 'unifiedSimilarityGeneration', 'corpusSourceMatchingEnabledAtComputation', 'evidenceInterpretation', 'reportCompletion', 'extractionDiagnostic']) {
    assert.equal(key in lean, false, 'test setup sanity: nothing server-owned is sent');
  }
  assert.equal((await save(owner, lean)).status, 200);
  const after = await row(owner, id);
  assertSimilarityUntouched(before, after, 'lean save');
  assert.equal(after.report.unifiedSimilarity.unifiedScore, 10);
  assertAiStored(after, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'lean save');
});

// ===========================================================================
// 4. completion composition survives
// ===========================================================================

test('4a. a Selective Corpus PARTIAL report keeps its lower-bound evidence, its "incomplete" marker and its reason through the AI save; the customer still reads PARTIAL', async () => {
  const id = 'fr-partial-selective';
  const { owner, report } = await finalizedReport(id, words(3000, 14), { shadow: partialShadow });
  const before = await row(owner, id);
  assert.equal(before.report.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.equal(before.report.selectiveCorpusAuthoritativeIncompleteReason, 'PARTIAL_INDEX');
  assert.equal(before.report.unifiedSimilarity.unifiedScore, 10, 'test setup sanity: a partial index still contributes its verified evidence');

  assert.equal((await save(owner, report)).status, 200);

  const after = await row(owner, id);
  assertSimilarityUntouched(before, after, 'AI save on a PARTIAL report');
  assert.equal(after.report.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.equal(after.report.selectiveCorpusAuthoritativeIncompleteReason, 'PARTIAL_INDEX');
  const seen = await getAsOwner(owner, id);
  assert.equal(seen.reportCompletion.state, 'PARTIAL');
  assert.equal(seen.reportCompletion.signals.selectiveCorpus, 'PARTIAL');
  assert.equal(seen.unifiedSimilarity.unifiedScore, 10);
});

test('4b. Selective Corpus COMPLETED + a partial previous-submission check stays PARTIAL through the AI save, and never becomes COMPLETED', async () => {
  const id = 'fr-partial-prior';
  const { owner, report } = await finalizedReport(id, await priorFixture(41, 'PARTIAL'), { passages: [passage(400, 459)] });
  const before = await row(owner, id);
  assert.equal(before.report.selectiveCorpusAuthoritativeStatus, 'completed');
  assert.equal(before.report.reportCompletion.signals.priorSubmission, 'PARTIAL', 'test setup sanity: recorded by the terminal write');
  assert.equal(before.report.unifiedSimilarity.selectiveCorpusOnlyWords, 60);

  assert.equal((await save(owner, report)).status, 200);

  assertSimilarityUntouched(before, await row(owner, id), 'AI save beside a partial previous-submission check');
  const seen = await getAsOwner(owner, id);
  assert.equal(seen.reportCompletion.state, 'PARTIAL');
  assert.equal(seen.reportCompletion.signals.selectiveCorpus, 'COMPLETED');
  assert.equal(seen.reportCompletion.signals.priorSubmission, 'PARTIAL');
});

// ===========================================================================
// 5-7. every evidence channel beside the Selective Corpus
// ===========================================================================

test('5. Selective Corpus + overlapping Archive evidence: the union and each channel\'s share are unchanged by the AI save', async () => {
  const id = 'fr-archive';
  const { owner, report } = await finalizedReport(id, words(3000, 15), { archiveMatchedPositions: range(350, 449) });
  const before = await row(owner, id);
  const u = before.report.unifiedSimilarity;
  assert.deepEqual(u.matchedPositions, range(100, 449), 'test setup sanity: Selective 100-399 united with Archive 350-449');
  assert.equal(u.archiveOnlyWords, 50);
  assert.equal(u.selectiveCorpusOnlyWords, 250);
  assert.equal(u.overlapWords, 50);
  assert.equal(u.unifiedScore, 12);

  assert.equal((await save(owner, report)).status, 200);

  const after = await row(owner, id);
  assertSimilarityUntouched(before, after, 'Selective + Archive');
  assert.deepEqual(after.report.unifiedSimilarity.matchedPositions, range(100, 449));
  assert.deepEqual(after.report.archiveMatchedPositions, range(350, 449));
});

test('6. Selective Corpus + overlapping previous-submission evidence: the union and the previous-submission share are unchanged by the AI save', async () => {
  const id = 'fr-prior';
  const { owner, report } = await finalizedReport(id, await priorFixture(42, 'COMPLETE'), { passages: [passage(250, 399)] });
  const before = await row(owner, id);
  const u = before.report.unifiedSimilarity;
  assert.ok(u.previousUploadOnlyWords > 0, 'test setup sanity: a previous submission holds part of the text');
  assert.ok(u.selectiveCorpusOnlyWords > 0, 'test setup sanity: the Selective Corpus holds another part');
  assert.ok(u.overlapWords > 0, 'test setup sanity: and they overlap');
  assert.equal(before.report.reportCompletion.signals.priorSubmission, 'COMPLETE');

  assert.equal((await save(owner, report)).status, 200);

  const after = await row(owner, id);
  assertSimilarityUntouched(before, after, 'Selective + previous submission');
  assert.deepEqual(after.report.unifiedSimilarity.previousUploadPositions, u.previousUploadPositions);
  assert.equal(after.report.unifiedSimilarity.previousUploadOnlyWords, u.previousUploadOnlyWords);
});

test('6b. Selective Corpus + overlapping live-academic evidence: the union and the academic share are unchanged by the AI save', async () => {
  const id = 'fr-academic';
  const text = words(3000, 35);
  // What /api/academic-evidence stored for this manuscript; the report row keeps only the handle to it.
  const evidence = [{
    provider: 'openaire', providerId: 'fr-academic-1', title: 'Academic source', authors: ['A. Author'], publication: 'Journal', year: 2020,
    doi: '10.9999/fr-academic', url: 'https://example.org/fr-academic', similarity: 50,
    matchedPassages: [{ submittedText: 'x', submittedWordStart: 350, submittedWordEnd: 449, matchedWordCount: 100 }],
  }];
  const diagnosticsId = Number(await recordAcademicSearchRunDiagnostics(client, {
    status: 'COMPLETE_WITH_MATCHES',
    stats: { queryCount: 3, searchLatencyMs: 1, candidateCountBeforeDedup: 1, candidateCountAfterDedup: 1, deduplicationRate: 0, candidatesTextRetrieved: 1, textRetrievalLatencyMs: 1, comparisonLatencyMs: 1, totalLatencyMs: 3, providerErrors: [], searchAttempts: 3 },
    queries: null, candidates: null, retrievalDiagnostics: null, evidence,
    submissionCanonicalSha256: canonicalSha256(text), scoringNormalizationVersion: 2,
  }));
  const { owner, report } = await finalizedReport(id, text, {
    reportFields: { academicEvidenceStatus: 'COMPLETE_WITH_MATCHES', externalAcademicEvidence: evidence },
    serverFields: { verifiedAcademicSearchDiagnosticsId: diagnosticsId },
  });
  const before = await row(owner, id);
  const u = before.report.unifiedSimilarity;
  assert.deepEqual(u.matchedPositions, range(100, 449), 'test setup sanity: Selective 100-399 united with the academic passage 350-449');
  assert.equal(u.liveAcademicOnlyWords, 50);
  assert.equal(u.selectiveCorpusOnlyWords, 250);
  assert.equal(u.overlapWords, 50);

  assert.equal((await save(owner, report)).status, 200);

  const after = await row(owner, id);
  assertSimilarityUntouched(before, after, 'Selective + live-academic evidence');
  assert.equal(after.report.unifiedSimilarity.liveAcademicOnlyWords, 50);
  assert.equal(after.raw.verifiedAcademicSearchDiagnosticsId, diagnosticsId, 'the server-side handle to the verified evidence is kept');
});

test('7. Selective Corpus + overlapping imported evidence: the union and the imported share are unchanged by the AI save', async () => {
  const id = 'fr-imported';
  const text = `${words(120, 16)} ${ANCHOR} ${words(120, 17)}`;
  const { owner, report } = await finalizedReport(id, text, { passages: [passage(115, 122)] });
  const before = await row(owner, id);
  const u = before.report.unifiedSimilarity;
  assert.ok(u.importedSimilarityEvidenceOnlyWords > 0, 'test setup sanity: the imported unit matched the anchor');
  assert.ok(u.selectiveCorpusOnlyWords > 0, 'test setup sanity: the Selective Corpus holds words before it');
  assert.ok(u.overlapWords > 0, 'test setup sanity: and they overlap');

  assert.equal((await save(owner, report)).status, 200);

  const after = await row(owner, id);
  assertSimilarityUntouched(before, after, 'Selective + imported evidence');
  assert.deepEqual(after.report.unifiedSimilarity.importedSimilarityEvidencePositions, u.importedSimilarityEvidencePositions);
});

// ===========================================================================
// 8-9. AI lifecycle: failure, retry, repetition
// ===========================================================================

test('8. an AI failure save, the AI result that follows it and a late failure after that each leave the similarity untouched', async () => {
  const id = 'fr-ai-failed';
  const { owner, report } = await finalizedReport(id, words(3000, 18));
  const before = await row(owner, id);

  assert.equal((await failedSave(owner, report)).status, 200);
  const failed = await row(owner, id);
  assertSimilarityUntouched(before, failed, 'AI failure save');
  assertAiStored(failed, { aiStatus: 'failed', aiScore: null, analysisStatus: 'error' }, 'AI failure save');

  assert.equal((await save(owner, report, { aiScore: 9 })).status, 200);
  const ready = await row(owner, id);
  assertSimilarityUntouched(before, ready, 'AI result after a failure');
  assertAiStored(ready, { aiStatus: 'ready', aiScore: 9, analysisStatus: 'complete' }, 'AI result after a failure');

  assert.equal((await failedSave(owner, report)).status, 200);
  const late = await row(owner, id);
  assert.equal(late.json, ready.json, 'a late failure changes nothing at all: the ready AI result and the similarity both stay');
  assertAiStored(late, { aiStatus: 'ready', aiScore: 9, analysisStatus: 'complete' }, 'late failure');
});

test('9. repeated AI saves are idempotent: the stored report is byte-identical after each', async () => {
  const id = 'fr-repeat';
  const { owner, report } = await finalizedReport(id, words(3000, 19), { archiveMatchedPositions: range(350, 449) });
  const before = await row(owner, id);
  const aiAnalysis = completeAiAnalysis();

  assert.equal((await save(owner, report, { aiAnalysis })).status, 200);
  const first = await row(owner, id);
  assertSimilarityUntouched(before, first, 'first AI save');
  for (const n of [2, 3, 4]) {
    assert.equal((await save(owner, report, { aiAnalysis })).status, 200);
    assert.equal((await row(owner, id)).json, first.json, `AI save ${n}: the stored report did not move`);
  }
});

// ===========================================================================
// 10. what may still write a score still does
// ===========================================================================

test('10a. the finalizer still writes the final score: an AI save while the report is pending leaves it pending with no score, and the finalizer then lands the Selective Corpus evidence beside that AI result', async () => {
  const id = 'fr-pending';
  const owner = await signUpOwner();
  const report = localReport(id, words(3000, 20));
  await seedPending(owner, report);

  assert.equal((await save(owner, report)).status, 200);
  const pending = await row(owner, id);
  assert.equal(pending.raw.selectiveCorpusAuthoritativeStatus, 'pending', 'a save never finalizes the report');
  assert.equal(pending.raw.unifiedSimilarity, undefined, 'and never persists a score for it');
  assertAiStored(pending, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'AI save while pending');

  assert.deepEqual(await finalize(owner, id, completedShadow([passage(100, 399)])), { outcome: 'finalized', status: 'completed' });
  const finalized = await row(owner, id);
  assert.equal(finalized.report.unifiedSimilarity.unifiedScore, 10, 'the server-authorized resolution updated the similarity');
  assert.deepEqual(finalized.report.unifiedSimilarity.selectiveCorpusPositions, range(100, 399));
  assertAiStored(finalized, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'the finalizer kept the AI result');

  assert.equal((await save(owner, report, { aiScore: 6 })).status, 200);
  assertSimilarityUntouched(finalized, await row(owner, id), 'and a later AI save keeps what the finalizer wrote');
});

test('10b. a report that is not authoritative is still re-resolved by a save: evidence that became available since the first save is found, and the score moves', async () => {
  const owner = await signUpOwner();
  const id = 'fr-ordinary';
  const shared = words(120, 2101);
  const report = localReport(id, `${words(200, 2102)} ${shared} ${words(280, 2103)}`);

  assert.equal((await save(owner, report, { aiStatus: 'processing', aiScore: null, aiTone: null, aiAnalysis: null, body: { room: 0 } })).status, 200);
  const first = await row(owner, id);
  assert.equal(first.raw.selectiveCorpusAuthoritativeStatus, undefined, 'test setup sanity: created outside authoritative mode');
  assert.equal(first.report.unifiedSimilarity.unifiedScore, 0, 'test setup sanity: nothing matches yet');

  // Another account's document holding the passage enters the corpus.
  await index('fr-later-source', `${words(250, 2104)} ${shared} ${words(250, 2105)}`);
  await matureCorpusBackings(client);
  await bumpCorpusMatchGeneration(client);

  assert.equal((await save(owner, report)).status, 200);
  const healed = await row(owner, id);
  assert.equal(healed.report.unifiedSimilarity.unifiedScore, 20, 'the save re-resolved the score: 120 of 600 words');
  assert.ok(healed.report.unifiedSimilarity.previousUploadOnlyWords > 0);
  assert.ok(healed.report.unifiedSimilarityGeneration > first.report.unifiedSimilarityGeneration, 'at the newer corpus generation');
  assertAiStored(healed, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'ordinary AI save');
});

// ===========================================================================
// 11-13. the client has no authority over server-owned evidence
// ===========================================================================

test('11. a client cannot inject Selective Corpus positions: not into a finalized report, and not into one that never was authoritative', async () => {
  const id = 'fr-inject';
  const { owner, report } = await finalizedReport(id, words(3000, 22));
  const before = await row(owner, id);
  const forged = {
    version: 'unified-similarity-v1', wordCount: report.wordCount, unifiedScore: 100, uniqueMatchedWords: report.wordCount,
    archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0, selfExcludedWords: 0, unknownExcludedWords: 0, deviceSelfExcludedWords: 0,
    userSuppliedReferenceOnlyWords: 0, selectiveCorpusOnlyWords: report.wordCount, importedSimilarityEvidenceOnlyWords: 0,
    contributions: [{ sourceType: 'selective_corpus', sourceId: 'selective-corpus:FORGED', submittedWordStart: 0, submittedWordEnd: report.wordCount - 1, matchedWordCount: report.wordCount, evidenceStatus: 'included' }],
    matchedPositions: range(0, report.wordCount - 1), previousUploadPositions: [], userSuppliedReferencePositions: [],
    selectiveCorpusPositions: range(0, report.wordCount - 1), importedSimilarityEvidencePositions: [],
  };
  const injection = {
    unifiedSimilarity: forged, unifiedSimilarityGeneration: 999999, unifiedSimilarityFailed: false, corpusSourceMatchingEnabledAtComputation: true,
    selectiveCorpusAuthoritativeStatus: 'completed',
    selectiveCorpusEvidence: [{ sourceId: 'FORGED', matchedPassages: [passage(0, report.wordCount - 1)] }],
  };
  assert.equal((await save(owner, report, { payload: injection })).status, 200);
  const after = await row(owner, id);
  assertSimilarityUntouched(before, after, 'injection into a finalized report');
  assert.equal(after.report.unifiedSimilarity.unifiedScore, 10);
  assert.equal('selectiveCorpusEvidence' in after.raw, false, 'nothing the client sent beside the AI half is stored');

  // A report created outside authoritative mode cannot be made to look finalized either.
  const ordinaryOwner = await signUpOwner();
  const ordinary = localReport('fr-inject-ordinary', words(3000, 23));
  assert.equal((await save(ordinaryOwner, ordinary, { payload: injection, body: { room: 0 } })).status, 200);
  const stored = await row(ordinaryOwner, ordinary.id);
  assert.equal(stored.raw.selectiveCorpusAuthoritativeStatus, undefined, 'the marker is the server\'s: a client value is never stored');
  assert.equal(stored.report.unifiedSimilarity.unifiedScore, 0, 'the server computed its own score');
  assert.deepEqual(stored.report.unifiedSimilarity.selectiveCorpusPositions, []);
  assert.notEqual(stored.report.unifiedSimilarityGeneration, 999999);
});

test('12. a client cannot remove Selective Corpus positions: nulled similarity fields, a "pending" marker, a failure flag and withdrawn Archive positions are all ignored', async () => {
  const id = 'fr-remove';
  const { owner, report } = await finalizedReport(id, words(3000, 24), { archiveMatchedPositions: range(350, 449) });
  const before = await row(owner, id);
  assert.equal(before.report.unifiedSimilarity.unifiedScore, 12);

  const removals = [
    ['nulled similarity', { unifiedSimilarity: null, unifiedSimilarityGeneration: null, corpusSourceMatchingEnabledAtComputation: null, evidenceInterpretation: null, reportCompletion: null }],
    ['a failure flag', { unifiedSimilarityFailed: true }],
    ['a "pending" marker', { selectiveCorpusAuthoritativeStatus: 'pending', selectiveCorpusAuthoritativeClaimedAt: '2020-01-01 00:00:00' }],
    ['no marker', { selectiveCorpusAuthoritativeStatus: null }],
    ['withdrawn Archive positions', { archiveMatchedPositions: [], matchedWordCount: 0 }],
  ];
  for (const [label, payload] of removals) {
    assert.equal((await save(owner, report, { payload })).status, 200, label);
    const after = await row(owner, id);
    assertSimilarityUntouched(before, after, label);
    assert.equal(after.report.unifiedSimilarity.unifiedScore, 12, label);
    assert.deepEqual(after.report.unifiedSimilarity.selectiveCorpusPositions, range(100, 349), label);
    assert.deepEqual(after.report.archiveMatchedPositions, range(350, 449), label);
    assert.equal(after.raw.selectiveCorpusAuthoritativeStatus, 'completed', label);
  }
  assert.equal((await finalize(owner, id, timeoutShadow())).outcome, 'not-pending', 'and the report was never reopened for the finalizer');
});

test('13. the server-owned retry count, the incomplete reason and the completion diagnostics of a report that timed out survive an AI save that forges all three', async () => {
  const id = 'fr-counters';
  const owner = await signUpOwner({ admin: true });
  const report = localReport(id, await priorFixture(43, 'PARTIAL'));
  await seedPending(owner, report);
  const outcomes = [];
  for (let i = 0; i < MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS; i += 1) outcomes.push((await finalize(owner, id, timeoutShadow())).outcome);
  assert.deepEqual(outcomes, [...Array(MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS - 1).fill('timeout-retry-scheduled'), 'finalized']);
  const before = await row(owner, id);
  assert.equal(before.raw.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.equal(before.raw.selectiveCorpusAuthoritativeIncompleteReason, 'TIMEOUT');
  assert.equal(before.raw.selectiveCorpusAuthoritativeTimedOutAttempts, MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS - 1);
  assert.equal(before.report.unifiedSimilarity.unifiedScore, 20, 'test setup sanity: the verified previous submission still scores');

  assert.equal((await save(owner, report, {
    payload: {
      selectiveCorpusAuthoritativeTimedOutAttempts: 0, selectiveCorpusAuthoritativeIncompleteReason: 'FAILED', selectiveCorpusAuthoritativeStatus: 'completed',
      reportCompletion: { state: 'COMPLETED', signals: { academicSearch: 'COMPLETE_NO_MATCHES', selectiveCorpus: 'COMPLETED', extraction: 'COMPLETE', unverifiedCandidateCount: 0, userSuppliedReference: null, priorSubmission: 'COMPLETE' }, diagnostics: [] },
    },
  })).status, 200);

  const after = await row(owner, id);
  assertSimilarityUntouched(before, after, 'AI save forging the server-owned diagnostics');
  assert.equal(after.raw.selectiveCorpusAuthoritativeTimedOutAttempts, MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS - 1);
  assert.equal(after.raw.selectiveCorpusAuthoritativeIncompleteReason, 'TIMEOUT');
  assert.equal(after.raw.selectiveCorpusAuthoritativeStatus, 'incomplete');
  const seen = await getAsOwner(owner, id);
  assert.equal(seen.reportCompletion.state, 'PARTIAL');
  assert.equal(seen.reportCompletion.signals.selectiveCorpus, 'PARTIAL');
  assert.equal(seen.reportCompletion.signals.priorSubmission, 'PARTIAL');
  assert.deepEqual(seen.reportCompletion.diagnostics, [
    { channel: 'SELECTIVE_CORPUS', reason: 'TIMEOUT' },
    { channel: 'PRIOR_SUBMISSION', reason: 'NOT_RECORDED' },
  ]);
});

// ===========================================================================
// 14. the rule is part of the write itself
// ===========================================================================

/** SAVE_REPORT_SQL exactly as the route runs it, for one incoming payload on an existing row. */
async function upsert(owner, report, incomingPayload, { aiStatus = 'ready', aiScore = 7 } = {}) {
  await client.execute({
    sql: reportsRoute.SAVE_REPORT_SQL,
    args: [report.id, owner.deviceKey, report.submissionId, report.title, report.created, report.wordCount, 0, 'Low', aiScore, 'low', aiStatus, JSON.stringify(incomingPayload), owner.userId, null],
  });
}
/** A full, well-formed payload a save could carry: its own score with no Selective Corpus, stamped at a newer generation. */
function newerGenerationPayload(report) {
  return {
    ...report, unifiedSimilarity: computeUnifiedSimilarity({ wordCount: report.wordCount, archiveMatchedPositions: report.archiveMatchedPositions }),
    unifiedSimilarityGeneration: 50, unifiedSimilarityFailed: false, corpusSourceMatchingEnabledAtComputation: true,
    aiScore: 7, aiAnalysis: completeAiAnalysis(),
  };
}

test('14. the upsert itself keeps a terminal report\'s stored payload whatever generation the incoming one carries — and only a terminal report\'s', async () => {
  const { owner, report } = await finalizedReport('fr-sql-terminal', words(3000, 25));
  const before = await row(owner, report.id);
  assert.ok(before.report.unifiedSimilarityGeneration < 50, 'test setup sanity: the incoming payload is at a NEWER generation, so the generation guard alone lets it through');

  await upsert(owner, report, newerGenerationPayload(report));
  const after = await row(owner, report.id);
  assertSimilarityUntouched(before, after, 'newer-generation payload onto a terminal report');
  assert.equal(after.report.unifiedSimilarity.unifiedScore, 10);
  assertAiStored(after, { aiStatus: 'ready', aiScore: 7, analysisStatus: 'complete' }, 'its AI half is merged');

  // "incomplete" is terminal too.
  const partial = await finalizedReport('fr-sql-incomplete', words(3000, 26), { shadow: partialShadow });
  const partialBefore = await row(partial.owner, partial.report.id);
  await upsert(partial.owner, partial.report, newerGenerationPayload(partial.report));
  assertSimilarityUntouched(partialBefore, await row(partial.owner, partial.report.id), 'newer-generation payload onto an incomplete report');

  // Still pending: nothing final is stored yet, so the rule does not apply (POST itself never sends a score for it).
  const pendingOwner = await signUpOwner();
  const pendingReport = localReport('fr-sql-pending', words(3000, 27));
  await seedPending(pendingOwner, pendingReport);
  await upsert(pendingOwner, pendingReport, newerGenerationPayload(pendingReport));
  assert.equal((await row(pendingOwner, pendingReport.id)).raw.unifiedSimilarityGeneration, 50, 'a pending row is not held');

  // Never authoritative: a newer-generation save replaces the stored score, exactly as before.
  const ordinaryOwner = await signUpOwner();
  const ordinary = localReport('fr-sql-ordinary', words(3000, 28));
  assert.equal((await save(ordinaryOwner, ordinary, { aiStatus: 'processing', aiScore: null, aiTone: null, aiAnalysis: null, body: { room: 0 } })).status, 200);
  await upsert(ordinaryOwner, ordinary, newerGenerationPayload(ordinary));
  assert.equal((await row(ordinaryOwner, ordinary.id)).raw.unifiedSimilarityGeneration, 50, 'an ordinary report is still replaced by a newer-generation save');
});

test('14b. the rule is keyed on the terminal marker alone: a terminal report that stores no score and no generation stamp is kept as it is, and a save puts no Selective-Corpus-less score in its place', async () => {
  const id = 'fr-scoreless';
  const owner = await signUpOwner();
  const report = localReport(id, words(3000, 34), { archiveMatchedPositions: range(350, 449) });
  await seedPending(owner, report);
  // Not a state the finalizer writes at this commit; set directly, to show what the rule depends on.
  await client.execute({
    sql: `UPDATE saved_reports
          SET payload_json = json_set(payload_json, '$.selectiveCorpusAuthoritativeStatus', 'incomplete', '$.selectiveCorpusAuthoritativeIncompleteReason', 'FINALIZER_ERROR', '$.unifiedSimilarityFailed', json('true'))
          WHERE device_key = ? AND id = ?`,
    args: [owner.deviceKey, id],
  });
  const before = await row(owner, id);
  assert.equal(before.raw.unifiedSimilarity, undefined);
  assert.equal(before.raw.unifiedSimilarityGeneration, undefined, 'test setup sanity: nothing for the generation guard to compare');

  assert.equal((await save(owner, report)).status, 200);

  const after = await row(owner, id);
  assert.deepEqual(changedSimilarityKeys(before, after), [], 'nothing but the AI half of the stored report changed');
  assert.equal(after.raw.unifiedSimilarity, undefined, 'no score was put in its place');
  assert.equal(after.raw.unifiedSimilarityFailed, true);
  assert.equal(after.raw.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.equal(after.raw.selectiveCorpusAuthoritativeIncompleteReason, 'FINALIZER_ERROR');
  assertAiStored(after, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'AI save onto a scoreless terminal report');
});

// ===========================================================================
// 15. the row that is persisted is the row that was measured
// ===========================================================================

/**
 * A 40,000-word report the finalizer completed with 2,000 separate ten-word Selective Corpus passages (50 %). What is
 * stored for it — positions, per-passage attribution, explanation — is far larger than the copy of the report a save
 * sends, which is the gap the size cases below sit in.
 */
async function largeFinalizedReport(id, seed) {
  const passages = Array.from({ length: 2_000 }, (_, i) => passage(i * 20, i * 20 + 9));
  const { owner, report } = await finalizedReport(id, words(40_000, seed), { passages });
  const before = await row(owner, id);
  assert.equal(before.report.unifiedSimilarity.unifiedScore, 50, 'test setup sanity: 20,000 of 40,000 words');
  const sent = JSON.stringify(report).length;
  assert.ok(persistedPayloadSize(before.json) - sent > 40_000, 'test setup sanity: the stored report is far larger than the copy a save sends');
  return { owner, report, before, sent };
}
/** An AI result of known bulk: one passage holding `text`. */
const aiAnalysisWith = (text, analysis = completeAiAnalysis()) => ({ ...analysis, passages: [{ text }] });

test('15. an AI result that fits beside the request\'s own copy but not beside the stored, finalized report is refused 413 with the row untouched; the AI-result route then settles it without touching the similarity', async () => {
  const id = 'fr-size';
  const { owner, report, before, sent } = await largeFinalizedReport(id, 29);

  // Under the ceiling beside the browser's copy of the report, over it beside the stored one.
  const filler = MAX_REPORT_SAVE_REQUEST_BYTES - sent - 20_000;
  const aiAnalysis = aiAnalysisWith('a'.repeat(filler));
  assert.ok(JSON.stringify({ ...report, aiScore: 5, aiAnalysis }).length < MAX_REPORT_SAVE_REQUEST_BYTES, 'test setup sanity: the request payload is under the ceiling');
  assert.ok(persistedPayloadSize(before.json) + filler > MAX_REPORT_SAVE_REQUEST_BYTES, 'test setup sanity: the stored report plus this AI result is over it');

  const res = await save(owner, report, { aiAnalysis });
  assert.equal(res.status, 413, 'refused: the report this save would persist does not fit');
  const refused = await row(owner, id);
  assert.ok(refused.json === before.json, 'nothing was written');
  assert.equal(refused.aiStatus, 'processing');

  // What the browser does next (lib/report-ai-completion.ts): the same AI result through the AI-result route.
  await resetRateForTest(`${owner.tag}-retry`);
  const retry = await aiRetryRoute.POST(new Request(`http://localhost/api/reports/${id}/ai-retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `${owner.tag}-retry`, cookie: `tp_session_v1=${owner.cookie}` },
    body: JSON.stringify({ aiStatus: 'ready', aiScore: 5, aiTone: 'low', payload: { aiScore: 5, aiAnalysis } }),
  }), { params: Promise.resolve({ id }) });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).aiOutcome, AI_SAVE_OUTCOME_SIZE_UNAVAILABLE);
  const settled = await row(owner, id);
  assert.ok(persistedPayloadSize(settled.json) <= MAX_REPORT_SAVE_REQUEST_BYTES, 'the stored report never exceeds the persistence ceiling');
  assert.equal(settled.raw.aiAnalysis.unavailableReason, AI_UNAVAILABLE_REASON_REPORT_SIZE);
  assert.deepEqual(changedSimilarityKeys(before, settled), [], 'and its similarity is exactly as finalized');
  assert.equal(settled.raw.unifiedSimilarity.unifiedScore, 50);
});

test('15b. a save whose AI half the upsert will not merge is not refused for a size it never adds: a late oversized failure onto a ready report, and a replayed first save', async () => {
  const id = 'fr-size-kept';
  const { owner, report, sent } = await largeFinalizedReport(id, 32);
  assert.equal((await save(owner, report)).status, 200);
  const ready = await row(owner, id);
  assertAiStored(ready, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'test setup sanity: the AI result is stored');

  // A stored ready AI result is never displaced by a failure, so this oversized one is not written — and not a 413 either.
  const filler = MAX_REPORT_SAVE_REQUEST_BYTES - sent - 20_000;
  assert.ok(persistedPayloadSize(ready.json) + filler > MAX_REPORT_SAVE_REQUEST_BYTES, 'test setup sanity: merged, it would not fit');
  assert.equal((await failedSave(owner, report, { aiAnalysis: aiAnalysisWith('a'.repeat(filler), failedAiAnalysis()) })).status, 200);
  assert.ok((await row(owner, id)).json === ready.json, 'the stored report is untouched');

  // The first save sent again: no AI result at all, checked against the smaller first-save ceiling.
  assert.equal((await save(owner, report, { aiStatus: 'processing', aiScore: null, aiTone: null, aiAnalysis: null })).status, 200);
  const replayed = await row(owner, id);
  assert.ok(replayed.json === ready.json, 'the stored report is untouched');
  assertAiStored(replayed, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'replayed first save');
});

test('15c. the size of the merged report is measured in the persistence unit even when SQL bounds cannot settle it: astral text that only fits by code points is refused, accented text that only overflows in bytes is stored', async () => {
  // The persistence UNIT is a property of the ceiling, which a row stored as arrays meets (compact positions OFF, the
  // default). A row stored as ranges is first held to the serving bound (tests/terminal-report-ai-completion.test.mjs), and
  // this fixture's accented AI result would take its served size past it — so the fixture is pinned to arrays.
  const positionsGate = process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED;
  delete process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED;
  try {
    await sizeUnitCase();
  } finally {
    if (positionsGate === undefined) delete process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED;
    else process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED = positionsGate;
  }
});
async function sizeUnitCase() {
  const id = 'fr-size-unit';
  const { owner, report, before } = await largeFinalizedReport(id, 33);
  const stored = persistedPayloadSize(before.json);
  const room = MAX_REPORT_SAVE_REQUEST_BYTES - stored;

  // Each astral character is 1 code point but 2 persisted units: under the ceiling by code points, over it in fact.
  const astral = '\u{1D49C}'.repeat(Math.ceil(room / 2) + 5_000);
  assert.ok(stored + astral.length > MAX_REPORT_SAVE_REQUEST_BYTES && stored + [...astral].length < MAX_REPORT_SAVE_REQUEST_BYTES, 'test setup sanity: only the unit decides');
  assert.ok(JSON.stringify({ ...report, aiScore: 5, aiAnalysis: aiAnalysisWith(astral) }).length < MAX_REPORT_SAVE_REQUEST_BYTES, 'test setup sanity: the request payload is under the ceiling');
  assert.equal((await save(owner, report, { aiAnalysis: aiAnalysisWith(astral) })).status, 413);
  assert.ok((await row(owner, id)).json === before.json, 'nothing was written');

  // Each accented character is 1 persisted unit but 2 UTF-8 bytes: over the ceiling in bytes, under it in fact.
  const accented = 'é'.repeat(room - 50_000);
  assert.ok(stored + accented.length < MAX_REPORT_SAVE_REQUEST_BYTES && stored + 2 * accented.length > MAX_REPORT_SAVE_REQUEST_BYTES, 'test setup sanity: only the unit decides');
  assert.equal((await save(owner, report, { aiAnalysis: aiAnalysisWith(accented) })).status, 200);
  const after = await row(owner, id);
  assert.ok(persistedPayloadSize(after.json) <= MAX_REPORT_SAVE_REQUEST_BYTES, 'the stored report is within the persistence ceiling');
  assert.equal(after.raw.aiAnalysis.passages[0].text.length, accented.length, 'the AI result is stored whole');
  assert.deepEqual(changedSimilarityKeys(before, after), [], 'and the similarity is exactly as finalized');
  assert.equal(after.raw.unifiedSimilarity.unifiedScore, 50);
}

// ===========================================================================
// 16. the whole lifecycle through the routes
// ===========================================================================

test('16. first save in authoritative mode -> the deferred finalizer makes it terminal -> the AI save: the report the finalizer left is the report that stays', async () => {
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  try {
    const owner = await signUpOwner();
    const report = localReport('fr-lifecycle', `${words(120, 30)} ${ANCHOR} ${words(120, 31)}`, { archiveMatchedPositions: range(10, 39) });
    // No request scope in this harness, so the deferred finalizer has run by the time the save returns (lib/run-after-response.ts).
    assert.equal((await save(owner, report, { aiStatus: 'processing', aiScore: null, aiTone: null, aiAnalysis: null, body: { room: 0 } })).status, 200);
    const before = await row(owner, report.id);
    assert.equal(before.raw.selectiveCorpusAuthoritativeStatus, 'incomplete', 'test setup sanity: no Selective Corpus artifact here, so the finalizer ends the report "incomplete"');
    assert.ok(before.report.unifiedSimilarity.archiveOnlyWords > 0, 'test setup sanity: with the Archive evidence');
    assert.ok(before.report.unifiedSimilarity.importedSimilarityEvidenceOnlyWords > 0, 'test setup sanity: and the imported evidence');
    assert.ok(before.raw.reportCompletion, 'the first save itself stored a completion: what the customer reads below never depended on a later save rebuilding one');

    assert.equal((await save(owner, report)).status, 200);

    const after = await row(owner, report.id);
    assertSimilarityUntouched(before, after, 'AI save after a real finalization');
    assertAiStored(after, { aiStatus: 'ready', aiScore: 5, analysisStatus: 'complete' }, 'AI save after a real finalization');
    const seen = await getAsOwner(owner, report.id);
    assert.equal(seen.reportCompletion.state, 'PARTIAL', 'the customer reads the incomplete Selective Corpus search as a partial one');
    assert.equal(seen.reportCompletion.signals.selectiveCorpus, 'PARTIAL');
  } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
    delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  }
});

test('16b. a report saved with a reference file: the score the finalizer stored and the server-verified reference evidence beside it are both what stays after the AI save', async () => {
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  try {
    const owner = await signUpOwner();
    const shared = words(150, 36);
    const report = localReport('fr-reference', `${words(200, 37)} ${shared} ${words(250, 38)}`);
    const reference = { fileName: 'reference.txt', fileType: 'txt', extractedText: `${words(180, 39)} ${shared} ${words(180, 40)}` };
    assert.equal((await save(owner, report, { aiStatus: 'processing', aiScore: null, aiTone: null, aiAnalysis: null, body: { room: 0, userSuppliedReferences: [reference] } })).status, 200);
    const before = await row(owner, report.id);
    assert.equal(before.raw.selectiveCorpusAuthoritativeStatus, 'incomplete', 'test setup sanity: finalized by the deferred finalizer');
    assert.equal(before.raw.userSuppliedReferenceEvidence?.[0]?.admitted, true, 'test setup sanity: the server verified and admitted the reference');
    assert.ok(before.raw.userSuppliedReferenceGuard, 'test setup sanity: with its carry-forward guard');

    // The AI save carries no reference files. Whether the finalizer's score counts the reference channel is the
    // finalizer's own boundary (tests/selective-corpus-authoritative-interpretation-consistency.test.mjs); a save changes neither.
    assert.equal((await save(owner, report)).status, 200);

    const after = await row(owner, report.id);
    assertSimilarityUntouched(before, after, 'AI save on a report with a reference file');
    assert.deepEqual(after.raw.userSuppliedReferenceEvidence, before.raw.userSuppliedReferenceEvidence);
    assert.deepEqual(after.raw.userSuppliedReferenceChannel, before.raw.userSuppliedReferenceChannel);
    assert.deepEqual(after.raw.userSuppliedReferenceGuard, before.raw.userSuppliedReferenceGuard);
  } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
    delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  }
});
