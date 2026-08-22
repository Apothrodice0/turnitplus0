import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';

/**
 * Privacy hardening (production audit fix, item 2): originally proved the
 * explicit opt-in consent gate on indexDocumentSubmissionIntoCorpus — a
 * signed-in user's uploads were never added to the cross-account matching
 * corpus unless their account had explicitly consented
 * (users.corpus_reuse_consented_at IS NOT NULL), and WERE added once they
 * did.
 *
 * Corpus-admission hardening (requirement 3) changes the second half of
 * that story: app/api/reports/route.ts no longer calls
 * indexDocumentSubmissionIntoCorpus at all, for any account, consenting or
 * not — consent is a necessary but no longer sufficient precondition
 * (automatic indexing now additionally requires the corpus-admission gate,
 * which no live route wires up yet). So this file's tests now prove: (a)
 * consent's own state machine (grant/revoke/PATCH semantics,
 * users.corpus_reuse_consented_at) still works exactly as before — that
 * primitive is untouched — and (b) no consent state, or transition between
 * states, ever causes a live-route corpus write any more. The underlying
 * matching mechanism itself (indexDocumentSubmissionIntoCorpus,
 * findCandidateCorpusRepresentations, matchAgainstUserSubmissionCorpus) is
 * still not modified — only that the live route never reaches it. Real
 * route calls only, no mocking, matching this repo's existing test
 * convention.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_privacy_consent.db');
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
  return `consent-report-${counter}`;
}

async function signup(email, deviceKey) {
  await resetAuthRateForTest('consent-signup-' + email);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'consent-signup-' + email },
    body: JSON.stringify({ email, password: 'consent-password-1', username: email.split('@')[0], deviceKey }),
  });
  const res = await signupRoute.POST(req);
  const body = await res.json();
  return { res, cookie: extractCookie(res), body };
}

async function login(email, deviceKey) {
  await resetAuthRateForTest('consent-login-' + email);
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'consent-login-' + email },
    body: JSON.stringify({ email, password: 'consent-password-1', deviceKey }),
  });
  const res = await loginRoute.POST(req);
  const body = await res.json();
  return { res, cookie: extractCookie(res), body };
}

async function getMe(cookie) {
  await resetRateForTest('consent-me-get');
  const req = new Request('http://localhost/api/auth/me', { headers: { cookie: `tp_session_v1=${cookie}` } });
  const res = await meRoute.GET(req);
  return { res, body: await res.json() };
}

async function patchMe(cookie, { username, email, corpusReuseConsent }) {
  await resetRateForTest('consent-me-patch');
  const req = new Request('http://localhost/api/auth/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({ username, email, ...(corpusReuseConsent === undefined ? {} : { corpusReuseConsent }) }),
  });
  const res = await meRoute.PATCH(req);
  return { res, body: await res.json() };
}

// Room/slot architecture: required for an authenticated first save (see
// app/api/reports/route.ts); ignored for anonymous requests and resaves. A
// fresh, auto-incrementing default so a scenario posting more than one
// genuinely new report for the same account never collides with itself —
// this file's scenarios are about corpus-reuse consent, not room occupancy.
let roomCounter = 0;
function nextRoom() {
  const room = roomCounter % 10;
  roomCounter += 1;
  return room;
}

async function postReport(deviceKey, { cookie, id, title = 'consent.pdf', text, room = nextRoom() } = {}) {
  await resetRateForTest('consent-post');
  const reportId = id ?? nextId();
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': 'consent-post' };
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
      archiveScore: 5,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      room,
      payload: { version: 11, id: Date.now(), submissionId: 'sub-' + reportId, title, author: '', assignment: '', created: new Date().toISOString(), score: 5, archiveScore: 5, text, wordCount: 100, characterCount: 500, pageCount: 1, fileSize: '1 KB', databaseSize: 230, corpusVersion: 'test', scoreBand: 'Low' },
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, id: reportId };
}

async function getReport(id, { deviceKey, cookie } = {}) {
  await resetRateForTest('consent-get');
  const headers = { 'x-forwarded-for': 'consent-get' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { headers });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
}

async function representationForText(text) {
  const hash = (await import('../lib/document-identity.ts')).canonicalSha256(text);
  const result = await setupClient.execute({ sql: 'SELECT id FROM corpus_document_representations WHERE canonical_sha256 = ?', args: [hash] });
  return result.rows[0] ? String(result.rows[0].id) : null;
}

// --- DEFAULT STATE: consent is off by default, everywhere it's surfaced ---

test('DEFAULT: a brand-new account has corpusReuseConsent=false on signup, login, and GET /api/auth/me', async () => {
  const email = 'consent-default@example.test';
  const { body: signupBody } = await signup(email, 'consent-device-default');
  assert.equal(signupBody.user.corpusReuseConsent, false, 'signup response must default to false');

  const { cookie, body: loginBody } = await login(email, 'consent-device-default');
  assert.equal(loginBody.user.corpusReuseConsent, false, 'login response must reflect false for an account that never opted in');

  const { body: meBody } = await getMe(cookie);
  assert.equal(meBody.user.corpusReuseConsent, false, 'GET /api/auth/me must reflect false');
});

// --- GATE: no consent -> no corpus write ------------------------------------

test('GATE: a signed-in save with NO consent creates a document identity but never indexes into the corpus', async () => {
  const text = 'Entomologists cataloguing beetle diversity across a fragmented lowland rainforest reserve recorded an unexpectedly high proportion of undescribed species within a single sampled hectare.';
  const { cookie } = await signup('consent-noconsent@example.test', 'consent-device-noconsent');

  const { res } = await postReport('consent-device-noconsent', { cookie, text });
  assert.equal(res.status, 200);

  const representationId = await representationForText(text);
  assert.equal(representationId, null, 'no corpus representation should exist — this account never consented');

  const identityCount = await setupClient.execute({ sql: 'SELECT COUNT(*) AS cnt FROM document_identities WHERE account_id IS NOT NULL AND canonical_sha256 = ?', args: [(await import('../lib/document-identity.ts')).canonicalSha256(text)] });
  assert.equal(Number(identityCount.rows[0].cnt), 1, 'the identity row itself (Phase A/B, unaffected by consent) must still be captured');
});

// --- GATE: consent granted -> still no live-route indexing (requirement 3) ---

test('GATE: granting consent via PATCH /api/auth/me does NOT cause a subsequent save to index into the corpus any more — consent alone is no longer sufficient', async () => {
  const text = 'Volcanologists monitoring a persistently degassing stratovolcano deployed a network of low-cost gas sensors to track sulfur dioxide flux variability across the eruptive cycle.';
  const email = 'consent-grant@example.test';
  const { cookie } = await signup(email, 'consent-device-grant');

  const before = await postReport('consent-device-grant', { cookie, text });
  assert.equal(await representationForText(text), null, 'must not be indexed before consent is granted');

  const patchResult = await patchMe(cookie, { username: 'consent-grant', email, corpusReuseConsent: true });
  assert.equal(patchResult.res.status, 200);
  assert.equal(patchResult.body.user.corpusReuseConsent, true, 'PATCH response must still reflect the newly granted consent — the consent primitive itself is untouched');

  const userRow = await setupClient.execute({ sql: 'SELECT corpus_reuse_consented_at FROM users WHERE email = ?', args: [email] });
  assert.ok(userRow.rows[0].corpus_reuse_consented_at, 'the DB column itself must still be set to a non-null timestamp');

  // A NEW report (distinct id) with the SAME text, saved AFTER consent was
  // granted — still must not index, since the live route no longer calls
  // indexDocumentSubmissionIntoCorpus regardless of consent state.
  const after = await postReport('consent-device-grant', { cookie, text, title: 'consent-grant-2.pdf' });
  assert.equal(after.res.status, 200);
  assert.equal(await representationForText(text), null, 'no corpus representation may exist even after consent was granted — automatic indexing now requires the corpus-admission gate, which the live route does not call');
});

// --- GATE: consent transitions never cause live-route indexing (requirement 3) ---

test('GATE: neither granting nor revoking consent ever causes live-route indexing any more — the consent state machine itself (grant/revoke/DB column) is otherwise unaffected', async () => {
  const email = 'consent-revoke@example.test';
  const firstText = 'Soil scientists comparing tillage regimes across a decade-long field trial measured consistently higher aggregate stability under the no-till treatment plots.';
  const secondText = 'Limnologists sampling a dimictic lake through two full seasonal turnover cycles documented a persistent hypolimnetic oxygen deficit unrelated to nutrient loading.';

  const { cookie } = await signup(email, 'consent-device-revoke');
  await patchMe(cookie, { username: 'consent-revoke', email, corpusReuseConsent: true });

  await postReport('consent-device-revoke', { cookie, text: firstText });
  assert.equal(await representationForText(firstText), null, 'a save made while consent is on must not be indexed via the live route any more');

  const revoked = await patchMe(cookie, { username: 'consent-revoke', email, corpusReuseConsent: false });
  assert.equal(revoked.body.user.corpusReuseConsent, false);
  const userRow = await setupClient.execute({ sql: 'SELECT corpus_reuse_consented_at FROM users WHERE email = ?', args: [email] });
  assert.equal(userRow.rows[0].corpus_reuse_consented_at, null, 'revoking must still clear the DB column back to NULL — the consent primitive itself is untouched');

  await postReport('consent-device-revoke', { cookie, text: secondText, title: 'consent-revoke-2.pdf' });
  assert.equal(await representationForText(secondText), null, 'a save made after revocation must not be indexed either');
});

// --- PATCH omitting the field leaves existing state untouched --------------

test('PATCH /api/auth/me without corpusReuseConsent leaves existing consent state unchanged (plain profile edits never silently grant or revoke)', async () => {
  const email = 'consent-omit@example.test';
  const { cookie } = await signup(email, 'consent-device-omit');
  await patchMe(cookie, { username: 'consent-omit', email, corpusReuseConsent: true });

  const plainEdit = await patchMe(cookie, { username: 'consent-omit-renamed', email });
  assert.equal(plainEdit.res.status, 200);
  assert.equal(plainEdit.body.user.corpusReuseConsent, true, 'omitting the field in a plain profile edit must not revoke consent');

  const userRow = await setupClient.execute({ sql: 'SELECT corpus_reuse_consented_at FROM users WHERE email = ?', args: [email] });
  assert.ok(userRow.rows[0].corpus_reuse_consented_at, 'DB state must still show consent granted after an unrelated profile edit');
});

// --- CROSS-ACCOUNT VISIBILITY: the real, user-facing effect of the gate ----

test('CROSS-ACCOUNT VISIBILITY: B never sees A as a PRIOR_SUBMISSION, whether or not A has consented — live-route indexing no longer happens either way (requirement 3)', async () => {
  const text = 'Aerospace engineers wind-tunnel testing a scaled winglet retrofit measured a modest but statistically significant reduction in induced drag across the tested angle-of-attack range.';

  const { cookie: cookieA } = await signup('consent-vis-a@example.test', 'consent-device-vis-a');
  const { cookie: cookieB } = await signup('consent-vis-b@example.test', 'consent-device-vis-b');

  // A uploads WITHOUT consent.
  await postReport('consent-device-vis-a', { cookie: cookieA, text });

  // B uploads the same content and checks their own report.
  const { id: bReportId } = await postReport('consent-device-vis-b', { cookie: cookieB, text, title: 'consent-vis-b.pdf' });
  const bGetBefore = await getReport(bReportId, { cookie: cookieB });
  const bBodyBefore = await bGetBefore.json();
  assert.equal(
    bBodyBefore.payload.historicalSubmissionMatch?.status,
    'NO_HISTORICAL_MATCH',
    'B must not see a match against A while A has not consented to cross-account matching',
  );

  // Now A grants consent and uploads again (a new report, same content) —
  // this no longer causes indexing at all (requirement 3), so B still must
  // never see a match, unlike before corpus-admission hardening.
  await patchMe(cookieA, { username: 'consent-vis-a', email: 'consent-vis-a@example.test', corpusReuseConsent: true });
  await postReport('consent-device-vis-a', { cookie: cookieA, text, title: 'consent-vis-a-2.pdf' });

  const { id: bReportId2 } = await postReport('consent-device-vis-b', { cookie: cookieB, text, title: 'consent-vis-b-2.pdf' });
  const bGetAfter = await getReport(bReportId2, { cookie: cookieB });
  const bBodyAfter = await bGetAfter.json();
  assert.equal(
    bBodyAfter.payload.historicalSubmissionMatch?.status,
    'NO_HISTORICAL_MATCH',
    'B must still see no match even after A consents — granting consent no longer causes live-route indexing at all',
  );
});

// --- ANONYMOUS: never eligible for consent, always skipped -----------------

test('ANONYMOUS: an anonymous submission is never indexed regardless of consent (consent is an account-level property; anonymous has no account)', async () => {
  const text = 'Structural engineers retrofitting a mid-century concrete overpass installed fiber-reinforced polymer wrap across the most heavily corroded rebar sections identified by ground-penetrating radar survey.';
  const { res } = await postReport('consent-device-anon', { text });
  assert.equal(res.status, 200);
  assert.equal(await representationForText(text), null, 'anonymous saves remain SKIPPED_ANONYMOUS regardless of any consent state');
});
