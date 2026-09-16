import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';
import { withTestIdentity } from './helpers/test-signup.mjs';

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_api_reports_account_scoping.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

let counter = 0;
function nextId() {
  counter += 1;
  return `scoping-report-${counter}`;
}

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function postReport(deviceKey, { cookie, id, title = 'scoping.pdf' } = {}) {
  await resetRateForTest('scoping-post');
  const reportId = id ?? nextId();
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': 'scoping-post' };
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
      wordCount: 10,
      archiveScore: 0,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      payload: { note: title },
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, id: reportId };
}

async function listReports({ deviceKey, cookie } = {}) {
  await resetRateForTest('scoping-list');
  const headers = { 'x-forwarded-for': 'scoping-list' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports?deviceKey=${encodeURIComponent(deviceKey)}` : 'http://localhost/api/reports';
  const req = new Request(url, { headers });
  return reportsRoute.GET(req);
}

async function getReport(id, { deviceKey, cookie } = {}) {
  await resetRateForTest('scoping-get');
  const headers = { 'x-forwarded-for': 'scoping-get' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { headers });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
}

/** Directly INSERTs a pre-existing ("old") anonymous saved_reports row, bypassing the POST route entirely — a POST can no longer create a first-ever anonymous row (see app/api/reports/route.ts's own "AUTH GATE" comment), so a genuinely legacy anonymous fixture is seeded this way, matching this codebase's own established pattern (see tests/report-write-time-finalization.test.mjs's own insertLegacyRow). Every scenario below is about what happens to an EXISTING anonymous report (claim-on-signup/login, resave rules, ownership) — none of them are about how that report first came to exist, so this substitution changes nothing about what each scenario proves. */
async function insertLegacyAnonymousReport(deviceKey, { id, title = 'scoping.pdf' } = {}) {
  const reportId = id ?? nextId();
  const raw = createClient({ url: `file:${dbFile}` });
  try {
    await raw.execute({
      sql: reportsRoute.SAVE_REPORT_SQL,
      args: [reportId, deviceKey, 'sub-' + reportId, title, new Date().toISOString(), 10, 0, 'Low', null, null, null, JSON.stringify({ note: title }), null, null],
    });
  } finally {
    raw.close();
  }
  return { id: reportId };
}

async function signup(email, deviceKey) {
  await resetAuthRateForTest('scoping-signup');
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'scoping-signup' },
    body: JSON.stringify(withTestIdentity({ email, password: 'scoping-password-1', username: 'scopeuser', deviceKey })),
  });
  const res = await signupRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

async function login(email, deviceKey) {
  await resetAuthRateForTest('scoping-login');
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'scoping-login' },
    body: JSON.stringify({ email, password: 'scoping-password-1', deviceKey }),
  });
  const res = await loginRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

// Scenario A: signup claims a device's existing (pre-existing/legacy)
// anonymous report, and the leak-fix regression — the raw device_key path
// must stop seeing it. AUTH GATE: a live anonymous POST can no longer create
// a first-ever report at all, so this is seeded as an old, already-existing
// anonymous row instead — exactly the scenario claimAnonymousReports itself
// exists for.
const deviceA = 'scoping-device-A';
const { id: reportA } = await insertLegacyAnonymousReport(deviceA);
{
  const anonBefore = await listReports({ deviceKey: deviceA });
  const anonBeforeBody = await anonBefore.json();
  assert.equal(anonBeforeBody.reports.length, 1, 'anonymous device A should see its own pre-existing report before signup');

  const { res: signupRes, cookie: cookieA } = await signup('scope-a@example.com', deviceA);
  assert.equal(signupRes.status, 201);
  assert.ok(cookieA);

  const authedList = await listReports({ cookie: cookieA });
  const authedBody = await authedList.json();
  assert.equal(authedBody.reports.length, 1, 'authenticated list must show the claimed report');
  assert.equal(authedBody.reports[0].id, reportA);

  const anonAfter = await listReports({ deviceKey: deviceA });
  const anonAfterBody = await anonAfter.json();
  assert.equal(anonAfterBody.reports.length, 0, 'REGRESSION: claimed reports must no longer be visible via the raw device_key path (shared-computer leak)');

  const anonGetAfter = await getReport(reportA, { deviceKey: deviceA });
  assert.equal(anonGetAfter.status, 404, 'REGRESSION: a claimed report must not be fetchable via the raw device_key path either');

  const authedGet = await getReport(reportA, { cookie: cookieA });
  assert.equal(authedGet.status, 200, 'the authenticated owner must still be able to fetch the claimed report');

  console.log('scenario A (signup claim + leak-fix regression) passed');

  // Release-hardening audit finding AUTHZ-01 (corrected), scenario D: an
  // ANONYMOUS re-save of an already-claimed (owned) report must now be
  // REJECTED outright, never silently accepted. AUTH GATE (further
  // tightened): a caller with no session at all can no longer write to
  // saved_reports at all — first save or resave — so this now fails at the
  // AUTH GATE itself (401), before the ownership-conflict check below is
  // ever reached, never revealing whether this exact (device_key, id) is
  // claimed, unclaimed, or doesn't exist. The legitimate double-save flow
  // carries the SAME session as the first save (same-origin fetch, cookies
  // included by default) and is covered separately below; if a user
  // genuinely signs out between the two saves, rejecting the second one is
  // the correct, safe behavior, not a bug.
  const beforeAnonResave = await getReport(reportA, { cookie: cookieA });
  const beforeAnonResaveBody = await beforeAnonResave.json();

  const { res: anonResaveRes } = await postReport(deviceA, { id: reportA, title: 'ANON-OVERWRITE-ATTEMPT' });
  assert.equal(anonResaveRes.status, 401, 'an anonymous resave of an account-owned report must be rejected by the auth gate, not silently accepted');
  const anonResaveBody = await anonResaveRes.json();
  assert.equal(anonResaveBody.error, 'Log in to save a report.', 'the rejection is the same generic auth-required response as an anonymous first save — it never reveals anything about this report');

  const afterAnonResave = await getReport(reportA, { cookie: cookieA });
  const afterAnonResaveBody = await afterAnonResave.json();
  assert.deepEqual(afterAnonResaveBody, beforeAnonResaveBody, 'the report must be byte-for-byte unchanged after the rejected anonymous resave attempt');
  assert.notEqual(JSON.stringify(afterAnonResaveBody).includes('ANON-OVERWRITE'), true, 'the malicious title must never have been written');

  const authedListAfterAnonResave = await listReports({ cookie: cookieA });
  const authedListAfterAnonResaveBody = await authedListAfterAnonResave.json();
  assert.equal(authedListAfterAnonResaveBody.reports.length, 1, 'the report must still belong to its real owner, unaffected by the rejected attempt');
  assert.equal(authedListAfterAnonResaveBody.reports[0].id, reportA);

  const anonListAfterAnonResave = await listReports({ deviceKey: deviceA });
  const anonListAfterAnonResaveBody = await anonListAfterAnonResave.json();
  assert.equal(anonListAfterAnonResaveBody.reports.length, 0, 'the report must remain invisible via the anonymous device-key path — ownership was never transferred either direction');
  console.log('scenario D (an anonymous resave of an account-owned report is rejected, ownership never transferred) passed');

  // Release-hardening audit finding AUTHZ-01, scenario E: a DIFFERENT
  // signed-in account that knows reportA's exact (device_key, id) — the
  // real identifiers, not guessed — must be rejected outright on resave,
  // and must never modify or claim the row, even though it IS a real,
  // authenticated session (same generic 404 as scenario D's anonymous
  // case — see app/api/reports/route.ts's own comment on this policy).
  const { cookie: cookieIntruder } = await signup('scope-intruder@example.com', 'scoping-device-intruder');
  assert.ok(cookieIntruder, 'the intruder account must have its own real, valid session');

  const beforeIntrusion = await getReport(reportA, { cookie: cookieA });
  const beforeIntrusionBody = await beforeIntrusion.json();

  const { res: intrusionRes } = await postReport(deviceA, {
    id: reportA,
    title: 'HIJACKED-BY-ACCOUNT-B',
    cookie: cookieIntruder,
  });
  assert.equal(intrusionRes.status, 404, 'a different authenticated account resaving another account\'s exact (device_key, id) must be rejected, not silently accepted');
  const intrusionBody = await intrusionRes.json();
  assert.equal(intrusionBody.error, 'Report not found', 'the rejection must not reveal that this report belongs to someone else');

  const afterIntrusion = await getReport(reportA, { cookie: cookieA });
  const afterIntrusionBody = await afterIntrusion.json();
  assert.deepEqual(afterIntrusionBody, beforeIntrusionBody, 'the report must be byte-for-byte unchanged after the rejected hijack attempt');
  assert.notEqual(JSON.stringify(afterIntrusionBody).includes('HIJACKED'), true, 'the malicious title must never have been written');

  const intruderList = await listReports({ cookie: cookieIntruder });
  const intruderListBody = await intruderList.json();
  assert.equal(intruderListBody.reports.length, 0, 'the intruder account must not gain visibility into a report it failed to hijack');

  const ownerListAfterIntrusion = await listReports({ cookie: cookieA });
  const ownerListAfterIntrusionBody = await ownerListAfterIntrusion.json();
  assert.equal(ownerListAfterIntrusionBody.reports.length, 1, 'the real owner must still see exactly their own report');
  assert.equal(ownerListAfterIntrusionBody.reports[0].id, reportA);

  console.log('scenario E (a different authenticated account cannot hijack another account\'s report, even knowing the exact identifiers) passed');

  // Release-hardening audit finding AUTHZ-01, scenario F: the SAME
  // authenticated owner resaving their own report must keep working
  // exactly as before — this is both the ordinary "edit and resave" flow
  // and the real shape of the Wikipedia-enrichment double-save (both
  // fetches carry the same session, since it's the same signed-in browser
  // saving the same report id twice in a row).
  const { res: ownerResaveRes } = await postReport(deviceA, {
    id: reportA,
    title: 'scoping-updated-by-real-owner.pdf',
    cookie: cookieA,
  });
  assert.equal(ownerResaveRes.status, 200, 'the real, authenticated owner must still be able to resave their own report');

  const ownerListAfterOwnerResave = await listReports({ cookie: cookieA });
  const ownerListAfterOwnerResaveBody = await ownerListAfterOwnerResave.json();
  assert.equal(ownerListAfterOwnerResaveBody.reports.length, 1, 'ownership must be completely unaffected by a same-owner resave');
  assert.equal(ownerListAfterOwnerResaveBody.reports[0].id, reportA);
  assert.equal(ownerListAfterOwnerResaveBody.reports[0].title, 'scoping-updated-by-real-owner.pdf');

  console.log('scenario F (the same authenticated owner can still resave their own report — the real double-save shape) passed');

  // Scenario B: a second device belonging to the same account, claimed via
  // login rather than signup, and the resulting cross-device list.
  const deviceB = 'scoping-device-B';
  const { id: reportB } = await insertLegacyAnonymousReport(deviceB);
  const anonBBefore = await listReports({ deviceKey: deviceB });
  assert.equal((await anonBBefore.json()).reports.length, 1);

  const { res: loginRes, cookie: cookieB } = await login('scope-a@example.com', deviceB);
  assert.equal(loginRes.status, 200);
  assert.ok(cookieB);

  const crossDeviceList = await listReports({ cookie: cookieB });
  const crossDeviceBody = await crossDeviceList.json();
  const ids = crossDeviceBody.reports.map((r) => r.id).sort();
  assert.deepEqual(ids, [reportA, reportB].sort(), 'logging in on a second device must claim its anonymous reports AND show the full cross-device list');

  const anonBAfter = await listReports({ deviceKey: deviceB });
  assert.equal((await anonBAfter.json()).reports.length, 0, 'device B\'s reports must also disappear from its own raw device_key path after login-claim');

  console.log('scenario B (login claims a second device + cross-device list) passed');
}

// Scenario C: a device that never authenticates is completely unaffected by
// any of the above.
{
  const deviceC = 'scoping-device-C';
  const { id: reportC } = await insertLegacyAnonymousReport(deviceC);
  const listC = await listReports({ deviceKey: deviceC });
  const bodyC = await listC.json();
  assert.equal(bodyC.reports.length, 1);
  assert.equal(bodyC.reports[0].id, reportC);
  console.log('scenario C (never-authenticated device unaffected) passed');

  // Release-hardening audit finding AUTHZ-01, scenario G — AUTH GATE
  // (further tightened): a report whose existing owner is genuinely NULL
  // (never claimed by anyone) is READ-ONLY for an anonymous caller now —
  // the ownership guard used to let an anonymous resave through untouched
  // (never claiming it, just updating content), but that WRITE path is
  // exactly what this correction removes. Historical anonymous
  // compatibility from here on is read/reopen only.
  const { res: anonResaveOwnResRes } = await postReport(deviceC, { id: reportC, title: 'scoping-c-updated.pdf' });
  assert.equal(anonResaveOwnResRes.status, 401, 'an anonymous resave of a never-claimed (user_id IS NULL) report must now be rejected — anonymous writes are gone entirely');
  const anonResaveOwnResBody = await anonResaveOwnResRes.json();
  assert.equal(anonResaveOwnResBody.error, 'Log in to save a report.');

  const listCAfterRejectedResave = await listReports({ deviceKey: deviceC });
  const bodyCAfterRejectedResave = await listCAfterRejectedResave.json();
  assert.equal(bodyCAfterRejectedResave.reports.length, 1, 'still exactly one report, completely untouched by the rejected write');
  assert.equal(bodyCAfterRejectedResave.reports[0].id, reportC);
  assert.equal(bodyCAfterRejectedResave.reports[0].title, 'scoping.pdf', 'the rejected anonymous resave must never have changed the content — still the original legacy title');
  console.log('scenario G (an anonymous resave of a never-claimed report is now rejected, content untouched) passed');

  // Scenario H: the ONLY way left to touch that same never-claimed legacy
  // row is an authenticated resave, which legitimately CLAIMS it (the
  // "claim by resave" path — distinct from claim-on-signup/login in
  // scenarios A/B, and still fully supported, per app/api/reports/route.ts's
  // own ownership-conflict comment: existing user_id IS NULL lets an
  // AUTHENTICATED resave through and COALESCE assigns real ownership).
  const { cookie: cookieH } = await signup('scope-h@example.com', 'scoping-device-h');
  const { res: authedClaimResaveRes } = await postReport(deviceC, { id: reportC, title: 'scoping-c-claimed-by-resave.pdf', cookie: cookieH });
  assert.equal(authedClaimResaveRes.status, 200, 'an authenticated resave of a never-claimed legacy row must still succeed and claim it');

  const claimedRow = await getReport(reportC, { cookie: cookieH });
  assert.equal(claimedRow.status, 200, 'the authenticated claimant can now read the row back through their own session');
  const claimedBody = await claimedRow.json();
  assert.equal(claimedBody.payload.note, 'scoping-c-claimed-by-resave.pdf', 'the authenticated resave actually updated the content');

  const anonListAfterClaimByResave = await listReports({ deviceKey: deviceC });
  assert.equal((await anonListAfterClaimByResave.json()).reports.length, 0, 'once claimed by resave, the report must no longer be visible via the raw anonymous device_key path');
  console.log('scenario H (an authenticated resave still legitimately claims a never-claimed legacy row) passed');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All account-scoping tests passed');
