import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { webcrypto, createHash, randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { resetRateForTest, resetReadRateForTest, resetAuthRateForTest } from '../lib/rate-limit.ts';
import { createDocumentIdentity } from '../lib/document-identity.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";
import { tokens } from '../lib/similarity-core.ts';
import { canonicalizeText } from '../lib/canonical-text.ts';
import { resolvePrimarySimilaritySummary } from '../lib/report-primary-similarity.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';
import { scheduleReportShadowEvaluations } from '../lib/report-shadow-evaluations.ts';
import { PROPOSED_ACCEPTANCE_POLICY_VERSION } from '../lib/e8o-historical-match-policy.ts';
import { DEVICE_PROVENANCE_SHADOW_POLICY_VERSION } from '../lib/device-provenance-shadow.ts';
import {
  derivePassportId,
  buildDevicePassportSignedMessage,
  createDevicePassportChallenge,
  DEVICE_PASSPORT_ALGORITHM,
} from '../lib/device-passport-server.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';

/**
 * Device Passport / historical-match shadow-telemetry trigger handoff for
 * write-time-finalized reports.
 *
 * Confirmed bug this covers: runHistoricalMatchShadowEvaluation and
 * runDeviceProvenanceShadowEvaluation were triggered ONLY from
 * GET /api/reports/[id]. A report whose authoritative similarity + AI both
 * finalize during POST /api/reports is frequently never fetched through that
 * GET route, so its shadow rows never appeared.
 *
 * Fix under test: POST /api/reports now schedules the SAME evaluators
 * (via the shared lib/report-shadow-evaluations.ts helper) in
 * runAfterResponse, after the report row is persisted — GET keeps its
 * trigger as a fallback/self-heal. Neither path recomputes or mutates the
 * production score; both are idempotent (UPSERT per
 * report_device_key + report_id + policy_version).
 */

const repoRoot = path.resolve('.');
const drizzleDir = path.join(repoRoot, 'drizzle');
const dbFile = path.join(repoRoot, 'test_report_shadow_evaluation_trigger.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
const originalPassportFlag = process.env.DEVICE_PASSPORT_ENABLED;

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  if (originalPassportFlag === undefined) delete process.env.DEVICE_PASSPORT_ENABLED;
  else process.env.DEVICE_PASSPORT_ENABLED = originalPassportFlag;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// fixtures + helpers
// ---------------------------------------------------------------------------

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;
const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
const SAME_ORIGIN = { origin: 'http://localhost', host: 'localhost' };

// Distinct ~70-word paragraphs — a real global shingle search runs, so no two
// scenarios may cross-match.
const TEXT_POOL = [
  'Hydrologists modelling a semi-arid catchment found that antecedent soil moisture explained more of the variance in flash-flood peak discharge than rainfall intensity alone, a result that held across three independent storm events instrumented with dense tipping-bucket networks and confirmed by post-event channel surveys measuring high-water marks along the main stem and its two largest tributaries.',
  'Ornithologists banding migratory warblers at a coastal stopover site recorded a consistent multi-day fuelling deficit in years when an offshore wind regime suppressed the emergence of the midges the birds depend on, linking a small-scale insect phenology shift to measurable downstream consequences for the birds arrival condition on the breeding grounds far to the north.',
  'Materials scientists characterising a new layered oxide for sodium-ion cathodes observed a reversible phase transition during cycling that, contrary to expectation, improved rate capability rather than degrading it, because the transition opened a wider diffusion channel for the sodium ions at exactly the state of charge where the older material bottlenecked most severely under fast charging.',
  'Historians re-examining port customs ledgers from a mid-sized medieval trading city reconstructed a decade of grain price movements fine enough to show that a single poor harvest propagated through the regional market in under six weeks, far faster than the overland transport times of the period would naively suggest, implying an active forward market the surviving narrative sources never mention.',
  'Volcanologists deploying a temporary broadband seismic array around a restless caldera distinguished shallow hydrothermal tremor from deeper magmatic signals by their contrasting spectral decay, and used the separation to argue that the most recent unrest episode was driven by pressurised water rather than fresh melt, easing the near-term eruption forecast for the surrounding valley communities.',
  'Immunologists tracking a cohort of transplant recipients found that a specific pattern of early T-cell receptor diversity recovery predicted long-term graft tolerance better than any single cytokine marker, and that the pattern was already visible in peripheral blood within the first month, well before conventional biopsy-based rejection scoring would have flagged any concern.',
  'Agronomists comparing cover-crop mixtures on a long-term tillage trial measured the largest gains in springtime nitrogen availability under a legume-heavy blend that also suppressed early weed emergence, and traced the effect to a faster residue breakdown rate that released mineral nitrogen just as the following cash crop entered its rapid uptake window rather than weeks too early.',
  'Linguists analysing a century of regional newspaper archives charted the retreat of a distinctive dialect pronoun from print, finding that it survived longest in classified advertisements and letters to the editor, the two genres where an editor was least likely to standardise the copy, which the authors treat as a rough proxy for its persistence in everyday speech.',
  'Cardiologists reviewing wearable-monitor data from an endurance-athlete registry identified a small subgroup whose nocturnal heart-rate recovery plateaued for several days after their hardest training blocks, a signal that preceded self-reported fatigue and minor illness by roughly a week and that coaches could in principle use to time recovery days more precisely.',
  'Mycologists surveying decaying logs across an elevation gradient found that wood-decay fungal communities turned over more sharply with elevation than the surrounding plant communities did, suggesting that temperature acts more directly on the decomposer layer and that carbon-release models calibrated only to vegetation zones may misplace the fastest-cycling stands.',
];
let textCursor = 0;
const takeText = () => {
  if (textCursor >= TEXT_POOL.length) throw new Error('text pool exhausted');
  return TEXT_POOL[textCursor++];
};

async function ensureUser(accountId) {
  if (!accountId) return;
  await client.execute({
    sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
    args: [accountId, `${accountId}@ex.test`, accountId, 'not-a-real-hash'],
  });
}

/** A real prior submission by ANOTHER account — makes a report of the same text a MATCHED / counted PRIOR_SUBMISSION. */
async function indexPriorSubmission(accountId, text) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: 'prior', author: null, rawText: text });
  const _r = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
  await matureCorpusBackings(client); // Phase A: age the seeded backing so it is matchable "now"
  return _r;
}

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const m = setCookie.match(/tp_session_v1=([^;]*)/);
  return m ? m[1] : null;
}

let userCounter = 0;
async function signUpAccount() {
  userCounter += 1;
  const tag = `shadow-trigger-signup-${userCounter}`;
  const email = `shadow-trigger-user-${userCounter}@example.test`;
  const deviceKey = `shadow-trigger-device-${userCounter}`;
  await resetAuthRateForTest(tag);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': tag },
    body: JSON.stringify({ email, password: 'shadow-trigger-pw-1', username: `shtrig${userCounter}`, deviceKey }),
  }));
  assert.equal(res.status, 201, 'signup must succeed');
  const row = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return { userId: String(row.rows[0].id), deviceKey, cookie: extractCookie(res), tag: `shadow-trigger-${userCounter}` };
}

async function postReport(account, { id, text, room = 0, aiStatus = 'ready', aiScore = 3, devicePassport, extraHeaders } = {}) {
  const wordCount = tokens(canonicalizeText(text)).length;
  await resetRateForTest(account.tag + '-post');
  const body = {
    deviceKey: account.deviceKey,
    id,
    submissionId: 'sub-' + id,
    title: 'Shadow trigger fixture',
    createdAt: new Date().toISOString(),
    wordCount,
    archiveScore: 0,
    scoreBand: 'Low',
    aiScore: aiScore ?? null,
    aiTone: aiScore != null ? 'low' : null,
    aiStatus,
    payload: {
      version: 11, id: 1, submissionId: 'sub-' + id, title: 'Shadow trigger fixture',
      author: '', assignment: '', created: new Date().toISOString(),
      score: 0, archiveScore: 0, wordCount, scoreBand: 'Low', matchedWordCount: 0,
      sources: [], repeats: [], text,
    },
  };
  if (account.cookie) body.room = room;
  if (devicePassport) body.devicePassport = devicePassport;
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': account.tag + '-post',
      ...(account.cookie ? { cookie: `tp_session_v1=${account.cookie}` } : {}),
      ...(extraHeaders ?? {}),
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

async function shadowRows(deviceKey, reportId) {
  const r = await client.execute({
    sql: 'SELECT * FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ? ORDER BY policy_version',
    args: [deviceKey, reportId],
  });
  return r.rows.map((row) => ({ ...row }));
}
const rowFor = (rows, policyVersion) => rows.find((r) => String(r.policy_version) === policyVersion) ?? null;
const e8pRow = (rows) => rowFor(rows, PROPOSED_ACCEPTANCE_POLICY_VERSION);
const deviceRow = (rows) => rowFor(rows, DEVICE_PROVENANCE_SHADOW_POLICY_VERSION);

async function savedReport(deviceKey, id) {
  const r = await client.execute({
    sql: 'SELECT archive_score, ai_score, ai_status, payload_json FROM saved_reports WHERE device_key = ? AND id = ?',
    args: [deviceKey, id],
  });
  const row = r.rows[0];
  return row ? { archiveScore: Number(row.archive_score), aiScore: row.ai_score, aiStatus: row.ai_status, payload: JSON.parse(String(row.payload_json)) } : null;
}

/** A verified device-passport attestation for an anonymous POST /api/reports of `text` with `reportId`. */
async function makeAttestation(text, reportId) {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spkiDer = Buffer.from(await webcrypto.subtle.exportKey('spki', kp.publicKey));
  const passportId = derivePassportId(spkiDer);
  await client.execute({
    sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, last_seen_at, revoked_at, provenance_generation)
          VALUES (?,?,?,?,NULL,NULL,0) ON CONFLICT(id) DO NOTHING`,
    args: [passportId, spkiDer, DEVICE_PASSPORT_ALGORITHM, Date.now()],
  });
  const { challengeId, nonce } = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const message = buildDevicePassportSignedMessage({
    nonceBase64: nonce, challengeId, method: 'POST', path: '/api/reports',
    payloadTextSha256Hex: sha256Hex(Buffer.from(text, 'utf8')), reportId,
  });
  const signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, message)).toString('base64');
  return { passportId, devicePassport: { challengeId, nonce, publicKeySpki: spkiDer.toString('base64'), signature } };
}

function productionNoMatch() {
  return { status: 'NO_HISTORICAL_MATCH', computedAt: new Date().toISOString(), matcherVersion: 'x', fingerprintVersion: 'x', canonicalizationVersion: 'x' };
}

// ===========================================================================
// 1. POST-finalized report schedules the historical-match shadow evaluation
// ===========================================================================

test('1. a report finalized during POST /api/reports schedules the historical-match shadow evaluation — no GET needed', async () => {
  const text = takeText();
  await indexPriorSubmission(uniq('prior-acc'), text);
  const account = await signUpAccount();
  const reportId = 'shadow-trigger-post-e8p';

  const res = await postReport(account, { id: reportId, text, room: 0 });
  assert.equal(res.status, 200, 'the save itself must succeed');

  // No GET /api/reports/[id] call at all.
  const rows = await shadowRows(account.deviceKey, reportId);
  const e8p = e8pRow(rows);
  assert.ok(e8p, 'the E8P historical-match shadow row must exist purely from the POST lifecycle');
  assert.equal(String(e8p.status), 'OK');
  assert.equal(String(e8p.production_status), 'MATCHED', 'it recorded the real production result from write-time finalization');
  assert.ok(Number(e8p.total_runtime_ms) >= 0);
});

// ===========================================================================
// 2. POST with a verified Device Passport schedules the device-provenance shadow
// ===========================================================================

test('2. a POST-finalized report with a verified Device Passport schedules the device-provenance shadow evaluation too', async () => {
  process.env.DEVICE_PASSPORT_ENABLED = 'true';
  try {
    const text = takeText();
    const deviceKey = uniq('dpp-dev');
    const reportId = 'shadow-trigger-post-devicepassport';
    const account = { deviceKey, cookie: null, tag: uniq('dpp') };
    const { passportId, devicePassport } = await makeAttestation(text, reportId);

    const res = await postReport(account, { id: reportId, text, aiStatus: 'ready', aiScore: 2, devicePassport, extraHeaders: SAME_ORIGIN });
    assert.equal(res.status, 200);

    // sanity: provenance was captured in the same transaction as the insert
    const stored = (await client.execute({ sql: 'SELECT verified_device_passport_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, reportId] })).rows[0];
    assert.equal(String(stored.verified_device_passport_id), passportId, 'test setup sanity: the verified passport must be persisted');

    // No GET call.
    const rows = await shadowRows(deviceKey, reportId);
    assert.ok(e8pRow(rows), 'the historical-match shadow still runs regardless of the passport');
    const device = deviceRow(rows);
    assert.ok(device, 'the device-provenance shadow row must exist purely from the POST lifecycle');
    assert.equal(String(device.status), 'OK');
    const evidence = JSON.parse(String(device.proposed_evidence));
    assert.equal(evidence.hasReportPassport, true, 'the device evaluator saw the report’s verified upload passport');

    // the passport secret never reaches the POST response body
    const bodyText = await res.text();
    for (const forbidden of [passportId, devicePassport.signature, devicePassport.nonce, devicePassport.challengeId, 'verified_device_passport_id']) {
      assert.equal(bodyText.includes(forbidden), false, `POST response leaked ${String(forbidden).slice(0, 20)}`);
    }
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
  }
});

// ===========================================================================
// 3. No verified Device Passport does not break report save
// ===========================================================================

test('3. a report with no verified Device Passport saves fine — device evaluator skips, historical-match evaluator still runs', async () => {
  process.env.DEVICE_PASSPORT_ENABLED = 'true'; // flag ON, but this report simply has no passport
  try {
    const text = takeText();
    await indexPriorSubmission(uniq('prior-acc'), text);
    const account = await signUpAccount();
    const reportId = 'shadow-trigger-no-passport';

    const res = await postReport(account, { id: reportId, text, room: 0, aiStatus: 'ready', aiScore: 5 });
    assert.equal(res.status, 200, 'the save must not be affected by the absence of a passport');

    const saved = await savedReport(account.deviceKey, reportId);
    assert.ok(saved, 'the report row is persisted');
    assert.ok(saved.payload.unifiedSimilarity, 'write-time finalization still ran');

    const rows = await shadowRows(account.deviceKey, reportId);
    assert.ok(e8pRow(rows), 'the historical-match shadow evaluator still behaves per its existing contract');
    assert.equal(deviceRow(rows), null, 'the device-provenance evaluator skipped as designed — no verified upload passport');
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
  }
});

// ===========================================================================
// 4. A shadow-evaluator / telemetry failure never fails the caller
// ===========================================================================

test('4. a failure inside the deferred shadow work never rejects out of scheduleReportShadowEvaluations (POST and GET both rely on this)', async () => {
  // a connection factory that throws synchronously — stands in for any
  // failure reaching the deferred work (broken pool, driver error, ...)
  await assert.doesNotReject(() => scheduleReportShadowEvaluations({
    reportDeviceKey: 'dk-fail-1', reportId: 'r-fail-1', accountId: null,
    rawText: 'irrelevant text for this case only.', productionResult: productionNoMatch(),
    authoritativeUnifiedSimilarity: null, effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 0,
    authoritativeArchiveMatchedPositions: null, authoritativeExternalAcademicEvidence: null,
    openConnection: () => { throw new Error('simulated deferred-connection failure'); },
  }));

  // a client whose every statement throws — exercises the evaluators' own
  // internal catch AND the scheduler's outer safety net together
  await assert.doesNotReject(() => scheduleReportShadowEvaluations({
    reportDeviceKey: 'dk-fail-2', reportId: 'r-fail-2', accountId: 'acc',
    rawText: takeText(),
    productionResult: { status: 'MATCHED', matches: [], computedAt: new Date().toISOString(), matcherVersion: 'x', fingerprintVersion: 'x', canonicalizationVersion: 'x' },
    authoritativeUnifiedSimilarity: null, effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 0,
    authoritativeArchiveMatchedPositions: null, authoritativeExternalAcademicEvidence: null,
    openConnection: () => ({ execute: async () => { throw new Error('simulated historical_match_shadow_evaluations outage'); }, close() {} }),
  }));

  const n = await client.execute("SELECT COUNT(*) AS n FROM historical_match_shadow_evaluations WHERE report_id IN ('r-fail-1','r-fail-2')");
  assert.equal(Number(n.rows[0].n), 0, 'a failed scheduler run persists nothing');
});

// ===========================================================================
// 5. GET /api/reports/[id] still schedules the evaluations (fallback / self-heal)
// ===========================================================================

test('5. GET /api/reports/[id] still schedules both evaluations — the fallback path is unchanged by the refactor', async () => {
  process.env.DEVICE_PASSPORT_ENABLED = 'true';
  try {
    const text = takeText();
    await indexPriorSubmission(uniq('prior-acc'), text);

    // A "legacy" report: seed the row directly, so POST never scheduled anything for it.
    const deviceKey = uniq('legacy-dev');
    const reportId = 'shadow-trigger-get-fallback';
    const wordCount = tokens(canonicalizeText(text)).length;
    const { passportId } = await makeAttestation(text, reportId);
    const payload = JSON.stringify({ version: 11, id: 1, submissionId: 'sub', title: 't', text, wordCount, score: 0, archiveScore: 0, sources: [], repeats: [] });
    await client.execute({
      sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [reportId, deviceKey, 'sub', 't', new Date().toISOString(), wordCount, 0, 'Low', payload, null, passportId],
    });

    assert.deepEqual(await shadowRows(deviceKey, reportId), [], 'no shadow rows before the report is ever viewed');

    const account = { deviceKey, cookie: null, tag: uniq('legacy') };
    const res = await getReport(account, reportId);
    assert.equal(res.status, 200);

    const rows = await shadowRows(deviceKey, reportId);
    assert.ok(e8pRow(rows), 'GET still schedules the historical-match shadow evaluation');
    assert.ok(deviceRow(rows), 'GET still schedules the device-provenance shadow evaluation');
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
  }
});

// ===========================================================================
// 6. Repeated POST / GET stays idempotent — one logical row per policy
// ===========================================================================

test('6. repeated POST + GET upsert the same policy row rather than duplicating it', async () => {
  process.env.DEVICE_PASSPORT_ENABLED = 'true';
  try {
    const text = takeText();
    await indexPriorSubmission(uniq('prior-acc'), text);
    const deviceKey = uniq('idem-dev');
    const reportId = 'shadow-trigger-idempotent';
    const account = { deviceKey, cookie: null, tag: uniq('idem') };
    const { devicePassport } = await makeAttestation(text, reportId);

    assert.equal((await postReport(account, { id: reportId, text, aiStatus: 'processing', aiScore: null, devicePassport, extraHeaders: SAME_ORIGIN })).status, 200);
    // resave (AI completes) — no fresh challenge, so no passport this time
    assert.equal((await postReport(account, { id: reportId, text, aiStatus: 'ready', aiScore: 4 })).status, 200);
    assert.equal((await getReport(account, reportId)).status, 200);
    assert.equal((await getReport(account, reportId)).status, 200);

    const counts = await client.execute({
      sql: 'SELECT policy_version, COUNT(*) AS n FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ? GROUP BY policy_version',
      args: [deviceKey, reportId],
    });
    assert.ok(counts.rows.length >= 1);
    for (const row of counts.rows) {
      assert.equal(Number(row.n), 1, `exactly one row for policy_version=${row.policy_version} after 2 POSTs + 2 GETs`);
    }
    const policies = counts.rows.map((r) => String(r.policy_version)).sort();
    assert.deepEqual(policies, [DEVICE_PROVENANCE_SHADOW_POLICY_VERSION, PROPOSED_ACCEPTANCE_POLICY_VERSION].sort(), 'both policies present, one row each');
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
  }
});

// ===========================================================================
// 7. Production unified score is unchanged by the shadow scheduling
// ===========================================================================

test('7. the persisted production unified score is byte-for-byte identical with the shadow scheduling in the POST/GET lifecycle', async () => {
  const text = takeText();
  await indexPriorSubmission(uniq('prior-acc'), text);
  const account = await signUpAccount();
  const reportId = 'shadow-trigger-score-invariance';

  assert.equal((await postReport(account, { id: reportId, text, room: 0, aiStatus: 'ready', aiScore: 3 })).status, 200);

  const afterPost = await savedReport(account.deviceKey, reportId);
  assert.ok(afterPost.payload.unifiedSimilarity, 'a real unified result was finalized');
  const scoreJson = JSON.stringify(afterPost.payload.unifiedSimilarity);
  const archiveScore = afterPost.archiveScore;

  // Independently recompute what production would settle on — must equal the persisted value.
  const resolution = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: account.deviceKey, reportId, accountId: account.userId, rawText: text,
    wordCount: tokens(canonicalizeText(text)).length, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
  });
  const independent = computeUnifiedSimilarity({
    wordCount: tokens(canonicalizeText(text)).length, archiveMatchedPositions: null, externalAcademicEvidence: null,
    historicalSubmissionMatch: resolution.historicalSubmissionMatch,
  });
  assert.equal(afterPost.payload.unifiedSimilarity.unifiedScore, independent.unifiedScore, 'persisted score equals an independent recompute');

  // Now drive the shadow evaluators hard: GET twice + direct calls.
  await getReport(account, reportId);
  await getReport(account, reportId);
  for (let i = 0; i < 3; i += 1) {
    await scheduleReportShadowEvaluations({
      reportDeviceKey: account.deviceKey, reportId, accountId: account.userId, rawText: text,
      productionResult: resolution.historicalSubmissionMatch,
      authoritativeUnifiedSimilarity: resolution.unifiedSimilarity ?? null,
      effectiveDeviceSelfRepresentationIds: resolution.effectiveDeviceSelfRepresentationIds,
      authoritativeCorpusGeneration: resolution.corpusGeneration,
      authoritativeArchiveMatchedPositions: null,
      authoritativeExternalAcademicEvidence: null,
    });
  }

  const afterShadow = await savedReport(account.deviceKey, reportId);
  assert.equal(JSON.stringify(afterShadow.payload.unifiedSimilarity), scoreJson, 'unifiedSimilarity JSON unchanged by any amount of shadow evaluation');
  assert.equal(afterShadow.archiveScore, archiveScore, 'archive_score unchanged');
  assert.equal(afterShadow.payload.unifiedSimilarityFailed ?? false, false);

  const reResolve = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: account.deviceKey, reportId, accountId: account.userId, rawText: text,
    wordCount: tokens(canonicalizeText(text)).length, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
  });
  assert.deepEqual(reResolve.historicalSubmissionMatch, resolution.historicalSubmissionMatch, 'the real historical-match result is stable across shadow runs');
});

// ===========================================================================
// 8. Existing privacy / auth behaviour is unchanged
// ===========================================================================

test('8. auth still gates GET, non-admin responses still carry no internal match/telemetry data, and the shadow rows leak nothing', async () => {
  process.env.DEVICE_PASSPORT_ENABLED = 'true';
  try {
    const text = takeText();
    const priorAccount = 'shadow-trigger-canary-prior';
    await indexPriorSubmission(priorAccount, text);

    const owner = await signUpAccount();
    const reportId = 'shadow-trigger-privacy';
    assert.equal((await postReport(owner, { id: reportId, text, room: 0, aiStatus: 'ready', aiScore: 3 })).status, 200);

    // the owner (non-admin) GET response carries none of the internal signals
    const res = await getReport(owner, reportId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.payload.historicalSubmissionMatch, undefined, 'historicalSubmissionMatch stays admin-only');
    assert.equal(body.payload.matchClassification, undefined, 'matchClassification stays admin-only');
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /historical_match_shadow_evaluations|proposed_evidence|wouldDowngrade|DISAGREE_/, 'no shadow-telemetry field leaks into the report response');
    assert.doesNotMatch(raw, new RegExp(`${priorAccount}@ex\\.test`), 'no backing account email reaches the owner');

    // a stranger with a wrong device key cannot read it
    await resetReadRateForTest('shadow-trigger-stranger');
    const strangerRes = await reportIdRoute.GET(
      new Request(`http://localhost/api/reports/${reportId}?deviceKey=${encodeURIComponent('not-the-owner-device')}`, { headers: { 'x-forwarded-for': 'shadow-trigger-stranger' } }),
      { params: Promise.resolve({ id: reportId }) },
    );
    assert.equal(strangerRes.status, 404, 'auth/ownership check on GET is unchanged');

    // the persisted shadow rows themselves are bounded telemetry — no text / account / email
    const rows = await shadowRows(owner.deviceKey, reportId);
    assert.ok(rows.length >= 1);
    const serialized = JSON.stringify(rows);
    for (const forbidden of [owner.userId, `${priorAccount}@ex.test`, priorAccount, text.slice(0, 40), 'password_hash']) {
      assert.equal(serialized.includes(forbidden), false, `shadow row leaked: ${String(forbidden).slice(0, 24)}`);
    }
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
  }
});

console.log('report-shadow-evaluation-trigger: POST trigger + GET fallback + idempotency + score invariance + privacy passed');
