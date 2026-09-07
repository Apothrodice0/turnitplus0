import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import * as resetAccountRoomsRoute from '../app/api/developer/reset-account-rooms/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';
import { canonicalSha256 } from '../lib/document-identity.ts';
import { buildReportAdmissionSourceRef } from '../lib/corpus-admission-source-ref.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { runCorpusAdmissionPromotionSweep } from '../lib/corpus-admission-promotion.ts';
import { matchAgainstUserSubmissionCorpus } from '../lib/user-submission-matching.ts';
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

/**
 * POST /api/developer/reset-account-rooms — "Clear account rooms". An admin
 * clears ONE other account's saved reports / room occupancy, selected by
 * exact email. Real DB + real route handlers, no mocking.
 *
 * Confirmation model: stateless. Dry run performs zero writes and needs no
 * token. The destructive call requires `confirmEmail` re-entered exactly;
 * server canonicalizes both the same way (trim + lowercase), requires
 * equality, then re-resolves the account server-side. Nothing from the dry
 * run has to survive to the destructive call (instance-independent).
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_developer_reset_account_rooms.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const ADMIN_EMAIL = 'admin@arr.test';
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ADMIN_EMAIL = ADMIN_EMAIL;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';

const db = createClient({ url: `file:${dbFile}` });
await db.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(db, drizzleDir);
const openConnection = () => createClient({ url: `file:${dbFile}` });

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const PASSWORD = 'reset-account-rooms-pw-1';

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  const match = setCookie && setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, deviceKey) {
  const ip = 'arr-signup-' + email;
  await resetAuthRateForTest(ip);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(withTestIdentity({ email, password: PASSWORD, username: email.split('@')[0].replace(/[^a-z0-9]/gi, ''), deviceKey })),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  return extractCookie(res);
}

async function me(cookie) {
  const ip = 'arr-me';
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  return (await meRoute.GET(new Request('http://localhost/api/auth/me', { headers }))).json();
}

let roomSeq = 0;
async function postReport(deviceKey, cookie, room, text) {
  const ip = 'arr-post';
  await resetRateForTest(ip);
  const reportId = `arr-report-${roomSeq++}-${randomUUID()}`;
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({
      deviceKey, id: reportId, submissionId: 'sub-' + reportId, title: reportId + '.pdf',
      createdAt: new Date().toISOString(), wordCount: 90, archiveScore: 3, scoreBand: 'Low',
      aiScore: null, aiTone: null, room,
      payload: {
        version: 11, id: Date.now(), submissionId: 'sub-' + reportId, title: reportId + '.pdf', author: '',
        assignment: '', created: new Date().toISOString(), score: 3, archiveScore: 3, text,
        wordCount: 90, characterCount: 700, pageCount: 1, fileSize: '1 KB', databaseSize: 230,
        corpusVersion: 'test', scoreBand: 'Low',
      },
    }),
  }));
  assert.equal(res.status, 200, `postReport ${reportId} (${res.status})`);
  return { reportId, deviceKey };
}

let callSeq = 0;
async function callEndpoint(cookie, body) {
  const ip = 'arr-call-' + (callSeq++);
  await resetRateForTest(ip);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const res = await resetAccountRoomsRoute.POST(new Request('http://localhost/api/developer/reset-account-rooms', {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function one(sql, args = []) {
  return (await db.execute({ sql, args })).rows[0];
}
async function count(sql, args = []) {
  return Number((await one(sql, args)).c);
}
async function userId(email) {
  const r = await one('SELECT id FROM users WHERE email = ?', [email]);
  return r ? String(r.id) : null;
}
async function reportCount(uid) {
  return count('SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?', [uid]);
}
async function distinctRooms(uid) {
  const r = await db.execute({ sql: 'SELECT DISTINCT room_number FROM saved_reports WHERE user_id = ? AND room_number IS NOT NULL ORDER BY room_number', args: [uid] });
  return r.rows.map((row) => Number(row.room_number));
}
async function identityIdFor(deviceKey, reportId) {
  const r = await one('SELECT document_identity_id FROM saved_reports WHERE device_key = ? AND id = ?', [deviceKey, reportId]);
  return r?.document_identity_id ? String(r.document_identity_id) : null;
}
async function fullDbSnapshot() {
  const tables = [
    'saved_reports', 'document_identities', 'report_historical_match_snapshots',
    'corpus_admission_decisions', 'corpus_admission_content_store', 'corpus_admission_report_jobs',
    'corpus_document_representations', 'corpus_document_shingles', 'corpus_submission_references',
    'corpus_admission_promotions', 'users', 'sessions',
  ];
  const out = {};
  for (const t of tables) out[t] = await count(`SELECT COUNT(*) AS c FROM ${t}`);
  return out;
}

async function acceptAndPromote(accountId, deviceKey, reportId, text) {
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });
  const hash = canonicalSha256(text);
  const decisionId = randomUUID();
  await db.execute({
    sql: `INSERT INTO corpus_admission_decisions (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, canonical_sha256, dry_run)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [decisionId, sourceRef, 'policy-test-v1', 'ACCEPT', '[]', 1, '[]', hash, 0],
  });
  await db.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, retention_basis) VALUES (?,?,?,?,'per-user-consent')`,
    args: [randomUUID(), decisionId, hash, text],
  });
  await db.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version) VALUES (?,?,?,?, 'fp-test-v1')`,
    args: [randomUUID(), decisionId, hash, 90],
  });
  await db.execute({
    sql: `INSERT INTO corpus_admission_report_jobs (id, source_ref, account_id, device_key, report_id, status, decision_id, attempt_count) VALUES (?,?,?,?,?, 'succeeded', ?, 1)`,
    args: [randomUUID(), sourceRef, accountId, deviceKey, reportId, decisionId],
  });
  const sweep = await runCorpusAdmissionPromotionSweep(db, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome?.outcome, 'indexed', `promotion must index for ${reportId}`);
  return { decisionId, hash, representationId: outcome.representationId };
}

// Unrelated topics — matchAgainstUserSubmissionCorpus does a global shingle search.
const PROMOTED_TEXT =
  'Limnologists monitoring a chain of alpine tarns over two decades recorded a consistent upward migration of the ' +
  'thermal stratification boundary each summer, tracking regional warming closely and shortening the window available ' +
  'for cold-water invertebrate species that depend on a deep oxygenated layer.';
const DISPOSABLE_TEXT =
  'Mycologists cataloguing wood-decay fungi in an old-growth beech stand described several fruiting bodies whose ' +
  'enzyme profiles suggested a previously unrecognised role in breaking down a specific class of heartwood ' +
  'compounds, accelerating nutrient return to the forest floor.';

// --- Fixtures --------------------------------------------------------

const cookieAdmin = await signup(ADMIN_EMAIL, 'device-arr-admin');
await grantTestAdmin(dbFile, ADMIN_EMAIL);
const idAdmin = await userId(ADMIN_EMAIL);
assert.equal((await one('SELECT role FROM users WHERE id = ?', [idAdmin])).role, 'admin');

await postReport('device-arr-admin', cookieAdmin, 0, 'Admin own report one about tidal marsh sediment accretion rates.');
await postReport('device-arr-admin', cookieAdmin, 1, 'Admin own report two about boreal peatland carbon flux seasonality.');

const cookieT = await signup('target@arr.test', 'device-arr-t');
const idT = await userId('target@arr.test');
const tReports = [];
tReports.push(await postReport('device-arr-t', cookieT, 0, PROMOTED_TEXT));
tReports.push(await postReport('device-arr-t', cookieT, 1, DISPOSABLE_TEXT));
for (let r = 2; r < 6; r++) {
  tReports.push(await postReport('device-arr-t', cookieT, r, `Target account report in room ${r}: distinct subject matter number ${r} to avoid shingle overlap between fixtures entirely.`));
}

const tPromoted = await acceptAndPromote(idT, 'device-arr-t', tReports[0].reportId, PROMOTED_TEXT);
const idTPromoted = await identityIdFor('device-arr-t', tReports[0].reportId);
const caseBIndexed = await indexDocumentSubmissionIntoCorpus(db, { documentIdentityId: idTPromoted, rawText: PROMOTED_TEXT });
assert.equal(caseBIndexed.representationId, tPromoted.representationId);
const idTDisposable = await identityIdFor('device-arr-t', tReports[1].reportId);
const disposableIndexed = await indexDocumentSubmissionIntoCorpus(db, { documentIdentityId: idTDisposable, rawText: DISPOSABLE_TEXT });
const disposableRepId = disposableIndexed.representationId;

const cookieX = await signup('third-party@arr.test', 'device-arr-x');
const idX = await userId('third-party@arr.test');
await postReport('device-arr-x', cookieX, 0, 'Third party report one about coral reef spawning synchrony under moonlight.');
await postReport('device-arr-x', cookieX, 1, 'Third party report two about desert lichen crust recovery after disturbance.');

const cookieU = await signup('ordinary@arr.test', 'device-arr-u');

const cookieZ = await signup('empty-admin@arr.test', 'device-arr-z');
const idZ = await userId('empty-admin@arr.test');
await db.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [idZ] });

const promotedShinglesBefore = await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [tPromoted.representationId]);

// --- 1: preview is exact-target-scoped and zero-write -------------

test('T1: admin previews the exact target account by email (report count + room list, no token)', async () => {
  const { status, body } = await callEndpoint(cookieAdmin, { email: 'target@arr.test', dryRun: true });
  assert.equal(status, 200);
  assert.equal(body.dryRun, true);
  assert.equal(body.found, true);
  assert.equal(body.accountEmail, 'target@arr.test');
  assert.equal(body.reportsToDelete, 6, 'only T\'s 6 reports counted (admin\'s 2 + X\'s 2 excluded)');
  assert.deepEqual(body.roomsAffected, [0, 1, 2, 3, 4, 5]);
  assert.equal(body.acceptedCorpusContentAffected, false);
  assert.equal(body.previewToken, undefined, 'no preview token in the response');
});

test('T1: preview performs zero writes', async () => {
  const before = await fullDbSnapshot();
  await callEndpoint(cookieAdmin, { email: 'target@arr.test', dryRun: true });
  assert.deepEqual(await fullDbSnapshot(), before);
});

// --- 3: mismatched confirmEmail -> 400, zero writes -------------

test('T3: a destructive call with a mismatched confirmEmail is rejected (400) with zero writes', async () => {
  const before = await fullDbSnapshot();
  const bodies = [
    { email: 'target@arr.test', dryRun: false, confirmEmail: 'third-party@arr.test' },
    { email: 'target@arr.test', dryRun: false, confirmEmail: 'targe@arr.test' },
    { email: 'target@arr.test', dryRun: false, confirmEmail: '' },
    { email: 'target@arr.test', dryRun: false }, // missing entirely
  ];
  for (const body of bodies) {
    const { status } = await callEndpoint(cookieAdmin, body);
    assert.equal(status, 400, `${JSON.stringify(body)} -> 400`);
  }
  assert.deepEqual(await fullDbSnapshot(), before, 'no table changed for any confirm mismatch');
  assert.equal(await reportCount(idT), 6, 'T untouched');
});

// --- 4: a token from a different email cannot delete; different target needs a fresh preview

test('T4: confirmEmail must equal the target email — a "confirm" for a different account never deletes it', async () => {
  // Simulates "I previewed T, then aimed at X": email says X, confirmEmail still says T -> mismatch.
  const beforeX = await reportCount(idX);
  const { status } = await callEndpoint(cookieAdmin, { email: 'third-party@arr.test', dryRun: false, confirmEmail: 'target@arr.test' });
  assert.equal(status, 400);
  assert.equal(await reportCount(idX), beforeX, 'X untouched');
  assert.equal(await reportCount(idT), 6, 'T untouched');
});

// --- 6: normalization is consistent between email and confirmEmail

test('T6: email and confirmEmail are canonicalized the SAME way (trim + lowercase)', async () => {
  const { status, body } = await callEndpoint(cookieAdmin, { email: '  TARGET@ARR.TEST  ', dryRun: true });
  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.equal(body.accountEmail, 'target@arr.test');
  assert.equal(body.reportsToDelete, 6);
});

// --- 12: nonexistent / malformed / partial / wildcard cannot target; ordinary/anon 404

test('T12a: a nonexistent email returns found:false and performs zero writes (dry run and destructive)', async () => {
  const before = await fullDbSnapshot();
  for (const dryRun of [true, false]) {
    const { status, body } = await callEndpoint(cookieAdmin, { email: 'nobody@arr.test', dryRun, confirmEmail: 'nobody@arr.test' });
    assert.equal(status, 200);
    assert.equal(body.found, false);
    assert.equal(body.accountEmail, 'nobody@arr.test');
  }
  assert.deepEqual(await fullDbSnapshot(), before);
});

test('T12b: a malformed email is rejected (400) with zero writes', async () => {
  const before = await fullDbSnapshot();
  for (const email of ['not-an-email', '', '   ', 'missing-domain@', '@no-local.test', 'no-tld@example']) {
    const { status } = await callEndpoint(cookieAdmin, { email, dryRun: true });
    assert.equal(status, 400, `"${email}" -> 400`);
  }
  assert.deepEqual(await fullDbSnapshot(), before);
});

test('T12c: partial and wildcard emails never target an account', async () => {
  const before = await fullDbSnapshot();
  const { body: partial } = await callEndpoint(cookieAdmin, { email: 'targe@arr.test', dryRun: true });
  assert.equal(partial.found, false, 'a prefix of a real email resolves to nothing — exact match only');
  for (const email of ['%@arr.test', '*@arr.test', 'target%@arr.test', '_arget@arr.test']) {
    const { status, body } = await callEndpoint(cookieAdmin, { email, dryRun: true });
    if (status === 200) assert.equal(body.found, false, `"${email}" must not resolve`);
    else assert.equal(status, 400, `"${email}" -> 400`);
  }
  assert.deepEqual(await fullDbSnapshot(), before, 'no account deleted for any wildcard/partial input');
});

test('T12d: ordinary (non-admin) and anonymous callers get a plain 404', async () => {
  const before = await fullDbSnapshot();
  for (const cookie of [cookieU, null]) {
    for (const dryRun of [true, false]) {
      const { status } = await callEndpoint(cookie, { email: 'target@arr.test', dryRun, confirmEmail: 'target@arr.test' });
      assert.equal(status, 404);
    }
  }
  assert.deepEqual(await fullDbSnapshot(), before);
});

// --- 2/5/7/8: destructive delete of T ---------------------------

test('T2,T5,T7,T8: correct confirmEmail deletes exactly T; client-supplied ids ignored; admin + X survive', async () => {
  const idAdminBefore = await reportCount(idAdmin);
  const idXBefore = await reportCount(idX);

  const preview = await callEndpoint(cookieAdmin, { email: 'target@arr.test', dryRun: true });
  assert.equal(preview.body.reportsToDelete, 6);

  const del = await callEndpoint(cookieAdmin, {
    email: 'target@arr.test',
    dryRun: false,
    confirmEmail: 'target@arr.test',
    // Malicious extra fields naming OTHER accounts — must be ignored.
    userId: idX, accountId: idAdmin, deviceKey: 'device-arr-x',
  });
  assert.equal(del.status, 200);
  assert.equal(del.body.dryRun, false);
  assert.equal(del.body.accountEmail, 'target@arr.test');
  assert.equal(del.body.reportsDeleted, 6);
  assert.deepEqual(del.body.roomsCleared, [0, 1, 2, 3, 4, 5]);

  assert.equal(await reportCount(idT), 0, 'every T report gone');
  assert.deepEqual(await distinctRooms(idT), [], 'T room occupancy cleared');
  assert.equal(await reportCount(idAdmin), idAdminBefore, 'admin\'s own reports untouched (accountId in body ignored)');
  assert.equal(await reportCount(idX), idXBefore, 'X untouched (userId/deviceKey in body ignored)');
});

test('T8: the target account itself is preserved — users row, session, consent; other users survive', async () => {
  assert.equal(await userId('target@arr.test'), idT, 'T users row intact');
  assert.equal((await me(cookieT)).user.email, 'target@arr.test', 'T session still valid');
  assert.equal(
    (await one('SELECT corpus_reuse_consented_at FROM users WHERE id = ?', [idT])).corpus_reuse_consented_at ?? null,
    null,
    'T consent state untouched',
  );
  assert.equal((await me(cookieX)).user.email, 'third-party@arr.test', 'X session still valid');
  assert.equal(await reportCount(idX), 2, 'X reports intact');
  assert.ok(await reportCount(idAdmin) >= 2, 'admin reports intact');
});

// --- 9/10: accepted + promoted corpus survives & still matches --

test('T9: T\'s accepted decision / content / fingerprint / promoted representation / shingles all survive', async () => {
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE id = ? AND decision = ?', [tPromoted.decisionId, 'ACCEPT']), 1);
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_content_store WHERE decision_id = ?', [tPromoted.decisionId]), 1);
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_accepted_representations WHERE decision_id = ?', [tPromoted.decisionId]), 1);
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_document_representations WHERE id = ?', [tPromoted.representationId]), 1, 'promoted representation survives (CASE-B guard)');
  assert.equal(
    await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [tPromoted.representationId]),
    promotedShinglesBefore,
    'promoted shingles unchanged',
  );
  assert.equal((await one('SELECT status FROM corpus_admission_promotions WHERE decision_id = ?', [tPromoted.decisionId])).status, 'indexed');
});

test('T10: a different-account document STILL MATCHES that accepted/promoted source after T\'s reset', async () => {
  await matureCorpusBackings(db); // Phase A: this test is about reset survival, not the 7-day activation clock
  const result = await matchAgainstUserSubmissionCorpus(db, { accountId: null, canonicalText: PROMOTED_TEXT });
  assert.equal(result.status, 'MATCHED');
  assert.equal(result.matches[0].relationshipType, 'TURNITPLUS_CORPUS_SOURCE');
});

test('T9: T\'s non-promoted disposable representation is removed by the reset (normal behavior)', async () => {
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_document_representations WHERE id = ?', [disposableRepId]), 0, 'disposable representation deleted');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [disposableRepId]), 0);
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_submission_references WHERE representation_id = ?', [disposableRepId]), 0);
  assert.equal(await count('SELECT COUNT(*) AS c FROM document_identities WHERE account_id = ?', [idT]), 0, 'T document identities cleaned');
  assert.equal(await count('SELECT COUNT(*) AS c FROM report_historical_match_snapshots WHERE report_device_key = ?', ['device-arr-t']), 0);
});

// --- 11: idempotent + zero-report target ----------------------

test('T11: repeated deletion of the same target is a clean no-op', async () => {
  const preview = await callEndpoint(cookieAdmin, { email: 'target@arr.test', dryRun: true });
  assert.equal(preview.body.reportsToDelete, 0);
  const del = await callEndpoint(cookieAdmin, { email: 'target@arr.test', dryRun: false, confirmEmail: 'target@arr.test' });
  assert.equal(del.status, 200);
  assert.equal(del.body.reportsDeleted, 0);
  assert.deepEqual(del.body.roomsCleared, []);
  assert.equal(await reportCount(idX), 2, 'X still untouched after a repeated T reset');
});

test('T11: a zero-report target succeeds safely', async () => {
  const preview = await callEndpoint(cookieAdmin, { email: 'empty-admin@arr.test', dryRun: true });
  assert.equal(preview.body.found, true);
  assert.equal(preview.body.reportsToDelete, 0);
  assert.deepEqual(preview.body.roomsAffected, []);

  const del = await callEndpoint(cookieAdmin, { email: 'empty-admin@arr.test', dryRun: false, confirmEmail: '  EMPTY-ADMIN@ARR.TEST  ' });
  assert.equal(del.status, 200, 'a differently-cased/spaced confirmEmail still canonicalizes equal');
  assert.equal(del.body.reportsDeleted, 0);
  assert.equal(await userId('empty-admin@arr.test'), idZ, 'Z account intact');
});

// --- multi-account conflict guard ---------------------

test('CONFLICT: if two users somehow share a normalized email, refuse with 409 (never guess)', async () => {
  const ghostId = randomUUID();
  await db.execute({ sql: 'PRAGMA foreign_keys = OFF' });
  await db.execute({ sql: 'DROP INDEX IF EXISTS ux_users_email' });
  await db.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [ghostId, 'third-party@arr.test', 'ghost', 'x'] });
  try {
    const { status, body } = await callEndpoint(cookieAdmin, { email: 'third-party@arr.test', dryRun: true });
    assert.equal(status, 409);
    assert.equal(body.conflict, true);
  } finally {
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [ghostId] });
    await db.execute({ sql: 'CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email)' });
    await db.execute({ sql: 'PRAGMA foreign_keys = ON' });
  }
});

// --- existing "Clear my rooms" is untouched -----------

test('REGRESSION: the separate "Clear my rooms" endpoint still works and is unaffected', async () => {
  const resetRooms = await import('../app/api/developer/reset-rooms/route.ts');
  await resetRateForTest('arr-clearmine');
  const res = await resetRooms.POST(new Request('http://localhost/api/developer/reset-rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'arr-clearmine', cookie: `tp_session_v1=${cookieAdmin}` },
    body: JSON.stringify({ dryRun: true }),
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dryRun, true);
  assert.equal(body.reportsToDelete, 2, 'admin previewing their OWN rooms via "Clear my rooms" still works');
});
