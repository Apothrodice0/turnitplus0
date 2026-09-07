import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import { resetReadRateForTest } from '../lib/rate-limit.ts';
import { bumpCorpusMatchGeneration, getCurrentCorpusMatchGeneration } from '../lib/report-historical-match.ts';
import {
  persistRefreshedSimilarity,
  selfHealUnifiedSimilarity,
  resolvePersistedSimilarityDisplay,
} from '../lib/report-primary-similarity.ts';
import { findRoomOccupant } from '../lib/reports-repo.ts';
import { deriveRoomStatus } from '../lib/report-rooms.ts';
import { resolveAiDisplayState } from '../lib/ai-display-state.ts';
import { aiSignalDisplay } from '../lib/report-types.ts';

/**
 * Fresh-report aiAnalysis-loss regression (Room 5, "The Legal Framework
 * Governing the Election of Constitutional Law Professors to the
 * Constitutional Court in Algeria.docx").
 *
 * Observed: a brand-new report — flat ai_status='ready' + ai_score=0 — whose
 * payload_json.aiAnalysis was missing, so the detail page showed "0% AI" with
 * "The passage-level breakdown isn't available for this saved copy." Not a
 * legacy row.
 *
 * Root cause: the similarity SELF-HEAL writes (lib/report-primary-similarity.ts's
 * selfHealUnifiedSimilarity, and app/api/reports/[id]/route.ts's GET-time
 * self-heal) rebuilt payload_json WHOLESALE from a spread of the row as it
 * was read EARLIER in the request, then wrote that whole blob back with a raw
 * `UPDATE ... SET payload_json = ?`. resolvePrimarySimilaritySummary in
 * between does real matcher work whenever the corpus generation has just
 * moved (the corpus-admission-rollout case). A concurrent AI-completion
 * SAVE_REPORT_SQL write — which sets $.aiAnalysis / $.aiScore AND moves
 * ai_status to 'ready' + a real ai_score — could commit inside that window;
 * the wholesale write then clobbered the just-persisted $.aiAnalysis straight
 * back out, while the flat ai_* columns (never touched by self-heal) stayed
 * 'ready' + numeric.
 *
 * Fix: persistRefreshedSimilarity applies json_set / json_remove to only the
 * four similarity-owned keys of the row's CURRENT payload_json, atomically —
 * $.aiAnalysis / $.aiScore and every other field are read back live and
 * preserved regardless of interleaving. The generation guard is unchanged.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_self_heal_ai_preservation.db');
for (const suffix of ['', '-wal', '-shm']) {
  const c = `${dbFile}${suffix}`;
  if (fs.existsSync(c)) fs.unlinkSync(c);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

// --- fixtures -------------------------------------------------------------

/** A real, current-version completed AI analysis with the passage-level
 *  detail the Room-5 UI was missing. medianLogOdds -1 → calibrated display 0%. */
const COMPLETE_ANALYSIS = {
  status: 'complete',
  score: 7.5,
  scoringVersion: 10,
  medianLogOdds: -1,
  model: 'test-model',
  engine: 'CPU',
  threshold: 0.7,
  eligibleWordCount: 620,
  analyzedWordCount: 600,
  analyzedTokenCount: 812,
  flaggedWordCount: 40,
  flaggedPassageCount: 1,
  passages: [
    { start: 0, end: 40, wordStart: 0, wordEnd: 20, text: 'first analyzed passage window', wordCount: 20, probability: 0.12, tokenStart: 0, tokenEnd: 28, tokenCount: 28 },
    { start: 41, end: 90, wordStart: 21, wordEnd: 44, text: 'second analyzed passage window', wordCount: 23, probability: 0.31, tokenStart: 29, tokenEnd: 60, tokenCount: 31 },
  ],
};

const ERROR_ANALYSIS = { status: 'error', score: null, model: 'test-model', engine: null, threshold: 0.7, eligibleWordCount: 0, analyzedWordCount: 0, passages: [], error: 'model load failed' };

let counter = 0;
let genUsers = 0;

async function ensureUser(userId) {
  await client.execute({
    sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
    args: [userId, `${userId}@example.test`, userId, 'not-a-real-hash'],
  });
}

function basePayload(id, overrides = {}) {
  return {
    version: 11,
    id,
    submissionId: 'sub-' + id,
    title: 'The Legal Framework Governing the Election of Constitutional Law Professors.docx',
    author: '',
    assignment: '',
    created: new Date().toISOString(),
    score: 0,
    archiveScore: 0,
    wordCount: 1200,
    characterCount: 8000,
    pageCount: 4,
    scoreBand: 'Low',
    matchedWordCount: 0,
    sources: [],
    repeats: [],
    text: 'A long legal-studies document about constitutional law professor elections in Algeria. '.repeat(30),
    ...overrides,
  };
}

/**
 * Inserts a real saved_reports row — the exact shape app/api/reports/route.ts
 * writes — with a persisted (possibly stale-generation) similarity result.
 */
async function seedReport({
  room = null,
  userId = null,
  aiStatus = 'processing',
  aiScore = null,
  aiTone = null,
  payloadOverrides = {},
} = {}) {
  counter += 1;
  const id = `self-heal-report-${counter}`;
  const deviceKey = `self-heal-device-${counter}`;
  if (userId) await ensureUser(userId);
  const payload = basePayload(id, payloadOverrides);
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, ai_status, payload_json, user_id, room_number, updated_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [id, deviceKey, payload.submissionId, payload.title, payload.wordCount, payload.archiveScore, payload.scoreBand, aiScore, aiTone, aiStatus, JSON.stringify(payload), userId, room],
  });
  return { id, deviceKey };
}

/** The AI-completion resave, through the REAL exported SAVE_REPORT_SQL —
 *  exactly what room-page-shell.tsx's saveEnrichedAiResult drives, carrying a
 *  freshly-completed payload.aiAnalysis + the flat ai_* columns. */
async function aiCompletionWrite({ id, deviceKey, userId = null, room = null, aiScore = 0, aiTone = 'low', aiStatus = 'ready', analysis = COMPLETE_ANALYSIS, rawAiScore = 7.5, similarityGeneration }) {
  const payload = basePayload(id, {
    aiAnalysis: analysis,
    aiScore: rawAiScore,
    ...(similarityGeneration !== undefined
      ? { unifiedSimilarity: { unifiedScore: 0, matchedPositions: [], uniqueMatchedWords: 0, previousUploadPositions: [] }, corpusSourceMatchingEnabledAtComputation: true, unifiedSimilarityGeneration: similarityGeneration, unifiedSimilarityFailed: false }
      : {}),
  });
  await client.execute({
    sql: reportsRoute.SAVE_REPORT_SQL,
    args: [id, deviceKey, payload.submissionId, payload.title, new Date().toISOString(), payload.wordCount, 0, 'Low', aiScore, aiTone, aiStatus, JSON.stringify(payload), userId, room],
  });
}

async function rowOf(deviceKey, id) {
  const r = await client.execute({
    sql: 'SELECT ai_score, ai_tone, ai_status, payload_json FROM saved_reports WHERE device_key = ? AND id = ?',
    args: [deviceKey, id],
  });
  const row = r.rows[0];
  return {
    ai_score: row.ai_score === null ? null : Number(row.ai_score),
    ai_tone: row.ai_tone,
    ai_status: row.ai_status,
    payload: JSON.parse(row.payload_json),
    payload_raw: String(row.payload_json),
  };
}

/** Mirrors components/report/ai-report.tsx's own `completeWithoutDetail`
 *  derivation exactly: signal.value !== null && !report.aiAnalysis — the
 *  precise condition that renders "The passage-level breakdown isn't
 *  available for this saved copy." */
function detailRenders(row) {
  const report = row.payload;
  const persisted = { aiStatus: row.ai_status, aiScore: row.ai_score, aiTone: row.ai_tone };
  const signal = aiSignalDisplay(report, persisted);
  const analysis = report.aiAnalysis;
  return {
    signalValue: signal.value,
    signalLabel: signal.label,
    completeWithoutDetail: signal.value !== null && !analysis,
    wordsAnalyzed: analysis?.analyzedWordCount,
    tokensAnalyzed: analysis?.analyzedTokenCount,
    passageWindows: analysis?.passages?.length,
    passages: analysis?.passages,
  };
}

// =========================================================================
// persistRefreshedSimilarity — the atomic, similarity-owned-only write
// =========================================================================

test('persistRefreshedSimilarity: preserves an $.aiAnalysis/$.aiScore added AFTER the resolution object was built (the exact race)', async () => {
  const { id, deviceKey } = await seedReport({
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 99, matchedPositions: [1], uniqueMatchedWords: 1, previousUploadPositions: [] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: 3,
      unifiedSimilarityFailed: false,
    },
  });

  // A resolution computed against generation 5 (a later promotion moved it).
  const resolution = {
    unifiedSimilarity: { unifiedScore: 42, matchedPositions: [7, 8], uniqueMatchedWords: 2, previousUploadPositions: [7] },
    failed: false,
    corpusSourceMatchingEnabled: true,
    corpusGeneration: 5,
  };

  // The concurrent AI-completion SAVE_REPORT_SQL write lands NOW — after the
  // resolution above was produced, before persistRefreshedSimilarity runs.
  await aiCompletionWrite({ id, deviceKey, similarityGeneration: 4 });

  const write = await persistRefreshedSimilarity(client, { reportDeviceKey: deviceKey, reportId: id }, resolution);
  assert.equal(write.written, 'resolved');
  assert.equal(write.rowsAffected, 1);

  const row = await rowOf(deviceKey, id);
  // similarity-owned fields fully replaced by the resolution
  assert.equal(row.payload.unifiedSimilarity.unifiedScore, 42);
  assert.deepEqual(row.payload.unifiedSimilarity.matchedPositions, [7, 8]);
  assert.equal(row.payload.unifiedSimilarityGeneration, 5);
  assert.equal(row.payload.corpusSourceMatchingEnabledAtComputation, true);
  assert.equal(row.payload.unifiedSimilarityFailed, false);
  // AI-owned fields the concurrent write added — untouched
  assert.equal(row.payload.aiAnalysis.status, 'complete');
  assert.equal(row.payload.aiAnalysis.passages.length, 2);
  assert.equal(row.payload.aiScore, 7.5);
  assert.equal(row.ai_status, 'ready');
  assert.equal(row.ai_score, 0);
});

test('persistRefreshedSimilarity: the generation guard still refuses to regress a newer-generation result a concurrent write already persisted', async () => {
  const { id, deviceKey } = await seedReport({
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 10, matchedPositions: [], uniqueMatchedWords: 0 },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: 2,
      unifiedSimilarityFailed: false,
      aiAnalysis: COMPLETE_ANALYSIS,
      aiScore: 7.5,
    },
  });
  // A concurrent write already advanced this row to generation 20.
  await aiCompletionWrite({ id, deviceKey, similarityGeneration: 20 });

  // This self-heal only ever saw generation 6 — it must NOT overwrite gen 20.
  const stale = { unifiedSimilarity: { unifiedScore: 55, matchedPositions: [9] }, failed: false, corpusSourceMatchingEnabled: true, corpusGeneration: 6 };
  const write = await persistRefreshedSimilarity(client, { reportDeviceKey: deviceKey, reportId: id }, stale);
  assert.equal(write.rowsAffected, 0, 'the generation guard rejected the stale write');

  const row = await rowOf(deviceKey, id);
  assert.equal(row.payload.unifiedSimilarityGeneration, 20, 'newer generation kept');
  assert.equal(row.payload.unifiedSimilarity.unifiedScore, 0, 'the gen-20 write\'s similarity value kept, not the stale 55');
  assert.equal(row.payload.aiAnalysis.status, 'complete', 'aiAnalysis untouched throughout');
});

test('persistRefreshedSimilarity: a genuinely newer generation still replaces ALL similarity-owned fields, and only those', async () => {
  const { id, deviceKey } = await seedReport({
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 10, matchedPositions: [1, 2], uniqueMatchedWords: 2, previousUploadPositions: [1] },
      corpusSourceMatchingEnabledAtComputation: false,
      unifiedSimilarityGeneration: 4,
      unifiedSimilarityFailed: true,
      aiAnalysis: COMPLETE_ANALYSIS,
      aiScore: 3.3,
      wikipediaMatchedWordCount: 12,
    },
  });
  const resolution = {
    unifiedSimilarity: { unifiedScore: 88, matchedPositions: [5, 6, 7], uniqueMatchedWords: 3, previousUploadPositions: [] },
    failed: false,
    corpusSourceMatchingEnabled: true,
    corpusGeneration: 9,
  };
  await persistRefreshedSimilarity(client, { reportDeviceKey: deviceKey, reportId: id }, resolution);

  const row = await rowOf(deviceKey, id);
  assert.deepEqual(row.payload.unifiedSimilarity, resolution.unifiedSimilarity, 'unifiedSimilarity fully replaced');
  assert.equal(row.payload.unifiedSimilarityGeneration, 9);
  assert.equal(row.payload.corpusSourceMatchingEnabledAtComputation, true);
  assert.equal(row.payload.unifiedSimilarityFailed, false, 'the stale failure marker is cleared by a real resolved result');
  // non-similarity fields untouched
  assert.equal(row.payload.aiAnalysis.status, 'complete');
  assert.equal(row.payload.aiScore, 3.3);
  assert.equal(row.payload.wikipediaMatchedWordCount, 12);
  assert.equal(row.payload.title, basePayload(id).title);
});

test('persistRefreshedSimilarity: the failure branch removes only $.unifiedSimilarity and stamps the marker — aiAnalysis survives', async () => {
  const { id, deviceKey } = await seedReport({
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 50, matchedPositions: [1] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: 1,
      unifiedSimilarityFailed: false,
      aiAnalysis: COMPLETE_ANALYSIS,
      aiScore: 9.1,
    },
  });
  const failure = { unifiedSimilarity: undefined, failed: true, corpusSourceMatchingEnabled: true, corpusGeneration: 3 };
  const write = await persistRefreshedSimilarity(client, { reportDeviceKey: deviceKey, reportId: id }, failure);
  assert.equal(write.written, 'failed');

  const row = await rowOf(deviceKey, id);
  assert.equal(row.payload.unifiedSimilarity, undefined, '$.unifiedSimilarity removed');
  assert.equal(row.payload.unifiedSimilarityFailed, true);
  assert.equal(row.payload.unifiedSimilarityGeneration, 3);
  assert.equal(row.payload.aiAnalysis.status, 'complete', 'aiAnalysis survives a similarity FAILURE write too');
  assert.equal(row.payload.aiScore, 9.1);
});

test('persistRefreshedSimilarity: a payload_json that is not valid JSON is left completely untouched (json_valid floor)', async () => {
  const { id, deviceKey } = await seedReport();
  await client.execute({ sql: 'UPDATE saved_reports SET payload_json = ? WHERE device_key = ? AND id = ?', args: ['{ not valid json', deviceKey, id] });
  const write = await persistRefreshedSimilarity(client, { reportDeviceKey: deviceKey, reportId: id }, {
    unifiedSimilarity: { unifiedScore: 1 }, failed: false, corpusSourceMatchingEnabled: true, corpusGeneration: 1,
  });
  assert.equal(write.rowsAffected, 0);
  const r = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, id] });
  assert.equal(String(r.rows[0].payload_json), '{ not valid json', 'the row is not nulled or corrupted further');
});

// =========================================================================
// selfHealUnifiedSimilarity — the real self-heal path, raced against AI
// =========================================================================

test('MANDATORY — EXACT ROOM 5 SHAPE: an AI-completion write landing mid-self-heal keeps its aiAnalysis; the persisted row has newer similarity + newer generation + the completed analysis + flat ai_status ready + ai_score 0', async () => {
  // A: initial report saved at generation N (=1), no aiAnalysis yet.
  await bumpCorpusMatchGeneration(client); // live generation -> 1
  const { id, deviceKey } = await seedReport({
    userId: 'room5-user-1', room: 5, aiStatus: 'processing', aiScore: null,
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 25, matchedPositions: [1], uniqueMatchedWords: 1, previousUploadPositions: [] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: 1,
      unifiedSimilarityFailed: false,
    },
  });

  // A later legitimate corpus change bumps the generation -> the next read
  // finds the persisted result stale and self-heals it.
  await bumpCorpusMatchGeneration(client); // live generation -> 2
  const liveGen = await getCurrentCorpusMatchGeneration(client);

  const healed = await selfHealUnifiedSimilarity(client, {
    reportDeviceKey: deviceKey,
    reportId: id,
    accountId: 'room5-user-1',
    // B: the AI-completion SAVE_REPORT_SQL write commits inside the exact
    //    window between self-heal's read+recompute and its write.
    testOnlyBeforePersist: async () => {
      await aiCompletionWrite({
        id, deviceKey, userId: 'room5-user-1', room: 5,
        aiScore: 0, aiTone: 'low', aiStatus: 'ready',
        analysis: COMPLETE_ANALYSIS, rawAiScore: 7.5,
        similarityGeneration: liveGen,
      });
    },
  });
  assert.equal(healed.attempted, true);
  assert.equal(healed.outcome, 'resolved');

  // D: the persisted row
  const row = await rowOf(deviceKey, id);
  assert.ok(row.payload.unifiedSimilarity, 'newer similarity state present');
  assert.equal(row.payload.unifiedSimilarityGeneration, liveGen, 'newer generation persisted');
  assert.equal(row.payload.unifiedSimilarityFailed, false);
  assert.ok(row.payload.aiAnalysis, 'the completed aiAnalysis was NOT erased by the self-heal write');
  assert.equal(row.payload.aiAnalysis.status, 'complete');
  assert.equal(row.payload.aiAnalysis.passages.length, 2);
  assert.equal(row.payload.aiScore, 7.5, 'raw aiScore preserved');
  assert.equal(row.ai_status, 'ready', 'flat ai_status');
  assert.equal(row.ai_score, 0, 'flat ai_score = 0 (a valid completed result)');

  // E: detail rendering resolves to a completed 0% WITH the passage breakdown
  assert.equal(deriveRoomStatus(row.ai_score, row.ai_status), 'ready');
  const resolved = resolveAiDisplayState({ aiStatus: row.ai_status, aiScore: row.ai_score, aiTone: row.ai_tone, aiAnalysis: row.payload.aiAnalysis });
  assert.equal(resolved.state, 'complete');
  assert.equal(resolved.score, 0);

  const d = detailRenders(row);
  assert.equal(d.signalValue, 0, 'detail headline: 0%');
  assert.notEqual(d.signalLabel, 'AI report pending');
  assert.equal(d.completeWithoutDetail, false, 'NOT "The passage-level breakdown isn\'t available for this saved copy."');
  assert.equal(d.wordsAnalyzed, 600, 'words analyzed present');
  assert.equal(d.tokensAnalyzed, 812, 'tokens analyzed present');
  assert.equal(d.passageWindows, 2, 'passage windows present');
  assert.ok(Array.isArray(d.passages) && d.passages.length === 2, 'passage breakdown present');
});

test('MANDATORY 1 — a POSITIVE AI score survives the identical sequence', async () => {
  await bumpCorpusMatchGeneration(client);
  const gLive = await getCurrentCorpusMatchGeneration(client);
  const { id, deviceKey } = await seedReport({
    userId: 'pos-user-1', room: 6, aiStatus: 'processing',
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 12, matchedPositions: [], uniqueMatchedWords: 0, previousUploadPositions: [] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: gLive,
      unifiedSimilarityFailed: false,
    },
  });
  await bumpCorpusMatchGeneration(client);
  const gAfter = await getCurrentCorpusMatchGeneration(client);

  const positive = { ...COMPLETE_ANALYSIS, medianLogOdds: 3, score: 71.2, passages: COMPLETE_ANALYSIS.passages.map((p) => ({ ...p, flagged: true })) };
  await selfHealUnifiedSimilarity(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: 'pos-user-1',
    testOnlyBeforePersist: async () => {
      await aiCompletionWrite({ id, deviceKey, userId: 'pos-user-1', room: 6, aiScore: 71, aiTone: 'high', analysis: positive, rawAiScore: 71.2, similarityGeneration: gAfter });
    },
  });

  const row = await rowOf(deviceKey, id);
  assert.equal(row.payload.aiAnalysis.status, 'complete');
  assert.equal(row.payload.aiScore, 71.2, 'the positive raw aiScore survived the self-heal race');
  assert.equal(row.ai_score, 71, 'the positive flat ai_score survived');
  assert.equal(row.ai_status, 'ready');
  const d = detailRenders(row);
  assert.notEqual(d.signalValue, null, 'a real completed AI headline is shown, not "pending"');
  assert.equal(d.completeWithoutDetail, false, 'the passage breakdown is available');
  assert.equal(d.passageWindows, 2);
  assert.equal(d.passages[0].flagged, true, 'the analyzed passage detail (flagged windows) is intact');
});

test('MANDATORY 3 — a self-heal whose own read never saw an aiAnalysis cannot erase one added concurrently (missing incoming aiAnalysis never erases a valid existing one)', async () => {
  await bumpCorpusMatchGeneration(client);
  const g = await getCurrentCorpusMatchGeneration(client);
  const { id, deviceKey } = await seedReport({
    userId: 'miss-user-1', room: 7, aiStatus: 'processing',
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 5, matchedPositions: [], uniqueMatchedWords: 0, previousUploadPositions: [] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: g,
      unifiedSimilarityFailed: false,
    },
  });
  await bumpCorpusMatchGeneration(client);
  const gAfter = await getCurrentCorpusMatchGeneration(client);

  await selfHealUnifiedSimilarity(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: 'miss-user-1',
    testOnlyBeforePersist: async () => {
      await aiCompletionWrite({ id, deviceKey, userId: 'miss-user-1', room: 7, similarityGeneration: gAfter });
    },
  });

  const row = await rowOf(deviceKey, id);
  assert.equal(row.payload.aiAnalysis.status, 'complete', 'the concurrently-added aiAnalysis is intact');
  assert.equal(row.payload.aiScore, 7.5);
});

test('MANDATORY 4 — a self-heal never rewrites ai_status/ai_score, so it can never turn a completed AI result back to failed/pending', async () => {
  await bumpCorpusMatchGeneration(client);
  const g = await getCurrentCorpusMatchGeneration(client);
  const { id, deviceKey } = await seedReport({
    userId: 'retry-user-1', room: 8, aiStatus: 'ready', aiScore: 0, aiTone: 'low',
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 3, matchedPositions: [], uniqueMatchedWords: 0, previousUploadPositions: [] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: g,
      unifiedSimilarityFailed: false,
      aiAnalysis: COMPLETE_ANALYSIS,
      aiScore: 7.5,
    },
  });
  await bumpCorpusMatchGeneration(client);

  const healed = await selfHealUnifiedSimilarity(client, { reportDeviceKey: deviceKey, reportId: id, accountId: 'retry-user-1' });
  assert.equal(healed.attempted, true);

  const row = await rowOf(deviceKey, id);
  assert.equal(row.ai_status, 'ready', 'flat ai_status untouched by self-heal');
  assert.equal(row.ai_score, 0);
  assert.equal(row.payload.aiAnalysis.status, 'complete', 'completed analysis untouched');
  assert.equal(row.payload.aiScore, 7.5);
});

test('MANDATORY 5 — a self-heal on a still-pending report does NOT fabricate a completed aiAnalysis', async () => {
  await bumpCorpusMatchGeneration(client);
  const g = await getCurrentCorpusMatchGeneration(client);
  const { id, deviceKey } = await seedReport({
    userId: 'pending-user-1', room: 9, aiStatus: 'processing', aiScore: null,
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 1, matchedPositions: [], uniqueMatchedWords: 0, previousUploadPositions: [] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: g,
      unifiedSimilarityFailed: false,
    },
  });
  await bumpCorpusMatchGeneration(client);

  await selfHealUnifiedSimilarity(client, { reportDeviceKey: deviceKey, reportId: id, accountId: 'pending-user-1' });

  const row = await rowOf(deviceKey, id);
  assert.equal(row.payload.aiAnalysis, undefined, 'no aiAnalysis invented');
  assert.equal(row.ai_status, 'processing');
  const resolved = resolveAiDisplayState({ aiStatus: row.ai_status, aiScore: row.ai_score, aiTone: row.ai_tone, aiAnalysis: null });
  assert.equal(resolved.state, 'pending', 'still pending — never a fabricated 0%');
  assert.equal(resolved.score, null);
});

test('MANDATORY 10 — ai_score = 0 with ai_status ready is a valid completed result, never read as missing/pending', async () => {
  const { id, deviceKey } = await seedReport({
    aiStatus: 'ready', aiScore: 0, aiTone: 'low',
    payloadOverrides: { aiAnalysis: undefined },
  });
  const row = await rowOf(deviceKey, id);
  const resolved = resolveAiDisplayState({ aiStatus: 'ready', aiScore: 0, aiTone: 'low', aiAnalysis: null });
  assert.equal(resolved.state, 'complete');
  assert.equal(resolved.score, 0);
  // and once the detail payload also has the analysis, the breakdown shows
  await client.execute({
    sql: 'UPDATE saved_reports SET payload_json = json_set(payload_json, \'$.aiAnalysis\', json(?)) WHERE device_key = ? AND id = ?',
    args: [JSON.stringify(COMPLETE_ANALYSIS), deviceKey, id],
  });
  const row2 = await rowOf(deviceKey, id);
  const d = detailRenders(row2);
  assert.equal(d.signalValue, 0);
  assert.equal(d.completeWithoutDetail, false);
});

// =========================================================================
// End-to-end convergence through the real read paths (findRoomOccupant, GET)
// =========================================================================

test('MANDATORY 8 — ordering AI completion -> newer similarity write: findRoomOccupant converges to newest similarity + completed AI', async () => {
  await bumpCorpusMatchGeneration(client);
  const g = await getCurrentCorpusMatchGeneration(client);
  const userId = 'order-a-user-1';
  const { id, deviceKey } = await seedReport({
    userId, room: 0, aiStatus: 'processing',
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 30, matchedPositions: [1], uniqueMatchedWords: 1, previousUploadPositions: [] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: g,
      unifiedSimilarityFailed: false,
    },
  });

  // AI completes first (row now ready + aiAnalysis).
  await aiCompletionWrite({ id, deviceKey, userId, room: 0, similarityGeneration: g });
  // Then a legitimate corpus change: the next room read self-heals similarity.
  await bumpCorpusMatchGeneration(client);
  const gAfter = await getCurrentCorpusMatchGeneration(client);

  const occupant = await findRoomOccupant(client, userId, 0);
  assert.equal(occupant.status, 'ready');
  assert.equal(occupant.report.aiScore, 0);

  const row = await rowOf(deviceKey, id);
  assert.equal(row.payload.unifiedSimilarityGeneration, gAfter, 'similarity self-healed to newest generation');
  assert.equal(row.payload.aiAnalysis.status, 'complete', 'completed AI still there');
  assert.equal(row.ai_status, 'ready');
  const d = detailRenders(row);
  assert.equal(d.completeWithoutDetail, false);
  assert.equal(d.passageWindows, 2);
});

test('MANDATORY 9 — reverse ordering newer similarity write (self-heal) -> AI completion: converges to newest similarity + completed AI', async () => {
  await bumpCorpusMatchGeneration(client);
  const g = await getCurrentCorpusMatchGeneration(client);
  const userId = 'order-b-user-1';
  const { id, deviceKey } = await seedReport({
    userId, room: 1, aiStatus: 'processing',
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 15, matchedPositions: [], uniqueMatchedWords: 0, previousUploadPositions: [] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: g,
      unifiedSimilarityFailed: false,
    },
  });

  // Similarity self-heals first (via a room read), then AI completes.
  await bumpCorpusMatchGeneration(client);
  const gAfter = await getCurrentCorpusMatchGeneration(client);
  const occupant1 = await findRoomOccupant(client, userId, 1);
  assert.equal(occupant1.status, 'processing', 'still processing AI-wise');

  const midRow = await rowOf(deviceKey, id);
  assert.equal(midRow.payload.unifiedSimilarityGeneration, gAfter, 'similarity already self-healed');
  assert.equal(midRow.payload.aiAnalysis, undefined, 'AI not done yet');

  await aiCompletionWrite({ id, deviceKey, userId, room: 1, similarityGeneration: gAfter });

  const finalRow = await rowOf(deviceKey, id);
  assert.equal(finalRow.payload.unifiedSimilarityGeneration, gAfter, 'newest similarity kept');
  assert.equal(finalRow.payload.aiAnalysis.status, 'complete', 'completed AI landed');
  assert.equal(finalRow.ai_status, 'ready');
  assert.equal(finalRow.ai_score, 0);
  const d = detailRenders(finalRow);
  assert.equal(d.completeWithoutDetail, false);
});

test('MANDATORY 6 — a stale similarity self-heal cannot clobber newer similarity state (through the real selfHealUnifiedSimilarity + generation guard)', async () => {
  await bumpCorpusMatchGeneration(client);
  const g = await getCurrentCorpusMatchGeneration(client);
  const userId = 'stale-sim-user-1';
  const { id, deviceKey } = await seedReport({
    userId, room: 2, aiStatus: 'processing',
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 20, matchedPositions: [], uniqueMatchedWords: 0, previousUploadPositions: [] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: g,
      unifiedSimilarityFailed: false,
    },
  });
  await bumpCorpusMatchGeneration(client);

  await selfHealUnifiedSimilarity(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: userId,
    // A concurrent write jumps the row to a much higher generation while
    // this self-heal is mid-flight.
    testOnlyBeforePersist: async () => {
      await aiCompletionWrite({ id, deviceKey, userId, room: 2, similarityGeneration: 999 });
    },
  });

  const row = await rowOf(deviceKey, id);
  assert.equal(row.payload.unifiedSimilarityGeneration, 999, 'the newer generation 999 was not regressed by this self-heal');
  assert.equal(row.payload.aiAnalysis.status, 'complete');
});

test('MANDATORY 2 — an incoming newer valid aiAnalysis DOES replace an older valid aiAnalysis (SAVE_REPORT_SQL, unchanged)', async () => {
  await bumpCorpusMatchGeneration(client);
  const g = await getCurrentCorpusMatchGeneration(client);
  const { id, deviceKey } = await seedReport({
    aiStatus: 'ready', aiScore: 0, aiTone: 'low',
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 1, matchedPositions: [] },
      unifiedSimilarityGeneration: g,
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityFailed: false,
      aiAnalysis: { ...COMPLETE_ANALYSIS, passages: [{ start: 0, end: 4, wordStart: 0, wordEnd: 2, text: 'OLD passage', wordCount: 2, probability: 0.1 }] },
      aiScore: 2.0,
    },
  });

  const newer = { ...COMPLETE_ANALYSIS, passages: [{ start: 0, end: 6, wordStart: 0, wordEnd: 3, text: 'NEW passage', wordCount: 3, probability: 0.8 }] };
  await aiCompletionWrite({ id, deviceKey, aiScore: 4, rawAiScore: 4.0, analysis: newer, similarityGeneration: g });

  const row = await rowOf(deviceKey, id);
  assert.equal(row.payload.aiAnalysis.passages[0].text, 'NEW passage', 'a genuine newer completed analysis replaces the older one');
  assert.equal(row.payload.aiScore, 4.0);
  assert.equal(row.ai_score, 4);
});

test('MANDATORY 7 (end to end) — a legitimate newer-generation similarity self-heal replaces every similarity-owned field on the real GET route, without touching AI-owned fields', async () => {
  await bumpCorpusMatchGeneration(client);
  const g = await getCurrentCorpusMatchGeneration(client);
  const { id, deviceKey } = await seedReport({
    aiStatus: 'ready', aiScore: 0, aiTone: 'low',
    payloadOverrides: {
      unifiedSimilarity: { unifiedScore: 77, matchedPositions: [1, 2, 3], uniqueMatchedWords: 3, previousUploadPositions: [1] },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: g,
      unifiedSimilarityFailed: false,
      aiAnalysis: COMPLETE_ANALYSIS,
      aiScore: 7.5,
    },
  });
  await bumpCorpusMatchGeneration(client);
  const gAfter = await getCurrentCorpusMatchGeneration(client);

  await resetReadRateForTest('self-heal-get-1');
  const req = new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}`, {
    headers: { 'x-forwarded-for': 'self-heal-get-1' },
  });
  const res = await reportIdRoute.GET(req, { params: Promise.resolve({ id: String(id) }) });
  assert.equal(res.status, 200);
  const body = await res.json();

  // response reflects the refreshed similarity + the untouched AI analysis
  assert.equal(body.payload.unifiedSimilarityGeneration, gAfter);
  assert.equal(body.payload.unifiedSimilarity.unifiedScore, 0, 'recomputed (no matching source) — similarity-owned fields fully refreshed');
  assert.equal(body.payload.aiAnalysis.status, 'complete');
  assert.equal(body.payload.aiScore, 7.5);

  // persisted row: same
  const row = await rowOf(deviceKey, id);
  assert.equal(row.payload.unifiedSimilarityGeneration, gAfter);
  assert.equal(row.payload.aiAnalysis.status, 'complete', 'GET-time self-heal did NOT erase aiAnalysis');
  assert.equal(row.payload.aiScore, 7.5);
  assert.equal(row.ai_status, 'ready');
  assert.equal(row.ai_score, 0);
  const d = detailRenders(row);
  assert.equal(d.completeWithoutDetail, false);
  assert.equal(d.passageWindows, 2);
});

// =========================================================================
// Structural guarantee — neither self-heal path rebuilds payload_json wholesale
// =========================================================================

test('STRUCTURAL: neither self-heal path contains a raw wholesale "SET payload_json = ?" write — both go through persistRefreshedSimilarity', async () => {
  const primarySrc = fs.readFileSync(path.join(repo, 'lib/report-primary-similarity.ts'), 'utf8');
  const idRouteSrc = fs.readFileSync(path.join(repo, 'app/api/reports/[id]/route.ts'), 'utf8');

  // The ONLY executable UPDATE ... SET payload_json in either file must be
  // the json_set/json_remove targeted ones inside persistRefreshedSimilarity
  // — never a `sql: \`UPDATE saved_reports SET payload_json = ?\`` wholesale
  // blob replacement (doc-comment prose mentioning that pattern is fine).
  const wholesale = /sql:\s*`UPDATE saved_reports\s+SET payload_json = \?/g;
  assert.equal((primarySrc.match(wholesale) || []).length, 0, 'lib/report-primary-similarity.ts has no wholesale payload_json write');
  assert.equal((idRouteSrc.match(wholesale) || []).length, 0, 'app/api/reports/[id]/route.ts has no wholesale payload_json write');

  assert.ok(primarySrc.includes('persistRefreshedSimilarity'), 'self-heal module defines/uses the shared helper');
  assert.ok(idRouteSrc.includes('persistRefreshedSimilarity'), 'the [id] GET route uses the shared helper');
  assert.ok(primarySrc.includes('json_set(') && primarySrc.includes('json_remove('), 'the helper edits only the similarity-owned keys via json_set/json_remove on the live column');
});
