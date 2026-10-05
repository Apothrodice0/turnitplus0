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
import { completeAiAnalysis } from './helpers/complete-ai-analysis.mjs';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import { withEvidenceInterpretation } from '../lib/report-evidence-interpretation.ts';
import { decodeReportFromPersistence, encodeReportForPersistence, MAX_SERVED_REPORT_BYTES, servedReportBytes } from '../lib/report-persistence.ts';
import { MAX_REPORT_SAVE_REQUEST_BYTES, persistedPayloadSize } from '../lib/report-transport-limits.ts';
import { isCompactPositions } from '../lib/position-runs-persistence.ts';
import { buildSizeUnavailableAiAnalysis } from '../lib/ai-unavailable-state.ts';
import {
  claimStaleSelectiveCorpusAuthoritativePendingReports,
  finalizeSelectiveCorpusAuthoritativeReport,
} from '../lib/selective-corpus-authoritative.ts';

/**
 * SIMILARITY TAKES PRIORITY OVER AI, AND THE ORDER DOES NOT MATTER.
 *
 * An authoritative report's AI result can be stored while the report is still pending — the browser's AI save lands first,
 * e.g. while a timed-out Selective Corpus attempt waits for the recovery sweep. The finalizer then decides the similarity as
 * if no AI result were there, and the AI half by the AI-result route's own rule on the exact row it writes:
 *   - combined fits                      -> the final similarity, AI stays ready;
 *   - combined too large only because of AI -> the final similarity, AI "unavailable for this document" (REPORT_SIZE);
 *   - the similarity cannot fit on its own -> PERSISTENCE_LIMIT, unchanged.
 * Every case is checked against its FINALIZER-FIRST twin (same evidence: finalized, then the same AI result through the
 * AI-result route): the two must be the same report. Real finalizer, real routes; every corpus is synthetic.
 */

const ENV_KEYS = ['TURSO_DATABASE_URL', 'CORPUS_SOURCE_MATCHING_ENABLED', 'REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED', 'REPORT_COMPACT_POSITIONS_WRITE_ENABLED',
  'SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED', 'SELECTIVE_CORPUS_SHADOW_ENABLED', 'SELECTIVE_CORPUS_ARTIFACT_PATH'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const workDir = mkdtempSync(path.join(process.env.TURNITPLUS_TEST_DB_DIR || tmpdir(), 'ai-first-'));
const dbFile = path.join(workDir, 'ai_first.db');
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
process.env.REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED = 'true';
delete process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED;
for (const key of ['SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED', 'SELECTIVE_CORPUS_SHADOW_ENABLED', 'SELECTIVE_CORPUS_ARTIFACT_PATH']) delete process.env[key];

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, path.resolve('drizzle'));
const openConnection = () => createClient({ url: `file:${dbFile}` });

test.after(() => {
  client.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const SYLLABLES = ['ka', 'lo', 'mi', 'tre', 'vun', 'sor', 'bel', 'dra', 'phi', 'quen', 'zor', 'tal', 'mer', 'nix', 'ost', 'ula', 'rin', 'vek', 'dom', 'sha', 'gri', 'pol', 'wex', 'yun'];
function words(count, seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length]);
  return out.join(' ');
}
const twoLetterText = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26), 97 + ((i * 7 + 3) % 26))).join(' ');
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
const withEnv = async (overrides, fn) => {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const set = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  for (const [key, value] of Object.entries(overrides)) set(key, value);
  try { return await fn(); } finally { for (const [key, value] of Object.entries(previous)) set(key, value); }
};
const silently = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

let accounts = 0;
async function signUp() {
  accounts += 1;
  const tag = `aif-${accounts}`, email = `aif-owner-${accounts}@example.test`, deviceKey = `aif-device-${accounts}`;
  await resetAuthRateForTest(`${tag}-signup`);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${tag}-signup` },
    body: JSON.stringify(withTestIdentity({ email, password: 'aif-owner-pw-1', username: `aifowner${accounts}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = (res.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)[1];
  const userId = String((await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  return { userId, deviceKey, cookie, tag };
}

function localReport(id, text) {
  return {
    version: 11, id, submissionId: `sub-${id}`, title: 'AI-first fixture', author: '', assignment: '', created: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    score: 0, archiveScore: 0, scoreBand: 'Low', wordCount: tokensForScoringNormalization(text, 2).length, characterCount: text.length,
    matchedWordCount: 0, archiveMatchedPositions: [], scoringNormalizationVersion: 2, sources: [], repeats: [], text, academicEvidenceStatus: 'COMPLETE_NO_MATCHES', externalAcademicEvidence: [],
  };
}
/** The row an authoritative first save persists: pending, no score, the AI check still running. */
async function seedPending(owner, report, { compactPositions = false } = {}) {
  const built = withEvidenceInterpretation({ ...report }, { selectiveCorpusBranch: null });
  const payload = { ...encodeReportForPersistence(built, { compactWrites: true, compactPositions }), selectiveCorpusAuthoritativeStatus: 'pending' };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_status, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [report.id, owner.deviceKey, report.submissionId, report.title, report.created, report.wordCount, 0, 'Low', 'processing', JSON.stringify(payload), owner.userId, null],
  });
}
const completedShadow = (ranges) => ({
  state: 'COMPLETED', evaluatorVersion: 'selective-corpus-shadow-v1', corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
  verifiedEvidence: ranges.length > 0 ? [{ sourceLabel: 'PMC-TEST-1', matchedPassages: ranges.map(([s, e]) => ({ submittedWordStart: s, submittedWordEnd: e, matchedWordCount: e - s + 1 })) }] : [],
});
const timeoutShadow = () => ({ state: 'TIMEOUT', evaluatorVersion: 'selective-corpus-shadow-v1', failureCode: 'TIMEOUT', failureMessage: 'time budget exceeded during Stage B verification', corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176 });
const finalize = (owner, id, shadowResult) => silently(() =>
  finalizeSelectiveCorpusAuthoritativeReport(client, { reportDeviceKey: owner.deviceKey, reportId: id, accountId: owner.userId, shadowResult, shadowScoringNormalizationVersion: 2 }));

let requests = 0;
/** POST /api/reports/[id]/ai-retry — the AI-result route (what the browser's AI save ends in when the whole report does not fit). */
async function aiResult(owner, id, aiAnalysis, aiScore = 5) {
  requests += 1;
  const ip = `${owner.tag}-air-${requests}`;
  await resetRateForTest(ip);
  const res = await aiRetryRoute.POST(new Request(`http://localhost/api/reports/${id}/ai-retry`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` },
    body: JSON.stringify({ aiStatus: 'ready', aiScore, aiTone: 'low', payload: { aiScore, aiAnalysis } }),
  }), { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200);
  return (await res.json()).aiOutcome ?? 'stored';
}
/** POST /api/reports — the browser's whole-report AI save. */
async function saveAi(owner, report, aiAnalysis, aiScore = 5) {
  requests += 1;
  const ip = `${owner.tag}-post-${requests}`;
  await resetRateForTest(ip);
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` },
    body: JSON.stringify({
      deviceKey: owner.deviceKey, id: report.id, submissionId: report.submissionId, title: report.title, createdAt: report.created,
      wordCount: report.wordCount, archiveScore: 0, scoreBand: 'Low', aiScore, aiTone: 'low', aiStatus: 'ready', scoringNormalization: 2, academicSearchDiagnosticsId: null,
      payload: { ...report, aiScore, aiAnalysis },
    }),
  }));
  return res.status;
}
async function row(owner, id) {
  const r = (await client.execute({ sql: 'SELECT payload_json, ai_status, ai_score, ai_tone FROM saved_reports WHERE device_key = ? AND id = ?', args: [owner.deviceKey, id] })).rows[0];
  const json = String(r.payload_json);
  const raw = JSON.parse(json);
  return { json, raw, report: decodeReportFromPersistence(JSON.parse(json)), aiStatus: r.ai_status, aiScore: r.ai_score === null ? null : Number(r.ai_score), aiTone: r.ai_tone };
}
async function getAsOwner(owner, id) {
  requests += 1;
  await resetReadRateForTest(`${owner.tag}-get-${requests}`);
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(owner.deviceKey)}`, { headers: { 'x-forwarded-for': `${owner.tag}-get-${requests}`, cookie: `tp_session_v1=${owner.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  assert.equal(res.status, 200);
  return (await res.json()).payload;
}
/** The report a reader gets: everything but identity, the timestamps and the volatile claim. */
async function semantic(owner, id) {
  const r = await row(owner, id);
  const served = await getAsOwner(owner, id);
  const { id: _i, submissionId: _s, created: _c, ...servedRest } = served;
  return {
    status: r.raw.selectiveCorpusAuthoritativeStatus, reason: r.raw.selectiveCorpusAuthoritativeIncompleteReason ?? null,
    timedOutAttempts: r.raw.selectiveCorpusAuthoritativeTimedOutAttempts ?? null, failed: r.raw.unifiedSimilarityFailed ?? null,
    unifiedSimilarity: r.report.unifiedSimilarity ?? null, evidenceInterpretation: r.report.evidenceInterpretation ?? null, reportCompletion: r.report.reportCompletion ?? null,
    archive: r.report.archiveMatchedPositions ?? null,
    ai: { status: r.aiStatus, score: r.aiScore, tone: r.aiTone, analysis: r.raw.aiAnalysis ?? null, payloadAiScore: r.raw.aiScore ?? null },
    served: servedRest,
  };
}
/** Same report, both orders: the full semantic state is identical. */
function assertSameReport(aiFirst, finalizerFirst, label) {
  for (const key of Object.keys(finalizerFirst)) assert.deepEqual(aiFirst[key], finalizerFirst[key], `${label}: ${key} is the same in either order`);
}
const aiWith = (pad) => ({ ...completeAiAnalysis(), passages: [{ text: 'a'.repeat(pad) }] });

/**
 * The twin pair: two identical pending reports (same text, same evidence), one per account. FINALIZER-FIRST is finalized and
 * then gets `aiAnalysis` through the AI-result route; AI-FIRST gets it first, then is finalized. Returns both semantic states.
 */
async function twins(name, text, shadow, aiFor, { compactPositions = false, finalizerGate = undefined } = {}) {
  const owners = { ff: await signUp(), af: await signUp() };
  const reports = { ff: localReport(`${name}-ff`, text), af: localReport(`${name}-af`, text) };
  await withEnv({ REPORT_COMPACT_POSITIONS_WRITE_ENABLED: compactPositions ? 'true' : undefined }, async () => {
    await seedPending(owners.ff, reports.ff, { compactPositions });
    await seedPending(owners.af, reports.af, { compactPositions });
  });
  const gate = { REPORT_COMPACT_POSITIONS_WRITE_ENABLED: (finalizerGate ?? compactPositions) ? 'true' : undefined };
  const ffOutcome = await withEnv(gate, () => finalize(owners.ff, reports.ff.id, shadow));
  const aiAnalysis = aiFor(await row(owners.ff, reports.ff.id), await row(owners.af, reports.af.id));
  const ffAi = await aiResult(owners.ff, reports.ff.id, aiAnalysis);
  const afAi = await aiResult(owners.af, reports.af.id, aiAnalysis);
  const afPending = await row(owners.af, reports.af.id);
  const afOutcome = await withEnv(gate, () => finalize(owners.af, reports.af.id, shadow));
  return {
    owners, reports, ffOutcome, afOutcome, ffAi, afAi, afPending,
    ff: await semantic(owners.ff, reports.ff.id), af: await semantic(owners.af, reports.af.id),
  };
}

// ===========================================================================

test('1. combined fits: the AI result stored while pending stays ready beside the final similarity — the same report as finalizer-first', async () => {
  const pair = await twins('aif-fits', words(3000, 101), completedShadow([[100, 399]]), () => completeAiAnalysis());
  assert.equal(pair.afAi, 'stored');
  assert.deepEqual([pair.afPending.aiStatus, pair.afPending.raw.selectiveCorpusAuthoritativeStatus], ['ready', 'pending'], 'test setup: AI first, report still pending');
  assert.deepEqual(pair.afOutcome, { outcome: 'finalized', status: 'completed' });
  assert.equal(pair.af.unifiedSimilarity.unifiedScore, 10);
  assert.deepEqual(pair.af.unifiedSimilarity.selectiveCorpusPositions, range(100, 399));
  assert.equal(pair.af.ai.status, 'ready');
  assert.equal(pair.af.ai.analysis.status, 'complete');
  assertSameReport(pair.af, pair.ff, 'fits');
});

test('2. combined too large ONLY because of the AI result (persistence ceiling, positions as arrays): the similarity is finalized and the AI half becomes "AI unavailable" (REPORT_SIZE) — the same report as finalizer-first', async () => {
  const pair = await twins('aif-ceiling', words(3000, 102), completedShadow([[100, 2899]]), (finalized, pending) => {
    // fits beside the pending row, not beside the final similarity
    const room = MAX_REPORT_SAVE_REQUEST_BYTES - persistedPayloadSize(pending.json);
    const pad = room - 2_000;
    assert.ok(persistedPayloadSize(finalized.json) + pad > MAX_REPORT_SAVE_REQUEST_BYTES, 'test setup: over the ceiling beside the final similarity');
    return aiWith(pad);
  });
  assert.equal(pair.afAi, 'stored', 'test setup: the AI result fits beside the pending row');
  assert.equal(pair.ffAi, 'SIZE_UNAVAILABLE', 'finalizer-first: the AI-result route settles it');
  assert.deepEqual(pair.afOutcome, { outcome: 'finalized', status: 'completed' }, 'AI-first: finalized, not PERSISTENCE_LIMIT');
  assert.equal(pair.af.unifiedSimilarity.unifiedScore, 93);
  assert.deepEqual(pair.af.ai, { status: 'failed', score: null, tone: 'unavailable', analysis: buildSizeUnavailableAiAnalysis(), payloadAiScore: null });
  assert.ok(persistedPayloadSize((await row(pair.owners.af, pair.reports.af.id)).json) <= MAX_REPORT_SAVE_REQUEST_BYTES);
  assertSameReport(pair.af, pair.ff, 'ceiling');
});

test('3. combined too large ONLY because of the AI result (serving bound, positions as ranges): the similarity is finalized, AI unavailable, and the report is served within the bound — the same report as finalizer-first', async () => {
  const n = 150_000;
  const pair = await twins('aif-served', twoLetterText(n), completedShadow([[0, n - 1]]), (finalized) => {
    const pad = MAX_SERVED_REPORT_BYTES - servedReportBytes(finalized.report) + 10_000;
    return aiWith(pad);
  }, { compactPositions: true });
  assert.equal(pair.afAi, 'stored', 'test setup: the AI result fits beside the pending row');
  assert.equal(pair.ffAi, 'SIZE_UNAVAILABLE');
  assert.deepEqual(pair.afOutcome, { outcome: 'finalized', status: 'completed' });
  const stored = await row(pair.owners.af, pair.reports.af.id);
  assert.ok(isCompactPositions(stored.raw.unifiedSimilarity.matchedPositions), 'stored as ranges');
  assert.equal(stored.report.unifiedSimilarity.matchedPositions.length, n);
  assert.ok(servedReportBytes(stored.report) <= MAX_SERVED_REPORT_BYTES + 1_024, 'served within the bound (plus the marker)');
  assert.equal(pair.af.ai.status, 'failed');
  assert.equal(pair.af.ai.analysis.unavailableReason, 'REPORT_SIZE');
  assertSameReport(pair.af, pair.ff, 'served');
});

test('4. the similarity cannot fit on its own: PERSISTENCE_LIMIT, no score, in either order — an AI result is never why', async () => {
  const n = 200_000;
  const pair = await twins('aif-limit', twoLetterText(n), completedShadow([[0, n - 1]]), () => completeAiAnalysis(), { compactPositions: true });
  assert.deepEqual(pair.ffOutcome, { outcome: 'persistence-limit-exceeded', status: 'incomplete' });
  assert.deepEqual(pair.afOutcome, { outcome: 'persistence-limit-exceeded', status: 'incomplete' });
  assert.equal(pair.af.unifiedSimilarity, null);
  assert.deepEqual([pair.af.status, pair.af.reason, pair.af.failed], ['incomplete', 'PERSISTENCE_LIMIT', true]);
  assertSameReport(pair.af, pair.ff, 'limit');
});

test('5. Selective timeout -> pending -> the browser AI save -> the recovery sweep: the similarity is finalized and kept, the retry state is the timeout\'s, AI unavailable when it cannot fit', async () => {
  const owner = await signUp();
  const report = localReport('aif-sweep', words(3000, 105));
  await seedPending(owner, report);
  assert.deepEqual(await finalize(owner, report.id, timeoutShadow()), { outcome: 'timeout-retry-scheduled', timedOutAttempts: 1 });
  const pending = await row(owner, report.id);
  const pad = MAX_REPORT_SAVE_REQUEST_BYTES - persistedPayloadSize(pending.json) - 2_000;
  assert.equal(await saveAi(owner, report, aiWith(pad)), 200, 'the browser AI save lands while the report is pending');
  const withAi = await row(owner, report.id);
  assert.deepEqual([withAi.raw.selectiveCorpusAuthoritativeStatus, withAi.aiStatus, withAi.raw.unifiedSimilarity ?? null], ['pending', 'ready', null], 'test setup: AI stored, still pending, no score');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const claimed = await claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection, minAgeMs: 1000, staleClaimMs: 1000 });
  assert.ok(claimed.some((entry) => String(entry.reportId) === report.id), 'the sweep takes the pending report');
  assert.deepEqual(await finalize(owner, report.id, completedShadow([[100, 2899]])), { outcome: 'finalized', status: 'completed' });
  const after = await row(owner, report.id);
  assert.equal(after.report.unifiedSimilarity.unifiedScore, 93, 'the similarity is finalized');
  assert.equal(after.raw.selectiveCorpusAuthoritativeTimedOutAttempts, 1, 'the retry state is the timeout\'s');
  assert.equal(after.raw.selectiveCorpusAuthoritativeClaimedAt, undefined, 'the claim is released');
  assert.deepEqual([after.aiStatus, after.aiScore, after.aiTone, after.raw.aiAnalysis.unavailableReason], ['failed', null, 'unavailable', 'REPORT_SIZE']);
  const seen = await getAsOwner(owner, report.id);
  assert.equal(seen.unifiedSimilarity.unifiedScore, 93);
  assert.equal(seen.reportCompletion.state, 'COMPLETED');
});

test('6. an old pending row (positions as arrays) finalized with ranges ON, AI first and too large beside the final similarity: the same report as finalizer-first', async () => {
  const pair = await twins('aif-arrays', words(3000, 106), completedShadow([[100, 2899]]), (finalized, pending) => {
    // halfway between the pending row and the finalized one: fits beside the first, not beside the second
    const pendingSize = persistedPayloadSize(pending.json), finalizedSize = persistedPayloadSize(finalized.json);
    assert.ok(finalizedSize - pendingSize > 400, 'test setup: finalizing grows the row');
    return aiWith(MAX_REPORT_SAVE_REQUEST_BYTES - Math.round((pendingSize + finalizedSize) / 2) - JSON.stringify(aiWith(0)).length);
  }, { compactPositions: false, finalizerGate: true });
  assert.equal(pair.afAi, 'stored', 'test setup: the AI result fits beside the pending row');
  assert.equal(pair.ffAi, 'SIZE_UNAVAILABLE');
  assert.deepEqual(pair.afOutcome, { outcome: 'finalized', status: 'completed' });
  const stored = await row(pair.owners.af, pair.reports.af.id);
  assert.ok(isCompactPositions(stored.raw.unifiedSimilarity.matchedPositions), 'finalized as ranges');
  assert.equal(pair.af.unifiedSimilarity.unifiedScore, 93);
  assert.equal(pair.af.ai.analysis.unavailableReason, 'REPORT_SIZE');
  assertSameReport(pair.af, pair.ff, 'arrays');
});

test('7. a row that changes between the measurement and the write is left alone (compare-and-swap on the exact text): still pending, nothing written, the sweep takes it again', async () => {
  const owner = await signUp();
  const report = localReport('aif-race', words(3000, 107));
  await seedPending(owner, report);
  assert.equal(await aiResult(owner, report.id, completeAiAnalysis()), 'stored');
  // a later AI save lands while the finalizer is deciding: injected right after its preview of the row it would write
  const clientClass = Object.getPrototypeOf(client);
  const realExecute = clientClass.execute;
  let injected = false;
  clientClass.execute = function execute(stmt, args) {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    const result = realExecute.call(this, stmt, args);
    if (!injected && /AS next FROM saved_reports/.test(sql)) {
      injected = true;
      return result.then(async (value) => {
        await realExecute.call(client, { sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.aiScore', 7), ai_score = 7 WHERE device_key = ? AND id = ?", args: [owner.deviceKey, report.id] });
        return value;
      });
    }
    return result;
  };
  let outcome;
  try {
    outcome = await finalize(owner, report.id, completedShadow([[100, 399]]));
  } finally {
    clientClass.execute = realExecute;
  }
  assert.ok(injected, 'test setup: the finalizer previewed the row');
  assert.deepEqual(outcome, { outcome: 'stale-attempt' });
  const after = await row(owner, report.id);
  assert.equal(after.raw.selectiveCorpusAuthoritativeStatus, 'pending');
  assert.equal(after.raw.unifiedSimilarity, undefined, 'no score written over the newer row');
  assert.equal(after.aiScore, 7, 'the concurrent AI save is intact');
  assert.deepEqual(await finalize(owner, report.id, completedShadow([[100, 399]])), { outcome: 'finalized', status: 'completed' }, 'the next attempt finalizes it');
});

test('8. a pending row whose AI half is already "AI unavailable" is finalized the ordinary way, the state kept', async () => {
  const owner = await signUp();
  const report = localReport('aif-marked', words(3000, 108));
  await seedPending(owner, report);
  await client.execute({
    sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.aiAnalysis', json(?), '$.aiScore', json('null')), ai_status = 'failed', ai_score = NULL, ai_tone = 'unavailable' WHERE device_key = ? AND id = ?",
    args: [JSON.stringify(buildSizeUnavailableAiAnalysis()), owner.deviceKey, report.id],
  });
  assert.deepEqual(await finalize(owner, report.id, completedShadow([[100, 399]])), { outcome: 'finalized', status: 'completed' });
  const after = await row(owner, report.id);
  assert.equal(after.report.unifiedSimilarity.unifiedScore, 10);
  assert.deepEqual([after.aiStatus, after.raw.aiAnalysis.unavailableReason], ['failed', 'REPORT_SIZE']);
});
