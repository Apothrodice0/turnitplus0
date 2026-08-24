import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import { resetRateForTest } from '../lib/rate-limit.js';

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_api_reports.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

function samplePayload(overrides = {}) {
  return {
    version: 11,
    id: Date.now(),
    submissionId: '1234567890',
    title: 'sample.pdf',
    created: new Date().toISOString(),
    score: 12,
    wordCount: 500,
    text: 'sample extracted text',
    ...overrides,
  };
}

async function postReport(deviceKey, { id, title = 'sample.pdf', payloadOverrides = {}, extra = {} } = {}) {
  await resetRateForTest('test-client-post');
  const payload = samplePayload({ id: id ?? Date.now(), title, ...payloadOverrides });
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-client-post' },
    body: JSON.stringify({
      deviceKey,
      id: String(payload.id),
      submissionId: payload.submissionId,
      title: payload.title,
      createdAt: payload.created,
      wordCount: payload.wordCount,
      archiveScore: payload.score,
      scoreBand: 'Low',
      aiScore: 7,
      aiTone: 'low',
      payload,
      ...extra,
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, payload };
}

async function listReports(deviceKey) {
  await resetRateForTest('test-client-list');
  const req = new Request(`http://localhost/api/reports?deviceKey=${encodeURIComponent(deviceKey)}`, {
    headers: { 'x-forwarded-for': 'test-client-list' },
  });
  return reportsRoute.GET(req);
}

async function getReport(deviceKey, id) {
  await resetRateForTest('test-client-get');
  const req = new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}`, {
    headers: { 'x-forwarded-for': 'test-client-get' },
  });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id: String(id) }) });
}

async function deleteReport(deviceKey, id) {
  await resetRateForTest('test-client-delete');
  const req = new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}`, {
    method: 'DELETE',
    headers: { 'x-forwarded-for': 'test-client-delete' },
  });
  return reportIdRoute.DELETE(req, { params: Promise.resolve({ id: String(id) }) });
}

// 1) Save -> list -> get -> delete round trip
{
  const deviceKey = 'device-round-trip';
  const { res: saveRes, payload } = await postReport(deviceKey, { title: 'roundtrip.pdf' });
  assert.equal(saveRes.status, 200, 'save should succeed');
  const saveBody = await saveRes.json();
  assert.equal(saveBody.ok, true);

  const listRes = await listReports(deviceKey);
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.reports.length, 1, 'list should contain exactly the saved report');
  assert.equal(listBody.reports[0].title, 'roundtrip.pdf');
  assert.equal(listBody.reports[0].id, String(payload.id));
  assert.ok(!('payload_json' in listBody.reports[0]), 'list must not return full payload_json (summary only)');
  assert.ok(!('text' in listBody.reports[0]), 'list must not include full report text');

  const getRes = await getReport(deviceKey, payload.id);
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  // Phase E8C attaches historicalSubmissionMatch as read-time enrichment
  // (like Phase D's matchClassification elsewhere), deliberately always
  // present (even for NO_HISTORICAL_MATCH) so its version/audit metadata
  // stays inspectable — see tests/document-identity.test.mjs's identical
  // adjustment for the full rationale. Phase 6 adds unifiedSimilarity as the
  // same kind of read-time enrichment (lib/unified-similarity.ts, computed
  // from historicalSubmissionMatch plus this payload's own
  // archiveMatchedPositions/externalAcademicEvidence — see
  // tests/unified-similarity-report-integration.test.mjs for its own
  // dedicated coverage), so it gets the same exclusion here.
  // Release-hardening audit finding SIM-04: corpusSourceMatchingEnabledAtComputation
  // and unifiedSimilarityGeneration are persisted alongside unifiedSimilarity
  // (both at write time and by the GET route's own self-heal write-back —
  // see lib/report-primary-similarity.ts's own header comment) as the flag/
  // generation snapshot a later read uses to detect staleness — the same
  // kind of enrichment as the two fields above, so they get the same
  // exclusion here.
  const { historicalSubmissionMatch, unifiedSimilarity, corpusSourceMatchingEnabledAtComputation, unifiedSimilarityGeneration, ...getPayloadWithoutHistoricalMatch } = getBody.payload;
  assert.equal(historicalSubmissionMatch?.status, 'NO_HISTORICAL_MATCH');
  assert.ok(unifiedSimilarity, 'unifiedSimilarity must also be attached as read-time enrichment');
  assert.equal(corpusSourceMatchingEnabledAtComputation, false, 'the live flag snapshot must be recorded (default off in this test env)');
  assert.equal(typeof unifiedSimilarityGeneration, 'number', 'the generation snapshot must be recorded');
  assert.deepEqual(getPayloadWithoutHistoricalMatch, payload, 'get must return the exact saved payload (aside from the new E8C/Phase 6/SIM-04 enrichment fields)');

  const deleteRes = await deleteReport(deviceKey, payload.id);
  assert.equal(deleteRes.status, 200);

  const getAfterDeleteRes = await getReport(deviceKey, payload.id);
  assert.equal(getAfterDeleteRes.status, 404, 'report must be gone after delete');

  const listAfterDeleteRes = await listReports(deviceKey);
  const listAfterDeleteBody = await listAfterDeleteRes.json();
  assert.equal(listAfterDeleteBody.reports.length, 0, 'list must be empty after delete');
  console.log('save/list/get/delete round trip passed');
}

// 2) Upsert semantics: saving the same (deviceKey, id) again updates in place
{
  const deviceKey = 'device-upsert';
  const sharedId = Date.now() + 1;
  await postReport(deviceKey, { id: sharedId, title: 'first-title.pdf' });
  await postReport(deviceKey, { id: sharedId, title: 'second-title.pdf' });

  const listRes = await listReports(deviceKey);
  const listBody = await listRes.json();
  assert.equal(listBody.reports.length, 1, 'upsert must not create a duplicate row');
  assert.equal(listBody.reports[0].title, 'second-title.pdf', 'upsert must overwrite the title');
  console.log('upsert semantics verified');
}

// 3) Device scoping: a different device key must not see or reach another device's reports
{
  const ownerKey = 'device-owner';
  const strangerKey = 'device-stranger';
  const { payload } = await postReport(ownerKey, { title: 'owner-only.pdf' });

  const strangerList = await listReports(strangerKey);
  const strangerListBody = await strangerList.json();
  assert.equal(strangerListBody.reports.length, 0, 'a different device key must not see another device\'s reports');

  const strangerGet = await getReport(strangerKey, payload.id);
  assert.equal(strangerGet.status, 404, 'a different device key must not be able to fetch another device\'s report by id');

  const strangerDelete = await deleteReport(strangerKey, payload.id);
  assert.equal(strangerDelete.status, 200, 'delete is a no-op (not an error) for a report the device key does not own');

  const ownerGetAfter = await getReport(ownerKey, payload.id);
  assert.equal(ownerGetAfter.status, 200, 'the owning device key must still be able to fetch its report — the stranger delete must not have removed it');
  console.log('device scoping verified');
}

// 4) Payload size limit
{
  const deviceKey = 'device-oversized';
  const hugeText = 'a'.repeat(3_000_000); // exceeds the 2MB cap
  const { res } = await postReport(deviceKey, { title: 'huge.pdf', payloadOverrides: { text: hugeText } });
  assert.equal(res.status, 413, 'oversized payload must be rejected');
  console.log('payload size limit verified');
}

// 5) Required-field validation
{
  const deviceKey = 'device-validation';
  await resetRateForTest('test-client-validation');
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-client-validation' },
    body: JSON.stringify({ deviceKey, id: 'x' }), // missing everything else
  });
  const res = await reportsRoute.POST(req);
  assert.equal(res.status, 400, 'missing required fields must be rejected');

  await resetRateForTest('test-client-validation2');
  const noDeviceKeyReq = new Request('http://localhost/api/reports?deviceKey=', { headers: { 'x-forwarded-for': 'test-client-validation2' } });
  const noDeviceKeyRes = await reportsRoute.GET(noDeviceKeyReq);
  assert.equal(noDeviceKeyRes.status, 400, 'listing without a deviceKey must be rejected');
  console.log('required-field validation verified');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All reports API tests passed');
