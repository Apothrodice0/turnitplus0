import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { completeAiAnalysis } from './helpers/complete-ai-analysis.mjs';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { resetRateForTest, resetReadRateForTest, resetAuthRateForTest } from '../lib/rate-limit.ts';
import { tokens } from '../lib/similarity-core.ts';
import { canonicalizeText } from '../lib/canonical-text.ts';
import { resolvePersistedSimilarityDisplay } from '../lib/report-primary-similarity.ts';
import { stripServerInternalReportFields } from '../lib/report-types.ts';
import { refreshSelectiveCorpusCompletionSignal, withEvidenceInterpretation } from '../lib/report-evidence-interpretation.ts';
import {
  finalizeSelectiveCorpusAuthoritativeReport,
  claimStaleSelectiveCorpusAuthoritativePendingReports,
  MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS,
} from '../lib/selective-corpus-authoritative.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';

/**
 * SELECTIVE CORPUS — BOUNDED TIMEOUT RETRY. A Selective Corpus TIMEOUT is a
 * transient work-limit result (Production: the same report timed out on its
 * first save and completed 17 s later — 30 candidates, 0 verified), so it must
 * not finalize an authoritative-pending report as "incomplete" on the first
 * occurrence. With attempts left the report stays pending (existing
 * "Calculating similarity" state) and the existing recovery sweep retries it;
 * only MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS timed-out attempts make it
 * terminal "incomplete" with reason TIMEOUT. Every other state keeps its
 * semantics, and nothing here changes what verified evidence scores.
 *
 * Same harness shape as tests/selective-corpus-authoritative-lifecycle.test.mjs:
 * a real libsql file DB, seeded rows for exact lifecycle states, the REAL
 * finalizer/claim functions, and the REAL POST/GET route handlers.
 */

const repoRoot = path.resolve('.');
const drizzleDir = path.join(repoRoot, 'drizzle');
const dbFile = path.join(repoRoot, 'test_selective_corpus_timeout_retry.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const originalAuthoritativeFlag = process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
const originalShadowFlag = process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

function restoreFlags() {
  if (originalAuthoritativeFlag === undefined) delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
  else process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = originalAuthoritativeFlag;
  if (originalShadowFlag === undefined) delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  else process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = originalShadowFlag;
}

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  restoreFlags();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// fixtures + helpers
// ---------------------------------------------------------------------------

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;
const EVALUATOR_VERSION = 'selective-corpus-shadow-v1';
const MAX = MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS;
const openTestConnection = () => createClient({ url: `file:${dbFile}` });
const twentyMinutesAgo = () => new Date(Date.now() - 20 * 60 * 1000).toISOString();

/** 300 distinct words; 3 archive-verified positions = a 1% report, like submission 1036041427's own 1%. */
const BODY_TEXT = Array.from({ length: 300 }, (_, i) => `lexeme${i}`).join(' ');
const ARCHIVE_POSITIONS = [10, 11, 12];

async function seedPendingReport(deviceKey, id, { createdAt = new Date().toISOString(), payloadExtra = {}, userId = null } = {}) {
  const wordCount = tokens(canonicalizeText(BODY_TEXT)).length;
  // The pending row a real first save persists: its explanation and completion
  // are built at save time with no Selective Corpus branch (POST passes null).
  const payload = JSON.stringify({
    ...withEvidenceInterpretation({
      version: 11, id: 1, submissionId: 'sub-' + id, title: 'Timeout retry fixture',
      text: BODY_TEXT, wordCount, score: 1, archiveScore: 1, scoreBand: 'Low',
      matchedWordCount: ARCHIVE_POSITIONS.length, archiveMatchedPositions: ARCHIVE_POSITIONS,
      sources: [], repeats: [],
    }, { selectiveCorpusBranch: null }),
    selectiveCorpusAuthoritativeStatus: 'pending',
    ...payloadExtra,
  });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey, 'sub-' + id, 'Timeout retry fixture', createdAt, wordCount, 1, 'Low', payload, userId, null],
  });
  return { wordCount };
}

async function rawPayload(deviceKey, id) {
  const r = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, id] });
  return JSON.parse(String(r.rows[0].payload_json));
}

/** The Production pair for submission 1036041427: TIMEOUT after Stage A, then COMPLETED with 30 candidates and 0 verified. */
function timeoutShadowResult() {
  return {
    state: 'TIMEOUT', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'TIMEOUT', failureMessage: 'time budget exceeded during Stage B verification',
    corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
    runtimeStageAMs: 2828.64, queryFingerprintsRawCount: 1312, queryFingerprintsTrimmed: false,
  };
}
function completedShadowResult(verifiedEvidence = [], candidateCount = 30) {
  const matchedPositionCount = verifiedEvidence.reduce((n, s) => n + s.matchedPassages.reduce((m, p) => m + p.matchedWordCount, 0), 0);
  return {
    state: 'COMPLETED', evaluatorVersion: EVALUATOR_VERSION,
    corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
    candidateCount, topCandidateRanks: [], stageATruncated: false,
    verifiedSourceCount: verifiedEvidence.length, matchedPositionCount,
    ...(verifiedEvidence.length > 0 ? { verifiedEvidence } : {}),
    counterfactualUnifiedSimilarity: 1, authoritativeUnifiedSimilarity: null, deltaVsAuthoritative: 0,
    runtimeStageAMs: 2346.34, runtimeStageBMs: 3549.16, familyGuardActivations: 0, coSourceAttributionActivations: 0,
  };
}
function artifactUnavailableShadowResult() {
  return { state: 'ARTIFACT_UNAVAILABLE', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'WRONG_DIGEST', failureMessage: 'artifact digest mismatch' };
}
function failedShadowResult() {
  return { state: 'FAILED', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'UNEXPECTED', failureMessage: 'boom' };
}

const finalize = (deviceKey, id, shadowResult, db = client) =>
  finalizeSelectiveCorpusAuthoritativeReport(db, { reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult });

/**
 * A client whose ONE timed-out-attempt record UPDATE first lets `interfere`
 * run to completion against the real DB — a deterministic interleaving of two
 * finalizers that both read the row while it was pending.
 */
function interleavingClient(interfere) {
  let fired = false;
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'execute') {
        return async (stmt) => {
          const sql = typeof stmt === 'string' ? stmt : stmt.sql;
          if (!fired && /^\s*UPDATE saved_reports/i.test(sql) && sql.includes("'$.selectiveCorpusAuthoritativeTimedOutAttempts', ?")) {
            fired = true;
            await interfere();
          }
          return target.execute(stmt);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function displayOf(deviceKey, id) {
  const payload = await rawPayload(deviceKey, id);
  return resolvePersistedSimilarityDisplay(client, {
    reportDeviceKey: deviceKey, reportId: id, archiveScore: 1,
    unifiedScore: payload.unifiedSimilarity?.unifiedScore ?? null, hasUnifiedSimilarity: Boolean(payload.unifiedSimilarity),
    corpusSourceMatchingEnabledAtComputation: payload.corpusSourceMatchingEnabledAtComputation ?? null,
    unifiedSimilarityFailed: false, hasPositionEvidence: Array.isArray(payload.unifiedSimilarity?.matchedPositions),
  });
}

async function getAnonymous(deviceKey, id) {
  const tag = uniq('sc-timeout-get');
  await resetReadRateForTest(tag);
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}`, { headers: { 'x-forwarded-for': tag } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  assert.equal(res.status, 200);
  return (await res.json()).payload;
}

let userCounter = 0;
async function signUpAccount() {
  userCounter += 1;
  const tag = `sc-timeout-signup-${userCounter}`;
  const email = `sc-timeout-user-${userCounter}@example.test`;
  const deviceKey = `sc-timeout-device-${userCounter}`;
  await resetAuthRateForTest(tag);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': tag },
    body: JSON.stringify(withTestIdentity({ email, password: 'sc-timeout-pw-1', username: `sctimeout${userCounter}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'signup must succeed');
  const cookie = (res.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)?.[1] ?? null;
  return { deviceKey, cookie, tag: `sc-timeout-${userCounter}` };
}

async function postReport(account, id, { forgedPayloadFields } = {}) {
  const wordCount = tokens(canonicalizeText(BODY_TEXT)).length;
  await resetRateForTest(account.tag + '-post');
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post', ...(account.cookie ? { cookie: `tp_session_v1=${account.cookie}` } : {}) },
    body: JSON.stringify({
      deviceKey: account.deviceKey, id, submissionId: 'sub-' + id, title: 'Timeout retry fixture', createdAt: new Date().toISOString(),
      wordCount, archiveScore: 1, scoreBand: 'Low', aiScore: 3, aiTone: 'low', aiStatus: 'ready',
      payload: {
        version: 11, id: 1, submissionId: 'sub-' + id, title: 'Timeout retry fixture', author: '', assignment: '', created: new Date().toISOString(),
        score: 1, archiveScore: 1, wordCount, scoreBand: 'Low', matchedWordCount: ARCHIVE_POSITIONS.length, archiveMatchedPositions: ARCHIVE_POSITIONS,
        sources: [], repeats: [], text: BODY_TEXT, aiAnalysis: completeAiAnalysis(),
        ...(forgedPayloadFields ?? {}),
      },
      room: 0,
    }),
  }));
}

// ===========================================================================
// 1. first TIMEOUT is retryable, never terminal
// ===========================================================================

test('1. a first authoritative TIMEOUT leaves the report pending and retryable — no score, no PARTIAL, attempt recorded, claim released', async () => {
  const deviceKey = uniq('dk-to-1');
  const id = uniq('r-to-1');
  await seedPendingReport(deviceKey, id, { payloadExtra: { selectiveCorpusAuthoritativeClaimedAt: '2026-10-03 14:00:46' } });

  const result = await finalize(deviceKey, id, timeoutShadowResult());
  assert.deepEqual(result, { outcome: 'timeout-retry-scheduled', timedOutAttempts: 1 });

  const payload = await rawPayload(deviceKey, id);
  assert.equal(payload.selectiveCorpusAuthoritativeStatus, 'pending', 'still pending — a timeout is not a terminal result');
  assert.equal(payload.selectiveCorpusAuthoritativeTimedOutAttempts, 1);
  assert.equal('selectiveCorpusAuthoritativeClaimedAt' in payload, false, 'the claim is released so the next sweep run can retry it');
  assert.equal(payload.unifiedSimilarity, undefined, 'no final score is persisted');
  assert.equal(payload.selectiveCorpusAuthoritativeIncompleteReason, undefined, 'no terminal reason is persisted');
  assert.deepEqual(await displayOf(deviceKey, id), { status: 'pending' }, 'the existing pending ("Calculating similarity") state, not COMPLETED and not PARTIAL');

  const outbound = await getAnonymous(deviceKey, id);
  assert.notEqual(outbound.reportCompletion?.signals?.selectiveCorpus, 'PARTIAL', 'no PARTIAL completion signal while the retry is pending');
  for (const key of ['selectiveCorpusAuthoritativeTimedOutAttempts', 'selectiveCorpusAuthoritativeStatus', 'selectiveCorpusAuthoritativeClaimedAt']) {
    assert.equal(key in outbound, false, `${key} never leaves the server`);
  }
});

// ===========================================================================
// 2/3. the sweep's retry completes the report
// ===========================================================================

test('2. timeout, then the sweep retries and the retry completes with no verified evidence -> completed, never PARTIAL', async () => {
  const deviceKey = uniq('dk-to-2');
  const id = uniq('r-to-2');
  await seedPendingReport(deviceKey, id, { createdAt: twentyMinutesAgo() });
  assert.equal((await finalize(deviceKey, id, timeoutShadowResult())).outcome, 'timeout-retry-scheduled');

  const claimed = await claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection });
  assert.ok(claimed.some((c) => c.reportDeviceKey === deviceKey && c.reportId === id), 'the existing sweep claim picks up the retryable report');

  assert.deepEqual(await finalize(deviceKey, id, completedShadowResult([])), { outcome: 'finalized', status: 'completed' });
  const payload = await rawPayload(deviceKey, id);
  assert.equal(payload.selectiveCorpusAuthoritativeStatus, 'completed');
  assert.equal(payload.unifiedSimilarity.selectiveCorpusOnlyWords, 0, 'nothing verified, nothing added');
  assert.equal(payload.selectiveCorpusAuthoritativeIncompleteReason, undefined);
  assert.notEqual((await displayOf(deviceKey, id)).status, 'pending');
});

test('3. timeout, then a retry with verified evidence -> the verified evidence persists exactly as a first-attempt success would', async () => {
  const deviceKey = uniq('dk-to-3');
  const id = uniq('r-to-3');
  await seedPendingReport(deviceKey, id, { createdAt: twentyMinutesAgo() });
  const evidence = [{ sourceLabel: 'S1', matchedPassages: [{ submittedWordStart: 100, submittedWordEnd: 104, matchedWordCount: 5 }] }];

  assert.equal((await finalize(deviceKey, id, timeoutShadowResult())).outcome, 'timeout-retry-scheduled');
  assert.deepEqual(await finalize(deviceKey, id, completedShadowResult(evidence, 1)), { outcome: 'finalized', status: 'completed' });

  // control: the same report finalized by a first-attempt success
  const controlKey = uniq('dk-to-3c');
  const controlId = uniq('r-to-3c');
  await seedPendingReport(controlKey, controlId);
  await finalize(controlKey, controlId, completedShadowResult(evidence, 1));

  const retried = (await rawPayload(deviceKey, id)).unifiedSimilarity;
  const control = (await rawPayload(controlKey, controlId)).unifiedSimilarity;
  assert.ok(retried.selectiveCorpusOnlyWords > 0, 'verified Selective Corpus evidence persisted after the retry');
  assert.equal(retried.unifiedScore, control.unifiedScore);
  assert.deepEqual(retried.matchedPositions, control.matchedPositions);
  assert.equal(retried.selectiveCorpusOnlyWords, control.selectiveCorpusOnlyWords);
});

// ===========================================================================
// 4. bounded termination
// ===========================================================================

test(`4. repeated TIMEOUT until the bound (${MAX} attempts) -> terminal incomplete with reason TIMEOUT; admins see SELECTIVE_CORPUS · TIMEOUT, customers the concise PARTIAL copy`, async () => {
  const deviceKey = uniq('dk-to-4');
  const id = uniq('r-to-4');
  await seedPendingReport(deviceKey, id);

  for (let attempt = 1; attempt < MAX; attempt += 1) {
    assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult()), { outcome: 'timeout-retry-scheduled', timedOutAttempts: attempt });
    assert.equal((await rawPayload(deviceKey, id)).selectiveCorpusAuthoritativeStatus, 'pending');
  }
  assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult()), { outcome: 'finalized', status: 'incomplete' }, `the ${MAX}th timeout is terminal`);

  const payload = await rawPayload(deviceKey, id);
  assert.equal(payload.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.equal(payload.selectiveCorpusAuthoritativeIncompleteReason, 'TIMEOUT');
  assert.equal(payload.selectiveCorpusAuthoritativeTimedOutAttempts, MAX - 1, 'retries recorded; the last attempt finalized');
  assert.equal(payload.unifiedSimilarity.selectiveCorpusOnlyWords, 0, 'a timeout contributes nothing');
  assert.notEqual((await displayOf(deviceKey, id)).status, 'pending', 'never left pending past the bound');

  // and no further attempt reopens it
  assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult()), { outcome: 'not-pending' });

  // admin view: the same GET-time refresh + strip the route performs
  const admin = structuredClone(payload);
  refreshSelectiveCorpusCompletionSignal(admin);
  stripServerInternalReportFields(admin, { viewerIsAdmin: true });
  assert.equal(admin.reportCompletion.state, 'PARTIAL');
  assert.ok(admin.reportCompletion.diagnostics.some((d) => d.channel === 'SELECTIVE_CORPUS' && d.reason === 'TIMEOUT'));

  // customer view through the real GET route
  const outbound = await getAnonymous(deviceKey, id);
  assert.equal(outbound.reportCompletion.state, 'PARTIAL');
  assert.equal(outbound.reportCompletion.signals.selectiveCorpus, 'PARTIAL');
  assert.equal('diagnostics' in outbound.reportCompletion, false);
  assert.doesNotMatch(JSON.stringify(outbound.reportCompletion), /TIMEOUT/);
  assert.equal('selectiveCorpusAuthoritativeTimedOutAttempts' in outbound, false);
});

test('4b. a counter that is not a valid count is treated as exhausted — a corrupt value can never keep a report retrying', async () => {
  const deviceKey = uniq('dk-to-4b');
  const id = uniq('r-to-4b');
  await seedPendingReport(deviceKey, id, { payloadExtra: { selectiveCorpusAuthoritativeTimedOutAttempts: 'abc' } });
  assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult()), { outcome: 'finalized', status: 'incomplete' });
  assert.equal((await rawPayload(deviceKey, id)).selectiveCorpusAuthoritativeIncompleteReason, 'TIMEOUT');
});

// ===========================================================================
// 5/6. races
// ===========================================================================

test('5. a terminal COMPLETED is never overwritten by a later stale TIMEOUT (sequential and interleaved)', async () => {
  // sequential: the stale attempt sees a non-pending row
  const deviceKey = uniq('dk-to-5');
  const id = uniq('r-to-5');
  await seedPendingReport(deviceKey, id);
  assert.deepEqual(await finalize(deviceKey, id, completedShadowResult([])), { outcome: 'finalized', status: 'completed' });
  assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult()), { outcome: 'not-pending' });

  // interleaved: the TIMEOUT attempt read the row while pending, a COMPLETED finalizer commits first
  const raceKey = uniq('dk-to-5r');
  const raceId = uniq('r-to-5r');
  await seedPendingReport(raceKey, raceId);
  const racing = interleavingClient(async () => {
    assert.deepEqual(await finalize(raceKey, raceId, completedShadowResult([])), { outcome: 'finalized', status: 'completed' });
  });
  assert.deepEqual(await finalize(raceKey, raceId, timeoutShadowResult(), racing), { outcome: 'stale-attempt' });
  const payload = await rawPayload(raceKey, raceId);
  assert.equal(payload.selectiveCorpusAuthoritativeStatus, 'completed', 'the newer terminal success stands');
  assert.equal(payload.selectiveCorpusAuthoritativeTimedOutAttempts, undefined, 'the stale timeout recorded nothing');
});

test('6. duplicate finalizers recording the same timed-out attempt count it once; duplicate sweeps claim a retryable report once', async () => {
  const deviceKey = uniq('dk-to-6');
  const id = uniq('r-to-6');
  await seedPendingReport(deviceKey, id, { createdAt: twentyMinutesAgo() });
  const racing = interleavingClient(async () => {
    assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult()), { outcome: 'timeout-retry-scheduled', timedOutAttempts: 1 });
  });
  assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult(), racing), { outcome: 'stale-attempt' }, 'the second recorder of the same attempt is a no-op');
  assert.equal((await rawPayload(deviceKey, id)).selectiveCorpusAuthoritativeTimedOutAttempts, 1, 'counted exactly once');

  const [a, b] = await Promise.all([
    claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection }),
    claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection }),
  ]);
  const hits = [...a, ...b].filter((c) => c.reportDeviceKey === deviceKey && c.reportId === id).length;
  assert.equal(hits, 1, 'exactly one sweep owns the retry');
});

test('6b. a failure to record the timed-out attempt leaves the report pending and the attempt uncounted — never a terminal fallback', async () => {
  const deviceKey = uniq('dk-to-6b');
  const id = uniq('r-to-6b');
  await seedPendingReport(deviceKey, id);
  const failing = interleavingClient(async () => { throw new Error('simulated DB failure'); });
  assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult(), failing), { outcome: 'gave-up' });
  const payload = await rawPayload(deviceKey, id);
  assert.equal(payload.selectiveCorpusAuthoritativeStatus, 'pending');
  assert.equal(payload.selectiveCorpusAuthoritativeTimedOutAttempts, undefined);
  assert.equal(payload.selectiveCorpusAuthoritativeIncompleteReason, undefined, 'not turned into a FINALIZER_ERROR terminal');
});

// ===========================================================================
// 7/8. other states unchanged
// ===========================================================================

for (const [label, resultFn] of [['ARTIFACT_UNAVAILABLE', artifactUnavailableShadowResult], ['FAILED', failedShadowResult]]) {
  test(`7/8 (${label}): unchanged — the first occurrence is terminal incomplete with its own reason, no retry recorded`, async () => {
    const deviceKey = uniq(`dk-to-${label}`);
    const id = uniq(`r-to-${label}`);
    await seedPendingReport(deviceKey, id);
    assert.deepEqual(await finalize(deviceKey, id, resultFn()), { outcome: 'finalized', status: 'incomplete' });
    const payload = await rawPayload(deviceKey, id);
    assert.equal(payload.selectiveCorpusAuthoritativeIncompleteReason, label);
    assert.equal(payload.selectiveCorpusAuthoritativeTimedOutAttempts, undefined);
  });
}

// ===========================================================================
// 9. retry state alone never changes a score
// ===========================================================================

test('9. recording a timed-out attempt changes nothing but the retry bookkeeping', async () => {
  const deviceKey = uniq('dk-to-9');
  const id = uniq('r-to-9');
  await seedPendingReport(deviceKey, id, { payloadExtra: { selectiveCorpusAuthoritativeClaimedAt: '2026-10-03 14:00:46' } });
  const before = await rawPayload(deviceKey, id);
  await finalize(deviceKey, id, timeoutShadowResult());
  const after = await rawPayload(deviceKey, id);
  delete before.selectiveCorpusAuthoritativeClaimedAt;
  delete after.selectiveCorpusAuthoritativeTimedOutAttempts;
  assert.deepEqual(after, before, 'score, archive positions, matched words, text and every other field are untouched');
  const row = await client.execute({ sql: 'SELECT archive_score, score_band FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, id] });
  assert.equal(Number(row.rows[0].archive_score), 1);
  assert.equal(String(row.rows[0].score_band), 'Low');
});

// ===========================================================================
// 10. the 1036041427 pattern
// ===========================================================================

test('10. submission-1036041427 pattern: TIMEOUT, then COMPLETED with 30 candidates / 0 verified -> same 1% as a first-attempt success, completion not PARTIAL', async () => {
  const deviceKey = uniq('dk-to-10');
  const id = uniq('r-to-10');
  await seedPendingReport(deviceKey, id, { createdAt: twentyMinutesAgo() });
  assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult()), { outcome: 'timeout-retry-scheduled', timedOutAttempts: 1 });
  await claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection });
  assert.deepEqual(await finalize(deviceKey, id, completedShadowResult([], 30)), { outcome: 'finalized', status: 'completed' });

  const controlKey = uniq('dk-to-10c');
  const controlId = uniq('r-to-10c');
  await seedPendingReport(controlKey, controlId);
  await finalize(controlKey, controlId, completedShadowResult([], 30));

  const retried = (await rawPayload(deviceKey, id)).unifiedSimilarity;
  const control = (await rawPayload(controlKey, controlId)).unifiedSimilarity;
  assert.equal(retried.unifiedScore, 1, 'the archive-only 1% stands');
  assert.equal(retried.unifiedScore, control.unifiedScore);
  assert.deepEqual(retried.matchedPositions, control.matchedPositions);
  assert.equal(retried.selectiveCorpusOnlyWords, 0);

  const outbound = await getAnonymous(deviceKey, id);
  assert.equal(outbound.reportCompletion.signals.selectiveCorpus, 'COMPLETED');
  assert.notEqual(outbound.reportCompletion.state, 'PARTIAL', 'no "Partial search" for a check that completed on retry');
});

// ===========================================================================
// save / resave
// ===========================================================================

test('resave of a retry-pending report keeps it pending with its attempt count and schedules no second job; a client can never set the count', async () => {
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  try {
    // resave: the seeded row is retry-pending; the resave is a real POST from an account
    const deviceKey = uniq('dk-to-rs');
    const id = uniq('r-to-rs');
    await seedPendingReport(deviceKey, id);
    assert.equal((await finalize(deviceKey, id, timeoutShadowResult())).outcome, 'timeout-retry-scheduled');
    const signedUp = await signUpAccount();
    const account = { ...signedUp, deviceKey, tag: uniq('sc-timeout-resave') };
    assert.equal((await postReport(account, id, { forgedPayloadFields: { selectiveCorpusAuthoritativeTimedOutAttempts: 0 } })).status, 200);
    const resaved = await rawPayload(deviceKey, id);
    assert.equal(resaved.selectiveCorpusAuthoritativeStatus, 'pending', 'still pending: the resave scheduled no second finalization (it would have run inline here)');
    assert.equal(resaved.selectiveCorpusAuthoritativeTimedOutAttempts, 1, 'the stored retry count survives the resave, and a client value cannot reset it');

    // first save: a forged count is dropped
    const fresh = await signUpAccount();
    const freshId = uniq('r-to-fs');
    assert.equal((await postReport(fresh, freshId, { forgedPayloadFields: { selectiveCorpusAuthoritativeTimedOutAttempts: 99 } })).status, 200);
    assert.equal((await rawPayload(fresh.deviceKey, freshId)).selectiveCorpusAuthoritativeTimedOutAttempts, undefined, 'a first save never accepts a client count');
  } finally {
    restoreFlags();
  }
});

// ===========================================================================
// MONOTONIC, SERVER-OWNED COUNT — a save can never move it, in either direction
// ===========================================================================

/** Executes the REAL upsert a resave performs, with a payload built from an
 *  earlier read of the row (the narrow race: a retry write landed in between). */
async function upsertResavePayload(deviceKey, id, payloadObject) {
  await client.execute({
    sql: reportsRoute.SAVE_REPORT_SQL,
    args: [id, deviceKey, 'sub-' + id, 'Timeout retry fixture', new Date().toISOString(), tokens(canonicalizeText(BODY_TEXT)).length, 1, 'Low', null, null, null, JSON.stringify(payloadObject), null, null],
  });
}

test('A1. a stale resave carrying an older count (2) cannot lower the stored count (3)', async () => {
  const deviceKey = uniq('dk-mono-1');
  const id = uniq('r-mono-1');
  await seedPendingReport(deviceKey, id, { payloadExtra: { selectiveCorpusAuthoritativeTimedOutAttempts: 3 } });
  const staleRead = { ...(await rawPayload(deviceKey, id)), selectiveCorpusAuthoritativeTimedOutAttempts: 2, resaveMarker: 'replaced' };
  await upsertResavePayload(deviceKey, id, staleRead);
  const payload = await rawPayload(deviceKey, id);
  assert.equal(payload.resaveMarker, 'replaced', 'the resave did replace the payload');
  assert.equal(payload.selectiveCorpusAuthoritativeTimedOutAttempts, 3, 'but the server-owned count kept its stored value');
  assert.equal(payload.selectiveCorpusAuthoritativeStatus, 'pending');
});

for (const [label, clientValue] of [['A2', 0], ['A3', 99]]) {
  test(`${label}. stored count 3 + a real resave whose client payload sends ${clientValue} -> stays 3`, async () => {
    const deviceKey = uniq(`dk-mono-${label}`);
    const id = uniq(`r-mono-${label}`);
    await seedPendingReport(deviceKey, id, { payloadExtra: { selectiveCorpusAuthoritativeTimedOutAttempts: 3 } });
    const signedUp = await signUpAccount();
    const account = { ...signedUp, deviceKey, tag: uniq(`sc-timeout-mono-${label}`) };
    assert.equal((await postReport(account, id, { forgedPayloadFields: { selectiveCorpusAuthoritativeTimedOutAttempts: clientValue } })).status, 200);
    const payload = await rawPayload(deviceKey, id);
    assert.equal(payload.selectiveCorpusAuthoritativeTimedOutAttempts, 3);
    assert.equal(payload.selectiveCorpusAuthoritativeStatus, 'pending');
  });
}

test('A3b. a resave can never create a count where the server recorded none', async () => {
  // through the real route
  const deviceKey = uniq('dk-mono-3b');
  const id = uniq('r-mono-3b');
  await seedPendingReport(deviceKey, id);
  const signedUp = await signUpAccount();
  const account = { ...signedUp, deviceKey, tag: uniq('sc-timeout-mono-3b') };
  assert.equal((await postReport(account, id, { forgedPayloadFields: { selectiveCorpusAuthoritativeTimedOutAttempts: 4 } })).status, 200);
  assert.equal('selectiveCorpusAuthoritativeTimedOutAttempts' in (await rawPayload(deviceKey, id)), false);

  // through the upsert itself, on a row whose payload it replaces
  const rawKey = uniq('dk-mono-3c');
  const rawId = uniq('r-mono-3c');
  await seedPendingReport(rawKey, rawId);
  await upsertResavePayload(rawKey, rawId, { ...(await rawPayload(rawKey, rawId)), selectiveCorpusAuthoritativeTimedOutAttempts: 4, resaveMarker: 'replaced' });
  const replaced = await rawPayload(rawKey, rawId);
  assert.equal(replaced.resaveMarker, 'replaced');
  assert.equal('selectiveCorpusAuthoritativeTimedOutAttempts' in replaced, false);
});

test('A4/A5. a retry moves 3 -> 4 exactly once; a duplicate finalizer recording the same attempt does not make it 5', async () => {
  const deviceKey = uniq('dk-mono-4');
  const id = uniq('r-mono-4');
  await seedPendingReport(deviceKey, id, { payloadExtra: { selectiveCorpusAuthoritativeTimedOutAttempts: 3 } });
  const racing = interleavingClient(async () => {
    assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult()), { outcome: 'timeout-retry-scheduled', timedOutAttempts: 4 });
  });
  assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult(), racing), { outcome: 'stale-attempt' });
  const payload = await rawPayload(deviceKey, id);
  assert.equal(payload.selectiveCorpusAuthoritativeTimedOutAttempts, 4, 'exactly one increment');
  assert.equal(payload.selectiveCorpusAuthoritativeStatus, 'pending');
});

test('A6. a terminal COMPLETED stands against a stale TIMEOUT and a later resave, and the count stays put', async () => {
  const deviceKey = uniq('dk-mono-6');
  const id = uniq('r-mono-6');
  await seedPendingReport(deviceKey, id, { payloadExtra: { selectiveCorpusAuthoritativeTimedOutAttempts: 3 } });
  assert.deepEqual(await finalize(deviceKey, id, completedShadowResult([])), { outcome: 'finalized', status: 'completed' });
  assert.deepEqual(await finalize(deviceKey, id, timeoutShadowResult()), { outcome: 'not-pending' });
  const signedUp = await signUpAccount();
  const account = { ...signedUp, deviceKey, tag: uniq('sc-timeout-mono-6') };
  assert.equal((await postReport(account, id, { forgedPayloadFields: { selectiveCorpusAuthoritativeTimedOutAttempts: 0 } })).status, 200);
  const payload = await rawPayload(deviceKey, id);
  assert.equal(payload.selectiveCorpusAuthoritativeStatus, 'completed');
  assert.ok(payload.unifiedSimilarity, 'the final score stands');
  assert.equal(payload.selectiveCorpusAuthoritativeTimedOutAttempts, 3);
});

console.log('selective-corpus-timeout-retry: bounded TIMEOUT retry tests passed');
