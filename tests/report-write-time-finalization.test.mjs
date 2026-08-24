import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { canonicalSha256 } from '../lib/document-identity.ts';
import { runCorpusAdmissionPromotionSweep } from '../lib/corpus-admission-promotion.ts';
import { findRoomOccupant } from '../lib/reports-repo.ts';

/**
 * Release-hardening audit finding SIM-03: the required end-to-end
 * regression test — promotes a real document into the corpus, has a
 * different, consenting account upload the identical text through the
 * REAL app/api/reports/route.ts POST handler (never a synthetic DB insert),
 * and proves every one of the write-time-finalization guarantees against
 * the real routes: the room card and the report-detail server render both
 * show the resolved 100% on their very FIRST read (no flash, no
 * "Calculating similarity…"), archive_score stays exactly 0 (the true
 * archive-only value — nothing in this fixture ever matched the archive),
 * a reload/reopen never re-invokes the matcher, and concurrent finalization
 * converges to one consistent, correct persisted result rather than
 * corrupting into two.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_write_time_finalization.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';

const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, drizzleDir);
const openConnection = () => createClient({ url: `file:${dbFile}` });

test.after(() => {
  client.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
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

async function insertDecision(hash) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      id, null, `write-time-finalization-${randomUUID()}`, 'v1', 'ACCEPT', '[]', 1, '[]',
      'txt', 200, 'English', 0.95, hash, 'v1', null, 80, 'v1',
      '{}', '{}', 'v1', 0.9, 'v1', 'NONE', null, null,
      JSON.stringify({ kind: 'PER_USER_CONSENT', consented: true }), 0,
    ],
  });
  return id;
}

/** "Promote document A into the corpus" — an admin-accepted, promoted representation, no account/submission reference of its own, matching lib/user-submission-matching.ts's TURNITPLUS_CORPUS_SOURCE convention and every other test file in this codebase that promotes a source. */
async function promoteDocumentIntoCorpus(text) {
  const hash = canonicalSha256(text);
  const decisionId = await insertDecision(hash);
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, 200, 'v1'],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, text, 'v1', 'LICENSED_REUSE'],
  });
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome?.outcome, 'indexed', 'test setup sanity: promotion must succeed');
}

let userCounter = 0;
/** A real, signed-up, corpus-reuse-consenting account — "a different consenting account" from the (anonymous) admin promotion above. */
async function signUpConsentingAccount() {
  userCounter += 1;
  const email = `write-time-finalization-user-${userCounter}@example.test`;
  await resetAuthRateForTest('write-time-finalization-signup-' + userCounter);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'write-time-finalization-signup-' + userCounter },
    body: JSON.stringify({ email, password: 'write-time-finalization-pw-1', username: `wtfuser${userCounter}`, deviceKey: `write-time-finalization-device-${userCounter}` }),
  });
  const res = await signupRoute.POST(req);
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = extractCookie(res);
  const row = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  const userId = row.rows[0].id;
  // Consent is granted directly (there is no dedicated HTTP endpoint for
  // it in this product) — mirrors this exact session's own earlier,
  // established verification method for granting corpus-reuse consent.
  await client.execute({ sql: "UPDATE users SET corpus_reuse_consented_at = CURRENT_TIMESTAMP WHERE id = ?", args: [userId] });
  return { userId, deviceKey: `write-time-finalization-device-${userCounter}`, cookie, tag: `write-time-finalization-${userCounter}` };
}

async function postReport(account, { id, room, aiStatus, aiScore, text = DOCUMENT_A_TEXT, wordCount = DOCUMENT_A_WORD_COUNT, archiveScore = 0 }) {
  await resetRateForTest(account.tag + '-post');
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post', cookie: `tp_session_v1=${account.cookie}` },
    body: JSON.stringify({
      deviceKey: account.deviceKey,
      id,
      submissionId: 'sub-' + id,
      title: 'Write-time finalization fixture',
      createdAt: new Date().toISOString(),
      wordCount,
      archiveScore,
      scoreBand: 'Low',
      aiScore: aiScore ?? null,
      aiTone: aiScore !== undefined ? 'low' : null,
      aiStatus,
      room,
      payload: {
        version: 11, id, submissionId: 'sub-' + id, title: 'Write-time finalization fixture',
        author: '', assignment: '', created: new Date().toISOString(),
        score: archiveScore, archiveScore, wordCount,
        scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [], text,
      },
    }),
  });
  return reportsRoute.POST(req);
}

async function getReportDetail(account, id) {
  await resetReadRateForTest(account.tag + '-get');
  const req = new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(account.deviceKey)}`, {
    headers: { 'x-forwarded-for': account.tag + '-get', cookie: `tp_session_v1=${account.cookie}` },
  });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id: String(id) }) });
}

async function snapshotRow(deviceKey, id) {
  const result = await client.execute({
    sql: 'SELECT computed_at, corpus_generation FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?',
    args: [deviceKey, id],
  });
  return result.rows[0] ?? null;
}

async function savedReportRow(deviceKey, id) {
  const result = await client.execute({ sql: 'SELECT archive_score, payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, id] });
  const row = result.rows[0];
  return { archiveScore: Number(row.archive_score), payload: JSON.parse(row.payload_json) };
}

function withEnv(name, value, fn) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

// A real document — long enough to be realistic, distinctive enough not to
// cross-contaminate with any other test file's own promoted fixtures
// (matchAgainstUserSubmissionCorpus does a real global shingle search).
const DOCUMENT_A_TEXT =
  'Astrophysicists analyzing gravitational-wave signals from a rare intermediate-mass black hole merger identified an unexpected precession pattern in the orbital plane, ' +
  'suggesting the progenitor system formed through a dynamical capture event in a dense stellar cluster rather than through isolated binary evolution, a distinction that ' +
  'carries direct implications for how future observatories should weight competing formation-channel models when interpreting the next generation of detections.';
const DOCUMENT_A_WORD_COUNT = 80;

test('SIM-03 END-TO-END: promoted document, different consenting account, real POST/GET routes — room card and detail both show 100% on first read, archive_score stays 0, reload never re-matches, room-list never matches, concurrent finalization converges to one correct result', async (t) => {
  await promoteDocumentIntoCorpus(DOCUMENT_A_TEXT);
  const account = await signUpConsentingAccount();
  const reportId = 'write-time-finalization-report-1';

  await t.test('first save (processing) already finalizes the combined result — the report-generation pipeline itself, not a later resave', async () => {
    const res = await postReport(account, { id: reportId, room: 0, aiStatus: 'processing' });
    assert.equal(res.status, 200, 'test setup sanity: first save must succeed');
    const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(archiveScore, 0, 'archive_score must be exactly the archive-only value submitted — never overwritten');
    assert.ok(payload.unifiedSimilarity, 'unifiedSimilarity must already be persisted after the very first save');
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, 'the promoted TURNITPLUS_CORPUS_SOURCE match must already be reflected — finalization does not wait for AI completion');
  });

  const firstSnapshot = await snapshotRow(account.deviceKey, reportId);
  assert.ok(firstSnapshot, 'the historical-match snapshot must be written as a real side effect of finalization');

  await t.test('the AI-completion resave (report/room reaching "ready") reuses the cached snapshot — no second real matcher search, no regression of the persisted result', async () => {
    const res = await postReport(account, { id: reportId, room: 0, aiStatus: 'ready', aiScore: 3 });
    assert.equal(res.status, 200);
    const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(archiveScore, 0, 'archive_score must still be exactly 0 after the resave');
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, 'the resave must not regress the already-finalized combined result back to a partial/client-side value');

    const snapshotAfterResave = await snapshotRow(account.deviceKey, reportId);
    assert.equal(snapshotAfterResave.computed_at, firstSnapshot.computed_at, 'the resave\'s own finalization call must be a cache hit — the snapshot row must not have been recomputed/rewritten');
  });

  await t.test("REQUIRED: the room card's first render is 100%, and archive_score remains the original archive-only value", async () => {
    const occupant = await findRoomOccupant(client, account.userId, 0);
    assert.equal(occupant.status, 'ready');
    assert.equal(occupant.report.archiveScore, 0, 'REQUIRED: archive_score must remain its original archive-only value');
    assert.equal(occupant.report.primaryScore, 100, 'REQUIRED: the room card\'s first render must be 100%');
    assert.equal(occupant.report.isUnified, true);
  });

  await t.test("REQUIRED: the report detail's first server render is 100% — findReportRowForUser's own raw row already carries it, exactly what app/reports/[id]/page.tsx's Server Component reads", async () => {
    // Mirrors app/reports/[id]/page.tsx's loadOwnedReport exactly (see that
    // file — it cannot be rendered directly here, outside a real Next.js
    // request scope, but it does nothing more than this same row read):
    // JSON.parse(row.payload_json) IS initialReport, with no enrichment
    // step in between. If unifiedSimilarity is already 100% right here, the
    // Server Component's first response necessarily contains it too.
    const { payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, "REQUIRED: the report detail's first server render must be 100%, straight from the saved row, before any client fetch");
  });

  await t.test('REQUIRED: opening/reloading the report via the real GET route does not invoke the matcher again', async () => {
    const before = await snapshotRow(account.deviceKey, reportId);
    const res = await getReportDetail(account, reportId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.payload.unifiedSimilarity.unifiedScore, 100, 'the GET route must still return 100%');
    const after = await snapshotRow(account.deviceKey, reportId);
    assert.equal(after.computed_at, before.computed_at, 'REQUIRED: opening/reloading must not invoke the matcher again — the snapshot must not be recomputed');

    // Reload once more — "no later client request changes 0% to 100%"
    // (there is nothing left to change; it was never 0% to begin with).
    const res2 = await getReportDetail(account, reportId);
    const body2 = await res2.json();
    assert.equal(body2.payload.unifiedSimilarity.unifiedScore, 100, 'REQUIRED: no later client request may ever change the score — it must already be 100% and stay 100%');
    const after2 = await snapshotRow(account.deviceKey, reportId);
    assert.equal(after2.computed_at, before.computed_at, 'a second reload must still be a pure cache hit');
  });

  await t.test('REQUIRED: room-list loading (findRoomOccupant for a different, empty room) never invokes matching', async () => {
    const snapshotCountBefore = (await client.execute('SELECT COUNT(*) AS n FROM report_historical_match_snapshots')).rows[0].n;
    const emptyRoomOccupant = await findRoomOccupant(client, account.userId, 1);
    assert.equal(emptyRoomOccupant.status, 'empty');
    const occupiedRoomOccupant = await findRoomOccupant(client, account.userId, 0);
    assert.equal(occupiedRoomOccupant.report.primaryScore, 100);
    const snapshotCountAfter = (await client.execute('SELECT COUNT(*) AS n FROM report_historical_match_snapshots')).rows[0].n;
    assert.equal(Number(snapshotCountAfter), Number(snapshotCountBefore), 'REQUIRED: reading the room list must never create/update a snapshot row — findRoomOccupant does no matching, only a plain SQL read');
  });

  await t.test('REQUIRED: concurrent finalization performs one effective computation/write — a second report, saved via two racing POSTs, converges to one correct persisted result, never a corrupted/inconsistent one', async () => {
    const concurrentReportId = 'write-time-finalization-report-concurrent';
    const [res1, res2] = await Promise.all([
      postReport(account, { id: concurrentReportId, room: 1, aiStatus: 'processing' }),
      // A genuine race for the SAME (device_key, id): the second "request"
      // targets the identical row, exactly as two browser tabs/a retry
      // racing the same save would. insertReportWithRoomCheck's own
      // busy-retry loop (app/api/reports/route.ts) already serializes the
      // room-occupancy+insert step; this proves finalization survives that
      // same real race without corrupting into two different stored
      // results.
      postReport(account, { id: concurrentReportId, room: 1, aiStatus: 'processing' }),
    ]);
    assert.ok([res1.status, res2.status].every((s) => s === 200 || s === 409), `both concurrent saves must resolve cleanly (200 or a genuine 409 room conflict), got ${res1.status} and ${res2.status}`);

    const rows = await client.execute({
      sql: 'SELECT COUNT(*) AS n FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?',
      args: [account.deviceKey, concurrentReportId],
    });
    assert.equal(Number(rows.rows[0].n), 1, 'exactly one snapshot row must exist for this report — never two, never zero, regardless of the race');

    const successfulSave = res1.status === 200 ? res1 : res2;
    void successfulSave;
    const { archiveScore, payload } = await savedReportRow(account.deviceKey, concurrentReportId);
    assert.equal(archiveScore, 0);
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, 'the converged, persisted result must still be the correct one — not a partial/inconsistent value from a mid-race read');
  });
});

// --- SIM-04: generation freshness, live flag rollback, the save-never-fails
// guarantee, and the SQL-level concurrency guard — the two gaps caught
// before commit in the SIM-03 architecture above, plus the three properties
// the fix must not have broken along the way. ---------------------------

const DOCUMENT_B_TEXT =
  'Malacologists surveying freshwater mussel beds along a regulated river reach linked a decline in juvenile recruitment to altered flow regimes below a hydroelectric dam, ' +
  'with host-fish passage restrictions compounding the effect during the mussels\' brief larval attachment window each spring.';
const DOCUMENT_B_WORD_COUNT = 60;

test('SIM-04: generation freshness — a report finalized before a matching source was promoted reads as "stale" everywhere, never the old archive-only number pretending to be final, until the detail route recomputes and persists, at which point room and detail agree again', async (t) => {
  const account = await signUpConsentingAccount();
  const reportId = 'sim04-generation-freshness-report';

  await t.test('first save finalizes archive-only — nothing is promoted yet', async () => {
    const res = await postReport(account, { id: reportId, room: 2, aiStatus: 'ready', aiScore: 4, text: DOCUMENT_B_TEXT, wordCount: DOCUMENT_B_WORD_COUNT });
    assert.equal(res.status, 200);
    const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(archiveScore, 0);
    assert.equal(payload.unifiedSimilarity.unifiedScore, 0, 'test setup sanity: no corpus source exists yet, so this must genuinely settle at 0, not a stale leftover');
  });

  const snapshotBeforePromotion = await snapshotRow(account.deviceKey, reportId);
  assert.ok(snapshotBeforePromotion);

  await t.test('promoting a source matching this exact report AFTER finalization bumps the generation — the room card must now show "stale," never trust the old persisted 0 as final, and must not run the matcher itself', async () => {
    await promoteDocumentIntoCorpus(DOCUMENT_B_TEXT);

    const occupant = await findRoomOccupant(client, account.userId, 2);
    assert.equal(occupant.report.similarityStatus, 'stale', 'a moved-on generation must be reported as stale, not resolved');
    assert.equal(occupant.report.primaryScore, 0, 'must fall back to the archive-only score — never a preview of the not-yet-recomputed new match');
    assert.equal(occupant.report.isUnified, false);
    assert.equal(occupant.report.archiveScore, 0);

    const snapshotAfterRoomRead = await snapshotRow(account.deviceKey, reportId);
    assert.equal(snapshotAfterRoomRead.computed_at, snapshotBeforePromotion.computed_at, 'REQUIRED: the room card itself must never trigger the expensive matcher, even when it detects staleness');

    const { payload: stillStored } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(stillStored.unifiedSimilarity.unifiedScore, 0, 'the persisted payload itself must be untouched by a mere room-card read');
  });

  await t.test('opening the report detail recomputes exactly once (a real cache miss, since the generation moved on) and persists the refreshed result', async () => {
    const before = await snapshotRow(account.deviceKey, reportId);
    const res = await getReportDetail(account, reportId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.payload.unifiedSimilarity.unifiedScore, 100, 'the detail route must recompute and reflect the newly promoted match');

    const after = await snapshotRow(account.deviceKey, reportId);
    assert.notEqual(after.computed_at, before.computed_at, 'a genuinely stale generation must trigger exactly one real recompute');

    const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(archiveScore, 0, 'archive_score must stay untouched throughout');
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, 'REQUIRED: after the resolver recomputes, the refreshed result must be persisted');

    // A second detail open must be a pure cache hit — the matcher runs
    // exactly once per current snapshot, not once per read.
    const res2 = await getReportDetail(account, reportId);
    const body2 = await res2.json();
    assert.equal(body2.payload.unifiedSimilarity.unifiedScore, 100);
    const after2 = await snapshotRow(account.deviceKey, reportId);
    assert.equal(after2.computed_at, after.computed_at, 'REQUIRED: a second open must not recompute again');
  });

  await t.test('REQUIRED: room and detail now agree — the room card reflects the freshly persisted result without any recompute of its own', async () => {
    const before = await snapshotRow(account.deviceKey, reportId);
    const occupant = await findRoomOccupant(client, account.userId, 2);
    assert.equal(occupant.report.similarityStatus, 'resolved');
    assert.equal(occupant.report.primaryScore, 100);
    assert.equal(occupant.report.isUnified, true);
    const after = await snapshotRow(account.deviceKey, reportId);
    assert.equal(after.computed_at, before.computed_at, 'the room card itself still never recomputes anything');
  });
});

const DOCUMENT_C_TEXT =
  'Speleologists mapping a newly discovered limestone cave system documented a previously unrecorded population of blind cave fish isolated in a deep, oxygen-poor pool.';
const DOCUMENT_C_WORD_COUNT = 70;

test('SIM-04: live flag rollback — a persisted corpus-enabled result immediately reads as archive-only on both room and detail once CORPUS_SOURCE_MATCHING_ENABLED is off, without the room card\'s own SQL read ever bypassing that live filter, and turning the flag back on restores the unified result without corrupting archive_score', async (t) => {
  await promoteDocumentIntoCorpus(DOCUMENT_C_TEXT);
  const account = await signUpConsentingAccount();
  const reportId = 'sim04-flag-rollback-report';

  await t.test('saved with the flag on — a real corpus-enabled unified result is persisted', async () => {
    const res = await postReport(account, { id: reportId, room: 3, aiStatus: 'ready', aiScore: 2, text: DOCUMENT_C_TEXT, wordCount: DOCUMENT_C_WORD_COUNT });
    assert.equal(res.status, 200);
    const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(archiveScore, 0);
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, 'test setup sanity');
    assert.equal(payload.corpusSourceMatchingEnabledAtComputation, true);
  });

  await withEnv('CORPUS_SOURCE_MATCHING_ENABLED', 'false', async () => {
    await t.test('REQUIRED: with the flag off, the room card immediately shows the archive-only score, without ever mutating the still-corpus-enabled persisted payload', async () => {
      const occupant = await findRoomOccupant(client, account.userId, 3);
      assert.equal(occupant.report.similarityStatus, 'resolved', 'a rollback is immediately, deterministically correct — no "updating" wait needed');
      assert.equal(occupant.report.primaryScore, 0, 'REQUIRED: the room card must show the archive-only score, not the stale corpus-inflated 100');
      assert.equal(occupant.report.isUnified, false);
      assert.equal(occupant.report.archiveScore, 0);

      // Proves the room's own direct SQL extraction did not bypass live
      // flag filtering by accident of storage having already changed —
      // storage is still exactly what the flag-on save persisted.
      const { payload: stillStored } = await savedReportRow(account.deviceKey, reportId);
      assert.equal(stillStored.unifiedSimilarity.unifiedScore, 100, 'the raw persisted payload must be untouched by a mere room-card read — the live filter is applied at the display layer, never by mutating storage');
    });

    await t.test('REQUIRED: with the flag off, the report detail also immediately shows the archive-only score', async () => {
      const res = await getReportDetail(account, reportId);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.payload.unifiedSimilarity.unifiedScore, 0, 'the detail route recomputes fresh under the live flag — corpus contribution excluded');
      assert.equal(body.payload.corpusSourceMatchingEnabledAtComputation, false);

      const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
      assert.equal(archiveScore, 0, 'archive_score must never be corrupted by the flag going off');
      assert.equal(payload.unifiedSimilarity.unifiedScore, 0, 'the detail route\'s own recompute is persisted — this is expected self-healing, not a bug');
    });

    await t.test('a second room-card read after the detail route\'s self-heal still agrees, now as a genuinely resolved (not merely archive-only-fallback) result', async () => {
      const occupant = await findRoomOccupant(client, account.userId, 3);
      assert.equal(occupant.report.similarityStatus, 'resolved');
      assert.equal(occupant.report.primaryScore, 0);
      assert.equal(occupant.report.isUnified, true, 'now a real resolved computation under the current flag, not just an archive-only fallback');
    });
  });

  await t.test('REQUIRED: turning the flag back on restores the unified result on both surfaces, and archive_score is still untouched throughout', async () => {
    const preRestoreOccupant = await findRoomOccupant(client, account.userId, 3);
    assert.equal(preRestoreOccupant.report.similarityStatus, 'stale', 'a roll-forward is never deterministic — must show updating, not silently reuse the old off-value');

    const res = await getReportDetail(account, reportId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.payload.unifiedSimilarity.unifiedScore, 100, 'REQUIRED: turning the flag back on must restore the unified result');

    const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(archiveScore, 0, 'REQUIRED: archive_score must never be corrupted by the flag going off and back on');
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100);

    const occupant = await findRoomOccupant(client, account.userId, 3);
    assert.equal(occupant.report.similarityStatus, 'resolved');
    assert.equal(occupant.report.primaryScore, 100);
    assert.equal(occupant.report.isUnified, true);
    assert.equal(occupant.report.archiveScore, 0);
  });
});

test('SIM-04: a report saved with no text at all (finalization never even attempted) still saves successfully and reads as "pending" with the real archive score — never a false 0%', async () => {
  const account = await signUpConsentingAccount();
  const reportId = 'sim04-no-text-report';
  await resetRateForTest(account.tag + '-post');
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post', cookie: `tp_session_v1=${account.cookie}` },
    body: JSON.stringify({
      deviceKey: account.deviceKey, id: reportId, submissionId: 'sub-' + reportId, title: 'No-text fixture',
      createdAt: new Date().toISOString(), wordCount: 40, archiveScore: 42, scoreBand: 'Low',
      aiScore: null, aiTone: null, aiStatus: 'ready', room: 4,
      payload: {
        version: 11, id: reportId, submissionId: 'sub-' + reportId, title: 'No-text fixture',
        author: '', assignment: '', created: new Date().toISOString(),
        score: 42, archiveScore: 42, wordCount: 40, scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [],
        // No `text` field at all — the real shape of a legacy report saved
        // before text capture existed, and the same gate
        // (isNonEmptyString(reportPayload?.text)) a genuine finalization
        // timeout/crash leaves behind: finalization is skipped entirely.
      },
    }),
  });
  const res = await reportsRoute.POST(req);
  assert.equal(res.status, 200, 'REQUIRED: a report with no text must still save successfully — finalization is simply skipped, never a hard failure');

  const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
  assert.equal(archiveScore, 42);
  assert.equal(payload.unifiedSimilarity, undefined, 'finalization must never have run — no text to finalize');

  const occupant = await findRoomOccupant(client, account.userId, 4);
  assert.equal(occupant.report.similarityStatus, 'pending', 'must show a neutral pending state, never a resolved value it never actually computed');
  assert.equal(occupant.report.primaryScore, 42, 'REQUIRED: must be the real archive score — never a false 0%, even though it was never unified');
  assert.equal(occupant.report.isUnified, false);
});

test('SIM-04: SAVE_REPORT_SQL\'s generation guard never lets an older-generation resave overwrite a newer-generation one, regardless of which write commits last', async () => {
  const account = await signUpConsentingAccount();
  const reportId = 'sim04-generation-guard-report';
  const res = await postReport(account, { id: reportId, room: 5, aiStatus: 'processing' });
  assert.equal(res.status, 200, 'test setup sanity: an initial real save must succeed before exercising the guard directly');

  const rawArgs = (unifiedScore, generation) => [
    reportId, account.deviceKey, 'sub-' + reportId, 'Generation guard fixture', new Date().toISOString(),
    DOCUMENT_A_WORD_COUNT, 0, 'Low', null, null, 'processing',
    JSON.stringify({ unifiedSimilarity: { unifiedScore }, unifiedSimilarityGeneration: generation }),
    account.userId, 5,
  ];

  // The HIGHER-generation write lands FIRST (e.g. a fast request that read
  // corpus_match_generation after a promotion)...
  await client.execute({ sql: reportsRoute.SAVE_REPORT_SQL, args: rawArgs(77, 9000) });
  // ...then a LOWER-generation write arrives SECOND (a slower request that
  // read the generation BEFORE that same promotion, but whose transaction
  // simply took longer to commit) — it must not be allowed to regress the
  // already-newer persisted result.
  await client.execute({ sql: reportsRoute.SAVE_REPORT_SQL, args: rawArgs(11, 4000) });

  const { payload } = await savedReportRow(account.deviceKey, reportId);
  assert.equal(payload.unifiedSimilarityGeneration, 9000, 'REQUIRED: a lower-generation write must never regress an already-persisted higher-generation result');
  assert.equal(payload.unifiedSimilarity.unifiedScore, 77);

  // The guard is a floor, not a freeze: a genuinely newer generation
  // arriving afterward must still be accepted normally.
  await client.execute({ sql: reportsRoute.SAVE_REPORT_SQL, args: rawArgs(55, 9500) });
  const { payload: latest } = await savedReportRow(account.deviceKey, reportId);
  assert.equal(latest.unifiedSimilarityGeneration, 9500, 'a genuinely newer generation must still be accepted normally');
  assert.equal(latest.unifiedSimilarity.unifiedScore, 55);
});
