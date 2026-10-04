import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';
import { tokens } from '../lib/similarity-core.ts';
import { createDocumentIdentity } from '../lib/document-identity.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { resolveReportCompletion, unknownExtractionDiagnostic } from '../lib/evidence-interpretation/index.ts';
import { refreshSelectiveCorpusCompletionSignal, withEvidenceInterpretation } from '../lib/report-evidence-interpretation.ts';
import { resolveCompletionView } from '../lib/report-v2-view.ts';
import { stripServerInternalReportFields } from '../lib/report-types.ts';
import { finalizeSelectiveCorpusAuthoritativeReport, MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS } from '../lib/selective-corpus-authoritative.ts';

/**
 * REPORT COMPLETION — every channel keeps its own signal, and no channel erases
 * another's. The previous-submission check (reportCompletion.signals.
 * priorSubmission) and the per-channel completion diagnostics
 * (reportCompletion.diagnostics) were built independently; this file pins how
 * they compose:
 *   - one PARTIAL channel -> PARTIAL; several -> PARTIAL with every channel's
 *     signal and diagnostic kept; all complete -> COMPLETED;
 *   - a partial previous-submission check has its own admin diagnostic
 *     (PRIOR_SUBMISSION · NOT_RECORDED: the report stores that the check was
 *     partial, not why) and never replaces a Selective Corpus reason;
 *   - an authoritative Selective Corpus report is persisted while pending with
 *     no previous-submission result, so the deferred finalizer records the
 *     signal of the check its final score was resolved with — in the same
 *     atomic write as the terminal status — instead of leaving it null forever.
 * Status propagation only: no score, position or interpretation changes here.
 * Every corpus is synthetic.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_completion_channel_composition.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

// ===========================================================================
// pure composition
// ===========================================================================

const ALL_COMPLETE = {
  academicSearch: 'COMPLETE_NO_MATCHES',
  selectiveCorpus: 'COMPLETED',
  userSuppliedReference: 'COMPLETE',
  priorSubmission: 'COMPLETE',
  extraction: { completeness: 'COMPLETE', analyzableWordCount: 600, skipped: null, extractor: null },
  verifiedSimilarityPercent: 20,
};
/** Each channel's PARTIAL input, the signal it leaves, and the diagnostic it must produce. */
const PARTIAL_CHANNELS = {
  academic: { input: { academicSearch: 'FAILED', academicSearchFailureReason: 'RATE_LIMITED' }, signal: ['academicSearch', 'FAILED'], diagnostic: { channel: 'LIVE_ACADEMIC_SEARCH', reason: 'RATE_LIMITED' } },
  selective: { input: { selectiveCorpus: 'PARTIAL', selectiveCorpusIncompleteReason: 'TIMEOUT' }, signal: ['selectiveCorpus', 'PARTIAL'], diagnostic: { channel: 'SELECTIVE_CORPUS', reason: 'TIMEOUT' } },
  references: { input: { userSuppliedReference: 'PARTIAL' }, signal: ['userSuppliedReference', 'PARTIAL'], diagnostic: { channel: 'USER_SUPPLIED_REFERENCES', reason: 'REFERENCE_FILE_UNREADABLE' } },
  prior: { input: { priorSubmission: 'PARTIAL' }, signal: ['priorSubmission', 'PARTIAL'], diagnostic: { channel: 'PRIOR_SUBMISSION', reason: 'NOT_RECORDED' } },
};
const ORDER = ['academic', 'selective', 'references', 'prior'];
function subsets(items) {
  const out = [];
  for (let mask = 1; mask < 1 << items.length; mask += 1) out.push(items.filter((_, i) => mask & (1 << i)));
  return out;
}

test('all channels complete -> COMPLETED, no diagnostics, every signal kept', () => {
  const c = resolveReportCompletion(ALL_COMPLETE);
  assert.equal(c.state, 'COMPLETED');
  assert.deepEqual(c.diagnostics, []);
  assert.deepEqual(c.signals, {
    academicSearch: 'COMPLETE_NO_MATCHES', selectiveCorpus: 'COMPLETED', extraction: 'COMPLETE',
    unverifiedCandidateCount: 0, userSuppliedReference: 'COMPLETE', priorSubmission: 'COMPLETE',
  });
});

test('every combination of PARTIAL channels -> PARTIAL, each channel keeps its own signal and its own diagnostic, in a fixed order', () => {
  for (const partial of subsets(ORDER)) {
    const input = { ...ALL_COMPLETE };
    for (const name of partial) Object.assign(input, PARTIAL_CHANNELS[name].input);
    const c = resolveReportCompletion(input);
    const label = partial.join('+');
    assert.equal(c.state, 'PARTIAL', label);
    assert.equal(c.detail, 'The 20% shown is a verified lower bound. Completed searches still produced valid evidence; sources we could not reach are not counted.', label);
    for (const name of ORDER) {
      const [key, value] = PARTIAL_CHANNELS[name].signal;
      assert.equal(c.signals[key], partial.includes(name) ? value : ALL_COMPLETE[key], `${label}: ${key}`);
    }
    assert.deepEqual(c.diagnostics, partial.map((name) => PARTIAL_CHANNELS[name].diagnostic), label);
  }
});

test('a partial previous-submission check never replaces a Selective Corpus TIMEOUT reason', () => {
  const c = resolveReportCompletion({ ...ALL_COMPLETE, selectiveCorpus: 'PARTIAL', selectiveCorpusIncompleteReason: 'TIMEOUT', priorSubmission: 'PARTIAL' });
  assert.deepEqual(c.diagnostics, [
    { channel: 'SELECTIVE_CORPUS', reason: 'TIMEOUT' },
    { channel: 'PRIOR_SUBMISSION', reason: 'NOT_RECORDED' },
  ]);
  assert.ok(c.reasons.includes('part of the TurnitPlus reference index was unavailable at search time'));
  assert.ok(c.reasons.includes('the previous-submission check could not examine every candidate'));
});

test('unread document content still outranks every partial search, and keeps every channel diagnostic', () => {
  const c = resolveReportCompletion({
    ...ALL_COMPLETE, priorSubmission: 'PARTIAL', selectiveCorpus: 'PARTIAL', selectiveCorpusIncompleteReason: 'TIMEOUT',
    extraction: { completeness: 'PARTIAL', analyzableWordCount: 500, skipped: { unit: 'pages', count: 1 }, extractor: null },
  });
  assert.equal(c.state, 'EXTRACTION_PARTIAL');
  assert.deepEqual(c.diagnostics.map((d) => d.channel), ['DOCUMENT_EXTRACTION', 'SELECTIVE_CORPUS', 'PRIOR_SUBMISSION']);
});

test('the response-time Selective refresh keeps the previous-submission signal and diagnostic beside the Selective reason', () => {
  // What the finalizer leaves: the pending-save completion with the prior signal recorded, plus the terminal marker.
  const pendingCompletion = resolveReportCompletion({ priorSubmission: 'PARTIAL', verifiedSimilarityPercent: 20, extraction: unknownExtractionDiagnostic() });
  for (const [status, reason, expected] of [
    ['incomplete', 'TIMEOUT', [{ channel: 'SELECTIVE_CORPUS', reason: 'TIMEOUT' }, { channel: 'PRIOR_SUBMISSION', reason: 'NOT_RECORDED' }]],
    ['completed', undefined, [{ channel: 'PRIOR_SUBMISSION', reason: 'NOT_RECORDED' }]],
  ]) {
    const report = {
      wordCount: 600, score: 0, archiveScore: 0, sources: [], repeats: [], text: '',
      selectiveCorpusAuthoritativeStatus: status,
      ...(reason ? { selectiveCorpusAuthoritativeIncompleteReason: reason } : {}),
      reportCompletion: structuredClone(pendingCompletion),
    };
    refreshSelectiveCorpusCompletionSignal(report);
    assert.equal(report.reportCompletion.state, 'PARTIAL', status);
    assert.equal(report.reportCompletion.signals.priorSubmission, 'PARTIAL', status);
    assert.equal(report.reportCompletion.signals.selectiveCorpus, status === 'completed' ? 'COMPLETED' : 'PARTIAL', status);
    assert.deepEqual(report.reportCompletion.diagnostics, expected, status);

    const ordinary = structuredClone(report);
    stripServerInternalReportFields(ordinary);
    assert.equal('diagnostics' in ordinary.reportCompletion, false, `${status}: an ordinary viewer gets no channel/reason codes`);
    assert.equal(ordinary.selectiveCorpusAuthoritativeIncompleteReason, undefined);
    assert.equal(ordinary.reportCompletion.state, 'PARTIAL');
    assert.doesNotMatch(JSON.stringify(ordinary.reportCompletion), /NOT_RECORDED|TIMEOUT|PRIOR_SUBMISSION|SELECTIVE_CORPUS/);
    const admin = structuredClone(report);
    stripServerInternalReportFields(admin, { viewerIsAdmin: true });
    assert.deepEqual(admin.reportCompletion.diagnostics, expected, `${status}: an admin keeps them`);
  }
});

test('a completion persisted without diagnostics derives the previous-submission diagnostic from its signals', () => {
  const { diagnostics: _none, ...persisted } = resolveReportCompletion({ priorSubmission: 'PARTIAL', selectiveCorpus: 'PARTIAL', verifiedSimilarityPercent: 20, extraction: unknownExtractionDiagnostic() });
  const view = resolveCompletionView(persisted, undefined, 20);
  assert.equal(view.state, 'PARTIAL');
  assert.deepEqual(view.diagnostics, [
    { channel: 'SELECTIVE_CORPUS', reason: 'NOT_RECORDED' },
    { channel: 'PRIOR_SUBMISSION', reason: 'NOT_RECORDED' },
  ]);
});

// ===========================================================================
// the authoritative Selective Corpus finalizer records the previous-submission signal
// ===========================================================================

const SYLLABLES = ['ka', 'lo', 'mi', 'tre', 'vun', 'sor', 'bel', 'dra', 'phi', 'quen', 'zor', 'tal', 'mer', 'nix', 'ost', 'ula', 'rin', 'vek', 'dom', 'sha', 'gri', 'pol', 'wex', 'yun'];
function words(count, seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length]);
  return out.join(' ');
}
async function index(accountId, rawText) {
  await client.execute({ sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [accountId, `${accountId}@example.test`, accountId, 'x'] });
  const identity = await createDocumentIdentity(client, { accountId, title: 't', author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  const row = await client.execute({ sql: 'SELECT representation_id FROM corpus_submission_references WHERE document_identity_id = ?', args: [identity.id] });
  return String(row.rows[0].representation_id);
}
/** A 600-word submission whose 120-word passage two other accounts hold; prior PARTIAL = the second holder is over the per-candidate size limit, so it is discovered but never verified. */
async function priorFixture(seed, prior) {
  const passage = words(120, seed * 101 + 1);
  const submission = `${words(200, seed * 101 + 2)} ${passage} ${words(280, seed * 101 + 3)}`;
  await index(`cc-other-${seed}`, `${words(250, seed * 101 + 4)} ${passage} ${words(250, seed * 101 + 5)}`);
  const second = await index(`cc-second-${seed}`, `${words(300, seed * 101 + 6)} ${passage} ${words(300, seed * 101 + 7)}`);
  await matureCorpusBackings(client);
  if (prior === 'PARTIAL') await client.execute({ sql: 'UPDATE corpus_document_representations SET word_count = 999999 WHERE id = ?', args: [second] });
  return { submission, wordCount: tokens(submission).length };
}

let accounts = 0;
async function signUpOwner({ admin = false } = {}) {
  accounts += 1;
  const tag = `cc-signup-${accounts}`, email = `cc-owner-${accounts}@example.test`, deviceKey = `cc-device-${accounts}`;
  await resetAuthRateForTest(tag);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': tag },
    body: JSON.stringify(withTestIdentity({ email, password: 'cc-owner-pw-1', username: `ccowner${accounts}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = (res.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)[1];
  const userId = String((await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  if (admin) await client.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [userId] });
  return { userId, deviceKey, cookie, tag: `cc-${accounts}` };
}

/** The row an authoritative-pending first save persists: completion built with no historical match and no Selective branch. */
async function seedPending(owner, id, fx, { reportCompletion } = {}) {
  const built = withEvidenceInterpretation({
    version: 11, id: 1, submissionId: 'sub-' + id, title: 'Completion composition', text: fx.submission, wordCount: fx.wordCount,
    score: 0, archiveScore: 0, scoreBand: 'Low', matchedWordCount: 0, archiveMatchedPositions: [], sources: [], repeats: [],
  }, { selectiveCorpusBranch: null });
  const payload = { ...built, selectiveCorpusAuthoritativeStatus: 'pending' };
  if (reportCompletion === 'absent') delete payload.reportCompletion;
  if (reportCompletion === 'without-prior-key') delete payload.reportCompletion.signals.priorSubmission;
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, owner.deviceKey, 'sub-' + id, 'Completion composition', new Date(Date.now() - 20 * 60 * 1000).toISOString(), fx.wordCount, 0, 'Low', JSON.stringify(payload), owner.userId, null],
  });
}
async function stored(owner, id) {
  const r = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [owner.deviceKey, id] });
  return JSON.parse(String(r.rows[0].payload_json));
}
async function getAsOwner(owner, id) {
  await resetReadRateForTest(owner.tag + '-get');
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(owner.deviceKey)}`, { headers: { 'x-forwarded-for': owner.tag + '-get', cookie: `tp_session_v1=${owner.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  assert.equal(res.status, 200);
  return (await res.json()).payload;
}
const EVALUATOR_VERSION = 'selective-corpus-shadow-v1';
const timeoutResult = () => ({
  state: 'TIMEOUT', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'TIMEOUT', failureMessage: 'time budget exceeded during Stage B verification',
  corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176, runtimeStageAMs: 2828.64, queryFingerprintsRawCount: 1312, queryFingerprintsTrimmed: false,
});
const completedResult = () => ({
  state: 'COMPLETED', evaluatorVersion: EVALUATOR_VERSION, corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
  candidateCount: 30, topCandidateRanks: [], stageATruncated: false, verifiedSourceCount: 0, matchedPositionCount: 0,
  counterfactualUnifiedSimilarity: 0, authoritativeUnifiedSimilarity: null, deltaVsAuthoritative: 0,
  runtimeStageAMs: 2346.34, runtimeStageBMs: 3549.16, familyGuardActivations: 0, coSourceAttributionActivations: 0,
});
const finalize = (owner, id, shadowResult) =>
  finalizeSelectiveCorpusAuthoritativeReport(client, { reportDeviceKey: owner.deviceKey, reportId: id, accountId: owner.userId, shadowResult });

test('finalizer: Selective COMPLETED + a partial previous-submission check -> the report reads PARTIAL, not COMPLETED', async () => {
  const owner = await signUpOwner();
  const fx = await priorFixture(41, 'PARTIAL');
  const id = 'cc-s1';
  await seedPending(owner, id, fx);
  assert.equal((await stored(owner, id)).reportCompletion.signals.priorSubmission, null, 'test setup sanity: the pending save claims no previous-submission result');
  assert.equal((await finalize(owner, id, completedResult())).outcome, 'finalized');
  const row = await stored(owner, id);
  assert.equal(row.selectiveCorpusAuthoritativeStatus, 'completed');
  assert.equal(row.reportCompletion.signals.priorSubmission, 'PARTIAL', 'recorded by the terminal write');
  assert.equal(row.unifiedSimilarity.unifiedScore, 20, 'the verified source still scores; the signal changes nothing else');
  const payload = await getAsOwner(owner, id);
  assert.equal(payload.reportCompletion.state, 'PARTIAL');
  assert.equal(payload.reportCompletion.signals.selectiveCorpus, 'COMPLETED');
  assert.equal(payload.reportCompletion.signals.priorSubmission, 'PARTIAL');
  assert.equal(payload.reportCompletion.detail, 'The 20% shown is a verified lower bound. Completed searches still produced valid evidence; sources we could not reach are not counted.');
  assert.equal('diagnostics' in payload.reportCompletion, false, 'ordinary viewer');
});

test('finalizer: a first Selective TIMEOUT stays pending and writes no completion signal; a successful retry then records the previous-submission signal', async () => {
  const owner = await signUpOwner();
  const fx = await priorFixture(42, 'PARTIAL');
  const id = 'cc-s2';
  await seedPending(owner, id, fx);
  assert.deepEqual(await finalize(owner, id, timeoutResult()), { outcome: 'timeout-retry-scheduled', timedOutAttempts: 1 });
  let row = await stored(owner, id);
  assert.equal(row.selectiveCorpusAuthoritativeStatus, 'pending', 'retryable, not terminal');
  assert.equal(row.unifiedSimilarity, undefined, 'no score while pending');
  assert.equal(row.reportCompletion.signals.priorSubmission, null, 'nothing recorded by a non-terminal attempt');

  assert.equal((await finalize(owner, id, completedResult())).outcome, 'finalized');
  row = await stored(owner, id);
  assert.equal(row.selectiveCorpusAuthoritativeStatus, 'completed');
  assert.equal(row.selectiveCorpusAuthoritativeTimedOutAttempts, 1, 'the server-owned count is untouched by the terminal write');
  const payload = await getAsOwner(owner, id);
  assert.equal(payload.reportCompletion.state, 'PARTIAL', 'the previous-submission check is still partial');
  assert.equal(payload.reportCompletion.signals.selectiveCorpus, 'COMPLETED');
  assert.equal(payload.reportCompletion.signals.priorSubmission, 'PARTIAL');
});

test('finalizer: five Selective TIMEOUTs + a partial previous-submission check -> PARTIAL with both channels; an admin sees TIMEOUT and the previous-submission diagnostic', async () => {
  const owner = await signUpOwner({ admin: true });
  const fx = await priorFixture(43, 'PARTIAL');
  const id = 'cc-s4';
  await seedPending(owner, id, fx);
  const outcomes = [];
  for (let i = 0; i < MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS; i += 1) outcomes.push((await finalize(owner, id, timeoutResult())).outcome);
  assert.deepEqual(outcomes, [...Array(MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS - 1).fill('timeout-retry-scheduled'), 'finalized']);
  const row = await stored(owner, id);
  assert.equal(row.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.equal(row.selectiveCorpusAuthoritativeIncompleteReason, 'TIMEOUT');
  assert.equal(row.reportCompletion.signals.priorSubmission, 'PARTIAL');
  const payload = await getAsOwner(owner, id);
  assert.equal(payload.reportCompletion.state, 'PARTIAL');
  assert.equal(payload.reportCompletion.signals.selectiveCorpus, 'PARTIAL');
  assert.equal(payload.reportCompletion.signals.priorSubmission, 'PARTIAL');
  assert.deepEqual(payload.reportCompletion.diagnostics, [
    { channel: 'SELECTIVE_CORPUS', reason: 'TIMEOUT' },
    { channel: 'PRIOR_SUBMISSION', reason: 'NOT_RECORDED' },
  ]);
});

test('finalizer: five Selective TIMEOUTs + a complete previous-submission check -> PARTIAL from the Selective channel alone', async () => {
  const owner = await signUpOwner({ admin: true });
  const fx = await priorFixture(44, 'COMPLETE');
  const id = 'cc-s5';
  await seedPending(owner, id, fx);
  for (let i = 0; i < MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS; i += 1) await finalize(owner, id, timeoutResult());
  const payload = await getAsOwner(owner, id);
  assert.equal(payload.reportCompletion.state, 'PARTIAL');
  assert.equal(payload.reportCompletion.signals.priorSubmission, 'COMPLETE');
  assert.deepEqual(payload.reportCompletion.diagnostics, [{ channel: 'SELECTIVE_CORPUS', reason: 'TIMEOUT' }]);
});

test('finalizer: Selective COMPLETED + a complete previous-submission check -> COMPLETED', async () => {
  const owner = await signUpOwner();
  const fx = await priorFixture(45, 'COMPLETE');
  const id = 'cc-s6';
  await seedPending(owner, id, fx);
  assert.equal((await finalize(owner, id, completedResult())).outcome, 'finalized');
  const payload = await getAsOwner(owner, id);
  assert.equal(payload.reportCompletion.state, 'COMPLETED');
  assert.equal(payload.reportCompletion.signals.selectiveCorpus, 'COMPLETED');
  assert.equal(payload.reportCompletion.signals.priorSubmission, 'COMPLETE');
});

test('finalizer: a report saved without a completion, or before the previous-submission signal existed, gets nothing invented', async () => {
  const owner = await signUpOwner();
  const fx = await priorFixture(46, 'PARTIAL');
  await seedPending(owner, 'cc-no-completion', fx, { reportCompletion: 'absent' });
  await seedPending(owner, 'cc-old-signals', fx, { reportCompletion: 'without-prior-key' });
  for (const id of ['cc-no-completion', 'cc-old-signals']) assert.equal((await finalize(owner, id, completedResult())).outcome, 'finalized', id);
  const noCompletion = await stored(owner, 'cc-no-completion');
  assert.equal(noCompletion.selectiveCorpusAuthoritativeStatus, 'completed');
  assert.equal('reportCompletion' in noCompletion, false, 'no partial reportCompletion object is created on a report that had none');
  const oldSignals = await stored(owner, 'cc-old-signals');
  assert.equal('priorSubmission' in oldSignals.reportCompletion.signals, false, 'an old-shaped completion is left as stored');
});

test('finalizer: a finalizer that lost the race writes no previous-submission signal over the winner', async () => {
  const owner = await signUpOwner();
  const fx = await priorFixture(47, 'PARTIAL');
  const id = 'cc-race';
  await seedPending(owner, id, fx);
  assert.equal((await finalize(owner, id, completedResult())).outcome, 'finalized');
  await client.execute({
    sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.reportCompletion.signals.priorSubmission', 'COMPLETE') WHERE device_key = ? AND id = ?",
    args: [owner.deviceKey, id],
  });
  assert.equal((await finalize(owner, id, timeoutResult())).outcome, 'not-pending');
  assert.equal((await stored(owner, id)).reportCompletion.signals.priorSubmission, 'COMPLETE', 'a terminal row is never touched again');
});
