import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'node:os';
import { webcrypto, createHash, randomUUID } from 'node:crypto';
import { hashToken } from '../lib/auth-session.ts';
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
import { SELECTIVE_CORPUS_EXPECTED_DIGEST } from '../lib/selective-corpus/constants.ts';
import { clearSelectiveCorpusArtifactCache } from '../lib/selective-corpus/artifact.ts';
import {
  derivePassportId,
  buildDevicePassportSignedMessage,
  createDevicePassportChallenge,
  DEVICE_PASSPORT_ALGORITHM,
} from '../lib/device-passport-server.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';

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
 * runAfterResponse, after the report row is persisted. Never recomputes or
 * mutates the production score; idempotent (UPSERT per
 * report_device_key + report_id + policy_version).
 *
 * REPORT-LIFECYCLE CORRECTNESS FIX (customer historical-GET purity):
 * GET /api/reports/[id] no longer schedules these evaluations at all — its
 * own former "fallback/self-heal" trigger was itself a DB write (an UPSERT
 * into historical_match_shadow_evaluations / device_provenance_shadow_
 * evaluations) reachable from an ordinary customer read, which is exactly
 * the class of bug this fix removes ("NOT write any DB row" applies to
 * every table, not only saved_reports). A report whose only view is ever a
 * GET (never a fresh POST) now simply never gets shadow rows — accepted:
 * these are admin-only telemetry/measurement systems, not customer-visible
 * data, and their coverage is now POST-only. See tests 5/9c below, and the
 * Task 5 report's own note on this trade-off.
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
    body: JSON.stringify(withTestIdentity({ email, password: 'shadow-trigger-pw-1', username: `shtrig${userCounter}`, deviceKey })),
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
async function makeAttestation(text, reportId, session = { accountId: null, sessionTokenHash: null }) {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spkiDer = Buffer.from(await webcrypto.subtle.exportKey('spki', kp.publicKey));
  const passportId = derivePassportId(spkiDer);
  await client.execute({
    sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, last_seen_at, revoked_at, provenance_generation)
          VALUES (?,?,?,?,NULL,NULL,0) ON CONFLICT(id) DO NOTHING`,
    args: [passportId, spkiDer, DEVICE_PASSPORT_ALGORITHM, Date.now()],
  });
  // AUTH GATE: the challenge must be bound to the SAME account/session the
  // actual POST /api/reports will carry — verifyDevicePassportAttestation
  // rejects any mismatch (see lib/device-passport-server.ts). Defaults to an
  // anonymous binding for the raw-INSERT (never-live-verified) fixtures below
  // that never call POST /api/reports at all.
  const { challengeId, nonce } = await createDevicePassportChallenge(client, session);
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
    // AUTH GATE: a genuinely new report can no longer be created anonymously
    // at all (see app/api/reports/route.ts) — device-passport verification
    // itself is orthogonal to auth state (already proven authenticated
    // elsewhere, e.g. tests/device-passport-actor-ledger.test.mjs), so this
    // fixture now signs up a fresh throwaway account instead.
    const account = await signUpAccount();
    const { deviceKey } = account;
    const reportId = 'shadow-trigger-post-devicepassport';
    const { passportId, devicePassport } = await makeAttestation(text, reportId, { accountId: account.userId, sessionTokenHash: hashToken(account.cookie) });

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
// 5. GET /api/reports/[id] no longer schedules either evaluation (customer
//    read-path purity — see this file's own header comment)
// ===========================================================================

test('5. GET /api/reports/[id] never schedules either evaluation any more — a customer GET is a pure read, so a legacy report only ever viewed (never re-POSTed) has no shadow rows', async () => {
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
    // A second view changes nothing either — GET is a pure read every time, not just the first.
    assert.equal((await getReport(account, reportId)).status, 200);

    const rows = await shadowRows(deviceKey, reportId);
    assert.equal(e8pRow(rows), null, 'REQUIRED (customer-read purity): GET must never write the historical-match shadow row — only POST does');
    assert.equal(deviceRow(rows), null, 'REQUIRED (customer-read purity): GET must never write the device-provenance shadow row — only POST does');

    // The explicit recovery/backfill machinery this report's write-time
    // finalization would have used still works when invoked directly (the
    // same "explicit action, not a passive read" idiom this whole fix uses
    // elsewhere) — proving the evaluators themselves are unaffected, only
    // GET's own implicit trigger is gone.
    const resolution = await resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: deviceKey, reportId, accountId: null, rawText: text,
      wordCount, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
    });
    await scheduleReportShadowEvaluations({
      reportDeviceKey: deviceKey, reportId, accountId: null, rawText: text,
      productionResult: resolution.historicalSubmissionMatch,
      authoritativeUnifiedSimilarity: resolution.unifiedSimilarity ?? null,
      effectiveDeviceSelfRepresentationIds: resolution.effectiveDeviceSelfRepresentationIds,
      authoritativeCorpusGeneration: resolution.corpusGeneration,
      authoritativeArchiveMatchedPositions: null,
      authoritativeExternalAcademicEvidence: null,
    });
    const rowsAfterExplicitSchedule = await shadowRows(deviceKey, reportId);
    assert.ok(e8pRow(rowsAfterExplicitSchedule), 'the historical-match evaluator itself still works when explicitly invoked');
    assert.ok(deviceRow(rowsAfterExplicitSchedule), 'the device-provenance evaluator itself still works when explicitly invoked');
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
    // AUTH GATE: a genuinely new report can no longer be created anonymously
    // at all — this fixture now signs up a fresh throwaway account instead
    // (see test 2's own comment above).
    const account = await signUpAccount();
    const { deviceKey } = account;
    const reportId = 'shadow-trigger-idempotent';
    const { devicePassport } = await makeAttestation(text, reportId, { accountId: account.userId, sessionTokenHash: hashToken(account.cookie) });

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

// ===========================================================================
// 9. GET-fallback Selective Corpus idempotency gating (includeSelectiveCorpus)
// ===========================================================================
//
// Selective Corpus shadow (lib/selective-corpus/) is the 5th evaluator this
// same scheduler runs, appended after the 4 above. Unlike them it writes NO
// DB row of its own — its only observable output is a structured
// "selective_corpus_shadow" console line (lib/selective-corpus/shadow-
// telemetry.ts) and, when SELECTIVE_CORPUS_DIAGNOSTICS_DIR is set, a local
// diagnostics JSON file named by reportId. Both are used below as the
// "did it run" signal, at two independent levels: a fast, artifact-free,
// direct call to the shared scheduler (console-line presence), and a real
// end-to-end POST/GET through the actual routes (diagnostics-file presence).

/** Section 9's own text generator — deliberately NOT drawn from the shared,
 *  exactly-10-entry TEXT_POOL above (already fully consumed by tests 1-8;
 *  this section adds 3 more callers, which would exhaust it). Uniqueness
 *  here only needs to avoid colliding with itself across this section's own
 *  calls, never with the pool. */
let gateTextCounter = 0;
function gateText() {
  gateTextCounter += 1;
  return `Section nine fixture paragraph number ${gateTextCounter} for the Selective Corpus GET-fallback gating tests, describing a wholly invented scenario about a research team calibrating a bespoke instrument under controlled laboratory conditions, repeating the calibration procedure several times to characterise drift before drawing any conclusion about the instrument long term stability under sustained continuous operation across a full working shift.`;
}

/** A minimal, valid, digest-matching Selective Corpus artifact: 256
 *  well-formed EMPTY shards (matches tests/selective-corpus-shadow.test.mjs's
 *  own writeMinimalSelectiveCorpusArtifact) — enough for the evaluator to
 *  reach state COMPLETED (zero candidates) quickly; no real matching needed
 *  for this section, only "did the evaluator run at all". */
function writeMinimalSelectiveCorpusArtifactFixture(dir) {
  fs.mkdirSync(path.join(dir, 'packed'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'corpus-version.json'),
    JSON.stringify({
      corpusVersion: 'selective-corpus-v1',
      corpusIdentityDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
      fingerprintVersion: 'selective-corpus-fp-w15-s5-v1',
      winnowWindow: 15,
      shingleSize: 5,
      stopPolicy: 'global DF>=13',
      documentCount: 1,
    }),
  );
  fs.writeFileSync(path.join(dir, 'packed', 'docmap.tsv'), '0\ta\tA_wikipedia\tbulk:a\t500\tORDINARY_REFERENCE');
  fs.writeFileSync(path.join(dir, 'packed', 'stopset.bin'), Buffer.alloc(0));
  for (let s = 0; s < 256; s++) {
    fs.writeFileSync(path.join(dir, 'packed', `shard-${String(s).padStart(3, '0')}.bin`), Buffer.alloc(4));
  }
}

/** Captures every console.log line emitted while `fn` runs, restoring
 *  console.log unconditionally afterward (success or throw). */
async function captureConsoleLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('9a. scheduleReportShadowEvaluations: default (POST shape) includes Selective Corpus telemetry; includeSelectiveCorpus:false (GET shape) excludes it — no real artifact needed (flag itself stays off, so the evaluator logs a fast DISABLED event either way, isolating ONLY the gating behavior)', async () => {
  // No openConnection override: uses the real getReportsDbClient() default
  // against this file's own real test DB (TURSO_DATABASE_URL, set at module
  // load) — the same DB every other test in this file already relies on,
  // rather than a hand-rolled mock that could silently miss a call shape one
  // of the 4 sibling evaluators (which this call also exercises) depends on.
  const base = {
    reportDeviceKey: uniq('gate-dev'), reportId: uniq('gate-report'), accountId: null,
    rawText: gateText(), productionResult: productionNoMatch(),
    authoritativeUnifiedSimilarity: null, effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 0,
    authoritativeArchiveMatchedPositions: null, authoritativeExternalAcademicEvidence: null,
  };

  // POST's call site never passes includeSelectiveCorpus at all — this is exactly that shape.
  const postShapeLines = await captureConsoleLog(() => scheduleReportShadowEvaluations({ ...base }));
  const postShapeScLines = postShapeLines.filter((l) => l.includes('"selective_corpus_shadow"'));
  assert.equal(postShapeScLines.length, 1, 'POST shape (default/omitted includeSelectiveCorpus) must produce exactly one Selective Corpus telemetry line');
  assert.match(postShapeScLines[0], /"state":"DISABLED"/, 'flag itself is off in this test — a fast DISABLED event proves the evaluator was actually invoked');

  // GET's call site shape — includeSelectiveCorpus explicitly false.
  const getShapeLines = await captureConsoleLog(() => scheduleReportShadowEvaluations({ ...base, includeSelectiveCorpus: false }));
  const getShapeScLines = getShapeLines.filter((l) => l.includes('"selective_corpus_shadow"'));
  assert.equal(getShapeScLines.length, 0, 'GET shape (includeSelectiveCorpus:false) must produce NO Selective Corpus telemetry event at all');
});

test('9b. real POST /api/reports produces a Selective Corpus shadow diagnostics artifact (end-to-end confirmation of existing/unchanged POST behavior)', async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'scv-gate-post-'));
  const diagDir = fs.mkdtempSync(path.join(tmpdir(), 'scv-gate-post-diag-'));
  writeMinimalSelectiveCorpusArtifactFixture(dir);
  clearSelectiveCorpusArtifactCache();
  const savedEnv = {
    SELECTIVE_CORPUS_SHADOW_ENABLED: process.env.SELECTIVE_CORPUS_SHADOW_ENABLED,
    SELECTIVE_CORPUS_ARTIFACT_PATH: process.env.SELECTIVE_CORPUS_ARTIFACT_PATH,
    SELECTIVE_CORPUS_DIAGNOSTICS_DIR: process.env.SELECTIVE_CORPUS_DIAGNOSTICS_DIR,
  };
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_ARTIFACT_PATH = dir;
  process.env.SELECTIVE_CORPUS_DIAGNOSTICS_DIR = diagDir;
  try {
    const text = gateText();
    const account = await signUpAccount();
    const reportId = 'shadow-trigger-sc-post-diag';
    const res = await postReport(account, { id: reportId, text, room: 0 });
    assert.equal(res.status, 200);

    const diagFile = path.join(diagDir, `${reportId}.selective-corpus-shadow.json`);
    assert.ok(fs.existsSync(diagFile), 'a real POST must still produce the Selective Corpus diagnostics artifact — unchanged from before this patch');
    const diag = JSON.parse(fs.readFileSync(diagFile, 'utf8'));
    assert.equal(diag.reportId, reportId);
    assert.ok(['COMPLETED', 'PARTIAL', 'TIMEOUT', 'FAILED', 'ARTIFACT_UNAVAILABLE'].includes(diag.result.state));
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(diagDir, { recursive: true, force: true });
    clearSelectiveCorpusArtifactCache();
  }
});

test('9c. real GET /api/reports/[id]: NONE of the three evaluators run any more — GET is a pure read, not just Selective-Corpus-gated (end-to-end)', async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'scv-gate-get-'));
  const diagDir = fs.mkdtempSync(path.join(tmpdir(), 'scv-gate-get-diag-'));
  writeMinimalSelectiveCorpusArtifactFixture(dir);
  clearSelectiveCorpusArtifactCache();
  const savedEnv = {
    SELECTIVE_CORPUS_SHADOW_ENABLED: process.env.SELECTIVE_CORPUS_SHADOW_ENABLED,
    SELECTIVE_CORPUS_ARTIFACT_PATH: process.env.SELECTIVE_CORPUS_ARTIFACT_PATH,
    SELECTIVE_CORPUS_DIAGNOSTICS_DIR: process.env.SELECTIVE_CORPUS_DIAGNOSTICS_DIR,
  };
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_ARTIFACT_PATH = dir;
  process.env.SELECTIVE_CORPUS_DIAGNOSTICS_DIR = diagDir;
  process.env.DEVICE_PASSPORT_ENABLED = 'true';
  try {
    const text = gateText();
    await indexPriorSubmission(uniq('prior-acc'), text);

    // A "legacy" report, seeded directly — POST never ran for it, so nothing
    // (including no Selective Corpus diagnostics file) exists yet.
    const deviceKey = uniq('legacy-sc-dev');
    const reportId = 'shadow-trigger-sc-get-fallback';
    const wordCount = tokens(canonicalizeText(text)).length;
    const { passportId } = await makeAttestation(text, reportId);
    const payload = JSON.stringify({ version: 11, id: 1, submissionId: 'sub', title: 't', text, wordCount, score: 0, archiveScore: 0, sources: [], repeats: [] });
    await client.execute({
      sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [reportId, deviceKey, 'sub', 't', new Date().toISOString(), wordCount, 0, 'Low', payload, null, passportId],
    });

    const diagFile = path.join(diagDir, `${reportId}.selective-corpus-shadow.json`);
    assert.equal(fs.existsSync(diagFile), false, 'sanity: no Selective Corpus diagnostics artifact exists before the report is ever viewed');
    assert.deepEqual(await shadowRows(deviceKey, reportId), [], 'sanity: no sibling shadow rows exist before the report is ever viewed');

    const account = { deviceKey, cookie: null, tag: uniq('legacy-sc') };
    const res = await getReport(account, reportId);
    assert.equal(res.status, 200);

    const rows = await shadowRows(deviceKey, reportId);
    assert.equal(e8pRow(rows), null, 'REQUIRED (customer-read purity): GET must never write the historical-match shadow row');
    assert.equal(deviceRow(rows), null, 'REQUIRED (customer-read purity): GET must never write the device-provenance shadow row');
    assert.equal(fs.existsSync(diagFile), false, 'Selective Corpus must NOT have run either — no diagnostics artifact was produced');
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.DEVICE_PASSPORT_ENABLED;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(diagDir, { recursive: true, force: true });
    clearSelectiveCorpusArtifactCache();
  }
});

console.log('report-shadow-evaluation-trigger: POST trigger + GET purity (no fallback scheduling) + idempotency + score invariance + privacy + Selective-Corpus GET-gating passed');
