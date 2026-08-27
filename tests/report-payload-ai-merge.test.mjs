import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import { deriveRoomStatus } from '../lib/report-rooms.ts';
import { resolveAiDisplayState } from '../lib/ai-display-state.ts';
import { aiSignalDisplay } from '../lib/report-types.ts';

/**
 * Upstream persistence half of the AI score / pending-state consistency fix.
 *
 * The production split (report 1787833395119): the AI-enrichment resave
 * updates the flat ai_score/ai_tone/ai_status columns AND carries a
 * freshly-completed payload.aiAnalysis, but its own write-time similarity
 * finalization transiently failed, so its payload has no
 * unifiedSimilarityGeneration. app/api/reports/route.ts's SAVE_REPORT_SQL
 * generation guard then CORRECTLY keeps the existing (generation-stamped)
 * payload_json — which never had an aiAnalysis — while the columns still
 * moved to 'ready' + a real score. Room card read the columns ("0% AI");
 * detail page read payload.aiAnalysis ("AI report pending").
 *
 * The fix: when the generation guard keeps the existing payload because the
 * incoming similarity generation is stale/missing, merge the incoming
 * AI-owned payload fields (aiAnalysis + its paired raw aiScore) into that
 * retained authoritative payload via json_set — leaving every similarity
 * field byte-for-byte untouched. The guard itself is NOT weakened.
 *
 * These tests exercise the EXACT exported SAVE_REPORT_SQL text directly
 * (same convention as tests/report-write-time-finalization.test.mjs's own
 * SIM-04 guard test) so they can force the "finalization failed, generation
 * missing" shape a POST through the real handler cannot reliably produce.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_payload_ai_merge.db');
for (const suffix of ['', '-wal', '-shm']) {
  const c = `${dbFile}${suffix}`;
  if (fs.existsSync(c)) fs.unlinkSync(c);
}
const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

const DEVICE = 'ai-merge-device';
let counter = 0;

function basePayload(overrides = {}) {
  return {
    version: 11,
    id: 'x',
    submissionId: 'sub-x',
    title: 'doc.pdf',
    author: '',
    assignment: '',
    created: new Date().toISOString(),
    score: 0,
    archiveScore: 0,
    wordCount: 1000,
    scoreBand: 'Low',
    matchedWordCount: 0,
    sources: [],
    repeats: [],
    text: 'sample text for the merge fixture',
    ...overrides,
  };
}

const COMPLETE_ANALYSIS = {
  status: 'complete',
  scoringVersion: 10,
  medianLogOdds: -1, // calibratedAiDisplaySignal(-1) === { score: 0 }
  model: 'm',
  engine: 'CPU',
  threshold: 0.7,
  eligibleWordCount: 400,
  analyzedWordCount: 400,
  passages: [
    { start: 0, end: 10, wordStart: 0, wordEnd: 5, text: 'passage one', wordCount: 5, probability: 0.1 },
    { start: 11, end: 20, wordStart: 6, wordEnd: 11, text: 'passage two', wordCount: 5, probability: 0.2 },
  ],
};

function args({ id, aiScore, aiTone, aiStatus, payload }) {
  return [
    id, DEVICE, 'sub-' + id, 'Merge fixture', new Date().toISOString(),
    1000, 0, 'Low', aiScore, aiTone, aiStatus,
    JSON.stringify(payload), null, 0,
  ];
}

async function exec(a) {
  await client.execute({ sql: reportsRoute.SAVE_REPORT_SQL, args: a });
}

async function rowOf(id) {
  const r = await client.execute({
    sql: 'SELECT ai_score, ai_tone, ai_status, payload_json FROM saved_reports WHERE device_key = ? AND id = ?',
    args: [DEVICE, id],
  });
  const row = r.rows[0];
  return {
    ai_score: row.ai_score === null ? null : Number(row.ai_score),
    ai_tone: row.ai_tone,
    ai_status: row.ai_status,
    payload: JSON.parse(row.payload_json),
    payload_raw: row.payload_json,
  };
}

/** A generation-stamped existing row with a real unified similarity result and NO aiAnalysis — the state at the moment the AI-enrichment resave arrives. */
async function seedExistingSimilarityRow(id, extra = {}) {
  await exec(args({
    id, aiScore: null, aiTone: null, aiStatus: 'processing',
    payload: basePayload({
      id,
      unifiedSimilarity: { unifiedScore: 100, matchedPositions: [1, 2, 3], uniqueMatchedWords: 3 },
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityGeneration: 7,
      unifiedSimilarityFailed: false,
      ...extra,
    }),
  }));
}

// ---------------------------------------------------------------------------

test('2 + 1 + 6: an AI resave with a missing similarity generation persists its completed aiAnalysis while every similarity field stays byte-for-byte unchanged', async () => {
  const id = `case-${++counter}`;
  await seedExistingSimilarityRow(id);

  // AI-enrichment resave: real completed analysis, ai_score=0 (the exact bug
  // shape), NO unifiedSimilarityGeneration (its finalization transiently
  // failed).
  await exec(args({
    id, aiScore: 0, aiTone: 'low', aiStatus: 'ready',
    payload: basePayload({ id, aiScore: 12.3, aiAnalysis: COMPLETE_ANALYSIS }),
  }));

  const row = await rowOf(id);

  // (1) newer similarity generation/data remains unchanged
  assert.equal(row.payload.unifiedSimilarity.unifiedScore, 100);
  assert.deepEqual(row.payload.unifiedSimilarity.matchedPositions, [1, 2, 3]);
  assert.equal(row.payload.unifiedSimilarity.uniqueMatchedWords, 3);
  assert.equal(row.payload.unifiedSimilarityGeneration, 7);
  assert.equal(row.payload.corpusSourceMatchingEnabledAtComputation, true);
  assert.equal(row.payload.unifiedSimilarityFailed, false);

  // (2) incoming completed aiAnalysis is persisted
  assert.equal(row.payload.aiAnalysis.status, 'complete');
  assert.equal(row.payload.aiAnalysis.scoringVersion, 10);
  assert.equal(row.payload.aiAnalysis.passages.length, 2);
  assert.equal(row.payload.aiAnalysis.passages[1].text, 'passage two');
  assert.equal(row.payload.aiScore, 12.3, 'the raw percentile paired with the analysis is merged too');

  // flat columns updated as normal
  assert.equal(row.ai_score, 0);
  assert.equal(row.ai_tone, 'low');
  assert.equal(row.ai_status, 'ready');

  // (6) the exact ready + ai_score=0 bug case now shows BOTH 0% AND the
  //     detailed analysis, on every surface
  assert.equal(deriveRoomStatus(row.ai_score, row.ai_status), 'ready', 'room reveal gate: ready');

  const roomView = resolveAiDisplayState({ aiStatus: row.ai_status, aiScore: row.ai_score, aiTone: row.ai_tone });
  assert.equal(roomView.state, 'complete');
  assert.equal(roomView.score, 0, 'room card: 0%');

  const detailSignal = aiSignalDisplay(
    { aiAnalysis: row.payload.aiAnalysis },
    { aiStatus: row.ai_status, aiScore: row.ai_score, aiTone: row.ai_tone },
  );
  assert.equal(detailSignal.value, 0, 'detail page headline: 0%, not "AI report pending"');
  assert.notEqual(detailSignal.label, 'AI report pending');
  assert.ok(Array.isArray(row.payload.aiAnalysis.passages) && row.payload.aiAnalysis.passages.length === 2,
    'detail page passage breakdown is present — the detailed AI analysis survived');
});

test('3: stale similarity fields carried on the incoming AI resave cannot overwrite the newer persisted similarity data', async () => {
  const id = `case-${++counter}`;
  await seedExistingSimilarityRow(id);

  // The incoming AI resave ALSO carries a stale, client-side unifiedSimilarity
  // and an OLDER generation alongside its fresh aiAnalysis.
  await exec(args({
    id, aiScore: 0, aiTone: 'low', aiStatus: 'ready',
    payload: basePayload({
      id,
      unifiedSimilarity: { unifiedScore: 0, matchedPositions: [] },
      unifiedSimilarityGeneration: 3,
      corpusSourceMatchingEnabledAtComputation: false,
      unifiedSimilarityFailed: true,
      aiAnalysis: COMPLETE_ANALYSIS,
    }),
  }));

  const row = await rowOf(id);
  assert.equal(row.payload.unifiedSimilarity.unifiedScore, 100, 'newer persisted 100% kept — not the stale client 0%');
  assert.deepEqual(row.payload.unifiedSimilarity.matchedPositions, [1, 2, 3]);
  assert.equal(row.payload.unifiedSimilarityGeneration, 7, 'generation 7 kept — not regressed to the stale 3');
  assert.equal(row.payload.corpusSourceMatchingEnabledAtComputation, true, 'flag snapshot kept');
  assert.equal(row.payload.unifiedSimilarityFailed, false, 'the stale unifiedSimilarityFailed:true did NOT leak in');
  assert.equal(row.payload.aiAnalysis.status, 'complete', 'the aiAnalysis still merged');
});

test('4: an incoming payload without an aiAnalysis cannot erase an existing aiAnalysis when the generation guard keeps the existing payload', async () => {
  const id = `case-${++counter}`;
  // Existing row: already has BOTH a real similarity result (gen 7) AND a
  // completed aiAnalysis.
  await exec(args({
    id, aiScore: 5, aiTone: 'low', aiStatus: 'ready',
    payload: basePayload({
      id,
      unifiedSimilarity: { unifiedScore: 100, matchedPositions: [1, 2, 3] },
      unifiedSimilarityGeneration: 7,
      corpusSourceMatchingEnabledAtComputation: true,
      unifiedSimilarityFailed: false,
      aiScore: 9.9,
      aiAnalysis: { ...COMPLETE_ANALYSIS, passages: [{ start: 0, end: 4, wordStart: 0, wordEnd: 2, text: 'EXISTING passage', wordCount: 2, probability: 0.3 }] },
    }),
  }));

  // Incoming: a similarity-shaped resave with a STALE generation and NO
  // aiAnalysis at all.
  await exec(args({
    id, aiScore: null, aiTone: null, aiStatus: 'processing',
    payload: basePayload({ id, unifiedSimilarity: { unifiedScore: 42 }, unifiedSimilarityGeneration: 2 }),
  }));

  const row = await rowOf(id);
  assert.ok(row.payload.aiAnalysis, 'existing aiAnalysis is still present');
  assert.equal(row.payload.aiAnalysis.passages[0].text, 'EXISTING passage', 'existing aiAnalysis untouched — not erased by the no-aiAnalysis incoming');
  assert.equal(row.payload.aiScore, 9.9, 'existing raw aiScore untouched');
  assert.equal(row.payload.unifiedSimilarity.unifiedScore, 100, 'existing similarity kept (stale 42 rejected by the guard)');
  assert.equal(row.payload.unifiedSimilarityGeneration, 7);
});

test('5: a newer legitimate similarity write still lands verbatim — the ELSE branch is byte-for-byte unchanged', async () => {
  const id = `case-${++counter}`;
  await exec(args({
    id, aiScore: 5, aiTone: 'low', aiStatus: 'ready',
    payload: basePayload({
      id,
      unifiedSimilarity: { unifiedScore: 100 },
      unifiedSimilarityGeneration: 7,
      aiAnalysis: { ...COMPLETE_ANALYSIS, passages: [{ start: 0, end: 4, wordStart: 0, wordEnd: 2, text: 'OLD', wordCount: 2, probability: 0.1 }] },
    }),
  }));

  const incomingPayload = basePayload({
    id,
    unifiedSimilarity: { unifiedScore: 42, matchedPositions: [9, 9] },
    unifiedSimilarityGeneration: 9,
    corpusSourceMatchingEnabledAtComputation: true,
    unifiedSimilarityFailed: false,
    aiScore: 1.1,
    aiAnalysis: { ...COMPLETE_ANALYSIS, passages: [{ start: 0, end: 4, wordStart: 0, wordEnd: 2, text: 'NEW', wordCount: 2, probability: 0.9 }] },
  });
  await exec(args({ id, aiScore: 3, aiTone: 'low', aiStatus: 'ready', payload: incomingPayload }));

  const row = await rowOf(id);
  assert.deepEqual(row.payload, incomingPayload, 'a genuinely newer-generation write replaces payload_json wholesale, exactly as before this fix');
  assert.equal(row.payload.unifiedSimilarityGeneration, 9);
  assert.equal(row.payload.aiAnalysis.passages[0].text, 'NEW');
});

test('5 (guard floor unchanged): a lower-generation resave carrying no aiAnalysis still changes nothing at all — the SIM-04 guard is not weakened', async () => {
  const id = `case-${++counter}`;
  await seedExistingSimilarityRow(id);
  const before = (await rowOf(id)).payload_raw;

  await exec(args({
    id, aiScore: null, aiTone: null, aiStatus: 'processing',
    payload: basePayload({ id, unifiedSimilarity: { unifiedScore: 11 }, unifiedSimilarityGeneration: 4 }),
  }));

  const after = await rowOf(id);
  assert.equal(after.payload.unifiedSimilarity.unifiedScore, 100);
  assert.equal(after.payload.unifiedSimilarityGeneration, 7);
  assert.equal(after.payload.aiAnalysis, undefined, 'no aiAnalysis was invented from a payload that never had one');
  assert.deepEqual(JSON.parse(after.payload_raw), JSON.parse(before), 'payload_json is byte-equivalent to before the stale write');
});

test('ready-vs-failed guard still wins over the merge: a failed AI retry never clobbers an already-good ready analysis', async () => {
  const id = `case-${++counter}`;
  await exec(args({
    id, aiScore: 5, aiTone: 'low', aiStatus: 'ready',
    payload: basePayload({
      id,
      unifiedSimilarity: { unifiedScore: 100 },
      unifiedSimilarityGeneration: 7,
      aiScore: 8.8,
      aiAnalysis: { ...COMPLETE_ANALYSIS, passages: [{ start: 0, end: 4, wordStart: 0, wordEnd: 2, text: 'GOOD', wordCount: 2, probability: 0.1 }] },
    }),
  }));

  // A later 'failed' retry — stale generation, error analysis.
  await exec(args({
    id, aiScore: null, aiTone: 'unavailable', aiStatus: 'failed',
    payload: basePayload({ id, aiAnalysis: { status: 'error', error: 'model load failed', passages: [] } }),
  }));

  const row = await rowOf(id);
  assert.equal(row.ai_status, 'ready', 'sticky ready — the failed write is refused');
  assert.equal(row.ai_score, 5);
  assert.equal(row.payload.aiAnalysis.status, 'complete', 'the good analysis is kept, not overwritten by the error one');
  assert.equal(row.payload.aiAnalysis.passages[0].text, 'GOOD');
  assert.equal(row.payload.aiScore, 8.8);
});

test('incoming aiScore null is merged as null (a valid state), alongside the completed aiAnalysis', async () => {
  const id = `case-${++counter}`;
  await seedExistingSimilarityRow(id);
  await exec(args({
    id, aiScore: 0, aiTone: 'unavailable', aiStatus: 'ready',
    payload: basePayload({ id, aiScore: null, aiAnalysis: { ...COMPLETE_ANALYSIS, medianLogOdds: null } }),
  }));
  const row = await rowOf(id);
  assert.equal(row.payload.aiScore, null);
  assert.equal(row.payload.aiAnalysis.status, 'complete');
  assert.equal(row.payload.unifiedSimilarity.unifiedScore, 100, 'similarity untouched');
});

test('concurrency: whichever similarity write wins, a stale-generation AI resave still lands its analysis on the survivor', async () => {
  const id = `case-${++counter}`;
  await seedExistingSimilarityRow(id); // gen 7

  // A newer similarity write arrives (a promotion bumped the generation).
  await exec(args({
    id, aiScore: null, aiTone: null, aiStatus: 'processing',
    payload: basePayload({ id, unifiedSimilarity: { unifiedScore: 88, matchedPositions: [5] }, unifiedSimilarityGeneration: 12, corpusSourceMatchingEnabledAtComputation: true, unifiedSimilarityFailed: false }),
  }));

  // Then the AI resave (finalization failed → no generation) commits last.
  await exec(args({
    id, aiScore: 0, aiTone: 'low', aiStatus: 'ready',
    payload: basePayload({ id, aiScore: 4.2, aiAnalysis: COMPLETE_ANALYSIS }),
  }));

  const row = await rowOf(id);
  assert.equal(row.payload.unifiedSimilarity.unifiedScore, 88, 'the newer similarity survivor is kept');
  assert.equal(row.payload.unifiedSimilarityGeneration, 12);
  assert.deepEqual(row.payload.unifiedSimilarity.matchedPositions, [5]);
  assert.equal(row.payload.aiAnalysis.status, 'complete', 'the AI analysis merged onto the survivor');
  assert.equal(row.payload.aiScore, 4.2);
  assert.equal(row.ai_status, 'ready');
});
