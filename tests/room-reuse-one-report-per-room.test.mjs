import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import { resetAuthRateForTest, resetRateForTest } from '../lib/rate-limit.js';
import { ROOM_CYCLE_MS } from '../lib/report-rooms.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';
import {
  createPendingReportAdmissionJob,
  buildReportAdmissionSourceRef,
  claimReportAdmissionJobForProcessing,
  processReportAdmissionJob,
} from '../lib/corpus-admission-report-integration.ts';
import { findCandidateCorpusRepresentations, corpusShingleHashes, CORPUS_FINGERPRINT_VERSION } from '../lib/user-submission-corpus.ts';
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';

/**
 * One-current-report-per-room (Phases 1+2): an account+room holds AT MOST
 * one current customer report. Reusing an expired room deletes the prior
 * occupant's customer/report-layer state and inserts the replacement,
 * atomically, guarded by an admission-safety gate that never deletes a
 * report whose corpus-admission job has not yet reached a durable decision.
 * Covers: no-job replacement, a genuine pending-job straggler recovering
 * successfully, a straggler that still cannot recover (bounded, retryable
 * 503 — never a duplicate row, never data loss), 7-day maturity/ingest
 * survival across the delete, active-room behavior (unchanged), repeated
 * reuse row-count bounding, multi-room isolation, the old permalink's new
 * 404, and the room-reuse concurrency race. Every fixture here is synthetic.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_room_reuse_one_report_per_room.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ADMIN_EMAIL;

const dbUrl = `file:${dbFile}`;
const setupClient = createClient({ url: dbUrl });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

const client = createClient({ url: dbUrl });
await client.execute('PRAGMA foreign_keys = ON');

test.after(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const originalAdmissionFlag = process.env.CORPUS_ADMISSION_ENABLED;
const originalPromotionFlag = process.env.CORPUS_PROMOTION_ENABLED;
test.after(() => {
  if (originalAdmissionFlag === undefined) delete process.env.CORPUS_ADMISSION_ENABLED;
  else process.env.CORPUS_ADMISSION_ENABLED = originalAdmissionFlag;
  if (originalPromotionFlag === undefined) delete process.env.CORPUS_PROMOTION_ENABLED;
  else process.env.CORPUS_PROMOTION_ENABLED = originalPromotionFlag;
});

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

let ipCounter = 0;
async function signup(body) {
  const ip = `room-reuse-signup-${++ipCounter}`;
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(withTestIdentity(body)),
  });
  return signupRoute.POST(req);
}

function samplePayload(id, overrides = {}) {
  return {
    version: 11,
    id,
    submissionId: String(id).slice(-10),
    title: `report-${id}.pdf`,
    created: new Date().toISOString(),
    score: 3,
    wordCount: 400,
    text: `sample extracted text for report ${id}`,
    ...overrides,
  };
}

async function postReport(deviceKey, id, { cookie, room, payloadOverrides = {}, createdAt } = {}) {
  const ip = `room-reuse-post-${++ipCounter}`;
  await resetRateForTest(ip);
  const payload = samplePayload(id, payloadOverrides);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceKey,
      id: String(id),
      submissionId: payload.submissionId,
      title: payload.title,
      createdAt: createdAt ?? payload.created,
      wordCount: payload.wordCount,
      archiveScore: payload.score,
      scoreBand: 'Low',
      aiScore: 12,
      aiTone: 'low',
      room,
      payload,
    }),
  });
  return reportsRoute.POST(req);
}

async function getReportById(id, cookie) {
  const ip = `room-reuse-get-${++ipCounter}`;
  await resetRateForTest(ip);
  const headers = { 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request(`http://localhost/api/reports/${encodeURIComponent(String(id))}`, { headers });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id: String(id) }) });
}

async function userIdFor(email) {
  const result = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return result.rows[0].id;
}

async function savedReportRowCount(userId, roomNumber) {
  const result = await client.execute({
    sql: 'SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ? AND room_number = ?',
    args: [userId, roomNumber],
  });
  return Number(result.rows[0].c);
}

async function totalSavedReportRowCount(userId) {
  const result = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?', args: [userId] });
  return Number(result.rows[0].c);
}

async function currentRoomOccupantId(userId, roomNumber) {
  const result = await client.execute({
    sql: 'SELECT id FROM saved_reports WHERE user_id = ? AND room_number = ? ORDER BY report_created_at DESC LIMIT 1',
    args: [userId, roomNumber],
  });
  return result.rows[0]?.id ?? null;
}

async function jobRowFor(sourceRef) {
  const result = await client.execute({ sql: 'SELECT * FROM corpus_admission_report_jobs WHERE source_ref = ?', args: [sourceRef] });
  return result.rows[0] ?? null;
}
async function decisionRowFor(sourceRef) {
  const result = await client.execute({ sql: 'SELECT * FROM corpus_admission_decisions WHERE source_ref = ?', args: [sourceRef] });
  return result.rows[0] ?? null;
}
async function contentStoreCountFor(sourceRef) {
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS c FROM corpus_admission_content_store cs
          JOIN corpus_admission_decisions d ON d.id = cs.decision_id
          WHERE d.source_ref = ?`,
    args: [sourceRef],
  });
  return Number(result.rows[0].c);
}
async function acceptedRepresentationFor(sourceRef) {
  const result = await client.execute({
    sql: `SELECT r.* FROM corpus_admission_accepted_representations r
          JOIN corpus_admission_decisions d ON d.id = r.decision_id
          WHERE d.source_ref = ?`,
    args: [sourceRef],
  });
  return result.rows[0] ?? null;
}
async function promotionRowFor(representationId) {
  const result = await client.execute({
    sql: `SELECT * FROM corpus_admission_promotions WHERE representation_id = ? AND status = 'indexed'`,
    args: [representationId],
  });
  return result.rows[0] ?? null;
}
async function representationRowFor(canonicalSha256) {
  const result = await client.execute({ sql: 'SELECT * FROM corpus_document_representations WHERE canonical_sha256 = ?', args: [canonicalSha256] });
  return result.rows[0] ?? null;
}
async function shingleCountFor(representationId) {
  const result = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', args: [representationId] });
  return Number(result.rows[0].c);
}

// Real, English, >=3000-word synthetic article text — deliberately mirrors
// tests/corpus-admission-report-integration.test.mjs's own generator exactly
// (same shape, own seed space — separate database file, so no cross-file
// collision risk) so a genuine ACCEPT is exercised, not a REJECT/short-text
// stub, wherever this feature's tests need real admitted/promoted content.
const WORD_BANK = [
  'research', 'analysis', 'population', 'sample', 'variable', 'hypothesis', 'method', 'outcome', 'region',
  'temperature', 'pressure', 'reaction', 'material', 'structure', 'process', 'signal', 'pattern', 'network',
  'sediment', 'species', 'habitat', 'climate', 'growth', 'measurement', 'instrument', 'observation', 'protocol',
  'significant', 'distinct', 'gradual', 'consistent', 'notable', 'substantial', 'minor', 'extensive', 'localized',
  'documented', 'identified', 'recorded', 'analyzed', 'examined', 'compared', 'measured', 'observed', 'reported',
];
function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0xffffffff; };
}
function plausibleArticleText(seed, targetWords = 3300) {
  const rng = seededRandom(seed);
  const paragraphs = [];
  let wordCount = 0;
  while (wordCount < targetWords) {
    const sentence = `The ${Array.from({ length: 10 + Math.floor(rng() * 18) }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]).join(' ')}.`;
    const paragraph = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => sentence).join(' ');
    paragraphs.push(paragraph);
    wordCount += paragraph.split(/\s+/).length;
  }
  return paragraphs.join('\n\n');
}

const EXPIRED_CREATED_AT = () => new Date(Date.now() - ROOM_CYCLE_MS - 60_000).toISOString();

let signupCounter = 0;
async function signedUpAccount(prefix) {
  signupCounter += 1;
  const email = `${prefix}-${signupCounter}@example.com`;
  const deviceKey = `${prefix}-device-${signupCounter}`;
  const res = await signup({ email, password: 'correct-horse-battery', username: `${prefix}${signupCounter}`, deviceKey });
  const cookie = extractCookie(res);
  assert.ok(cookie, `signup must succeed for ${email}`);
  const userId = await userIdFor(email);
  return { email, deviceKey, cookie, userId };
}

// --- 1. NO_JOB: an expired occupant with no corpus-admission job at all ---
// (the common case today — the flag defaults off) is replaced safely.

test('NO_JOB: an expired occupant with no admission job is replaced safely — old row removed, exactly one row remains, other rooms untouched', async () => {
  delete process.env.CORPUS_ADMISSION_ENABLED;
  const { deviceKey, cookie, userId } = await signedUpAccount('no-job');

  const oldId = 'no-job-old-1';
  const first = await postReport(deviceKey, oldId, { cookie, room: 1, createdAt: EXPIRED_CREATED_AT() });
  assert.equal(first.status, 200);
  // A second room, untouched throughout — proves isolation even in this
  // simplest scenario.
  const otherRoomId = 'no-job-other-room-1';
  const otherRoom = await postReport(deviceKey, otherRoomId, { cookie, room: 2 });
  assert.equal(otherRoom.status, 200);

  const newId = 'no-job-new-1';
  const reused = await postReport(deviceKey, newId, { cookie, room: 1 });
  assert.equal(reused.status, 200, 'a no-job expired occupant must be replaced without any retryable error');

  assert.equal(await savedReportRowCount(userId, 1), 1, 'exactly one row may occupy room 1 after reuse');
  assert.equal(await currentRoomOccupantId(userId, 1), newId);
  assert.equal(await savedReportRowCount(userId, 2), 1, 'room 2 must be completely untouched');
  assert.equal(await currentRoomOccupantId(userId, 2), otherRoomId);

  const oldRes = await getReportById(oldId, cookie);
  assert.equal(oldRes.status, 404, 'the superseded report id must no longer resolve as a customer report');
});

// --- 2. PENDING-JOB SUCCESS: a genuine straggler recovers on the one ---
// synchronous chance the gate gives it, then is safely replaced.

test('PENDING-JOB SUCCESS: a straggler whose admission job is still pending recovers via the existing machinery and is then replaced — one row remains, its decision is now durable', async () => {
  process.env.CORPUS_ADMISSION_ENABLED = 'false';
  const { deviceKey, cookie, userId } = await signedUpAccount('pending-ok');

  const oldId = 'pending-ok-old-1';
  const text = plausibleArticleText(101);
  const first = await postReport(deviceKey, oldId, { cookie, room: 1, createdAt: EXPIRED_CREATED_AT(), payloadOverrides: { text } });
  assert.equal(first.status, 200);

  // Simulate the genuine straggler: a pending job exists (created directly,
  // exactly like tests/corpus-admission-report-integration.test.mjs's own
  // "CRASH-BEFORE-AFTER" fixture — never processed), while the report's own
  // retained text (saved_reports.payload_json) is fully intact.
  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  const created = await createPendingReportAdmissionJob(client, { accountId: userId, deviceKey, reportId: oldId });
  assert.ok(created?.jobId, 'test setup sanity: the pending job must be created');
  process.env.CORPUS_ADMISSION_ENABLED = 'false';
  const sourceRef = buildReportAdmissionSourceRef({ accountId: userId, deviceKey, reportId: oldId });
  assert.equal((await jobRowFor(sourceRef)).status, 'pending', 'test setup sanity: the job must still be pending before reuse is attempted');

  const newId = 'pending-ok-new-1';
  const reused = await postReport(deviceKey, newId, { cookie, room: 1 });
  assert.equal(reused.status, 200, 'the gate must recover the straggler synchronously and then allow replacement');

  assert.equal(await savedReportRowCount(userId, 1), 1, 'exactly one row may occupy the room after a successful recovery + replacement');
  assert.equal(await currentRoomOccupantId(userId, 1), newId);

  // The job-tracking row itself is always removed once its report is
  // deleted (deleteReportCorpusAdmissionData's own existing contract, reused
  // here unchanged — "that row exists only to track THIS report's own
  // processing status, which is moot once the report is gone"); what must
  // survive is the DURABLE DECISION the recovery attempt produced before
  // that cleanup ran.
  assert.equal(await jobRowFor(sourceRef), null, 'the job-tracking row is removed along with its report, exactly like every other report deletion');
  const decisionAfter = await decisionRowFor(sourceRef);
  assert.ok(decisionAfter, 'a durable decision must now exist for the recovered straggler — this is what proves the one synchronous recovery attempt actually ran and completed');

  const oldRes = await getReportById(oldId, cookie);
  assert.equal(oldRes.status, 404, 'the recovered-then-superseded report must no longer resolve as a customer report');
});

// --- 3. PENDING-JOB FAILURE: recovery still cannot produce a durable ---
// decision — bounded, customer-safe retry; never a data loss, never a
// duplicate row.

test('PENDING-JOB FAILURE: a straggler that still has no durable decision after the one recovery attempt blocks replacement with a retryable 503 — old report retained, no second row ever inserted', async () => {
  process.env.CORPUS_ADMISSION_ENABLED = 'false';
  const { deviceKey, cookie, userId } = await signedUpAccount('pending-fail');

  const oldId = 'pending-fail-old-1';
  const first = await postReport(deviceKey, oldId, { cookie, room: 1, createdAt: EXPIRED_CREATED_AT() });
  assert.equal(first.status, 200);

  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  const created = await createPendingReportAdmissionJob(client, { accountId: userId, deviceKey, reportId: oldId });
  assert.ok(created?.jobId);
  process.env.CORPUS_ADMISSION_ENABLED = 'false';
  const sourceRef = buildReportAdmissionSourceRef({ accountId: userId, deviceKey, reportId: oldId });

  // Corrupt the ONLY thing a not-yet-evaluated job still depends on —
  // saved_reports.payload_json's own `.text` — so the recovery attempt
  // reproduces the exact, real "no longer exists or has no retained text"
  // failure processReportAdmissionJob already persists (never a test-only
  // fault injected into the room-reuse gate itself).
  await client.execute({ sql: 'UPDATE saved_reports SET payload_json = ? WHERE device_key = ? AND id = ?', args: [JSON.stringify({}), deviceKey, oldId] });

  const newId = 'pending-fail-new-1';
  const reused = await postReport(deviceKey, newId, { cookie, room: 1 });
  assert.equal(reused.status, 503, 'a straggler that cannot recover must return the bounded, retryable condition — never a 200, never a 409');
  const body = await reused.json();
  assert.equal(body.code, 'ROOM_REUSE_NOT_READY');
  assert.match(body.error, /try again/i);
  assert.doesNotMatch(body.error, /corpus|admission|decision|job/i, 'the customer-facing message must never leak internal/corpus terminology');

  assert.equal(await savedReportRowCount(userId, 1), 1, 'exactly one row must exist — the OLD one — never zero, never two');
  assert.equal(await currentRoomOccupantId(userId, 1), oldId, 'the old report must be retained untouched');

  const jobAfter = await jobRowFor(sourceRef);
  assert.equal(jobAfter.status, 'failed');
  assert.equal(jobAfter.decision_id, null, 'test setup sanity: still genuinely non-terminal');
  assert.equal(await decisionRowFor(sourceRef), null, 'no decision may ever be fabricated for a report whose text could not be evaluated');

  const stillReadable = await getReportById(oldId, cookie);
  assert.equal(stillReadable.status, 200, 'the retained old report must still be a completely normal, readable customer report');

  const newRes = await getReportById(newId, cookie);
  assert.equal(newRes.status, 404, 'the rejected replacement must never have been persisted at all');
});

// --- 4. 7-DAY MATURITY + INGEST PRESERVATION -----------------------------

test('7-DAY MATURITY: room reuse deletes the old customer report but the admitted/promoted source, its decision, its maturity timestamp, and its device-provenance-free fingerprint all survive byte-for-byte, and remain matchable past the maturity window', async () => {
  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  process.env.CORPUS_PROMOTION_ENABLED = 'true';
  const { deviceKey, cookie, userId } = await signedUpAccount('maturity');

  const oldId = 'maturity-old-1';
  const text = plausibleArticleText(202);
  // T0: uploaded and, within this same synchronous test-harness call (see
  // lib/run-after-response.ts's own comment — runAfterResponse's deferred
  // callback runs inline and is awaited outside a real Next.js request
  // scope), admitted and promoted for real, exactly like a production
  // upload whose immediate deferred attempt succeeds on the first try.
  const first = await postReport(deviceKey, oldId, { cookie, room: 1, createdAt: EXPIRED_CREATED_AT(), payloadOverrides: { text } });
  assert.equal(first.status, 200);

  const sourceRef = buildReportAdmissionSourceRef({ accountId: userId, deviceKey, reportId: oldId });
  const jobBefore = await jobRowFor(sourceRef);
  assert.equal(jobBefore?.status, 'succeeded', 'test setup sanity: T0 admission must have completed synchronously');
  const decisionBefore = await decisionRowFor(sourceRef);
  assert.ok(decisionBefore, 'test setup sanity: a decision must exist');
  assert.equal(decisionBefore.decision, 'ACCEPT', 'test setup sanity: a real >=3000-word English article must ACCEPT');
  const acceptedRepBefore = await acceptedRepresentationFor(sourceRef);
  assert.ok(acceptedRepBefore, 'test setup sanity: an accepted fingerprint must exist');
  const canonicalHash = acceptedRepBefore.canonical_sha256;
  const representationBefore = await representationRowFor(canonicalHash);
  assert.ok(representationBefore, 'test setup sanity: a reusable representation must exist');
  const promotionBefore = await promotionRowFor(representationBefore.id);
  assert.ok(promotionBefore, 'test setup sanity: the representation must be promoted (indexed)');
  const maturityTimestampBefore = decisionBefore.created_at;
  const firstSeenBefore = representationBefore.first_seen_at;
  const shinglesBefore = await shingleCountFor(representationBefore.id);
  assert.ok(shinglesBefore > 0, 'test setup sanity: shingles must exist for real matching');

  // T0 + simulated 24h: room 1 is reused, the old saved_reports row deleted.
  const newId = 'maturity-new-1';
  const reused = await postReport(deviceKey, newId, { cookie, room: 1 });
  assert.equal(reused.status, 200);

  assert.equal(await savedReportRowCount(userId, 1), 1);
  assert.equal(await currentRoomOccupantId(userId, 1), newId);
  const oldGone = await client.execute({ sql: 'SELECT id FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, oldId] });
  assert.equal(oldGone.rows.length, 0, 'OLD_SAVED_REPORT_EXISTS must be NO');

  const decisionAfter = await decisionRowFor(sourceRef);
  assert.ok(decisionAfter, 'PRIOR_SOURCE_STILL_EXISTS must be YES — the decision must survive');
  assert.equal(decisionAfter.created_at, maturityTimestampBefore, 'MATURITY_CLOCK_UNCHANGED must be YES — the decision timestamp must be byte-for-byte unchanged by room reuse');
  assert.equal(await contentStoreCountFor(sourceRef), 1, 'the retained accepted content must survive room reuse');
  const acceptedRepAfter = await acceptedRepresentationFor(sourceRef);
  assert.ok(acceptedRepAfter);
  assert.equal(acceptedRepAfter.revoked_at, null, 'the fingerprint must remain active, never revoked by room reuse');
  const representationAfter = await representationRowFor(canonicalHash);
  assert.ok(representationAfter, 'the reusable representation must survive room reuse');
  assert.equal(representationAfter.first_seen_at, firstSeenBefore, 'the representation\'s own maturity anchor (first_seen_at) must be unchanged');
  const promotionAfter = await promotionRowFor(representationAfter.id);
  assert.ok(promotionAfter, 'the promotion (indexed) record must survive room reuse');
  assert.equal(promotionAfter.status, 'indexed');
  assert.equal(await shingleCountFor(representationAfter.id), shinglesBefore, 'every shingle must survive room reuse');

  // T0 + simulated 7d: artificially age every backing past the maturity
  // window (tests/helpers/corpus-maturity.mjs — the same helper
  // tests/corpus-admission-automatic-promotion.test.mjs already uses) and
  // confirm the retained source is STILL discoverable as an actively
  // promoted candidate under the existing, unmodified maturity rules.
  await matureCorpusBackings(client);
  const hashes = corpusShingleHashes(text, 5);
  const candidates = await findCandidateCorpusRepresentations(client, hashes, {
    fingerprintVersion: CORPUS_FINGERPRINT_VERSION,
    minSharedShingles: 1,
    limit: 10,
  });
  const stillFound = candidates.find((c) => c.representationId === representationAfter.id);
  assert.ok(stillFound, 'the admitted source must still be found by real candidate matching past the 7-day maturity window');
  assert.equal(stillFound.isActivelyPromoted, true, 'it must still be classified as an actively promoted source');
});

// --- 5. ACTIVE_ROOM: unchanged (<24h) behavior --------------------------

test('ACTIVE_ROOM: an occupant within its 24h cycle still refuses a second upload with 409 — old report untouched, no new row, unchanged by this feature', async () => {
  const { deviceKey, cookie, userId } = await signedUpAccount('active-room');
  const oldId = 'active-room-old-1';
  const first = await postReport(deviceKey, oldId, { cookie, room: 1 });
  assert.equal(first.status, 200);

  const second = await postReport(deviceKey, 'active-room-new-1', { cookie, room: 1 });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.ok(typeof body.cycleEndsAt === 'string');

  assert.equal(await savedReportRowCount(userId, 1), 1);
  assert.equal(await currentRoomOccupantId(userId, 1), oldId, 'the active occupant must be completely untouched by a refused reuse attempt');
});

// --- 6. REPEATED REUSE: Room 1 never accumulates history ----------------

test('REPEATED REUSE: sequential expire+reuse cycles (A->B->C->D) in Room 1 always leave exactly one row, and every superseded id 404s', async () => {
  delete process.env.CORPUS_ADMISSION_ENABLED;
  const { deviceKey, cookie, userId } = await signedUpAccount('repeated');
  const ids = ['repeated-a', 'repeated-b', 'repeated-c', 'repeated-d'];

  for (let i = 0; i < ids.length; i += 1) {
    const createdAt = i < ids.length - 1 ? EXPIRED_CREATED_AT() : undefined;
    const res = await postReport(deviceKey, ids[i], { cookie, room: 1, createdAt });
    assert.equal(res.status, 200, `reuse cycle ${i} (${ids[i]}) must succeed`);
    assert.equal(await savedReportRowCount(userId, 1), 1, `exactly one row must exist after inserting ${ids[i]}`);
    assert.equal(await currentRoomOccupantId(userId, 1), ids[i]);
  }

  for (let i = 0; i < ids.length - 1; i += 1) {
    const res = await getReportById(ids[i], cookie);
    assert.equal(res.status, 404, `superseded report ${ids[i]} must no longer resolve as a customer report`);
  }
  const latest = await getReportById(ids[ids.length - 1], cookie);
  assert.equal(latest.status, 200, 'the current occupant must remain fully readable');
});

// --- 7. MULTI-ROOM ISOLATION ---------------------------------------------

test('MULTI-ROOM ISOLATION: reusing Room 1 repeatedly never touches Rooms 2-6 — total current rows stay bounded by room count, not historical accumulation', async () => {
  delete process.env.CORPUS_ADMISSION_ENABLED;
  const { deviceKey, cookie, userId } = await signedUpAccount('multiroom');

  for (let room = 2; room <= 6; room += 1) {
    const res = await postReport(deviceKey, `multiroom-static-${room}`, { cookie, room });
    assert.equal(res.status, 200);
  }

  const room1First = await postReport(deviceKey, 'multiroom-1-a', { cookie, room: 1, createdAt: EXPIRED_CREATED_AT() });
  assert.equal(room1First.status, 200);
  const room1Second = await postReport(deviceKey, 'multiroom-1-b', { cookie, room: 1, createdAt: EXPIRED_CREATED_AT() });
  assert.equal(room1Second.status, 200);
  const room1Third = await postReport(deviceKey, 'multiroom-1-c', { cookie, room: 1 });
  assert.equal(room1Third.status, 200);

  for (let room = 2; room <= 6; room += 1) {
    assert.equal(await savedReportRowCount(userId, room), 1, `room ${room} must be completely untouched by Room 1's reuse`);
    assert.equal(await currentRoomOccupantId(userId, room), `multiroom-static-${room}`);
  }
  assert.equal(await currentRoomOccupantId(userId, 1), 'multiroom-1-c');
  assert.equal(await totalSavedReportRowCount(userId), 6, 'total current customer report rows must equal the number of rooms actually used, never historical accumulation');
});

// --- 8. ROOM-REUSE CONCURRENCY: two simultaneous reuse attempts ----------

test('ROOM-REUSE RACE: two concurrent uploads racing to reuse the SAME expired room never both succeed — exactly one wins, the other gets 409, and the room never ends up with two rows', async () => {
  delete process.env.CORPUS_ADMISSION_ENABLED;
  const { deviceKey, cookie, userId } = await signedUpAccount('reuse-race');
  const oldId = 'reuse-race-old-1';
  const first = await postReport(deviceKey, oldId, { cookie, room: 1, createdAt: EXPIRED_CREATED_AT() });
  assert.equal(first.status, 200);

  const [resA, resB] = await Promise.all([
    postReport(deviceKey, 'reuse-race-a', { cookie, room: 1 }),
    postReport(deviceKey, 'reuse-race-b', { cookie, room: 1 }),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one concurrent reuse attempt must succeed and the other must be refused — never both 200');
  assert.equal(await savedReportRowCount(userId, 1), 1, 'the room must end up with exactly one row, never two, never zero');

  const winnerId = resA.status === 200 ? 'reuse-race-a' : 'reuse-race-b';
  assert.equal(await currentRoomOccupantId(userId, 1), winnerId);

  const oldRes = await getReportById(oldId, cookie);
  assert.equal(oldRes.status, 404, 'the original expired occupant must have been replaced by the winner');
});

// --- 9. ATOMIC SINGLE-JOB CLAIM (direct): serializes concurrent evaluation ---
// Calls claimReportAdmissionJobForProcessing + processReportAdmissionJob
// directly (bypassing the HTTP room-reuse flow entirely, so the winning
// room-claim's own cleanup can never delete the job row before this test
// gets to inspect it) — the most precise, deterministic proof that the
// claim actually serializes two concurrent callers racing the SAME job.

test('ATOMIC SINGLE-JOB CLAIM: two concurrent claim+process attempts on the SAME job never both evaluate — exactly one decision, job.decision_id stable and pointing at it, corpus data never duplicated', async () => {
  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  const { deviceKey, userId } = await signedUpAccount('claim-direct');
  const reportId = 'claim-direct-report-1';
  const text = plausibleArticleText(404);
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, updated_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportId, deviceKey, 'sub-claim-direct-1', 'T', 3300, 10, 'low', JSON.stringify({ text }), userId],
  });
  const created = await createPendingReportAdmissionJob(client, { accountId: userId, deviceKey, reportId });
  assert.ok(created?.jobId);
  const sourceRef = buildReportAdmissionSourceRef({ accountId: userId, deviceKey, reportId });
  const openConnection = () => createClient({ url: dbUrl });

  // Two independent callers race to claim the SAME job id.
  const [claimedA, claimedB] = await Promise.all([
    claimReportAdmissionJobForProcessing(openConnection, created.jobId),
    claimReportAdmissionJobForProcessing(openConnection, created.jobId),
  ]);
  assert.notEqual(claimedA, claimedB, 'exactly one of the two concurrent claim attempts may win — never both, never neither');
  const winnerClaimed = claimedA || claimedB;
  assert.equal(winnerClaimed, true);

  // Only the WINNER may ever call processReportAdmissionJob — this mirrors
  // exactly what ensureRoomReuseAdmissionSafety itself now does.
  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(outcome.decision, 'ACCEPT', 'test setup sanity: a real >=3000-word English article must ACCEPT');

  const decisionCountResult = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE source_ref = ?', args: [sourceRef] });
  assert.equal(Number(decisionCountResult.rows[0].c), 1, 'CONCURRENT_SAME_JOB_PROCESSING_SERIALIZED: exactly one decision row may ever exist — the loser must never have called processReportAdmissionJob at all');

  const jobAfter = await jobRowFor(sourceRef);
  assert.equal(jobAfter.status, 'succeeded');
  assert.equal(jobAfter.decision_id, outcome.decisionId, 'JOB_DECISION_ID_STABLE: the job must point at the one and only decision that was ever created — no last-write-wins ambiguity is possible when only one caller ever evaluates');

  assert.equal(await contentStoreCountFor(sourceRef), 1, 'no duplicate content row');
  const acceptedRep = await acceptedRepresentationFor(sourceRef);
  assert.ok(acceptedRep, 'no duplicate accepted representation — exactly one must exist');
  const representation = await representationRowFor(acceptedRep.canonical_sha256);
  assert.ok(representation, 'no duplicate corpus representation — exactly one must exist');
  const promotion = await promotionRowFor(representation.id);
  assert.ok(promotion, 'no duplicate promotion — exactly one indexed promotion must exist');
});

// --- 10. CONCURRENT SAME-JOB PRODUCTION-PATH RACE (full HTTP flow) -------

test('CONCURRENT SAME-JOB PRODUCTION-PATH RACE: two concurrent room-reuse requests recovering the SAME straggler never double-process it — exactly one decision, no duplicate corpus rows, exactly one room winner, no duplicate saved_reports row', async () => {
  process.env.CORPUS_ADMISSION_ENABLED = 'false';
  const { deviceKey, cookie, userId } = await signedUpAccount('same-job-prod');

  const oldId = 'same-job-prod-old-1';
  const text = plausibleArticleText(505);
  const first = await postReport(deviceKey, oldId, { cookie, room: 1, createdAt: EXPIRED_CREATED_AT(), payloadOverrides: { text } });
  assert.equal(first.status, 200);

  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  const created = await createPendingReportAdmissionJob(client, { accountId: userId, deviceKey, reportId: oldId });
  assert.ok(created?.jobId);
  process.env.CORPUS_ADMISSION_ENABLED = 'false';
  const sourceRef = buildReportAdmissionSourceRef({ accountId: userId, deviceKey, reportId: oldId });
  assert.equal((await jobRowFor(sourceRef)).status, 'pending', 'test setup sanity: still pending before the race');

  const [resA, resB] = await Promise.all([
    postReport(deviceKey, 'same-job-prod-a', { cookie, room: 1 }),
    postReport(deviceKey, 'same-job-prod-b', { cookie, room: 1 }),
  ]);

  const statuses = [resA.status, resB.status].sort();
  console.log('[CONCURRENT SAME-JOB PRODUCTION-PATH] observed status pair:', statuses);
  assert.equal(statuses.filter((s) => s === 200).length, 1, 'exactly one request may succeed');
  assert.ok(
    (statuses[0] === 200 && statuses[1] === 409) || (statuses[0] === 200 && statuses[1] === 503),
    `expected the winner (200) paired with either a room conflict (409) or a not-ready straggler (503), got ${JSON.stringify(statuses)}`,
  );

  assert.equal(await savedReportRowCount(userId, 1), 1, 'no duplicate saved_reports row may ever result from this race');

  const decisionCountResult = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE source_ref = ?', args: [sourceRef] });
  assert.equal(Number(decisionCountResult.rows[0].c), 1, 'exactly one decision row must exist — the atomic claim must prevent a second, duplicate evaluation of the same job');

  const decision = await decisionRowFor(sourceRef);
  assert.ok(decision);
  assert.equal(decision.decision, 'ACCEPT');
  assert.equal(await contentStoreCountFor(sourceRef), 1, 'no duplicate content row');
  const acceptedRep = await acceptedRepresentationFor(sourceRef);
  assert.ok(acceptedRep, 'no duplicate accepted representation — exactly one must exist');
  const representation = await representationRowFor(acceptedRep.canonical_sha256);
  assert.ok(representation, 'no duplicate corpus representation');
  const promotion = await promotionRowFor(representation.id);
  assert.ok(promotion, 'no duplicate promotion');
});

// --- 11. CLAIM-LOSS: an active (non-stale) claim blocks a room-reuse request ---

test('CLAIM-LOSS: room reuse against a job whose claim is currently held (not stale) never processes it, never deletes the old report, never inserts a second report, and returns retryable NOT_READY', async () => {
  process.env.CORPUS_ADMISSION_ENABLED = 'false';
  const { deviceKey, cookie, userId } = await signedUpAccount('claim-loss');

  const oldId = 'claim-loss-old-1';
  const first = await postReport(deviceKey, oldId, { cookie, room: 1, createdAt: EXPIRED_CREATED_AT() });
  assert.equal(first.status, 200);

  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  const created = await createPendingReportAdmissionJob(client, { accountId: userId, deviceKey, reportId: oldId });
  assert.ok(created?.jobId);
  process.env.CORPUS_ADMISSION_ENABLED = 'false';
  const sourceRef = buildReportAdmissionSourceRef({ accountId: userId, deviceKey, reportId: oldId });

  // Simulate "Request A has already claimed this job and is mid-processing"
  // WITHOUT actually evaluating it — a fresh (non-stale) claimed_at with the
  // job still genuinely pending. This is exactly the atomic claim primitive
  // itself, called directly, never processReportAdmissionJob.
  const openConnection = () => createClient({ url: dbUrl });
  const claimedByA = await claimReportAdmissionJobForProcessing(openConnection, created.jobId);
  assert.equal(claimedByA, true, 'test setup sanity: the simulated "Request A" claim must succeed');
  assert.equal((await jobRowFor(sourceRef)).status, 'pending', 'test setup sanity: still pending — A has claimed it but not yet processed it');

  const newId = 'claim-loss-new-1';
  const reused = await postReport(deviceKey, newId, { cookie, room: 1 });
  assert.equal(reused.status, 503, 'Request B must receive the bounded, retryable condition — the active claim must never be bypassed');
  const body = await reused.json();
  assert.equal(body.code, 'ROOM_REUSE_NOT_READY');

  // B must never have called processReportAdmissionJob: zero decisions exist.
  const decisionCountResult = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE source_ref = ?', args: [sourceRef] });
  assert.equal(Number(decisionCountResult.rows[0].c), 0, 'Request B must never evaluate a job it does not hold the claim for');

  assert.equal(await savedReportRowCount(userId, 1), 1, 'the old report must be retained — never deleted while another claim is active');
  assert.equal(await currentRoomOccupantId(userId, 1), oldId);
  const newRes = await getReportById(newId, cookie);
  assert.equal(newRes.status, 404, 'the rejected replacement must never have been persisted');
});

// --- 12. STALE-CLAIM RECOVERY: an abandoned claim is reclaimable ---------

test('STALE-CLAIM RECOVERY: a claim far older than the sweep\'s own stale threshold is treated as abandoned and reclaimed — room reuse succeeds normally', async () => {
  process.env.CORPUS_ADMISSION_ENABLED = 'false';
  const { deviceKey, cookie, userId } = await signedUpAccount('stale-claim');

  const oldId = 'stale-claim-old-1';
  // Real ACCEPT-quality text (matching this file's own convention elsewhere)
  // so the reclaimed evaluation produces a genuinely durable ACCEPT decision
  // — a REJECT-quality submission's decision would be legitimately removed
  // again by room reuse's own cleanup (nothing corpus-valuable to preserve),
  // which would make "the job was actually reclaimed and evaluated" and "no
  // job was ever processed at all" indistinguishable from the outside.
  const text = plausibleArticleText(606);
  const first = await postReport(deviceKey, oldId, { cookie, room: 1, createdAt: EXPIRED_CREATED_AT(), payloadOverrides: { text } });
  assert.equal(first.status, 200);

  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  const created = await createPendingReportAdmissionJob(client, { accountId: userId, deviceKey, reportId: oldId });
  assert.ok(created?.jobId);
  process.env.CORPUS_ADMISSION_ENABLED = 'false';
  const sourceRef = buildReportAdmissionSourceRef({ accountId: userId, deviceKey, reportId: oldId });

  // Simulate an abandoned claim — far older than the sweep's own 5-minute
  // default stale threshold (reused unchanged, never a second duration
  // constant — see lib/corpus-admission-report-integration.ts's own
  // DEFAULT_STALE_CLAIM_MS).
  await client.execute({
    sql: "UPDATE corpus_admission_report_jobs SET claimed_at = datetime('now', '-30 minutes') WHERE id = ?",
    args: [created.jobId],
  });

  const newId = 'stale-claim-new-1';
  const reused = await postReport(deviceKey, newId, { cookie, room: 1 });
  assert.equal(reused.status, 200, 'STALE_JOB_RECOVERABLE: an abandoned (stale) claim must not permanently block room reuse');

  assert.equal(await savedReportRowCount(userId, 1), 1);
  assert.equal(await currentRoomOccupantId(userId, 1), newId);

  const jobAfter = await jobRowFor(sourceRef);
  assert.equal(jobAfter, null, 'the recovered job row is removed along with its report, exactly like every other successful replacement');
  const decision = await decisionRowFor(sourceRef);
  assert.ok(decision, 'the stale job must have actually been reclaimed and evaluated to a durable decision, not left untouched');
  assert.equal(decision.decision, 'ACCEPT', 'test setup sanity: a real >=3000-word English article must ACCEPT, proving the reclaim genuinely evaluated it');

  const oldRes = await getReportById(oldId, cookie);
  assert.equal(oldRes.status, 404);
});

console.log('All one-current-report-per-room tests passed');
