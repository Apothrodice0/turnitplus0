import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as uploadLimitRoute from '../app/api/upload-limit/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';
import { completeAiAnalysis } from './helpers/complete-ai-analysis.mjs';
import { setReportCreatedAt } from './helpers/report-clock.mjs';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import { withEvidenceInterpretation } from '../lib/report-evidence-interpretation.ts';
import { encodeReportForPersistence } from '../lib/report-persistence.ts';
import { ROOM_CYCLE_MS } from '../lib/report-rooms.ts';
import { DAILY_UPLOAD_LIMIT, countUploadsToday } from '../lib/upload-limit.ts';
import { deleteAllReportDataForAccount, invalidateSessionsAndDeleteUser } from '../lib/account-deletion.ts';
import {
  finalizeSelectiveCorpusAuthoritativeReport,
  claimStaleSelectiveCorpusAuthoritativePendingReports,
} from '../lib/selective-corpus-authoritative.ts';

/**
 * THE DAILY UPLOAD QUOTA COUNTS UPLOADS, NOT THE REPORTS THAT HAPPEN TO BE LEFT.
 *
 * The quota used to be the number of saved_reports rows an account saved today. A deleted row was no longer counted,
 * so deleting a report gave its upload back: upload, delete, upload again — twelve of twelve accepted, zero counted.
 *
 * What is counted now (lib/upload-limit.ts): every new upload the server accepted today — the rows that still exist,
 * plus one upload_usage_tombstones row (drizzle/0054) for each of today's reports that does not, written by a database
 * trigger as the report's row is deleted, whichever code path deletes it.
 *
 * This file pins, through the real routes:
 *   - a new upload counts once (1); deleting it gives nothing back (2), so upload → delete reaches the limit (3);
 *   - neither does a room replacing its expired occupant, nor a rooms reset (4);
 *   - no save of a report that already exists consumes anything: the AI save, a re-analysis, a retry of a save the
 *     server already stored (5), the Selective Corpus finalizer and recovery sweep (6) — and they all still work when
 *     the account is at its limit (7);
 *   - the window is the UTC day it always was (8);
 *   - two uploads racing for the last slot are not both stored (9);
 *   - what the table keeps and stops keeping (10), and that an admin is still unlimited (11).
 *
 * To put an account near its limit without ten uploads, a test seeds the usage of uploads that were "made and deleted
 * earlier today" straight into upload_usage_tombstones (usedEarlierToday) — the exact rows the trigger writes.
 * Every corpus is synthetic.
 */

const ENV_KEYS = [
  'TURSO_DATABASE_URL',
  'CORPUS_SOURCE_MATCHING_ENABLED',
  'REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED',
  'IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH',
  'SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED',
  'SELECTIVE_CORPUS_SHADOW_ENABLED',
  'SELECTIVE_CORPUS_ARTIFACT_PATH',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const workDir = mkdtempSync(path.join(process.env.TURNITPLUS_TEST_DB_DIR || tmpdir(), 'upload-quota-'));
const dbFile = path.join(workDir, 'upload_quota.db');
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
process.env.REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED = 'true';
delete process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH;
delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
delete process.env.SELECTIVE_CORPUS_ARTIFACT_PATH;

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, path.resolve('drizzle'));

test.after(() => {
  client.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ===========================================================================
// fixtures
// ===========================================================================

const SYLLABLES = ['ka', 'lo', 'mi', 'tre', 'vun', 'sor', 'bel', 'dra', 'phi', 'quen', 'zor', 'tal', 'mer', 'nix', 'ost', 'ula', 'rin', 'vek', 'dom', 'sha', 'gri', 'pol', 'wex', 'yun'];
function words(count, seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length]);
  return out.join(' ');
}
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

let accounts = 0;
async function signUpOwner() {
  accounts += 1;
  const tag = `uq-${accounts}`, email = `uq-owner-${accounts}@example.test`, deviceKey = `uq-device-${accounts}`;
  await resetAuthRateForTest(`${tag}-signup`);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${tag}-signup` },
    body: JSON.stringify(withTestIdentity({ email, password: 'uq-owner-pw-1', username: `uqowner${accounts}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = (res.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)[1];
  const userId = String((await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  return { userId, deviceKey, cookie, tag, email };
}

let reports = 0;
function localReport(prefix, { wordsCount = 600 } = {}) {
  reports += 1;
  const text = words(wordsCount, 7300 + reports);
  return {
    version: 11, id: `${prefix}-${reports}`, submissionId: `sub-${prefix}-${reports}`, title: `${prefix}-${reports}.docx`, author: '', assignment: '', created: iso(-60_000),
    score: 0, archiveScore: 0, scoreBand: 'Low', wordCount: tokensForScoringNormalization(text, 2).length, characterCount: text.length,
    matchedWordCount: 0, archiveMatchedPositions: [], scoringNormalizationVersion: 2,
    sources: [], repeats: [], text, academicEvidenceStatus: 'COMPLETE_NO_MATCHES', externalAcademicEvidence: [],
  };
}

let requests = 0;
/** POST /api/reports: `ai: false` is a check's first save (a new upload when the report does not exist yet); the default is the browser's AI save. */
async function save(owner, report, { ai = true, room } = {}) {
  requests += 1;
  const ip = `${owner.tag}-post-${requests}`;
  await resetRateForTest(ip);
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` },
    body: JSON.stringify({
      deviceKey: owner.deviceKey, id: report.id, submissionId: report.submissionId, title: report.title, createdAt: report.created,
      wordCount: report.wordCount, archiveScore: report.archiveScore, scoreBand: report.scoreBand,
      aiScore: ai ? 5 : null, aiTone: ai ? 'low' : null, aiStatus: ai ? 'ready' : 'processing', scoringNormalization: 2, academicSearchDiagnosticsId: null,
      ...(room === undefined ? {} : { room }),
      payload: { ...report, ...(ai ? { aiScore: 5, aiAnalysis: completeAiAnalysis() } : {}) },
    }),
  }));
}
/** A new upload into `room`: the first save of a report that does not exist yet. */
const upload = (owner, report, room = 0) => save(owner, report, { ai: false, room });
async function uploaded(owner, prefix, room = 0) {
  const report = localReport(prefix);
  assert.equal((await upload(owner, report, room)).status, 200, `test setup sanity: the upload into room ${room} must be accepted`);
  return report;
}
/** DELETE /api/reports/[id], as the owner. */
async function remove(owner, id) {
  requests += 1;
  const ip = `${owner.tag}-del-${requests}`;
  await resetRateForTest(ip);
  const res = await reportIdRoute.DELETE(
    new Request(`http://localhost/api/reports/${id}`, { method: 'DELETE', headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  assert.equal(res.status, 200, 'test setup sanity: the owner can delete the report');
}

const scalar = async (sql, args) => Number((await client.execute({ sql, args })).rows[0].n);
const rows = (owner) => scalar('SELECT COUNT(*) AS n FROM saved_reports WHERE user_id = ?', [owner.userId]);
const tombstones = (owner) => scalar('SELECT COUNT(*) AS n FROM upload_usage_tombstones WHERE user_id = ?', [owner.userId]);
const exists = async (owner, id) => (await scalar('SELECT COUNT(*) AS n FROM saved_reports WHERE device_key = ? AND id = ?', [owner.deviceKey, id])) === 1;
/** Uploads used today: what enforcement counts, checked against what the account is shown (GET /api/upload-limit). */
async function used(owner) {
  const counted = await countUploadsToday(client, owner.userId);
  requests += 1;
  const ip = `${owner.tag}-limit-${requests}`;
  await resetReadRateForTest(ip);
  const res = await uploadLimitRoute.GET(new Request('http://localhost/api/upload-limit', { headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` } }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { authenticated: true, unlimited: false, uploadsToday: counted, limit: DAILY_UPLOAD_LIMIT }, 'the account is shown the count enforcement uses');
  return counted;
}
/** `count` uploads this account made and deleted earlier today: the rows the delete trigger writes. */
async function usedEarlierToday(owner, count) {
  for (let i = 0; i < count; i += 1) {
    await client.execute({ sql: 'INSERT INTO upload_usage_tombstones (user_id, used_at) VALUES (?, CURRENT_TIMESTAMP)', args: [owner.userId] });
  }
}
function nextUtcMidnightIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}
async function assertRefused(res, label) {
  assert.equal(res.status, 429, `${label}: a new upload over the daily limit is refused`);
  const retryAfter = Number(res.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 86_400, `${label}: Retry-After is the time to the reset (${retryAfter})`);
  const body = await res.json();
  assert.deepEqual({ limit: body.limit, uploadsToday: body.uploadsToday, resetsAt: body.resetsAt }, { limit: DAILY_UPLOAD_LIMIT, uploadsToday: DAILY_UPLOAD_LIMIT, resetsAt: nextUtcMidnightIso() }, label);
}

// ---- authoritative fixtures ----
const EVALUATOR_VERSION = 'selective-corpus-shadow-v1';
const completedShadow = () => ({
  state: 'COMPLETED', evaluatorVersion: EVALUATOR_VERSION, corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
  verifiedEvidence: [{ sourceLabel: 'S1', matchedPassages: [{ submittedWordStart: 100, submittedWordEnd: 159, matchedWordCount: 60 }] }],
});
/** A report row written straight into the database, as every report saved before drizzle/0054 is: no usage record of its own. */
async function seedReport(owner, report, { room = 0, createdAt = report.created, pending = false } = {}) {
  const built = withEvidenceInterpretation({ ...report, created: createdAt }, { selectiveCorpusBranch: null });
  const payload = { ...encodeReportForPersistence(built), ...(pending ? { selectiveCorpusAuthoritativeStatus: 'pending' } : {}) };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_status, payload_json, user_id, room_number)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [report.id, owner.deviceKey, report.submissionId, report.title, createdAt, report.wordCount, report.archiveScore, report.scoreBand, 'processing', JSON.stringify(payload), owner.userId, room],
  });
}

// ===========================================================================
// 1-3. an upload counts once, and deleting it gives nothing back
// ===========================================================================

test('1. every new upload the server accepts counts once', async () => {
  const owner = await signUpOwner();
  assert.equal(await used(owner), 0);
  for (let room = 0; room < 3; room += 1) {
    await uploaded(owner, 'uq-count', room);
    assert.equal(await used(owner), room + 1);
  }
  assert.equal(await rows(owner), 3);
  assert.equal(await tombstones(owner), 0, 'nothing is recorded twice while the reports exist');
});

test('2. deleting a report gives its upload back to nobody: the count is the same before and after', async () => {
  const owner = await signUpOwner();
  const made = [];
  for (let room = 0; room < 3; room += 1) made.push(await uploaded(owner, 'uq-delete', room));
  assert.equal(await used(owner), 3);

  await remove(owner, made[0].id);
  assert.equal(await rows(owner), 2);
  assert.equal(await used(owner), 3, 'one report deleted: still three uploads used');

  await remove(owner, made[1].id);
  await remove(owner, made[2].id);
  assert.equal(await rows(owner), 0);
  assert.equal(await used(owner), 3, 'all deleted: still three uploads used');
  assert.equal(await tombstones(owner), 3);
});

test('3. upload -> delete, repeated, reaches the daily limit, and the next upload is refused', async () => {
  const owner = await signUpOwner();
  for (let i = 1; i <= DAILY_UPLOAD_LIMIT; i += 1) {
    const report = localReport('uq-cycle');
    assert.equal((await upload(owner, report, 0)).status, 200, `upload ${i}/${DAILY_UPLOAD_LIMIT} into the emptied room is accepted`);
    await remove(owner, report.id);
    assert.equal(await used(owner), i, `${i} uploads used, though no report is left`);
  }
  assert.equal(await rows(owner), 0);

  const refused = localReport('uq-cycle-refused');
  await assertRefused(await upload(owner, refused, 0), 'the upload after the limit');
  assert.equal(await exists(owner, refused.id), false, 'and nothing of it is stored');
  await assertRefused(await upload(owner, localReport('uq-cycle-refused'), 1), 'another room does not help');
  assert.equal(await used(owner), DAILY_UPLOAD_LIMIT, 'a refused upload uses nothing');
});

// ===========================================================================
// 4. every other way a report's row disappears
// ===========================================================================

test('4. a room replacing its expired occupant, and a rooms reset, give nothing back either', async () => {
  const owner = await signUpOwner();
  const first = await uploaded(owner, 'uq-replace', 0);
  assert.equal(await used(owner), 1);

  // The occupant's 24-hour cycle is over (its creation time, set back — tests/helpers/report-clock.mjs); it was uploaded today.
  await setReportCreatedAt(client, { deviceKey: owner.deviceKey, id: first.id }, iso(-ROOM_CYCLE_MS - 60_000));
  const second = await uploaded(owner, 'uq-replace', 0);
  assert.equal(await exists(owner, first.id), false, 'test setup sanity: the new upload replaced the expired occupant');
  assert.equal(await exists(owner, second.id), true);
  assert.equal(await used(owner), 2, 'two uploads were accepted: the replacement did not erase the first');

  // The developer rooms reset and account deletion share this cleanup (lib/account-deletion.ts).
  await uploaded(owner, 'uq-replace', 1);
  assert.equal(await used(owner), 3);
  await deleteAllReportDataForAccount(client, owner.userId);
  assert.equal(await rows(owner), 0, 'test setup sanity: the reset removed every report');
  assert.equal(await used(owner), 3, 'and the three uploads are still used');
});

// ===========================================================================
// 5-7. what never consumes an upload
// ===========================================================================

test('5. no save of a report that already exists consumes an upload: the AI save, a re-analysis, a rename, a repeated first save', async () => {
  const owner = await signUpOwner();
  const report = await uploaded(owner, 'uq-resave', 0);
  assert.equal(await used(owner), 1);

  assert.equal((await save(owner, report)).status, 200, 'the AI save');
  assert.equal(await used(owner), 1);

  const reanalysed = { ...report, title: 'renamed.docx', archiveMatchedPositions: range(0, 59), matchedWordCount: 60, score: 10, archiveScore: 10 };
  assert.equal((await save(owner, reanalysed)).status, 200, 'a re-analysis under another title');
  assert.equal(await used(owner), 1);

  // The browser never saw the answer to its first save and sends it again: the server already stored that upload.
  assert.equal((await upload(owner, report, 0)).status, 200, 'the same first save again');
  assert.equal((await upload(owner, report, 0)).status, 200);
  assert.equal(await used(owner), 1);
  assert.equal(await rows(owner), 1);
  assert.equal(await tombstones(owner), 0);
});

test('6. the Selective Corpus finalizer and the recovery sweep consume nothing', async () => {
  // A real first save in authoritative mode: its deferred finalizer runs (no artifact is configured, so it ends the report "incomplete").
  const owner = await signUpOwner();
  const report = localReport('uq-final', { wordsCount: 3000 });
  process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED = 'true';
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = 'true';
  try {
    assert.equal((await upload(owner, report, 0)).status, 200);
  } finally {
    delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
    delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  }
  const status = await client.execute({ sql: `SELECT json_extract(payload_json, '$.selectiveCorpusAuthoritativeStatus') AS s FROM saved_reports WHERE device_key = ? AND id = ?`, args: [owner.deviceKey, report.id] });
  assert.equal(status.rows[0].s, 'incomplete', 'test setup sanity: the finalizer ran and made the report terminal');
  assert.equal(await used(owner), 1, 'one upload, finalized: one used');
  assert.equal((await save(owner, report)).status, 200, 'the AI save of the finalized report');
  assert.equal(await used(owner), 1);

  // A pending report whose finalizer never ran: the sweep claims it, the finalizer completes it.
  const pending = localReport('uq-sweep', { wordsCount: 3000 });
  await seedReport(owner, pending, { room: 1, createdAt: iso(-20 * 60 * 1000), pending: true });
  assert.equal(await used(owner), 2, 'test setup sanity: a report row saved today is one upload');
  const claimed = await claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: () => createClient({ url: `file:${dbFile}` }), minAgeMs: 60_000, staleClaimMs: 60_000 });
  assert.ok(claimed.some((c) => String(c.reportId) === pending.id), 'test setup sanity: the sweep claimed the pending report');
  assert.equal(await used(owner), 2, 'the sweep used nothing');
  const finalized = await finalizeSelectiveCorpusAuthoritativeReport(client, { reportDeviceKey: owner.deviceKey, reportId: pending.id, accountId: owner.userId, shadowResult: completedShadow(), shadowScoringNormalizationVersion: 2 });
  assert.equal(finalized.outcome, 'finalized');
  assert.equal(await used(owner), 2, 'nor did the finalizer');
  assert.equal(await tombstones(owner), 0);
});

test('7. at the limit, only a NEW upload is refused: every save of a report that exists still works', async () => {
  const owner = await signUpOwner();
  await usedEarlierToday(owner, DAILY_UPLOAD_LIMIT - 1);
  assert.equal(await used(owner), DAILY_UPLOAD_LIMIT - 1);

  const last = await uploaded(owner, 'uq-last', 0);
  assert.equal(await used(owner), DAILY_UPLOAD_LIMIT, 'the last slot is taken');

  assert.equal((await upload(owner, last, 0)).status, 200, 'the same first save, sent again');
  assert.equal((await save(owner, last)).status, 200, 'its AI save');
  assert.equal((await save(owner, { ...last, title: 'renamed.docx' })).status, 200, 'a later save');
  assert.equal(await used(owner), DAILY_UPLOAD_LIMIT);

  const refused = localReport('uq-last-refused');
  await assertRefused(await upload(owner, refused, 1), 'a new upload at the limit');
  assert.equal(await exists(owner, refused.id), false);

  // Deleting at the limit frees the room, not the quota.
  await remove(owner, last.id);
  await assertRefused(await upload(owner, localReport('uq-last-refused'), 0), 'a new upload into the room just emptied');
  assert.equal(await used(owner), DAILY_UPLOAD_LIMIT);
});

// ===========================================================================
// 8. the window
// ===========================================================================

test('8. the quota window is the UTC day, as before: yesterday\'s uploads — deleted or not — are not counted, and a full account is free again after it', async () => {
  // The boundary itself: the last second of yesterday is out, the first second of today is in.
  const edge = await signUpOwner();
  for (let i = 0; i < 3; i += 1) await client.execute({ sql: `INSERT INTO upload_usage_tombstones (user_id, used_at) VALUES (?, datetime(date('now'), '-1 second'))`, args: [edge.userId] });
  for (let i = 0; i < 2; i += 1) await client.execute({ sql: `INSERT INTO upload_usage_tombstones (user_id, used_at) VALUES (?, datetime(date('now')))`, args: [edge.userId] });
  assert.equal(await used(edge), 2);

  // An account at its limit — some reports still there, some deleted.
  const owner = await signUpOwner();
  await usedEarlierToday(owner, DAILY_UPLOAD_LIMIT - 2);
  await uploaded(owner, 'uq-window', 0);
  const deleted = await uploaded(owner, 'uq-window', 1);
  await remove(owner, deleted.id);
  assert.equal(await used(owner), DAILY_UPLOAD_LIMIT);
  await assertRefused(await upload(owner, localReport('uq-window-refused'), 2), 'today');

  // The same usage, one day older: it is yesterday's.
  await client.execute({ sql: `UPDATE saved_reports SET saved_at = datetime(saved_at, '-1 day') WHERE user_id = ?`, args: [owner.userId] });
  await client.execute({ sql: `UPDATE upload_usage_tombstones SET used_at = datetime(used_at, '-1 day') WHERE user_id = ?`, args: [owner.userId] });
  assert.equal(await used(owner), 0, 'a new day starts at zero');
  await uploaded(owner, 'uq-window', 2);
  assert.equal(await used(owner), 1);
});

// ===========================================================================
// 9. the last slot
// ===========================================================================

test('9. two new uploads racing for the last slot are not both stored; with two slots left, both are', async () => {
  const owner = await signUpOwner();
  await usedEarlierToday(owner, DAILY_UPLOAD_LIMIT - 1);
  const a = localReport('uq-race'), b = localReport('uq-race');
  const responses = await Promise.all([upload(owner, a, 0), upload(owner, b, 1)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429], 'exactly one of the two takes the last slot');
  await assertRefused(responses.find((r) => r.status === 429), 'the upload that lost the race');
  assert.equal(await rows(owner), 1, 'exactly one report is stored');
  assert.equal(await used(owner), DAILY_UPLOAD_LIMIT, 'and the account is at its limit, not past it');

  // No false refusal: two slots, two uploads.
  const roomy = await signUpOwner();
  await usedEarlierToday(roomy, DAILY_UPLOAD_LIMIT - 2);
  const both = await Promise.all([upload(roomy, localReport('uq-race-two'), 0), upload(roomy, localReport('uq-race-two'), 1)]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.equal(await used(roomy), DAILY_UPLOAD_LIMIT);

  // The same upload racing with its own retry for the last slot is one upload: it is never refused for the quota.
  const retrier = await signUpOwner();
  await usedEarlierToday(retrier, DAILY_UPLOAD_LIMIT - 1);
  const once = localReport('uq-race-same');
  const twice = await Promise.all([upload(retrier, once, 0), upload(retrier, once, 0)]);
  assert.ok(twice.some((r) => r.status === 200), 'the upload is accepted');
  assert.equal(twice.some((r) => r.status === 429), false, `its own retry is not a second upload (${twice.map((r) => r.status).join(', ')})`);
  assert.equal(await rows(retrier), 1);
  assert.equal(await used(retrier), DAILY_UPLOAD_LIMIT);
});

// ===========================================================================
// 10-11. what the table keeps, and who is not metered
// ===========================================================================

test('10. the usage table keeps only what the count needs: one row per report of today that was deleted, nothing for an older one, and nothing once the account is gone', async () => {
  const columns = (await client.execute(`PRAGMA table_info('upload_usage_tombstones')`)).rows.map((r) => String(r.name));
  assert.deepEqual(columns, ['id', 'user_id', 'used_at'], 'no report or device identifier is kept');
  const trigger = await client.execute(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'saved_reports' AND name = 'trg_upload_usage_tombstone_on_report_delete'`);
  assert.equal(trigger.rows.length, 1);
  // Applying the migration again changes nothing (every statement in it is IF NOT EXISTS).
  await client.executeMultiple(fs.readFileSync(path.resolve('drizzle', '0054_upload_usage_tombstones.sql'), 'utf8'));
  assert.equal((await client.execute(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('upload_usage_tombstones', 'idx_upload_usage_tombstones_user_used_at', 'trg_upload_usage_tombstone_on_report_delete')`)).rows[0].n, 3);

  // A report that was saved before the table existed is a plain saved_reports row: it counts as it always did, and its deletion is no longer a refund.
  const owner = await signUpOwner();
  const old = localReport('uq-legacy');
  await seedReport(owner, old, { room: 0 });
  assert.equal(await used(owner), 1);
  await remove(owner, old.id);
  assert.equal(await used(owner), 1);
  const kept = await client.execute({ sql: 'SELECT used_at FROM upload_usage_tombstones WHERE user_id = ?', args: [owner.userId] });
  assert.equal(kept.rows.length, 1);
  assert.match(String(kept.rows[0].used_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'the upload\'s own time, in the form saved_at has');

  // Yesterday's report is outside the window whether it exists or not: deleting it records nothing.
  const yesterday = await uploaded(owner, 'uq-yesterday', 1);
  await client.execute({ sql: `UPDATE saved_reports SET saved_at = datetime(saved_at, '-1 day') WHERE device_key = ? AND id = ?`, args: [owner.deviceKey, yesterday.id] });
  assert.equal(await used(owner), 1);
  await remove(owner, yesterday.id);
  assert.equal(await tombstones(owner), 1, 'no row for a report that was not uploaded today');
  assert.equal(await used(owner), 1);

  // An anonymous legacy report belongs to no account: nothing is recorded for it.
  const before = await scalar('SELECT COUNT(*) AS n FROM upload_usage_tombstones', []);
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json) VALUES (?,?,?,?,?,?,?,?,?)`,
    args: ['uq-anonymous', 'uq-anonymous-device', 'sub-uq-anonymous', 'anonymous.docx', iso(0), 10, 0, 'Low', '{}'],
  });
  await client.execute({ sql: 'DELETE FROM saved_reports WHERE device_key = ? AND id = ?', args: ['uq-anonymous-device', 'uq-anonymous'] });
  assert.equal(await scalar('SELECT COUNT(*) AS n FROM upload_usage_tombstones', []), before);

  // Account deletion: its report cleanup writes the last rows, and deleting the user removes them all.
  await uploaded(owner, 'uq-account', 2);
  await deleteAllReportDataForAccount(client, owner.userId);
  assert.equal(await tombstones(owner), 2);
  await invalidateSessionsAndDeleteUser(client, owner.userId);
  assert.equal(await tombstones(owner), 0, 'nothing of the account is left in the table');
});

test('11. an admin account is still unlimited', async () => {
  const admin = await signUpOwner();
  await grantTestAdmin(dbFile, admin.email);
  await usedEarlierToday(admin, DAILY_UPLOAD_LIMIT);
  for (let room = 0; room < 2; room += 1) {
    const report = localReport('uq-admin');
    assert.equal((await upload(admin, report, room)).status, 200, 'an admin upload past the normal limit is accepted');
    await remove(admin, report.id);
  }
  requests += 1;
  const ip = `${admin.tag}-limit-${requests}`;
  await resetReadRateForTest(ip);
  const res = await uploadLimitRoute.GET(new Request('http://localhost/api/upload-limit', { headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${admin.cookie}` } }));
  assert.deepEqual(await res.json(), { authenticated: true, unlimited: true });
});
