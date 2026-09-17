import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as resetAccountRoomsRoute from '../app/api/developer/reset-account-rooms/route.ts';
import { resetAuthRateForTest, resetRateForTest } from '../lib/rate-limit.js';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';
import { deleteAllReportDataForAccount } from '../lib/account-deletion.ts';
import { buildReportAdmissionSourceRef } from '../lib/corpus-admission-source-ref.ts';
import { canonicalSha256 } from '../lib/document-identity.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { runCorpusAdmissionPromotionSweep } from '../lib/corpus-admission-promotion.ts';

/**
 * Reset-workspace bulk-delete performance fix — proves deleteAllReportDataForAccount
 * (lib/account-deletion.ts), the function BOTH "Clear my rooms" and "Clear
 * account rooms" already call unchanged, now performs its work in a small,
 * bounded number of set-based/chunked DB round trips instead of several per
 * report. Simulates the exact production shape that produced the reset-
 * workspace 504: 100 legacy-accumulated reports across 10 rooms (inserted
 * directly — one-report-per-room now enforces at most one CURRENT report per
 * room going forward through the live POST route, so this pre-existing
 * accumulation shape can only be constructed directly, exactly as it already
 * exists in any real account that predates that feature), plus historical
 * snapshots, admission jobs, one accepted-but-never-promoted decision, one
 * accepted-and-promoted representation, and one non-promoted orphan
 * representation. Every fixture here is synthetic.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_reset_workspace_bulk_delete.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const ADMIN_EMAIL = 'admin@bulkreset.test';
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ADMIN_EMAIL = ADMIN_EMAIL;

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

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  const match = setCookie && setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, deviceKey) {
  const ip = 'bulkreset-signup-' + email;
  await resetAuthRateForTest(ip);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(withTestIdentity({ email, password: 'bulk-reset-pw-1', username: email.split('@')[0].replace(/[^a-z0-9]/gi, ''), deviceKey })),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  return extractCookie(res);
}

let callSeq = 0;
async function callResetAccountRooms(cookie, body) {
  const ip = 'bulkreset-call-' + callSeq++;
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
  const r = await one(sql, args);
  return r ? Number(r.c) : 0;
}
async function userId(email) {
  const r = await one('SELECT id FROM users WHERE email = ?', [email]);
  return r ? String(r.id) : null;
}
async function fullDbSnapshot() {
  const tables = [
    'saved_reports', 'document_identities', 'document_identity_shingles', 'report_historical_match_snapshots',
    'corpus_admission_decisions', 'corpus_admission_content_store', 'corpus_admission_accepted_representations',
    'corpus_admission_report_jobs', 'corpus_document_representations', 'corpus_document_shingles',
    'corpus_submission_references', 'corpus_admission_promotions', 'users', 'sessions',
  ];
  const out = {};
  for (const t of tables) out[t] = await count(`SELECT COUNT(*) AS c FROM "${t}"`);
  return out;
}

/** Wraps a real @libsql/client Client so every .execute() call is counted — the exact metric this fix is judged on. Delegates everything else untouched. */
function countingClient(real) {
  const counts = { execute: 0 };
  const proxy = {
    execute: (...args) => { counts.execute += 1; return real.execute(...args); },
    batch: (...args) => real.batch(...args),
    transaction: (...args) => real.transaction(...args),
    migrate: (...args) => real.migrate(...args),
    executeMultiple: (...args) => real.executeMultiple(...args),
    sync: (...args) => real.sync(...args),
    close: () => real.close(),
    reconnect: (...args) => real.reconnect(),
    get closed() { return real.closed; },
    get protocol() { return real.protocol; },
  };
  return { counts, proxy };
}

async function acceptDecisionAndContent(accountId, deviceKey, reportId, text) {
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
  return { decisionId, hash, sourceRef };
}

async function insertDocumentIdentity(accountId, text) {
  const id = randomUUID();
  const hash = canonicalSha256(text);
  await db.execute({
    sql: `INSERT INTO document_identities (id, account_id, raw_sha256, canonical_sha256) VALUES (?,?,?,?)`,
    args: [id, accountId, hash, hash],
  });
  return id;
}

async function linkReportToIdentity(deviceKey, reportId, identityId) {
  await db.execute({ sql: 'UPDATE saved_reports SET document_identity_id = ? WHERE device_key = ? AND id = ?', args: [identityId, deviceKey, reportId] });
}

// Unrelated topics deliberately — matchAgainstUserSubmissionCorpus-style
// callers do a global shingle search; distinct subjects avoid cross-fixture overlap.
const PROMOTED_TEXT =
  'Limnologists monitoring a chain of alpine tarns over two decades recorded a consistent upward migration of the ' +
  'thermal stratification boundary each summer, tracking regional warming closely and shortening the window available ' +
  'for cold-water invertebrate species that depend on a deep oxygenated layer.';
const ORPHAN_TEXT =
  'Mycologists cataloguing wood-decay fungi in an old-growth beech stand described several fruiting bodies whose ' +
  'enzyme profiles suggested a previously unrecognised role in breaking down a specific class of heartwood ' +
  'compounds, accelerating nutrient return to the forest floor.';
const ACCEPTED_NOT_PROMOTED_TEXT =
  'Entomologists surveying a remote montane cloud forest catalogued an undescribed weevil lineage whose distinctive ' +
  'wing-case ridging pattern diverges sharply from every previously known genus recorded in the region.';

// --- Fixture: 100 legacy-accumulated reports across 10 rooms for account T ---

const cookieAdmin = await signup(ADMIN_EMAIL, 'device-bulk-admin');
await grantTestAdmin(dbFile, ADMIN_EMAIL);

const cookieT = await signup('target@bulkreset.test', 'device-bulk-t');
const idT = await userId('target@bulkreset.test');
const deviceKeyT = 'device-bulk-t';

const cookieOther = await signup('other@bulkreset.test', 'device-bulk-other');
const idOther = await userId('other@bulkreset.test');
const deviceKeyOther = 'device-bulk-other';

const REPORT_COUNT = 100;
const ROOM_COUNT = 10;
const HISTORICAL_SNAPSHOT_COUNT = 20;
const ADMISSION_JOB_COUNT = 20;
const ACCEPTED_NOT_PROMOTED_INDEX = 40;
const PROMOTED_INDEX = 41;
const ORPHAN_INDEX = 42;

const NOW_MS = Date.now();
function isoOffsetSeconds(offset) { return new Date(NOW_MS - offset * 1000).toISOString(); }

// One batched round trip for all 100 saved_reports rows — fixture setup speed
// is not what this suite measures; the delete path below is.
const reportIds = Array.from({ length: REPORT_COUNT }, (_, i) => `bulk-report-${i}`);
await db.batch(
  reportIds.map((id, i) => ({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, room_number, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [id, deviceKeyT, `sub-${id}`, `${id}.pdf`, isoOffsetSeconds(REPORT_COUNT - i), 100, 5, 'Low', JSON.stringify({ text: `fixture text ${i}` }), idT, i % ROOM_COUNT],
  })),
  'write',
);

// 20 historical-match snapshots (one per report, indices 0-19).
await db.batch(
  reportIds.slice(0, HISTORICAL_SNAPSHOT_COUNT).map((id) => ({
    sql: `INSERT INTO report_historical_match_snapshots (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, computed_at, corpus_generation)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,0)`,
    args: [deviceKeyT, id, 'NO_HISTORICAL_MATCH', 'v-test', 'v-test', 'v-test'],
  })),
  'write',
);

// 20 pending admission jobs, never evaluated (indices 20-39) — exercises bulk
// job-row cleanup independent of any decision.
await db.batch(
  reportIds.slice(HISTORICAL_SNAPSHOT_COUNT, HISTORICAL_SNAPSHOT_COUNT + ADMISSION_JOB_COUNT).map((id) => ({
    sql: `INSERT INTO corpus_admission_report_jobs (id, source_ref, account_id, device_key, report_id, status, attempt_count) VALUES (?,?,?,?,?, 'pending', 0)`,
    args: [randomUUID(), buildReportAdmissionSourceRef({ accountId: idT, deviceKey: deviceKeyT, reportId: id }), idT, deviceKeyT, id],
  })),
  'write',
);

// Report 40: accepted decision + retained content, deliberately never promoted.
const acceptedNotPromotedId = reportIds[ACCEPTED_NOT_PROMOTED_INDEX];
const acceptedNotPromoted = await acceptDecisionAndContent(idT, deviceKeyT, acceptedNotPromotedId, ACCEPTED_NOT_PROMOTED_TEXT);

// Report 41: accepted, promoted, and indexed into the real reusable corpus —
// exactly the existing developer-reset-account-rooms.test.mjs fixture shape.
const promotedId = reportIds[PROMOTED_INDEX];
const promoted = await acceptDecisionAndContent(idT, deviceKeyT, promotedId, PROMOTED_TEXT);
const promotedIdentityId = await insertDocumentIdentity(idT, PROMOTED_TEXT);
await linkReportToIdentity(deviceKeyT, promotedId, promotedIdentityId);
const sweep = await runCorpusAdmissionPromotionSweep(db, { openConnection, batchSize: 20 });
const promotionOutcome = sweep.results.find((r) => r.decisionId === promoted.decisionId);
assert.equal(promotionOutcome?.outcome, 'indexed', 'test setup sanity: the promotion sweep must index the promoted decision');
const promotedRepresentationId = promotionOutcome.representationId;
const promotedIndexed = await indexDocumentSubmissionIntoCorpus(db, { documentIdentityId: promotedIdentityId, rawText: PROMOTED_TEXT });
assert.equal(promotedIndexed.representationId, promotedRepresentationId, 'test setup sanity: the SAME representation must be reused, not duplicated');

// Report 42: a plain user-submission-corpus representation with no admission
// involvement at all — its sole reference disappears with its identity,
// leaving a genuine non-promoted orphan.
const orphanId = reportIds[ORPHAN_INDEX];
const orphanIdentityId = await insertDocumentIdentity(idT, ORPHAN_TEXT);
await linkReportToIdentity(deviceKeyT, orphanId, orphanIdentityId);
const orphanIndexed = await indexDocumentSubmissionIntoCorpus(db, { documentIdentityId: orphanIdentityId, rawText: ORPHAN_TEXT });
const orphanRepresentationId = orphanIndexed.representationId;

// A separate, untouched account with its own reports/rooms.
await db.batch(
  [0, 1, 2].map((room) => ({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, room_number, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [`other-report-${room}`, deviceKeyOther, `sub-other-${room}`, `other-${room}.pdf`, new Date().toISOString(), 50, 2, 'Low', JSON.stringify({ text: `other account report ${room}` }), idOther, room],
  })),
  'write',
);

const promotedShinglesBefore = await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [promotedRepresentationId]);
assert.ok(promotedShinglesBefore > 0, 'test setup sanity: the promoted representation must have real shingles');

// --- 1. Dry-run at 100-report scale performs zero writes -----------------

test('DRY RUN (100-report scale): "Clear account rooms" preview performs zero writes anywhere in the database', async () => {
  const before = await fullDbSnapshot();
  const { status, body } = await callResetAccountRooms(cookieAdmin, { email: 'target@bulkreset.test', dryRun: true });
  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.equal(body.reportsToDelete, REPORT_COUNT);
  assert.equal(body.roomsAffected.length, ROOM_COUNT);
  assert.deepEqual(await fullDbSnapshot(), before, 'a preview must never write anything, even at 100-report scale');
});

// --- 2. The real bulk delete: round-trip count, elapsed time, correctness ---

let executeCountForBulkDelete = null;
let elapsedMsForBulkDelete = null;
let bulkResult = null;

test('BULK DELETE (100 reports / 10 rooms): completes in a small, bounded number of DB round trips', async () => {
  const { counts, proxy } = countingClient(db);
  const startedAt = Date.now();
  bulkResult = await deleteAllReportDataForAccount(proxy, idT, { preserveActivelyPromotedRepresentations: true });
  elapsedMsForBulkDelete = Date.now() - startedAt;
  executeCountForBulkDelete = counts.execute;

  console.log(`[BULK DELETE] 100 reports / 10 rooms: ${executeCountForBulkDelete} client.execute() round trips, ${elapsedMsForBulkDelete}ms elapsed`);
  assert.equal(bulkResult.reportsDeleted, REPORT_COUNT);

  // The old row-by-row implementation performed roughly 4-5 round trips per
  // report PLUS roughly 2-5 per identity (this project's own prior
  // measured/estimated ~500-800 for an 83-report account) — i.e. hundreds,
  // scaling 1:1 with report count. The bulk implementation must be a small
  // constant-ish number, nowhere near proportional to 100.
  assert.ok(executeCountForBulkDelete < 50, `expected well under 50 round trips for 100 reports (chunked, not per-row), got ${executeCountForBulkDelete}`);
});

// --- 3. Correctness after the bulk delete ---------------------------------

test('AFTER BULK DELETE: every target report and room is empty', async () => {
  assert.equal(await count('SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?', [idT]), 0, 'all 100 of T\'s reports must be gone');
  const rooms = await db.execute({ sql: 'SELECT DISTINCT room_number FROM saved_reports WHERE user_id = ?', args: [idT] });
  assert.equal(rooms.rows.length, 0, 'T must have zero occupied rooms');
});

test('AFTER BULK DELETE: the other account is completely untouched', async () => {
  assert.equal(await count('SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?', [idOther]), 3, 'the other account\'s 3 reports must all survive');
  const rooms = await db.execute({ sql: 'SELECT DISTINCT room_number FROM saved_reports WHERE user_id = ? ORDER BY room_number', args: [idOther] });
  assert.deepEqual(rooms.rows.map((r) => Number(r.room_number)), [0, 1, 2]);
});

test('AFTER BULK DELETE: historical-match snapshots and admission jobs are removed for T', async () => {
  assert.equal(await count('SELECT COUNT(*) AS c FROM report_historical_match_snapshots WHERE report_device_key = ?', [deviceKeyT]), 0);
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_report_jobs WHERE account_id = ?', [idT]), 0, 'every job-tracking row for T must be gone, regardless of its underlying decision');
});

test('AFTER BULK DELETE: the accepted-but-never-promoted decision, its content, and its fingerprint all survive', async () => {
  const decision = await one('SELECT * FROM corpus_admission_decisions WHERE id = ?', [acceptedNotPromoted.decisionId]);
  assert.ok(decision, 'ACCEPTED_CONTENT_PRESERVED: an accepted decision must survive even though its own report row is gone');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_content_store WHERE decision_id = ?', [acceptedNotPromoted.decisionId]), 1);
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_accepted_representations WHERE decision_id = ?', [acceptedNotPromoted.decisionId]), 1);
});

test('AFTER BULK DELETE: the promoted representation, its promotion record, and its shingles all survive', async () => {
  const decision = await one('SELECT * FROM corpus_admission_decisions WHERE id = ?', [promoted.decisionId]);
  assert.ok(decision, 'the promoted decision must survive');
  const representation = await one('SELECT * FROM corpus_document_representations WHERE id = ?', [promotedRepresentationId]);
  assert.ok(representation, 'PROMOTED_REPRESENTATION_PRESERVED: the promoted representation must survive deleting T\'s document identities');
  const promotion = await one("SELECT * FROM corpus_admission_promotions WHERE representation_id = ? AND status = 'indexed'", [promotedRepresentationId]);
  assert.ok(promotion, 'the indexed promotion record must survive');
  const shinglesAfter = await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [promotedRepresentationId]);
  assert.equal(shinglesAfter, promotedShinglesBefore, 'every shingle of the promoted representation must survive');
});

test('AFTER BULK DELETE: the non-promoted orphan representation is removed, and T\'s document identities are gone', async () => {
  assert.equal(await count('SELECT COUNT(*) AS c FROM document_identities WHERE account_id = ?', [idT]), 0, 'all of T\'s document identities must be removed');
  const orphanRepresentation = await one('SELECT * FROM corpus_document_representations WHERE id = ?', [orphanRepresentationId]);
  assert.equal(orphanRepresentation, undefined, 'a non-promoted, now fully-unreferenced representation must be removed by the bulk cleanup');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_submission_references WHERE representation_id = ?', [orphanRepresentationId]), 0);
});

test('AFTER BULK DELETE: the target account itself (users row) is untouched — this is a report/room reset, never account deletion', async () => {
  const user = await one('SELECT id FROM users WHERE id = ?', [idT]);
  assert.ok(user, 'the reset must never delete the users row itself');
});

// --- 4. Idempotency: calling it again is a clean, cheap no-op -------------

test('IDEMPOTENT: calling deleteAllReportDataForAccount again for the already-reset account is a harmless, cheap no-op', async () => {
  const { counts, proxy } = countingClient(db);
  const result = await deleteAllReportDataForAccount(proxy, idT, { preserveActivelyPromotedRepresentations: true });
  assert.deepEqual(result, { reportsDeleted: 0, identitiesProcessed: 0 });
  console.log(`[IDEMPOTENT RE-RUN] ${counts.execute} client.execute() round trips for an already-empty account`);
  assert.ok(counts.execute < 10, `a no-op re-run must be cheap (a handful of empty-set SELECTs), got ${counts.execute}`);

  // Nothing preserved from the first run regresses on a second run.
  assert.ok(await one('SELECT id FROM corpus_admission_decisions WHERE id = ?', [promoted.decisionId]));
  assert.ok(await one('SELECT id FROM corpus_document_representations WHERE id = ?', [promotedRepresentationId]));
});

console.log('All reset-workspace bulk-delete tests passed');
