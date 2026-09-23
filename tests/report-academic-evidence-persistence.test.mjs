import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity, markTestAccountEmailVerified } from './helpers/test-signup.mjs';

/**
 * Phase 3 STEP 9 items 7, 8, 15 (persistence/round-trip aspects): proves
 * externalAcademicEvidence rides through the SAME save/read path every
 * other report field already does (payload_json is a flexible JSON blob —
 * see this phase's own report on why no schema/migration change was
 * needed), and that its presence never perturbs score/archiveScore or the
 * other read-time enrichments (matchClassification, historicalSubmissionMatch)
 * that already run on every GET. Mirrors tests/api-reports.test.mjs's own
 * DB-backed route-handler harness exactly (temp SQLite file, real
 * migrations, real route handler functions invoked with real Request
 * objects) rather than a second, divergent test setup.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_academic_evidence_persistence.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

const EVIDENCE_FIXTURE = [{
  provider: 'openaire',
  providerId: 'ext-1',
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani'],
  publication: 'NeurIPS',
  year: 2017,
  doi: '10.48550/arxiv.1706.03762',
  url: 'https://arxiv.org/abs/1706.03762',
  matchedPassages: [{ submittedText: 'attention mechanisms alone', submittedWordStart: 0, submittedWordEnd: 3, matchedWordCount: 3 }],
  similarity: 97,
}];

function samplePayload(overrides = {}) {
  return {
    version: 11,
    id: Date.now() + Math.floor(Math.random() * 1000),
    submissionId: '9876543210',
    title: 'sample.pdf',
    created: new Date().toISOString(),
    score: 24,
    archiveScore: 24,
    wordCount: 500,
    text: 'sample extracted text for academic evidence persistence tests, long enough to be realistic',
    ...overrides,
  };
}

// AUTH GATE (product requirement): a genuinely new report can no longer be
// created anonymously at all (see app/api/reports/route.ts's own "AUTH GATE"
// comment). This file's fixtures were never actually about anonymity — they
// use a fresh, per-test device key only as a unique namespace — so postReport
// now signs up a fresh throwaway account for that device key first, and every
// getReport call carries that same account's session.
async function signupFor(deviceKey, clientTag) {
  await resetAuthRateForTest(clientTag + '-signup');
  const email = `${clientTag}@example.test`;
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': clientTag + '-signup' },
    body: JSON.stringify(withTestIdentity({ email, password: 'academic-evidence-fixture-pw', username: clientTag.replace(/[^a-z0-9]/gi, '').slice(0, 24) || 'academicevidenceuser', deviceKey })),
  });
  const res = await signupRoute.POST(req);
  if (res.status === 201) await markTestAccountEmailVerified(dbFile, email);
  const setCookie = res.headers.get('set-cookie');
  const match = setCookie ? setCookie.match(/tp_session_v1=([^;]*)/) : null;
  return match ? match[1] : null;
}

async function postReport(deviceKey, clientTag, { payloadOverrides = {} } = {}) {
  await resetRateForTest(clientTag);
  const payload = samplePayload(payloadOverrides);
  const cookie = await signupFor(deviceKey, clientTag);
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': clientTag, cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({
      deviceKey,
      id: String(payload.id),
      submissionId: payload.submissionId,
      title: payload.title,
      createdAt: payload.created,
      wordCount: payload.wordCount,
      archiveScore: payload.score,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      room: 0,
      payload,
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, payload, cookie };
}

async function getReport(deviceKey, id, clientTag, cookie) {
  await resetRateForTest(clientTag);
  const url = cookie ? `http://localhost/api/reports/${id}` : `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}`;
  const headers = { 'x-forwarded-for': clientTag };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  const req = new Request(url, { headers });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id: String(id) }) });
}

test('STEP 9.15/7: a report saved WITHOUT externalAcademicEvidence round-trips with score/archiveScore untouched and the field absent', async () => {
  const deviceKey = 'device-no-evidence';
  const { res: saveRes, payload, cookie } = await postReport(deviceKey, 'client-no-evidence');
  assert.equal(saveRes.status, 200);

  const getRes = await getReport(deviceKey, payload.id, 'client-no-evidence-get', cookie);
  assert.equal(getRes.status, 200);
  const body = await getRes.json();

  assert.equal(body.payload.score, payload.score, 'score must be byte-identical');
  assert.equal(body.payload.archiveScore, payload.archiveScore, 'archiveScore must be byte-identical');
  assert.equal('externalAcademicEvidence' in body.payload, false, 'the field must be entirely absent, not null/[]');
  // Phase D/E8C enrichments must still run normally — proves this phase's
  // change did not interfere with the existing read-time enrichment chain.
  // Release-hardening audit finding UI-02: historicalSubmissionMatch is
  // admin-only (app/api/reports/[id]/route.ts's GET handler) — this is an
  // ordinary non-admin account (AUTH GATE: a genuinely new report can no
  // longer be created anonymously at all), so it is undefined here for the
  // same admin-gating reason, not a regression.
  // See tests/report-historical-match-visibility.test.mjs for dedicated
  // admin-vs-ordinary coverage.
  assert.equal(body.payload.historicalSubmissionMatch, undefined, 'REQUIRED (UI-02): a non-admin viewer must never receive historicalSubmissionMatch');
});

test('STEP 9.7: a report saved WITH externalAcademicEvidence round-trips with the SAME score/archiveScore as an equivalent report without it', async () => {
  const deviceKeyA = 'device-with-evidence';
  const deviceKeyB = 'device-without-evidence-cmp';
  const sharedOverrides = { title: 'compare.pdf', score: 41, archiveScore: 41, wordCount: 900 };

  const { payload: payloadWith, cookie: cookieWith } = await postReport(deviceKeyA, 'client-with-evidence', {
    payloadOverrides: { ...sharedOverrides, externalAcademicEvidence: EVIDENCE_FIXTURE },
  });
  const { payload: payloadWithout, cookie: cookieWithout } = await postReport(deviceKeyB, 'client-without-evidence-cmp', {
    payloadOverrides: { ...sharedOverrides },
  });

  const getWith = await getReport(deviceKeyA, payloadWith.id, 'client-with-evidence-get', cookieWith);
  const getWithout = await getReport(deviceKeyB, payloadWithout.id, 'client-without-evidence-cmp-get', cookieWithout);
  const bodyWith = (await getWith.json()).payload;
  const bodyWithout = (await getWithout.json()).payload;

  assert.equal(bodyWith.score, bodyWithout.score, 'presence of external evidence must never change score');
  assert.equal(bodyWith.archiveScore, bodyWithout.archiveScore, 'presence of external evidence must never change archiveScore');
  assert.equal(bodyWith.score, 41);
  // Scholarly evidence server trust boundary (drizzle/0052): a client-supplied
  // externalAcademicEvidence with NO backing academic_search_run_diagnostics row
  // is NOT trusted — the server resolves the authoritative set (here: []) and it
  // is that value which round-trips, not the client fixture. See
  // tests/report-academic-evidence-trust-boundary.test.mjs for the full coverage.
  assert.deepEqual(bodyWith.externalAcademicEvidence, [], 'unverified client evidence is replaced by the server-verified set ([])');
});

test('STEP 9.8: E8P-adjacent read-time fields (matchClassification, historicalSubmissionMatch) are populated identically whether or not externalAcademicEvidence is present', async () => {
  const deviceKeyWith = 'device-e8-with';
  const deviceKeyWithout = 'device-e8-without';
  const sharedText = 'identical submission text used to compare E8-adjacent enrichment behavior across both variants of this test';

  const { payload: withEv, cookie: cookieWith } = await postReport(deviceKeyWith, 'client-e8-with', {
    payloadOverrides: { text: sharedText, externalAcademicEvidence: EVIDENCE_FIXTURE },
  });
  const { payload: withoutEv, cookie: cookieWithout } = await postReport(deviceKeyWithout, 'client-e8-without', {
    payloadOverrides: { text: sharedText },
  });

  const getWith = await getReport(deviceKeyWith, withEv.id, 'client-e8-with-get', cookieWith);
  const getWithout = await getReport(deviceKeyWithout, withoutEv.id, 'client-e8-without-get', cookieWithout);
  const envelopeWith = await getWith.json();
  const envelopeWithout = await getWithout.json();
  const bodyWith = envelopeWith.payload;
  const bodyWithout = envelopeWithout.payload;

  assert.equal(bodyWith.matchClassification?.selfMatchPercent, bodyWithout.matchClassification?.selfMatchPercent);
  assert.equal(bodyWith.matchClassification?.priorSubmissionPercent, bodyWithout.matchClassification?.priorSubmissionPercent);
  assert.equal(bodyWith.historicalSubmissionMatch?.status, bodyWithout.historicalSubmissionMatch?.status);
  assert.equal(bodyWith.experimentalHistoricalMatch, undefined, 'non-allowlisted account: no experimental field either way');
  assert.equal(bodyWithout.experimentalHistoricalMatch, undefined);
  assert.ok(!('reuseContext' in envelopeWith), 'reuse-context workflow removed: the report GET envelope must not carry reuseContext');
  assert.ok(!('reuseContext' in envelopeWithout), 'reuse-context workflow removed: the report GET envelope must not carry reuseContext');
});

test('a payload with externalAcademicEvidence stays comfortably under the existing 2MB payload cap for a realistic number of sources', async () => {
  const deviceKey = 'device-size-check';
  const manySources = Array.from({ length: 5 }, (_, i) => ({ ...EVIDENCE_FIXTURE[0], providerId: `ext-${i}`, doi: `10.1/${i}` }));
  const { res } = await postReport(deviceKey, 'client-size-check', { payloadOverrides: { externalAcademicEvidence: manySources } });
  assert.equal(res.status, 200);
});
