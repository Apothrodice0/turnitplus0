import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { resetRateForTest, resetReadRateForTest, resetAuthRateForTest } from '../lib/rate-limit.ts';
import { tokens } from '../lib/similarity-core.ts';
import { canonicalizeText } from '../lib/canonical-text.ts';
import {
  selfHealUnifiedSimilarity,
  resolvePersistedSimilarityDisplay,
  persistSelectiveCorpusAuthoritativeFinalization,
} from '../lib/report-primary-similarity.ts';
import { isSimilarityTerminal } from '../lib/report-detail-poll.ts';
import { runSelectiveCorpusShadowEvaluation } from '../lib/selective-corpus/shadow-evaluation.ts';
import {
  finalizeSelectiveCorpusAuthoritativeReport,
  claimStaleSelectiveCorpusAuthoritativePendingReports,
  selectSelectiveCorpusFinalizationEvidence,
} from '../lib/selective-corpus-authoritative.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { withTestIdentity, markTestAccountEmailVerified } from './helpers/test-signup.mjs';

/**
 * AUTHORITATIVE PROMOTION — lifecycle / resave / creation-policy / CAS /
 * recovery / historical-immutability tests (task items 13-42). Test items
 * 1-12 (pure computeUnifiedSimilarity core-scoring behavior) live in
 * tests/unified-similarity-selective-corpus.test.mjs; this file covers
 * everything with a real persisted saved_reports row.
 *
 * Uses a real libsql file DB (own file, isolated from every other test),
 * the REAL app/api/reports POST/GET route handlers for creation/resave/GET
 * behavior, and DIRECT calls to the canonical finalizer/claim functions for
 * state-policy and race/recovery behavior — never a hand-rolled duplicate of
 * the scoring or persistence logic under test.
 */

const repoRoot = path.resolve('.');
const drizzleDir = path.join(repoRoot, 'drizzle');
const dbFile = path.join(repoRoot, 'test_selective_corpus_authoritative_lifecycle.db');
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

// ---------------------------------------------------------------------------
// fixtures + helpers
// ---------------------------------------------------------------------------

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;
const EVALUATOR_VERSION = 'selective-corpus-shadow-v1';

/** claimStaleSelectiveCorpusAuthoritativePendingReports OWNS and closes
 *  whatever connection its openConnection factory returns (see its own
 *  implementation — mirrors runReportAdmissionRetrySweep's identical
 *  contract). Passing this file's single long-lived `client` directly would
 *  get it closed out from under every later test; hand it a fresh
 *  connection to the SAME file-backed DB each time instead. */
const openTestConnection = () => createClient({ url: `file:${dbFile}` });

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const m = setCookie.match(/tp_session_v1=([^;]*)/);
  return m ? m[1] : null;
}

let userCounter = 0;
async function signUpAccount() {
  userCounter += 1;
  const tag = `sc-auth-signup-${userCounter}`;
  const email = `sc-auth-user-${userCounter}@example.test`;
  const deviceKey = `sc-auth-device-${userCounter}`;
  await resetAuthRateForTest(tag);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': tag },
    body: JSON.stringify(withTestIdentity({ email, password: 'sc-auth-pw-1', username: `scauth${userCounter}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'signup must succeed');
  await markTestAccountEmailVerified(dbFile, email);
  const row = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return { userId: String(row.rows[0].id), deviceKey, cookie: extractCookie(res), tag: `sc-auth-${userCounter}` };
}

async function postReport(account, { id, text, aiStatus = 'ready', aiScore = 3, forgedPayloadFields } = {}) {
  const wordCount = typeof text === 'string' && text.length > 0 ? tokens(canonicalizeText(text)).length : 0;
  await resetRateForTest(account.tag + '-post');
  const body = {
    deviceKey: account.deviceKey,
    id,
    submissionId: 'sub-' + id,
    title: 'Authoritative fixture',
    createdAt: new Date().toISOString(),
    wordCount,
    archiveScore: 0,
    scoreBand: 'Low',
    aiScore: aiScore ?? null,
    aiTone: aiScore != null ? 'low' : null,
    aiStatus,
    payload: {
      version: 11, id: 1, submissionId: 'sub-' + id, title: 'Authoritative fixture',
      author: '', assignment: '', created: new Date().toISOString(),
      score: 0, archiveScore: 0, wordCount, scoreBand: 'Low', matchedWordCount: 0,
      sources: [], repeats: [], text,
      // CLIENT FORGERY TESTS — a real attacker/buggy client can put ANY key
      // into their own submitted `payload` object; this is exactly that raw,
      // untrusted shape, spread in last so a test-supplied forged value for
      // unifiedSimilarity/unifiedSimilarityFailed/unifiedSimilarityGeneration/
      // corpusSourceMatchingEnabledAtComputation (or anything else) reaches
      // the real POST route's body precisely as a hostile client's own JSON
      // would. Absent (undefined) for every ordinary call site above.
      ...(forgedPayloadFields ?? {}),
    },
    // AUTH GATE: a genuinely new report can no longer be created anonymously
    // at all (see app/api/reports/route.ts). Every real `signUpAccount()`
    // account here only ever creates exactly one first-save id (a resave of
    // the same id, if any, ignores room), so a fixed room is safe; the
    // fake `{ deviceKey, cookie: null, tag }` fixtures used elsewhere in this
    // file are always a RESAVE of a row already seeded directly via
    // seedReport/seedPendingReport (isFirstSaveOfThisReport is false there),
    // which the auth gate never touches — so `room` is simply ignored for
    // them, exactly as it already is for any other anonymous resave.
    room: 0,
  };
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': account.tag + '-post',
      ...(account.cookie ? { cookie: `tp_session_v1=${account.cookie}` } : {}),
    },
    body: JSON.stringify(body),
  }));
}

async function getReport(account, id) {
  await resetReadRateForTest(account.tag + '-get');
  const url = account.cookie
    ? `http://localhost/api/reports/${id}`
    : `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(account.deviceKey)}`;
  return reportIdRoute.GET(
    new Request(url, {
      headers: {
        'x-forwarded-for': account.tag + '-get',
        ...(account.cookie ? { cookie: `tp_session_v1=${account.cookie}` } : {}),
      },
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
}

async function savedReportRow(deviceKey, id) {
  const r = await client.execute({
    sql: 'SELECT report_created_at, ai_status, payload_json FROM saved_reports WHERE device_key = ? AND id = ?',
    args: [deviceKey, id],
  });
  const row = r.rows[0];
  return row
    ? { reportCreatedAt: String(row.report_created_at), aiStatus: row.ai_status, payload: JSON.parse(String(row.payload_json)) }
    : null;
}

/** Seeds a saved_reports row directly (mirrors the "legacy report" pattern
 *  already used by tests/report-shadow-evaluation-trigger.test.mjs) — used
 *  wherever a test needs a precisely-frozen lifecycle state that a full
 *  round-trip through the real route cannot observe, since runAfterResponse
 *  runs its deferred work SYNCHRONOUSLY (awaited inline) in this test
 *  harness (see lib/run-after-response.ts's own doc comment): by the time a
 *  real POST call returns, any deferred finalization it triggered has
 *  already completed, so there is no real "still mid-flight" instant to
 *  observe from outside. Directly asserting on/exercising the real
 *  persistence and finalization functions against a known-shape row is the
 *  faithful way to test these states. */
async function seedReport(deviceKey, id, { userId = null, text = 'Authoritative fixture body text for a seeded lifecycle test.', createdAt = new Date().toISOString(), payloadExtra = {} } = {}) {
  const wordCount = tokens(canonicalizeText(text)).length;
  const payload = JSON.stringify({
    version: 11, id: 1, submissionId: 'sub-' + id, title: 'Authoritative fixture',
    text, wordCount, score: 0, archiveScore: 0, scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [],
    ...payloadExtra,
  });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey, 'sub-' + id, 'Authoritative fixture', createdAt, wordCount, 0, 'Low', payload, userId, null],
  });
  return { text, wordCount };
}

async function seedPendingReport(deviceKey, id, opts = {}) {
  return seedReport(deviceKey, id, {
    ...opts,
    payloadExtra: {
      selectiveCorpusAuthoritativeStatus: 'pending',
      ...(opts.claimedAt ? { selectiveCorpusAuthoritativeClaimedAt: opts.claimedAt } : {}),
      ...(opts.payloadExtra ?? {}),
    },
  });
}

function completedShadowResult(verifiedEvidence = []) {
  const matchedPositionCount = verifiedEvidence.reduce((n, s) => n + s.matchedPassages.reduce((m, p) => m + p.matchedWordCount, 0), 0);
  return {
    state: 'COMPLETED', evaluatorVersion: EVALUATOR_VERSION,
    corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 1,
    candidateCount: verifiedEvidence.length, topCandidateRanks: verifiedEvidence.map((_, i) => i), stageATruncated: false,
    verifiedSourceCount: verifiedEvidence.length, matchedPositionCount,
    ...(verifiedEvidence.length > 0 ? { verifiedEvidence } : {}),
    counterfactualUnifiedSimilarity: 0, authoritativeUnifiedSimilarity: null, deltaVsAuthoritative: 0,
    runtimeStageAMs: 1, runtimeStageBMs: 1, familyGuardActivations: 0, coSourceAttributionActivations: 0,
  };
}
function partialShadowResult(verifiedEvidence) {
  return {
    ...completedShadowResult(verifiedEvidence), state: 'PARTIAL',
    degradedShardCount: 1, degradedShards: [7], degradedShardCodes: { MISSING: 1 }, degradedDetail: '1 shard unavailable',
  };
}
function timeoutShadowResult() {
  return { state: 'TIMEOUT', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'TIMEOUT', failureMessage: 'stage budget exceeded' };
}
function artifactUnavailableShadowResult() {
  return { state: 'ARTIFACT_UNAVAILABLE', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'MISSING_ARTIFACT_PATH', failureMessage: 'no artifact configured' };
}
function failedShadowResult() {
  return { state: 'FAILED', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'UNEXPECTED', failureMessage: 'boom' };
}

// ===========================================================================
// LIFECYCLE (13-21)
// ===========================================================================

test('13. a genuinely pending report persists marker=pending, no unifiedSimilarity, and reads back as similarityStatus=pending', async () => {
  const deviceKey = uniq('dk-13');
  const id = uniq('r-13');
  await seedPendingReport(deviceKey, id);

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'pending');
  assert.equal(row.payload.unifiedSimilarity, undefined, 'no final score persisted while pending');

  const display = await resolvePersistedSimilarityDisplay(client, {
    reportDeviceKey: deviceKey, reportId: id, archiveScore: 0,
    unifiedScore: null, hasUnifiedSimilarity: false,
    corpusSourceMatchingEnabledAtComputation: null, unifiedSimilarityFailed: false, hasPositionEvidence: false,
  });
  assert.deepEqual(display, { status: 'pending' }, 'the existing similarityStatus mechanism naturally reports pending — no second UI lifecycle was invented');
});

test('14. flag ON + shadow OFF: no pending marker is created, current pre-V4 scoring persists', async () => {
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  try {
    const account = await signUpAccount();
    const id = uniq('r-14');
    const res = await postReport(account, { id, text: 'A short but real submission body used only to exercise the misconfiguration-safe creation path end to end.' });
    assert.equal(res.status, 200);

    const row = await savedReportRow(account.deviceKey, id);
    assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, undefined, 'AUTHORITATIVE=true + SHADOW=false must never create a pending report');
    assert.ok(row.payload.unifiedSimilarity, 'the normal pre-V4 score persists immediately, exactly as before this feature existed');
  } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
  }
});

test('15. pending GET: no V4 execution, selfHeal short-circuits to attempted:false, no write at all', async () => {
  const deviceKey = uniq('dk-15');
  const id = uniq('r-15');
  await seedPendingReport(deviceKey, id);
  const before = await savedReportRow(deviceKey, id);

  const account = { deviceKey, cookie: null, tag: uniq('sc-auth-get-15') };
  const res = await getReport(account, id);
  assert.equal(res.status, 200, 'GET must still serve the report, just without a final score');
  const body = await res.json();
  assert.equal(body.payload?.unifiedSimilarity, undefined, 'no numeric unified result is exposed while pending');

  const heal = await selfHealUnifiedSimilarity(client, { reportDeviceKey: deviceKey, reportId: id, accountId: null });
  assert.deepEqual(heal, { attempted: false }, 'the pending short-circuit fires — no compute attempted');

  const after = await savedReportRow(deviceKey, id);
  assert.deepEqual(after.payload, before.payload, 'payload_json is completely unchanged by GET + selfHeal on a pending report');
});

test('16. deferred COMPLETED finalizes: real verifiedEvidence merges in, marker pending -> completed', async () => {
  const deviceKey = uniq('dk-16');
  const id = uniq('r-16');
  const { wordCount } = await seedPendingReport(deviceKey, id);
  const evidence = [{ sourceLabel: 'S1', matchedPassages: [{ submittedWordStart: 0, submittedWordEnd: Math.min(9, wordCount - 1), matchedWordCount: Math.min(10, wordCount) }] }];

  const result = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: completedShadowResult(evidence),
  });
  assert.deepEqual(result, { outcome: 'finalized', status: 'completed' });

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'completed');
  assert.equal(row.payload.selectiveCorpusAuthoritativeClaimedAt, undefined, 'claim marker cleared on terminal transition');
  assert.ok(row.payload.unifiedSimilarity, 'a real final score was persisted');
  assert.ok(row.payload.unifiedSimilarity.selectiveCorpusOnlyWords > 0, 'the verified V4 evidence actually contributed to the persisted score');
});

test('17. deferred PARTIAL finalizes with its real lower-bound evidence, marker pending -> incomplete', async () => {
  const deviceKey = uniq('dk-17');
  const id = uniq('r-17');
  const { wordCount } = await seedPendingReport(deviceKey, id);
  const evidence = [{ sourceLabel: 'S1', matchedPassages: [{ submittedWordStart: 0, submittedWordEnd: Math.min(4, wordCount - 1), matchedWordCount: Math.min(5, wordCount) }] }];

  const result = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: partialShadowResult(evidence),
  });
  assert.deepEqual(result, { outcome: 'finalized', status: 'incomplete' });

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.ok(row.payload.unifiedSimilarity.selectiveCorpusOnlyWords > 0, 'PARTIAL still contributes its genuine, already-verified lower-bound evidence — never treated as zero');
});

for (const [label, resultFn] of [
  ['TIMEOUT', timeoutShadowResult],
  ['ARTIFACT_UNAVAILABLE', artifactUnavailableShadowResult],
  ['FAILED', failedShadowResult],
]) {
  test(`18/19/20 (${label}): zero V4 contribution, marker pending -> incomplete, report still resolves`, async () => {
    const deviceKey = uniq(`dk-term-${label}`);
    const id = uniq(`r-term-${label}`);
    await seedPendingReport(deviceKey, id);

    const result = await finalizeSelectiveCorpusAuthoritativeReport(client, {
      reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: resultFn(),
    });
    assert.deepEqual(result, { outcome: 'finalized', status: 'incomplete' });

    const row = await savedReportRow(deviceKey, id);
    assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'incomplete');
    assert.equal(row.payload.unifiedSimilarity.selectiveCorpusOnlyWords, 0, `${label} must contribute exactly zero`);

    const display = await resolvePersistedSimilarityDisplay(client, {
      reportDeviceKey: deviceKey, reportId: id, archiveScore: 0,
      unifiedScore: row.payload.unifiedSimilarity.unifiedScore, hasUnifiedSimilarity: true,
      corpusSourceMatchingEnabledAtComputation: row.payload.corpusSourceMatchingEnabledAtComputation,
      unifiedSimilarityFailed: false, hasPositionEvidence: Array.isArray(row.payload.unifiedSimilarity.matchedPositions),
    });
    // Never "pending" (the customer-facing invariant this test exists to
    // prove) — whether the display resolver's own orthogonal historical-
    // match-snapshot freshness check happens to land on "resolved" or
    // "stale" is governed by lib/report-historical-match.ts, not by
    // anything Selective Corpus authoritative promotion controls.
    assert.notEqual(display.status, 'pending', `a customer report must not be left pending merely because V4 had an operational (${label}) failure`);
    assert.notEqual(display.status, 'failed', `an operational V4 failure alone must never surface as a terminal similarity failure`);
  });
}

test('21. unexpected finalizer exception falls back to best-effort zero-V4 incomplete finalization', async () => {
  const deviceKey = uniq('dk-21');
  const id = uniq('r-21');
  await seedPendingReport(deviceKey, id);

  let calls = 0;
  const throwingOnceClient = {
    execute: async (arg) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated unexpected failure inside the primary finalization attempt');
      return client.execute(arg);
    },
    close() {},
  };

  const result = await finalizeSelectiveCorpusAuthoritativeReport(throwingOnceClient, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: completedShadowResult([{ sourceLabel: 'S1', matchedPassages: [{ submittedWordStart: 0, submittedWordEnd: 4, matchedWordCount: 5 }] }]),
  });
  assert.deepEqual(result, { outcome: 'finalized', status: 'incomplete' }, 'best-effort fallback drops the V4 evidence entirely but still finalizes honestly as incomplete');
  assert.ok(calls > 1, 'sanity: the primary attempt really did throw and a fallback attempt really did follow');

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.equal(row.payload.unifiedSimilarity.selectiveCorpusOnlyWords, 0, 'the fallback never uses the evidence the failed primary attempt might have picked');
});

test('21b. if the fallback ALSO fails, the report is left pending for the recovery sweep — never a false result', async () => {
  const deviceKey = uniq('dk-21b');
  const id = uniq('r-21b');
  await seedPendingReport(deviceKey, id);

  const alwaysThrowingClient = { execute: async () => { throw new Error('simulated total DB outage'); }, close() {} };
  const result = await finalizeSelectiveCorpusAuthoritativeReport(alwaysThrowingClient, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: completedShadowResult([]),
  });
  assert.deepEqual(result, { outcome: 'gave-up' });

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'pending', 'left honestly pending, eligible for the recovery sweep — never a fabricated result');
});

// ===========================================================================
// RESAVE (22-25)
// ===========================================================================

test('22. an AI/Wikipedia-style resave of a still-pending report preserves the pending marker and never persists a score', async () => {
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  try {
    const account = await signUpAccount();
    const id = uniq('r-22');
    // Empty text -> shadowEvaluationInputs stays null -> scheduling (and
    // therefore the deferred finalizer) never fires this save, so the row
    // genuinely remains pending after POST returns in this synchronous test
    // harness (see seedReport's own comment above for why this is necessary).
    assert.equal((await postReport(account, { id, text: '', aiStatus: 'processing', aiScore: null })).status, 200);
    const afterFirstSave = await savedReportRow(account.deviceKey, id);
    assert.equal(afterFirstSave.payload.selectiveCorpusAuthoritativeStatus, 'pending', 'sanity: first save entered pending');

    // AI/Wikipedia-style second save — same report id, AI now complete.
    assert.equal((await postReport(account, { id, text: '', aiStatus: 'ready', aiScore: 4 })).status, 200);

    const afterResave = await savedReportRow(account.deviceKey, id);
    assert.equal(afterResave.payload.selectiveCorpusAuthoritativeStatus, 'pending', 'the resave preserves the pending marker instead of dropping it');
    assert.equal(afterResave.payload.unifiedSimilarity, undefined, 'still no premature score after the resave');
    assert.equal(afterResave.aiStatus, 'ready', 'sanity: the resave itself really did apply (AI fields updated)');
  } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
    delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  }
});

test('23. resave after completed preserves the completed marker (and its score)', async () => {
  const deviceKey = uniq('dk-23');
  const id = uniq('r-23');
  await seedPendingReport(deviceKey, id);
  const fin = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: completedShadowResult([]),
  });
  assert.equal(fin.outcome, 'finalized');
  // AUTH GATE (tightened): a resave — like a first save — now requires a
  // session; an anonymous resave of this pre-existing (never-claimed)
  // legacy row is no longer possible at all. This resave is instead the
  // real "claim by resave" path (a fresh account, authenticated, resaving
  // the exact pre-existing device_key/id) — orthogonal to what this test
  // actually proves (a terminal marker survives an ordinary resave).
  const signedUp = await signUpAccount();
  const account = { ...signedUp, deviceKey, tag: uniq('sc-auth-resave-23') };

  assert.equal((await postReport(account, { id, text: 'Authoritative fixture body text for a seeded lifecycle test.', aiStatus: 'ready', aiScore: 2 })).status, 200);

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'completed', 'a terminal marker is never dropped or reset by an ordinary resave');
});

test('24. resave after incomplete preserves the incomplete marker', async () => {
  const deviceKey = uniq('dk-24');
  const id = uniq('r-24');
  await seedPendingReport(deviceKey, id);
  const fin = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: timeoutShadowResult(),
  });
  assert.equal(fin.outcome, 'finalized');
  // AUTH GATE (tightened): see test 23's own comment — this is now a real
  // "claim by resave" from a fresh authenticated account, never anonymous.
  const signedUp = await signUpAccount();
  const account = { ...signedUp, deviceKey, tag: uniq('sc-auth-resave-24') };

  assert.equal((await postReport(account, { id, text: 'Authoritative fixture body text for a seeded lifecycle test.', aiStatus: 'ready', aiScore: 2 })).status, 200);

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'incomplete', 'incomplete is preserved exactly like completed — resave never silently upgrades or drops it');
});

test('25. claimedAt is preserved by a normal resave while a claim is in flight', async () => {
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  try {
    const deviceKey = uniq('dk-25');
    const id = uniq('r-25');
    const claimedAt = '2020-01-01 00:00:00';
    await seedPendingReport(deviceKey, id, { claimedAt });
    // AUTH GATE (tightened): see test 23's own comment — a real "claim by
    // resave" from a fresh authenticated account, never anonymous.
    const signedUp = await signUpAccount();
    const account = { ...signedUp, deviceKey, tag: uniq('sc-auth-resave-25') };

    assert.equal((await postReport(account, { id, text: '', aiStatus: 'ready', aiScore: 1 })).status, 200);

    const row = await savedReportRow(deviceKey, id);
    assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'pending');
    assert.equal(row.payload.selectiveCorpusAuthoritativeClaimedAt, claimedAt, 'an in-progress recovery-sweep claim survives an ordinary resave untouched');
  } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
    delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  }
});

// ===========================================================================
// CREATION POLICY (26-27)
// ===========================================================================

test('26. a report created authoritative-pending still finalizes via requiredForAuthoritativePendingReport after both flags flip OFF', async () => {
  delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
  delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  const deviceKey = uniq('dk-26');
  const id = uniq('r-26');
  // Represents a report whose creation-time marker was already persisted
  // while both flags were ON — seeded directly since this test's whole point
  // is what happens to an ALREADY-pending report after the flags flip, not
  // the creation moment itself (covered by test 13/14).
  await seedPendingReport(deviceKey, id);

  // Both flags are OFF right now (see the deletes above) — an ordinary
  // shadow evaluation would return DISABLED, but the deferred/recovery
  // bypass must ignore that live flag entirely for this persisted report.
  const shadowResult = await runSelectiveCorpusShadowEvaluation({
    reportId: id, rawText: 'Authoritative fixture body text for a seeded lifecycle test.',
    authoritativeUnifiedSimilarity: null, requiredForAuthoritativePendingReport: true,
  });
  assert.notEqual(shadowResult.state, 'DISABLED', 'the creation-time policy bypasses the now-OFF live shadow flag');

  const fin = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult,
  });
  assert.equal(fin.outcome, 'finalized', 'the report finalizes per its creation-time policy despite the later flag flip');
  const row = await savedReportRow(deviceKey, id);
  assert.notEqual(row.payload.selectiveCorpusAuthoritativeStatus, 'pending');
});

test('27. an ordinary shadow evaluation with the live shadow flag OFF still returns DISABLED — the internal bypass never leaks to normal callers', async () => {
  delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  const result = await runSelectiveCorpusShadowEvaluation({
    reportId: uniq('r-27'), rawText: 'irrelevant text for this DISABLED-path check only.',
    authoritativeUnifiedSimilarity: null,
    // requiredForAuthoritativePendingReport intentionally omitted — this is
    // exactly the shape every ordinary (non-authoritative) caller uses.
  });
  assert.equal(result.state, 'DISABLED');
});

// ===========================================================================
// CAS / RACES (28-31)
// ===========================================================================

test('28/29. two finalizers race the same pending report: exactly one terminal UPDATE wins, and a losing "incomplete" can never overwrite a winning "completed"', async () => {
  const deviceKey = uniq('dk-28');
  const id = uniq('r-28');
  await seedPendingReport(deviceKey, id);

  const winner = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: completedShadowResult([]),
  });
  assert.deepEqual(winner, { outcome: 'finalized', status: 'completed' });

  // A duplicate/racing finalizer (e.g. a redundant deferred run, or a sweep
  // that also claimed this same row) computing AFTER the winner already
  // committed — must never regress completed -> incomplete.
  const loser = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: timeoutShadowResult(),
  });
  assert.deepEqual(loser, { outcome: 'not-pending' }, 'the finalizer itself detects the row is no longer pending and refuses to touch it');

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'completed', 'completed is never overwritten by a later incomplete duplicate');
});

test('30. persistSelectiveCorpusAuthoritativeFinalization: rowsAffected===0 on an already-terminal row is a clean no-op, not an error', async () => {
  const deviceKey = uniq('dk-30');
  const id = uniq('r-30');
  await seedPendingReport(deviceKey, id);
  await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: completedShadowResult([]),
  });

  // Direct duplicate write attempt at the persistence layer itself (below
  // finalizeSelectiveCorpusAuthoritativeReport's own not-pending short-circuit).
  const write = await persistSelectiveCorpusAuthoritativeFinalization(client, { reportDeviceKey: deviceKey, reportId: id }, {
    unifiedSimilarity: { unifiedScore: 99, uniqueMatchedWords: 0, matchedPositions: [] },
    corpusSourceMatchingEnabled: true, corpusGeneration: 0, terminalStatus: 'incomplete',
  });
  assert.deepEqual(write, { written: false, rowsAffected: 0 });

  const row = await savedReportRow(deviceKey, id);
  assert.notEqual(row.payload.unifiedSimilarity.unifiedScore, 99, 'the no-op write never touched the already-persisted real score');
});

test('31. the existing generation guard remains active alongside the status CAS', async () => {
  const deviceKey = uniq('dk-31');
  const id = uniq('r-31');
  await seedPendingReport(deviceKey, id, { payloadExtra: { unifiedSimilarityGeneration: 5 } });

  // A finalization attempt computed at an OLDER generation than what is
  // already persisted must be rejected by the generation half of the WHERE
  // clause, even though the status half ('pending') would otherwise allow it.
  const staleGenWrite = await persistSelectiveCorpusAuthoritativeFinalization(client, { reportDeviceKey: deviceKey, reportId: id }, {
    unifiedSimilarity: { unifiedScore: 10, uniqueMatchedWords: 0, matchedPositions: [] },
    corpusSourceMatchingEnabled: true, corpusGeneration: 2, terminalStatus: 'completed',
  });
  assert.deepEqual(staleGenWrite, { written: false, rowsAffected: 0 }, 'an older-generation write is rejected even though status is still pending');

  const stillPending = await savedReportRow(deviceKey, id);
  assert.equal(stillPending.payload.selectiveCorpusAuthoritativeStatus, 'pending');

  // A write at a generation >= the persisted one succeeds normally.
  const currentGenWrite = await persistSelectiveCorpusAuthoritativeFinalization(client, { reportDeviceKey: deviceKey, reportId: id }, {
    unifiedSimilarity: { unifiedScore: 20, uniqueMatchedWords: 0, matchedPositions: [] },
    corpusSourceMatchingEnabled: true, corpusGeneration: 5, terminalStatus: 'completed',
  });
  assert.deepEqual(currentGenWrite, { written: true, rowsAffected: 1 });
});

// ===========================================================================
// RECOVERY (32-38)
// ===========================================================================

test('32. a report whose deferred callback never ran is claimed and finalized by the recovery sweep', async () => {
  const deviceKey = uniq('dk-32');
  const id = uniq('r-32');
  // Same-UTC-day, but well past the 10-minute default minAge — this is
  // exactly the ISO-vs-datetime('now') format case that must be handled
  // correctly (see claimStaleSelectiveCorpusAuthoritativePendingReports's
  // own header comment on report_created_at's format).
  const oldButSameDay = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await seedPendingReport(deviceKey, id, { createdAt: oldButSameDay });

  const claimed = await claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection });
  assert.ok(claimed.some((c) => c.reportDeviceKey === deviceKey && c.reportId === id), 'the stale same-day pending report was claimed');

  const fin = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: completedShadowResult([]),
  });
  assert.equal(fin.outcome, 'finalized');
  const row = await savedReportRow(deviceKey, id);
  assert.notEqual(row.payload.selectiveCorpusAuthoritativeStatus, 'pending');
});

test('33. a fresh pending report (younger than minAgeMs) is not claimed', async () => {
  const deviceKey = uniq('dk-33');
  const id = uniq('r-33');
  await seedPendingReport(deviceKey, id, { createdAt: new Date().toISOString() });

  const claimed = await claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection });
  assert.equal(claimed.some((c) => c.reportDeviceKey === deviceKey && c.reportId === id), false, 'a normal fresh pending report must never be classified as abandoned');

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeClaimedAt, undefined, 'left completely untouched');
});

test('34. two concurrent sweep invocations racing the same stale report: only one claim wins', async () => {
  const deviceKey = uniq('dk-34');
  const id = uniq('r-34');
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await seedPendingReport(deviceKey, id, { createdAt: old });

  const [claimedA, claimedB] = await Promise.all([
    claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection }),
    claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection }),
  ]);
  const wonA = claimedA.some((c) => c.reportDeviceKey === deviceKey && c.reportId === id);
  const wonB = claimedB.some((c) => c.reportDeviceKey === deviceKey && c.reportId === id);
  assert.equal(wonA && wonB, false, 'both sweeps racing the same row must never both believe they claimed it fresh in the same window');
  assert.ok(wonA || wonB, 'at least one of the two racing sweeps did claim it');
});

test('35. an abandoned claim becomes reclaimable after the stale-claim threshold', async () => {
  const deviceKey = uniq('dk-35');
  const id = uniq('r-35');
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  // A claim stamped long ago — the worker that made it is presumed dead.
  await seedPendingReport(deviceKey, id, { createdAt: old, claimedAt: '2020-01-01 00:00:00' });

  const claimed = await claimStaleSelectiveCorpusAuthoritativePendingReports({
    openConnection: openTestConnection, staleClaimMs: 10 * 60 * 1000,
  });
  assert.ok(claimed.some((c) => c.reportDeviceKey === deviceKey && c.reportId === id), 'an abandoned (long-stale) claim is reclaimed rather than treated as a permanent lease');
});

test('35b. a recent, in-progress claim is NOT reclaimed', async () => {
  const deviceKey = uniq('dk-35b');
  const id = uniq('r-35b');
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentClaim = new Date().toISOString().slice(0, 19).replace('T', ' '); // SQLite datetime('now') shape, just now
  await seedPendingReport(deviceKey, id, { createdAt: old, claimedAt: recentClaim });

  const claimed = await claimStaleSelectiveCorpusAuthoritativePendingReports({
    openConnection: openTestConnection, staleClaimMs: 10 * 60 * 1000,
  });
  assert.equal(claimed.some((c) => c.reportDeviceKey === deviceKey && c.reportId === id), false, 'a claim made moments ago must not be treated as abandoned');
});

test('36. a sweep-triggered evaluator failure still reaches incomplete finalization when the DB is available', async () => {
  const deviceKey = uniq('dk-36');
  const id = uniq('r-36');
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await seedPendingReport(deviceKey, id, { createdAt: old });

  await claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection });
  // Simulates runSelectiveCorpusShadowEvaluation's own FAILED contract (it
  // never throws — an internal failure surfaces as state:"FAILED", exactly
  // as constructed here).
  const fin = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: failedShadowResult(),
  });
  assert.deepEqual(fin, { outcome: 'finalized', status: 'incomplete' });
});

test('37. a DB failure during sweep finalization leaves the row pending and reclaimable later', async () => {
  const deviceKey = uniq('dk-37');
  const id = uniq('r-37');
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await seedPendingReport(deviceKey, id, { createdAt: old });
  await claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection, staleClaimMs: 1000 });

  const alwaysThrowingClient = { execute: async () => { throw new Error('simulated DB outage during sweep finalization'); }, close() {} };
  const fin = await finalizeSelectiveCorpusAuthoritativeReport(alwaysThrowingClient, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult: completedShadowResult([]),
  });
  assert.deepEqual(fin, { outcome: 'gave-up' });

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'pending');

  // Backdate the claim directly rather than sleeping in real time — SQLite's
  // datetime('now') has whole-second resolution, so a short real sleep can
  // land on the same truncated second as the claim and flakily fail to look
  // "stale" even though real time elapsed. Deterministic and instant instead.
  await client.execute({
    sql: `UPDATE saved_reports SET payload_json = json_set(payload_json, '$.selectiveCorpusAuthoritativeClaimedAt', '2020-01-01 00:00:00') WHERE device_key = ? AND id = ?`,
    args: [deviceKey, id],
  });
  const reclaimed = await claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection, staleClaimMs: 1000 });
  assert.ok(reclaimed.some((c) => c.reportDeviceKey === deviceKey && c.reportId === id), 'the abandoned claim from the failed attempt is reclaimed by a later sweep run');
});

test('38. the recovery runner ignores a later live shadow-flag OFF — the persisted pending marker alone requires completion', async () => {
  delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  const deviceKey = uniq('dk-38');
  const id = uniq('r-38');
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await seedPendingReport(deviceKey, id, { createdAt: old });

  const claimed = await claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: openTestConnection });
  assert.ok(claimed.some((c) => c.reportDeviceKey === deviceKey && c.reportId === id));

  // The sweep's own call site always sets requiredForAuthoritativePendingReport:true.
  const shadowResult = await runSelectiveCorpusShadowEvaluation({
    reportId: id, rawText: 'Authoritative fixture body text for a seeded lifecycle test.',
    authoritativeUnifiedSimilarity: null, requiredForAuthoritativePendingReport: true,
  });
  assert.notEqual(shadowResult.state, 'DISABLED', 'the recovery worker bypasses the live flag exactly like the deferred finalizer does');
  const fin = await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null, shadowResult,
  });
  assert.equal(fin.outcome, 'finalized');
});

// ===========================================================================
// HISTORICAL / UX (39-42)
// ===========================================================================

test('39. a historical report with no marker at all is unaffected by the authoritative flag turning ON', async () => {
  const deviceKey = uniq('dk-39');
  const id = uniq('r-39');
  // No selectiveCorpusAuthoritativeStatus at all — a report saved before this
  // feature existed, or while the flag was off. Its unifiedSimilarity is
  // deliberately left to the PRE-EXISTING, unrelated self-heal/read-time
  // recompute (lib/report-primary-similarity.ts's resolvePrimarySimilaritySummary,
  // called unconditionally by this GET route for any report with no
  // authoritative marker) — that mechanism refreshing a legacy report's score
  // is normal, byte-for-byte unchanged behavior, not something Selective
  // Corpus authoritative promotion controls. What THIS test asserts is the
  // one thing that IS this feature's concern: no selectiveCorpusAuthoritativeStatus
  // marker is ever retroactively added to a historical report just because
  // the flag is enabled later — creation-time-only evaluation (see
  // lib/selective-corpus/flag.ts) means only a genuinely NEW report can ever
  // acquire this marker.
  await seedReport(deviceKey, id, { payloadExtra: { unifiedSimilarity: { unifiedScore: 12, uniqueMatchedWords: 3, matchedPositions: [0, 1, 2] } } });
  const before = await savedReportRow(deviceKey, id);
  assert.equal(before.payload.selectiveCorpusAuthoritativeStatus, undefined);

  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  try {
    const account = { deviceKey, cookie: null, tag: uniq('sc-auth-hist-39') };
    const res = await getReport(account, id);
    assert.equal(res.status, 200);
    const after = await savedReportRow(deviceKey, id);
    assert.equal(after.payload.selectiveCorpusAuthoritativeStatus, undefined, 'a historical report never rolls forward into the authoritative-pending lifecycle merely because the flag is enabled later');
  } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
    delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  }
});

test('40. an authoritative-finalized report is immutable when the flag later turns OFF', async () => {
  const deviceKey = uniq('dk-40');
  const id = uniq('r-40');
  await seedPendingReport(deviceKey, id);
  await finalizeSelectiveCorpusAuthoritativeReport(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: null,
    shadowResult: completedShadowResult([{ sourceLabel: 'S1', matchedPassages: [{ submittedWordStart: 0, submittedWordEnd: 4, matchedWordCount: 5 }] }]),
  });
  const before = await savedReportRow(deviceKey, id);

  delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
  delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  const account = { deviceKey, cookie: null, tag: uniq('sc-auth-hist-40') };
  const res = await getReport(account, id);
  assert.equal(res.status, 200);
  const after = await savedReportRow(deviceKey, id);
  assert.deepEqual(after.payload, before.payload, 'a completed authoritative result is never rewritten or stripped by a later flag rollback');
});

test('41. pending similarity remains non-terminal in the existing polling/reveal logic', () => {
  assert.equal(isSimilarityTerminal('pending'), false);
  assert.equal(isSimilarityTerminal('stale'), false);
  assert.equal(isSimilarityTerminal('resolved'), true);
  assert.equal(isSimilarityTerminal('failed'), true);
});

test('42. no final numeric score is exposed before V4 finalization, via GET or the display resolver', async () => {
  const deviceKey = uniq('dk-42');
  const id = uniq('r-42');
  await seedPendingReport(deviceKey, id);

  const account = { deviceKey, cookie: null, tag: uniq('sc-auth-hist-42') };
  const res = await getReport(account, id);
  const body = await res.json();
  assert.equal(body.payload?.unifiedSimilarity?.unifiedScore, undefined);
  assert.equal(body.payload?.score, 0, 'the only numeric field present is the pre-existing, non-final archive score placeholder — never a substituted unified result');

  const display = await resolvePersistedSimilarityDisplay(client, {
    reportDeviceKey: deviceKey, reportId: id, archiveScore: 0,
    unifiedScore: null, hasUnifiedSimilarity: false,
    corpusSourceMatchingEnabledAtComputation: null, unifiedSimilarityFailed: false, hasPositionEvidence: false,
  });
  assert.equal('primaryScore' in display, false, 'the pending display variant carries no score field at all');
});

// ===========================================================================
// CLIENT FORGERY / TRUST BOUNDARY (final-review blocking finding, fixed)
// ===========================================================================
//
// app/api/reports/route.ts's persistedReportPayload used to spread the raw,
// unvalidated client `payload` object with no override for unifiedSimilarity /
// unifiedSimilarityFailed / unifiedSimilarityGeneration /
// corpusSourceMatchingEnabledAtComputation — the ordinary success/failure
// branches always re-set these from real server values, but the Selective
// Corpus authoritative-pending "no-op" branch (deliberately skipping any
// write-time finalization while pending) did not, so a client-forged value
// for any of these four keys would have survived verbatim into payload_json,
// making hasUnifiedSimilarity look true and similarityStatus surface as
// "resolved" instead of "pending". Fixed by explicitly overriding all four
// to undefined in the SAME base object literal that already overrides
// externalAcademicEvidence/verifiedAcademicSearchDiagnosticsId — applies
// unconditionally to every save, not just the pending branch.

const FORGED_SIMILARITY_FIELDS = {
  unifiedSimilarity: { version: 'forged-v0', wordCount: 1, unifiedScore: 987654, uniqueMatchedWords: 1, matchedPositions: [0] },
  unifiedSimilarityFailed: 'not-a-real-boolean-forged-value',
  unifiedSimilarityGeneration: 999999,
  corpusSourceMatchingEnabledAtComputation: 'forged-flag-value',
};

test('FORGERY 1: authoritative-pending first save — a forged client unifiedSimilarity/*, cannot survive; report reads back pending, never resolved', async () => {
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  try {
    const account = await signUpAccount();
    const id = uniq('r-forge-1');
    // Empty text -> shadowEvaluationInputs stays null -> scheduling never
    // fires this save, so the row genuinely stays pending after POST returns
    // in this synchronous test harness (see seedReport's own header comment)
    // — isolating the trust-boundary fix from any real finalization timing.
    const res = await postReport(account, { id, text: '', aiStatus: 'processing', aiScore: null, forgedPayloadFields: FORGED_SIMILARITY_FIELDS });
    assert.equal(res.status, 200, 'the save itself must still succeed — forged fields are silently dropped, not rejected');

    const row = await savedReportRow(account.deviceKey, id);
    assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'pending');
    assert.equal(row.payload.unifiedSimilarity, undefined, 'the forged unifiedSimilarity object never reaches payload_json');
    assert.equal(row.payload.unifiedSimilarityFailed, undefined, 'the forged unifiedSimilarityFailed value never reaches payload_json');
    assert.equal(row.payload.unifiedSimilarityGeneration, undefined, 'the forged unifiedSimilarityGeneration value never reaches payload_json');
    assert.equal(row.payload.corpusSourceMatchingEnabledAtComputation, undefined, 'the forged corpusSourceMatchingEnabledAtComputation value never reaches payload_json — not legitimately set by the server for this deferred save');

    const display = await resolvePersistedSimilarityDisplay(client, {
      reportDeviceKey: account.deviceKey, reportId: id, archiveScore: 0,
      unifiedScore: null, hasUnifiedSimilarity: row.payload.unifiedSimilarity !== undefined,
      corpusSourceMatchingEnabledAtComputation: row.payload.corpusSourceMatchingEnabledAtComputation ?? null,
      unifiedSimilarityFailed: Boolean(row.payload.unifiedSimilarityFailed), hasPositionEvidence: false,
    });
    assert.deepEqual(display, { status: 'pending' }, 'similarityStatus reads pending, never resolved, despite the forged submission');

    // AUTH GATE: this report is now account-owned (a genuinely new save
    // requires authentication), so reading it back must use the SAME
    // account's session — an anonymous device-key GET would no longer find
    // it at all (the anonymous lookup excludes owned reports by design).
    const account2 = { deviceKey: account.deviceKey, cookie: account.cookie, tag: uniq('sc-auth-forge1-get') };
    const getRes = await getReport(account2, id);
    const body = await getRes.json();
    assert.equal(body.payload?.unifiedSimilarity, undefined, 'GET never echoes the forged score back either');
  } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
    delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  }
});

test('FORGERY 2: authoritative-pending resave (AI/Wikipedia-style) — forged values in the resave payload cannot overwrite the pending marker or plant a score', async () => {
  const deviceKey = uniq('dk-forge-2');
  const id = uniq('r-forge-2');
  await seedPendingReport(deviceKey, id);
  // AUTH GATE (tightened): see test 23's own comment — a real "claim by
  // resave" from a fresh authenticated account, never anonymous.
  const signedUp = await signUpAccount();
  const account = { ...signedUp, deviceKey, tag: uniq('sc-auth-forge2') };

  const res = await postReport(account, { id, text: '', aiStatus: 'ready', aiScore: 4, forgedPayloadFields: FORGED_SIMILARITY_FIELDS });
  assert.equal(res.status, 200);

  const row = await savedReportRow(deviceKey, id);
  assert.equal(row.payload.selectiveCorpusAuthoritativeStatus, 'pending', 'the pending marker survives the forged resave untouched');
  assert.equal(row.payload.unifiedSimilarity, undefined, 'still no score after the forged resave');
  assert.equal(row.payload.unifiedSimilarityFailed, undefined);
  assert.equal(row.payload.unifiedSimilarityGeneration, undefined);
  assert.equal(row.aiStatus, 'ready', 'sanity: the resave itself really did apply (AI fields updated) — only the four protected similarity fields were stripped');
});

test('FORGERY 3: ordinary (non-authoritative) success save — a forged client unifiedSimilarity is replaced by the real server-computed result', async () => {
  delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
  delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  const account = await signUpAccount();
  const id = uniq('r-forge-3');
  const text = 'A wholly unique paragraph used only for this forgery regression test, describing a fictional expedition cataloguing lichen species across a remote basalt plateau over three consecutive summers.';

  const res = await postReport(account, { id, text, forgedPayloadFields: FORGED_SIMILARITY_FIELDS });
  assert.equal(res.status, 200);

  const row = await savedReportRow(account.deviceKey, id);
  assert.ok(row.payload.unifiedSimilarity, 'a real result was persisted');
  assert.notEqual(row.payload.unifiedSimilarity.unifiedScore, 987654, 'the forged score is gone');
  assert.notEqual(row.payload.unifiedSimilarity.version, 'forged-v0', 'the forged shape is gone — this is a genuine computeUnifiedSimilarity result');
  assert.equal(row.payload.unifiedSimilarity.wordCount, tokens(canonicalizeText(text)).length, 'the real word count for THIS submission, not the forged wordCount:1');
  assert.equal(row.payload.unifiedSimilarityFailed, false, 'server-set false, not the forged non-boolean value');
  assert.equal(typeof row.payload.unifiedSimilarityGeneration, 'number', 'server-set real generation, not the forged 999999 sentinel');
  assert.notEqual(row.payload.unifiedSimilarityGeneration, 999999);
  assert.equal(typeof row.payload.corpusSourceMatchingEnabledAtComputation, 'boolean', 'server-set real boolean flag snapshot, not the forged string value');
});

test('FORGERY 4: an existing skip/edge path (empty-text save, no legitimate server score) — a forged unifiedSimilarity cannot survive either', async () => {
  delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
  delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  const account = await signUpAccount();
  const id = uniq('r-forge-4');

  // Reuses the SAME existing empty-text edge case already relied on elsewhere
  // in this file (e.g. FORGERY 1/2, test 22) — isNonEmptyString(reportPayload.text)
  // is false, so app/api/reports/route.ts's own write-time finalization block
  // never runs at all for this save; no legitimate server unifiedSimilarity
  // is ever computed for it.
  const res = await postReport(account, { id, text: '', forgedPayloadFields: FORGED_SIMILARITY_FIELDS });
  assert.equal(res.status, 200);

  const row = await savedReportRow(account.deviceKey, id);
  assert.equal(row.payload.unifiedSimilarity, undefined, 'no legitimate score exists for this save, and the forged one does not fill the gap');
  assert.equal(row.payload.unifiedSimilarityFailed, undefined);
  assert.equal(row.payload.unifiedSimilarityGeneration, undefined);
  assert.equal(row.payload.corpusSourceMatchingEnabledAtComputation, undefined);
});

// ===========================================================================
// bonus: selectSelectiveCorpusFinalizationEvidence pure policy mapping
// ===========================================================================

test('bonus: selectSelectiveCorpusFinalizationEvidence maps every terminal state to the documented evidence/status policy', () => {
  assert.deepEqual(
    selectSelectiveCorpusFinalizationEvidence(completedShadowResult([{ sourceLabel: 'S1', matchedPassages: [{ submittedWordStart: 0, submittedWordEnd: 1, matchedWordCount: 2 }] }])),
    { evidence: [{ sourceId: 'S1', matchedPassages: [{ submittedWordStart: 0, submittedWordEnd: 1, matchedWordCount: 2 }] }], terminalStatus: 'completed' },
  );
  assert.deepEqual(selectSelectiveCorpusFinalizationEvidence(completedShadowResult([])), { evidence: null, terminalStatus: 'completed' });
  assert.deepEqual(
    selectSelectiveCorpusFinalizationEvidence(partialShadowResult([{ sourceLabel: 'S1', matchedPassages: [{ submittedWordStart: 0, submittedWordEnd: 1, matchedWordCount: 2 }] }])).terminalStatus,
    'incomplete',
  );
  assert.deepEqual(selectSelectiveCorpusFinalizationEvidence(timeoutShadowResult()), { evidence: null, terminalStatus: 'incomplete' });
  assert.deepEqual(selectSelectiveCorpusFinalizationEvidence(artifactUnavailableShadowResult()), { evidence: null, terminalStatus: 'incomplete' });
  assert.deepEqual(selectSelectiveCorpusFinalizationEvidence(failedShadowResult()), { evidence: null, terminalStatus: 'incomplete' });
});

console.log('selective-corpus-authoritative-lifecycle: lifecycle + resave + creation-policy + CAS + recovery + historical/UX + client-forgery trust-boundary tests passed');
