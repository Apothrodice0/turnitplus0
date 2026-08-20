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
 * Privacy hardening (production audit fix, item 2): proves the explicit
 * opt-in consent gate on indexDocumentSubmissionIntoCorpus — a signed-in
 * user's uploads are never added to the cross-account matching corpus
 * (corpus_document_representations/corpus_submission_references) unless
 * their account has explicitly consented (users.corpus_reuse_consented_at
 * IS NOT NULL). The underlying matching mechanism itself
 * (indexDocumentSubmissionIntoCorpus, findCandidateCorpusRepresentations,
 * matchAgainstUserSubmissionCorpus) is not modified — only whether
 * app/api/reports/route.ts ever calls the entry point. Real route calls
 * only, no mocking, matching this repo's existing test convention.
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

async function postReport(deviceKey, { cookie, id, title = 'consent.pdf', text } = {}) {
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

// --- GATE: consent granted -> indexing resumes exactly as before -----------

test('GATE: granting consent via PATCH /api/auth/me causes a SUBSEQUENT save to index into the corpus', async () => {
  const text = 'Volcanologists monitoring a persistently degassing stratovolcano deployed a network of low-cost gas sensors to track sulfur dioxide flux variability across the eruptive cycle.';
  const email = 'consent-grant@example.test';
  const { cookie } = await signup(email, 'consent-device-grant');

  const before = await postReport('consent-device-grant', { cookie, text });
  assert.equal(await representationForText(text), null, 'must not be indexed before consent is granted');

  const patchResult = await patchMe(cookie, { username: 'consent-grant', email, corpusReuseConsent: true });
  assert.equal(patchResult.res.status, 200);
  assert.equal(patchResult.body.user.corpusReuseConsent, true, 'PATCH response must reflect the newly granted consent');

  const userRow = await setupClient.execute({ sql: 'SELECT corpus_reuse_consented_at FROM users WHERE email = ?', args: [email] });
  assert.ok(userRow.rows[0].corpus_reuse_consented_at, 'the DB column itself must be set to a non-null timestamp');

  // A NEW report (distinct id, since indexing is gated on isFirstSaveOfThisReport per report id) with the SAME text now indexes.
  const after = await postReport('consent-device-grant', { cookie, text, title: 'consent-grant-2.pdf' });
  assert.equal(after.res.status, 200);
  const representationId = await representationForText(text);
  assert.ok(representationId, 'a corpus representation must now exist after consent was granted');

  const refs = await setupClient.execute({ sql: 'SELECT document_identity_id FROM corpus_submission_references WHERE representation_id = ?', args: [representationId] });
  assert.equal(refs.rows.length, 1, 'exactly the post-consent report should be indexed, not the earlier pre-consent one');
});

// --- GATE: revoking stops future indexing but does not retroactively un-index ---

test('GATE: revoking consent stops future indexing but does not remove already-indexed data', async () => {
  const email = 'consent-revoke@example.test';
  const firstText = 'Soil scientists comparing tillage regimes across a decade-long field trial measured consistently higher aggregate stability under the no-till treatment plots.';
  const secondText = 'Limnologists sampling a dimictic lake through two full seasonal turnover cycles documented a persistent hypolimnetic oxygen deficit unrelated to nutrient loading.';

  const { cookie } = await signup(email, 'consent-device-revoke');
  await patchMe(cookie, { username: 'consent-revoke', email, corpusReuseConsent: true });

  await postReport('consent-device-revoke', { cookie, text: firstText });
  const firstRepresentationId = await representationForText(firstText);
  assert.ok(firstRepresentationId, 'must be indexed while consent is on');

  const revoked = await patchMe(cookie, { username: 'consent-revoke', email, corpusReuseConsent: false });
  assert.equal(revoked.body.user.corpusReuseConsent, false);
  const userRow = await setupClient.execute({ sql: 'SELECT corpus_reuse_consented_at FROM users WHERE email = ?', args: [email] });
  assert.equal(userRow.rows[0].corpus_reuse_consented_at, null, 'revoking must clear the DB column back to NULL');

  await postReport('consent-device-revoke', { cookie, text: secondText, title: 'consent-revoke-2.pdf' });
  assert.equal(await representationForText(secondText), null, 'a save made after revocation must not be indexed');

  // The FIRST text's representation, indexed while consent was on, is untouched by revocation.
  assert.ok(await representationForText(firstText), 'revocation must not retroactively remove text indexed while consent was granted');
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

test('CROSS-ACCOUNT VISIBILITY: B never sees A as a PRIOR_SUBMISSION while A has not consented, and does once A consents', async () => {
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

  // Now A grants consent and uploads again (a new report, same content).
  await patchMe(cookieA, { username: 'consent-vis-a', email: 'consent-vis-a@example.test', corpusReuseConsent: true });
  await postReport('consent-device-vis-a', { cookie: cookieA, text, title: 'consent-vis-a-2.pdf' });

  // B's SECOND upload of the same content should now surface a PRIOR_SUBMISSION.
  const { id: bReportId2 } = await postReport('consent-device-vis-b', { cookie: cookieB, text, title: 'consent-vis-b-2.pdf' });
  const bGetAfter = await getReport(bReportId2, { cookie: cookieB });
  const bBodyAfter = await bGetAfter.json();
  assert.equal(
    bBodyAfter.payload.historicalSubmissionMatch?.status,
    'MATCHED',
    'once A consents and re-indexes, B must be able to see the PRIOR_SUBMISSION match — the underlying matcher is unchanged, only reachability changed',
  );
  const matchTypes = bBodyAfter.payload.historicalSubmissionMatch.matches.map((m) => m.relationshipType);
  assert.ok(matchTypes.includes('PRIOR_SUBMISSION'), 'the surfaced relationship must be PRIOR_SUBMISSION, exactly as the pre-existing (unmodified) matcher already classifies it');
});

// --- ANONYMOUS: never eligible for consent, always skipped -----------------

test('ANONYMOUS: an anonymous submission is never indexed regardless of consent (consent is an account-level property; anonymous has no account)', async () => {
  const text = 'Structural engineers retrofitting a mid-century concrete overpass installed fiber-reinforced polymer wrap across the most heavily corroded rebar sections identified by ground-penetrating radar survey.';
  const { res } = await postReport('consent-device-anon', { text });
  assert.equal(res.status, 200);
  assert.equal(await representationForText(text), null, 'anonymous saves remain SKIPPED_ANONYMOUS regardless of any consent state');
});
