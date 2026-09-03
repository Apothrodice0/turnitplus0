import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';
import { getOrComputeHistoricalMatchSnapshot } from '../lib/report-historical-match.ts';
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_historical_match_integration.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);

test.after(() => {
  setupClient.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

let counter = 0;
function nextId() {
  counter += 1;
  return `ehist-report-${counter}`;
}

// Room/slot architecture: required for an authenticated first save (see
// app/api/reports/route.ts); ignored for anonymous requests and resaves. A
// fresh, auto-incrementing default so a scenario posting more than one
// genuinely new report for the same account never collides with itself —
// this file's scenarios are about historical-match snapshots, not room
// occupancy.
let roomCounter = 0;
function nextRoom() {
  const room = roomCounter % 10;
  roomCounter += 1;
  return room;
}

async function postReport(deviceKey, { cookie, id, title = 'ehist.pdf', text = 'sample fixture text', score = 12, archiveScore = 9, room = nextRoom() } = {}) {
  await resetRateForTest('ehist-post');
  const reportId = id ?? nextId();
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': 'ehist-post' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceKey,
      id: reportId,
      submissionId: 'sub-' + reportId,
      title,
      createdAt: new Date().toISOString(),
      wordCount: 100,
      archiveScore,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      room,
      payload: { version: 11, id: Date.now(), submissionId: 'sub-' + reportId, title, author: '', assignment: '', created: new Date().toISOString(), score, archiveScore, text, wordCount: 100, characterCount: 500, pageCount: 1, fileSize: '1 KB', databaseSize: 230, corpusVersion: 'test', scoreBand: 'Low' },
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, id: reportId };
}

async function getReport(id, { deviceKey, cookie } = {}) {
  await resetRateForTest('ehist-get');
  const headers = { 'x-forwarded-for': 'ehist-get' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { headers });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
}

async function deleteReport(id, { deviceKey, cookie } = {}) {
  await resetRateForTest('ehist-delete');
  const headers = { 'x-forwarded-for': 'ehist-delete' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { method: 'DELETE', headers });
  return reportIdRoute.DELETE(req, { params: Promise.resolve({ id }) });
}

async function signup(email, deviceKey) {
  await resetAuthRateForTest('ehist-signup-' + email);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'ehist-signup-' + email },
    body: JSON.stringify({ email, password: 'ehist-password-1', username: email.split('@')[0], deviceKey }),
  });
  const res = await signupRoute.POST(req);
  // Privacy hardening: grants cross-account corpus-reuse consent immediately
  // so this file's existing scenarios (written before consent-gating
  // existed) continue to exercise the real indexDocumentSubmissionIntoCorpus
  // path via the live route, unchanged — see
  // tests/report-privacy-consent.test.mjs for the dedicated consent on/off
  // behavior this gate itself needs.
  //
  // Release-hardening audit finding UI-02: historicalSubmissionMatch is now
  // admin-only on the GET response — this file's own scenarios read its
  // `.status`/`.matches` to verify the underlying snapshot/matcher
  // behavior, orthogonal to admin-only VISIBILITY. Promoted here too,
  // matching tests/report-match-classification.test.mjs's own precedent;
  // visibility itself is covered separately in tests/report-historical-
  // match-visibility.test.mjs. The file's own ANONYMOUS scenario has no
  // session to promote at all — it calls the underlying snapshot function
  // directly instead, matching this same file's other real-matcher tests.
  await setupClient.execute({ sql: "UPDATE users SET corpus_reuse_consented_at = CURRENT_TIMESTAMP, role = 'admin' WHERE email = ?", args: [email] });
  return { res, cookie: extractCookie(res) };
}

// --- STRUCTURAL: save route performance (section 16) -------------------------

test('SAVE ROUTE: POST /api/reports does not import or call the historical matcher — structurally proven, not just by timing', () => {
  const source = fs.readFileSync(path.join(repo, 'app/api/reports/route.ts'), 'utf8');
  const imports = source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join('\n');
  assert.doesNotMatch(imports, /report-historical-match|user-submission-matching/);
});

// --- REGRESSION: existing save/get/delete round trip still works -------------

test('REGRESSION: save -> get -> delete round trip still works exactly as before (anonymous device path)', async () => {
  const deviceKey = 'ehist-device-regression';
  const { res: postRes, id } = await postReport(deviceKey, { title: 'regression.pdf', text: 'regression fixture text' });
  assert.equal(postRes.status, 200);

  const getRes = await getReport(id, { deviceKey });
  assert.equal(getRes.status, 200);
  const body = await getRes.json();
  assert.equal(body.payload.title, 'regression.pdf');

  const deleteRes = await deleteReport(id, { deviceKey });
  assert.equal(deleteRes.status, 200);

  const getAfterDelete = await getReport(id, { deviceKey });
  assert.equal(getAfterDelete.status, 404, 'REGRESSION: 404 must remain 404 after deletion');
});

test('REGRESSION: 404 remains 404 for a nonexistent report id', async () => {
  const res = await getReport('ehist-does-not-exist', { deviceKey: 'ehist-device-nonexistent' });
  assert.equal(res.status, 404);
});

// --- PRODUCTION SCORE UNCHANGED (section 26) ----------------------------------

test('PRODUCTION SCORE: score and archiveScore in the GET response are exactly what was saved, unaffected by historicalSubmissionMatch', async () => {
  const deviceKey = 'ehist-device-score';
  const { id } = await postReport(deviceKey, { text: 'score fixture text with distinctive wording for this specific test case only', score: 19, archiveScore: 19 });

  const getRes = await getReport(id, { deviceKey });
  const body = await getRes.json();
  assert.equal(body.payload.score, 19, 'production score must remain exactly what was saved');
  assert.equal(body.payload.archiveScore, 19, 'archive overlap must remain exactly what was saved');
});

// --- FULL LIFECYCLE + SELF via real corpus data -------------------------------

test('LIFECYCLE: a signed-in account viewing its own re-saved-equivalent content sees SELF in historicalSubmissionMatch, and it is removed on delete', async () => {
  const email = 'ehist-self@example.test';
  const { res: signupRes, cookie } = await signup(email, 'ehist-device-self');
  assert.equal(signupRes.status, 201);

  const text = 'Volcanologists monitoring a stratovolcano recorded a sustained increase in sulfur dioxide flux preceding a minor phreatic eruption event this cycle.';

  // First save+view: Phase E8D activates save-time indexing, so this first
  // save DOES already index itself into the corpus (unlike when this test
  // was written under E8C, before activation existed). The report must
  // still show NO_HISTORICAL_MATCH here, though, for a different reason
  // now: lib/report-historical-match.ts excludes this exact submission's
  // own just-indexed reference from ownership counting (see its own
  // comment), and with no other reference yet recorded, there is no
  // genuine external evidence to report — see
  // tests/report-historical-match.test.mjs's own "very first-ever upload"
  // fixture for this same property tested in isolation.
  const { id: firstReportId } = await postReport('ehist-device-self', { cookie, text });
  const firstGet = await getReport(firstReportId, { cookie });
  const firstBody = await firstGet.json();
  assert.equal(firstBody.payload.historicalSubmissionMatch?.status ?? 'NO_HISTORICAL_MATCH', 'NO_HISTORICAL_MATCH', 'a first-ever indexed upload must not match against nothing but itself');

  // Directly index a second, genuinely separate submission of the same
  // account's content into the E8A corpus — representing a real second
  // upload event distinct from the one captured above.
  const { createDocumentIdentity } = await import('../lib/document-identity.ts');
  const { indexDocumentSubmissionIntoCorpus } = await import('../lib/user-submission-corpus.ts');
  const client = createClient({ url: `file:${dbFile}` });
  const sessionRow = await client.execute({ sql: "SELECT user_id FROM saved_reports WHERE id = ?", args: [firstReportId] });
  const accountId = sessionRow.rows[0].user_id;
  const identity = await createDocumentIdentity(client, { accountId, title: 'T', author: null, rawText: text });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
  await matureCorpusBackings(client); // Phase A: age the seeded backing so it is matchable "now"
  client.close();

  const { id: secondReportId } = await postReport('ehist-device-self', { cookie, text });
  const secondGet = await getReport(secondReportId, { cookie });
  const secondBody = await secondGet.json();
  assert.equal(secondBody.payload.historicalSubmissionMatch?.status, 'MATCHED');
  assert.equal(secondBody.payload.historicalSubmissionMatch.matches[0].relationshipType, 'SELF');

  const deleteRes = await deleteReport(secondReportId, { cookie });
  assert.equal(deleteRes.status, 200);
  const snapshotClient = createClient({ url: `file:${dbFile}` });
  const remaining = await snapshotClient.execute({
    sql: 'SELECT COUNT(*) AS cnt FROM report_historical_match_snapshots WHERE report_id = ?',
    args: [secondReportId],
  });
  assert.equal(Number(remaining.rows[0].cnt), 0, 'deleting the report must remove its historical-match snapshot too');
  snapshotClient.close();
});

// --- AUTH: account B cannot read account A's report or its historical match ---

test('AUTH: account B cannot fetch account A\'s report at all, so its historicalSubmissionMatch can never leak', async () => {
  const { cookie: cookieA } = await signup('ehist-auth-a@example.test', 'ehist-device-auth-a');
  const { cookie: cookieB } = await signup('ehist-auth-b@example.test', 'ehist-device-auth-b');

  const { id } = await postReport('ehist-device-auth-a', { cookie: cookieA, text: 'account A private fixture text for the auth boundary test case.' });

  const asOwner = await getReport(id, { cookie: cookieA });
  assert.equal(asOwner.status, 200);

  const asOtherAccount = await getReport(id, { cookie: cookieB });
  assert.equal(asOtherAccount.status, 404, 'account B must get 404, not the report or any of its historical-match data');

  const asAnonymousGuess = await getReport(id, { deviceKey: 'some-unrelated-device-key' });
  assert.equal(asAnonymousGuess.status, 404, 'an unrelated device_key must also get 404');
});

// --- ANONYMOUS behavior --------------------------------------------------------

test('ANONYMOUS: an anonymous report still loads normally and, if a match exists, is classified UNKNOWN_RELATIONSHIP, never SELF', async () => {
  const text = 'Paleobotanists examining fossilized pollen assemblages reconstructed a shift in regional vegetation cover across a documented climatic transition interval this study.';
  const { createDocumentIdentity } = await import('../lib/document-identity.ts');
  const { indexDocumentSubmissionIntoCorpus } = await import('../lib/user-submission-corpus.ts');
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute({ sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: ['ehist-anon-owner', 'ehist-anon-owner@example.test', 'ehist-anon-owner', 'x'] });
  const identity = await createDocumentIdentity(client, { accountId: 'ehist-anon-owner', title: 'T', author: null, rawText: text });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
  await matureCorpusBackings(client); // Phase A: age the seeded backing so it is matchable "now"
  client.close();

  const deviceKey = 'ehist-device-anonymous';
  const { id } = await postReport(deviceKey, { text });
  const getRes = await getReport(id, { deviceKey });
  assert.equal(getRes.status, 200, 'an anonymous report must still load normally');
  const body = await getRes.json();
  // Release-hardening audit finding UI-02: historicalSubmissionMatch is
  // admin-only on the GET response, and there is no session at all here to
  // promote to admin — this is exactly the case that field's own gate
  // exists to protect (see tests/report-historical-match-visibility.test.mjs's
  // role-spoof coverage), so the response itself correctly carries nothing.
  // This scenario's own purpose is the real matcher's UNKNOWN_RELATIONSHIP
  // classification, so it reaches the same underlying computation the GET
  // route itself calls, directly, server-side.
  assert.equal(body.payload.historicalSubmissionMatch, undefined, 'REQUIRED (UI-02): an anonymous viewer must never receive historicalSubmissionMatch via the response');
  const readClient = createClient({ url: `file:${dbFile}` });
  let anonMatch;
  try {
    anonMatch = await getOrComputeHistoricalMatchSnapshot(readClient, { reportDeviceKey: deviceKey, reportId: id, accountId: null, rawText: text });
  } finally {
    readClient.close();
  }
  assert.equal(anonMatch.status, 'MATCHED');
  assert.equal(anonMatch.matches[0].relationshipType, 'UNKNOWN_RELATIONSHIP', 'an anonymous viewer must never be classified SELF');
});
