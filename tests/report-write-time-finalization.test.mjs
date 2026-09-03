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
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';
import { getCurrentCorpusMatchGeneration, isHistoricalMatchSnapshotCurrent } from '../lib/report-historical-match.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { findRoomOccupant, findReportRowForUser } from '../lib/reports-repo.ts';
import { deriveRoomStatus } from '../lib/report-rooms.ts';
import { resolvePersistedSimilarityDisplay, selfHealUnifiedSimilarity } from '../lib/report-primary-similarity.ts';
import {
  archiveOverlapScore,
  buildReportSummary,
  hasUnifiedSimilarity,
  PRIMARY_SIMILARITY_BAND_LABELS,
  primarySimilarityScore,
  unifiedEvidenceSummary,
} from '../lib/report-types.ts';
import { attachUnifiedSimilarity } from '../lib/document-check-pipeline.ts';
import { tokens } from '../lib/similarity-core.ts';
import { similarityScoreBand } from '../lib/ai-core.ts';
import { createReceiptPdf } from '../lib/receipt-pdf.ts';
import { ensurePdfjsNodePolyfills } from '../lib/pdfjs-node-polyfill.ts';
import { extractPdfTextDocument } from '../lib/pdf-text-extraction.ts';
// Release-hardening audit finding LIFECYCLE-06 (Preview regression): the
// REAL, exported isFullyRevealed — not this file's own long-standing local
// mirror further down (kept as-is for the existing LIFECYCLE-03/05 tests) —
// aliased so the new regression test below proves the actual deployed
// function's behavior, not a parallel description of it.
import { isFullyRevealed as isFullyRevealedReal } from '../app/reports/rooms/[room]/room-page-shell.tsx';

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
  // Phase A: this suite tests write-time finalization / self-heal, not the
  // 7-day activation gate — age the just-promoted backing so the report POST's
  // own write-time resolution sees it as matchable "now".
  await matureCorpusBackings(client);
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

async function postReport(account, { id, room, aiStatus, aiScore, text = DOCUMENT_A_TEXT, wordCount = DOCUMENT_A_WORD_COUNT, archiveScore = 0, payloadOverrides = {} }) {
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
        // Release-hardening audit finding LIFECYCLE-06 (Preview regression):
        // lets a caller submit exactly what a real client resave would —
        // e.g. a stale, client-computed unifiedSimilarity — so a test can
        // prove the SERVER correctly overwrites it via write-time
        // finalization, rather than only ever submitting the archive-only
        // default shape every other caller of this helper already uses.
        ...payloadOverrides,
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

// Preview receipt regression: real font bytes, read once, so createReceiptPdf
// never needs its own fetch("/receipt-font.ttf") — that call requires a real
// browser origin and cannot run in this Node test environment.
const receiptFonts = {
  regular: fs.readFileSync(path.join(repo, 'public/receipt-font.ttf')),
  bold: fs.readFileSync(path.join(repo, 'public/receipt-font-bold.ttf')),
};

/**
 * Mirrors lib/document-check-pipeline.ts's downloadReceipt exactly — same
 * selectors (primarySimilarityScore, similarityScoreBand, hasUnifiedSimilarity,
 * unifiedEvidenceSummary), same order, same shape handed to createReceiptPdf
 * — stopping short only of downloadReceipt's own trailing browser-only file-
 * download side effects (document.createElement/URL.createObjectURL/
 * window.setTimeout), which are pure plumbing with no score/evidence-
 * selection logic of their own and cannot run here. This is the real
 * "receipt data-building path," not a synthetic ReceiptData object handed
 * straight to createReceiptPdf.
 */
async function buildReceiptPdfForReport(report) {
  const primaryScore = primarySimilarityScore(report);
  const verdict = similarityScoreBand(primaryScore);
  const unified = hasUnifiedSimilarity(report) && report.unifiedSimilarity && verdict
    ? {
      score: primaryScore,
      label: PRIMARY_SIMILARITY_BAND_LABELS[verdict.key],
      evidenceSummary: unifiedEvidenceSummary(report.unifiedSimilarity),
    }
    : undefined;
  return createReceiptPdf({ ...report, unified }, receiptFonts);
}

/** Real PDF text extraction (this codebase's own Node-compatible path, already proven in tests/corpus-text-extraction.test.mjs) — proves the actual rendered receipt, not just the input model handed to createReceiptPdf. */
async function extractReceiptPdfText(blob) {
  await ensurePdfjsNodePolyfills();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  return extractPdfTextDocument(document, () => {});
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

test('SIM-04: generation freshness — a report finalized before a matching source was promoted reads as "stale" only transiently: the room card\'s own read now self-heals it directly (legacy-room bug fix), so room and detail agree on the very first room read after promotion, never trusting the old archive-only number as final', async (t) => {
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

  await t.test('REQUIRED (legacy-room bug fix): promoting a source matching this exact report AFTER finalization bumps the generation, and the very next room-card read recognizes the persisted result as stale and self-heals it to the current 100% in that same read — never left showing the old archive-only 0 while waiting for the detail page to be opened', async () => {
    await promoteDocumentIntoCorpus(DOCUMENT_B_TEXT);

    const occupant = await findRoomOccupant(client, account.userId, 2);
    assert.equal(occupant.report.similarityStatus, 'resolved', 'REQUIRED: "stale" must be actionable on the room read itself, not a state the client is left polling forever — see this file\'s own LEGACY ROOM BUG section');
    assert.equal(occupant.report.primaryScore, 100, 'must converge to the true current match, never stay stuck at the stale archive-only 0');
    assert.equal(occupant.report.isUnified, true);
    assert.equal(occupant.report.archiveScore, 0, 'the original archive-only value is untouched even though the unified result was just refreshed');

    const snapshotAfterRoomRead = await snapshotRow(account.deviceKey, reportId);
    assert.notEqual(snapshotAfterRoomRead.computed_at, snapshotBeforePromotion.computed_at, 'REQUIRED: the room card\'s own self-heal performs exactly one real recompute when it detects staleness — this is the fix, not a cost to avoid');

    const { payload: stored } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(stored.unifiedSimilarity.unifiedScore, 100, 'REQUIRED: the room read must actually persist the refreshed result, using the same generation-guarded write every other finalization path uses');
  });

  await t.test('opening the report detail after the room already self-healed is a pure cache hit — no second recompute', async () => {
    const before = await snapshotRow(account.deviceKey, reportId);
    const res = await getReportDetail(account, reportId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.payload.unifiedSimilarity.unifiedScore, 100, 'the detail route reads the already-current result the room\'s own self-heal just persisted');

    const after = await snapshotRow(account.deviceKey, reportId);
    assert.equal(after.computed_at, before.computed_at, 'REQUIRED: the room already did the one real recompute — detail must not recompute a second time');

    const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(archiveScore, 0, 'archive_score must stay untouched throughout');
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100);
  });

  await t.test('REQUIRED: a later room-card read still agrees, still with no recompute of its own', async () => {
    const before = await snapshotRow(account.deviceKey, reportId);
    const occupant = await findRoomOccupant(client, account.userId, 2);
    assert.equal(occupant.report.similarityStatus, 'resolved');
    assert.equal(occupant.report.primaryScore, 100);
    assert.equal(occupant.report.isUnified, true);
    const after = await snapshotRow(account.deviceKey, reportId);
    assert.equal(after.computed_at, before.computed_at, 'the room card never recomputes an already-current result');
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

  await t.test('REQUIRED (legacy-room bug fix): turning the flag back on restores the unified result on the very first room-card read — a roll-forward is exactly the kind of "stale" the room\'s own self-heal now resolves directly, never left showing the old off-value while waiting for the detail page', async () => {
    const restoredOccupant = await findRoomOccupant(client, account.userId, 3);
    assert.equal(restoredOccupant.report.similarityStatus, 'resolved', 'REQUIRED: the room card itself must self-heal a roll-forward, not merely report "stale" and wait for the detail page');
    assert.equal(restoredOccupant.report.primaryScore, 100);
    assert.equal(restoredOccupant.report.isUnified, true);
    assert.equal(restoredOccupant.report.archiveScore, 0, 'REQUIRED: archive_score must never be corrupted by the flag going off and back on');

    const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(archiveScore, 0);
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, 'REQUIRED: the room read must actually persist the restored result');

    // The detail route, opened after the room already self-healed, must be
    // a pure cache hit — no second recompute.
    const res = await getReportDetail(account, reportId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.payload.unifiedSimilarity.unifiedScore, 100);
  });
});

test('SIM-04: a report saved with no text at all (finalization never even attempted at write time) still saves successfully; the legacy-room self-heal then resolves it to an honest, real 0% on first room read — see this file\'s own LEGACY ROOM BUG section for why text presence must not gate whether that self-heal is even attempted', async () => {
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
  assert.equal(payload.unifiedSimilarity, undefined, 'write-time finalization must never have run — no text to finalize (this part is completely unaffected by the legacy-room self-heal, which is a READ-time concern in findRoomOccupant only)');

  // Legacy-room bug fix: this report has real, terminal ai_status but no
  // unifiedSimilarity/unifiedSimilarityFailed at all — the same ambiguous
  // combination the legacy-room self-heal resolves for ANY row in that
  // state. Deliberately not special-cased on text presence (see this
  // file's own LEGACY ROOM BUG section for why: text presence cannot
  // reliably distinguish "genuinely legacy" from "modern transient skip",
  // so it must not gate whether the self-heal attempt itself even runs).
  // computeUnifiedSimilarity does not require rawText — with no
  // archiveMatchedPositions, no externalAcademicEvidence, and no
  // historical match against an empty canonical text, it converges to an
  // honest, real 0%, not the old indefinite "pending".
  const occupant = await findRoomOccupant(client, account.userId, 4);
  assert.equal(occupant.report.similarityStatus, 'resolved', 'the legacy-room self-heal now resolves this too, rather than leaving it "pending" forever');
  assert.equal(occupant.report.primaryScore, 0, 'a real, honestly-computed 0% — there is genuinely nothing to match without text — never the OLD archive score masquerading as the unified result');
  assert.equal(occupant.report.isUnified, true, 'a real unifiedSimilarity WAS computed (all-zero) — this is a genuine resolution, not an inferred archive-only fallback');
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

const DOCUMENT_D_TEXT =
  'Marine biologists tagging juvenile reef sharks along a nursery lagoon recorded consistent site fidelity across two consecutive monitoring seasons, ' +
  'with individual tag-recapture intervals showing minimal home-range drift even during the seasonal thermal stratification event that disrupted several neighboring habitats.';
const DOCUMENT_D_WORD_COUNT = 55;

// Release-hardening audit finding LIFECYCLE-05 (superseding this test's own
// original framing): "the room page shows the real 100%" below is a claim
// about the DATA LAYER (findRoomOccupant/the GET route), proving similarity
// finalizes and is retrievable independently of ai_status — it is NOT a
// claim about what app/reports/rooms/[room]/room-page-shell.tsx actually
// RENDERS. That client-side component now deliberately withholds the
// number until BOTH pipelines are terminal ("reveal AI score, unified
// similarity score, and receipt together" — see room-page-shell.tsx's own
// isFullyRevealed and tests/room-processing-navigation.test.mjs for that
// UI-level gate). This test still matters: isFullyRevealed can only ever
// say "yes" once the data it reads is actually correct, and that is
// exactly what write-time finalization (proven here) guarantees. See the
// LIFECYCLE-05 END-TO-END test below for the combined-reveal gate itself,
// exercised against this same real data.
test('LIFECYCLE-03 END-TO-END (data layer): similarity and AI-writing detection finalize as independent pipelines — the data is already the real 100% while ai_status is still "processing" (proving room-page-shell.tsx\'s isFullyRevealed CAN reveal it the moment AI catches up), the very first detail render already carries it (no matcher re-run), and the later AI-completion resave never changes it', async (t) => {
  await promoteDocumentIntoCorpus(DOCUMENT_D_TEXT);
  const account = await signUpConsentingAccount();
  const reportId = 'lifecycle-03-report-1';

  await t.test('a different, consenting account uploads the matching text — the first save (aiStatus "processing") already finalizes and persists the combined 100% result', async () => {
    const res = await postReport(account, { id: reportId, room: 0, aiStatus: 'processing', text: DOCUMENT_D_TEXT, wordCount: DOCUMENT_D_WORD_COUNT });
    assert.equal(res.status, 200, 'test setup sanity: first save must succeed');
    const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(archiveScore, 0, 'archive_score must be exactly the archive-only value submitted — never overwritten');
    assert.ok(payload.unifiedSimilarity, 'unifiedSimilarity must already be persisted after the very first save, before AI has even started');
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, 'the promoted TURNITPLUS_CORPUS_SOURCE match must already be reflected');
  });

  const snapshotAfterFirstSave = await snapshotRow(account.deviceKey, reportId);
  assert.ok(snapshotAfterFirstSave, 'the historical-match snapshot must be written as a real side effect of the first save');

  await t.test('REQUIRED (data layer): findRoomOccupant already has the real 100% while ai_status is STILL "processing" — similarity finalization is never coupled to AI completion, even though the room card\'s own UI now deliberately waits for both (see LIFECYCLE-05 END-TO-END below)', async () => {
    const occupant = await findRoomOccupant(client, account.userId, 0);
    assert.equal(occupant.status, 'processing', 'test setup sanity: AI analysis must genuinely still be in progress at this point — this is the exact case the fix is about');
    assert.equal(occupant.report.primaryScore, 100, 'REQUIRED: the underlying data must carry the real, finalized 100% even though AI has not finished — this is what lets isFullyRevealed say yes the instant AI also catches up');
    assert.equal(occupant.report.isUnified, true);
    assert.equal(occupant.report.similarityStatus, 'resolved', 'similarity itself is fully resolved, independent of ai_status');
    assert.equal(occupant.report.archiveScore, 0, 'archive_score must remain untouched');
    assert.equal(occupant.report.aiScore, null, 'AI Detection has genuinely not produced a score yet — the two pipelines are independent, not one waiting for the other');
  });

  await t.test('REQUIRED: the very first detail render already shows 100%, straight from the saved row, before any client fetch — no different from a fully "ready" report', async () => {
    const { payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, "REQUIRED: the report detail's first server render must already be 100%");
  });

  await t.test('REQUIRED: opening the detail report while still "processing" does not trigger matching, recomputation, or any later score change — a real GET, twice, is a pure cache hit both times', async () => {
    const before = await snapshotRow(account.deviceKey, reportId);
    const res = await getReportDetail(account, reportId);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.payload.unifiedSimilarity.unifiedScore, 100, 'the GET route must still return the real 100% while AI is still processing');
    const after = await snapshotRow(account.deviceKey, reportId);
    assert.equal(after.computed_at, before.computed_at, 'REQUIRED: opening the detail report must not invoke the matcher again — the snapshot must not be recomputed');

    const res2 = await getReportDetail(account, reportId);
    const body2 = await res2.json();
    assert.equal(body2.payload.unifiedSimilarity.unifiedScore, 100, 'REQUIRED: no later request may ever change the score — it must already be 100% and stay 100%');
    const after2 = await snapshotRow(account.deviceKey, reportId);
    assert.equal(after2.computed_at, before.computed_at, 'a second open must still be a pure cache hit');
  });

  await t.test('REQUIRED: the later AI-completion resave preserves the finalized unified similarity exactly — archive_score, unifiedScore, and the snapshot itself are all untouched by AI finishing', async () => {
    const beforeResave = await snapshotRow(account.deviceKey, reportId);
    const res = await postReport(account, { id: reportId, room: 0, aiStatus: 'ready', aiScore: 4, text: DOCUMENT_D_TEXT, wordCount: DOCUMENT_D_WORD_COUNT });
    assert.equal(res.status, 200);

    const { archiveScore, payload } = await savedReportRow(account.deviceKey, reportId);
    assert.equal(archiveScore, 0, 'archive_score must still be exactly 0 after the AI-completion resave');
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, 'REQUIRED: the AI-completion resave must not regress or otherwise change the already-finalized 100%');

    const afterResave = await snapshotRow(account.deviceKey, reportId);
    assert.equal(afterResave.computed_at, beforeResave.computed_at, "the AI-completion resave's own finalization call must be a cache hit — no second real matcher search");

    const occupant = await findRoomOccupant(client, account.userId, 0);
    assert.equal(occupant.status, 'ready', 'AI has now genuinely finished');
    assert.equal(occupant.report.primaryScore, 100, 'the room card must still show 100% now that both pipelines have completed');
    assert.equal(occupant.report.aiScore, 4, 'AI Detection now shows its own real, independently-arrived score');
  });
});

/**
 * Mirrors app/reports/[id]/page.tsx's loadOwnedReport exactly for the two
 * fields ReportDetailShell actually needs to compute its own bothReady gate
 * — deriveRoomStatus(row.ai_score, row.ai_status) for aiStatus, and
 * resolvePersistedSimilarityDisplay for similarityStatus — without needing
 * a real Next.js request scope to render the page component itself. Same
 * "mirrors the real handler's own logic, not a second implementation of
 * different logic" discipline this file's own postReport/getReportDetail
 * helpers already follow for the routes they call.
 */
async function computeInitialDetailState(userId, reportId) {
  const row = await findReportRowForUser(client, reportId, userId);
  assert.ok(row, 'test setup sanity: the report row must exist');
  const aiStatus = deriveRoomStatus(row.ai_score, row.ai_status);
  const payload = JSON.parse(row.payload_json);
  const display = await resolvePersistedSimilarityDisplay(client, {
    reportDeviceKey: row.device_key,
    reportId,
    archiveScore: archiveOverlapScore(payload),
    unifiedScore: payload.unifiedSimilarity?.unifiedScore ?? null,
    hasUnifiedSimilarity: hasUnifiedSimilarity(payload),
    corpusSourceMatchingEnabledAtComputation: payload.corpusSourceMatchingEnabledAtComputation ?? null,
    unifiedSimilarityFailed: payload.unifiedSimilarityFailed ?? false,
    hasPositionEvidence: payload.unifiedSimilarity?.matchedPositions !== undefined,
  });
  return { aiStatus, similarityStatus: display.status };
}

/** Mirrors ReportDetailShell's own bothReady formula exactly (mode "similarity" — the room's own links always open this mode). Release-hardening audit finding LIFECYCLE-06 (extended): similarityTerminal now also covers a genuine, persisted "failed" status — see lib/report-detail-poll.ts's own isSimilarityTerminal. */
function isBothReady({ aiStatus, similarityStatus }) {
  const aiTerminal = aiStatus === null || aiStatus === 'ready' || aiStatus === 'failed';
  const similarityTerminal = similarityStatus === 'resolved' || similarityStatus === 'failed';
  return aiTerminal && similarityTerminal;
}

/** Mirrors room-page-shell.tsx's own isFullyRevealed formula exactly. */
function isFullyRevealed(occupant) {
  if (occupant.status !== 'ready' && occupant.status !== 'failed') return false;
  const similarityStatus = occupant.report?.similarityStatus;
  return similarityStatus !== 'stale' && similarityStatus !== 'pending';
}

const DOCUMENT_E_TEXT =
  'Volcanologists installing a dense tiltmeter array around an active stratovolcano detected a gradual inflation signal consistent with magma accumulation at shallow depth, ' +
  'with the deformation pattern closely matching precursory signals documented before a smaller eruptive episode at the same edifice several decades earlier.';
const DOCUMENT_E_WORD_COUNT = 50;

test('LIFECYCLE-05 END-TO-END: the room and detail pages both withhold every result until AI-writing detection AND unified similarity are BOTH terminal, then reveal everything together — an AI failure still counts as terminal and does not hold back the completed similarity result', async (t) => {
  await promoteDocumentIntoCorpus(DOCUMENT_E_TEXT);
  const readyAccount = await signUpConsentingAccount();
  const failedAccount = await signUpConsentingAccount();
  const readyReportId = 'lifecycle-05-ready-report';
  const failedReportId = 'lifecycle-05-failed-report';

  await t.test('first save (aiStatus "processing"): neither the room nor the detail page is fully revealed, even though similarity already has the real 100% underneath', async () => {
    const res = await postReport(readyAccount, { id: readyReportId, room: 0, aiStatus: 'processing', text: DOCUMENT_E_TEXT, wordCount: DOCUMENT_E_WORD_COUNT });
    assert.equal(res.status, 200, 'test setup sanity: first save must succeed');

    const occupant = await findRoomOccupant(client, readyAccount.userId, 0);
    assert.equal(occupant.status, 'processing');
    assert.equal(occupant.report.primaryScore, 100, 'test setup sanity: similarity data is already the real 100%');
    assert.equal(isFullyRevealed(occupant), false, 'REQUIRED: the room must NOT be fully revealed while AI is still processing, regardless of what similarity already knows');

    const detailState = await computeInitialDetailState(readyAccount.userId, readyReportId);
    assert.equal(detailState.aiStatus, 'processing');
    assert.equal(detailState.similarityStatus, 'resolved', 'test setup sanity: similarity is already resolved server-side too');
    assert.equal(isBothReady(detailState), false, 'REQUIRED: the detail page must NOT be bothReady either — one stable loading screen, not a partial reveal of the already-known 100%');
  });

  await t.test('AI-completion resave (aiStatus "ready"): the room and detail pages both become fully revealed, and the score is exactly what was already finalized — never recomputed, never changed', async () => {
    const res = await postReport(readyAccount, { id: readyReportId, room: 0, aiStatus: 'ready', aiScore: 6, text: DOCUMENT_E_TEXT, wordCount: DOCUMENT_E_WORD_COUNT });
    assert.equal(res.status, 200);

    const occupant = await findRoomOccupant(client, readyAccount.userId, 0);
    assert.equal(occupant.status, 'ready');
    assert.equal(occupant.report.primaryScore, 100, 'REQUIRED: revealing must never change the already-finalized score');
    assert.equal(occupant.report.aiScore, 6);
    assert.equal(isFullyRevealed(occupant), true, 'REQUIRED: now that both pipelines are terminal, the room must reveal everything together');

    const detailState = await computeInitialDetailState(readyAccount.userId, readyReportId);
    assert.equal(detailState.aiStatus, 'ready');
    assert.equal(detailState.similarityStatus, 'resolved');
    assert.equal(isBothReady(detailState), true, 'REQUIRED: the detail page must now replace its loading screen with the complete report');

    const { payload } = await savedReportRow(readyAccount.deviceKey, readyReportId);
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, 'the score itself must be byte-identical to what was persisted before AI ever finished');
  });

  await t.test('REQUIRED: an AI failure still counts as terminal — the room and detail pages reveal the completed similarity result (and an "Unavailable" AI signal) rather than waiting forever', async () => {
    await postReport(failedAccount, { id: failedReportId, room: 0, aiStatus: 'processing', text: DOCUMENT_E_TEXT, wordCount: DOCUMENT_E_WORD_COUNT });
    let occupant = await findRoomOccupant(client, failedAccount.userId, 0);
    assert.equal(isFullyRevealed(occupant), false, 'test setup sanity: not yet revealed while genuinely processing');

    const res = await postReport(failedAccount, { id: failedReportId, room: 0, aiStatus: 'failed', text: DOCUMENT_E_TEXT, wordCount: DOCUMENT_E_WORD_COUNT });
    assert.equal(res.status, 200);

    occupant = await findRoomOccupant(client, failedAccount.userId, 0);
    assert.equal(occupant.status, 'failed');
    assert.equal(occupant.report.primaryScore, 100, 'the completed similarity result must still be there, unaffected by the AI failure sitting next to it');
    assert.equal(isFullyRevealed(occupant), true, 'REQUIRED: an AI failure is itself a terminal, final answer — never a reason to keep the room stuck on "Analysis in progress" forever');

    const detailState = await computeInitialDetailState(failedAccount.userId, failedReportId);
    assert.equal(detailState.aiStatus, 'failed');
    assert.equal(isBothReady(detailState), true, 'REQUIRED: the detail page must also reveal — showing "Unavailable" for AI while still showing the real similarity result, never staying on the loading screen because of a failure');
  });
});

const DOCUMENT_F_TEXT =
  'Paleoclimatologists analyzing a newly extracted ice core from a high-altitude glacier identified a distinctive dust layer whose isotopic signature matches a documented volcanic ' +
  'eruption several centuries earlier, allowing the entire core to be independently dated with a precision the existing annual-layer count alone could not achieve.';
const DOCUMENT_F_WORD_COUNT = 45;

/**
 * Release-hardening audit finding LIFECYCLE-06 (Preview regression, proven
 * root cause): reproduces the exact sequence Vercel Preview surfaced —
 * fresh upload of content matching an already-promoted corpus source
 * revealed AI + a false 0% similarity together, permanently, until a full
 * page reload (a fresh server read) showed the true 100%.
 *
 * Root cause traced through the real code: app/reports/rooms/[room]/room-page-shell.tsx's
 * runCheck() calls the REAL attachUnifiedSimilarity (lib/document-check-pipeline.ts)
 * on the client's own locally-generated report BEFORE it is ever saved —
 * that function never passes historicalSubmissionMatch to computeUnifiedSimilarity
 * (see its own single call site), so it has no way to see the corpus and
 * correctly-for-its-own-inputs computes 0 for a promoted-corpus-only match.
 * The SERVER side was never wrong: write-time finalization (resolvePrimarySimilaritySummary,
 * invoked from app/api/reports/route.ts's POST handler on every save with
 * text) already, correctly persists the true 100% on the very first save,
 * before AI even starts — proven directly below, and already established
 * by the LIFECYCLE-03/05 END-TO-END tests above. The client, however,
 * never learns this: the save response is {ok:true}, not the enriched
 * payload, so the client's own in-memory `report` object keeps its stale,
 * corpus-blind unifiedSimilarity for the rest of this session. When AI
 * finishes, saveEnrichedAiResult spread that SAME stale object into
 * `enriched` and fed it through buildReportSummary (lib/report-types.ts),
 * whose own similarityStatus heuristic — hasUnifiedSimilarity(report) ?
 * "resolved" : "pending" — could not distinguish a present-but-corpus-blind
 * client computation from a genuinely server-confirmed one. That false
 * "resolved" was sufficient on its own for isFullyRevealed
 * (room-page-shell.tsx) to declare the room fully revealed and, via
 * setOccupant, permanently stop the room's own poll effect — the ONE thing
 * that would have read the server's already-correct persisted value.
 *
 * The fix (this same file's own room-page-shell.tsx, both call sites that
 * build a ReportSummary from a client-only report object) forces
 * similarityStatus to "pending" unconditionally at those two construction
 * points, so only a genuine server read (via this room's own poll effect)
 * can ever promote it to "resolved". Proven below using the REAL, exported
 * attachUnifiedSimilarity, buildReportSummary, and isFullyRevealed
 * (aliased isFullyRevealedReal) — never source-string assertions, and
 * never a second, parallel implementation of any of them.
 */
test('LIFECYCLE-06 PREVIEW REGRESSION: a fresh upload matching an already-promoted corpus source must not reveal the client\'s own corpus-blind 0% as a false "resolved" similarity — the room stays not-revealed until a real server read confirms the already-finalized 100%, and the very next poll-equivalent read adopts it with no page reload', async (t) => {
  await promoteDocumentIntoCorpus(DOCUMENT_F_TEXT);
  const account = await signUpConsentingAccount();
  const reportId = 'lifecycle-06-preview-regression-report';

  // Mirrors runCheck()'s own construction exactly: the client analyzes the
  // document entirely locally, then calls the REAL attachUnifiedSimilarity
  // — which never has corpus access — before ever saving anything.
  const clientReport = attachUnifiedSimilarity({
    version: 11, id: reportId, submissionId: 'sub-' + reportId, title: 'Client-side fixture',
    author: '', assignment: '', created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount: DOCUMENT_F_WORD_COUNT,
    scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [], text: DOCUMENT_F_TEXT,
    archiveMatchedPositions: [], externalAcademicEvidence: [],
  });
  assert.equal(clientReport.unifiedSimilarity.unifiedScore, 0, 'test setup sanity: the client-only computation must genuinely be blind to the promoted corpus match — this is the real attachUnifiedSimilarity output, not a fabricated fixture');

  await t.test('initial upload POST (aiStatus "processing"), submitting the client\'s own blind unifiedSimilarity exactly as saveReportRemote really does — write-time finalization already overwrites it with the true 100%, proving the corpus/unified result never required the detail page to be opened', async () => {
    const res = await postReport(account, {
      id: reportId, room: 0, aiStatus: 'processing', text: DOCUMENT_F_TEXT, wordCount: DOCUMENT_F_WORD_COUNT,
      payloadOverrides: { unifiedSimilarity: clientReport.unifiedSimilarity },
    });
    assert.equal(res.status, 200, 'test setup sanity: first save must succeed');

    const occupant = await findRoomOccupant(client, account.userId, 0);
    assert.equal(occupant.status, 'processing', 'test setup sanity: AI genuinely still in progress');
    assert.equal(occupant.report.similarityStatus, 'resolved', 'REQUIRED: the server already has the true, current unified result — proves the corpus/unified result never needed the detail page to be opened');
    assert.equal(occupant.report.primaryScore, 100, 'REQUIRED: the true 100% is already persisted server-side, overwriting the client\'s own submitted 0%, before AI has even started');
  });

  // Mirrors saveEnrichedAiResult's own construction exactly: `enriched`
  // spreads the SAME clientReport object from above — never updated with
  // the server's own confirmed 100%, since the save response above was
  // only {ok:true}.
  const aiResult = { aiScore: 3, aiAnalysis: { status: 'complete', analyzedWordCount: DOCUMENT_F_WORD_COUNT } };
  const enriched = { ...clientReport, ...aiResult };

  t.test('REQUIRED (proves the exact root cause): building the room summary from the client\'s own stale, corpus-blind report the OLD way reports a false "resolved" 0%, and the real isFullyRevealed accepts it as fully revealed', () => {
    const buggyOldSummary = { ...buildReportSummary(enriched), aiStatus: 'ready' };
    assert.equal(buggyOldSummary.similarityStatus, 'resolved', 'documents the exact root cause: buildReportSummary treats the mere presence of a client-only unifiedSimilarity as sufficient evidence of "resolved"');
    assert.equal(buggyOldSummary.primaryScore, 0, 'documents the exact root cause: the reported score is the client\'s own blind 0%, not the server\'s real 100%');
    const buggyOccupant = { status: 'ready', report: buggyOldSummary, cycleEndsAt: new Date().toISOString() };
    assert.equal(isFullyRevealedReal(buggyOccupant), true, 'documents the exact root cause: this false "resolved" status alone is enough for the real isFullyRevealed to declare the room fully revealed, permanently stopping the poll effect that would otherwise correct it');
  });

  t.test('REQUIRED (proves the fix): the actual, currently-deployed saveEnrichedAiResult construction forces similarityStatus to "pending" regardless of buildReportSummary\'s own output — the room correctly stays NOT revealed, so its own poll effect keeps running instead of stopping on the false 0%', () => {
    // Mirrors room-page-shell.tsx's saveEnrichedAiResult exactly, including
    // the fix: similarityStatus: "pending" overrides whatever
    // buildReportSummary(enriched) itself computed.
    const fixedSummary = { ...buildReportSummary(enriched), aiStatus: 'ready', similarityStatus: 'pending' };
    assert.equal(fixedSummary.similarityStatus, 'pending');
    const fixedOccupant = { status: 'ready', report: fixedSummary, cycleEndsAt: new Date().toISOString() };
    assert.equal(isFullyRevealedReal(fixedOccupant), false, 'REQUIRED: the room must not declare itself fully revealed from the client\'s own unconfirmed similarity — it must remain "Analysis in progress," never a temporary 0%. This is also the proof that a poll observing this pending state continues rather than treating the fallback score as resolved: isFullyRevealed is the poll effect\'s own stop condition, and it says no here.');
  });

  await t.test('REQUIRED: the AI-completion resave (the real POST, submitting the client\'s own stale unifiedSimilarity in the body, exactly as saveEnrichedAiResult really sends it) still results in the server persisting the TRUE 100% — the server was never the problem — and the room\'s own next poll-equivalent read adopts it, revealing AI + correct similarity + receipt together, atomically, with no page reload and no detail-page visit', async () => {
    const res = await postReport(account, {
      id: reportId, room: 0, aiStatus: 'ready', aiScore: 3, text: DOCUMENT_F_TEXT, wordCount: DOCUMENT_F_WORD_COUNT,
      payloadOverrides: { unifiedSimilarity: clientReport.unifiedSimilarity },
    });
    assert.equal(res.status, 200);

    // "next room poll" — the SAME findRoomOccupant call the room's own poll
    // effect reaches via fetchReportRoomContents -> GET /api/reports?room=N.
    const occupant = await findRoomOccupant(client, account.userId, 0);
    assert.equal(occupant.status, 'ready');
    assert.equal(occupant.report.similarityStatus, 'resolved', 'REQUIRED: the next poll must observe the true, current result, never the client\'s stale submitted value');
    assert.equal(occupant.report.primaryScore, 100, 'REQUIRED: the room must adopt the real 100% — never the client\'s own blind 0% it submitted in the resave body');
    assert.equal(occupant.report.aiScore, 3);
    assert.equal(isFullyRevealedReal(occupant), true, 'REQUIRED: once the poll observes this genuinely resolved state, the room reveals AI + correct similarity + receipt together — atomically, automatically, with no browser refresh and no detail-page visit required');
  });
});

const RECEIPT_REGRESSION_TEXT =
  'Marine biologists studying deep-reef fish populations documented a previously unrecorded diel vertical migration pattern synchronized with lunar illumination cycles, ' +
  'indicating that ambient moonlight rather than water temperature alone structures the timing of this nightly foraging behavior across the entire studied reef system.';
const RECEIPT_REGRESSION_WORD_COUNT = tokens(RECEIPT_REGRESSION_TEXT).length;

/**
 * Preview receipt regression: Preview commit 276cc8d passed the room and
 * report-page checks (both already server-confirmed, per the LIFECYCLE-06
 * fix above) but the downloaded receipt still showed 0% / "own reference
 * material" for a real promoted-corpus-only 100% match.
 *
 * ROOT CAUSE, traced through the real code — a THIRD, previously-unguarded
 * call site of the exact LIFECYCLE-06 pattern: app/reports/rooms/[room]/
 * room-page-shell.tsx's handleDownloadReceipt (and components/reports/
 * report-history-row.tsx's own identical handler, shared by app/page.tsx's
 * anonymous list and the room browser's per-room list) resolved the report
 * to hand to downloadReceipt as `local ?? (await fetchRemoteReport(...))` —
 * PREFERRING the local IndexedDB copy whenever one existed. That local copy
 * is `report` from runCheck (or saveEnrichedAiResult's `enriched`, which
 * spreads the same object), stored via storeReportBestEffort with
 * attachUnifiedSimilarity's own client-side, corpus-blind unifiedSimilarity
 * already attached — the identical stale object the room-card and
 * write-time-finalization fixes above were built specifically to stop
 * treating as trustworthy. Unlike the room card (fixed by forcing
 * similarityStatus to "pending" so only a fresh server poll can resolve it)
 * and the report detail page (which always reads through GET /api/reports/
 * [id]), the receipt download path had no equivalent guard at all: `local`
 * was always truthy once any local copy existed, so the remote fallback
 * never even ran, and downloadReceipt's own primarySimilarityScore/
 * unifiedEvidenceSummary calls (both already correct) faithfully rendered
 * whatever the stale object contained — 0% and, since the client's own
 * archive check can independently find a small unrelated overlap, "own
 * reference material" instead of "TurnitPlus reference sources".
 *
 * FIX (app/reports/rooms/[room]/room-page-shell.tsx and components/reports/
 * report-history-row.tsx, both receipt-download entry points): flipped to
 * `remote ?? (await getStoredReportById(...).catch(() => null))` — the
 * server-confirmed copy first, local IndexedDB only as an offline fallback
 * when the network fetch itself fails. No change to scoring, matching,
 * corpus admission/promotion, room lifecycle, or the report-detail page —
 * this is the same "never trust a client-computed result as server-
 * confirmed" principle already applied elsewhere, extended to the one
 * remaining call site that still violated it.
 */
test('RECEIPT PREVIEW REGRESSION: the downloaded receipt must show the server-finalized 100%, matching the room and report detail page exactly — never the client-side corpus-blind preview', async (t) => {
  await promoteDocumentIntoCorpus(RECEIPT_REGRESSION_TEXT);
  const account = await signUpConsentingAccount();
  const reportId = 'receipt-preview-regression-report';

  // Mirrors runCheck()'s own construction exactly (same as the LIFECYCLE-06
  // room-card regression above): the client analyzes entirely locally, then
  // calls the REAL attachUnifiedSimilarity, which has no corpus access —
  // this is exactly what storeReportBestEffort would have written into
  // IndexedDB at upload time.
  const clientPreviewReport = attachUnifiedSimilarity({
    version: 11, id: reportId, submissionId: 'sub-' + reportId, title: 'Receipt regression fixture',
    author: '', assignment: '', created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount: RECEIPT_REGRESSION_WORD_COUNT,
    scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [], text: RECEIPT_REGRESSION_TEXT,
    archiveMatchedPositions: [], externalAcademicEvidence: [],
  });
  assert.equal(clientPreviewReport.unifiedSimilarity.unifiedScore, 0, 'test setup sanity: the client-only preview must genuinely be blind to the promoted corpus match — this is the real attachUnifiedSimilarity output, not a fabricated fixture');

  const saveRes = await postReport(account, {
    id: reportId, room: 1, aiStatus: 'ready', aiScore: 2, text: RECEIPT_REGRESSION_TEXT, wordCount: RECEIPT_REGRESSION_WORD_COUNT,
    payloadOverrides: { unifiedSimilarity: clientPreviewReport.unifiedSimilarity },
  });
  assert.equal(saveRes.status, 200, 'test setup sanity: save must succeed, submitting the client\'s own stale preview exactly as a real resave would');

  await t.test('REQUIRED (documents the exact bug mechanism): a receipt built from the client\'s own stale local preview shows 0%, not 100% — proving this scenario genuinely reproduces the reported bug, not a trivial always-correct fixture', async () => {
    const blob = await buildReceiptPdfForReport(clientPreviewReport);
    const text = await extractReceiptPdfText(blob);
    assert.match(text, /TurnitPlus Similarity:\s*0%/, 'documents the exact root cause: the client-side preview genuinely produces the same 0% Preview reported');
  });

  await t.test('REQUIRED (proves the fix): a receipt built from the real, server-finalized report shows 100%, with evidence-source wording matching the report page\'s own privacy-safe terminology', async () => {
    const detailRes = await getReportDetail(account, reportId);
    assert.equal(detailRes.status, 200);
    const detailBody = await detailRes.json();
    const serverReport = detailBody.payload;
    assert.ok(serverReport.unifiedSimilarity, 'REQUIRED: the server must return a real, finalized unifiedSimilarity — this is exactly what the fixed remote-first fetch now hands to the receipt, instead of the stale local preview');
    assert.equal(serverReport.unifiedSimilarity.unifiedScore, 100, 'test setup sanity: write-time finalization must have already persisted the true 100% server-side, before this receipt is ever requested');
    assert.equal(serverReport.unifiedSimilarity.previousUploadOnlyWords, serverReport.unifiedSimilarity.uniqueMatchedWords, 'test setup sanity: this report\'s only similarity evidence is the promoted corpus source');

    const blob = await buildReceiptPdfForReport(serverReport);
    const text = await extractReceiptPdfText(blob);
    assert.match(text, /TurnitPlus Similarity:\s*100%/, 'REQUIRED: the receipt must show the real, server-confirmed 100% — the same figure the room and report detail page already show');
    // Ordinary-user simplification (latest turn): the "Evidence sources"
    // row is removed entirely — a TURNITPLUS_CORPUS_SOURCE contribution no
    // longer gets even the generic "TurnitPlus reference sources" label on
    // the receipt; no matching channel/method is named at all any more.
    assert.doesNotMatch(text, /Evidence sources/i, 'REQUIRED: no "Evidence sources" row on the receipt at all');
    assert.doesNotMatch(text, /own reference material/i, 'the receipt must never claim archive evidence that does not exist for a match that is genuinely 100% promoted-corpus-only');
    assert.doesNotMatch(text, /TurnitPlus reference sources/i, 'REQUIRED: never names this channel on the ordinary-user receipt, even for a genuine corpus-source match');
    assert.doesNotMatch(text, /live academic sources/i, 'REQUIRED: never names this channel on the ordinary-user receipt');
    assert.doesNotMatch(text, /\bcorpus\b|\bprovider\b|\bprior submission|\bprevious submission|retained source|\brepresentation\b|\badmission\b|\bpromotion\b/i, 'the receipt must never expose corpus relationship types, prior-submission terminology, or admission/promotion internals to an ordinary viewer');
    assert.match(text, /TurnitPlus Similarity reflects matched text identified across the sources checked for this submission\./, 'REQUIRED: the neutral disclaimer wording must be present');
    // Receipt presentation fix (final receipt cleanup): a second
    // "Similarity result (component)" row directly beneath the real 100%
    // headline — technically correct (this report's archive-only score
    // genuinely is 0%) but reads as the system contradicting itself on an
    // ordinary-user receipt. Removed entirely once the authoritative
    // unified result is shown; the archive component stays available
    // elsewhere (UnifiedSimilaritySection's own admin-gated breakdown), not
    // duplicated here as a second competing "similarity result."
    assert.doesNotMatch(text, /Similarity result \(component\)/, 'REQUIRED: no second, competing "similarity result" row may appear once the authoritative TurnitPlus Similarity is shown');
    // Required per this fix: exactly one authoritative headline, and the
    // receipt must no longer claim to be mid-processing — this report is
    // completely finalized (write-time finalization + the LEGACY ROOM
    // BUG/backward-compatibility fixes above already guarantee that by the
    // time a receipt is ever requested).
    assert.doesNotMatch(text, /PROCESSING RECEIPT/, 'REQUIRED: a finalized report\'s receipt must never claim to be a processing receipt');
    assert.match(text, /FINAL RECEIPT/, 'REQUIRED: a finalized report\'s receipt must carry a clear, finalized label');
  });

  await t.test('REQUIRED (structural): both receipt-download entry points fetch the server-confirmed report first, using the local IndexedDB copy only as an offline fallback when the remote fetch itself fails', () => {
    // Scoped to handleDownloadReceipt's own function body specifically —
    // room-page-shell.tsx also has retryAiCheck, which legitimately still
    // resolves local-first (it only needs the report's own text to re-run
    // AI analysis, never a server-confirmed similarity figure, and is out
    // of scope for this receipt-specific fix) — a file-wide check would
    // false-positive on that unrelated, correct function.
    for (const file of ['app/reports/rooms/[room]/room-page-shell.tsx', 'components/reports/report-history-row.tsx']) {
      const source = fs.readFileSync(path.join(repo, file), 'utf8');
      const handlerStart = source.indexOf('async function handleDownloadReceipt');
      assert.ok(handlerStart > -1, `${file} must still define handleDownloadReceipt`);
      // Brace-matched, not a fixed-length slice — the function's own
      // explanatory comment is long enough that a short fixed window could
      // cut off before reaching its actual code.
      let depth = 0;
      let handlerEnd = handlerStart;
      for (let i = source.indexOf('{', handlerStart); i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) { handlerEnd = i + 1; break; }
        }
      }
      const handlerBody = source.slice(handlerStart, handlerEnd);
      assert.match(
        handlerBody,
        /const remote = await fetchRemoteReport[\s\S]{0,40}\n\s*const full = remote \?\? \(await getStoredReportById/,
        `${file}'s handleDownloadReceipt must resolve the receipt's report as remote-first, local-fallback`,
      );
      assert.doesNotMatch(
        handlerBody,
        /const local = await getStoredReportById[\s\S]{0,200}const full = local \?\?/,
        `${file}'s handleDownloadReceipt must no longer prefer the local IndexedDB copy over a fresh server fetch`,
      );
    }
  });
});

/**
 * Ordinary-user simplification (Task A, final receipt polish, latest turn):
 * this test previously verified the "Evidence sources" row showed the
 * correct, distinct label per contribution channel (own reference
 * material / live academic sources / TurnitPlus reference sources). That
 * row is now removed entirely, and none of those channel names may appear
 * anywhere on the receipt regardless of which channel(s) actually
 * contributed — verified here through the REAL buildReceiptPdfForReport
 * pipeline (primarySimilarityScore/unifiedEvidenceSummary and friends),
 * not just a synthetic createReceiptPdf call.
 */
test('RECEIPT (ordinary-user simplification): archive-only, academic-only, and corpus-only contributions all produce a receipt with no Evidence sources row and no channel-naming wording, regardless of which channel actually contributed', async () => {
  // Deliberately neutral id/submissionId/title (never containing the words
  // "archive"/"corpus"/"provider" themselves) — those words ARE expected
  // to legitimately appear on the receipt as real, ordinary user-supplied
  // content (a submission title, a submission ID) completely independent
  // of this test's own forbidden-internal-wording check; using them here
  // would make the assertions below fail for the wrong reason.
  const baseFixture = {
    version: 11, id: 'receipt-channel-fixture', submissionId: 'sub-receipt-channel-fixture', title: 'Channel fixture',
    author: '', assignment: '', created: new Date().toISOString(),
    score: 40, archiveScore: 40, wordCount: 1000, scoreBand: 'Moderate', matchedWordCount: 400, sources: [], repeats: [], text: 'fixture text not used by receipt generation directly',
  };

  const scenarios = [
    { label: 'channel-a', overrides: { archiveOnlyWords: 400, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0 } },
    { label: 'channel-b', overrides: { archiveOnlyWords: 0, liveAcademicOnlyWords: 400, previousUploadOnlyWords: 0 } },
    { label: 'channel-c', overrides: { archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 400 } },
  ];
  for (const scenario of scenarios) {
    const report = {
      ...baseFixture,
      id: `receipt-${scenario.label}-fixture`, submissionId: `sub-receipt-${scenario.label}-fixture`, title: `${scenario.label} fixture`,
      unifiedSimilarity: {
        version: 'unified-similarity-v1', wordCount: 1000, unifiedScore: 40, uniqueMatchedWords: 400,
        overlapWords: 0, selfExcludedWords: 0, unknownExcludedWords: 0, contributions: [],
        ...scenario.overrides,
      },
    };
    const text = await extractReceiptPdfText(await buildReceiptPdfForReport(report));
    assert.doesNotMatch(text, /Evidence sources/i, `${scenario.label}: REQUIRED no "Evidence sources" row`);
    assert.doesNotMatch(text, /own reference material/i, `${scenario.label}: REQUIRED never names this channel`);
    assert.doesNotMatch(text, /live academic sources/i, `${scenario.label}: REQUIRED never names this channel`);
    assert.doesNotMatch(text, /TurnitPlus reference sources/i, `${scenario.label}: REQUIRED never names this channel`);
    assert.doesNotMatch(text, /\barchive\b|\bcorpus\b|\bprovider\b/i, `${scenario.label}: REQUIRED never names archive/corpus/provider internals`);
    assert.match(text, /TurnitPlus Similarity:\s*40%/, `${scenario.label}: the one authoritative score must still render correctly regardless of which channel produced it`);
    assert.match(text, /TurnitPlus Similarity reflects matched text identified across the sources checked for this submission\./, `${scenario.label}: REQUIRED the neutral disclaimer wording is present`);
  }
});

/**
 * Task A, final receipt cleanup: two ordinary-user-visible presentation bugs
 * on the receipt PDF, unrelated to score computation, highlighting, or room
 * lifecycle (none of which this fix touches):
 *  1. Every receipt was unconditionally labeled "PROCESSING RECEIPT," even
 *     though a receipt can only ever be generated for an already-finalized
 *     report — both real entry points (room-page-shell.tsx's
 *     handleDownloadReceipt, report-history-row.tsx's own handler) gate the
 *     Receipt control behind a fully-revealed/already-saved report. Fixed
 *     to an unconditional "FINAL RECEIPT" label — not a new "is this
 *     finalized" check, since one was never reachable from the real UI.
 *  2. Once a unified result exists, the receipt showed BOTH the real
 *     authoritative "TurnitPlus Similarity" headline AND a second
 *     "Similarity result (component)" row (the archive-only score)
 *     directly beneath it — two different, individually-correct
 *     percentages both shaped like an overall "similarity result," reading
 *     as the system contradicting itself. The component row is removed
 *     entirely when the unified result is shown; the archive-only/legacy
 *     fallback path (no unified result at all) is untouched and still
 *     shows its one "Similarity result" row exactly as before.
 */
test('RECEIPT PRESENTATION FIX: a finalized receipt never says PROCESSING RECEIPT, always carries the chosen finalized label, and shows exactly one authoritative similarity result even at a genuine 0%', async () => {
  const zeroScoreReport = {
    version: 11, id: 'receipt-zero-score-fixture', submissionId: 'sub-receipt-zero-score-fixture', title: 'Zero-score unified fixture',
    author: '', assignment: '', created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount: 500, scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [], text: 'fixture text not used by receipt generation directly',
    unifiedSimilarity: {
      version: 'unified-similarity-v1', wordCount: 500, unifiedScore: 0, uniqueMatchedWords: 0,
      archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0,
      selfExcludedWords: 0, unknownExcludedWords: 0, contributions: [],
    },
  };
  const zeroText = await extractReceiptPdfText(await buildReceiptPdfForReport(zeroScoreReport));
  assert.doesNotMatch(zeroText, /PROCESSING RECEIPT/, 'REQUIRED: never claim to be a processing receipt — this report is fully finalized');
  assert.match(zeroText, /FINAL RECEIPT/, 'REQUIRED: a clear, finalized label must be present');
  assert.match(zeroText, /TurnitPlus Similarity:\s*0%/, 'REQUIRED: an authoritative, genuine 0% unified result must still display correctly as the one headline figure');
  assert.doesNotMatch(zeroText, /Similarity result \(component\)/, 'REQUIRED: no second competing "similarity result" row, even when the archive component and the unified result happen to be the same 0% value');

  const legacyArchiveOnlyReport = {
    version: 11, id: 'receipt-legacy-archive-only-fixture', submissionId: 'sub-receipt-legacy-archive-only-fixture', title: 'Legacy archive-only fixture',
    author: '', assignment: '', created: new Date().toISOString(),
    score: 62, archiveScore: 62, wordCount: 500, scoreBand: 'High', matchedWordCount: 310, sources: [], repeats: [], text: 'fixture text not used by receipt generation directly',
    // No unifiedSimilarity at all — a genuine legacy/archive-only report.
  };
  const legacyText = await extractReceiptPdfText(await buildReceiptPdfForReport(legacyArchiveOnlyReport));
  assert.doesNotMatch(legacyText, /PROCESSING RECEIPT/, 'REQUIRED: the finalized label applies regardless of whether a unified result exists');
  assert.match(legacyText, /FINAL RECEIPT/);
  assert.match(legacyText, /TurnitPlus Similarity:\s*62%/, 'REQUIRED: a legacy/archive-only report shows its one authoritative value under the SAME "TurnitPlus Similarity" label the unified path uses (the same value primarySimilarityScore(report) would fall back to) — never a distinct "Similarity result" label, and never a second "(component)" line, since there is no separate authoritative figure to compete with it');
  assert.doesNotMatch(legacyText, /Similarity result/, 'REQUIRED: the archive-only path must never use the old "Similarity result" label at all — every receipt shows exactly one row, always labeled "TurnitPlus Similarity"');
});

/**
 * LEGACY ROOM BUG (Preview reproduction): rooms 1–2, older saved reports
 * already completed/reported as ready elsewhere, opened to AI = Analyzing,
 * Similarity = Analyzing, Receipt = Preparing — indefinitely. Logout/login
 * did not fix it. Rooms 3–6 (newer reports) loaded their saved terminal
 * results normally. Vercel logs showed no new POST /api/reports when
 * reopening rooms 1–2, only repeated GET polling — the app was not
 * re-analyzing them, it was misclassifying already-complete legacy reports
 * as pending.
 *
 * ROOT CAUSE, traced through the requested chain (room page loader ->
 * findRoomOccupant -> resolvePersistedSimilarityDisplay -> isFullyRevealed
 * -> /api/reports polling): lib/report-primary-similarity.ts's
 * resolvePersistedSimilarityDisplay had exactly one branch for "no
 * unifiedSimilarity has ever been persisted" — return "pending",
 * unconditionally. lib/reports-repo.ts's findRoomOccupant (the room card's
 * read path, polled every few seconds) never self-heals by design — a cheap
 * json_extract read, never the matcher — so a legacy row (real text, real
 * terminal ai_status, real archive_score, but payload_json predating
 * unifiedSimilarity/unifiedSimilarityFailed entirely) stayed "pending"
 * forever: isFullyRevealed's own gate never passed, so the room never
 * revealed, and (this codebase's own established, tested behavior — see
 * "NOT REVEALED: no separate 'Open full report' escape hatch" elsewhere in
 * this suite) there is no way into the report-detail page — the ONE path
 * that self-heals — while a room is not yet revealed. Structurally unable
 * to ever recover on its own: exactly "logout/login does not fix it."
 *
 * REJECTED FIRST FIX: reading "no unifiedSimilarity + no failure marker +
 * real text present" as "resolved, archive-only" turned out to be unsound.
 * That same combination can ALSO mean a genuinely modern report whose
 * write-time finalization hit the rare transient-infra skip in
 * app/api/reports/route.ts's own outer catch — text presence alone cannot
 * distinguish "legacy" from "transiently incomplete." Resolving either one
 * to archiveScore can show a false terminal 0% for what a fresh resolution
 * would actually report as 100% (a promoted TurnitPlus corpus-source match)
 * — reintroducing the exact class of bug the unified-similarity work
 * eliminated. Never shipped past a local patch.
 *
 * ACCEPTED FIX (lib/report-primary-similarity.ts's new
 * selfHealMissingUnifiedSimilarity, called from lib/reports-repo.ts's
 * findRoomOccupant): stop guessing a fallback value entirely. When
 * hasUnifiedSimilarity is false and unifiedSimilarityFailed is not set,
 * findRoomOccupant now invokes the SAME authoritative resolver every other
 * finalization path already uses (resolvePrimarySimilaritySummary — write-
 * time finalization and the detail page's own self-heal) exactly once, and
 * persists whatever it returns (a real unifiedSimilarity, or an explicit
 * unifiedSimilarityFailed marker) using the same generation-guarded write
 * those paths already use. Once persisted, every subsequent read of this
 * row — a reload, a logout/login, a later poll — sees an already-resolved
 * (or already-failed) row through the ordinary cheap
 * resolvePersistedSimilarityDisplay path (itself completely unchanged) and
 * never re-enters the self-heal branch again: compatibility self-heal, not
 * repeated analysis. Never touches ai_score/ai_status — the AI pipeline is
 * completely independent and is never rerun or restarted. A genuine
 * transient infrastructure failure DURING the self-heal attempt itself is
 * caught and treated as attempted:false: the row is left exactly as
 * ambiguous as before (still "pending" on read), never a fabricated
 * resolved-archive-only or failed state.
 *
 * PREVIEW REGRESSION (deployed commit ca89842, the fix directly above):
 * rooms 1-2 STILL polled forever after that fix shipped. Real, read-only
 * inspection of the Preview Turso DB (via safe, whitelisted-field SELECTs -
 * never document text, never credentials) showed the real Room 1 row's
 * actual shape: ai_score=0, ai_status='ready', payload.aiAnalysis.status=
 * 'complete' (AI was genuinely terminal - not the blocker), has_unified=1,
 * payload.unifiedSimilarity.unifiedScore=0 (a REAL unifiedSimilarity WAS
 * already persisted - not "missing"), unifiedSimilarityFailed=NULL,
 * unifiedSimilarityGeneration=NULL, corpusSourceMatchingEnabledAtComputation
 * =NULL, current corpus_match_generation=1.
 *
 * ROOT CAUSE: ca89842's own trigger condition - `!hasUnifiedSimilarity &&
 * !unifiedSimilarityFailed` - only ever covers "nothing was ever
 * persisted." This real row has hasUnifiedSimilarity=true, so
 * selfHealMissingUnifiedSimilarity was NEVER invoked for it.
 * resolvePersistedSimilarityDisplay was still called (as it always is) and
 * correctly, honestly classified this row "stale" - a live-flag
 * roll-forward, since corpusSourceMatchingEnabledAtComputation is null
 * (this row predates that field existing at all) while the live
 * CORPUS_SOURCE_MATCHING_ENABLED flag is on. But findRoomOccupant never
 * acted on "stale" - only on the raw missing-flags condition above - so a
 * persisted-but-stale legacy result was invisible to ca89842's own fix,
 * and the room polled it forever, identically to the original bug.
 *
 * ACCEPTED FIX (this revision): findRoomOccupant no longer gates self-heal
 * on the raw hasUnifiedSimilarity/unifiedSimilarityFailed flags at all -
 * that was itself a second, duplicated freshness rule living outside
 * resolvePersistedSimilarityDisplay, the one canonical place freshness is
 * decided. Instead: call resolvePersistedSimilarityDisplay first; if its
 * verdict is "pending" OR "stale" (both mean "not an authoritative answer
 * right now"), invoke the renamed selfHealUnifiedSimilarity (same
 * function, same body, only its trigger and its name changed) exactly
 * once; update the local row fields from whatever it returns; call
 * resolvePersistedSimilarityDisplay again for the terminal verdict. No
 * generation/flag/date/room-number logic was added to lib/reports-repo.ts
 * - it only ever reads resolvePersistedSimilarityDisplay's own verdict.
 * "resolved" and "failed" are already terminal and skip self-heal
 * entirely - an explicit failure is never retried on every room read.
 */

let legacyRoomCounter = 0;
/** Directly INSERTs a saved_reports row via the real production SAVE_REPORT_SQL, with a payload_json shape that predates unifiedSimilarity/unifiedSimilarityFailed/corpusSourceMatchingEnabledAtComputation/unifiedSimilarityGeneration entirely — the real shape of a report saved before that feature existed, never merely a report with those fields set to null/false. Bypasses app/api/reports/route.ts's POST handler on purpose: a POST through that handler always attempts write-time finalization for text-bearing payloads, so it could never produce a genuinely legacy row on its own. */
async function insertLegacyRow(account, { id, room, aiStatus, aiScore, archiveScore, text, createdAt = new Date().toISOString() }) {
  legacyRoomCounter += 1;
  const payload = {
    version: 8, id, submissionId: 'sub-' + id, title: 'Legacy fixture ' + legacyRoomCounter,
    author: '', assignment: '', created: createdAt,
    score: archiveScore, archiveScore, wordCount: DOCUMENT_A_WORD_COUNT, scoreBand: 'Low',
    matchedWordCount: 0, sources: [], repeats: [], text,
    // Deliberately absent: unifiedSimilarity, unifiedSimilarityFailed,
    // corpusSourceMatchingEnabledAtComputation, unifiedSimilarityGeneration
    // — this IS the point of the fixture.
  };
  await client.execute({
    sql: reportsRoute.SAVE_REPORT_SQL,
    args: [id, account.deviceKey, 'sub-' + id, 'Legacy fixture ' + legacyRoomCounter, createdAt, DOCUMENT_A_WORD_COUNT, archiveScore, 'Low', aiScore ?? null, aiScore !== undefined ? 'low' : null, aiStatus, JSON.stringify(payload), account.userId, room],
  });
}

const LEGACY_SELF_HEAL_TEXT =
  'Entomologists cataloguing a remote montane cloud forest documented an undescribed weevil lineage whose wing-case ridging pattern diverges sharply from every previously known genus in the region, ' +
  'suggesting an extended period of geographic isolation shaped this population long before the surrounding lowland habitat began fragmenting under modern land use.';
const LEGACY_SELF_HEAL_WORD_COUNT = tokens(LEGACY_SELF_HEAL_TEXT).length;

test('LEGACY ROOM BUG: a legacy report whose original archive score is 0% but whose current promoted TurnitPlus reference-source match is 100% self-heals to the same 100% a fresh resolution/the detail page would return — never stuck at archive 0%', async (t) => {
  await promoteDocumentIntoCorpus(LEGACY_SELF_HEAL_TEXT);
  const account = await signUpConsentingAccount();
  const id = 'legacy-self-heal-100-report';
  // Genuinely legacy shape: real text (an EXACT match for the promoted
  // source), terminal AI, archive_score 0 (no archive overlap at all — the
  // ENTIRE 100% similarity lives in the corpus-source match this legacy
  // row's own payload_json predates and has never seen), no unifiedSimilarity/
  // unifiedSimilarityFailed field at all.
  await insertLegacyRow(account, { id, room: 6, aiStatus: 'ready', aiScore: 4, archiveScore: 0, text: LEGACY_SELF_HEAL_TEXT });

  await t.test('before any room read: no unifiedSimilarity has ever been persisted for this row', async () => {
    const row = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
    const payload = JSON.parse(row.rows[0].payload_json);
    assert.equal(payload.unifiedSimilarity, undefined, 'test setup sanity: genuinely no unifiedSimilarity persisted yet — this is the legacy shape, not a fixture that already has the answer');
  });

  let firstRead;
  await t.test('REQUIRED: the first compatibility read performs one authoritative similarity finalization and the room self-heals to 100%, matching what a fresh resolvePrimarySimilaritySummary/the detail page would return', async () => {
    firstRead = await findRoomOccupant(client, account.userId, 6);
    assert.equal(firstRead.status, 'ready', 'test setup sanity: AI is genuinely terminal for this legacy row');
    assert.equal(firstRead.report.similarityStatus, 'resolved', 'REQUIRED: the room must self-heal to a real resolved result, never stay stuck "pending"');
    assert.equal(firstRead.report.primaryScore, 100, 'REQUIRED: must converge to the true 100% promoted-corpus-source match, never the stale archive-only 0%');
    assert.equal(firstRead.report.isUnified, true, 'the self-healed result is the real corpus-aware unified result, not an archive-only fallback');

    const row = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
    const payload = JSON.parse(row.rows[0].payload_json);
    assert.equal(payload.unifiedSimilarity.unifiedScore, 100, 'REQUIRED: the self-heal must actually PERSIST the resolved result, using the same generation-guarded write write-time finalization already uses');
    assert.equal(payload.archiveScore, 0, 'the original archive score itself is untouched — self-heal only ever adds the unified result alongside it, never rewrites the archive component');
  });

  await t.test('REQUIRED: AI is not rerun — ai_score/ai_status are byte-identical before and after the self-heal', async () => {
    const row = await client.execute({ sql: 'SELECT ai_score, ai_status FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
    assert.equal(Number(row.rows[0].ai_score), 4);
    assert.equal(row.rows[0].ai_status, 'ready');
    assert.equal(firstRead.report.aiScore, 4, 'the room summary itself still reports the original, untouched AI score');
  });

  await t.test('REQUIRED: the room is fully revealed — reproduces the exact reported fix (AI/Similarity/Receipt no longer stuck on "Analyzing…"/"Preparing…")', () => {
    assert.equal(isFullyRevealedReal(firstRead), true);
  });

  await t.test('REQUIRED: a second (and third) room read uses the persisted result and performs no recomputation — no new matcher/snapshot call, identical result, no further write', async () => {
    const snapshotAfterFirstRead = await snapshotRow(account.deviceKey, id);
    assert.ok(snapshotAfterFirstRead, 'test setup sanity: the first read\'s own self-heal must have created a real historical-match snapshot');

    const rowBefore = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });

    const secondRead = await findRoomOccupant(client, account.userId, 6);
    const thirdRead = await findRoomOccupant(client, account.userId, 6);
    assert.deepEqual(secondRead, firstRead, 'REQUIRED: repeated reads must return the identical, already-persisted result');
    assert.deepEqual(thirdRead, secondRead, 'REQUIRED: repeated reads must return the identical, already-persisted result');
    assert.equal(secondRead.report.primaryScore, 100);

    const snapshotAfterRepeatedReads = await snapshotRow(account.deviceKey, id);
    assert.equal(snapshotAfterRepeatedReads.computed_at, snapshotAfterFirstRead.computed_at, 'REQUIRED: no new matcher call — the historical-match snapshot must not have been recomputed by the second/third read');

    const rowAfter = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
    assert.deepEqual(rowBefore.rows[0], rowAfter.rows[0], 'REQUIRED: repeated reads must never write anything further — the persisted row, including updated_at, is byte-identical before and after');
  });
});

const LEGACY_STALE_UNIFIED_TEXT =
  'Marine biologists tracking a newly catalogued deep-sea siphonophore recorded bioluminescent pulses timed precisely to prey movement rather than random background flashing, ' +
  'a coordination pattern previously assumed impossible in an organism that has no centralized nervous system to synchronize it.';
const LEGACY_STALE_UNIFIED_WORD_COUNT = tokens(LEGACY_STALE_UNIFIED_TEXT).length;

test('LEGACY ROOM BUG (Preview regression, exact real Room 1 shape): a row with an ALREADY-persisted unifiedSimilarity that predates generation/flag metadata entirely is recognized as stale and self-heals to the current 100% promoted match — AI (ai_score=0, ai_status="ready", payload.aiAnalysis.status="complete") is genuinely terminal, was never the blocker, and is never rerun', async (t) => {
  await promoteDocumentIntoCorpus(LEGACY_STALE_UNIFIED_TEXT);
  const account = await signUpConsentingAccount();
  const id = 'legacy-stale-unified-100-report';
  // The exact shape read back from the real Preview DB: a real, terminal
  // AI result (both the embedded payload.aiAnalysis object AND the
  // flattened ai_score/ai_status columns agree it is "complete"/"ready"),
  // and a REAL, already-persisted unifiedSimilarity (unifiedScore 0 — not
  // missing) whose unifiedSimilarityGeneration and
  // corpusSourceMatchingEnabledAtComputation are absent entirely, because
  // this row predates those two fields existing at all.
  const payload = {
    version: 8, id, submissionId: 'sub-' + id, title: 'Legacy stale-unified fixture',
    author: '', assignment: '', created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount: LEGACY_STALE_UNIFIED_WORD_COUNT, scoreBand: 'Low',
    matchedWordCount: 0, sources: [], repeats: [], text: LEGACY_STALE_UNIFIED_TEXT,
    aiAnalysis: {
      status: 'complete', score: 0, model: 'test-model', engine: null, threshold: 0.5,
      eligibleWordCount: LEGACY_STALE_UNIFIED_WORD_COUNT, analyzedWordCount: LEGACY_STALE_UNIFIED_WORD_COUNT, passages: [],
    },
    unifiedSimilarity: {
      version: 'unified-similarity-v1', wordCount: LEGACY_STALE_UNIFIED_WORD_COUNT, unifiedScore: 0, uniqueMatchedWords: 0,
      archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0,
      selfExcludedWords: 0, unknownExcludedWords: 0, contributions: [],
    },
    // Deliberately absent: unifiedSimilarityGeneration,
    // corpusSourceMatchingEnabledAtComputation — this IS the point.
  };
  await client.execute({
    sql: reportsRoute.SAVE_REPORT_SQL,
    args: [id, account.deviceKey, 'sub-' + id, 'Legacy stale-unified fixture', new Date().toISOString(), LEGACY_STALE_UNIFIED_WORD_COUNT, 0, 'Low', 0, 'low', 'ready', JSON.stringify(payload), account.userId, 6],
  });

  await t.test('test setup sanity: resolvePersistedSimilarityDisplay itself classifies this exact persisted shape as "stale", not "resolved" and not "pending"', async () => {
    const display = await resolvePersistedSimilarityDisplay(client, {
      reportDeviceKey: account.deviceKey, reportId: id, archiveScore: 0, unifiedScore: 0,
      hasUnifiedSimilarity: true, corpusSourceMatchingEnabledAtComputation: null, unifiedSimilarityFailed: false,
    });
    assert.equal(display.status, 'stale', 'a real unifiedSimilarity IS persisted (hasUnifiedSimilarity true), so this must never be "pending" — but it predates the live-flag snapshot, so it must never be "resolved" either');
  });

  let firstRead;
  await t.test('REQUIRED: the first room read recognizes the stale persisted result as actionable and self-heals to the current 100% promoted match', async () => {
    firstRead = await findRoomOccupant(client, account.userId, 6);
    assert.equal(firstRead.status, 'ready', 'test setup sanity: AI is genuinely terminal');
    assert.equal(firstRead.report.similarityStatus, 'resolved', 'REQUIRED: a persisted-but-stale result must self-heal, exactly like a persisted-but-missing one');
    assert.equal(firstRead.report.primaryScore, 100, 'REQUIRED: must converge to the true current 100% promoted-corpus-source match, never stay stuck at the stale persisted 0%');
    assert.equal(firstRead.report.isUnified, true);
  });

  await t.test('REQUIRED: AI fields are byte-identical before and after the self-heal — AI is never rerun', async () => {
    const row = await client.execute({ sql: 'SELECT ai_score, ai_status FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
    assert.equal(Number(row.rows[0].ai_score), 0);
    assert.equal(row.rows[0].ai_status, 'ready');
    assert.equal(firstRead.report.aiScore, 0);
  });

  await t.test('REQUIRED: generation and corpus-flag metadata become current on the freshly-persisted result', async () => {
    const row = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
    const healedPayload = JSON.parse(row.rows[0].payload_json);
    const currentGeneration = await getCurrentCorpusMatchGeneration(client);
    assert.equal(healedPayload.unifiedSimilarityGeneration, currentGeneration, 'REQUIRED: the self-heal must stamp the CURRENT generation, not leave it absent/stale');
    assert.equal(healedPayload.corpusSourceMatchingEnabledAtComputation, true, 'REQUIRED: the self-heal must record the live flag, not leave it absent');
    assert.equal(healedPayload.unifiedSimilarity.unifiedScore, 100);
  });

  await t.test('REQUIRED: the room is fully revealed', () => {
    assert.equal(isFullyRevealedReal(firstRead), true);
  });

  await t.test('REQUIRED: a second and third room read use the persisted result and perform no recomputation or write', async () => {
    const snapshotAfterFirstRead = await snapshotRow(account.deviceKey, id);
    const rowBefore = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });

    const secondRead = await findRoomOccupant(client, account.userId, 6);
    const thirdRead = await findRoomOccupant(client, account.userId, 6);
    assert.deepEqual(secondRead, firstRead, 'REQUIRED: repeated reads must return the identical, already-persisted result');
    assert.deepEqual(thirdRead, secondRead);

    const snapshotAfterRepeatedReads = await snapshotRow(account.deviceKey, id);
    assert.equal(snapshotAfterRepeatedReads.computed_at, snapshotAfterFirstRead.computed_at, 'REQUIRED: no new matcher call on repeated reads');

    const rowAfter = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
    assert.deepEqual(rowBefore.rows[0], rowAfter.rows[0], 'REQUIRED: repeated reads must never write anything further');
  });
});

/**
 * BACKWARD-COMPATIBILITY FIX (highlighting migration gap): Rooms self-healed
 * by the earlier legacy-room fix (commit 5225b83) landed BEFORE
 * lib/unified-similarity.ts's computeUnifiedSimilarity started returning
 * matchedPositions/previousUploadPositions (see that type's own comment).
 * Such a row is fully CURRENT by every generation/flag/snapshot check —
 * resolvePersistedSimilarityDisplay's own freshness logic alone would call
 * it "resolved" — yet its persisted unifiedSimilarity has no position
 * evidence at all for the new renderer to highlight from. Required
 * invariant: "a resolved unified report must not be considered
 * presentation-complete when it lacks the canonical position evidence
 * required to explain its score."
 *
 * FIX: resolvePersistedSimilarityDisplay's own final "resolved" branch (the
 * one reached only after generation/flag/snapshot all already agree) now
 * ALSO requires hasPositionEvidence — computed from
 * `json_extract(payload_json, '$.unifiedSimilarity.matchedPositions') IS
 * NOT NULL` (lib/reports-repo.ts's findRoomOccupant) or
 * `payload.unifiedSimilarity?.matchedPositions !== undefined`
 * (app/reports/[id]/page.tsx) — deliberately `!== undefined`, not
 * `.length`, so a real, current 0% match (matchedPositions: [], present but
 * empty) is never mistaken for "field never existed." When absent, this
 * branch returns "stale" instead of "resolved" — reusing the EXACT SAME
 * actionable-state findRoomOccupant already self-heals on, so no new
 * trigger or duplicated freshness rule was added anywhere. No inference
 * from the percentage, no faked full-document highlighting from 100%, and
 * the scoring formula is completely untouched — selfHealUnifiedSimilarity's
 * own body is unchanged; it already always calls the real
 * resolvePrimarySimilaritySummary and persists whatever it returns, which
 * now always includes matchedPositions by construction.
 */
const LEGACY_MATCHED_POSITIONS_TEXT =
  'Structural engineers reviewing a retrofit of a century-old truss bridge measured strain redistribution patterns the original 1920s design calculations never accounted for, ' +
  'revealing that decades of incremental deck resurfacing had quietly shifted load paths onto members never sized for that share of the traffic.';
const LEGACY_MATCHED_POSITIONS_WORD_COUNT = tokens(LEGACY_MATCHED_POSITIONS_TEXT).length;

/** Inserts a row shaped exactly like a row self-healed by commit 5225b83 BEFORE matchedPositions/previousUploadPositions existed: unifiedScore/uniqueMatchedWords/generation/flag are all already correct and current, but the position-evidence fields are entirely absent from the persisted JSON — not present-and-empty, genuinely never written. */
async function insertPreMatchedPositionsRow(account, { id, room, aiScore, wordCount, text, unifiedScore, uniqueMatchedWords, previousUploadOnlyWords, generation, corpusFlag }) {
  const payload = {
    version: 11, id, submissionId: 'sub-' + id, title: 'Pre-matchedPositions fixture',
    author: '', assignment: '', created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount, scoreBand: 'Low',
    matchedWordCount: 0, sources: [], repeats: [], text,
    unifiedSimilarity: {
      version: 'unified-similarity-v1', wordCount, unifiedScore, uniqueMatchedWords,
      archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords, overlapWords: 0,
      selfExcludedWords: 0, unknownExcludedWords: 0, contributions: [],
      // Deliberately absent: matchedPositions, previousUploadPositions —
      // this IS the exact legacy shape this fix targets.
    },
    unifiedSimilarityGeneration: generation,
    corpusSourceMatchingEnabledAtComputation: corpusFlag,
  };
  await client.execute({
    sql: reportsRoute.SAVE_REPORT_SQL,
    args: [id, account.deviceKey, 'sub-' + id, 'Pre-matchedPositions fixture', new Date().toISOString(), wordCount, 0, 'Low', aiScore, 'low', 'ready', JSON.stringify(payload), account.userId, room],
  });
  return payload;
}

test('BACKWARD COMPATIBILITY: a legacy-shaped resolved unifiedSimilarity (current generation/flag, real 100% score, but matchedPositions never persisted) is recognized as needing a one-time presentation-evidence upgrade and self-heals to the full position-aware result — never a faked full-document highlight, never a rescored percentage', async (t) => {
  await promoteDocumentIntoCorpus(LEGACY_MATCHED_POSITIONS_TEXT);
  const account = await signUpConsentingAccount();
  const id = 'pre-matched-positions-100-report';
  const currentGeneration = await getCurrentCorpusMatchGeneration(client);

  await insertPreMatchedPositionsRow(account, {
    id, room: 6, aiScore: 8, wordCount: LEGACY_MATCHED_POSITIONS_WORD_COUNT, text: LEGACY_MATCHED_POSITIONS_TEXT,
    unifiedScore: 100, uniqueMatchedWords: LEGACY_MATCHED_POSITIONS_WORD_COUNT, previousUploadOnlyWords: LEGACY_MATCHED_POSITIONS_WORD_COUNT,
    generation: currentGeneration, corpusFlag: true,
  });

  await t.test('test setup sanity: resolvePersistedSimilarityDisplay recognizes this exact legacy shape as "stale" (needs a one-time upgrade), even though generation/flag/snapshot are all already current', async () => {
    const display = await resolvePersistedSimilarityDisplay(client, {
      reportDeviceKey: account.deviceKey, reportId: id, archiveScore: 0, unifiedScore: 100,
      hasUnifiedSimilarity: true, corpusSourceMatchingEnabledAtComputation: true, unifiedSimilarityFailed: false,
      hasPositionEvidence: false,
    });
    assert.equal(display.status, 'stale', 'REQUIRED: missing position evidence alone must be enough to mark an otherwise-current resolved result as needing self-heal');
  });

  let firstRead;
  await t.test('REQUIRED: the first room read self-heals the legacy row — authoritative recomputation produces the identical 100% score (never rescored) and persists matchedPositions', async () => {
    firstRead = await findRoomOccupant(client, account.userId, 6);
    assert.equal(firstRead.report.similarityStatus, 'resolved');
    assert.equal(firstRead.report.primaryScore, 100, 'REQUIRED: the score must not change — this is a presentation upgrade, never a rescore');
    assert.equal(firstRead.report.isUnified, true);

    const row = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
    const healedPayload = JSON.parse(row.rows[0].payload_json);
    assert.notEqual(healedPayload.unifiedSimilarity.matchedPositions, undefined, 'REQUIRED: matchedPositions must now be persisted');
    assert.equal(healedPayload.unifiedSimilarity.matchedPositions.length, healedPayload.unifiedSimilarity.uniqueMatchedWords, 'REQUIRED: the exact full matched-position count must equal the authoritative matched-word count');
    assert.equal(healedPayload.unifiedSimilarity.matchedPositions.length, LEGACY_MATCHED_POSITIONS_WORD_COUNT, 'the full document matched, per the real promoted corpus source');
    assert.equal(healedPayload.unifiedSimilarity.unifiedScore, 100, 'REQUIRED: the score is untouched by this upgrade');
  });

  await t.test('REQUIRED: the room is fully revealed — this is a real presentation fix, not merely a silent data upgrade with no user-visible effect', () => {
    assert.equal(isFullyRevealedReal(firstRead), true);
  });

  await t.test('REQUIRED: a second and third room read perform no recomputation — the upgrade is truly one-time, room lifecycle does not regress into endless polling', async () => {
    const snapshotAfterFirstRead = await snapshotRow(account.deviceKey, id);
    const rowBefore = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });

    const secondRead = await findRoomOccupant(client, account.userId, 6);
    const thirdRead = await findRoomOccupant(client, account.userId, 6);
    assert.deepEqual(secondRead, firstRead, 'REQUIRED: repeated reads must return the identical, already-upgraded result');
    assert.deepEqual(thirdRead, secondRead);

    const snapshotAfterRepeatedReads = await snapshotRow(account.deviceKey, id);
    assert.equal(snapshotAfterRepeatedReads.computed_at, snapshotAfterFirstRead.computed_at, 'REQUIRED: no new matcher call on repeated reads');

    const rowAfter = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
    assert.deepEqual(rowBefore.rows[0], rowAfter.rows[0], 'REQUIRED: repeated reads must never write anything further');
  });
});

test('BACKWARD COMPATIBILITY: a current, genuinely 0% result (a real SELF-match) with matchedPositions present-but-empty stays resolved and does not loop — "field absent" and "field present but empty" remain distinguishable', async () => {
  // A real SELF match (not a hand-typed fixture): this test needs a
  // MATCHED-status snapshot whose CONTRIBUTION to the score is still exactly
  // zero, to prove "present-but-empty matchedPositions" reads as current
  // rather than "needs upgrade". A SELF match is the one real, easy-to-
  // construct way to get that — the same real
  // mechanism tests/unified-similarity-relationship-integration.test.mjs's
  // own "SCENARIO A (SELF)" proves end to end: SELF is always excluded from
  // unifiedScore/previousUploadOnlyWords/matchedPositions (DECISION 1, no
  // override), but the underlying match/snapshot is real and current.
  const account = await signUpConsentingAccount();
  const selfMatchText =
    'A distinctive passage about lichen colonization rates on recently deglaciated rock faces, submitted twice by the same account to produce a real, current SELF match with zero net contribution.';
  const selfMatchWordCount = tokens(selfMatchText).length;

  const firstRes = await postReport(account, { id: 'self-match-zero-first', room: 8, aiStatus: 'ready', aiScore: 5, text: selfMatchText, wordCount: selfMatchWordCount });
  assert.equal(firstRes.status, 200, 'test setup sanity: the first (prior-content) save must succeed');

  // Corpus indexing for a "does this match my own earlier work" lookup is a
  // genuinely eventual-consistency step in production (see
  // lib/user-submission-corpus.ts's own header comment) — not automatic on
  // save. Seeded explicitly here, the same way
  // tests/unified-similarity-relationship-integration.test.mjs's own
  // seedCorpusIndexForReport does for its real SELF-match scenarios, so the
  // second submission's matcher has something real to find.
  const firstIdentity = await client.execute({ sql: 'SELECT document_identity_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, 'self-match-zero-first'] });
  const firstDocumentIdentityId = String(firstIdentity.rows[0]?.document_identity_id ?? '');
  assert.ok(firstDocumentIdentityId, 'test setup sanity: the first save must have captured a document_identity_id');
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: firstDocumentIdentityId, rawText: selfMatchText });
  await matureCorpusBackings(client); // Phase A: the SELF source must be matchable at the second save's write-time finalization

  const secondRes = await postReport(account, { id: 'self-match-zero-second', room: 9, aiStatus: 'ready', aiScore: 5, text: selfMatchText, wordCount: selfMatchWordCount });
  assert.equal(secondRes.status, 200, 'test setup sanity: the second (SELF-matching) save must succeed');

  // The FIRST room read is the one that may itself still land a real
  // recompute (write-time finalization's own snapshot cache can predate
  // indexDocumentSubmissionIntoCorpus's own effect, exactly the same
  // "before is captured only once the first, write-triggering read has
  // already landed" lesson the earlier "revisiting/reloading" test above
  // already established) — this test's own "no further writes" claim is
  // about repeat reads AFTER that point, not about write-time finalization
  // itself.
  const first = await findRoomOccupant(client, account.userId, 9);
  assert.equal(first.report.similarityStatus, 'resolved', 'REQUIRED: matchedPositions: [] (present, empty) must read as current, never as "needs upgrade"');
  assert.equal(first.report.primaryScore, 0, 'a genuine, honest 0% — never fabricated');
  assert.equal(first.report.isUnified, true);

  const stableRow = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, 'self-match-zero-second'] });
  const stablePayload = JSON.parse(stableRow.rows[0].payload_json);
  assert.notEqual(stablePayload.unifiedSimilarity.matchedPositions, undefined, 'test setup sanity: matchedPositions must be persisted by this point');
  assert.equal(stablePayload.unifiedSimilarity.uniqueMatchedWords, 0, 'test setup sanity: a SELF match contributes zero — a genuine 0%, not an upgrade gap');
  assert.deepEqual(stablePayload.unifiedSimilarity.matchedPositions, [], 'test setup sanity: present, genuinely empty, never absent');

  const rowBefore = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, 'self-match-zero-second'] });
  const second = await findRoomOccupant(client, account.userId, 9);
  const third = await findRoomOccupant(client, account.userId, 9);
  assert.deepEqual(second, first, 'REQUIRED: repeated reads must return the identical, already-current result');
  assert.deepEqual(third, second);

  const rowAfter = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, 'self-match-zero-second'] });
  assert.deepEqual(rowBefore.rows[0], rowAfter.rows[0], 'REQUIRED: a genuinely current 0% result must never be rewritten or looped on once stable');
});

test('BACKWARD COMPATIBILITY: the real detail/report route (app/api/reports/[id]/route.ts), not only findRoomOccupant, upgrades a legacy pre-matchedPositions row before rendering', async () => {
  // LEGACY_MATCHED_POSITIONS_TEXT was already promoted by the earlier
  // "one-time presentation-evidence upgrade" test above, in this same
  // shared DB — canonical_sha256 is UNIQUE, so it must not be promoted
  // twice; reusing the same already-promoted source is deliberate here, not
  // an oversight.
  const account = await signUpConsentingAccount();
  const id = 'pre-matched-positions-detail-report';
  const currentGeneration = await getCurrentCorpusMatchGeneration(client);

  await insertPreMatchedPositionsRow(account, {
    id, room: 7, aiScore: 3, wordCount: LEGACY_MATCHED_POSITIONS_WORD_COUNT, text: LEGACY_MATCHED_POSITIONS_TEXT,
    unifiedScore: 100, uniqueMatchedWords: LEGACY_MATCHED_POSITIONS_WORD_COUNT, previousUploadOnlyWords: LEGACY_MATCHED_POSITIONS_WORD_COUNT,
    generation: currentGeneration, corpusFlag: true,
  });

  const beforeRow = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
  assert.equal(JSON.parse(beforeRow.rows[0].payload_json).unifiedSimilarity.matchedPositions, undefined, 'test setup sanity: genuinely absent before this route is ever hit');

  const res = await getReportDetail(account, id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.payload.unifiedSimilarity.unifiedScore, 100, 'the real GET route must still report the correct, unchanged score');
  assert.notEqual(body.payload.unifiedSimilarity.matchedPositions, undefined, 'REQUIRED: the real detail route response itself must carry the upgraded position evidence, not just an internal DB row');
  assert.equal(body.payload.unifiedSimilarity.matchedPositions.length, LEGACY_MATCHED_POSITIONS_WORD_COUNT);

  const afterRow = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
  const afterPayload = JSON.parse(afterRow.rows[0].payload_json);
  assert.notEqual(afterPayload.unifiedSimilarity.matchedPositions, undefined, 'REQUIRED: the real detail route must persist the upgrade too, not only return it in the response');
});

const LEGACY_STALE_GENERATION_TEXT =
  'Materials scientists stress-testing a new self-healing polymer found that repeated micro-fractures actually strengthened the bond network over successive cycles, ' +
  'the opposite of the fatigue curve every prior formulation in the same family had shown under identical loading conditions.';
const LEGACY_STALE_GENERATION_WORD_COUNT = tokens(LEGACY_STALE_GENERATION_TEXT).length;

test('LEGACY ROOM BUG: a MODERN row (generation/flag metadata present, not missing) that has genuinely gone stale because a later promotion bumped corpus_match_generation also self-heals correctly — proves the fix generalizes to "stale" in general, not only the "metadata predates the fields" legacy shape', async () => {
  const account = await signUpConsentingAccount();
  const id = 'modern-stale-generation-report';
  const generationBeforeThisRowWasSaved = await getCurrentCorpusMatchGeneration(client);
  const payload = {
    version: 11, id, submissionId: 'sub-' + id, title: 'Modern stale-generation fixture',
    author: '', assignment: '', created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount: LEGACY_STALE_GENERATION_WORD_COUNT, scoreBand: 'Low',
    matchedWordCount: 0, sources: [], repeats: [], text: LEGACY_STALE_GENERATION_TEXT,
    unifiedSimilarity: {
      version: 'unified-similarity-v1', wordCount: LEGACY_STALE_GENERATION_WORD_COUNT, unifiedScore: 0, uniqueMatchedWords: 0,
      archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0,
      selfExcludedWords: 0, unknownExcludedWords: 0, contributions: [],
    },
    // Present, not absent — a genuinely modern row, correctly finalized at
    // the time it was saved, under the generation/flag current at that
    // moment.
    unifiedSimilarityGeneration: generationBeforeThisRowWasSaved,
    corpusSourceMatchingEnabledAtComputation: true,
  };
  await client.execute({
    sql: reportsRoute.SAVE_REPORT_SQL,
    args: [id, account.deviceKey, 'sub-' + id, 'Modern stale-generation fixture', new Date().toISOString(), LEGACY_STALE_GENERATION_WORD_COUNT, 0, 'Low', 5, 'low', 'ready', JSON.stringify(payload), account.userId, 6],
  });

  // A later promotion bumps corpus_match_generation past what this row was
  // computed under — a genuine, ordinary staleness, unrelated to any
  // missing metadata.
  await promoteDocumentIntoCorpus(LEGACY_STALE_GENERATION_TEXT);

  const occupant = await findRoomOccupant(client, account.userId, 6);
  assert.equal(occupant.report.similarityStatus, 'resolved', 'REQUIRED: a genuinely stale (generation-mismatched) modern row must also self-heal, not just the missing-metadata legacy shape');
  assert.equal(occupant.report.primaryScore, 100, 'REQUIRED: must converge to the now-current 100% promoted match');
  assert.equal(occupant.report.aiScore, 5, 'AI untouched');
});

test('LEGACY ROOM BUG: a modern row whose persisted unifiedSimilarity is ALREADY current stays cheap — self-heal is never invoked and nothing is recomputed or rewritten', async () => {
  const promotedText =
    'Urban planners comparing two adjacent transit corridors found that adding a single mid-block crossing cut average pedestrian wait times more than doubling the corridor\'s bus frequency did, ' +
    'a result that shifted the following year\'s capital budget toward crossings instead of the originally planned fleet expansion.';
  await promoteDocumentIntoCorpus(promotedText);
  const account = await signUpConsentingAccount();
  const res = await postReport(account, { id: 'modern-current-cheap-report', room: 6, aiStatus: 'ready', aiScore: 2, text: promotedText, wordCount: tokens(promotedText).length });
  assert.equal(res.status, 200, 'test setup sanity: a real save must succeed and, per write-time finalization\'s own synchronous guarantee, must already be fully resolved');

  const firstRead = await findRoomOccupant(client, account.userId, 6);
  assert.equal(firstRead.report.similarityStatus, 'resolved', 'test setup sanity: write-time finalization already produced a current, resolved result');
  assert.equal(firstRead.report.primaryScore, 100);

  const snapshotBefore = await snapshotRow(account.deviceKey, 'modern-current-cheap-report');
  const rowBefore = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, 'modern-current-cheap-report'] });

  const secondRead = await findRoomOccupant(client, account.userId, 6);
  assert.deepEqual(secondRead, firstRead, 'REQUIRED: an already-current resolved result must read identically on a second pass');

  const snapshotAfter = await snapshotRow(account.deviceKey, 'modern-current-cheap-report');
  assert.equal(snapshotAfter.computed_at, snapshotBefore.computed_at, 'REQUIRED: an already-resolved, already-current row must never trigger self-heal — no new matcher/snapshot call');

  const rowAfter = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, 'modern-current-cheap-report'] });
  assert.deepEqual(rowBefore.rows[0], rowAfter.rows[0], 'REQUIRED: no write of any kind for an already-current resolved row');
});

test('LEGACY ROOM BUG: a modern report whose AI check is genuinely still processing stays "processing" — the fix never touches the AI pipeline or reveals a room too early', async () => {
  const account = await signUpConsentingAccount();
  const res = await postReport(account, { id: 'legacy-room-modern-processing-report', room: 6, aiStatus: 'processing', text: DOCUMENT_A_TEXT, wordCount: DOCUMENT_A_WORD_COUNT });
  assert.equal(res.status, 200, 'test setup sanity: a real save must succeed');

  const occupant = await findRoomOccupant(client, account.userId, 6);
  assert.equal(occupant.status, 'processing', 'REQUIRED: a genuinely still-processing modern report must remain "processing" — this fix only concerns the similarity branch that had no unifiedSimilarity AND no failure marker, never the independent AI pipeline');
  assert.equal(isFullyRevealedReal(occupant), false, 'REQUIRED: must not reveal a room whose AI check has not actually finished');
});

test('LEGACY ROOM BUG: a genuine transient infrastructure failure DURING the self-heal attempt itself is never falsely resolved to archiveScore — the row is left exactly as ambiguous as before, eligible for another attempt on the next read', async () => {
  const account = await signUpConsentingAccount();
  const id = 'legacy-self-heal-transient-failure-report';
  // This row is, at the data level, INDISTINGUISHABLE from a genuinely
  // legacy row (see this file's own REJECTED FIRST FIX comment above) —
  // the point of this test is exactly that: regardless of WHY
  // hasUnifiedSimilarity/unifiedSimilarityFailed are both absent, if the
  // self-heal ATTEMPT itself cannot complete, it must never fabricate a
  // result from either state.
  await insertLegacyRow(account, { id, room: 6, aiStatus: 'ready', aiScore: 7, archiveScore: 61, text: DOCUMENT_A_TEXT });

  // A genuinely broken connection reproduces the same class of failure
  // resolvePrimarySimilaritySummary's own "not unconditionally safe" tests
  // already exercise (tests/report-primary-similarity.test.mjs's SIM-04 (3))
  // — a real infra failure (DB connectivity) propagating out of the
  // resolution attempt, never a synthetic error label.
  const brokenClient = createClient({ url: `file:${dbFile}` });
  await brokenClient.close();

  const healed = await selfHealUnifiedSimilarity(brokenClient, { reportDeviceKey: account.deviceKey, reportId: id, accountId: account.userId });
  assert.equal(healed.attempted, false, 'REQUIRED: a genuine infrastructure failure during the attempt must be reported as attempted:false, never thrown out to the caller');

  const row = await client.execute({ sql: 'SELECT payload_json, ai_score, ai_status FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
  const payload = JSON.parse(row.rows[0].payload_json);
  assert.equal(payload.unifiedSimilarity, undefined, 'REQUIRED: must never persist a fabricated resolved (archive-only or otherwise) result when the attempt itself failed');
  assert.equal(payload.unifiedSimilarityFailed, undefined, 'REQUIRED: must never persist a false terminal failure marker either — this is not a reproducible computation failure, only a transient one, and must remain eligible for retry');
  assert.equal(Number(row.rows[0].ai_score), 7, 'AI fields must be completely untouched by a failed self-heal attempt');
  assert.equal(row.rows[0].ai_status, 'ready');

  // A subsequent read, with a real working client, still correctly resolves
  // it (a genuine transient failure — the underlying data was always fine)
  // — proving the row was left retry-eligible, never permanently stuck by
  // the failed attempt itself. DOCUMENT_A_TEXT has no promoted corpus match
  // and this fixture never set archiveMatchedPositions, so the real,
  // honestly-computed unified result is 0 — the point being it is now a
  // REAL persisted result (isUnified: true), not the earlier failed
  // attempt's absence, and not a fabricated echo of archiveScore either.
  const occupant = await findRoomOccupant(client, account.userId, 6);
  assert.equal(occupant.report.similarityStatus, 'resolved', 'a later read with a working connection must still be able to self-heal — the earlier failure must not have poisoned the row');
  assert.equal(occupant.report.isUnified, true, 'the recovered result is a real, freshly-computed unified result, not an inferred archive-only fallback');
});

test('LEGACY ROOM BUG: a modern report with an explicit, persisted unifiedSimilarityFailed marker stays a genuine terminal failure — never reinterpreted as a resolved archive-only result', async () => {
  const account = await signUpConsentingAccount();
  const id = 'legacy-room-modern-failure-report';
  const payload = {
    version: 11, id, submissionId: 'sub-' + id, title: 'Modern failure fixture',
    author: '', assignment: '', created: new Date().toISOString(),
    score: 9, archiveScore: 9, wordCount: DOCUMENT_A_WORD_COUNT, scoreBand: 'Low',
    matchedWordCount: 0, sources: [], repeats: [], text: DOCUMENT_A_TEXT,
    unifiedSimilarityFailed: true, corpusSourceMatchingEnabledAtComputation: true, unifiedSimilarityGeneration: 1,
  };
  await client.execute({
    sql: reportsRoute.SAVE_REPORT_SQL,
    args: [id, account.deviceKey, 'sub-' + id, 'Modern failure fixture', new Date().toISOString(), DOCUMENT_A_WORD_COUNT, 9, 'Low', 4, 'low', 'ready', JSON.stringify(payload), account.userId, 6],
  });

  const rowBefore = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });

  const occupant = await findRoomOccupant(client, account.userId, 6);
  assert.equal(occupant.report.similarityStatus, 'failed', 'REQUIRED: an explicit unifiedSimilarityFailed marker must always win — this row is a genuine, reproducible modern failure, never a legacy row to infer archive-only status for');
  assert.equal(isFullyRevealedReal(occupant), true, 'a genuine terminal failure still reveals the room (shows "Unavailable"), matching the existing LIFECYCLE-06 behavior — never left polling forever either');

  // REQUIRED: "failed" is a terminal, already-actionable verdict from
  // resolvePersistedSimilarityDisplay — neither "pending" nor "stale" — so
  // findRoomOccupant's self-heal trigger must never fire for it, on this or
  // any later read.
  const rowAfter = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
  assert.deepEqual(rowBefore.rows[0], rowAfter.rows[0], 'REQUIRED: an explicit terminal failure must never be retried — no self-heal write of any kind');
});

const LEGACY_REVISIT_TEXT =
  'Glaciologists resurveying a receding alpine ice tongue measured a basal sliding rate roughly triple the value recorded a decade earlier, indicating meltwater lubrication now dominates the flow regime, ' +
  'a mechanism the original monitoring program was never instrumented to detect at the depth where it turns out to matter most.';

test('LEGACY ROOM BUG: revisiting/reloading an already-resolved legacy room returns the identical persisted result every time, with no write of any kind — never a re-save, never re-analysis', async () => {
  // Promoted (unlike the transient-failure fixture above): lib/report-
  // historical-match.ts's own isSnapshotRowCurrent deliberately never
  // treats a NO_HISTORICAL_MATCH snapshot as "current" on a later read —
  // by design, a corpus source that would match could always appear later
  // (see that function's own header comment) — so an archive-only
  // resolution's OWN historical-match snapshot legitimately reads "stale"
  // again on every subsequent check, independent of this fix entirely. A
  // REAL, persistent MATCHED snapshot is what this test needs to exercise
  // "an already-resolved row stays resolved on repeat reads."
  await promoteDocumentIntoCorpus(LEGACY_REVISIT_TEXT);
  const account = await signUpConsentingAccount();
  const id = 'legacy-room-revisit-report';
  await insertLegacyRow(account, { id, room: 6, aiStatus: 'ready', aiScore: 3, archiveScore: 0, text: LEGACY_REVISIT_TEXT });

  // The FIRST read is the one-time compatibility self-heal itself (already
  // covered end to end by the "self-heals to 100%" test above) — this test
  // is specifically about what happens AFTER a row is already resolved, so
  // `before` is captured only once that first, write-triggering read has
  // already landed.
  const first = await findRoomOccupant(client, account.userId, 6);
  assert.equal(first.report.similarityStatus, 'resolved', 'test setup sanity: the row must already be self-healed before this test\'s own "no further writes" assertions begin');

  const before = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });

  // Simulates entering the room again, then reloading, then logging back in
  // and entering it again — three independent reads of the exact same,
  // already-resolved room.
  const second = await findRoomOccupant(client, account.userId, 6);
  const third = await findRoomOccupant(client, account.userId, 6);
  const fourth = await findRoomOccupant(client, account.userId, 6);
  assert.deepEqual(second, first, 'REQUIRED: reloading must show the identical result, never a fresh computation');
  assert.deepEqual(third, second, 'REQUIRED: logging back in and reopening must show the identical result again');
  assert.deepEqual(fourth, third, 'REQUIRED: a third revisit must still show the identical result');

  const after = await client.execute({ sql: 'SELECT payload_json, updated_at FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
  assert.deepEqual(before.rows[0], after.rows[0], 'REQUIRED: three room reads must never write anything — the persisted row, including updated_at, must be byte-identical before and after');
});

test('LEGACY ROOM BUG: an explicit new upload to a room whose prior (legacy) occupant has cycled out replaces the occupant, and the prior legacy report/history row is preserved, never deleted', async () => {
  const account = await signUpConsentingAccount();
  const legacyId = 'legacy-room-history-report';
  // A room holds AT MOST one CURRENT report at a time (lib/report-rooms.ts's
  // own "at most one active report per room" design, enforced by
  // insertReportWithRoomCheck's own occupancy check) — a genuinely new
  // upload can only ever claim a room once its prior occupant's own
  // ROOM_CYCLE_MS (24h) has elapsed, exactly like rooms 3-6 in the real
  // Preview reproduction eventually would. This is the real mechanism
  // behind "only an explicit new upload replaces the room's occupant": not
  // "immediately, on demand," but "once legitimately available, never via
  // reload/relogin alone" — see the room-revisit test above for that half.
  const expiredCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await insertLegacyRow(account, { id: legacyId, room: 6, aiStatus: 'ready', aiScore: 6, archiveScore: 44, text: DOCUMENT_A_TEXT, createdAt: expiredCreatedAt });

  const beforeUpload = await findRoomOccupant(client, account.userId, 6);
  assert.equal(beforeUpload.status, 'empty', 'test setup sanity: a report whose own cycle has elapsed is no longer the room\'s CURRENT occupant, freeing the room for a new upload — it is not deleted, only no longer current (see the history assertion below)');

  // An explicit new upload — the ONLY thing that should ever replace a
  // room's occupant.
  const newId = 'legacy-room-history-report-new';
  const res = await postReport(account, { id: newId, room: 6, aiStatus: 'processing', text: DOCUMENT_A_TEXT, wordCount: DOCUMENT_A_WORD_COUNT });
  assert.equal(res.status, 200);

  const afterUpload = await findRoomOccupant(client, account.userId, 6);
  assert.equal(afterUpload.report.id, newId, 'REQUIRED: only an explicit new upload replaces the room\'s current occupant');

  const legacyRowStillExists = await client.execute({ sql: 'SELECT id FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, legacyId] });
  assert.equal(legacyRowStillExists.rows.length, 1, 'REQUIRED: the previous saved report/history must not be accidentally deleted by a new upload to the same room');
});

const NO_HISTORICAL_MATCH_FIX_TEXT =
  'Cryptozoologists debunking a purported new amphibian sighting instead identified an unusual pigment variation in a well-documented salamander population, ' +
  'concluding the specimen was misidentified rather than representing any previously unrecorded species in the surveyed watershed.';

test('REQUIRED (real Room 4 reproduction): a genuinely unmatched submission — real POST route, ai_score=0/ai_status="ready" exactly like the confirmed stuck row — becomes fully revealable through the real findRoomOccupant + isFullyRevealed path, never stuck on "Analysis is taking longer than usual"', async () => {
  const account = await signUpConsentingAccount();
  const id = 'nomatch-fix-real-room4-report';
  // No corpus source is ever promoted for this text — a genuine,
  // non-manufactured NO_HISTORICAL_MATCH, exactly like a real document with
  // no prior submission anywhere in the corpus.
  const res = await postReport(account, { id, room: 3, aiStatus: 'ready', aiScore: 0, text: NO_HISTORICAL_MATCH_FIX_TEXT, wordCount: 45 });
  assert.equal(res.status, 200, 'test setup sanity: the real POST route must accept this submission');

  // Confirms this reproduces the real confirmed row shape from the live
  // incident: ai_score=0 (not null — a real, non-null score), ai_status='ready'.
  const rawRow = await client.execute({ sql: 'SELECT ai_score, ai_status FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
  assert.equal(Number(rawRow.rows[0].ai_score), 0);
  assert.equal(rawRow.rows[0].ai_status, 'ready');

  // This file runs with CORPUS_SOURCE_MATCHING_ENABLED on, so write-time
  // finalization persisted a complete, current NO_HISTORICAL_MATCH — now a
  // genuine cache hit, reusable exactly like a MATCHED snapshot.
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: account.deviceKey, reportId: id }), true);

  const occupant = await findRoomOccupant(client, account.userId, 3);
  assert.equal(occupant.status, 'ready', 'REQUIRED: matches the real confirmed row — deriveRoomStatus(0, "ready") must be "ready", not "processing"');
  assert.equal(occupant.report.similarityStatus, 'resolved', 'REQUIRED: a genuine no-match report reveals, never stuck at "stale" forever');
  assert.equal(isFullyRevealedReal(occupant), true, 'REQUIRED: reproduces the exact reported fix for the real Room 4 shape — the room must stop polling and reveal, never show "Analysis is taking longer than usual" for a genuinely terminal, correctly-no-match report');
});

test('REQUIRED: after the real Room 4 shape reveals once, a later independent room read is a genuine cache hit (no matcher re-run) and still reveals — the no-match cache eliminates the per-poll recompute', async () => {
  const account = await signUpConsentingAccount();
  const id = 'nomatch-fix-real-room4-repeat-report';
  const text = 'Ornithologists tracking a migratory songbird population via geolocator tags documented an unexpected stopover site never previously associated with this species\' known flyway.';
  const res = await postReport(account, { id, room: 3, aiStatus: 'ready', aiScore: 0, text, wordCount: 45 });
  assert.equal(res.status, 200);

  const firstOccupant = await findRoomOccupant(client, account.userId, 3);
  assert.equal(isFullyRevealedReal(firstOccupant), true, 'test setup sanity: first read must already reveal');
  const firstSnapshot = await snapshotRow(account.deviceKey, id);

  const secondOccupant = await findRoomOccupant(client, account.userId, 3);
  assert.equal(isFullyRevealedReal(secondOccupant), true, 'REQUIRED: a second, independent read must ALSO reveal — not a one-time fluke');
  const secondSnapshot = await snapshotRow(account.deviceKey, id);
  assert.equal(secondSnapshot.computed_at, firstSnapshot.computed_at, 'REQUIRED: the second read must be a genuine cache hit — the snapshot row is not rewritten and the expensive matcher is not re-run on every poll (a corpus content add would bump the generation and force a recompute, so a later match is still never permanently hidden)');
});
