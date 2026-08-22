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
import { canonicalSha256 } from '../lib/document-identity.ts';
import { ACCOUNT_DELETION_CONFIRMATION_PHRASE } from '../lib/account-deletion.ts';

/**
 * Account deletion (production audit fix — no such endpoint existed
 * before). Real DB calls throughout, real route handlers, no mocking,
 * matching this repo's existing test convention. Reuses the exact setup
 * pattern already proven in tests/report-deletion-privacy.test.mjs.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_account_deletion.db');
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
  return `deletion-account-report-${counter}`;
}

const PASSWORD = 'account-deletion-password-1';

async function signup(email, deviceKey) {
  await resetAuthRateForTest('acct-del-signup-' + email);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'acct-del-signup-' + email },
    body: JSON.stringify({ email, password: PASSWORD, username: email.split('@')[0], deviceKey }),
  });
  const res = await signupRoute.POST(req);
  const body = await res.json();
  return { res, cookie: extractCookie(res), userId: null, body };
}

async function login(email, deviceKey, ip = 'acct-del-login') {
  await resetAuthRateForTest(ip + email);
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip + email },
    body: JSON.stringify({ email, password: PASSWORD, deviceKey }),
  });
  const res = await loginRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

async function me(cookie, ip = 'acct-del-me') {
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/auth/me', { headers });
  return meRoute.GET(req);
}

async function deleteAccount(cookie, { password = PASSWORD, confirm = ACCOUNT_DELETION_CONFIRMATION_PHRASE, ip = 'acct-del-delete' } = {}) {
  await resetAuthRateForTest(ip);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/auth/me', {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ password, confirm }),
  });
  return meRoute.DELETE(req);
}

// Room/slot architecture: required for an authenticated first save (see
// app/api/reports/route.ts); ignored for anonymous requests and resaves. A
// fresh, auto-incrementing default so a scenario posting more than one
// genuinely new report for the same account never collides with itself —
// this file's scenarios are about account deletion, not room occupancy.
let roomCounter = 0;
function nextRoom() {
  const room = roomCounter % 10;
  roomCounter += 1;
  return room;
}

async function postReport(deviceKey, { cookie, id, title = 'account-deletion.pdf', text, room = nextRoom() } = {}) {
  await resetRateForTest('acct-del-post');
  const reportId = id ?? nextId();
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': 'acct-del-post' };
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

async function grantConsent(email) {
  await setupClient.execute({ sql: 'UPDATE users SET corpus_reuse_consented_at = CURRENT_TIMESTAMP WHERE email = ?', args: [email] });
}

async function userExists(email) {
  const result = await setupClient.execute({ sql: 'SELECT 1 FROM users WHERE email = ?', args: [email] });
  return result.rows.length > 0;
}

async function sessionCountForEmail(email) {
  const result = await setupClient.execute({
    sql: 'SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)',
    args: [email],
  });
  return Number(result.rows[0].cnt);
}

async function reportCountForEmail(email) {
  const result = await setupClient.execute({
    sql: 'SELECT COUNT(*) AS cnt FROM saved_reports WHERE user_id = (SELECT id FROM users WHERE email = ?)',
    args: [email],
  });
  return Number(result.rows[0].cnt);
}

async function representationForText(text) {
  const hash = canonicalSha256(text);
  const result = await setupClient.execute({ sql: 'SELECT id FROM corpus_document_representations WHERE canonical_sha256 = ?', args: [hash] });
  return result.rows[0] ? String(result.rows[0].id) : null;
}

// --- AUTHENTICATED DELETION SUCCEEDS ----------------------------------------

test('SUCCESS: an authenticated user can delete their own account with correct password and confirmation', async () => {
  const email = 'delete-success@example.test';
  const { cookie } = await signup(email, 'delete-device-success');
  assert.ok(await userExists(email), 'sanity: account exists before deletion');

  const del = await deleteAccount(cookie);
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.deepEqual(body, { ok: true }, 'response must be minimal — no counts, no per-item detail');

  assert.equal(await userExists(email), false, 'the users row must be gone');
});

// --- UNAUTHENTICATED DELETION IS REJECTED -----------------------------------

test('AUTH REQUIRED: an unauthenticated request is rejected, and touches no account', async () => {
  const email = 'delete-unauth@example.test';
  await signup(email, 'delete-device-unauth');

  const del = await deleteAccount(null);
  assert.equal(del.status, 401);
  const body = await del.json();
  assert.equal(body.error, 'Not signed in.');
  assert.ok(await userExists(email), 'the account must still exist — no session means no deletion');
});

// --- WRONG PASSWORD IS REJECTED ----------------------------------------------

test('WRONG PASSWORD: an incorrect password is rejected, and the account survives', async () => {
  const email = 'delete-wrongpw@example.test';
  const { cookie } = await signup(email, 'delete-device-wrongpw');

  const del = await deleteAccount(cookie, { password: 'totally-the-wrong-password' });
  assert.equal(del.status, 401);
  const body = await del.json();
  assert.equal(body.error, 'Incorrect password.');
  assert.ok(await userExists(email), 'the account must still exist after a failed password check');

  // The session itself must still be valid — a wrong password on THIS
  // sensitive action must not silently sign the user out of their account.
  const meRes = await me(cookie);
  const meBody = await meRes.json();
  assert.equal(meBody.user.email, email);
});

// --- MISSING/WRONG CONFIRMATION IS REJECTED ---------------------------------

test('CONFIRMATION REQUIRED: a missing or wrong confirmation phrase is rejected before any password check', async () => {
  const email = 'delete-noconfirm@example.test';
  const { cookie } = await signup(email, 'delete-device-noconfirm');

  const del = await deleteAccount(cookie, { confirm: 'delete my account' }); // wrong case/text
  assert.equal(del.status, 400);
  assert.ok(await userExists(email), 'the account must still exist');

  // A genuinely absent `confirm` field — not routed through deleteAccount()'s
  // own default parameter (which would silently substitute the correct
  // phrase for `undefined` before the request body is even built).
  await resetAuthRateForTest('acct-del-noconfirm-missing');
  const missingReq = new Request('http://localhost/api/auth/me', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'acct-del-noconfirm-missing', cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const delMissing = await meRoute.DELETE(missingReq);
  assert.equal(delMissing.status, 400);
  assert.ok(await userExists(email));
});

// --- ALL SESSIONS ARE INVALIDATED -------------------------------------------

test('SESSIONS: every active session for the account is invalidated, not just the one used to delete it', async () => {
  const email = 'delete-sessions@example.test';
  const { cookie: cookieA } = await signup(email, 'delete-device-sessions-a');
  // A second "device" logs in too, producing a SECOND, independent session row.
  const { cookie: cookieB } = await login(email, 'delete-device-sessions-b', 'acct-del-sessions-b-');
  assert.equal(await sessionCountForEmail(email), 2, 'sanity: two independent sessions exist');

  const del = await deleteAccount(cookieA);
  assert.equal(del.status, 200);

  // Both sessions must now be gone from the DB...
  const remaining = await setupClient.execute({ sql: 'SELECT COUNT(*) AS cnt FROM sessions' });
  // ...and specifically, the SECOND device's cookie must no longer authenticate.
  const meB = await me(cookieB, 'acct-del-sessions-check-b');
  const meBBody = await meB.json();
  assert.equal(meBBody.user, null, "the second device's session must be invalidated too, not just the one used to delete");
});

// --- USER'S REPORTS ARE REMOVED ---------------------------------------------

test("REPORTS: all of the user's own reports are removed", async () => {
  const email = 'delete-reports@example.test';
  const { cookie } = await signup(email, 'delete-device-reports');
  await postReport('delete-device-reports', { cookie, text: 'Ornithologists banding migratory shorebirds at a coastal stopover site recorded unusually high site fidelity across three consecutive return seasons.' });
  await postReport('delete-device-reports', { cookie, text: 'Seismologists analyzing induced microseismicity near a geothermal injection well correlated event clustering with weekly injection rate changes.', title: 'second.pdf' });
  assert.equal(await reportCountForEmail(email), 2, 'sanity: two reports exist');

  const del = await deleteAccount(cookie);
  assert.equal(del.status, 200);
  assert.equal(await reportCountForEmail(email), 0, 'every report owned by this account must be gone (query naturally returns 0 once the account itself is gone too)');
});

// --- DOCUMENT TEXT REMOVED WHEN NO REMAINING REFERENCE ----------------------

test("DOCUMENT TEXT: the user's own (non-shared) document text is removed from the corpus", async () => {
  const text = 'Paleobotanists examining silicified wood fragments from a fossil forest identified growth-ring anomalies consistent with a multi-year regional drought event.';
  const email = 'delete-text@example.test';
  const { cookie } = await signup(email, 'delete-device-text');
  await grantConsent(email);
  const { id: reportId } = await postReport('delete-device-text', { cookie, text });

  const identityRow = await setupClient.execute({ sql: 'SELECT document_identity_id FROM saved_reports WHERE device_key = ? AND id = ?', args: ['delete-device-text', reportId] });
  const identityId = String(identityRow.rows[0].document_identity_id);
  assert.ok(await representationForText(text), 'sanity: representation exists before deletion');

  const del = await deleteAccount(cookie);
  assert.equal(del.status, 200);

  assert.equal((await setupClient.execute({ sql: 'SELECT 1 FROM document_identities WHERE id = ?', args: [identityId] })).rows.length, 0, 'the identity row must be gone');
  assert.equal(await representationForText(text), null, 'the canonical_text representation must be gone — it had no other reference');
});

// --- SHARED REPRESENTATION SURVIVES ------------------------------------------

test('SHARED EVIDENCE: a document representation shared with another account survives account deletion', async () => {
  const text = 'Malacologists surveying intertidal gastropod assemblages after a marine heatwave documented a marked shift toward warmer-water-adapted species composition.';
  const emailA = 'delete-shared-a@example.test';
  const emailB = 'delete-shared-b@example.test';
  const { cookie: cookieA } = await signup(emailA, 'delete-device-shared-a');
  const { cookie: cookieB } = await signup(emailB, 'delete-device-shared-b');
  await grantConsent(emailA);
  await grantConsent(emailB);

  await postReport('delete-device-shared-a', { cookie: cookieA, text });
  const { id: reportBId } = await postReport('delete-device-shared-b', { cookie: cookieB, text, title: 'shared-b.pdf' });

  const representationId = await representationForText(text);
  assert.ok(representationId, 'sanity: one shared representation exists');
  assert.equal(
    (await setupClient.execute({ sql: 'SELECT COUNT(*) AS cnt FROM corpus_submission_references WHERE representation_id = ?', args: [representationId] })).rows[0].cnt,
    2,
    'sanity: two references (A and B) point at the shared representation',
  );

  // Delete A's account — the shared text must survive because B still references it.
  const del = await deleteAccount(cookieA);
  assert.equal(del.status, 200);

  assert.ok(await representationForText(text), "the shared representation must SURVIVE — account B's report still references it");
  assert.equal(
    (await setupClient.execute({ sql: 'SELECT COUNT(*) AS cnt FROM corpus_submission_references WHERE representation_id = ?', args: [representationId] })).rows[0].cnt,
    1,
    'exactly one reference (B\'s) must remain',
  );

  // B's own report/account must be completely unaffected.
  assert.ok(await userExists(emailB), "account B must still exist");
  const bGet = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${reportBId}`, { headers: { cookie: `tp_session_v1=${cookieB}` } }),
    { params: Promise.resolve({ id: reportBId }) },
  );
  assert.equal(bGet.status, 200, "B's report must still be fully readable after A's account deletion");
});

// --- ANOTHER USER'S REPORTS/EVIDENCE REMAIN INTACT (broader check) ---------

test("ISOLATION: deleting one account never touches a different account's reports, sessions, or family evidence", async () => {
  const emailA = 'delete-isolation-a@example.test';
  const emailB = 'delete-isolation-b@example.test';
  const { cookie: cookieA } = await signup(emailA, 'delete-device-isolation-a');
  const { cookie: cookieB } = await signup(emailB, 'delete-device-isolation-b');

  const original = 'Climatologists reconstructing tree-ring width chronologies from a subalpine site extended the regional precipitation record by four additional centuries.';
  const revised = original + ' A supplementary cross-dating pass corrected two ring-count discrepancies identified during quality review.';
  await postReport('delete-device-isolation-a', { cookie: cookieA, text: original });
  const { id: reportBId } = await postReport('delete-device-isolation-b', { cookie: cookieB, text: revised, title: 'isolation-b.pdf' });

  const del = await deleteAccount(cookieA);
  assert.equal(del.status, 200);

  assert.ok(await userExists(emailB), "B's account must be untouched");
  assert.equal(await reportCountForEmail(emailB), 1, "B's own report must be untouched");
  const meB = await me(cookieB, 'acct-del-isolation-meB');
  const meBBody = await meB.json();
  assert.equal(meBBody.user.email, emailB, "B's session must still be valid — only A's sessions were invalidated");
});

// --- SAFE TO RETRY ------------------------------------------------------------

test('RETRY-SAFE: calling the deletion library functions again after a successful deletion is a harmless no-op', async () => {
  const email = 'delete-retry@example.test';
  const { cookie } = await signup(email, 'delete-device-retry');
  await postReport('delete-device-retry', { cookie, text: 'Volcanic tephrochronologists correlating ash layers across three lake-sediment cores established a shared regional marker horizon for a previously undated eruption.' });

  const client = createClient({ url: `file:${dbFile}` });
  const userRow = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  const accountId = userRow.rows[0].id;

  const { deleteAccountData, invalidateSessionsAndDeleteUser } = await import('../lib/account-deletion.ts');
  await deleteAccountData(client, accountId);
  await invalidateSessionsAndDeleteUser(client, accountId);
  assert.equal(await userExists(email), false, 'sanity: first run deleted the account');

  // Re-running both functions directly (simulating a retried request after a
  // dropped connection) against an already-fully-deleted account must not throw.
  await assert.doesNotReject(() => deleteAccountData(client, accountId));
  await assert.doesNotReject(() => invalidateSessionsAndDeleteUser(client, accountId));
  client.close();

  // And via the real HTTP route: a retried request with the (now-invalid)
  // session cookie is correctly rejected as unauthenticated, not a crash.
  const retryDel = await deleteAccount(cookie);
  assert.equal(retryDel.status, 401);
});

// --- ACCOUNT CANNOT BE ACCESSED AFTER DELETION -------------------------------

test('POST-DELETION: the account cannot be accessed by any means after deletion — session, login, or re-signup collision', async () => {
  const email = 'delete-postcheck@example.test';
  const { cookie } = await signup(email, 'delete-device-postcheck');
  const del = await deleteAccount(cookie);
  assert.equal(del.status, 200);

  // The old session cookie no longer works.
  const meAfter = await me(cookie, 'acct-del-postcheck-me');
  const meAfterBody = await meAfter.json();
  assert.equal(meAfterBody.user, null);

  // Logging in with the old credentials fails — the account is genuinely gone.
  const loginAfter = await login(email, 'delete-device-postcheck', 'acct-del-postcheck-login-');
  assert.equal(loginAfter.res.status, 401);

  // The email is free to re-register — proves the users row is truly deleted,
  // not just orphaned/soft-deleted (a unique-email constraint would block this otherwise).
  const resignup = await signup(email, 'delete-device-postcheck-2');
  assert.equal(resignup.res.status, 201, 'the email must be available again after true deletion');
});
