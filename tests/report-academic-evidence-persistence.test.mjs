import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import { resetRateForTest } from '../lib/rate-limit.ts';

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

async function postReport(deviceKey, clientTag, { payloadOverrides = {} } = {}) {
  await resetRateForTest(clientTag);
  const payload = samplePayload(payloadOverrides);
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': clientTag },
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
      payload,
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, payload };
}

async function getReport(deviceKey, id, clientTag) {
  await resetRateForTest(clientTag);
  const req = new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}`, {
    headers: { 'x-forwarded-for': clientTag },
  });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id: String(id) }) });
}

test('STEP 9.15/7: a report saved WITHOUT externalAcademicEvidence round-trips with score/archiveScore untouched and the field absent', async () => {
  const deviceKey = 'device-no-evidence';
  const { res: saveRes, payload } = await postReport(deviceKey, 'client-no-evidence');
  assert.equal(saveRes.status, 200);

  const getRes = await getReport(deviceKey, payload.id, 'client-no-evidence-get');
  assert.equal(getRes.status, 200);
  const body = await getRes.json();

  assert.equal(body.payload.score, payload.score, 'score must be byte-identical');
  assert.equal(body.payload.archiveScore, payload.archiveScore, 'archiveScore must be byte-identical');
  assert.equal('externalAcademicEvidence' in body.payload, false, 'the field must be entirely absent, not null/[]');
  // Phase D/E8C enrichments must still run normally — proves this phase's
  // change did not interfere with the existing read-time enrichment chain.
  // (matchClassification itself is undefined for an anonymous device-key
  // report — no owning account to classify family membership against —
  // and JSON.stringify drops undefined keys entirely, so its absence here
  // is expected, not a regression; historicalSubmissionMatch has no such
  // anonymous-only gap and is always attached.)
  assert.equal(body.payload.historicalSubmissionMatch?.status, 'NO_HISTORICAL_MATCH');
});

test('STEP 9.7: a report saved WITH externalAcademicEvidence round-trips with the SAME score/archiveScore as an equivalent report without it', async () => {
  const deviceKeyA = 'device-with-evidence';
  const deviceKeyB = 'device-without-evidence-cmp';
  const sharedOverrides = { title: 'compare.pdf', score: 41, archiveScore: 41, wordCount: 900 };

  const { payload: payloadWith } = await postReport(deviceKeyA, 'client-with-evidence', {
    payloadOverrides: { ...sharedOverrides, externalAcademicEvidence: EVIDENCE_FIXTURE },
  });
  const { payload: payloadWithout } = await postReport(deviceKeyB, 'client-without-evidence-cmp', {
    payloadOverrides: { ...sharedOverrides },
  });

  const getWith = await getReport(deviceKeyA, payloadWith.id, 'client-with-evidence-get');
  const getWithout = await getReport(deviceKeyB, payloadWithout.id, 'client-without-evidence-cmp-get');
  const bodyWith = (await getWith.json()).payload;
  const bodyWithout = (await getWithout.json()).payload;

  assert.equal(bodyWith.score, bodyWithout.score, 'presence of external evidence must never change score');
  assert.equal(bodyWith.archiveScore, bodyWithout.archiveScore, 'presence of external evidence must never change archiveScore');
  assert.equal(bodyWith.score, 41);
  assert.deepEqual(bodyWith.externalAcademicEvidence, EVIDENCE_FIXTURE, 'evidence survives the JSON round trip unchanged');
});

test('STEP 9.8: E8S/E8P-adjacent read-time fields (matchClassification, historicalSubmissionMatch, reuseContext) are populated identically whether or not externalAcademicEvidence is present', async () => {
  const deviceKeyWith = 'device-e8-with';
  const deviceKeyWithout = 'device-e8-without';
  const sharedText = 'identical submission text used to compare E8-adjacent enrichment behavior across both variants of this test';

  const { payload: withEv } = await postReport(deviceKeyWith, 'client-e8-with', {
    payloadOverrides: { text: sharedText, externalAcademicEvidence: EVIDENCE_FIXTURE },
  });
  const { payload: withoutEv } = await postReport(deviceKeyWithout, 'client-e8-without', {
    payloadOverrides: { text: sharedText },
  });

  const getWith = await getReport(deviceKeyWith, withEv.id, 'client-e8-with-get');
  const getWithout = await getReport(deviceKeyWithout, withoutEv.id, 'client-e8-without-get');
  const bodyWith = (await getWith.json()).payload;
  const bodyWithout = (await getWithout.json()).payload;

  assert.equal(bodyWith.matchClassification?.selfMatchPercent, bodyWithout.matchClassification?.selfMatchPercent);
  assert.equal(bodyWith.matchClassification?.priorSubmissionPercent, bodyWithout.matchClassification?.priorSubmissionPercent);
  assert.equal(bodyWith.historicalSubmissionMatch?.status, bodyWithout.historicalSubmissionMatch?.status);
  assert.equal(bodyWith.reuseContext, undefined, 'non-allowlisted anonymous account: reuseContext stays undefined regardless');
  assert.equal(bodyWithout.reuseContext, undefined);
  assert.equal(bodyWith.experimentalHistoricalMatch, undefined, 'non-allowlisted account: no experimental field either way');
  assert.equal(bodyWithout.experimentalHistoricalMatch, undefined);
});

test('a payload with externalAcademicEvidence stays comfortably under the existing 2MB payload cap for a realistic number of sources', async () => {
  const deviceKey = 'device-size-check';
  const manySources = Array.from({ length: 5 }, (_, i) => ({ ...EVIDENCE_FIXTURE[0], providerId: `ext-${i}`, doi: `10.1/${i}` }));
  const { res } = await postReport(deviceKey, 'client-size-check', { payloadOverrides: { externalAcademicEvidence: manySources } });
  assert.equal(res.status, 200);
});
