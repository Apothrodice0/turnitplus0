import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';
import { completeAiAnalysis } from './helpers/complete-ai-analysis.mjs';
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';
import { tokens } from '../lib/similarity-core.ts';
import { decodeReportFromPersistence } from '../lib/report-persistence.ts';
import { createDocumentIdentity } from '../lib/document-identity.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { USER_SUBMISSION_MATCH_THRESHOLDS } from '../lib/user-submission-matching.ts';
import {
  getOrComputeHistoricalMatchSnapshot,
  PRIOR_SUBMISSION_MATCH_MAX_ATTEMPTS,
  SNAPSHOT_MATCHER_VERSION,
} from '../lib/report-historical-match.ts';
import { withEvidenceInterpretation, priorSubmissionBranchState } from '../lib/report-evidence-interpretation.ts';
import { finalizeSelectiveCorpusAuthoritativeReport, MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS } from '../lib/selective-corpus-authoritative.ts';

/**
 * A TRANSIENT previous-submission failure heals inside the resolution that hit
 * it. Before this, a matching pass cut short on a first save (a slow candidate
 * query on a cold instance) left the report "Partial search" — and without any
 * source the pass never reached — until the browser happened to save the
 * report again; no read ever recomputes it.
 *
 * Now a pass that was CUT SHORT is run again, at most
 * PRIOR_SUBMISSION_MATCH_MAX_ATTEMPTS passes per resolution, by how it ended:
 *   - QUERY_FAILED or a thrown error: re-issued up to the bound;
 *   - TIME_BUDGET: re-run once, and again only while a re-run got further —
 *     two passes out of time at the same point are bound by the work;
 *   - a pass that examined every candidate and is partial only because a
 *     candidate is over the size limit: never — that answer does not change.
 *
 * Every failure here is injected on the statement, never produced by a slow
 * machine: nothing in the corpus or the manuscript changes between passes.
 * Completion reliability only — no score, position or threshold moves. Every
 * corpus is synthetic.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_prior_submission_transient_retry.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

// ── statement faults ───────────────────────────────────────────────────────
// The save route opens its own connections, so faults are injected on the
// connection class: each queued fault applies to the next statement, on ANY
// connection, whose SQL matches its pattern.
//   'ok'         the statement runs normally
//   'reject'     it fails at once (a query error)
//   { slowMs }   it is answered late (the matcher gives up waiting)
//   function     runs first; the statement then runs normally
const CANDIDATE_PAGE = /GROUP BY s\.representation_id/;
const REPRESENTATION_LOAD = /FROM corpus_document_representations WHERE id = \?/;
const OWN_IDENTITIES = /FROM document_identities WHERE account_id = \? AND canonical_sha256 = \?/;
const PATTERNS = [CANDIDATE_PAGE, REPRESENTATION_LOAD, OWN_IDENTITIES];
const faults = new Map();
const issued = new Map();
const queue = (pattern, ...list) => faults.set(pattern, list);
const issuedCount = (pattern) => issued.get(pattern) ?? 0;
function clearFaults() {
  faults.clear();
  issued.clear();
}
function faultedExecute(realExecute) {
  return function execute(stmt, args) {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    const pattern = PATTERNS.find((p) => p.test(sql));
    if (!pattern) return realExecute.call(this, stmt, args);
    issued.set(pattern, issuedCount(pattern) + 1);
    const fault = faults.get(pattern)?.shift();
    if (fault === 'reject') return Promise.reject(new Error('simulated transient query failure'));
    if (fault && typeof fault === 'object') {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try { realExecute.call(this, stmt, args).then(resolve, reject); } catch (err) { reject(err); }
        }, fault.slowMs);
      });
    }
    if (typeof fault === 'function') fault();
    return realExecute.call(this, stmt, args);
  };
}
const clientClass = Object.getPrototypeOf(client);
const realExecute = clientClass.execute;
clientClass.execute = faultedExecute(realExecute);

// The matcher's time budget is a Date.now() deadline: moving the clock forward
// mid-pass spends it without waiting.
const realNow = Date.now;
let clockSkewMs = 0;
Date.now = () => realNow() + clockSkewMs;
const spendTimeBudget = () => { clockSkewMs += USER_SUBMISSION_MATCH_THRESHOLDS.matchTimeBudgetMs + 500; };

test.after(() => {
  clientClass.execute = realExecute;
  Date.now = realNow;
  client.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

// ── fixtures ───────────────────────────────────────────────────────────────
const SYLLABLES = ['ka', 'lo', 'mi', 'tre', 'vun', 'sor', 'bel', 'dra', 'phi', 'quen', 'zor', 'tal', 'mer', 'nix', 'ost', 'ula', 'rin', 'vek', 'dom', 'sha', 'gri', 'pol', 'wex', 'yun'];
function words(count, seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length]);
  return out.join(' ');
}
/** A 600-word submission holding a 120-word passage (20 %) that `source`, `secondSource` and `thirdSource` also hold. */
function fixture(seed) {
  const passage = words(120, seed * 101 + 1);
  const submission = `${words(200, seed * 101 + 2)} ${passage} ${words(280, seed * 101 + 3)}`;
  return {
    submission,
    wordCount: tokens(submission).length,
    source: `${words(250, seed * 101 + 4)} ${passage} ${words(250, seed * 101 + 5)}`,
    secondSource: `${words(300, seed * 101 + 6)} ${passage} ${words(300, seed * 101 + 7)}`,
    thirdSource: `${words(350, seed * 101 + 10)} ${passage} ${words(350, seed * 101 + 11)}`,
    ownDraft: (k) => `${submission} ${words(20, seed * 101 + 50 + k)}`,
    unrelated: words(600, seed * 101 + 9),
  };
}
async function index(accountId, rawText) {
  await client.execute({ sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [accountId, `${accountId}@example.test`, accountId, 'x'] });
  const identity = await createDocumentIdentity(client, { accountId, title: 't', author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  const row = await client.execute({ sql: 'SELECT representation_id FROM corpus_submission_references WHERE document_identity_id = ?', args: [identity.id] });
  return String(row.rows[0].representation_id);
}
const inflateWordCount = (representationId) =>
  client.execute({ sql: 'UPDATE corpus_document_representations SET word_count = 999999 WHERE id = ?', args: [representationId] });

/** One write-capable resolution of the check, as resolvePrimarySimilaritySummary makes it. */
let resolutions = 0;
function resolve(fx, { accountId = 'tr-submitter', reportId } = {}) {
  resolutions += 1;
  return getOrComputeHistoricalMatchSnapshot(client, {
    reportDeviceKey: 'tr-device',
    reportId: reportId ?? `tr-report-${resolutions}`,
    accountId,
    rawText: fx.submission,
    excludeAccountId: accountId ?? undefined,
    corpusSourceMatchingEnabled: true,
  });
}
async function snapshotRow(reportId, reportDeviceKey = 'tr-device') {
  const row = await client.execute({ sql: 'SELECT status, is_partial, candidate_count, error_message FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?', args: [reportDeviceKey, reportId] });
  const r = row.rows[0];
  return r ? { status: String(r.status), isPartial: Number(r.is_partial), candidateCount: r.candidate_count === null ? null : Number(r.candidate_count), errorMessage: r.error_message } : null;
}
/** Runs `work` and returns the prior_submission_check log lines it emitted, parsed. */
async function capturingCheckLog(work) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('"prior_submission_check"')) lines.push(args[0]);
    else original(...args);
  };
  try {
    const result = await work();
    return { result, lines, events: lines.map((line) => JSON.parse(line)) };
  } finally {
    console.warn = original;
  }
}

// ===========================================================================
// The bound, and what it does not change
// ===========================================================================

test('the retry is bounded, and changes no budget, threshold or snapshot tag', () => {
  assert.equal(PRIOR_SUBMISSION_MATCH_MAX_ATTEMPTS, 3);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.matchTimeBudgetMs, 2_500, 'each pass keeps the same time budget');
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.dbQueryTimeoutMs, 1_500, 'each pass keeps the same query wait');
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidateWordCount, 20_000);
  assert.equal(SNAPSHOT_MATCHER_VERSION, 'user-submission-match-v5+pos.raw-token-v1+cfg.6fa25f8561c8', 'no stored snapshot is invalidated');
});

// ===========================================================================
// One resolution: which passes are run again
// ===========================================================================

test('a complete first pass is the only pass, and logs nothing', async () => {
  const fx = fixture(1);
  await index('tr-other-1', fx.source);
  await matureCorpusBackings(client);
  clearFaults();
  const { result, lines } = await capturingCheckLog(() => resolve(fx));
  assert.equal(result.status, 'MATCHED');
  assert.notEqual(result.partial, true);
  assert.equal(issuedCount(CANDIDATE_PAGE), 1, 'one pass');
  assert.deepEqual(lines, [], 'the ordinary path emits no new log line');
});

test('QUERY_FAILED on the first pass, then no candidates -> COMPLETE, one extra pass', async () => {
  const fx = fixture(2);
  await index('tr-other-2', fx.unrelated);
  await matureCorpusBackings(client);
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject');
  const { result, events } = await capturingCheckLog(() => resolve(fx));
  assert.equal(result.status, 'NO_HISTORICAL_MATCH');
  assert.notEqual(result.partial, true, 'the pass that completed is the result');
  assert.equal(priorSubmissionBranchState(result), 'COMPLETE');
  assert.equal(issuedCount(CANDIDATE_PAGE), 2);
  assert.deepEqual((await snapshotRow(`tr-report-${resolutions}`)).isPartial, 0);
  assert.equal(events.length, 1);
  assert.deepEqual(
    { result: events[0].result, attempts: events[0].attempts, maxAttempts: events[0].maxAttempts, stops: events[0].stops },
    { result: 'recovered', attempts: 2, maxAttempts: 3, stops: ['QUERY_FAILED', 'CANDIDATES_EXHAUSTED'] },
  );
});

test('QUERY_FAILED on the first pass, then verified evidence -> COMPLETE with the source the first pass never reached', async () => {
  const fx = fixture(3);
  const sourceId = await index('tr-other-3', fx.source);
  await matureCorpusBackings(client);
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject');
  const { result, lines } = await capturingCheckLog(() => resolve(fx));
  assert.equal(result.status, 'MATCHED');
  assert.notEqual(result.partial, true);
  assert.deepEqual(result.matches.map((m) => [m.relationshipType, m.matchedRepresentationId]), [['PRIOR_SUBMISSION', sourceId]]);
  assert.equal(priorSubmissionBranchState(result), 'COMPLETE');
  assert.equal(issuedCount(CANDIDATE_PAGE), 2);
  // The log line is counts and enums: nothing that identifies a report, an account or a source.
  assert.equal(lines.length, 1);
  for (const identifier of [sourceId, 'tr-device', `tr-report-${resolutions}`, 'tr-submitter', 'tr-other-3']) {
    assert.equal(lines[0].includes(identifier), false, identifier);
  }
});

test('TIME_BUDGET on the first pass (one of two sources verified) -> the next pass verifies both', async () => {
  const fx = fixture(4);
  await index('tr-other-4a', fx.source);
  await index('tr-other-4b', fx.secondSource);
  await matureCorpusBackings(client);
  clearFaults();
  // The budget runs out while the first source is being loaded.
  queue(REPRESENTATION_LOAD, spendTimeBudget);
  const { result, events } = await capturingCheckLog(() => resolve(fx));
  assert.equal(result.status, 'MATCHED');
  assert.notEqual(result.partial, true);
  assert.equal(result.matches.length, 2, 'both sources, not only the one the cut-short pass reached');
  assert.deepEqual(events[0].stops, ['TIME_BUDGET', 'CANDIDATES_EXHAUSTED']);
  assert.equal(events[0].result, 'recovered');
});

test('TIME_BUDGET twice at the same point is work-bound: the passes stop at two, short of the bound', async () => {
  const fx = fixture(13);
  await index('tr-other-13a', fx.source);
  await index('tr-other-13b', fx.secondSource);
  await matureCorpusBackings(client);
  clearFaults();
  // Every pass runs out of time after its first source: more work than fits, not a slow run.
  let loadsInThisPass = 0;
  const spendOnFirstLoadOfEachPass = () => {
    loadsInThisPass += 1;
    if (loadsInThisPass === 1) spendTimeBudget();
  };
  queue(CANDIDATE_PAGE, () => { loadsInThisPass = 0; }, () => { loadsInThisPass = 0; }, () => { loadsInThisPass = 0; });
  queue(REPRESENTATION_LOAD, ...Array(6).fill(spendOnFirstLoadOfEachPass));
  const { result, events } = await capturingCheckLog(() => resolve(fx));
  assert.deepEqual(events[0].stops, ['TIME_BUDGET', 'TIME_BUDGET'], 'a third identical pass is not run');
  assert.equal(issuedCount(CANDIDATE_PAGE), 2);
  assert.equal(result.partial, true);
  assert.equal(result.matches.length, 1, 'what was verified is kept: a lower bound');
  assert.equal(priorSubmissionBranchState(result), 'PARTIAL');
  assert.equal(events[0].result, 'partial');
});

test('TIME_BUDGET re-runs that each get further go on to the bound', async () => {
  const fx = fixture(14);
  await index('tr-other-14a', fx.source);
  await index('tr-other-14b', fx.secondSource);
  await index('tr-other-14c', fx.thirdSource);
  await matureCorpusBackings(client);
  clearFaults();
  // Pass 1 runs out of time on its first source, pass 2 on its second, pass 3 verifies all three.
  queue(REPRESENTATION_LOAD, spendTimeBudget, 'ok', spendTimeBudget);
  const { result, events } = await capturingCheckLog(() => resolve(fx));
  assert.deepEqual(events[0].stops, ['TIME_BUDGET', 'TIME_BUDGET', 'CANDIDATES_EXHAUSTED']);
  assert.notEqual(result.partial, true);
  assert.equal(result.matches.length, 3);
  assert.equal(events[0].result, 'recovered');
});

test('a pass that throws is run again; the completed pass is stored, not FAILED', async () => {
  const fx = fixture(5);
  await index('tr-other-5', fx.source);
  await matureCorpusBackings(client);
  await client.execute({ sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: ['tr-submitter', 'tr-submitter@example.test', 'tr-submitter', 'x'] });
  clearFaults();
  queue(OWN_IDENTITIES, 'reject');
  const { result, events } = await capturingCheckLog(() => resolve(fx));
  assert.equal(result.status, 'MATCHED');
  assert.equal(priorSubmissionBranchState(result), 'COMPLETE');
  assert.deepEqual(await snapshotRow(`tr-report-${resolutions}`), { status: 'MATCHED', isPartial: 0, candidateCount: 1, errorMessage: null });
  assert.deepEqual(events[0].stops, ['ERROR', 'CANDIDATES_EXHAUSTED']);
});

test('every allowed pass cut short -> PARTIAL after exactly the bound, never more', async () => {
  const fx = fixture(6);
  await index('tr-other-6', fx.source);
  await matureCorpusBackings(client);
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject', 'reject', 'reject', 'reject', 'reject');
  const { result, events } = await capturingCheckLog(() => resolve(fx));
  assert.equal(issuedCount(CANDIDATE_PAGE), PRIOR_SUBMISSION_MATCH_MAX_ATTEMPTS, 'bounded');
  assert.equal(result.status, 'NO_HISTORICAL_MATCH');
  assert.equal(result.partial, true);
  assert.equal(priorSubmissionBranchState(result), 'PARTIAL');
  assert.equal((await snapshotRow(`tr-report-${resolutions}`)).isPartial, 1, 'stored as partial, so it is never reused');
  assert.deepEqual(
    { result: events[0].result, attempts: events[0].attempts, stops: events[0].stops },
    { result: 'partial', attempts: 3, stops: ['QUERY_FAILED', 'QUERY_FAILED', 'QUERY_FAILED'] },
  );
});

test('every allowed pass cut short -> the pass that verified the most is kept, not the last one', async () => {
  const fx = fixture(7);
  await index('tr-other-7a', fx.source);
  await index('tr-other-7b', fx.secondSource);
  await matureCorpusBackings(client);
  clearFaults();
  // Pass 1 verifies one source and runs out of time; passes 2 and 3 fail before finding anything.
  queue(CANDIDATE_PAGE, 'ok', 'reject', 'reject');
  queue(REPRESENTATION_LOAD, spendTimeBudget);
  const { result, events } = await capturingCheckLog(() => resolve(fx));
  assert.deepEqual(events[0].stops, ['TIME_BUDGET', 'QUERY_FAILED', 'QUERY_FAILED']);
  assert.equal(result.partial, true);
  assert.equal(result.status, 'MATCHED', 'the verified source of the first pass is still evidence');
  assert.equal(result.matches.length, 1);
  assert.deepEqual(await snapshotRow(`tr-report-${resolutions}`), { status: 'MATCHED', isPartial: 1, candidateCount: 1, errorMessage: null });
});

test('every allowed pass throws -> UNAVAILABLE, stored as FAILED and reused exactly as before', async () => {
  const fx = fixture(8);
  await index('tr-other-8', fx.source);
  await matureCorpusBackings(client);
  clearFaults();
  queue(OWN_IDENTITIES, 'reject', 'reject', 'reject');
  const { result, events } = await capturingCheckLog(() => resolve(fx, { reportId: 'tr-failed' }));
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(priorSubmissionBranchState(result), 'PARTIAL');
  assert.equal(issuedCount(OWN_IDENTITIES), 3, 'bounded');
  assert.deepEqual(await snapshotRow('tr-failed'), { status: 'FAILED', isPartial: 0, candidateCount: null, errorMessage: 'simulated transient query failure' });
  assert.deepEqual({ result: events[0].result, stops: events[0].stops }, { result: 'unavailable', stops: ['ERROR', 'ERROR', 'ERROR'] });
  // Unchanged: a current FAILED row is a cache hit, not another three passes.
  clearFaults();
  assert.equal((await resolve(fx, { reportId: 'tr-failed' })).status, 'UNAVAILABLE');
  assert.equal(issuedCount(OWN_IDENTITIES), 0);
});

test('a scoring candidate over 20,000 words is terminal: PARTIAL, and the pass is NOT run again', async () => {
  const fx = fixture(9);
  await index('tr-other-9a', fx.source);
  const oversized = await index('tr-other-9b', fx.secondSource);
  await matureCorpusBackings(client);
  await inflateWordCount(oversized);
  clearFaults();
  const { result, events } = await capturingCheckLog(() => resolve(fx));
  assert.equal(issuedCount(CANDIDATE_PAGE), 1, 'the same answer every time — nothing to retry');
  assert.equal(result.partial, true);
  assert.equal(result.status, 'MATCHED');
  assert.equal(priorSubmissionBranchState(result), 'PARTIAL', 'a truthful lower bound');
  assert.deepEqual(
    { result: events[0].result, attempts: events[0].attempts, stops: events[0].stops, oversized: events[0].oversizedScoringCandidatesSkipped },
    { result: 'partial', attempts: 1, stops: ['CANDIDATES_EXHAUSTED'], oversized: 1 },
  );
});

test('a cut-short pass followed by one that examines everything but meets an oversized candidate -> PARTIAL after two passes', async () => {
  const fx = fixture(10);
  await index('tr-other-10a', fx.source);
  const oversized = await index('tr-other-10b', fx.secondSource);
  await matureCorpusBackings(client);
  await inflateWordCount(oversized);
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject', 'ok', 'reject');
  const { result, events } = await capturingCheckLog(() => resolve(fx));
  assert.equal(issuedCount(CANDIDATE_PAGE), 2, 'the exhaustive pass ends the loop');
  assert.equal(result.partial, true);
  assert.equal(result.matches.length, 1);
  assert.deepEqual(events[0].stops, ['QUERY_FAILED', 'CANDIDATES_EXHAUSTED']);
  assert.equal(events[0].result, 'partial');
});

test('SELF-only stays COMPLETE in one pass', async () => {
  const fx = fixture(11);
  for (let k = 1; k <= 12; k += 1) await index('tr-self-author', fx.ownDraft(k));
  await matureCorpusBackings(client);
  clearFaults();
  const { result, lines } = await capturingCheckLog(() => resolve(fx, { accountId: 'tr-self-author' }));
  assert.equal(result.status, 'MATCHED');
  assert.ok(result.matches.every((m) => m.relationshipType === 'SELF'));
  assert.notEqual(result.partial, true);
  assert.equal(priorSubmissionBranchState(result), 'COMPLETE');
  assert.equal(issuedCount(CANDIDATE_PAGE), 1);
  assert.deepEqual(lines, []);
});

test('UNKNOWN-only stays COMPLETE in one pass', async () => {
  const fx = fixture(12);
  for (let k = 1; k <= 12; k += 1) await index(`tr-unknown-${k}`, fx.ownDraft(k));
  await matureCorpusBackings(client);
  clearFaults();
  const { result, lines } = await capturingCheckLog(() => resolve(fx, { accountId: null }));
  assert.equal(result.status, 'MATCHED');
  assert.ok(result.matches.every((m) => m.relationshipType === 'UNKNOWN_RELATIONSHIP'));
  assert.notEqual(result.partial, true);
  assert.equal(priorSubmissionBranchState(result), 'COMPLETE');
  assert.equal(issuedCount(CANDIDATE_PAGE), 1);
  assert.deepEqual(lines, []);
});

// ===========================================================================
// The real save route: the first save heals itself — no browser re-save
// ===========================================================================

let accounts = 0;
async function signUp({ admin = false } = {}) {
  accounts += 1;
  const email = `tr-owner-${accounts}@example.test`, deviceKey = `tr-owner-device-${accounts}`;
  await resetAuthRateForTest('tr-signup-' + accounts);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': 'tr-signup-' + accounts },
    body: JSON.stringify(withTestIdentity({ email, password: 'tr-owner-pw-1', username: `trowner${accounts}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = res.headers.get('set-cookie').match(/tp_session_v1=([^;]*)/)[1];
  const userId = String((await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  if (admin) await client.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [userId] });
  return { userId, deviceKey, cookie, tag: `tr-${accounts}` };
}
async function postReport(account, fx, { id, aiStatus = 'processing' }) {
  await resetRateForTest(account.tag + '-post');
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post', cookie: `tp_session_v1=${account.cookie}` },
    body: JSON.stringify({
      deviceKey: account.deviceKey, id, submissionId: 'sub-' + id, title: 'Transient retry fixture', createdAt: new Date().toISOString(),
      wordCount: fx.wordCount, archiveScore: 0, scoreBand: 'Low',
      aiScore: aiStatus === 'ready' ? 2 : null, aiTone: aiStatus === 'ready' ? 'low' : null, aiStatus, room: 0,
      payload: {
        version: 11, id, submissionId: 'sub-' + id, title: 'Transient retry fixture', author: '', assignment: '',
        created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: fx.wordCount, scoreBand: 'Low',
        matchedWordCount: 0, sources: [], repeats: [], text: fx.submission, archiveMatchedPositions: [],
        ...(aiStatus === 'ready' ? { aiAnalysis: completeAiAnalysis() } : {}),
      },
    }),
  }));
}
async function getReport(account, id) {
  await resetReadRateForTest(account.tag + '-get');
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(account.deviceKey)}`, { headers: { 'x-forwarded-for': account.tag + '-get', cookie: `tp_session_v1=${account.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  assert.equal(res.status, 200);
  return (await res.json()).payload;
}
async function stored(account, id) {
  const row = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
  return decodeReportFromPersistence(JSON.parse(String(row.rows[0].payload_json)));
}
const completion = (report) => ({ state: report.reportCompletion.state, priorSubmission: report.reportCompletion.signals.priorSubmission });
const scored = (report) => ({
  score: report.unifiedSimilarity.unifiedScore,
  matched: report.unifiedSimilarity.uniqueMatchedWords,
  positions: report.unifiedSimilarity.matchedPositions,
});
/** What an undisturbed save of the same manuscript stores (by another account — a room holds one report): the similarity a healed save must equal, position for position. */
async function undisturbedSave(fx, id) {
  clearFaults();
  const account = await signUp();
  assert.equal((await postReport(account, fx, { id })).status, 200);
  const report = await stored(account, id);
  assert.deepEqual(completion(report), { state: 'COMPLETED', priorSubmission: 'COMPLETE' }, 'test setup sanity: the undisturbed save is complete');
  return scored(report);
}

test('first save, one failed candidate query, no candidates -> saved COMPLETED; reads show it; no re-save was made', async () => {
  const account = await signUp();
  const fx = fixture(21);
  await index('tr-route-other-21', fx.unrelated);
  await matureCorpusBackings(client);
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject');
  const id = 'tr-first-save-empty';
  assert.equal((await postReport(account, fx, { id })).status, 200);
  const saved = await stored(account, id);
  assert.deepEqual(completion(saved), { state: 'COMPLETED', priorSubmission: 'COMPLETE' });
  assert.equal((await snapshotRow(id, account.deviceKey)).isPartial, 0);
  assert.deepEqual(completion(await getReport(account, id)), { state: 'COMPLETED', priorSubmission: 'COMPLETE' });
  assert.equal(saved.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(scored(saved), await undisturbedSave(fx, id + '-control'));
});

test('first save, one failed candidate query, a real prior source -> saved COMPLETED with the source scored (20 %)', async () => {
  const account = await signUp();
  const fx = fixture(22);
  await index('tr-route-other-22', fx.source);
  await matureCorpusBackings(client);
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject');
  const id = 'tr-first-save-evidence';
  assert.equal((await postReport(account, fx, { id })).status, 200);
  const saved = await stored(account, id);
  assert.deepEqual(completion(saved), { state: 'COMPLETED', priorSubmission: 'COMPLETE' });
  assert.deepEqual(completion(await getReport(account, id)), { state: 'COMPLETED', priorSubmission: 'COMPLETE' });
  assert.equal(saved.unifiedSimilarity.unifiedScore, 20);
  assert.deepEqual(scored(saved), await undisturbedSave(fx, id + '-control'), 'the same similarity as a save that met no failure');
});

test('first save, a candidate query slower than the query wait (the hosted Preview cause) -> saved COMPLETED', async () => {
  const account = await signUp();
  const fx = fixture(23);
  await index('tr-route-other-23', fx.source);
  await matureCorpusBackings(client);
  clearFaults();
  queue(CANDIDATE_PAGE, { slowMs: USER_SUBMISSION_MATCH_THRESHOLDS.dbQueryTimeoutMs + 200 });
  const id = 'tr-first-save-slow';
  const { result: res, events } = await capturingCheckLog(() => postReport(account, fx, { id }));
  assert.equal(res.status, 200);
  assert.deepEqual(events[0].stops, ['QUERY_FAILED', 'CANDIDATES_EXHAUSTED'], 'the wait was abandoned, the re-issued query answered');
  const saved = await stored(account, id);
  assert.deepEqual(completion(saved), { state: 'COMPLETED', priorSubmission: 'COMPLETE' });
  assert.equal(saved.unifiedSimilarity.unifiedScore, 20);
  await new Promise((resolve) => setTimeout(resolve, 400)); // let the abandoned statement drain
  assert.deepEqual(scored(saved), await undisturbedSave(fx, id + '-control'));
});

test('first save, every pass cut short -> saved PARTIAL (a lower bound); reads keep it; the next save runs its own bounded passes', async () => {
  const account = await signUp();
  const fx = fixture(24);
  await index('tr-route-other-24', fx.source);
  await matureCorpusBackings(client);
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject', 'reject', 'reject');
  const id = 'tr-first-save-exhausted';
  assert.equal((await postReport(account, fx, { id })).status, 200);
  const saved = await stored(account, id);
  assert.deepEqual(completion(saved), { state: 'PARTIAL', priorSubmission: 'PARTIAL' });
  assert.equal(saved.unifiedSimilarity.unifiedScore, 0, 'only what was verified: a lower bound');
  assert.deepEqual(saved.reportCompletion.diagnostics, [{ channel: 'PRIOR_SUBMISSION', reason: 'NOT_RECORDED' }], 'the report still stores that the check was partial, not why');
  assert.equal((await snapshotRow(id, account.deviceKey)).isPartial, 1);
  assert.equal((await getReport(account, id)).reportCompletion.state, 'PARTIAL', 'never shown as COMPLETED');

  // Nothing is remembered between resolutions: a later save is not penalised for the earlier one.
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject');
  assert.equal((await postReport(account, fx, { id, aiStatus: 'ready' })).status, 200);
  const resaved = await stored(account, id);
  assert.deepEqual(completion(resaved), { state: 'COMPLETED', priorSubmission: 'COMPLETE' });
  assert.equal(resaved.unifiedSimilarity.unifiedScore, 20);
  assert.deepEqual(scored(resaved), await undisturbedSave(fx, id + '-control'));
});

// ===========================================================================
// Beside the Selective Corpus retry: neither channel erases the other
// ===========================================================================

/** The row an authoritative-pending first save persists (no score, no previous-submission result). */
async function seedPending(owner, id, fx) {
  const built = withEvidenceInterpretation({
    version: 11, id: 1, submissionId: 'sub-' + id, title: 'Transient retry fixture', text: fx.submission, wordCount: fx.wordCount,
    score: 0, archiveScore: 0, scoreBand: 'Low', matchedWordCount: 0, archiveMatchedPositions: [], sources: [], repeats: [],
  }, { selectiveCorpusBranch: null });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, owner.deviceKey, 'sub-' + id, 'Transient retry fixture', new Date(Date.now() - 20 * 60 * 1000).toISOString(), fx.wordCount, 0, 'Low', JSON.stringify({ ...built, selectiveCorpusAuthoritativeStatus: 'pending' }), owner.userId, null],
  });
}
const rawStored = async (owner, id) =>
  JSON.parse(String((await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [owner.deviceKey, id] })).rows[0].payload_json));
const EVALUATOR_VERSION = 'selective-corpus-shadow-v1';
const timeoutResult = () => ({
  state: 'TIMEOUT', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'TIMEOUT', failureMessage: 'time budget exceeded during Stage B verification',
  corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176, runtimeStageAMs: 2828.64, queryFingerprintsRawCount: 1312, queryFingerprintsTrimmed: false,
});
const completedResult = () => ({
  state: 'COMPLETED', evaluatorVersion: EVALUATOR_VERSION, corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
  candidateCount: 30, topCandidateRanks: [], stageATruncated: false, verifiedSourceCount: 0, matchedPositionCount: 0,
  counterfactualUnifiedSimilarity: 0, authoritativeUnifiedSimilarity: null, deltaVsAuthoritative: 0,
  runtimeStageAMs: 2346.34, runtimeStageBMs: 3549.16, familyGuardActivations: 0, coSourceAttributionActivations: 0,
});
const finalize = (owner, id, shadowResult, db = client) =>
  finalizeSelectiveCorpusAuthoritativeReport(db, { reportDeviceKey: owner.deviceKey, reportId: id, accountId: owner.userId, shadowResult });

test('finalizer: a transient previous-submission failure heals inside the finalization -> COMPLETED, no re-save', async () => {
  const owner = await signUp();
  const fx = fixture(31);
  await index('tr-fin-other-31', fx.source);
  await matureCorpusBackings(client);
  const id = 'tr-fin-heal';
  await seedPending(owner, id, fx);
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject');
  assert.deepEqual(await finalize(owner, id, completedResult()), { outcome: 'finalized', status: 'completed' });
  const row = await rawStored(owner, id);
  assert.equal(row.reportCompletion.signals.priorSubmission, 'COMPLETE');
  assert.equal(row.unifiedSimilarity.unifiedScore, 20);
  const opened = await getReport(owner, id);
  assert.equal(opened.reportCompletion.state, 'COMPLETED');
  assert.equal(opened.reportCompletion.signals.selectiveCorpus, 'COMPLETED');
});

test('finalizer: a previous-submission check that stays cut short + Selective COMPLETED -> PARTIAL; the Selective success erases nothing', async () => {
  const owner = await signUp({ admin: true });
  const fx = fixture(32);
  await index('tr-fin-other-32', fx.source);
  await matureCorpusBackings(client);
  const id = 'tr-fin-exhausted';
  await seedPending(owner, id, fx);
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject', 'reject', 'reject');
  assert.deepEqual(await finalize(owner, id, completedResult()), { outcome: 'finalized', status: 'completed' });
  assert.equal(issuedCount(CANDIDATE_PAGE), PRIOR_SUBMISSION_MATCH_MAX_ATTEMPTS, 'bounded: the finalizer never waits on this check');
  const row = await rawStored(owner, id);
  assert.equal(row.selectiveCorpusAuthoritativeStatus, 'completed', 'terminal — a partial previous-submission check does not hold the report pending');
  assert.equal(row.reportCompletion.signals.priorSubmission, 'PARTIAL');
  const opened = await getReport(owner, id);
  assert.equal(opened.reportCompletion.state, 'PARTIAL');
  assert.equal(opened.reportCompletion.signals.selectiveCorpus, 'COMPLETED');
  assert.equal(opened.reportCompletion.signals.priorSubmission, 'PARTIAL');
  assert.deepEqual(opened.reportCompletion.diagnostics, [{ channel: 'PRIOR_SUBMISSION', reason: 'NOT_RECORDED' }]);
});

test('finalizer: a Selective TIMEOUT keeps its own retry state untouched by the previous-submission retry', async () => {
  const owner = await signUp();
  const fx = fixture(33);
  await index('tr-fin-other-33', fx.source);
  await matureCorpusBackings(client);
  const id = 'tr-fin-timeout';
  await seedPending(owner, id, fx);

  // A timed-out attempt stays pending and never reaches the previous-submission check.
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject', 'reject', 'reject');
  assert.deepEqual(await finalize(owner, id, timeoutResult()), { outcome: 'timeout-retry-scheduled', timedOutAttempts: 1 });
  assert.equal(issuedCount(CANDIDATE_PAGE), 0);
  let row = await rawStored(owner, id);
  assert.equal(row.selectiveCorpusAuthoritativeStatus, 'pending');
  assert.equal(row.unifiedSimilarity, undefined, 'no score while pending');
  assert.equal(row.reportCompletion.signals.priorSubmission, null);

  // The retried attempt completes; its previous-submission check hits a transient failure and heals.
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject');
  assert.deepEqual(await finalize(owner, id, completedResult()), { outcome: 'finalized', status: 'completed' });
  row = await rawStored(owner, id);
  assert.equal(row.selectiveCorpusAuthoritativeTimedOutAttempts, 1, 'the Selective count is exactly what the Selective retry recorded');
  assert.equal(row.reportCompletion.signals.priorSubmission, 'COMPLETE');
  assert.equal((await getReport(owner, id)).reportCompletion.state, 'COMPLETED');
});

test('finalizer: Selective TIMEOUT exhausted + a healed previous-submission check -> PARTIAL from Selective alone; the healed check erases nothing', async () => {
  const owner = await signUp({ admin: true });
  const fx = fixture(34);
  await index('tr-fin-other-34', fx.source);
  await matureCorpusBackings(client);
  const id = 'tr-fin-selective-partial';
  await seedPending(owner, id, fx);
  clearFaults();
  queue(CANDIDATE_PAGE, 'reject');
  const outcomes = [];
  for (let i = 0; i < MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS; i += 1) outcomes.push((await finalize(owner, id, timeoutResult())).outcome);
  assert.deepEqual(outcomes, [...Array(MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS - 1).fill('timeout-retry-scheduled'), 'finalized']);
  assert.equal(issuedCount(CANDIDATE_PAGE), 2, 'only the terminal attempt ran the check: one failed pass, one complete');
  const row = await rawStored(owner, id);
  assert.equal(row.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.equal(row.selectiveCorpusAuthoritativeIncompleteReason, 'TIMEOUT');
  assert.equal(row.selectiveCorpusAuthoritativeTimedOutAttempts, MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS - 1);
  const opened = await getReport(owner, id);
  assert.equal(opened.reportCompletion.state, 'PARTIAL');
  assert.equal(opened.reportCompletion.signals.selectiveCorpus, 'PARTIAL');
  assert.equal(opened.reportCompletion.signals.priorSubmission, 'COMPLETE');
  assert.deepEqual(opened.reportCompletion.diagnostics, [{ channel: 'SELECTIVE_CORPUS', reason: 'TIMEOUT' }]);
});

test('finalizer: a stale worker whose passes were all cut short cannot overwrite a newer COMPLETE finalization', async () => {
  const owner = await signUp();
  const fx = fixture(35);
  await index('tr-fin-other-35', fx.source);
  await matureCorpusBackings(client);
  const id = 'tr-fin-stale';
  await seedPending(owner, id, fx);
  clearFaults();

  // The stale worker: its own connection, on which every candidate query fails
  // — the first one only after the other worker has finished.
  let reachedCandidateQuery;
  const reached = new Promise((resolve) => { reachedCandidateQuery = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const staleConnection = createClient({ url: `file:${dbFile}` });
  staleConnection.execute = function execute(stmt, args) {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    if (!CANDIDATE_PAGE.test(sql)) return realExecute.call(this, stmt, args);
    reachedCandidateQuery();
    return released.then(() => { throw new Error('simulated transient query failure'); });
  };
  try {
    const stale = finalize(owner, id, completedResult(), staleConnection);
    await reached;

    assert.deepEqual(await finalize(owner, id, completedResult()), { outcome: 'finalized', status: 'completed' });
    assert.equal((await rawStored(owner, id)).reportCompletion.signals.priorSubmission, 'COMPLETE');

    release();
    assert.deepEqual(await stale, { outcome: 'already-finalized' });
    const row = await rawStored(owner, id);
    assert.equal(row.selectiveCorpusAuthoritativeStatus, 'completed');
    assert.equal(row.reportCompletion.signals.priorSubmission, 'COMPLETE', 'the stale PARTIAL never lands');
    assert.equal(row.unifiedSimilarity.unifiedScore, 20, 'nor its score without the source');
    assert.equal((await getReport(owner, id)).reportCompletion.state, 'COMPLETED');
  } finally {
    staleConnection.close();
  }
});
