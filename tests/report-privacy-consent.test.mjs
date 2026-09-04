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
import { withTestIdentity } from './helpers/test-signup.mjs';
import { buildReportAdmissionSourceRef } from '../lib/corpus-admission-report-integration.ts';

/**
 * Privacy hardening (production audit fix, item 2) originally proved an
 * explicit opt-in consent gate on indexDocumentSubmissionIntoCorpus.
 * Corpus-admission hardening (requirement 3) then proved app/api/reports/
 * route.ts never calls that OLD direct-indexing path at all any more, for
 * any account — that part is still true and still covered below.
 *
 * Later product decision (this file's current focus): cross-account
 * TurnitPlus corpus checking — both LOOKUP (lib/report-primary-similarity.ts)
 * and corpus-ADMISSION eligibility (lib/corpus-admission-report-
 * integration.ts's processReportAdmissionJob / app/api/reports/route.ts's
 * job-creation gate) — is now MANDATORY for every authenticated account.
 * There is no account preference capable of disabling it any more:
 * users.corpus_reuse_consented_at is a vestigial historical column
 * (db/schema.ts), signup/login/GET /api/auth/me always report
 * corpusReuseConsent=true, and PATCH /api/auth/me accepts the field for
 * request-shape back-compat but it is fully inert — it is never written,
 * and can no longer grant, revoke, or block anything (see that route's own
 * comment).
 *
 * So this file now proves: (a) every account, old or new, reports
 * corpusReuseConsent=true everywhere it's surfaced; (b) PATCH's
 * corpusReuseConsent field has zero effect on the DB or on future behavior,
 * in either direction; (c) the OLD direct-indexing path
 * (indexDocumentSubmissionIntoCorpus) is still never reached by the live
 * route, for any account, regardless of this now-inert field's value —
 * unaffected by (and unrelated to) the newer, still-flag-gated corpus-
 * admission pipeline (see tests/corpus-admission-report-integration.test.mjs
 * and tests/corpus-lookup-mandatory.test.mjs for that pipeline's own
 * mandatory-eligibility and mandatory-lookup pinning). Real route calls
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
    body: JSON.stringify(withTestIdentity({ email, password: 'consent-password-1', username: email.split('@')[0], deviceKey })),
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

// --- MANDATORY: every account reports consent=true everywhere it's surfaced ---

test('MANDATORY: a brand-new account has corpusReuseConsent=true on signup, login, and GET /api/auth/me — no opt-in step exists any more', async () => {
  const email = 'consent-default@example.test';
  const { body: signupBody } = await signup(email, 'consent-device-default');
  assert.equal(signupBody.user.corpusReuseConsent, true, 'signup response must be true — mandatory from account creation');

  const { cookie, body: loginBody } = await login(email, 'consent-device-default');
  assert.equal(loginBody.user.corpusReuseConsent, true, 'login response must be true');

  const { body: meBody } = await getMe(cookie);
  assert.equal(meBody.user.corpusReuseConsent, true, 'GET /api/auth/me must be true');
});

// --- GATE: no consent -> no corpus write ------------------------------------

test('a signed-in save creates a document identity but never indexes into the corpus via the OLD direct-indexing path (dead code, unaffected by consent either way)', async () => {
  const text = 'Entomologists cataloguing beetle diversity across a fragmented lowland rainforest reserve recorded an unexpectedly high proportion of undescribed species within a single sampled hectare.';
  const { cookie } = await signup('consent-noconsent@example.test', 'consent-device-noconsent');

  const { res } = await postReport('consent-device-noconsent', { cookie, text });
  assert.equal(res.status, 200);

  const representationId = await representationForText(text);
  assert.equal(representationId, null, 'no corpus representation should exist via the OLD direct-indexing path');

  const identityCount = await setupClient.execute({ sql: 'SELECT COUNT(*) AS cnt FROM document_identities WHERE account_id IS NOT NULL AND canonical_sha256 = ?', args: [(await import('../lib/document-identity.ts')).canonicalSha256(text)] });
  assert.equal(Number(identityCount.rows[0].cnt), 1, 'the identity row itself (Phase A/B, unaffected by consent) must still be captured');
});

// --- PATCH's corpusReuseConsent field is fully inert, in both directions ---

test("INERT: PATCH /api/auth/me with corpusReuseConsent:true never writes the (vestigial) DB column, and does NOT cause a subsequent save to index into the OLD direct-indexing path any more", async () => {
  const text = 'Volcanologists monitoring a persistently degassing stratovolcano deployed a network of low-cost gas sensors to track sulfur dioxide flux variability across the eruptive cycle.';
  const email = 'consent-grant@example.test';
  const { cookie } = await signup(email, 'consent-device-grant');

  await postReport('consent-device-grant', { cookie, text });
  assert.equal(await representationForText(text), null, 'must not be indexed via the OLD direct-indexing path');

  const patchResult = await patchMe(cookie, { username: 'consent-grant', email, corpusReuseConsent: true });
  assert.equal(patchResult.res.status, 200);
  assert.equal(patchResult.body.user.corpusReuseConsent, true, 'response is always true — mandatory, not derived from the request body');

  const userRow = await setupClient.execute({ sql: 'SELECT corpus_reuse_consented_at FROM users WHERE email = ?', args: [email] });
  assert.equal(userRow.rows[0].corpus_reuse_consented_at, null, 'REQUIRED: PATCH must never write this column any more, even when the request body sends corpusReuseConsent:true');

  // A NEW report (distinct id) with the SAME text, saved after the no-op
  // PATCH — still must not hit the OLD direct-indexing path, which the live
  // route never calls for any account.
  const after = await postReport('consent-device-grant', { cookie, text, title: 'consent-grant-2.pdf' });
  assert.equal(after.res.status, 200);
  assert.equal(await representationForText(text), null, 'no corpus representation may exist via the OLD direct-indexing path — it stays dead code regardless of this field');
});

test("INERT: PATCH /api/auth/me with corpusReuseConsent:false never disables anything and never touches the (vestigial) DB column — the response still reports true", async () => {
  const email = 'consent-revoke@example.test';
  const firstText = 'Soil scientists comparing tillage regimes across a decade-long field trial measured consistently higher aggregate stability under the no-till treatment plots.';
  const secondText = 'Limnologists sampling a dimictic lake through two full seasonal turnover cycles documented a persistent hypolimnetic oxygen deficit unrelated to nutrient loading.';

  const { cookie } = await signup(email, 'consent-device-revoke');
  await patchMe(cookie, { username: 'consent-revoke', email, corpusReuseConsent: true }); // no-op, per the test above

  await postReport('consent-device-revoke', { cookie, text: firstText });
  assert.equal(await representationForText(firstText), null, 'the OLD direct-indexing path is still never reached');

  const revoked = await patchMe(cookie, { username: 'consent-revoke', email, corpusReuseConsent: false });
  assert.equal(revoked.res.status, 200);
  assert.equal(revoked.body.user.corpusReuseConsent, true, 'REQUIRED: sending corpusReuseConsent:false must NOT flip the reported value — no account can disable this any more');
  const userRow = await setupClient.execute({ sql: 'SELECT corpus_reuse_consented_at FROM users WHERE email = ?', args: [email] });
  assert.equal(userRow.rows[0].corpus_reuse_consented_at, null, 'the DB column must be untouched (still NULL, exactly as at signup) — PATCH never writes it');

  await postReport('consent-device-revoke', { cookie, text: secondText, title: 'consent-revoke-2.pdf' });
  assert.equal(await representationForText(secondText), null, 'a save made after the no-op "revocation" attempt still never hits the OLD direct-indexing path');
});

// --- PATCH omitting the field entirely --------------------------------------

test('PATCH /api/auth/me without corpusReuseConsent still reports true (mandatory, independent of the request body) and leaves the vestigial DB column untouched', async () => {
  const email = 'consent-omit@example.test';
  const { cookie } = await signup(email, 'consent-device-omit');
  await patchMe(cookie, { username: 'consent-omit', email, corpusReuseConsent: true }); // no-op

  const plainEdit = await patchMe(cookie, { username: 'consent-omit-renamed', email });
  assert.equal(plainEdit.res.status, 200);
  assert.equal(plainEdit.body.user.corpusReuseConsent, true, 'always true, field omitted or not');

  const userRow = await setupClient.execute({ sql: 'SELECT corpus_reuse_consented_at FROM users WHERE email = ?', args: [email] });
  assert.equal(userRow.rows[0].corpus_reuse_consented_at, null, 'DB column must still be untouched after an unrelated profile edit');
});

// --- CROSS-ACCOUNT VISIBILITY: the real, user-facing effect of the gate ----

test('CROSS-ACCOUNT VISIBILITY: B never sees A as a PRIOR_SUBMISSION, whether or not A has consented — live-route indexing no longer happens either way (requirement 3)', async () => {
  const text = 'Aerospace engineers wind-tunnel testing a scaled winglet retrofit measured a modest but statistically significant reduction in induced drag across the tested angle-of-attack range.';

  const { cookie: cookieA } = await signup('consent-vis-a@example.test', 'consent-device-vis-a');
  const { cookie: cookieB } = await signup('consent-vis-b@example.test', 'consent-device-vis-b');
  // Release-hardening audit finding UI-02: historicalSubmissionMatch is now
  // admin-only on the GET response — B's own account is promoted here so
  // this test can still inspect its `.status` directly; the consent gate
  // this test actually proves (whether A's content is eligible to match at
  // all) is orthogonal to admin-only VISIBILITY of the result. See
  // tests/report-match-classification.test.mjs for the same precedent, and
  // tests/report-historical-match-visibility.test.mjs for dedicated
  // visibility coverage.
  await setupClient.execute({ sql: "UPDATE users SET role = 'admin' WHERE email = ?", args: ['consent-vis-b@example.test'] });

  // A uploads.
  await postReport('consent-device-vis-a', { cookie: cookieA, text });

  // B uploads the same content and checks their own report.
  const { id: bReportId } = await postReport('consent-device-vis-b', { cookie: cookieB, text, title: 'consent-vis-b.pdf' });
  const bGetBefore = await getReport(bReportId, { cookie: cookieB });
  const bBodyBefore = await bGetBefore.json();
  assert.equal(
    bBodyBefore.payload.historicalSubmissionMatch?.status,
    'NO_HISTORICAL_MATCH',
    'B must not see a match via the OLD direct-indexing path, which the live route never calls for any account',
  );

  // The corpusReuseConsent PATCH field is now fully inert (see the INERT
  // tests above) — sending it here changes nothing, and B still must never
  // see a match via the (still-dead) OLD direct-indexing path.
  await patchMe(cookieA, { username: 'consent-vis-a', email: 'consent-vis-a@example.test', corpusReuseConsent: true });
  await postReport('consent-device-vis-a', { cookie: cookieA, text, title: 'consent-vis-a-2.pdf' });

  const { id: bReportId2 } = await postReport('consent-device-vis-b', { cookie: cookieB, text, title: 'consent-vis-b-2.pdf' });
  const bGetAfter = await getReport(bReportId2, { cookie: cookieB });
  const bBodyAfter = await bGetAfter.json();
  assert.equal(
    bBodyAfter.payload.historicalSubmissionMatch?.status,
    'NO_HISTORICAL_MATCH',
    'B must still see no match — the (inert) PATCH field cannot cause OLD-path indexing, which stays dead code regardless',
  );
});

// --- ANONYMOUS: no account, so no admission eligibility to speak of --------

test('ANONYMOUS: an anonymous submission is never indexed via the OLD direct-indexing path (no account exists for this now-inert consent field to apply to)', async () => {
  const text = 'Structural engineers retrofitting a mid-century concrete overpass installed fiber-reinforced polymer wrap across the most heavily corroded rebar sections identified by ground-penetrating radar survey.';
  const { res } = await postReport('consent-device-anon', { text });
  assert.equal(res.status, 200);
  assert.equal(await representationForText(text), null, 'anonymous saves remain SKIPPED_ANONYMOUS');
});

// --- MANDATORY ADMISSION: the real POST /api/reports route, end-to-end ----
// The other tests in this file only prove the OLD (dead) direct-indexing
// path stays unreached. This proves the NEWER corpus-admission pipeline
// (app/api/reports/route.ts's job-creation gate -> lib/corpus-admission-
// report-integration.ts's processReportAdmissionJob) is itself unconditional
// for a never-consented account — the actual "mandatory" behavior this
// product decision requires — through the real route, not a lower-level
// helper. tests/corpus-admission-report-integration.test.mjs pins the same
// invariant directly against processReportAdmissionJob.

const WORD_BANK = ['research', 'analysis', 'sample', 'variable', 'method', 'outcome', 'temperature', 'pressure', 'reaction', 'material', 'structure', 'process', 'signal', 'pattern', 'network', 'species', 'habitat', 'climate', 'growth', 'measurement', 'instrument', 'observation', 'protocol', 'significant', 'distinct', 'gradual', 'consistent', 'notable', 'substantial', 'documented', 'identified', 'recorded', 'analyzed', 'examined', 'compared', 'measured', 'observed', 'reported'];
function longEnglishText(seed, targetWords = 3300) {
  let state = seed >>> 0 || 1;
  const rng = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0xffffffff; };
  const words = [];
  while (words.length < targetWords) {
    words.push('The', WORD_BANK[Math.floor(rng() * WORD_BANK.length)], WORD_BANK[Math.floor(rng() * WORD_BANK.length)], 'was', WORD_BANK[Math.floor(rng() * WORD_BANK.length)] + '.');
  }
  return words.join(' ');
}

test('MANDATORY ADMISSION (real route, end-to-end): an account that never consented (corpus_reuse_consented_at stays NULL throughout) still gets a real corpus-admission job created and ACCEPTed by POST /api/reports — no per-account preference blocks corpus-admission eligibility any more', async () => {
  const originalAdmissionFlag = process.env.CORPUS_ADMISSION_ENABLED;
  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  try {
    const email = 'consent-mandatory-admission@example.test';
    const deviceKey = 'consent-device-mandatory-admission';
    const text = longEnglishText(777);
    const { cookie } = await signup(email, deviceKey);

    const userRow = await setupClient.execute({ sql: 'SELECT id, corpus_reuse_consented_at FROM users WHERE email = ?', args: [email] });
    const accountId = userRow.rows[0].id;
    assert.equal(userRow.rows[0].corpus_reuse_consented_at, null, 'test setup sanity: this account never consented and never will — nothing in this test ever PATCHes it');

    const { res, id: reportId } = await postReport(deviceKey, { cookie, text });
    assert.equal(res.status, 200);

    const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });
    const job = await setupClient.execute({ sql: 'SELECT status FROM corpus_admission_report_jobs WHERE source_ref = ?', args: [sourceRef] });
    assert.equal(job.rows.length, 1, 'REQUIRED: a corpus-admission job must be created even though this account never consented');
    assert.equal(job.rows[0].status, 'succeeded', 'REQUIRED: the job must be evaluated (never cancelled for lack of consent) — runAfterResponse runs inline and awaited in tests, see lib/run-after-response.ts');

    const decision = await setupClient.execute({ sql: 'SELECT decision FROM corpus_admission_decisions WHERE source_ref = ?', args: [sourceRef] });
    assert.equal(decision.rows.length, 1);
    assert.equal(decision.rows[0].decision, 'ACCEPT', 'a long, English, quality submission from a never-consented account must be free to ACCEPT — consent is no longer part of the decision');

    const stillUnconsented = await setupClient.execute({ sql: 'SELECT corpus_reuse_consented_at FROM users WHERE id = ?', args: [accountId] });
    assert.equal(stillUnconsented.rows[0].corpus_reuse_consented_at, null, 'sanity: still never consented — the ACCEPT above did not require or produce consent');
  } finally {
    if (originalAdmissionFlag === undefined) delete process.env.CORPUS_ADMISSION_ENABLED;
    else process.env.CORPUS_ADMISSION_ENABLED = originalAdmissionFlag;
  }
});
