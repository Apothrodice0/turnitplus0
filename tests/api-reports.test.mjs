import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';
import { withTestIdentity } from './helpers/test-signup.mjs';

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

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

// AUTH GATE (product requirement): creating a genuinely NEW report is an
// authenticated-account action only (see app/api/reports/route.ts's own
// "AUTH GATE" comment) — every fixture below that creates a report now signs
// up a fresh throwaway account first. This file's own assertions (round trip,
// upsert, size limit, required-field validation) were never actually about
// anonymity; they used an anonymous device-key save only as the easiest
// vehicle to create a report, so authenticating the fixture changes nothing
// about what each test proves.
let signupCounter = 0;
async function signup(deviceKey) {
  signupCounter += 1;
  const email = `api-reports-fixture-${signupCounter}@example.com`;
  await resetAuthRateForTest('test-client-signup-' + signupCounter);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-client-signup-' + signupCounter },
    body: JSON.stringify(withTestIdentity({ email, password: 'api-reports-fixture-pw', username: 'apireportsfixture', deviceKey })),
  });
  const res = await signupRoute.POST(req);
  return extractCookie(res);
}

async function postReport(deviceKey, { id, title = 'sample.pdf', payloadOverrides = {}, extra = {}, cookie, room = 0 } = {}) {
  await resetRateForTest('test-client-post');
  const payload = samplePayload({ id: id ?? Date.now(), title, ...payloadOverrides });
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': 'test-client-post' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers,
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
      room,
      payload,
      ...extra,
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, payload };
}

/** Convenience: signs up a fresh account for this device key, then saves a report as that account (a genuine first save requires authentication now). Returns the cookie alongside the usual save result so callers can keep using it for list/get/delete. */
async function postReportAsFreshAccount(deviceKey, opts = {}) {
  const cookie = await signup(deviceKey);
  const { res, payload } = await postReport(deviceKey, { ...opts, cookie });
  return { res, payload, cookie };
}

async function listReports(deviceKey, { cookie } = {}) {
  await resetRateForTest('test-client-list');
  const headers = { 'x-forwarded-for': 'test-client-list' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports?deviceKey=${encodeURIComponent(deviceKey)}` : 'http://localhost/api/reports';
  const req = new Request(url, { headers });
  return reportsRoute.GET(req);
}

async function getReport(deviceKey, id, { cookie } = {}) {
  await resetRateForTest('test-client-get');
  const headers = { 'x-forwarded-for': 'test-client-get' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { headers });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id: String(id) }) });
}

async function deleteReport(deviceKey, id, { cookie } = {}) {
  await resetRateForTest('test-client-delete');
  const headers = { 'x-forwarded-for': 'test-client-delete' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, {
    method: 'DELETE',
    headers,
  });
  return reportIdRoute.DELETE(req, { params: Promise.resolve({ id: String(id) }) });
}

// 1) Save -> list -> get -> delete round trip
{
  const deviceKey = 'device-round-trip';
  const { res: saveRes, payload, cookie } = await postReportAsFreshAccount(deviceKey, { title: 'roundtrip.pdf' });
  assert.equal(saveRes.status, 200, 'save should succeed');
  const saveBody = await saveRes.json();
  assert.equal(saveBody.ok, true);

  const listRes = await listReports(deviceKey, { cookie });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.reports.length, 1, 'list should contain exactly the saved report');
  assert.equal(listBody.reports[0].title, 'roundtrip.pdf');
  assert.equal(listBody.reports[0].id, String(payload.id));
  assert.ok(!('payload_json' in listBody.reports[0]), 'list must not return full payload_json (summary only)');
  assert.ok(!('text' in listBody.reports[0]), 'list must not include full report text');

  const getRes = await getReport(deviceKey, payload.id, { cookie });
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  // Phase E8C originally attached historicalSubmissionMatch as read-time
  // enrichment (like Phase D's matchClassification elsewhere) unconditionally
  // for every viewer. Release-hardening audit finding UI-02 gated it
  // admin-only (app/api/reports/[id]/route.ts's GET handler, matching
  // matchClassification's own pre-existing gate) — see
  // tests/report-historical-match-visibility.test.mjs for the dedicated
  // admin-vs-ordinary coverage. This save/fetch is an ordinary (non-admin)
  // authenticated account — AUTH GATE: a genuinely new report can no longer
  // be created anonymously at all (see app/api/reports/route.ts), so this
  // fixture now signs up a fresh throwaway account instead; the assertions
  // below are unaffected since historicalSubmissionMatch is gated on
  // admin-vs-non-admin, not anonymous-vs-authenticated — so
  // historicalSubmissionMatch must be entirely absent here, not a
  // NO_HISTORICAL_MATCH shape. Phase 6 adds unifiedSimilarity as its own
  // kind of read-time enrichment (lib/unified-similarity.ts, computed from
  // historicalSubmissionMatch plus this payload's own archiveMatchedPositions/
  // externalAcademicEvidence — see tests/unified-similarity-report-integration.test.mjs
  // for its own dedicated coverage) — unlike historicalSubmissionMatch,
  // this one stays present for every viewer (the finalized aggregate score
  // itself is never gated), so it gets the same exclusion-from-the-diff
  // treatment here for a different reason: it's still not part of the
  // original saved payload.
  // Release-hardening audit finding SIM-04: corpusSourceMatchingEnabledAtComputation
  // and unifiedSimilarityGeneration are persisted alongside unifiedSimilarity
  // (both at write time and by the GET route's own self-heal write-back —
  // see lib/report-primary-similarity.ts's own header comment) as the flag/
  // generation snapshot a later read uses to detect staleness — the same
  // kind of enrichment as unifiedSimilarity, so they get the same exclusion here.
  // Release-hardening audit finding LIFECYCLE-06: unifiedSimilarityFailed is
  // explicitly written as `false` on every successful resolution (both at
  // write time and by the GET route's own self-heal), so it too is excluded
  // from the round-trip diff rather than compared against the payload
  // literal, which never declares it.
  // Task A correction: viewerIsAdmin is a new, explicit, unconditional
  // authorization signal the GET handler now sets on every response (see
  // SimilarityReport.viewerIsAdmin's own comment) — likewise excluded from
  // the round-trip diff and checked separately below.
  const { historicalSubmissionMatch, unifiedSimilarity, corpusSourceMatchingEnabledAtComputation, unifiedSimilarityGeneration, unifiedSimilarityFailed, viewerIsAdmin, ...getPayloadWithoutHistoricalMatch } = getBody.payload;
  assert.equal(historicalSubmissionMatch, undefined, 'REQUIRED (UI-02): historicalSubmissionMatch is admin-only — an anonymous/non-admin GET must never receive it, not even a NO_HISTORICAL_MATCH shape');
  assert.ok(unifiedSimilarity, 'unifiedSimilarity must still be attached as read-time enrichment — never gated, only historicalSubmissionMatch is');
  assert.equal(corpusSourceMatchingEnabledAtComputation, false, 'the live flag snapshot must be recorded (default off in this test env)');
  assert.equal(typeof unifiedSimilarityGeneration, 'number', 'the generation snapshot must be recorded');
  assert.equal(unifiedSimilarityFailed, false, 'a genuine success must explicitly clear/set unifiedSimilarityFailed to false, never leave it ambiguous');
  assert.equal(viewerIsAdmin, false, 'REQUIRED: an anonymous/non-admin GET must always get an explicit false, never undefined/omitted — this is a real authorization signal, not optional enrichment');
  assert.deepEqual(getPayloadWithoutHistoricalMatch, payload, 'get must return the exact saved payload (aside from the new E8C/Phase 6/SIM-04/LIFECYCLE-06/viewerIsAdmin enrichment fields)');

  const deleteRes = await deleteReport(deviceKey, payload.id, { cookie });
  assert.equal(deleteRes.status, 200);

  const getAfterDeleteRes = await getReport(deviceKey, payload.id, { cookie });
  assert.equal(getAfterDeleteRes.status, 404, 'report must be gone after delete');

  const listAfterDeleteRes = await listReports(deviceKey, { cookie });
  const listAfterDeleteBody = await listAfterDeleteRes.json();
  assert.equal(listAfterDeleteBody.reports.length, 0, 'list must be empty after delete');
  console.log('save/list/get/delete round trip passed');
}

// 2) Upsert semantics: saving the same (deviceKey, id) again updates in place
{
  const deviceKey = 'device-upsert';
  const sharedId = Date.now() + 1;
  // AUTH GATE: the first save is a genuine creation (authenticated); the
  // second save is a RESAVE of the same (deviceKey, id) — the pre-existing
  // ownership-conflict rule requires it to carry the SAME account's session,
  // never a fresh one, so both saves reuse the one signed-up cookie.
  const cookie = await signup(deviceKey);
  await postReport(deviceKey, { id: sharedId, title: 'first-title.pdf', cookie });
  await postReport(deviceKey, { id: sharedId, title: 'second-title.pdf', cookie });

  const listRes = await listReports(deviceKey, { cookie });
  const listBody = await listRes.json();
  assert.equal(listBody.reports.length, 1, 'upsert must not create a duplicate row');
  assert.equal(listBody.reports[0].title, 'second-title.pdf', 'upsert must overwrite the title');
  console.log('upsert semantics verified');
}

// 3) Account scoping: a different account must not see or reach another
// account's reports. (Originally written as anonymous "device scoping" —
// AUTH GATE means a genuinely new report can no longer be created
// anonymously at all, so this now uses two distinct authenticated accounts;
// tests/api-reports-session-lifecycle.test.mjs's own account-scoping coverage
// already proves the equivalent invariant this way too. The isolation being
// proven — one identity can never see/reach another's reports — is
// unchanged.)
{
  const ownerKey = 'device-owner';
  const strangerKey = 'device-stranger';
  const ownerCookie = await signup(ownerKey);
  const strangerCookie = await signup(strangerKey);
  const { payload } = await postReport(ownerKey, { title: 'owner-only.pdf', cookie: ownerCookie });

  const strangerList = await listReports(undefined, { cookie: strangerCookie });
  const strangerListBody = await strangerList.json();
  assert.equal(strangerListBody.reports.length, 0, 'a different account must not see another account\'s reports');

  const strangerGet = await getReport(undefined, payload.id, { cookie: strangerCookie });
  assert.equal(strangerGet.status, 404, 'a different account must not be able to fetch another account\'s report by id');

  const strangerDelete = await deleteReport(undefined, payload.id, { cookie: strangerCookie });
  assert.equal(strangerDelete.status, 200, 'delete is a no-op (not an error) for a report the account does not own');

  const ownerGetAfter = await getReport(undefined, payload.id, { cookie: ownerCookie });
  assert.equal(ownerGetAfter.status, 200, 'the owning account must still be able to fetch its report — the stranger delete must not have removed it');
  console.log('account scoping verified');
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
