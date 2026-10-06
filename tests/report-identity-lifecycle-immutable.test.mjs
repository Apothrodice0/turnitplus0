import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as roomsRoute from '../app/api/reports/rooms/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest, resetPollRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';
import { completeAiAnalysis } from './helpers/complete-ai-analysis.mjs';
import { atServerTime, setReportCreatedAt } from './helpers/report-clock.mjs';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import { withEvidenceInterpretation } from '../lib/report-evidence-interpretation.ts';
import { decodeReportFromPersistence, encodeReportForPersistence } from '../lib/report-persistence.ts';
import { ROOM_CYCLE_MS } from '../lib/report-rooms.ts';
import {
  finalizeSelectiveCorpusAuthoritativeReport,
  claimStaleSelectiveCorpusAuthoritativePendingReports,
} from '../lib/selective-corpus-authoritative.ts';

/**
 * A REPORT'S CREATION TIME IS THE SERVER'S, AND NO SAVE CHANGES WHICH REPORT A REPORT IS.
 *
 * saved_reports.report_created_at is a report's lifecycle clock: the room's 24-hour cycle, which report a room's
 * replacement deletes, and the Selective Corpus recovery sweep's minimum age are all read from it. submission_id is the
 * reference a report is listed and looked up under. Both used to come from the save request — on every save. A first
 * save that said "created three days ago" stored a report already outside its cycle, so the same room took upload after
 * upload; a later save could move an existing report's time the same way, and the next upload — refused 409 a moment
 * earlier — was accepted and deleted it; "created in 2099" kept a room occupied, and a pending report out of the sweep,
 * for good.
 *
 * This file pins the rule that replaced it, through the real routes and the real upsert statement:
 *   - the creation time is the server's clock at the report's first save (tests 1-2), whatever the request claims;
 *   - no later save moves it, or the submission id the first save established (tests 4-9), for an ordinary report, a
 *     pending authoritative one and a finalized one;
 *   - the copies of both inside the stored report — what the report page and the receipt print — are the row's values
 *     (tests 1, 4, 5, 7, 11): a stored report cannot show a creation date or a submission id its own row does not carry;
 *   - everything a save is for still happens (the AI result, a re-analysis, a pending report's progress), and the room
 *     cycle and replacement behave as they always did when time really passes (test 3).
 *
 * A test that needs a report of a particular age gets one from the server clock or from the database
 * (helpers/report-clock.mjs) — never by sending a creation time through the save route.
 *
 * The title is content, not identity: it travels with the payload a save stores, and is kept with the payload once a
 * report is finalized (test 6).
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

const workDir = mkdtempSync(path.join(process.env.TURNITPLUS_TEST_DB_DIR || tmpdir(), 'report-identity-'));
const dbFile = path.join(workDir, 'report_identity.db');
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
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const cycleEnd = (createdAt) => new Date(Date.parse(createdAt) + ROOM_CYCLE_MS).toISOString();

let accounts = 0;
async function signUpOwner() {
  accounts += 1;
  const tag = `ri-${accounts}`, email = `ri-owner-${accounts}@example.test`, deviceKey = `ri-device-${accounts}`;
  await resetAuthRateForTest(`${tag}-signup`);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${tag}-signup` },
    body: JSON.stringify(withTestIdentity({ email, password: 'ri-owner-pw-1', username: `riowner${accounts}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = (res.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)[1];
  const userId = String((await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  return { userId, deviceKey, cookie, tag };
}

let reports = 0;
/**
 * The report as the browser holds it after its check. `created` is the BROWSER's clock at that moment: every save
 * sends it (as `createdAt` and inside the payload), and the server never uses it.
 */
function localReport(prefix, { created = iso(-20 * 60 * 1000), wordsCount = 600 } = {}) {
  reports += 1;
  const text = words(wordsCount, 6100 + reports);
  return {
    version: 11, id: `${prefix}-${reports}`, submissionId: `sub-${prefix}-${reports}`, title: `${prefix}-${reports}.docx`, author: '', assignment: '', created,
    score: 0, archiveScore: 0, scoreBand: 'Low', wordCount: tokensForScoringNormalization(text, 2).length, characterCount: text.length,
    matchedWordCount: 0, archiveMatchedPositions: [], scoringNormalizationVersion: 2,
    sources: [], repeats: [], text, academicEvidenceStatus: 'COMPLETE_NO_MATCHES', externalAcademicEvidence: [],
  };
}

let requests = 0;
/**
 * POST /api/reports. `ai: false` is the first save of a check (AI still running); the default is the browser's AI save
 * (room-page-shell.tsx saveEnrichedAiResult): the report it holds with the AI result spread over it. `payload` / `body`
 * add or replace fields of either — which is how a save that carries a different identity is sent.
 */
async function save(owner, report, { ai = true, aiScore = 5, room, payload = {}, body = {} } = {}) {
  requests += 1;
  const ip = `${owner.tag}-post-${requests}`;
  await resetRateForTest(ip);
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` },
    body: JSON.stringify({
      deviceKey: owner.deviceKey, id: report.id, submissionId: report.submissionId, title: report.title, createdAt: report.created,
      wordCount: report.wordCount, archiveScore: report.archiveScore, scoreBand: report.scoreBand,
      aiScore: ai ? aiScore : null, aiTone: ai ? 'low' : null, aiStatus: ai ? 'ready' : 'processing', scoringNormalization: 2, academicSearchDiagnosticsId: null,
      ...(room === undefined ? {} : { room }),
      payload: { ...report, ...(ai ? { aiScore, aiAnalysis: completeAiAnalysis() } : {}), ...payload },
      ...body,
    }),
  }));
}
const firstSave = (owner, report, room = 0) => save(owner, report, { ai: false, room });

/** The identity columns of the stored row, and whether the row exists at all. */
async function identity(owner, id) {
  const r = await client.execute({ sql: 'SELECT submission_id, title, report_created_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [owner.deviceKey, id] });
  return r.rows[0] ? { submission_id: r.rows[0].submission_id, title: r.rows[0].title, report_created_at: r.rows[0].report_created_at } : null;
}
/** The identity row of `report` as created at `createdAt` — the server's time for a report the route created. */
const identityOf = (report, createdAt) => ({ submission_id: report.submissionId, title: report.title, report_created_at: createdAt });
/** The report's first save through the route; returns the creation time the server gave it. */
async function create(owner, report, room = 0) {
  assert.equal((await firstSave(owner, report, room)).status, 200, 'test setup sanity: the first save must succeed');
  return String((await identity(owner, report.id)).report_created_at);
}
async function stored(owner, id) {
  const r = await client.execute({ sql: 'SELECT payload_json, ai_status, ai_score, word_count, archive_score, score_band FROM saved_reports WHERE device_key = ? AND id = ?', args: [owner.deviceKey, id] });
  const raw = JSON.parse(String(r.rows[0].payload_json));
  return { raw, report: decodeReportFromPersistence(JSON.parse(String(r.rows[0].payload_json))), aiStatus: r.rows[0].ai_status, aiScore: r.rows[0].ai_score, archiveScore: Number(r.rows[0].archive_score), scoreBand: r.rows[0].score_band };
}
/**
 * The report's own copies of its identity — what the report page and the receipt print — as stored, and as the owner is
 * served them (GET /api/reports/[id]). One value: the two must agree.
 */
async function copies(owner, id) {
  const { raw } = await stored(owner, id);
  requests += 1;
  const ip = `${owner.tag}-get-${requests}`;
  await resetReadRateForTest(ip);
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(owner.deviceKey)}`, { headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  assert.equal(res.status, 200, 'test setup sanity: the owner can open the report');
  const served = (await res.json()).payload;
  assert.deepEqual({ submissionId: served.submissionId, created: served.created }, { submissionId: raw.submissionId, created: raw.created }, 'the served report shows what is stored');
  return { submissionId: raw.submissionId, created: raw.created };
}

/** The room index entry (GET /api/reports/rooms) and the room's occupant (GET /api/reports?room=N), as the owner is served them. */
async function room(owner, number = 0) {
  requests += 1;
  const ip = `${owner.tag}-room-${requests}`;
  await resetReadRateForTest(ip);
  await resetPollRateForTest(ip);
  const headers = { 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` };
  const index = (await (await roomsRoute.GET(new Request('http://localhost/api/reports/rooms', { headers }))).json()).rooms.find((r) => r.room === number);
  const occupant = await (await reportsRoute.GET(new Request(`http://localhost/api/reports?room=${number}`, { headers }))).json();
  return {
    status: index.status, mostRecentAt: index.mostRecentAt, cycleEndsAt: index.cycleEndsAt,
    occupantStatus: occupant.status, occupantId: occupant.report?.id ?? null, occupantCreatedAt: occupant.report?.createdAt ?? null, occupantCycleEndsAt: occupant.cycleEndsAt,
  };
}
const EMPTY_ROOM = { status: 'empty', mostRecentAt: null, cycleEndsAt: null, occupantStatus: 'empty', occupantId: null, occupantCreatedAt: null, occupantCycleEndsAt: null };
/** What the report list (GET /api/reports) shows for one report. */
async function listed(owner, id) {
  requests += 1;
  const ip = `${owner.tag}-list-${requests}`;
  await resetReadRateForTest(ip);
  const res = await reportsRoute.GET(new Request('http://localhost/api/reports', { headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` } }));
  const entry = (await res.json()).reports.find((r) => r.id === String(id));
  return entry ? { submissionId: entry.submissionId, title: entry.title, createdAt: entry.createdAt } : null;
}

/** The ways a save can claim another creation time. */
const FORGED_TIMES = [
  ['three days ago', () => iso(-3 * DAY)],
  ['just past the cycle', () => iso(-ROOM_CYCLE_MS - 60_000)],
  ['far in the future', () => '2099-01-01T00:00:00.000Z'],
  ['not a date', () => 'not-a-date'],
  ['a date in another format', () => '2001-01-01 00:00:00'],
];

// ---- authoritative fixtures: the pending row a first save persists, and the finalizer ----
const EVALUATOR_VERSION = 'selective-corpus-shadow-v1';
const completedShadow = () => ({
  state: 'COMPLETED', evaluatorVersion: EVALUATOR_VERSION, corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
  verifiedEvidence: [{ sourceLabel: 'S1', matchedPassages: [{ submittedWordStart: 100, submittedWordEnd: 159, matchedWordCount: 60 }] }],
});
/** A pending authoritative row written straight into the database, created at `report.created`. */
async function seedPending(owner, report, roomNumber = 0) {
  const built = withEvidenceInterpretation({ ...report }, { selectiveCorpusBranch: null });
  const payload = { ...encodeReportForPersistence(built), selectiveCorpusAuthoritativeStatus: 'pending' };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_status, payload_json, user_id, room_number)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [report.id, owner.deviceKey, report.submissionId, report.title, report.created, report.wordCount, report.archiveScore, report.scoreBand, 'processing', JSON.stringify(payload), owner.userId, roomNumber],
  });
}
const finalize = (owner, id) =>
  finalizeSelectiveCorpusAuthoritativeReport(client, { reportDeviceKey: owner.deviceKey, reportId: id, accountId: owner.userId, shadowResult: completedShadow(), shadowScoringNormalizationVersion: 2 });
const sweep = () => claimStaleSelectiveCorpusAuthoritativePendingReports({ openConnection: () => createClient({ url: `file:${dbFile}` }), minAgeMs: 60_000, staleClaimMs: 60_000 });

// ===========================================================================
// 1. the first save: the creation time is the server's clock
// ===========================================================================

test('1. a first save cannot choose its creation time: row, stored report, list and room all carry the server\'s current time, and the room is occupied for a real cycle', async () => {
  for (const [label, forgedTime] of FORGED_TIMES) {
    const owner = await signUpOwner();
    // The upload says when it was created — in the request and in the report it carries.
    const report = localReport('ri-new', { created: forgedTime() });
    const before = Date.now();
    assert.equal((await firstSave(owner, report)).status, 200, label);
    const after = Date.now();

    const row = await identity(owner, report.id);
    const createdMs = Date.parse(String(row.report_created_at));
    assert.ok(createdMs >= before && createdMs <= after, `${label}: the stored creation time is the server's clock during the save (${row.report_created_at}), not the request's (${report.created})`);
    assert.equal(row.report_created_at, new Date(createdMs).toISOString(), `${label}: in the one format every reader of the column expects`);
    assert.equal(row.submission_id, report.submissionId, `${label}: the first save establishes the submission id`);

    // The copies a reader is shown are the row's.
    assert.deepEqual(await copies(owner, report.id), { submissionId: report.submissionId, created: row.report_created_at }, `${label}: the stored report`);
    assert.deepEqual(await listed(owner, report.id), { submissionId: report.submissionId, title: report.title, createdAt: row.report_created_at }, `${label}: the report list`);
    const occupied = await room(owner);
    assert.equal(occupied.status, 'processing', `${label}: the room is occupied`);
    assert.equal(occupied.occupantId, report.id);
    assert.equal(occupied.occupantCreatedAt, row.report_created_at, `${label}: the served report`);
    assert.equal(occupied.cycleEndsAt, cycleEnd(row.report_created_at), `${label}: its cycle runs 24 hours from the server's time`);
    assert.equal(occupied.occupantCycleEndsAt, occupied.cycleEndsAt);

    // So a back-dated upload does not leave its room free: the next upload is refused, whatever time IT claims.
    const other = localReport('ri-new-other', { created: forgedTime() });
    const second = await firstSave(owner, other);
    assert.equal(second.status, 409, `${label}: the room is occupied — a second upload is refused`);
    assert.equal((await second.json()).cycleEndsAt, occupied.cycleEndsAt, `${label}: until the real end of its cycle`);
    assert.ok(await identity(owner, report.id), `${label}: and the first report was not replaced`);
    assert.equal(await identity(owner, other.id), null);
  }
});

test('2. the clock is the server\'s: with it fixed, the creation time is exactly that instant — which is how a fixture gets a report of a chosen age', async () => {
  // Twenty minutes ago by the server; "2099" by the request.
  const owner = await signUpOwner();
  const report = localReport('ri-clock', { created: '2099-01-01T00:00:00.000Z' });
  const at = iso(-20 * 60 * 1000);
  await atServerTime(at, async () => assert.equal((await firstSave(owner, report)).status, 200));
  assert.deepEqual(await identity(owner, report.id), identityOf(report, at));
  assert.deepEqual(await copies(owner, report.id), { submissionId: report.submissionId, created: at });
  assert.equal((await room(owner)).cycleEndsAt, cycleEnd(at));

  // A report the server created more than a cycle ago is past its cycle now: the room is free, and the next upload replaces it.
  const agedOwner = await signUpOwner();
  const aged = localReport('ri-clock-aged');
  const longAgo = iso(-ROOM_CYCLE_MS - 60_000);
  await atServerTime(longAgo, async () => {
    assert.equal((await firstSave(agedOwner, aged)).status, 200);
    assert.equal((await room(agedOwner)).status, 'processing', 'occupied at the time it was created');
  });
  assert.equal((await identity(agedOwner, aged.id)).report_created_at, longAgo);
  assert.deepEqual(await room(agedOwner), EMPTY_ROOM);
  const next = localReport('ri-clock-next');
  const createdNext = await create(agedOwner, next);
  assert.equal(await identity(agedOwner, aged.id), null, 'the aged-out report was replaced');
  assert.equal((await room(agedOwner)).cycleEndsAt, cycleEnd(createdNext));
});

test('3. the room cycle itself is unchanged: when a report really is past its 24 hours the room is free, and the next upload replaces it', async () => {
  const owner = await signUpOwner();
  const report = localReport('ri-cycle');
  await create(owner, report);
  assert.equal((await save(owner, report)).status, 200);
  assert.equal((await room(owner)).status, 'ready');

  // Time passing, not a save: the stored creation time is now more than a cycle old.
  const aged = iso(-ROOM_CYCLE_MS - 60_000);
  await setReportCreatedAt(client, { deviceKey: owner.deviceKey, id: report.id }, aged);
  assert.deepEqual(await room(owner), EMPTY_ROOM);
  assert.ok(await identity(owner, report.id), 'ageing out deletes nothing by itself');

  // A save of the aged-out report cannot bring it back into its cycle either.
  assert.equal((await save(owner, report, { aiScore: 6, body: { createdAt: iso(0) }, payload: { created: iso(0) } })).status, 200);
  assert.equal((await identity(owner, report.id)).report_created_at, aged);
  assert.equal((await copies(owner, report.id)).created, aged);
  assert.equal((await room(owner)).status, 'empty', 'a save does not restart a finished cycle');

  const next = localReport('ri-cycle-next', { created: iso(0) });
  const createdNext = await create(owner, next);
  assert.equal(await identity(owner, report.id), null, 'the free room accepted a new upload, which replaced the aged-out report');
  assert.deepEqual(await identity(owner, next.id), identityOf(next, createdNext), 'and is stored with its own first-save identity');
  const now = await room(owner);
  assert.equal(now.occupantId, next.id);
  assert.equal(now.cycleEndsAt, cycleEnd(createdNext));
});

// ===========================================================================
// 2. later saves: report_created_at — the lifecycle clock
// ===========================================================================

test('4. a save cannot move the creation time of an existing report — in its row or in the stored report: the room keeps its cycle, a second upload is still refused, and the report is still there', async () => {
  for (const [label, forgedTime] of FORGED_TIMES) {
    const owner = await signUpOwner();
    const report = localReport('ri-time');
    const other = localReport('ri-time-other', { created: iso(0) });
    const createdAt = await create(owner, report);
    const before = await room(owner);
    assert.equal(before.status, 'processing', `${label}: test setup sanity: the room is occupied`);
    assert.equal(before.cycleEndsAt, cycleEnd(createdAt), `${label}: its cycle runs from the report's creation time`);
    assert.equal((await firstSave(owner, other)).status, 409, `${label}: test setup sanity: a second upload into the occupied room is refused`);

    // The AI save of the same report, saying it was created at another time — in the request and in the payload.
    const forged = forgedTime();
    assert.equal((await save(owner, report, { body: { createdAt: forged }, payload: { created: forged } })).status, 200, label);

    assert.deepEqual(await identity(owner, report.id), identityOf(report, createdAt), `${label}: the stored creation time is the first save's`);
    assert.deepEqual(await copies(owner, report.id), { submissionId: report.submissionId, created: createdAt }, `${label}: and so is the stored report's own copy, though this save replaced the payload`);
    const after = await room(owner);
    assert.deepEqual({ ...after, status: null, occupantStatus: null }, { ...before, status: null, occupantStatus: null }, `${label}: the room index and the room occupant are as they were`);
    assert.equal(after.status, 'ready', `${label}: the AI result of that same save landed`);
    assert.equal(after.occupantId, report.id);
    assert.equal(after.occupantCreatedAt, createdAt, `${label}: the served report shows its real creation time`);
    assert.deepEqual(await listed(owner, report.id), { submissionId: report.submissionId, title: report.title, createdAt }, label);

    const second = await firstSave(owner, other);
    assert.equal(second.status, 409, `${label}: the room is still occupied — a second upload is still refused`);
    assert.equal((await second.json()).cycleEndsAt, before.cycleEndsAt, `${label}: with the unchanged end of cycle`);
    assert.ok(await identity(owner, report.id), `${label}: and the first report was not replaced`);
    assert.equal(await identity(owner, other.id), null);
  }
});

// ===========================================================================
// 3. later saves: submission_id and title
// ===========================================================================

test('5. a save cannot give an existing report another submission id — in its row or in the stored report: the list, the room and a lookup by the claimed id are unchanged', async () => {
  const owner = await signUpOwner();
  const report = localReport('ri-ident');
  const createdAt = await create(owner, report);

  // Another account's report, whose reference the first account will claim.
  const stranger = await signUpOwner();
  const theirs = localReport('ri-theirs');
  const theirsCreatedAt = await create(stranger, theirs);

  assert.equal((await save(owner, report, { body: { submissionId: theirs.submissionId }, payload: { submissionId: theirs.submissionId } })).status, 200);

  assert.deepEqual(await identity(owner, report.id), identityOf(report, createdAt), 'the submission id is the first save\'s');
  assert.deepEqual(await copies(owner, report.id), { submissionId: report.submissionId, created: createdAt }, 'and the stored report prints the same one');
  assert.deepEqual(await listed(owner, report.id), { submissionId: report.submissionId, title: report.title, createdAt });
  const holders = await client.execute({ sql: 'SELECT user_id FROM saved_reports WHERE submission_id = ?', args: [theirs.submissionId] });
  assert.deepEqual(holders.rows.map((r) => String(r.user_id)), [stranger.userId], 'a lookup by the claimed submission id still finds only its own report');
  assert.deepEqual(await identity(stranger, theirs.id), identityOf(theirs, theirsCreatedAt), 'and that report is untouched');
  const after = await stored(owner, report.id);
  assert.equal(after.aiStatus, 'ready', 'the AI result of the same save landed');
  assert.equal(after.raw.aiAnalysis?.status, 'complete');

  // Empty and wrongly typed values are refused as before, with nothing written.
  for (const body of [{ title: '' }, { submissionId: '' }, { createdAt: '' }, { title: 42 }]) {
    assert.equal((await save(owner, report, { aiScore: 9, body })).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await identity(owner, report.id), identityOf(report, createdAt));
});

test('6. the title is content and travels with the payload: a save whose report is stored stores its title; once the report is finalized, both are kept', async () => {
  // An ordinary report: the save's payload replaces the stored one, and its title goes with it — the list and the report agree.
  const owner = await signUpOwner();
  const report = localReport('ri-title');
  const createdAt = await create(owner, report);
  const renamed = { ...report, title: 'Second name.docx' };
  assert.equal((await save(owner, renamed)).status, 200);
  assert.deepEqual(await identity(owner, report.id), { ...identityOf(report, createdAt), title: 'Second name.docx' }, 'the title followed the save; the submission id and creation time did not');
  assert.equal((await stored(owner, report.id)).raw.title, 'Second name.docx', 'the stored report carries the same title');
  assert.equal((await listed(owner, report.id)).title, 'Second name.docx');

  // A finalized authoritative report: the stored payload is kept, so its title is kept — the list cannot show a name the report does not carry.
  const finalOwner = await signUpOwner();
  const finalized = localReport('ri-title-final', { wordsCount: 3000 });
  await seedPending(finalOwner, finalized);
  assert.equal((await finalize(finalOwner, finalized.id)).outcome, 'finalized');
  assert.equal((await save(finalOwner, { ...finalized, title: 'Second name.docx' })).status, 200);
  assert.deepEqual(await identity(finalOwner, finalized.id), identityOf(finalized, finalized.created));
  assert.equal((await stored(finalOwner, finalized.id)).raw.title, finalized.title);
  assert.equal((await listed(finalOwner, finalized.id)).title, finalized.title);
});

// ===========================================================================
// 4. the same rule for authoritative reports, pending and finalized
// ===========================================================================

test('7. a pending authoritative report: a save still replaces its content and summary, cannot move its identity or creation time, and the recovery sweep still finds it', async () => {
  const owner = await signUpOwner();
  const first = localReport('ri-pending', { wordsCount: 3000 });
  await seedPending(owner, first);

  // The browser's next save of the same check carries a later archive result — and, forged, another identity and a creation time in 2099.
  const report = { ...first, archiveMatchedPositions: range(350, 499), matchedWordCount: 150, score: 5, archiveScore: 5 };
  const forged = { submissionId: 'FORGED-SUBMISSION', title: 'forged.docx', createdAt: '2099-01-01T00:00:00.000Z' };
  assert.equal((await save(owner, report, { body: forged, payload: { submissionId: forged.submissionId, title: forged.title, created: forged.createdAt } })).status, 200);

  const held = { ...identityOf(first, first.created), title: forged.title };
  assert.deepEqual(await identity(owner, first.id), held, 'the submission id and creation time are the first save\'s; the title went with the stored payload');
  const pending = await stored(owner, first.id);
  assert.equal(pending.raw.selectiveCorpusAuthoritativeStatus, 'pending');
  assert.equal(pending.archiveScore, 5, 'the similarity summary still follows the payload the save stored');
  assert.deepEqual(pending.report.archiveMatchedPositions, range(350, 499), 'and so does the content');
  assert.equal(pending.raw.title, forged.title);
  assert.deepEqual([pending.raw.submissionId, pending.raw.created], [first.submissionId, first.created], 'but the stored report\'s identity copies are the row\'s, not the save\'s');
  assert.equal(pending.aiStatus, 'ready');

  // The sweep's age check reads the stored creation time: a report "created in 2099" would never be old enough.
  const claimed = await sweep();
  assert.ok(claimed.some((c) => String(c.reportId) === first.id), 'the pending report is still claimed for recovery');

  assert.deepEqual(await finalize(owner, first.id), { outcome: 'finalized', status: 'completed' });
  assert.deepEqual(await identity(owner, first.id), held, 'the finalizer leaves all three alone');
});

test('8. a creation time in the future cannot keep a pending report out of the recovery sweep — claimed by its first save, and again by a later one', async () => {
  // The upload says "created in 2099". The server stores its own time: here, twenty minutes ago.
  const owner = await signUpOwner();
  const report = localReport('ri-sweep', { created: '2099-01-01T00:00:00.000Z', wordsCount: 3000 });
  const at = iso(-20 * 60 * 1000);
  await atServerTime(at, async () => assert.equal((await firstSave(owner, report)).status, 200));
  assert.equal((await identity(owner, report.id)).report_created_at, at);
  // Its deferred finalizer never ran: the row is still pending (the marker a first save in authoritative mode stores).
  await client.execute({
    sql: `UPDATE saved_reports SET payload_json = json_set(payload_json, '$.selectiveCorpusAuthoritativeStatus', 'pending') WHERE device_key = ? AND id = ?`,
    args: [owner.deviceKey, report.id],
  });
  assert.equal((await save(owner, report)).status, 200, 'and a later save says 2099 again');
  assert.deepEqual(await identity(owner, report.id), identityOf(report, at));
  const pending = await stored(owner, report.id);
  assert.equal(pending.raw.selectiveCorpusAuthoritativeStatus, 'pending');
  assert.equal(pending.raw.created, at);

  const claimed = await sweep();
  assert.ok(claimed.some((c) => String(c.reportId) === report.id), 'a pending report twenty minutes old is claimed for recovery');

  // The age check is real: a pending report the server created this moment is not old enough.
  const freshOwner = await signUpOwner();
  const fresh = localReport('ri-sweep-fresh', { created: iso(-3 * DAY), wordsCount: 3000 });
  await create(freshOwner, fresh);
  await client.execute({
    sql: `UPDATE saved_reports SET payload_json = json_set(payload_json, '$.selectiveCorpusAuthoritativeStatus', 'pending') WHERE device_key = ? AND id = ?`,
    args: [freshOwner.deviceKey, fresh.id],
  });
  assert.equal((await sweep()).some((c) => String(c.reportId) === fresh.id), false, 'a report that only SAYS it is three days old is not swept early');
});

test('9. a finalized authoritative report: the AI save lands, and neither its identity, its creation time nor its similarity can be moved by it', async () => {
  const owner = await signUpOwner();
  const report = localReport('ri-final', { wordsCount: 3000 });
  await seedPending(owner, report);
  assert.equal((await finalize(owner, report.id)).outcome, 'finalized');
  const before = await stored(owner, report.id);
  const roomBefore = await room(owner);
  assert.equal(before.raw.selectiveCorpusAuthoritativeStatus, 'completed');
  assert.equal(before.report.unifiedSimilarity.unifiedScore, 2, 'test setup sanity: 60 of 3,000 words');

  for (const [label, forgedTime] of FORGED_TIMES) {
    const forged = forgedTime();
    assert.equal((await save(owner, report, {
      aiScore: 7,
      body: { createdAt: forged, submissionId: 'FORGED-SUBMISSION', title: 'forged.docx', archiveScore: 99, scoreBand: 'High' },
      payload: { created: forged, submissionId: 'FORGED-SUBMISSION', title: 'forged.docx' },
    })).status, 200, label);
    assert.deepEqual(await identity(owner, report.id), identityOf(report, report.created), label);
    const after = await stored(owner, report.id);
    assert.deepEqual(after.report.unifiedSimilarity, before.report.unifiedSimilarity, `${label}: the stored similarity`);
    assert.deepEqual([after.raw.submissionId, after.raw.title, after.raw.created], [report.submissionId, report.title, report.created], `${label}: the stored report's own copies`);
    assert.deepEqual([after.archiveScore, after.scoreBand], [before.archiveScore, before.scoreBand], `${label}: the flat similarity summary`);
    assert.equal(after.aiStatus, 'ready', label);
    assert.equal(after.aiScore, 7, label);
    const roomAfter = await room(owner);
    assert.deepEqual({ ...roomAfter, status: null, occupantStatus: null }, { ...roomBefore, status: null, occupantStatus: null }, `${label}: the room and its cycle`);
  }
  const second = await firstSave(owner, localReport('ri-final-other', { created: iso(0) }));
  assert.equal(second.status, 409, 'the room is still occupied');
});

// ===========================================================================
// 5. what is unchanged: an ordinary re-analysis, ownership, deletion
// ===========================================================================

test('10. an ordinary save after the first still re-analyses the report, and repeating it changes nothing about the identity', async () => {
  const owner = await signUpOwner();
  const report = localReport('ri-first', { wordsCount: 3000, created: iso(-5 * 60 * 1000) });
  const createdAt = await create(owner, report);
  assert.equal((await stored(owner, report.id)).report.unifiedSimilarity.unifiedScore, 0);

  // A legitimate re-analysis: new archive evidence, the same report.
  const reanalysed = { ...report, archiveMatchedPositions: range(0, 599), matchedWordCount: 600, score: 20, archiveScore: 20, scoreBand: 'Moderate' };
  assert.equal((await save(owner, reanalysed)).status, 200);
  const after = await stored(owner, report.id);
  assert.equal(after.report.unifiedSimilarity.unifiedScore, 20, 'the score moved: 600 of 3,000 words');
  assert.deepEqual([after.archiveScore, after.scoreBand], [20, 'Moderate'], 'and the flat similarity summary with it');
  assert.deepEqual(await identity(owner, report.id), identityOf(report, createdAt), 'the identity did not');
  assert.deepEqual(await copies(owner, report.id), { submissionId: report.submissionId, created: createdAt });

  // The same save repeated: nothing about the identity depends on how often it is sent.
  assert.equal((await save(owner, reanalysed)).status, 200);
  assert.deepEqual(await identity(owner, report.id), identityOf(report, createdAt));
  assert.deepEqual(await copies(owner, report.id), { submissionId: report.submissionId, created: createdAt });
});

test('11. ownership and deletion are as before: another account cannot save over the report, and its owner can still delete it', async () => {
  const owner = await signUpOwner();
  const report = localReport('ri-owned');
  const createdAt = await create(owner, report);

  const stranger = await signUpOwner();
  const hijack = await save({ ...stranger, deviceKey: owner.deviceKey }, report, { body: { title: 'taken.docx', submissionId: 'taken', createdAt: iso(-3 * DAY) } });
  assert.equal(hijack.status, 404, 'a save of someone else\'s report is refused as before');
  assert.deepEqual(await identity(owner, report.id), identityOf(report, createdAt));
  const ownerId = await client.execute({ sql: 'SELECT user_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [owner.deviceKey, report.id] });
  assert.equal(String(ownerId.rows[0].user_id), owner.userId);

  requests += 1;
  await resetRateForTest(`${owner.tag}-del-${requests}`);
  const deleted = await reportIdRoute.DELETE(
    new Request(`http://localhost/api/reports/${report.id}`, { method: 'DELETE', headers: { 'x-forwarded-for': `${owner.tag}-del-${requests}`, cookie: `tp_session_v1=${owner.cookie}` } }),
    { params: Promise.resolve({ id: report.id }) },
  );
  assert.equal(deleted.status, 200);
  assert.equal(await identity(owner, report.id), null);
  assert.equal((await room(owner)).status, 'empty');
});

// ===========================================================================
// 6. the rule is part of the write itself
// ===========================================================================

test('12. the upsert writes submission id and creation time on insert and never on conflict, and re-pins the stored report\'s copies of them — for an ordinary, a pending and a finalized row; the title goes with the payload it stores', async () => {
  // The statement as the route runs it: `over` is what a save CLAIMS, in its columns and in the report it carries.
  const args = (owner, report, over = {}) => [
    report.id, owner.deviceKey, over.submissionId ?? report.submissionId, over.title ?? report.title, over.createdAt ?? report.created,
    report.wordCount, 0, 'Low', 7, 'low', 'ready',
    JSON.stringify({ ...report, submissionId: over.submissionId ?? report.submissionId, title: over.title ?? report.title, created: over.createdAt ?? report.created, aiScore: 7, aiAnalysis: completeAiAnalysis() }),
    owner.userId, 0,
  ];
  const forged = { submissionId: 'FORGED-SUBMISSION', title: 'forged.docx', createdAt: '2001-01-01T00:00:00.000Z' };
  const rawCopies = async (owner, id) => { const { raw } = await stored(owner, id); return [raw.submissionId, raw.title, raw.created]; };

  // Insert: no row yet, so the statement's values are stored (the route passes the server's time).
  const owner = await signUpOwner();
  const inserted = localReport('ri-sql-insert');
  await client.execute({ sql: reportsRoute.SAVE_REPORT_SQL, args: args(owner, inserted) });
  assert.deepEqual(await identity(owner, inserted.id), identityOf(inserted, inserted.created));
  // Conflict on that ordinary row.
  await client.execute({ sql: reportsRoute.SAVE_REPORT_SQL, args: args(owner, inserted, forged) });
  assert.deepEqual(await identity(owner, inserted.id), { ...identityOf(inserted, inserted.created), title: forged.title }, 'ordinary row: its payload is replaced, and the title with it');
  assert.deepEqual(await rawCopies(owner, inserted.id), [inserted.submissionId, forged.title, inserted.created], 'the replaced payload carries the row\'s submission id and creation time, not the ones it arrived with');
  assert.equal((await stored(owner, inserted.id)).aiScore, 7, 'the rest of the statement still applied');

  const pendingOwner = await signUpOwner();
  const pending = localReport('ri-sql-pending', { wordsCount: 3000 });
  await seedPending(pendingOwner, pending);
  await client.execute({ sql: reportsRoute.SAVE_REPORT_SQL, args: args(pendingOwner, pending, forged) });
  assert.deepEqual(await identity(pendingOwner, pending.id), { ...identityOf(pending, pending.created), title: forged.title }, 'pending row: the same');
  assert.deepEqual(await rawCopies(pendingOwner, pending.id), [pending.submissionId, forged.title, pending.created]);

  const finalOwner = await signUpOwner();
  const finalized = localReport('ri-sql-final', { wordsCount: 3000 });
  await seedPending(finalOwner, finalized);
  assert.equal((await finalize(finalOwner, finalized.id)).outcome, 'finalized');
  await client.execute({ sql: reportsRoute.SAVE_REPORT_SQL, args: args(finalOwner, finalized, forged) });
  assert.deepEqual(await identity(finalOwner, finalized.id), identityOf(finalized, finalized.created), 'finalized row: its payload is kept, and all three with it');
  assert.deepEqual(await rawCopies(finalOwner, finalized.id), [finalized.submissionId, finalized.title, finalized.created]);

  // A legacy anonymous row claimed by a save keeps its own identity and age; only its owner is set.
  const legacy = localReport('ri-sql-legacy', { created: iso(-40 * DAY) });
  const claimer = await signUpOwner();
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json) VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [legacy.id, claimer.deviceKey, legacy.submissionId, legacy.title, legacy.created, legacy.wordCount, 0, 'Low', JSON.stringify(legacy)],
  });
  assert.equal((await save(claimer, { ...legacy, title: 'claimed.docx' }, { body: { createdAt: iso(0), submissionId: 'claimed-submission' }, payload: { created: iso(0), submissionId: 'claimed-submission' } })).status, 200);
  assert.deepEqual(await identity(claimer, legacy.id), { ...identityOf(legacy, legacy.created), title: 'claimed.docx' }, 'a claimed legacy report takes the claimant\'s content and is not made to look new');
  assert.deepEqual(await rawCopies(claimer, legacy.id), [legacy.submissionId, 'claimed.docx', legacy.created]);
  const claimed = await client.execute({ sql: 'SELECT user_id, room_number FROM saved_reports WHERE device_key = ? AND id = ?', args: [claimer.deviceKey, legacy.id] });
  assert.equal(String(claimed.rows[0].user_id), claimer.userId, 'the claim itself still happens');
  assert.equal(claimed.rows[0].room_number, null);
});
