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
 * Phase 6: proves computeUnifiedSimilarity() is actually wired into the real
 * report-read pipeline (GET /api/reports/[id], the same route
 * ReportDetailShell's client-side anonymous/device-key fallback and every
 * deviceKey-based lookup ultimately hit) rather than only unit-tested in
 * isolation — tests/unified-similarity.test.mjs already covers the pure
 * function's own arithmetic exhaustively, and
 * tests/unified-similarity-relationship-integration.test.mjs already covers
 * SELF/UNKNOWN/PRIOR_SUBMISSION classification end-to-end; this file's own
 * job is narrower: prove report.unifiedSimilarity actually appears in a real
 * GET response body, reflects real saved archiveMatchedPositions +
 * externalAcademicEvidence, survives a second GET ("refresh"/reopen)
 * unchanged, and never appears (or breaks the response) for a report that
 * predates this phase or has no evidence at all. Mirrors
 * tests/report-academic-evidence-persistence.test.mjs's own DB-backed
 * route-handler harness exactly.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_unified_similarity_report_integration.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

function academicEvidence(overrides = {}) {
  return {
    provider: 'openaire',
    providerId: 'ext-1',
    title: 'Some External Paper',
    authors: null,
    publication: null,
    year: null,
    doi: '10.1/example',
    url: 'https://example.test/paper',
    matchedPassages: [],
    similarity: 90,
    ...overrides,
  };
}

function passage(start, end) {
  return { submittedText: '', submittedWordStart: start, submittedWordEnd: end, matchedWordCount: end - start + 1 };
}

function samplePayload(overrides = {}) {
  return {
    version: 11,
    id: Date.now() + Math.floor(Math.random() * 100000),
    submissionId: '9876543210',
    title: 'sample.pdf',
    created: new Date().toISOString(),
    score: 24,
    archiveScore: 24,
    wordCount: 1000,
    text: 'sample extracted text for unified similarity report integration tests, long enough to be realistic and pass minimum length checks',
    ...overrides,
  };
}

async function postReport(deviceKey, clientTag, { payloadOverrides = {} } = {}) {
  resetRateForTest(clientTag);
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
  resetRateForTest(clientTag);
  const req = new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}`, {
    headers: { 'x-forwarded-for': clientTag },
  });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id: String(id) }) });
}

test('1. ARCHIVE ONLY: a real GET response attaches unifiedSimilarity reflecting archiveMatchedPositions alone', async () => {
  const deviceKey = 'device-unified-archive-only';
  const archiveMatchedPositions = Array.from({ length: 150 }, (_, i) => i); // 0..149 of 1000
  const { payload } = await postReport(deviceKey, 'client-unified-archive-only', {
    payloadOverrides: { archiveMatchedPositions },
  });

  const res = await getReport(deviceKey, payload.id, 'client-unified-archive-only-get');
  assert.equal(res.status, 200);
  const body = (await res.json()).payload;

  assert.ok(body.unifiedSimilarity, 'unifiedSimilarity must be attached by the real GET route');
  assert.equal(body.unifiedSimilarity.unifiedScore, 15);
  assert.equal(body.unifiedSimilarity.archiveOnlyWords, 150);
  assert.equal(body.unifiedSimilarity.liveAcademicOnlyWords, 0);
  assert.equal(body.unifiedSimilarity.previousUploadOnlyWords, 0);
});

test('2. LIVE ONLY: no archive coverage, live academic evidence alone drives unifiedSimilarity', async () => {
  const deviceKey = 'device-unified-live-only';
  const { payload } = await postReport(deviceKey, 'client-unified-live-only', {
    payloadOverrides: {
      externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(100, 249)] })], // 150 words
    },
  });

  const res = await getReport(deviceKey, payload.id, 'client-unified-live-only-get');
  const body = (await res.json()).payload;

  assert.ok(body.unifiedSimilarity);
  assert.equal(body.unifiedSimilarity.unifiedScore, 15);
  assert.equal(body.unifiedSimilarity.liveAcademicOnlyWords, 150);
  assert.equal(body.unifiedSimilarity.archiveOnlyWords, 0);
});

test('3. ARCHIVE + LIVE SAME PASSAGE: real GET response counts the overlapping span once, not twice', async () => {
  const deviceKey = 'device-unified-same-passage';
  const archiveMatchedPositions = Array.from({ length: 100 }, (_, i) => i); // 0..99
  const { payload } = await postReport(deviceKey, 'client-unified-same-passage', {
    payloadOverrides: {
      archiveMatchedPositions,
      externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(0, 99)] })], // exact same range
    },
  });

  const res = await getReport(deviceKey, payload.id, 'client-unified-same-passage-get');
  const body = (await res.json()).payload;

  assert.equal(body.unifiedSimilarity.uniqueMatchedWords, 100, 'must not become 200 just because both sources found it');
  assert.equal(body.unifiedSimilarity.unifiedScore, 10);
  assert.equal(body.unifiedSimilarity.overlapWords, 100);
});

test('4. ARCHIVE + LIVE DIFFERENT PASSAGES: real GET response combines disjoint unique coverage', async () => {
  const deviceKey = 'device-unified-different-passages';
  const archiveMatchedPositions = Array.from({ length: 100 }, (_, i) => i); // 0..99
  const { payload } = await postReport(deviceKey, 'client-unified-different-passages', {
    payloadOverrides: {
      archiveMatchedPositions,
      externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(500, 599)] })], // 500..599, disjoint
    },
  });

  const res = await getReport(deviceKey, payload.id, 'client-unified-different-passages-get');
  const body = (await res.json()).payload;

  assert.equal(body.unifiedSimilarity.uniqueMatchedWords, 200);
  assert.equal(body.unifiedSimilarity.unifiedScore, 20);
  assert.equal(body.unifiedSimilarity.overlapWords, 0);
  assert.equal(body.unifiedSimilarity.archiveOnlyWords, 100);
  assert.equal(body.unifiedSimilarity.liveAcademicOnlyWords, 100);
});

test('9. PROVIDER FAILURE (no externalAcademicEvidence field at all): report generation and GET still succeed, unifiedSimilarity falls back to archive alone', async () => {
  const deviceKey = 'device-unified-provider-failure';
  const archiveMatchedPositions = Array.from({ length: 40 }, (_, i) => i);
  const { res: saveRes, payload } = await postReport(deviceKey, 'client-unified-provider-failure', {
    payloadOverrides: { archiveMatchedPositions }, // no externalAcademicEvidence key at all, as if the background lookup never resolved
  });
  assert.equal(saveRes.status, 200, 'save must succeed even though no academic evidence was ever attached');

  const res = await getReport(deviceKey, payload.id, 'client-unified-provider-failure-get');
  assert.equal(res.status, 200, 'GET must succeed with no crash');
  const body = (await res.json()).payload;

  assert.ok(body.unifiedSimilarity);
  assert.equal(body.unifiedSimilarity.unifiedScore, 4);
  assert.equal(body.unifiedSimilarity.liveAcademicOnlyWords, 0);
});

test('10. NO EVIDENCE AT ALL: report with no archive positions and no academic evidence still completes with a well-formed zero unifiedSimilarity', async () => {
  const deviceKey = 'device-unified-no-evidence';
  const { res: saveRes, payload } = await postReport(deviceKey, 'client-unified-no-evidence');
  assert.equal(saveRes.status, 200);

  const res = await getReport(deviceKey, payload.id, 'client-unified-no-evidence-get');
  assert.equal(res.status, 200);
  const body = (await res.json()).payload;

  assert.ok(body.unifiedSimilarity);
  assert.equal(body.unifiedSimilarity.unifiedScore, 0);
  assert.equal(body.unifiedSimilarity.uniqueMatchedWords, 0);
});

test('PERSISTENCE: a second GET ("refresh"/reopen) recomputes the identical unifiedSimilarity result from the same persisted inputs', async () => {
  const deviceKey = 'device-unified-persistence';
  const archiveMatchedPositions = Array.from({ length: 75 }, (_, i) => i);
  const { payload } = await postReport(deviceKey, 'client-unified-persistence', {
    payloadOverrides: {
      archiveMatchedPositions,
      externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(300, 349)] })],
    },
  });

  const firstRes = await getReport(deviceKey, payload.id, 'client-unified-persistence-get-1');
  const firstBody = (await firstRes.json()).payload;
  const secondRes = await getReport(deviceKey, payload.id, 'client-unified-persistence-get-2');
  const secondBody = (await secondRes.json()).payload;

  assert.deepEqual(firstBody.unifiedSimilarity, secondBody.unifiedSimilarity, 'refreshing/reopening the report must yield the identical unified result');
  assert.equal(firstBody.unifiedSimilarity.uniqueMatchedWords, 125, '75 archive words + 50 disjoint live words');
  assert.equal(firstBody.unifiedSimilarity.unifiedScore, Math.round((125 / 1000) * 100));
});

test('OLD REPORT: a payload with no archiveMatchedPositions field at all (pre-Phase-3 shape) still loads and gets a well-formed unifiedSimilarity, never crashes', async () => {
  const deviceKey = 'device-unified-legacy-report';
  const legacyPayload = {
    version: 5,
    id: Date.now() + Math.floor(Math.random() * 100000),
    submissionId: 'legacy-1',
    title: 'legacy.pdf',
    created: new Date().toISOString(),
    score: 12,
    archiveScore: 12,
    wordCount: 800,
    text: 'a legacy report payload text saved before archiveMatchedPositions existed on the report shape at all',
    // Deliberately no archiveMatchedPositions, no externalAcademicEvidence.
  };
  resetRateForTest('client-unified-legacy-report');
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'client-unified-legacy-report' },
    body: JSON.stringify({
      deviceKey,
      id: String(legacyPayload.id),
      submissionId: legacyPayload.submissionId,
      title: legacyPayload.title,
      createdAt: legacyPayload.created,
      wordCount: legacyPayload.wordCount,
      archiveScore: legacyPayload.score,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      payload: legacyPayload,
    }),
  });
  const saveRes = await reportsRoute.POST(req);
  assert.equal(saveRes.status, 200);

  const res = await getReport(deviceKey, legacyPayload.id, 'client-unified-legacy-report-get');
  assert.equal(res.status, 200, 'a legacy report missing archiveMatchedPositions must still load successfully');
  const body = (await res.json()).payload;

  assert.equal(body.score, 12, 'legacy score must be untouched');
  assert.ok(body.unifiedSimilarity, 'a legacy report still gets a freshly computed unifiedSimilarity attached');
  assert.equal(body.unifiedSimilarity.unifiedScore, 0, 'with no archive/live/prior evidence recorded, unified score is 0, not a crash');
});

test('SCORE ISOLATION: presence of unifiedSimilarity never changes score/archiveScore themselves', async () => {
  const deviceKey = 'device-unified-score-isolation';
  const archiveMatchedPositions = Array.from({ length: 300 }, (_, i) => i); // would push unifiedScore well above archiveScore's own 24 if it leaked in
  const { payload } = await postReport(deviceKey, 'client-unified-score-isolation', {
    payloadOverrides: {
      archiveMatchedPositions,
      externalAcademicEvidence: [academicEvidence({ matchedPassages: [passage(700, 799)] })],
      score: 24,
      archiveScore: 24,
    },
  });

  const res = await getReport(deviceKey, payload.id, 'client-unified-score-isolation-get');
  const body = (await res.json()).payload;

  assert.equal(body.score, 24, 'score must stay exactly what was saved, regardless of unifiedSimilarity');
  assert.equal(body.archiveScore, 24, 'archiveScore must stay exactly what was saved, regardless of unifiedSimilarity');
  assert.notEqual(body.unifiedSimilarity.unifiedScore, body.score, 'sanity: this scenario constructs a unifiedScore that genuinely differs from score, proving isolation is real, not coincidental');
});
