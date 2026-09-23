import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { resetRateForTest, resetReadRateForTest, resetAuthRateForTest } from '../lib/rate-limit.ts';
import { tokens } from '../lib/similarity-core.ts';
import { canonicalizeText } from '../lib/canonical-text.ts';
import { stripServerInternalReportFields } from '../lib/report-types.ts';
import { refreshSelectiveCorpusCompletionSignal } from '../lib/report-evidence-interpretation.ts';
import { finalizeSelectiveCorpusAuthoritativeReport } from '../lib/selective-corpus-authoritative.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { withTestIdentity, markTestAccountEmailVerified } from './helpers/test-signup.mjs';

/**
 * Selective Corpus authoritative RESPONSE HYGIENE — selectiveCorpusAuthoritativeStatus
 * and selectiveCorpusAuthoritativeClaimedAt are server-internal lifecycle/
 * recovery control state (lib/report-types.ts's own doc comments); this
 * file proves they never reach an ordinary GET response while still being
 * fully readable by server-side lifecycle/recovery code, and that
 * "incomplete" finalization surfaces as a safe, derived reportCompletion
 * signal instead — never a raw internal enum.
 */

const repoRoot = path.resolve('.');
const drizzleDir = path.join(repoRoot, 'drizzle');
const dbFile = path.join(repoRoot, 'test_report_selective_corpus_response_hygiene.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const originalAuthoritativeFlag = process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
const originalShadowFlag = process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  if (originalAuthoritativeFlag === undefined) delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
  else process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = originalAuthoritativeFlag;
  if (originalShadowFlag === undefined) delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  else process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = originalShadowFlag;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const m = setCookie.match(/tp_session_v1=([^;]*)/);
  return m ? m[1] : null;
}

let userCounter = 0;
async function signUpAccount() {
  userCounter += 1;
  const tag = `sc-hygiene-signup-${userCounter}`;
  const email = `sc-hygiene-user-${userCounter}@example.test`;
  const deviceKey = `sc-hygiene-device-${userCounter}`;
  await resetAuthRateForTest(tag);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': tag },
    body: JSON.stringify(withTestIdentity({ email, password: 'sc-hygiene-pw-1', username: `schyg${userCounter}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'signup must succeed');
  await markTestAccountEmailVerified(dbFile, email);
  const row = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return { userId: String(row.rows[0].id), deviceKey, cookie: extractCookie(res), tag: `sc-hygiene-${userCounter}` };
}

async function postReport(account, { id, text, aiStatus = 'ready', aiScore = 3, forgedPayloadFields } = {}) {
  const wordCount = typeof text === 'string' && text.length > 0 ? tokens(canonicalizeText(text)).length : 0;
  await resetRateForTest(account.tag + '-post');
  const body = {
    deviceKey: account.deviceKey,
    id,
    submissionId: 'sub-' + id,
    title: 'Response hygiene fixture',
    createdAt: new Date().toISOString(),
    wordCount,
    archiveScore: 0,
    scoreBand: 'Low',
    aiScore: aiScore ?? null,
    aiTone: aiScore != null ? 'low' : null,
    aiStatus,
    payload: {
      version: 11, id: 1, submissionId: 'sub-' + id, title: 'Response hygiene fixture',
      author: '', assignment: '', created: new Date().toISOString(),
      score: 0, archiveScore: 0, wordCount, scoreBand: 'Low', matchedWordCount: 0,
      sources: [], repeats: [], text,
      ...(forgedPayloadFields ?? {}),
    },
    // AUTH GATE: a genuinely new report can no longer be created
    // anonymously at all (see app/api/reports/route.ts) — every account
    // from signUpAccount() only ever creates exactly one first-save report
    // (a resave of the same id, if any, ignores room), so a fixed room is
    // safe here.
    room: 0,
  };
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post', cookie: `tp_session_v1=${account.cookie}` },
    body: JSON.stringify(body),
  }));
}

async function getReport(account, id) {
  await resetReadRateForTest(account.tag + '-get');
  const url = `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(account.deviceKey)}`;
  return reportIdRoute.GET(
    new Request(url, { headers: { 'x-forwarded-for': account.tag + '-get', cookie: `tp_session_v1=${account.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
}

/** Raw DB read — the ONLY way this file inspects persisted payload_json
 *  directly, standing in for "server-side lifecycle/recovery code," which
 *  reads payload_json exactly like this rather than through any client
 *  response. Never used to assert on what a CLIENT sees. */
async function rawPersistedPayload(deviceKey, id) {
  const r = await client.execute({
    sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?',
    args: [deviceKey, id],
  });
  const row = r.rows[0];
  return row ? JSON.parse(String(row.payload_json)) : null;
}

const EVALUATOR_VERSION = 'selective-corpus-shadow-v1';
function completedShadowResult(verifiedEvidence = []) {
  return {
    state: 'COMPLETED', evaluatorVersion: EVALUATOR_VERSION,
    corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 1,
    candidateCount: 0, topCandidateRanks: [], stageATruncated: false,
    verifiedSourceCount: 0, matchedPositionCount: 0,
    ...(verifiedEvidence.length > 0 ? { verifiedEvidence } : {}),
    counterfactualUnifiedSimilarity: 0, authoritativeUnifiedSimilarity: null, deltaVsAuthoritative: 0,
    runtimeStageAMs: 1, runtimeStageBMs: 1, familyGuardActivations: 0, coSourceAttributionActivations: 0,
  };
}
function timeoutShadowResult() {
  return { state: 'TIMEOUT', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'TIMEOUT', failureMessage: 'stage budget exceeded' };
}

/** Creates a genuinely authoritative-pending report via the REAL POST route
 *  (empty text -> shadowEvaluationInputs stays null -> the deferred
 *  finalizer never fires this save, so the row stays pending after POST
 *  returns in this synchronous test harness — the same technique already
 *  established in tests/selective-corpus-authoritative-lifecycle.test.mjs).
 *  Empty text still exercises the real finalizeReportJson/withEvidenceInterpretation
 *  call (unconditional, regardless of text), so a real reportCompletion is
 *  persisted for these fixtures too. */
async function createPendingFixture(id, forgedPayloadFields) {
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  try {
    const account = await signUpAccount();
    const res = await postReport(account, { id, text: '', aiStatus: 'processing', aiScore: null, forgedPayloadFields });
    assert.equal(res.status, 200);
    return account;
  } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
    delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  }
}

// ===========================================================================
// Pure unit coverage for the two new functions
// ===========================================================================

test('unit: stripServerInternalReportFields removes only the two internal fields', () => {
  const report = { selectiveCorpusAuthoritativeStatus: 'completed', selectiveCorpusAuthoritativeClaimedAt: '2026-01-01', wordCount: 10, score: 5 };
  stripServerInternalReportFields(report);
  assert.equal(report.selectiveCorpusAuthoritativeStatus, undefined);
  assert.equal(report.selectiveCorpusAuthoritativeClaimedAt, undefined);
  assert.equal(report.wordCount, 10);
  assert.equal(report.score, 5);
});

test('unit: refreshSelectiveCorpusCompletionSignal no-ops without a persisted reportCompletion', () => {
  const report = { selectiveCorpusAuthoritativeStatus: 'incomplete' };
  refreshSelectiveCorpusCompletionSignal(report);
  assert.equal(report.reportCompletion, undefined);
});

test('unit: refreshSelectiveCorpusCompletionSignal no-ops for marker-absent or pending', () => {
  const base = { state: 'COMPLETED', headline: 'h', detail: null, reasons: [], signals: { academicSearch: null, selectiveCorpus: null, extraction: 'UNKNOWN', unverifiedCandidateCount: 0, userSuppliedReference: null } };
  const absent = { reportCompletion: { ...base } };
  refreshSelectiveCorpusCompletionSignal(absent);
  assert.deepEqual(absent.reportCompletion, base, 'no marker at all -> untouched');

  const pending = { selectiveCorpusAuthoritativeStatus: 'pending', reportCompletion: { ...base } };
  refreshSelectiveCorpusCompletionSignal(pending);
  assert.deepEqual(pending.reportCompletion, base, 'still pending -> untouched (no terminal branch to report yet)');
});

test('unit: refreshSelectiveCorpusCompletionSignal upgrades to PARTIAL for incomplete, with the neutral existing headline/reason', () => {
  const report = {
    selectiveCorpusAuthoritativeStatus: 'incomplete',
    wordCount: 500,
    unifiedSimilarity: { unifiedScore: 12 },
    reportCompletion: { state: 'COMPLETED', headline: 'h', detail: null, reasons: [], signals: { academicSearch: null, selectiveCorpus: null, extraction: 'UNKNOWN', unverifiedCandidateCount: 0, userSuppliedReference: null } },
  };
  refreshSelectiveCorpusCompletionSignal(report);
  assert.equal(report.reportCompletion.signals.selectiveCorpus, 'PARTIAL');
  assert.equal(report.reportCompletion.state, 'PARTIAL');
  assert.match(report.reportCompletion.headline, /source searches were unavailable/i);
  assert.ok(report.reportCompletion.reasons.some((r) => /TurnitPlus reference index/.test(r)));
});

test('unit: refreshSelectiveCorpusCompletionSignal marks COMPLETED without any warning', () => {
  const report = {
    selectiveCorpusAuthoritativeStatus: 'completed',
    reportCompletion: { state: 'COMPLETED', headline: 'h', detail: null, reasons: [], signals: { academicSearch: null, selectiveCorpus: null, extraction: 'UNKNOWN', unverifiedCandidateCount: 0, userSuppliedReference: null } },
  };
  refreshSelectiveCorpusCompletionSignal(report);
  assert.equal(report.reportCompletion.signals.selectiveCorpus, 'COMPLETED');
  assert.equal(report.reportCompletion.state, 'COMPLETED');
  assert.equal(report.reportCompletion.detail, null, 'completed carries no incomplete-style detail sentence');
});

// ===========================================================================
// 1. pending report ordinary GET
// ===========================================================================

test('1. pending report GET: pending status, no final score, internal fields not exposed', async () => {
  const id = uniq('r-hyg-1');
  const account = await createPendingFixture(id);

  const res = await getReport(account, id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.payload?.unifiedSimilarity, undefined, 'no final score while pending');
  assert.equal(body.payload?.selectiveCorpusAuthoritativeStatus, undefined, 'internal status not exposed');
  assert.equal(body.payload?.selectiveCorpusAuthoritativeClaimedAt, undefined, 'internal claim timestamp not exposed');
  assert.equal('selectiveCorpusAuthoritativeStatus' in (body.payload ?? {}), false, 'the key itself is absent, not merely undefined-valued');
});

// ===========================================================================
// 2. completed report GET
// ===========================================================================

test('2. completed report GET: resolved score present, internal fields not exposed, no incomplete warning', async () => {
  const id = uniq('r-hyg-2');
  const account = await createPendingFixture(id);
  const fin = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: account.deviceKey, reportId: id, accountId: null, shadowResult: completedShadowResult(),
  });
  assert.deepEqual(fin, { outcome: 'finalized', status: 'completed' });

  const res = await getReport(account, id);
  const body = await res.json();
  assert.ok(body.payload?.unifiedSimilarity, 'a real resolved score is present');
  assert.equal('selectiveCorpusAuthoritativeStatus' in (body.payload ?? {}), false);
  assert.equal('selectiveCorpusAuthoritativeClaimedAt' in (body.payload ?? {}), false);
  assert.ok(body.payload?.reportCompletion, 'reportCompletion is present');
  assert.notEqual(body.payload.reportCompletion.state, 'PARTIAL', 'completed must never show the incomplete/PARTIAL warning');
  assert.equal(body.payload.reportCompletion.signals.selectiveCorpus, 'COMPLETED');
});

// ===========================================================================
// 3. incomplete report GET
// ===========================================================================

test('3. incomplete report GET: resolved score present, internal fields not exposed, safe derived incomplete signal present', async () => {
  const id = uniq('r-hyg-3');
  const account = await createPendingFixture(id);
  const fin = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: account.deviceKey, reportId: id, accountId: null, shadowResult: timeoutShadowResult(),
  });
  assert.deepEqual(fin, { outcome: 'finalized', status: 'incomplete' });

  const res = await getReport(account, id);
  const body = await res.json();
  assert.ok(body.payload?.unifiedSimilarity, 'a real resolved score is present even though V4 was incomplete');
  assert.equal(body.payload?.unifiedSimilarityFailed, false);
  assert.equal('selectiveCorpusAuthoritativeStatus' in (body.payload ?? {}), false, 'raw internal enum never exposed');
  assert.equal('selectiveCorpusAuthoritativeClaimedAt' in (body.payload ?? {}), false);
  assert.ok(body.payload?.reportCompletion, 'reportCompletion is present');
  assert.equal(body.payload.reportCompletion.state, 'PARTIAL', 'the safe derived "some source checks incomplete" signal');
  assert.equal(body.payload.reportCompletion.signals.selectiveCorpus, 'PARTIAL');
  assert.match(body.payload.reportCompletion.headline, /source searches were unavailable/i);
  // neutral product language only — no internal enum/state-machine/digest/retry vocabulary leaked into the copy
  const raw = JSON.stringify(body.payload.reportCompletion);
  for (const forbidden of ['TIMEOUT', 'ARTIFACT_UNAVAILABLE', 'FAILED', 'claimedAt', 'digest', 'retry', 'recovery', 'sweep']) {
    assert.doesNotMatch(raw, new RegExp(forbidden, 'i'), `reportCompletion must not leak internal vocabulary: ${forbidden}`);
  }
});

// ===========================================================================
// 4. marker-less historical report
// ===========================================================================

test('4. marker-less historical report GET: response unchanged, no incomplete signal', async () => {
  delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
  delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  const id = uniq('r-hyg-4');
  const account = await signUpAccount();
  const text = 'A wholly unique paragraph for the response-hygiene historical-report regression test, describing a fictional survey of tidal pools along a rocky coastline over a full lunar cycle.';
  const res = await postReport(account, { id, text });
  assert.equal(res.status, 200);

  const before = await rawPersistedPayload(account.deviceKey, id);
  assert.equal(before.selectiveCorpusAuthoritativeStatus, undefined, 'sanity: genuinely marker-less');

  const getRes = await getReport(account, id);
  const body = await getRes.json();
  assert.equal('selectiveCorpusAuthoritativeStatus' in (body.payload ?? {}), false);
  assert.equal('selectiveCorpusAuthoritativeClaimedAt' in (body.payload ?? {}), false);
  assert.equal(body.payload.reportCompletion?.signals?.selectiveCorpus ?? null, null, 'no incomplete signal is invented for a report with no marker at all');
  assert.notEqual(body.payload.reportCompletion?.state, 'PARTIAL');
});

// ===========================================================================
// 5. forged client payload containing internal lifecycle fields
// ===========================================================================

test('5. a forged client payload cannot control the persisted or public authoritative status', async () => {
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  try {
    const id = uniq('r-hyg-5');
    const account = await signUpAccount();
    const res = await postReport(account, {
      id, text: '', aiStatus: 'processing', aiScore: null,
      forgedPayloadFields: {
        selectiveCorpusAuthoritativeStatus: 'completed',
        selectiveCorpusAuthoritativeClaimedAt: '2020-01-01T00:00:00.000Z',
        unifiedSimilarity: { version: 'forged', wordCount: 1, unifiedScore: 100, uniqueMatchedWords: 1, matchedPositions: [0] },
      },
    });
    assert.equal(res.status, 200);

    const persisted = await rawPersistedPayload(account.deviceKey, id);
    assert.equal(persisted.selectiveCorpusAuthoritativeStatus, 'pending', 'the server-computed marker wins; the forged "completed" never lands');
    assert.equal(persisted.selectiveCorpusAuthoritativeClaimedAt, undefined, 'a first save never persists a claim timestamp, forged or not');
    assert.equal(persisted.unifiedSimilarity, undefined, 'the forged score is stripped by the pre-existing trust-boundary fix, not just hidden at display time');

    const getRes = await getReport(account, id);
    const body = await getRes.json();
    assert.equal(body.payload?.unifiedSimilarity, undefined, 'no forged/final-looking score is ever displayed');
    assert.equal('selectiveCorpusAuthoritativeStatus' in (body.payload ?? {}), false);
  } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
    delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  }
});

// ===========================================================================
// 6. resave preserves internal persisted status despite response stripping
// ===========================================================================

test('6. an ordinary resave preserves the internal persisted status even though it is never exposed in either response', async () => {
  const id = uniq('r-hyg-6');
  const account = await createPendingFixture(id);
  await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: account.deviceKey, reportId: id, accountId: null, shadowResult: timeoutShadowResult(),
  });
  const beforeResave = await rawPersistedPayload(account.deviceKey, id);
  assert.equal(beforeResave.selectiveCorpusAuthoritativeStatus, 'incomplete');

  // AI/Wikipedia-style resave — no forged fields, just a normal follow-up save.
  const resaveRes = await postReport(account, { id, text: '', aiStatus: 'ready', aiScore: 2 });
  assert.equal(resaveRes.status, 200);

  const afterResave = await rawPersistedPayload(account.deviceKey, id);
  assert.equal(afterResave.selectiveCorpusAuthoritativeStatus, 'incomplete', 'preserved internally across the resave');

  const getRes = await getReport(account, id);
  const body = await getRes.json();
  assert.equal('selectiveCorpusAuthoritativeStatus' in (body.payload ?? {}), false, 'still never exposed after the resave');
  assert.equal(body.payload.reportCompletion?.state, 'PARTIAL', 'the derived signal still reflects the preserved internal state after the resave');
});

// ===========================================================================
// 7. recovery/finalizer server code can still read the persisted internal fields
// ===========================================================================

test('7. server-side recovery/finalizer code still reads the persisted internal fields after a client has already viewed the (stripped) response', async () => {
  const id = uniq('r-hyg-7');
  const account = await createPendingFixture(id);

  // A client views the report while it is still pending — this exercises the
  // in-memory stripping path, but must never touch the STORED payload_json.
  const getRes = await getReport(account, id);
  assert.equal(getRes.status, 200);
  const viewedBody = await getRes.json();
  assert.equal('selectiveCorpusAuthoritativeStatus' in (viewedBody.payload ?? {}), false);

  const stillPending = await rawPersistedPayload(account.deviceKey, id);
  assert.equal(stillPending.selectiveCorpusAuthoritativeStatus, 'pending', 'the GET response stripping never mutated the stored payload_json');

  // Server-side recovery/finalizer code reads and acts on that same
  // still-intact persisted field, exactly as if the client view never happened.
  const fin = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: account.deviceKey, reportId: id, accountId: null, shadowResult: completedShadowResult(),
  });
  assert.deepEqual(fin, { outcome: 'finalized', status: 'completed' });

  const finalized = await rawPersistedPayload(account.deviceKey, id);
  assert.equal(finalized.selectiveCorpusAuthoritativeStatus, 'completed');
});

console.log('report-selective-corpus-response-hygiene: internal-field stripping + derived incomplete signal tests passed');
