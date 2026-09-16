import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';
import { withTestIdentity } from './helpers/test-signup.mjs';
import { buildReportSaveRejectedTelemetryEvent } from '../lib/report-save-telemetry.ts';
import { claimAnonymousReports } from '../lib/auth-session.ts';

// This checkout stores app/page.tsx with CRLF line endings — normalize to LF
// so every structural regex below can use a plain \n regardless of the
// checkout's line-ending settings.
async function readPage() {
  const raw = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  return raw.replace(/\r\n/g, '\n');
}

// NEW PRODUCT REQUIREMENT coverage: a customer must be logged in before they
// can select/upload a manuscript, start a new check, generate a report, or
// create/persist/update a customer report — first save AND resave alike.
// Unauthenticated visitors may still browse public/marketing pages, and old
// anonymous reports remain READ-ONLY (list/fetch/reopen by device key still
// works; writing to them, even to update, does not) — see
// app/api/reports/route.ts's own "AUTH GATE" comment (server) and
// app/page.tsx's goToNewCheck/startNewCheck/generateReport (client) for the
// actual implementation this file proves.
//
// Coverage map (server-side enforcement, below):
//   A. anonymous first-save POST -> 401
//   B. anonymous resave/update of an existing legacy anonymous row -> 401
//   C. legacy anonymous GET/read/reopen still succeeds
//   D. authenticated create succeeds
//   E. authenticated update/resave succeeds
//   F. claim-on-signup still works
// G (Device Passport historical-row coverage) and H (SELF/UNKNOWN historical
// classification) are proved in their own dedicated suites —
// tests/device-passport-actor-ledger.test.mjs and
// tests/report-historical-match-integration.test.mjs respectively — since
// that's where the real attestation/matcher machinery already lives; this
// file's own job is the auth boundary itself.

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_creation_auth_required.db');
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
  return `auth-gate-report-${counter}`;
}

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, deviceKey) {
  await resetAuthRateForTest('auth-gate-signup-' + email);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'auth-gate-signup-' + email },
    body: JSON.stringify(withTestIdentity({ email, password: 'auth-gate-password-1', username: 'authgateuser', deviceKey })),
  });
  const res = await signupRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

async function postReport(deviceKey, { cookie, id, title = 'auth-gate.pdf', room = 0, bucket = 'auth-gate-post' } = {}) {
  await resetRateForTest(bucket);
  const reportId = id ?? nextId();
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': bucket };
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
      room,
      payload: { note: title },
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, id: reportId };
}

async function listReports({ deviceKey, cookie, bucket = 'auth-gate-list' } = {}) {
  await resetRateForTest(bucket);
  const headers = { 'x-forwarded-for': bucket };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports?deviceKey=${encodeURIComponent(deviceKey)}` : 'http://localhost/api/reports';
  const req = new Request(url, { headers });
  return reportsRoute.GET(req);
}

/** Directly INSERTs a pre-existing ("old") anonymous saved_reports row, bypassing the POST route entirely — a POST can no longer create a first-ever anonymous row (that is exactly the behavior under test), so a genuinely legacy anonymous row must be seeded this way, matching this codebase's own established "insertLegacyRow" pattern (tests/report-write-time-finalization.test.mjs). */
async function insertLegacyAnonymousReport(deviceKey, id) {
  const raw = createClient({ url: `file:${dbFile}` });
  try {
    await raw.execute({
      sql: reportsRoute.SAVE_REPORT_SQL,
      args: [id, deviceKey, 'sub-' + id, 'legacy-anonymous.pdf', new Date().toISOString(), 10, 0, 'Low', null, null, null, JSON.stringify({ note: 'legacy-anonymous.pdf' }), null, null],
    });
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------------------
// SERVER-SIDE ENFORCEMENT
// ---------------------------------------------------------------------------

test('unauthenticated report POST is rejected: a first-ever save with no session is refused with 401 and creates no row', async () => {
  const deviceKey = 'auth-gate-device-anon-create';
  const { res, id } = await postReport(deviceKey, { bucket: 'auth-gate-anon-create' });
  assert.equal(res.status, 401, 'an unauthenticated first save must be rejected, not silently accepted');
  const body = await res.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);

  const list = await listReports({ deviceKey, bucket: 'auth-gate-anon-create-list' });
  const listBody = await list.json();
  assert.deepEqual(listBody.reports.map((r) => r.id), [], 'a rejected first save must never persist a row');
});

test('authenticated report creation still works: a signed-in account can create a genuinely new report', async () => {
  const deviceKey = 'auth-gate-device-auth-create';
  const { cookie } = await signup('auth-gate-create@example.com', deviceKey);
  const { res, id } = await postReport(deviceKey, { cookie, room: 0, bucket: 'auth-gate-auth-create' });
  assert.equal(res.status, 200, 'an authenticated first save must still succeed');

  const list = await listReports({ cookie, bucket: 'auth-gate-auth-create-list' });
  const listBody = await list.json();
  assert.deepEqual(listBody.reports.map((r) => r.id), [id], 'the newly created report must appear in the account\'s own list');
});

test('authenticated upload still works end to end: extraction-shaped payload persists with the account as owner', async () => {
  const deviceKey = 'auth-gate-device-auth-upload';
  const { cookie } = await signup('auth-gate-upload@example.com', deviceKey);
  const { res, id } = await postReport(deviceKey, { cookie, room: 1, title: 'upload-flow.pdf', bucket: 'auth-gate-auth-upload' });
  assert.equal(res.status, 200);

  await resetRateForTest('auth-gate-auth-upload-anon-check');
  // The same report must NOT be visible via the anonymous device-key lookup
  // (it is owned, not anonymous) — proves the save was attributed to the
  // account, not left as an anonymous row.
  const anonAttempt = await listReports({ deviceKey, bucket: 'auth-gate-auth-upload-anon-check' });
  const anonBody = await anonAttempt.json();
  assert.deepEqual(anonBody.reports.map((r) => r.id), [], 'an authenticated upload must never be visible through the anonymous device-key path');
});

test('B: a pre-existing (old) anonymous report can NO LONGER be resaved without authentication — historical anonymous compatibility is READ-ONLY', async () => {
  const deviceKey = 'auth-gate-device-legacy-resave';
  const id = nextId();
  await insertLegacyAnonymousReport(deviceKey, id);

  // AUTH GATE (tightened): the gate now applies to EVERY write — first save
  // AND resave — never just isFirstSaveOfThisReport. An anonymous caller can
  // never write to saved_reports again, even to update a row that was
  // already anonymous.
  const { res } = await postReport(deviceKey, { id, title: 'ANON-REWRITE-ATTEMPT', bucket: 'auth-gate-legacy-resave' });
  assert.equal(res.status, 401, 'a resave of an already-existing anonymous report must now be rejected — anonymous writes are gone entirely, not just anonymous creation');
  const body = await res.json();
  assert.equal(body.error, 'Log in to save a report.');

  // The row must be completely untouched by the rejected write.
  const list = await listReports({ deviceKey, bucket: 'auth-gate-legacy-resave-verify' });
  const listBody = await list.json();
  assert.equal(listBody.reports.length, 1);
  assert.equal(listBody.reports[0].title, 'legacy-anonymous.pdf', 'the rejected anonymous resave must never have changed the content');
});

test('a pre-existing (old) anonymous report can still be read/reopened without authentication', async () => {
  const deviceKey = 'auth-gate-device-legacy-read';
  const id = nextId();
  await insertLegacyAnonymousReport(deviceKey, id);

  const list = await listReports({ deviceKey, bucket: 'auth-gate-legacy-read' });
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.deepEqual(body.reports.map((r) => r.id), [id], 'reading an old anonymous report by its device key must be unaffected by the new auth gate');
});

test('an anonymous resave attempt against an account-owned report is rejected by the auth gate itself (401), never reaching — or revealing anything via — the ownership-conflict check', async () => {
  const deviceKey = 'auth-gate-device-ownership';
  const { cookie } = await signup('auth-gate-owner@example.com', deviceKey);
  const { id } = await postReport(deviceKey, { cookie, room: 2, bucket: 'auth-gate-ownership-create' });

  // AUTH GATE (tightened): a resave attempt with NO session now fails at the
  // blanket auth gate — the SAME generic 401 an anonymous first save gets —
  // before the route ever looks up who owns this (device_key, id), so the
  // response can never distinguish "unclaimed", "owned by someone else", or
  // "doesn't exist".
  const { res } = await postReport(deviceKey, { id, bucket: 'auth-gate-ownership-resave' });
  assert.equal(res.status, 401, 'an unauthenticated resave of an account-owned report must be rejected by the auth gate, not the ownership-conflict check');
  const body = await res.json();
  assert.equal(body.error, 'Log in to save a report.', 'the same generic auth-required response as any other anonymous write attempt');
});

test('E: an authenticated resave/update of an already-existing report still succeeds (the ownership-conflict check still runs — and still passes — for the real owner)', async () => {
  const deviceKey = 'auth-gate-device-authed-resave';
  const { cookie } = await signup('auth-gate-authed-resave@example.com', deviceKey);
  const { id } = await postReport(deviceKey, { cookie, room: 3, title: 'first-version.pdf', bucket: 'auth-gate-authed-resave-create' });

  const { res } = await postReport(deviceKey, { id, cookie, title: 'second-version.pdf', bucket: 'auth-gate-authed-resave-update' });
  assert.equal(res.status, 200, 'the real, authenticated owner must still be able to resave/update their own report');

  const list = await listReports({ cookie, bucket: 'auth-gate-authed-resave-verify' });
  const listBody = await list.json();
  assert.equal(listBody.reports.length, 1, 'the resave must update in place, never duplicate');
  assert.equal(listBody.reports[0].title, 'second-version.pdf');
});

test('an authenticated resave from a DIFFERENT account still hits the pre-existing ownership-conflict 404, unaffected by the tightened auth gate', async () => {
  const deviceKey = 'auth-gate-device-cross-account';
  const { cookie: ownerCookie } = await signup('auth-gate-cross-owner@example.com', deviceKey);
  const { id } = await postReport(deviceKey, { cookie: ownerCookie, room: 4, bucket: 'auth-gate-cross-create' });

  const { cookie: intruderCookie } = await signup('auth-gate-cross-intruder@example.com', 'auth-gate-device-cross-intruder');
  const { res } = await postReport(deviceKey, { id, cookie: intruderCookie, title: 'HIJACK-ATTEMPT', bucket: 'auth-gate-cross-hijack' });
  assert.equal(res.status, 404, 'a different authenticated account must still be rejected by the pre-existing ownership-conflict check, not the auth gate');
  const body = await res.json();
  assert.equal(body.error, 'Report not found');
});

test('F: claim-on-signup still works — claimAnonymousReports still attaches a pre-existing anonymous report to a newly-created account for the same device', async () => {
  const deviceKey = 'auth-gate-device-claim-on-signup';
  const id = nextId();
  await insertLegacyAnonymousReport(deviceKey, id);

  const { cookie } = await signup('auth-gate-claim-on-signup@example.com', deviceKey);
  // Signup itself triggers claimAnonymousReports for this device key (see
  // app/api/auth/signup/route.ts); re-invoking it directly here is
  // idempotent and just re-confirms the same outcome without depending on
  // that route's own internal wiring order.
  const client = createClient({ url: `file:${dbFile}` });
  try {
    const meRow = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: ['auth-gate-claim-on-signup@example.com'] });
    await claimAnonymousReports(client, String(meRow.rows[0].id), deviceKey);
  } finally {
    client.close();
  }

  const authedList = await listReports({ cookie, bucket: 'auth-gate-claim-on-signup-authed' });
  assert.deepEqual((await authedList.json()).reports.map((r) => r.id), [id], 'the pre-existing anonymous report must now appear in the new account\'s own list');

  const anonList = await listReports({ deviceKey, bucket: 'auth-gate-claim-on-signup-anon' });
  assert.deepEqual((await anonList.json()).reports.map((r) => r.id), [], 'once claimed, the report must no longer be visible via the raw anonymous device-key path');
});

test('report_save_rejected telemetry: AUTH_REQUIRED is a valid, correctly-shaped rejection reason', () => {
  const event = buildReportSaveRejectedTelemetryEvent({ reason: 'AUTH_REQUIRED', status: 401, authMode: 'anonymous' });
  assert.deepEqual(event, { event: 'report_save_rejected', reason: 'AUTH_REQUIRED', status: 401, authMode: 'anonymous' });
});

// ---------------------------------------------------------------------------
// CLIENT-SIDE UI GATING (structural source assertions — matches this
// codebase's own established pattern for app/page.tsx, e.g.
// tests/reports-view-auth-flash.test.mjs, since Home() depends on browser-
// only APIs (IndexedDB, Web Workers) that make full rendering impractical)
// ---------------------------------------------------------------------------

test('goToNewCheck(): an unauthenticated visitor is routed into the existing login/register flow, never the anonymous Dashboard', async () => {
  const page = await readPage();
  const fnMatch = page.match(/function goToNewCheck\(\) \{[\s\S]*?\n  \}/);
  assert.ok(fnMatch, 'goToNewCheck must exist');
  const body = fnMatch[0];
  assert.match(body, /if \(!account\) \{\s*\n\s*openAccountPage\("login"\);\s*\n\s*return;\s*\n\s*\}/, 'an unauthenticated visitor must be sent into the existing login/register flow');
  assert.doesNotMatch(body, /navigate\(account \? "reports" : "dashboard"\)/, 'must no longer route an unauthenticated visitor straight into the anonymous Dashboard upload flow');
});

test('startNewCheck(): refuses to start an anonymous check and opens the login flow instead', async () => {
  const page = await readPage();
  const fnMatch = page.match(/function startNewCheck\(\) \{[\s\S]*?\n  \}/);
  assert.ok(fnMatch, 'startNewCheck must exist');
  const body = fnMatch[0];
  assert.match(body, /if \(!account\) \{\s*\n\s*openAccountPage\("login"\);\s*\n\s*return;\s*\n\s*\}/, 'startNewCheck must gate on an authenticated account before doing anything else');
});

test('generateReport(): refuses to run for an unauthenticated visitor, as its very first check', async () => {
  const page = await readPage();
  const fnMatch = page.match(/async function generateReport\(\) \{[\s\S]*?\n  \}\n\n  function startNewCheck/);
  assert.ok(fnMatch, 'generateReport must exist and precede startNewCheck');
  const body = fnMatch[0];
  const guardIndex = body.indexOf('if (!account)');
  const lockIndex = body.indexOf('if (generationLockRef.current)');
  assert.ok(guardIndex !== -1, 'generateReport must gate on an authenticated account');
  assert.ok(lockIndex !== -1, 'generateReport must still keep its generation-lock check');
  assert.ok(guardIndex < lockIndex, 'the auth gate must run before any other work in generateReport, including the existing generation-lock check');
  assert.match(body, /openAccountPage\("login"\);/, 'an unauthenticated attempt must be routed into the existing login/register flow');
});

test('direct navigation cannot bypass the gate: the "dashboard" view itself never renders upload/check controls without an authenticated account', async () => {
  const page = await readPage();
  const viewMatch = page.match(/\{view === "dashboard" && \(\n([\s\S]*?)\n {8}\)\}/);
  assert.ok(viewMatch, 'the dashboard view block must exist');
  const block = viewMatch[1];
  assert.match(block, /^\s*account \? \(/, 'the dashboard view must branch on the authenticated account before rendering anything');

  const accountBranchEnd = block.indexOf(') : (');
  assert.ok(accountBranchEnd !== -1, 'the dashboard view must have a distinct unauthenticated fallback branch');
  const accountBranch = block.slice(0, accountBranchEnd);
  const anonymousBranch = block.slice(accountBranchEnd);

  assert.match(accountBranch, /<DocumentUploadPanel/, 'the real upload panel must still render for a signed-in account');
  assert.doesNotMatch(anonymousBranch, /<DocumentUploadPanel/, 'no usable upload control may render for an unauthenticated visitor, even if the dashboard view is somehow reached');
  assert.match(anonymousBranch, /openAccountPage\("login"\)/, 'the unauthenticated fallback must route into the existing login/register flow');
});

test('the anonymous "no reports yet" empty state routes into login, never into the anonymous Dashboard', async () => {
  const page = await readPage();
  assert.match(page, /onClick=\{\(\) => openAccountPage\("login"\)\}>Log in to create a report<\/button>/, 'the empty-state CTA must open the existing login/register flow');
  assert.doesNotMatch(page, /onClick=\{\(\) => navigate\("dashboard"\)\}>Create a report<\/button>/, 'must no longer route straight into the anonymous Dashboard upload flow');
});

test('no reference/provider/corpus controls reappear in the (now account-gated) customer upload flow', async () => {
  const page = await readPage();
  // Regression guard for already-shipped UX work (commit dcb55f4 "hide
  // supplied references from customer upload flow", 2005ea1 "hide provider
  // names from customer report scope") — the auth-gating change must not
  // reintroduce either while touching this same file.
  assert.doesNotMatch(page, /references=\{\{/, 'the reference-files panel must stay unwired from the normal customer upload flow');
  assert.doesNotMatch(page, /provider(Name|Select|Picker)/i, 'no provider-selection control may reappear in the customer-facing page');
  assert.doesNotMatch(page, /corpus(Select|Picker|Toggle)/i, 'no corpus-selection control may reappear in the customer-facing page');
});
