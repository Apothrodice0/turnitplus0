import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import * as resetRoomsRoute from '../app/api/developer/reset-rooms/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';
import { canonicalSha256 } from '../lib/document-identity.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { buildReportAdmissionSourceRef } from '../lib/corpus-admission-source-ref.ts';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

/**
 * POST /api/developer/reset-rooms — "Clear my rooms". Real DB, real route
 * handlers, no mocking, matching this repo's test convention (setup mirrors
 * tests/account-deletion.test.mjs).
 *
 * Proves the 12 required properties: dry-run is account-scoped and writes
 * nothing; a real reset removes exactly the calling developer's own reports
 * and their dependent rows (per the existing single-report delete
 * lifecycle); a second developer, ordinary users, and anonymous callers are
 * untouched/rejected; accepted corpus content survives; the operation is
 * idempotent; and no client-supplied identifier can widen the scope.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_developer_reset_rooms.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const ADMIN_A_EMAIL = 'dev-a@roomreset.test';
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ADMIN_EMAIL = ADMIN_A_EMAIL;

const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, drizzleDir);

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const PASSWORD = 'developer-reset-rooms-pw-1';

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, deviceKey) {
  const ip = 'reset-signup-' + email;
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(withTestIdentity({ email, password: PASSWORD, username: email.split('@')[0].replace(/[^a-z0-9]/gi, ''), deviceKey })),
  });
  const res = await signupRoute.POST(req);
  assert.equal(res.status, 201, `signup for ${email} should succeed`);
  return extractCookie(res);
}

async function me(cookie) {
  const ip = 'reset-me';
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const res = await meRoute.GET(new Request('http://localhost/api/auth/me', { headers }));
  return res.json();
}

let roomCounter = 0;
async function postReport(deviceKey, cookie, room, text) {
  const ip = 'reset-post';
  await resetRateForTest(ip);
  const reportId = `reset-report-${roomCounter++}-${randomUUID()}`;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({
      deviceKey,
      id: reportId,
      submissionId: 'sub-' + reportId,
      title: reportId + '.pdf',
      createdAt: new Date().toISOString(),
      wordCount: 120,
      archiveScore: 4,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      room,
      payload: {
        version: 11, id: Date.now(), submissionId: 'sub-' + reportId, title: reportId + '.pdf',
        author: '', assignment: '', created: new Date().toISOString(), score: 4, archiveScore: 4,
        text, wordCount: 120, characterCount: 640, pageCount: 1, fileSize: '1 KB', databaseSize: 230,
        corpusVersion: 'test', scoreBand: 'Low',
      },
    }),
  });
  const res = await reportsRoute.POST(req);
  assert.equal(res.status, 200, `postReport ${reportId} should succeed (got ${res.status})`);
  return { reportId, deviceKey };
}

async function callReset(cookie, body, ipSuffix = 'default') {
  const ip = 'reset-call-' + ipSuffix;
  await resetRateForTest(ip);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/developer/reset-rooms', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return resetRoomsRoute.POST(req);
}

async function userIdFor(email) {
  const r = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return r.rows[0] ? String(r.rows[0].id) : null;
}

async function count(sql, args = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0].c);
}

async function savedReportCount(userId) {
  return count('SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?', [userId]);
}

async function distinctRooms(userId) {
  const r = await db.execute({
    sql: 'SELECT DISTINCT room_number FROM saved_reports WHERE user_id = ? AND room_number IS NOT NULL ORDER BY room_number',
    args: [userId],
  });
  return r.rows.map((row) => Number(row.room_number));
}

/** Seed the dependent rows the single-report delete lifecycle cleans up, for one report. */
async function seedDependentRows(email, deviceKey, reportId, text, { accepted }) {
  const accountId = await userIdFor(email);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });
  const hash = canonicalSha256(text);

  // report_historical_match_snapshots: written naturally by POST /api/reports'
  // own write-time finalization, so it already exists here — no need to seed.

  // Corpus-admission job row (always removed by the lifecycle).
  await db.execute({
    sql: `INSERT INTO corpus_admission_report_jobs (id, source_ref, account_id, device_key, report_id, status, attempt_count)
          VALUES (?, ?, ?, ?, ?, ?, 1)`,
    args: [randomUUID(), sourceRef, accountId, deviceKey, reportId, accepted ? 'succeeded' : 'succeeded'],
  });

  // Corpus-admission decision. accepted => keep decision + content + fingerprint; rejected => whole decision is removed.
  const decisionId = randomUUID();
  await db.execute({
    sql: `INSERT INTO corpus_admission_decisions
            (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, canonical_sha256, dry_run)
          VALUES (?, ?, 'policy-test-v1', ?, '[]', 1, '[]', ?, 0)`,
    args: [decisionId, sourceRef, accepted ? 'ACCEPT' : 'REJECT', hash],
  });
  if (accepted) {
    await db.execute({
      sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, retention_basis)
            VALUES (?, ?, ?, ?, 'per-user-consent')`,
      args: [randomUUID(), decisionId, hash, text],
    });
    await db.execute({
      sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version)
            VALUES (?, ?, ?, 120, 'fp-test-v1')`,
      args: [randomUUID(), decisionId, hash],
    });
  }
  return { sourceRef, decisionId, hash };
}

async function documentIdentityIdFor(deviceKey, reportId) {
  const r = await db.execute({
    sql: 'SELECT document_identity_id FROM saved_reports WHERE device_key = ? AND id = ?',
    args: [deviceKey, reportId],
  });
  return r.rows[0]?.document_identity_id ? String(r.rows[0].document_identity_id) : null;
}

// --- Fixtures -------------------------------------------------------------

// Developer A — promoted via ADMIN_EMAIL at signup.
const cookieA = await signup(ADMIN_A_EMAIL, 'device-reset-a');
await grantTestAdmin(dbFile, ADMIN_A_EMAIL);
const idA = await userIdFor(ADMIN_A_EMAIL);
assert.equal((await me(cookieA)).user.email, ADMIN_A_EMAIL, 'developer A session is valid');
assert.equal(
  (await db.execute({ sql: 'SELECT role FROM users WHERE id = ?', args: [idA] })).rows[0].role,
  'admin',
  'developer A must be admin via ADMIN_EMAIL',
);

// Developer B — a second admin (role set directly; ADMIN_EMAIL only promotes one address).
const cookieB = await signup('dev-b@roomreset.test', 'device-reset-b');
const idB = await userIdFor('dev-b@roomreset.test');
await db.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [idB] });

// Ordinary user C — stays role=user.
const cookieC = await signup('user-c@roomreset.test', 'device-reset-c');
const idC = await userIdFor('user-c@roomreset.test');

// Developer D — admin with zero reports.
const cookieD = await signup('dev-d@roomreset.test', 'device-reset-d');
const idD = await userIdFor('dev-d@roomreset.test');
await db.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [idD] });

const A_TEXTS = [
  'Ornithologists banding migratory shorebirds at a coastal stopover site recorded unusually high site fidelity across three consecutive return seasons of monitoring.',
  'Seismologists analyzing induced microseismicity near a geothermal injection well correlated event clustering with weekly injection-rate changes over an eighteen-month window.',
  'Paleobotanists examining silicified wood fragments from a fossil forest identified growth-ring anomalies consistent with a multi-year regional drought during deposition.',
];
const B_TEXTS = [
  'Malacologists surveying intertidal gastropod assemblages after a marine heatwave documented a marked shift toward warmer-water-adapted species composition at three sites.',
  'Volcanic tephrochronologists correlating ash layers across three lake-sediment cores established a shared regional marker horizon for a previously undated eruption event.',
];
const C_TEXT = 'Glaciologists tracking supraglacial lake drainage on a temperate ice tongue linked abrupt basal-water pulses to short-lived downstream velocity increases each summer.';

// A: reports in rooms 0,1,2. Room 0 -> accepted admission; room 1 -> rejected admission.
const aReports = [];
aReports.push(await postReport('device-reset-a', cookieA, 0, A_TEXTS[0]));
aReports.push(await postReport('device-reset-a', cookieA, 1, A_TEXTS[1]));
aReports.push(await postReport('device-reset-a', cookieA, 2, A_TEXTS[2]));

const aAccepted = await seedDependentRows(ADMIN_A_EMAIL, 'device-reset-a', aReports[0].reportId, A_TEXTS[0], { accepted: true });
const aRejected = await seedDependentRows(ADMIN_A_EMAIL, 'device-reset-a', aReports[1].reportId, A_TEXTS[1], { accepted: false });

// Sanity: POST /api/reports already persisted a historical-match snapshot for each of A's reports.
for (const { reportId } of aReports) {
  assert.equal(
    await count('SELECT COUNT(*) AS c FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', ['device-reset-a', reportId]),
    1,
    `sanity: snapshot exists for ${reportId} before reset`,
  );
}

// A's own (non-shared) corpus representation for report[2], seeded the real way.
const aIdentity2 = await documentIdentityIdFor('device-reset-a', aReports[2].reportId);
assert.ok(aIdentity2, 'sanity: report[2] captured a document_identity_id');
await indexDocumentSubmissionIntoCorpus(db, { documentIdentityId: aIdentity2, rawText: A_TEXTS[2] });
assert.equal(
  await count('SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?', [canonicalSha256(A_TEXTS[2])]),
  1,
  'sanity: A report[2] representation exists before reset',
);

// B: reports in rooms 0,1. Room 0 -> accepted admission + snapshot.
const bReports = [];
bReports.push(await postReport('device-reset-b', cookieB, 0, B_TEXTS[0]));
bReports.push(await postReport('device-reset-b', cookieB, 1, B_TEXTS[1]));
const bAccepted = await seedDependentRows('dev-b@roomreset.test', 'device-reset-b', bReports[0].reportId, B_TEXTS[0], { accepted: true });

// C: one report.
const cReport = await postReport('device-reset-c', cookieC, 0, C_TEXT);

// --- 1. Dry-run is account-scoped ---------------------------------------

test('1. developer A dry-run reports only A\'s own reports and rooms', async () => {
  const res = await callReset(cookieA, { dryRun: true }, 'a-dry-1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dryRun, true);
  assert.equal(body.reportsToDelete, 3, 'A owns exactly 3 reports (B\'s 2 must not be counted)');
  assert.deepEqual(body.roomsAffected.slice().sort((x, y) => x - y), [0, 1, 2]);
  assert.equal(body.acceptedCorpusContentAffected, false);
});

// --- 2. Dry-run performs zero writes -----------------------------------

test('2. dry-run performs zero writes', async () => {
  const snapshot = async () => ({
    reports: await count('SELECT COUNT(*) AS c FROM saved_reports'),
    identities: await count('SELECT COUNT(*) AS c FROM document_identities'),
    snapshots: await count('SELECT COUNT(*) AS c FROM report_historical_match_snapshots'),
    decisions: await count('SELECT COUNT(*) AS c FROM corpus_admission_decisions'),
    contentStore: await count('SELECT COUNT(*) AS c FROM corpus_admission_content_store'),
    jobs: await count('SELECT COUNT(*) AS c FROM corpus_admission_report_jobs'),
    representations: await count('SELECT COUNT(*) AS c FROM corpus_document_representations'),
    references: await count('SELECT COUNT(*) AS c FROM corpus_submission_references'),
  });
  const before = await snapshot();
  const res = await callReset(cookieA, { dryRun: true }, 'a-dry-2');
  assert.equal(res.status, 200);
  const after = await snapshot();
  assert.deepEqual(after, before, 'no table changed row count across a dry run');
});

// --- 5/6/12. Rejections happen before any deletion --------------------

test('5. an ordinary (non-admin) user is rejected with a plain 404, reports untouched', async () => {
  for (const dryRun of [true, false]) {
    const res = await callReset(cookieC, { dryRun }, 'c-' + dryRun);
    assert.equal(res.status, 404, 'non-admin must get 404, never 401/403/200');
    assert.equal((await res.text()).length, 0, 'no body for a non-admin');
  }
  assert.equal(await savedReportCount(idC), 1, 'C\'s report is untouched');
});

test('6. an anonymous caller is rejected with a plain 404, nothing deleted', async () => {
  const before = await count('SELECT COUNT(*) AS c FROM saved_reports');
  for (const dryRun of [true, false]) {
    const res = await callReset(null, { dryRun }, 'anon-' + dryRun);
    assert.equal(res.status, 404);
  }
  assert.equal(await count('SELECT COUNT(*) AS c FROM saved_reports'), before, 'no report deleted for an anonymous caller');
});

test('12. a non-admin cannot widen scope with a client-supplied account/user/device id', async () => {
  const res = await callReset(
    cookieC,
    { dryRun: false, userId: idA, accountId: idA, deviceKey: 'device-reset-a', targetEmail: ADMIN_A_EMAIL },
    'c-widen',
  );
  assert.equal(res.status, 404, 'still a plain non-admin 404 — the body identifiers are ignored');
  assert.equal(await savedReportCount(idA), 3, 'developer A\'s reports are completely untouched');
});

// --- 10. Zero-report reset succeeds -----------------------------------

test('10. reset with zero reports succeeds (dry-run and real)', async () => {
  const dry = await callReset(cookieD, { dryRun: true }, 'd-dry');
  assert.equal(dry.status, 200);
  const dryBody = await dry.json();
  assert.equal(dryBody.reportsToDelete, 0);
  assert.deepEqual(dryBody.roomsAffected, []);

  const real = await callReset(cookieD, { dryRun: false }, 'd-real');
  assert.equal(real.status, 200);
  const realBody = await real.json();
  assert.equal(realBody.dryRun, false);
  assert.equal(realBody.reportsDeleted, 0);
  assert.deepEqual(realBody.roomsCleared, []);
});

// --- 3/7/8/9/12. The real reset for developer A ----------------------

test('3. developer A reset deletes every saved report A owns', async () => {
  assert.equal(await savedReportCount(idA), 3, 'sanity: 3 before');
  // Malicious body: a client-supplied userId pointing at developer B must be ignored.
  const res = await callReset(cookieA, { dryRun: false, userId: idB, accountId: idB }, 'a-real');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dryRun, false);
  assert.equal(body.reportsDeleted, 3);
  assert.deepEqual(body.roomsCleared.slice().sort((x, y) => x - y), [0, 1, 2]);
  assert.equal(await savedReportCount(idA), 0, 'every saved_reports row A owned is gone');
});

test('7. developer A\'s room list is empty afterward', async () => {
  assert.deepEqual(await distinctRooms(idA), [], 'no room slot is still occupied by A');
});

test('8. report-owned dependent data is cleaned per the single-report delete lifecycle', async () => {
  // Historical-match snapshots for A's reports — gone.
  for (const { reportId } of aReports) {
    assert.equal(
      await count('SELECT COUNT(*) AS c FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', ['device-reset-a', reportId]),
      0,
      `snapshot for ${reportId} removed`,
    );
  }
  // Every corpus-admission job row for A's reports — gone (job tracking is moot once the report is gone).
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_report_jobs WHERE source_ref = ?', [aAccepted.sourceRef]), 0, 'accepted report\'s job row removed');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_report_jobs WHERE source_ref = ?', [aRejected.sourceRef]), 0, 'rejected report\'s job row removed');

  // The never-accepted decision — removed entirely.
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE source_ref = ?', [aRejected.sourceRef]), 0, 'a REJECT decision with no retained content is removed');

  // A's document identities and the non-shared representation — gone (last reference).
  assert.equal(await count('SELECT COUNT(*) AS c FROM document_identities WHERE account_id = ?', [idA]), 0, 'A\'s document_identities are gone');
  assert.equal(
    await count('SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?', [canonicalSha256(A_TEXTS[2])]),
    0,
    'A\'s own non-shared representation is removed once its last reference is gone',
  );
});

test('9. accepted / promoted corpus content is preserved for developer A', async () => {
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE id = ?', [aAccepted.decisionId]), 1, 'the ACCEPT decision survives');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_content_store WHERE decision_id = ?', [aAccepted.decisionId]), 1, 'its retained canonical_text survives');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_accepted_representations WHERE decision_id = ?', [aAccepted.decisionId]), 1, 'its accepted_representations fingerprint survives');
});

// --- 4. Developer B is completely untouched ---------------------------

test('4. developer B is completely untouched by A\'s reset', async () => {
  assert.equal(await savedReportCount(idB), 2, 'B still owns both reports');
  assert.deepEqual(await distinctRooms(idB), [0, 1], 'B\'s room occupancy is unchanged');
  assert.equal(
    await count('SELECT COUNT(*) AS c FROM report_historical_match_snapshots WHERE report_device_key = ?', ['device-reset-b']),
    2,
    'B\'s historical-match snapshots (one per report) are unchanged',
  );
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE id = ?', [bAccepted.decisionId]), 1, 'B\'s accepted decision is unchanged');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_report_jobs WHERE source_ref = ?', [bAccepted.sourceRef]), 1, 'B\'s admission job row is unchanged');
  assert.equal(await count('SELECT COUNT(*) AS c FROM document_identities WHERE account_id = ?', [idB]), 2, 'B\'s document identities are unchanged');
  assert.equal((await me(cookieB)).user.email, 'dev-b@roomreset.test', 'B\'s session is still valid');
  assert.equal(await userIdFor('dev-b@roomreset.test'), idB, 'B\'s user row is intact');
});

test('C\'s ordinary account and report are still intact after A\'s reset', async () => {
  assert.equal(await savedReportCount(idC), 1);
  assert.equal((await me(cookieC)).user.email, 'user-c@roomreset.test');
});

// --- 11. Repeated reset is idempotent --------------------------------

test('11. a repeated reset for developer A is a clean no-op', async () => {
  const res = await callReset(cookieA, { dryRun: false }, 'a-repeat');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reportsDeleted, 0, 'nothing left to delete');
  assert.deepEqual(body.roomsCleared, []);
  assert.equal(await savedReportCount(idB), 2, 'B is still untouched after A\'s repeated reset');
  assert.equal(await savedReportCount(idA), 0);
});

// --- Body validation -------------------------------------------------

test('malformed request bodies are rejected for an admin (400), after the auth gate', async () => {
  for (const body of [{}, { dryRun: 'true' }, { dryRun: 1 }, { dryRun: null }]) {
    const res = await callReset(cookieA, body, 'a-badbody');
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} -> 400`);
  }
  // A non-admin sending the same malformed body still gets 404, never 400 —
  // the route's existence is not revealed by validating its input.
  const res = await callReset(cookieC, { dryRun: 'nope' }, 'c-badbody');
  assert.equal(res.status, 404);
});
