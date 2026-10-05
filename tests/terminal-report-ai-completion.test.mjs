import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient } from '@libsql/client';

// The detail page is a real client component: next/link and next/navigation are redirected to stand-ins (same arrangement as
// the other SSR tests). Register BEFORE dynamically importing it.
register('./helpers/ssr-next-hooks.mjs', import.meta.url);

import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as aiRetryRoute from '../app/api/reports/[id]/ai-retry/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';
import { completeAiAnalysis } from './helpers/complete-ai-analysis.mjs';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import { createDocumentIdentity } from '../lib/document-identity.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { bumpCorpusMatchGeneration } from '../lib/corpus-match-generation.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';
import { withEvidenceInterpretation, refreshSelectiveCorpusCompletionSignal } from '../lib/report-evidence-interpretation.ts';
import {
  decodeReportFromPersistence,
  encodeReportForPersistence,
  MAX_SERVED_REPORT_BYTES,
  servedReportBytes,
  storedRowExceedsServingBound,
} from '../lib/report-persistence.ts';
import { MAX_REPORT_SAVE_REQUEST_BYTES } from '../lib/report-transport-limits.ts';
import { isCompactPositions } from '../lib/position-runs-persistence.ts';
import { AI_SAVE_OUTCOME_SIZE_UNAVAILABLE, AI_UNAVAILABLE_REASON_REPORT_SIZE } from '../lib/ai-unavailable-state.ts';
import { finalizeSelectiveCorpusAuthoritativeReport } from '../lib/selective-corpus-authoritative.ts';
import { PRIOR_SUBMISSION_MATCH_MAX_ATTEMPTS } from '../lib/report-historical-match.ts';
import {
  resolveReportCompletion,
  SIMILARITY_NOT_FINALIZED_DETAIL,
  SIMILARITY_NOT_FINALIZED_HEADLINE,
} from '../lib/evidence-interpretation/completion.ts';
import { resolveCompletionView, SIMILARITY_UNAVAILABLE_STATUS_LABEL } from '../lib/report-v2-view.ts';
import { stripServerInternalReportFields } from '../lib/report-types.ts';

const { ReportDetailShell } = await import('../app/reports/[id]/report-detail-shell.tsx');

/**
 * A REPORT THE SELECTIVE CORPUS FINALIZER MADE TERMINAL STAYS EXACTLY WHAT IT WAS WHEN ITS AI RESULT ARRIVES.
 *
 * Three rules, each through the real routes, the real finalizer and the real previous-submission matcher:
 *
 *  1. SERVING BOUND. A report admitted only because its positions are stored as ranges must stay servable within
 *     MAX_SERVED_REPORT_BYTES. Merging an AI result into it is measured like writing it whole
 *     (lib/report-persistence.ts storedRowExceedsServingBound): a result that would take it over is not stored next to it —
 *     the whole-report save answers 413 and the AI-result route settles the AI half as "unavailable for this document"
 *     (the existing G2 state). The similarity is never touched to make room.
 *  2. OWNERSHIP. An AI save of a terminal report is not a similarity resolution: it re-runs no previous-submission check and
 *     writes no snapshot or shadow table — only the AI half of the report changes. A pending report, and a report that is
 *     not authoritative, are resolved exactly as before.
 *  3. COPY. A report finalized with no score because its final form could not be stored (PERSISTENCE_LIMIT) is never
 *     described as a partial search with a percentage that is a lower bound, and its page never headlines a percentage.
 *
 * Compact persistence is ON, as in Production. Every corpus and document is synthetic.
 */

const ENV_KEYS = [
  'TURSO_DATABASE_URL',
  'CORPUS_SOURCE_MATCHING_ENABLED',
  'REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED',
  'REPORT_COMPACT_POSITIONS_WRITE_ENABLED',
  'SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED',
  'SELECTIVE_CORPUS_SHADOW_ENABLED',
  'SELECTIVE_CORPUS_ARTIFACT_PATH',
  'IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const workDir = mkdtempSync(path.join(process.env.TURNITPLUS_TEST_DB_DIR || tmpdir(), 'terminal-ai-'));
const dbFile = path.join(workDir, 'terminal_ai.db');
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
process.env.REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED = 'true';
delete process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED;
delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
delete process.env.SELECTIVE_CORPUS_ARTIFACT_PATH;
delete process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH;

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, path.resolve('drizzle'));

// ── statement faults and counts on the previous-submission candidate query, on ANY connection (the routes open their own) ──
const CANDIDATE_PAGE = /GROUP BY s\.representation_id/;
const faults = { queue: [], issued: 0 };
const clientClass = Object.getPrototypeOf(client);
const realExecute = clientClass.execute;
clientClass.execute = function execute(stmt, args) {
  const sql = typeof stmt === 'string' ? stmt : stmt.sql;
  if (!CANDIDATE_PAGE.test(sql)) return realExecute.call(this, stmt, args);
  faults.issued += 1;
  if (faults.queue.shift() === 'reject') return Promise.reject(new Error('simulated transient query failure'));
  return realExecute.call(this, stmt, args);
};

test.after(() => {
  clientClass.execute = realExecute;
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
/** `n` two-letter words: a short manuscript whose evidence (one number per matched word when expanded) dwarfs its text. */
const twoLetterText = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26), 97 + ((i * 7 + 3) % 26))).join(' ');
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const withEnv = async (overrides, fn) => {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const set = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  for (const [key, value] of Object.entries(overrides)) set(key, value);
  try { return await fn(); } finally { for (const [key, value] of Object.entries(previous)) set(key, value); }
};
const silently = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

let accounts = 0;
async function signUp() {
  accounts += 1;
  const tag = `tai-${accounts}`, email = `tai-owner-${accounts}@example.test`, deviceKey = `tai-device-${accounts}`;
  await resetAuthRateForTest(`${tag}-signup`);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${tag}-signup` },
    body: JSON.stringify(withTestIdentity({ email, password: 'tai-owner-pw-1', username: `taiowner${accounts}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = (res.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)[1];
  const userId = String((await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  return { userId, deviceKey, cookie, tag };
}

/** The report as the browser holds it after its check: archive evidence only, no server score, no AI result yet. */
function localReport(id, text, { archiveMatchedPositions = [] } = {}) {
  return {
    version: 11, id, submissionId: `sub-${id}`, title: 'Terminal AI fixture', author: '', assignment: '', created: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    score: 0, archiveScore: 0, scoreBand: 'Low', wordCount: tokensForScoringNormalization(text, 2).length, characterCount: text.length,
    matchedWordCount: archiveMatchedPositions.length, archiveMatchedPositions, scoringNormalizationVersion: 2,
    sources: [], repeats: [], text, academicEvidenceStatus: 'COMPLETE_NO_MATCHES', externalAcademicEvidence: [],
  };
}

/** The row an authoritative first save persists: no unifiedSimilarity, the marker "pending", the AI check still running. */
async function seedPending(owner, report, { compactPositions = false } = {}) {
  const built = withEvidenceInterpretation({ ...report }, { selectiveCorpusBranch: null });
  const payload = { ...encodeReportForPersistence(built, { compactWrites: true, compactPositions }), selectiveCorpusAuthoritativeStatus: 'pending' };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_status, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [report.id, owner.deviceKey, report.submissionId, report.title, report.created, report.wordCount, 0, 'Low', 'processing', JSON.stringify(payload), owner.userId, null],
  });
}
/** A copy of a stored row under another id (an identical stored state for a second scenario). */
const cloneRow = (owner, fromId, toId) => client.execute({
  sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_status, ai_score, ai_tone, payload_json, user_id, verified_device_passport_id)
        SELECT ?, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_status, ai_score, ai_tone, payload_json, user_id, verified_device_passport_id
        FROM saved_reports WHERE device_key = ? AND id = ?`,
  args: [toId, owner.deviceKey, fromId],
});

const passage = (start, end) => ({ submittedWordStart: start, submittedWordEnd: end, matchedWordCount: end - start + 1 });
const completedShadow = (passages) => ({
  state: 'COMPLETED', evaluatorVersion: 'selective-corpus-shadow-v1', corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
  verifiedEvidence: passages.length > 0 ? [{ sourceLabel: 'PMC-TEST-1', matchedPassages: passages }] : [],
});
const finalize = (owner, id, shadowResult) =>
  finalizeSelectiveCorpusAuthoritativeReport(client, { reportDeviceKey: owner.deviceKey, reportId: id, accountId: owner.userId, shadowResult, shadowScoringNormalizationVersion: 2 });

let requests = 0;
/** POST /api/reports as the browser's AI save sends it: the report it holds with the AI result spread over it. */
async function save(owner, report, { aiStatus = 'ready', aiScore = 5, aiTone = 'low', aiAnalysis = completeAiAnalysis(), body = {} } = {}) {
  requests += 1;
  const ip = `${owner.tag}-post-${requests}`;
  await resetRateForTest(ip);
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` },
    body: JSON.stringify({
      deviceKey: owner.deviceKey, id: report.id, submissionId: report.submissionId, title: report.title, createdAt: report.created,
      wordCount: report.wordCount, archiveScore: report.archiveScore, scoreBand: report.scoreBand,
      aiScore, aiTone, aiStatus, scoringNormalization: 2, academicSearchDiagnosticsId: null,
      payload: { ...report, ...(aiAnalysis ? { aiScore, aiAnalysis } : {}) },
      ...body,
    }),
  }));
}
/** POST /api/reports/[id]/ai-retry — the AI-result route the browser falls back to after a 413. */
async function aiResult(owner, id, { aiStatus = 'ready', aiScore = 5, aiTone = 'low', aiAnalysis = completeAiAnalysis() } = {}) {
  requests += 1;
  const ip = `${owner.tag}-air-${requests}`;
  await resetRateForTest(ip);
  const res = await aiRetryRoute.POST(new Request(`http://localhost/api/reports/${id}/ai-retry`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` },
    body: JSON.stringify({ aiStatus, aiScore, aiTone, payload: { aiScore, aiAnalysis } }),
  }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}
async function getAsOwner(owner, id) {
  requests += 1;
  await resetReadRateForTest(`${owner.tag}-get-${requests}`);
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(owner.deviceKey)}`, { headers: { 'x-forwarded-for': `${owner.tag}-get-${requests}`, cookie: `tp_session_v1=${owner.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  assert.equal(res.status, 200);
  return (await res.json()).payload;
}
async function row(owner, id) {
  const r = (await client.execute({ sql: 'SELECT payload_json, ai_status, ai_score, ai_tone FROM saved_reports WHERE device_key = ? AND id = ?', args: [owner.deviceKey, id] })).rows[0];
  const json = String(r.payload_json);
  const raw = JSON.parse(json);
  const { aiAnalysis: _a, aiScore: _s, ...nonAi } = raw;
  return { json, raw, report: decodeReportFromPersistence(JSON.parse(json)), nonAi: JSON.stringify(nonAi), aiStatus: r.ai_status, aiScore: r.ai_score === null ? null : Number(r.ai_score), aiTone: r.ai_tone };
}
async function snapshotRow(owner, id) {
  const r = (await client.execute({ sql: 'SELECT * FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', args: [owner.deviceKey, id] })).rows[0];
  return r ? JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => Number.isNaN(Number(k))))) : null;
}
/** A digest of every table's content, to tell exactly which tables a request wrote. */
async function tableDigest() {
  const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((r) => String(r.name));
  const out = {};
  for (const name of tables) {
    const result = await client.execute(`SELECT * FROM "${name}"`);
    out[name] = sha(result.rows.map((r) => result.columns.map((c) => String(r[c])).join('\u0001')).join('\u0002'));
  }
  return out;
}
const changedTables = (a, b) => Object.keys({ ...a, ...b }).filter((t) => a[t] !== b[t]).sort();
/** Request bookkeeping every request writes (rate limiting) — not report state. */
const BOOKKEEPING = new Set(['rate_limit_buckets']);

async function index(accountId, rawText) {
  await client.execute({ sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [accountId, `${accountId}@example.test`, accountId, 'x'] });
  const identity = await createDocumentIdentity(client, { accountId, title: 't', author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  await matureCorpusBackings(client);
}
/** A 600-word submission whose 120-word passage (words 200-319) another account's earlier submission holds. */
async function priorFixture(seed) {
  const shared = words(120, seed * 101 + 1);
  await index(`tai-other-${seed}`, `${words(250, seed * 101 + 4)} ${shared} ${words(250, seed * 101 + 5)}`);
  return `${words(200, seed * 101 + 2)} ${shared} ${words(280, seed * 101 + 3)}`;
}

// ===========================================================================
// 1. the serving bound
// ===========================================================================

/** A runtime report whose every word matched the archive: `n` positions, admitted only as ranges once n is large. */
function wholeArchiveReport(n) {
  const archiveMatchedPositions = range(0, n - 1);
  return {
    version: 11, id: 1, submissionId: 's', title: 'serving bound', author: '', assignment: '', created: '2026-10-05T00:00:00.000Z', score: 100, archiveScore: 100,
    wordCount: n, scoreBand: 'High', matchedWordCount: n, archiveMatchedPositions, sources: [], repeats: [], text: 't',
    unifiedSimilarity: computeUnifiedSimilarity({ wordCount: n, archiveMatchedPositions }),
  };
}
/** An AI result of known bulk: one passage holding `pad` characters. */
const aiWith = (pad) => ({ ...completeAiAnalysis(), passages: [{ text: 'a'.repeat(pad) }] });

test('1. SERVING BOUND (the merge rule): a merged row only ranges admit is over the bound exactly when its report as served is over MAX_SERVED_REPORT_BYTES (the `>` every writer uses); an array row, or one whose array form fits, never is', () => {
  const report = wholeArchiveReport(200_000);
  const stored = (pad, compactPositions = true) => JSON.stringify({ ...encodeReportForPersistence(report, { compactWrites: true, compactPositions }), aiScore: 5, aiAnalysis: aiWith(pad) });
  const servedOf = (json) => servedReportBytes(decodeReportFromPersistence(JSON.parse(json)));
  assert.ok(JSON.stringify(encodeReportForPersistence(report, { compactWrites: true, compactPositions: false })).length > MAX_REPORT_SAVE_REQUEST_BYTES, 'test setup: the array form is over the ceiling');
  const base = servedOf(stored(0));
  assert.ok(base < MAX_SERVED_REPORT_BYTES, `test setup: served ${base} before the AI result grows`);
  for (const [delta, over] of [[-1, false], [0, false], [1, true]]) {
    const json = stored(MAX_SERVED_REPORT_BYTES - base + delta);
    assert.equal(servedOf(json), MAX_SERVED_REPORT_BYTES + delta, 'test setup: the exact served size');
    assert.ok(json.length <= MAX_REPORT_SAVE_REQUEST_BYTES, 'and the row itself fits the ceiling: only the serving bound decides');
    assert.equal(storedRowExceedsServingBound(json, MAX_REPORT_SAVE_REQUEST_BYTES), over, `served MAX ${delta >= 0 ? '+' : ''}${delta}`);
  }
  // the same report and AI result with its positions as arrays: no compact list, never subject (exactly as before ranges)
  assert.equal(storedRowExceedsServingBound(stored(MAX_SERVED_REPORT_BYTES - base + 1, false), MAX_REPORT_SAVE_REQUEST_BYTES), false);
  // a compact row whose array form fits the ceiling: admitted before ranges existed, never subject
  const small = wholeArchiveReport(10_000);
  const smallJson = JSON.stringify({ ...encodeReportForPersistence(small, { compactWrites: true, compactPositions: true }), aiScore: 5, aiAnalysis: aiWith(1_000) });
  assert.ok(isCompactPositions(JSON.parse(smallJson).archiveMatchedPositions));
  assert.equal(storedRowExceedsServingBound(smallJson, MAX_REPORT_SAVE_REQUEST_BYTES), false);
  // nothing a damaged or foreign value could make it throw on
  for (const junk of ['', 'not json', '[]', 'null', '{"unifiedSimilarity":7}']) assert.equal(storedRowExceedsServingBound(junk, MAX_REPORT_SAVE_REQUEST_BYTES), false);
});

/**
 * A 150,000-word authoritative report the finalizer completed at 100 % from Selective Corpus evidence, its positions stored as
 * ranges. The evidence exists only on the server (the browser's copy carries none), so the browser's whole-report AI save is
 * small while the report it is merged into is served at several megabytes — the shape in which the merge decides.
 */
const LARGE_WORDS = 150_000;
async function largeFinalizedReport(owner, id) {
  const n = LARGE_WORDS;
  const text = twoLetterText(n);
  const report = localReport(id, text);
  assert.equal(report.wordCount, n, 'test setup: every two-letter token is a word');
  await withEnv({ REPORT_COMPACT_POSITIONS_WRITE_ENABLED: 'true' }, async () => {
    await seedPending(owner, report, { compactPositions: true });
    assert.deepEqual(await silently(() => finalize(owner, id, completedShadow([passage(0, n - 1)]))), { outcome: 'finalized', status: 'completed' });
  });
  const stored = await row(owner, id);
  assert.ok(isCompactPositions(stored.raw.unifiedSimilarity.matchedPositions), 'test setup: stored as ranges');
  assert.equal(stored.report.unifiedSimilarity.unifiedScore, 100);
  return { report, stored, served: servedReportBytes(stored.report) };
}
/** The exact served size of `owner`'s row `id` with this AI result merged by the AI-result route's own statement. */
async function servedWithAi(owner, id, aiScore, aiAnalysis) {
  const merged = (await client.execute({
    sql: `SELECT json_set(payload_json, '$.aiAnalysis', json(?), '$.aiScore', ?) AS merged FROM saved_reports WHERE device_key = ? AND id = ?`,
    args: [JSON.stringify(aiAnalysis), aiScore, owner.deviceKey, id],
  })).rows[0].merged;
  return servedReportBytes(decodeReportFromPersistence(JSON.parse(String(merged))));
}
/** An AI result that makes `owner`'s row `id` serve at exactly MAX_SERVED_REPORT_BYTES + delta once merged. */
async function aiAtServedBound(owner, id, delta) {
  let pad = 0;
  for (let i = 0; i < 3; i += 1) pad += MAX_SERVED_REPORT_BYTES + delta - (await servedWithAi(owner, id, 7, aiWith(pad)));
  const analysis = aiWith(pad);
  assert.equal(await servedWithAi(owner, id, 7, analysis), MAX_SERVED_REPORT_BYTES + delta, 'test setup: the exact merged served size');
  return analysis;
}

test('2. SERVING BOUND through the AI-result route (gate ON): a result that leaves the report served at MAX - 1 or MAX is stored; at MAX + 1 the AI half is settled "unavailable" — the score, the positions and the report a reader is sent are untouched in all three', async () => {
  const owner = await signUp();
  const { stored: finalized, served } = await largeFinalizedReport(owner, 'tai-bound');
  assert.ok(served < MAX_SERVED_REPORT_BYTES - 100_000, `test setup: served ${served}`);
  for (const delta of [-1, 0, 1]) await cloneRow(owner, 'tai-bound', `tai-bound${delta}`);

  for (const delta of [-1, 0, 1]) {
    const id = `tai-bound${delta}`;
    const analysis = await aiAtServedBound(owner, id, delta);
    const res = await aiResult(owner, id, { aiScore: 7, aiAnalysis: analysis });
    assert.equal(res.status, 200, `MAX ${delta}`);
    const after = await row(owner, id);
    assert.equal(after.nonAi, finalized.nonAi, `MAX ${delta}: every stored key but the AI half is byte-identical`);
    assert.equal(after.report.unifiedSimilarity.unifiedScore, 100);
    if (delta <= 0) {
      assert.equal(res.body.aiOutcome, undefined, `MAX ${delta}: the real result is stored`);
      assert.deepEqual([after.aiStatus, after.aiScore], ['ready', 7]);
      assert.equal(servedReportBytes(after.report), MAX_SERVED_REPORT_BYTES + delta);
    } else {
      assert.equal(res.body.aiOutcome, AI_SAVE_OUTCOME_SIZE_UNAVAILABLE, 'MAX + 1: settled as AI unavailable for this document');
      assert.deepEqual([after.aiStatus, after.aiScore, after.aiTone], ['failed', null, 'unavailable']);
      assert.equal(after.raw.aiAnalysis.unavailableReason, AI_UNAVAILABLE_REASON_REPORT_SIZE);
      assert.ok(servedReportBytes(after.report) <= served + 1_024, 'served as admitted plus the marker');
    }
    const seen = await getAsOwner(owner, id);
    assert.equal(seen.unifiedSimilarity.unifiedScore, 100, `MAX ${delta}: GET reads the same score`);
    assert.equal(seen.unifiedSimilarity.matchedPositions.length, LARGE_WORDS);
    assert.ok(seen.unifiedSimilarity.matchedPositions.every((p, i) => p === i), `MAX ${delta}: and the exact positions`);
  }
});

test('3. SERVING BOUND through the whole-report AI save of a terminal report: one byte over is refused 413 with nothing written (one byte under is stored); the AI-result route then settles it (what the browser does next) — and a stored ready result is never displaced by an oversized one', async () => {
  const owner = await signUp();
  const { report, stored: finalized } = await largeFinalizedReport(owner, 'tai-post');
  for (const suffix of ['at', 'ready']) await cloneRow(owner, 'tai-post', `tai-post-${suffix}`);
  const over = await aiAtServedBound(owner, 'tai-post', 1);
  const at = await aiAtServedBound(owner, 'tai-post-at', 0);
  const post =(id, analysis, aiScore = 7) => withEnv({ REPORT_COMPACT_POSITIONS_WRITE_ENABLED: 'true' }, () => save(owner, { ...report, id }, { aiScore, aiAnalysis: analysis }));

  assert.equal((await post('tai-post-at', at)).status, 200, 'served exactly at the bound: stored');
  const stored = await row(owner, 'tai-post-at');
  assert.deepEqual([stored.aiStatus, stored.aiScore], ['ready', 7]);
  assert.equal(stored.nonAi, finalized.nonAi);

  const res = await post('tai-post', over);
  assert.equal(res.status, 413, 'one byte over the bound: the save that would make the report unservable is refused');
  const refused = await row(owner, 'tai-post');
  assert.equal(refused.json, finalized.json, 'nothing was written');
  assert.equal(refused.aiStatus, 'processing');

  const settled = await aiResult(owner, 'tai-post', { aiScore: 7, aiAnalysis: over });
  assert.equal(settled.body.aiOutcome, AI_SAVE_OUTCOME_SIZE_UNAVAILABLE);
  const after = await row(owner, 'tai-post');
  assert.equal(after.nonAi, finalized.nonAi, 'similarity exactly as finalized');
  assert.deepEqual([after.aiStatus, after.aiScore], ['failed', null]);

  // a small ready result first (it fits), then the oversized one through either route: the ready result stays
  assert.equal((await post('tai-post-ready', completeAiAnalysis(), 6)).status, 200, 'a small result fits beside it');
  const ready = await row(owner, 'tai-post-ready');
  assert.deepEqual([ready.aiStatus, ready.aiScore], ['ready', 6]);
  assert.equal((await post('tai-post-ready', over)).status, 413);
  assert.equal((await aiResult(owner, 'tai-post-ready', { aiScore: 7, aiAnalysis: over })).status, 200);
  assert.equal((await row(owner, 'tai-post-ready')).json, ready.json, 'the stored ready result is not displaced');
});

test('4. SERVING BOUND: a row whose positions are arrays (everything written with the gate OFF) takes its AI result with no serving check, exactly as before', async () => {
  const owner = await signUp();
  const report = localReport('tai-arrays', words(3000, 41), { archiveMatchedPositions: range(100, 399) });
  await seedPending(owner, report);
  assert.deepEqual(await finalize(owner, 'tai-arrays', completedShadow([passage(500, 799)])), { outcome: 'finalized', status: 'completed' });
  const before = await row(owner, 'tai-arrays');
  assert.ok(Array.isArray(before.raw.unifiedSimilarity.matchedPositions), 'test setup: arrays');
  const res = await aiResult(owner, 'tai-arrays', { aiScore: 9 });
  assert.deepEqual([res.status, res.body.aiOutcome], [200, undefined]);
  const after = await row(owner, 'tai-arrays');
  assert.deepEqual([after.aiStatus, after.aiScore], ['ready', 9]);
  assert.equal(after.nonAi, before.nonAi);
});

// ===========================================================================
// 2. ownership: an AI save of a terminal report resolves nothing
// ===========================================================================

async function assertAiSaveChangesOnlyAi(owner, report, label) {
  const seenBefore = await getAsOwner(owner, report.id);
  const before = await row(owner, report.id);
  const snapshotBefore = await snapshotRow(owner, report.id);
  assert.ok(snapshotBefore, `${label}: test setup: the finalizer stored a snapshot`);
  const tablesBefore = await tableDigest();
  const issuedBefore = faults.issued;

  assert.equal((await save(owner, report, { aiScore: 6 })).status, 200, `${label}: AI save`);
  assert.equal((await save(owner, report, { aiScore: 8 })).status, 200, `${label}: repeated AI save`);

  assert.equal(faults.issued - issuedBefore, 0, `${label}: no previous-submission candidate query — the check was not re-run`);
  assert.equal(await snapshotRow(owner, report.id), snapshotBefore, `${label}: the snapshot row is byte-identical`);
  assert.deepEqual(changedTables(tablesBefore, await tableDigest()).filter((t) => !BOOKKEEPING.has(t)), ['saved_reports'], `${label}: no table but the report's own row was written (no snapshot, no shadow evaluation)`);
  const after = await row(owner, report.id);
  assert.equal(after.nonAi, before.nonAi, `${label}: every stored key but the AI half is byte-identical (similarity, completion, retry state, stamps)`);
  assert.deepEqual([after.aiStatus, after.aiScore], ['ready', 8], `${label}: the AI half is stored`);
  const seenAfter = await getAsOwner(owner, report.id);
  assert.deepEqual(seenAfter.unifiedSimilarity, seenBefore.unifiedSimilarity, `${label}: the customer reads the same result`);
  assert.deepEqual(seenAfter.reportCompletion, seenBefore.reportCompletion, `${label}: and the same completion`);
}

test('5. OWNERSHIP: a terminal COMPLETED report — the AI save re-runs no previous-submission check and writes no snapshot or shadow table; only its AI half changes', async () => {
  const owner = await signUp();
  const text = await priorFixture(51);
  const report = localReport('tai-own-complete', text);
  await seedPending(owner, report);
  faults.queue = [];
  assert.deepEqual(await finalize(owner, report.id, completedShadow([passage(400, 499)])), { outcome: 'finalized', status: 'completed' });
  const finalized = await row(owner, report.id);
  assert.equal(finalized.report.reportCompletion.signals.priorSubmission, 'COMPLETE');
  assert.ok(finalized.report.unifiedSimilarity.previousUploadOnlyWords > 0, 'test setup: the prior source is in the score');
  await assertAiSaveChangesOnlyAi(owner, report, 'COMPLETED');
});

test('6. OWNERSHIP: a terminal report whose previous-submission check stayed cut short (PARTIAL) — the AI save does not re-run it once the queries answer again: it stays PARTIAL, the snapshot row is untouched, the score does not change', async () => {
  const owner = await signUp();
  const text = await priorFixture(52);
  const report = localReport('tai-own-partial', text);
  await seedPending(owner, report);
  faults.queue = Array(PRIOR_SUBMISSION_MATCH_MAX_ATTEMPTS).fill('reject');
  assert.deepEqual(await finalize(owner, report.id, completedShadow([passage(400, 499)])), { outcome: 'finalized', status: 'completed' });
  faults.queue = []; // the previous-submission queries answer again from here on
  const finalized = await row(owner, report.id);
  assert.equal(finalized.report.reportCompletion.signals.priorSubmission, 'PARTIAL', 'test setup: the check stayed cut short');
  assert.equal(finalized.report.unifiedSimilarity.previousUploadOnlyWords, 0, 'test setup: and its source is not in the score');
  await assertAiSaveChangesOnlyAi(owner, report, 'PARTIAL');
  assert.equal((await getAsOwner(owner, report.id)).reportCompletion.state, 'PARTIAL', 'still a partial search: an AI save neither heals nor regresses it');
});

test('7. OWNERSHIP does not freeze a PENDING report: an AI save while pending still resolves (the previous-submission check runs), and the finalizer then finalizes it normally', async () => {
  const owner = await signUp();
  const text = await priorFixture(53);
  const report = localReport('tai-own-pending', text);
  await seedPending(owner, report);
  const issuedBefore = faults.issued;
  assert.equal((await save(owner, report, { aiScore: 6 })).status, 200);
  assert.ok(faults.issued > issuedBefore, 'the pending report was resolved as before');
  const pending = await row(owner, report.id);
  assert.equal(pending.raw.selectiveCorpusAuthoritativeStatus, 'pending');
  assert.equal(pending.raw.unifiedSimilarity, undefined, 'and still has no score');
  assert.deepEqual(await finalize(owner, report.id, completedShadow([passage(400, 499)])), { outcome: 'finalized', status: 'completed' });
  const finalized = await row(owner, report.id);
  assert.ok(finalized.report.unifiedSimilarity.previousUploadOnlyWords > 0 && finalized.report.unifiedSimilarity.selectiveCorpusOnlyWords > 0, 'finalized with the previous-submission and Selective Corpus evidence');
  assert.deepEqual([finalized.aiStatus, finalized.aiScore], ['ready', 6], 'beside the AI result');
});

test('8. OWNERSHIP does not touch a report that is not authoritative: a later save re-resolves it, finds evidence that became available, and the score moves', async () => {
  const owner = await signUp();
  const shared = words(120, 5801);
  const report = localReport('tai-ordinary', `${words(200, 5802)} ${shared} ${words(280, 5803)}`);
  assert.equal((await save(owner, report, { aiStatus: 'processing', aiScore: null, aiTone: null, aiAnalysis: null, body: { room: 0 } })).status, 200);
  const first = await row(owner, report.id);
  assert.equal(first.raw.selectiveCorpusAuthoritativeStatus, undefined, 'test setup: not authoritative');
  assert.equal(first.report.unifiedSimilarity.unifiedScore, 0);
  await index('tai-later-source', `${words(250, 5804)} ${shared} ${words(250, 5805)}`);
  await bumpCorpusMatchGeneration(client);
  const issuedBefore = faults.issued;
  assert.equal((await save(owner, report)).status, 200);
  assert.ok(faults.issued > issuedBefore, 'the check ran');
  const healed = await row(owner, report.id);
  assert.equal(healed.report.unifiedSimilarity.unifiedScore, 20, '120 of 600 words');
  assert.ok(healed.report.unifiedSimilarityGeneration > first.report.unifiedSimilarityGeneration);
});

// ===========================================================================
// 3. the copy of a report finalized with no score (PERSISTENCE_LIMIT)
// ===========================================================================

const FALSE_FOR_NO_SCORE = [/The \d+% shown/, /lower bound/i, /Partial search/i, /reference index/i, /sources were unavailable/i, /could not reach/i];

test('9. COPY: a PERSISTENCE_LIMIT completion says the similarity could not be finalized — never a percentage that is a lower bound, never an unavailable index; the reason stays in the admin diagnostics; other partial searches keep their wording', () => {
  for (const pct of [0, 13, undefined]) {
    const completion = resolveReportCompletion({ selectiveCorpus: 'PARTIAL', selectiveCorpusIncompleteReason: 'PERSISTENCE_LIMIT', academicSearch: 'COMPLETE_NO_MATCHES', verifiedSimilarityPercent: pct });
    assert.equal(completion.state, 'PARTIAL', 'not a completed check');
    assert.equal(completion.headline, SIMILARITY_NOT_FINALIZED_HEADLINE);
    assert.equal(completion.detail, SIMILARITY_NOT_FINALIZED_DETAIL);
    const customerText = [completion.headline, completion.detail, ...completion.reasons].join(' ');
    for (const pattern of FALSE_FOR_NO_SCORE) assert.doesNotMatch(customerText, pattern, `pct ${pct}: ${pattern}`);
    assert.match(completion.detail, /not a 0% result/, 'and says outright that no percentage is a 0% result');
    assert.match(customerText, /too large to process/, 'the reason is a technical size limit');
    assert.deepEqual(completion.diagnostics, [{ channel: 'SELECTIVE_CORPUS', reason: 'PERSISTENCE_LIMIT' }], 'admin diagnostics keep the code');
    // the view keeps it (a customer's completion has no diagnostics)
    const { diagnostics: _admin, ...customer } = completion;
    const view = resolveCompletionView(customer, undefined, pct ?? 0);
    assert.equal(view.statusLabel, SIMILARITY_UNAVAILABLE_STATUS_LABEL);
    assert.equal(view.headline, SIMILARITY_NOT_FINALIZED_HEADLINE);
    assert.equal(view.detail, SIMILARITY_NOT_FINALIZED_DETAIL);
  }
  for (const reason of ['TIMEOUT', 'PARTIAL_INDEX', 'ARTIFACT_UNAVAILABLE', 'FINALIZER_ERROR']) {
    const completion = resolveReportCompletion({ selectiveCorpus: 'PARTIAL', selectiveCorpusIncompleteReason: reason, verifiedSimilarityPercent: 13 });
    assert.equal(completion.headline, 'Partial search: some sources were unavailable.', reason);
    assert.match(completion.detail, /The 13% shown is a verified lower bound/, reason);
    assert.deepEqual(completion.reasons, ['part of the TurnitPlus reference index was unavailable at search time'], reason);
    const view = resolveCompletionView(completion, undefined, 13);
    assert.equal(view.statusLabel, 'Partial search', reason);
    assert.match(view.detail, /The 13% shown is a verified lower bound/, reason);
  }
});

/** A stored PERSISTENCE_LIMIT report as GET serves it to its owner: no score, Archive evidence (a 13 % archive-only fallback). */
function persistenceLimitPayload({ admin = false } = {}) {
  const text = words(1200, 77);
  const pending = withEvidenceInterpretation({ ...localReport('tai-copy', text, { archiveMatchedPositions: range(300, 449) }), score: 13, archiveScore: 13 }, { selectiveCorpusBranch: null });
  const payload = { ...pending, unifiedSimilarityFailed: true, selectiveCorpusAuthoritativeStatus: 'incomplete', selectiveCorpusAuthoritativeIncompleteReason: 'PERSISTENCE_LIMIT' };
  refreshSelectiveCorpusCompletionSignal(payload);
  stripServerInternalReportFields(payload, { viewerIsAdmin: admin });
  return payload;
}

test('10. COPY: the completion a customer is sent for a stored PERSISTENCE_LIMIT report (refreshed at read time from the terminal marker) is the not-finalized copy', () => {
  const payload = persistenceLimitPayload();
  assert.equal(payload.unifiedSimilarity, undefined, 'test setup: no score');
  assert.equal(payload.reportCompletion.headline, SIMILARITY_NOT_FINALIZED_HEADLINE);
  assert.equal(payload.reportCompletion.detail, SIMILARITY_NOT_FINALIZED_DETAIL);
  for (const pattern of FALSE_FOR_NO_SCORE) assert.doesNotMatch(JSON.stringify(payload.reportCompletion), pattern);
  assert.equal('diagnostics' in payload.reportCompletion, false, 'the reason code is not a customer field');
  assert.deepEqual(persistenceLimitPayload({ admin: true }).reportCompletion.diagnostics, [{ channel: 'SELECTIVE_CORPUS', reason: 'PERSISTENCE_LIMIT' }]);
});

test('11. COPY: the report page of a report with no similarity score headlines no percentage — the established "Similarity unavailable" presentation, never the archive-only fallback as its similarity score; a report with a score keeps the V2 workspace', () => {
  const visible = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
  const render = (initialReport, initialSimilarityStatus) => renderToStaticMarkup(React.createElement(ReportDetailShell, {
    id: 'tai-copy', initialReport, initialAiStatus: 'ready', initialAiScore: 5, initialAiTone: 'low', initialSimilarityStatus, requiresClientResolution: false, mode: 'similarity', backRoom: 0,
  }));
  const html = render(persistenceLimitPayload(), 'failed');
  const text = visible(html);
  assert.doesNotMatch(html, /rv2ws-hero/, 'no V2 workspace headline');
  assert.doesNotMatch(text, /\d+% Similarity score|Similarity score \d+%/, 'no percentage presented as the similarity score');
  for (const pattern of FALSE_FOR_NO_SCORE) assert.doesNotMatch(text, pattern);
  assert.match(text, /Similarity unavailable/);
  assert.match(text, /Similarity analysis is currently unavailable for this document/);

  // the same report WITH a score: the V2 workspace, as before
  const scored = withEvidenceInterpretation({ ...localReport('tai-copy', words(1200, 77), { archiveMatchedPositions: range(300, 449) }), unifiedSimilarity: computeUnifiedSimilarity({ wordCount: 1200, archiveMatchedPositions: range(300, 449) }) }, { selectiveCorpusBranch: null });
  assert.match(render(scored, 'resolved'), /rv2ws-hero/, 'a scored report keeps the workspace');
});
