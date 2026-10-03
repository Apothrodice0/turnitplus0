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
import { matchAgainstUserSubmissionCorpus } from '../lib/user-submission-matching.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';
import { resolveReportCompletion, unknownExtractionDiagnostic } from '../lib/evidence-interpretation/index.ts';
import {
  withEvidenceInterpretation,
  priorSubmissionBranchState,
  refreshSelectiveCorpusCompletionSignal,
} from '../lib/report-evidence-interpretation.ts';
import { resolveCompletionView } from '../lib/report-v2-view.ts';

/**
 * Incomplete prior-submission analysis reaches the report through the existing
 * completion system: reportCompletion.signals.priorSubmission, and state
 * PARTIAL whenever a candidate that could have scored was never verified.
 *
 * Status propagation only — no matching, scoring or similarity number changes.
 * Every corpus is synthetic.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_prior_submission_completion_signal.db');
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(`${dbFile}${suffix}`)) fs.unlinkSync(`${dbFile}${suffix}`);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

// ── text fixtures ──────────────────────────────────────────────────────────
// Three-syllable pseudo-words: every 5-gram is informative and two different
// seeds share no passage.
const SYLLABLES = ['ka', 'lo', 'mi', 'tre', 'vun', 'sor', 'bel', 'dra', 'phi', 'quen', 'zor', 'tal', 'mer', 'nix', 'ost', 'ula', 'rin', 'vek', 'dom', 'sha', 'gri', 'pol', 'wex', 'yun'];
function words(count, seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length]);
  return out.join(' ');
}
/** A 600-word submission holding a 120-word passage that two other documents also hold. */
function fixture(seed) {
  const passage = words(120, seed * 101 + 1);
  const submission = `${words(200, seed * 101 + 2)} ${passage} ${words(280, seed * 101 + 3)}`;
  return {
    submission,
    wordCount: tokens(submission).length,
    source: `${words(250, seed * 101 + 4)} ${passage} ${words(250, seed * 101 + 5)}`,
    secondSource: `${words(300, seed * 101 + 6)} ${passage} ${words(300, seed * 101 + 7)}`,
    ownDraft: (k) => `${submission} ${words(20, seed * 101 + 50 + k)}`,
    unrelated: words(600, seed * 101 + 9),
  };
}

// ── corpus helpers (work on any client) ───────────────────────────────────
async function freshMemoryCorpus() {
  const memory = createClient({ url: ':memory:' });
  await memory.execute('PRAGMA foreign_keys = ON');
  await applyMigrationsLibsql(memory, drizzleDir);
  return memory;
}
async function index(db, accountId, rawText) {
  await db.execute({ sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [accountId, `${accountId}@example.test`, accountId, 'x'] });
  const identity = await createDocumentIdentity(db, { accountId, title: 't', author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(db, { documentIdentityId: identity.id, rawText });
  const row = await db.execute({ sql: 'SELECT representation_id FROM corpus_submission_references WHERE document_identity_id = ?', args: [identity.id] });
  return String(row.rows[0].representation_id);
}
const inflateWordCount = (db, representationId, wordCount = 999_999) =>
  db.execute({ sql: 'UPDATE corpus_document_representations SET word_count = ? WHERE id = ?', args: [wordCount, representationId] });

/** The matcher result in the shape the historical-match snapshot hands the report (rowToResult). */
function asReportMatch(result) {
  return {
    status: result.status,
    ...(result.status === 'MATCHED' ? { matches: result.matches } : {}),
    computedAt: '2026-10-03T00:00:00.000Z',
    matcherVersion: 'x',
    fingerprintVersion: 'x',
    canonicalizationVersion: 'x',
    ...(result.partial ? { partial: true } : {}),
  };
}
/** The report completion withEvidenceInterpretation builds from this matcher result. */
function completionFor(fx, result) {
  const historicalSubmissionMatch = asReportMatch(result);
  const report = {
    version: 11, id: 'r', submissionId: 's', title: 't', created: '2026-10-03T00:00:00.000Z',
    score: 0, archiveScore: 0, wordCount: fx.wordCount, scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [], text: fx.submission,
    unifiedSimilarity: computeUnifiedSimilarity({ wordCount: fx.wordCount, historicalSubmissionMatch }),
  };
  return withEvidenceInterpretation(report, { historicalSubmissionMatch }).reportCompletion;
}

// ── route helpers (mirror tests/report-v2-wiring.test.mjs) ─────────────────
let userCounter = 0;
async function signUpAccount() {
  userCounter += 1;
  const email = `prior-completion-user-${userCounter}@example.test`;
  await resetAuthRateForTest('prior-completion-signup-' + userCounter);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'prior-completion-signup-' + userCounter },
    body: JSON.stringify(withTestIdentity({
      email, password: 'prior-completion-pw-1', username: `pcuser${userCounter}`, deviceKey: `prior-completion-device-${userCounter}`,
    })),
  }));
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = res.headers.get('set-cookie').match(/tp_session_v1=([^;]*)/)[1];
  const row = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return { userId: String(row.rows[0].id), deviceKey: `prior-completion-device-${userCounter}`, cookie, tag: `prior-completion-${userCounter}` };
}
async function postReport(account, fx, { id, aiStatus = 'ready' }) {
  await resetRateForTest(account.tag + '-post');
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post', cookie: `tp_session_v1=${account.cookie}` },
    body: JSON.stringify({
      deviceKey: account.deviceKey, id, submissionId: 'sub-' + id, title: 'Prior completion fixture', createdAt: new Date().toISOString(),
      wordCount: fx.wordCount, archiveScore: 0, scoreBand: 'Low',
      aiScore: aiStatus === 'ready' ? 2 : null, aiTone: aiStatus === 'ready' ? 'low' : null, aiStatus, room: 0,
      payload: {
        version: 11, id, submissionId: 'sub-' + id, title: 'Prior completion fixture', author: '', assignment: '',
        created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: fx.wordCount, scoreBand: 'Low',
        matchedWordCount: 0, sources: [], repeats: [], text: fx.submission, archiveMatchedPositions: [],
        ...(aiStatus === 'ready' ? { aiAnalysis: completeAiAnalysis() } : {}),
      },
    }),
  }));
}
async function getReport(account, id) {
  await resetReadRateForTest(account.tag + '-get');
  return reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(account.deviceKey)}`, {
      headers: { 'x-forwarded-for': account.tag + '-get', cookie: `tp_session_v1=${account.cookie}` },
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
}
async function storedPayload(account, id) {
  const row = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [account.deviceKey, id] });
  return decodeReportFromPersistence(JSON.parse(String(row.rows[0].payload_json)));
}

// ===========================================================================
// The mapping itself
// ===========================================================================

test('priorSubmissionBranchState: partial or a failed check is PARTIAL; any other result is COMPLETE; no check is null', () => {
  const base = { computedAt: 'x', matcherVersion: 'x', fingerprintVersion: 'x', canonicalizationVersion: 'x' };
  const entry = (relationshipType) => ({ relationshipType, matchedRepresentationId: 'r', matchType: 'STRONG_TEXT_MATCH', containment: 1, matchedWordCount: 50, passageCount: 0, longestMatchWords: 50, passages: [], historicalSubmissionCount: 0 });
  assert.equal(priorSubmissionBranchState(undefined), null);
  assert.equal(priorSubmissionBranchState(null), null);
  assert.equal(priorSubmissionBranchState({ ...base, status: 'NO_HISTORICAL_MATCH' }), 'COMPLETE');
  assert.equal(priorSubmissionBranchState({ ...base, status: 'MATCHED', matches: [entry('PRIOR_SUBMISSION')] }), 'COMPLETE');
  assert.equal(priorSubmissionBranchState({ ...base, status: 'MATCHED', matches: [entry('SELF')] }), 'COMPLETE', 'SELF does not score — that is not a gap');
  assert.equal(priorSubmissionBranchState({ ...base, status: 'MATCHED', matches: [entry('UNKNOWN_RELATIONSHIP')] }), 'COMPLETE', 'UNKNOWN does not score — that is not a gap');
  assert.equal(priorSubmissionBranchState({ ...base, status: 'MATCHED', matches: [entry('PRIOR_SUBMISSION')], partial: true }), 'PARTIAL');
  assert.equal(priorSubmissionBranchState({ ...base, status: 'NO_HISTORICAL_MATCH', partial: true }), 'PARTIAL');
  assert.equal(priorSubmissionBranchState({ ...base, status: 'UNAVAILABLE' }), 'PARTIAL', 'a failed check contributes nothing to the score');
});

test('resolveReportCompletion: priorSubmission PARTIAL makes the report PARTIAL with the existing lower-bound copy; COMPLETE and null do not', () => {
  const partial = resolveReportCompletion({ priorSubmission: 'PARTIAL', verifiedSimilarityPercent: 20, extraction: unknownExtractionDiagnostic() });
  assert.equal(partial.state, 'PARTIAL');
  assert.equal(partial.signals.priorSubmission, 'PARTIAL');
  assert.equal(partial.headline, 'Some source searches were unavailable. Results may be incomplete.');
  assert.equal(partial.detail, 'The 20% shown is a lower bound — a source we could not reach may add more.');
  assert.ok(partial.reasons.includes('the previous-submission check could not examine every candidate'));

  for (const priorSubmission of ['COMPLETE', null, undefined]) {
    const c = resolveReportCompletion({ priorSubmission, verifiedSimilarityPercent: 20, extraction: unknownExtractionDiagnostic() });
    assert.equal(c.state, 'COMPLETED', String(priorSubmission));
    assert.equal(c.signals.priorSubmission, priorSubmission ?? null);
  }

  // Precedence is unchanged: unread document content still outranks a partial search.
  const both = resolveReportCompletion({
    priorSubmission: 'PARTIAL',
    extraction: { completeness: 'PARTIAL', analyzableWordCount: 100, skipped: { unit: 'pages', count: 2 }, extractor: null },
  });
  assert.equal(both.state, 'EXTRACTION_PARTIAL');
});

// ===========================================================================
// 1-7: real matcher results -> report completion
// ===========================================================================

test('1: an exhaustive prior-submission run -> COMPLETED', async () => {
  const db = await freshMemoryCorpus();
  try {
    const fx = fixture(1);
    await index(db, 'other-account', fx.source);
    await matureCorpusBackings(db);
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(db, { accountId: 'submitter', canonicalText: fx.submission, excludeAccountId: 'submitter', diagnostics });
    assert.equal(diagnostics.stopReason, 'CANDIDATES_EXHAUSTED');
    assert.equal(result.status, 'MATCHED');
    const completion = completionFor(fx, result);
    assert.equal(completion.state, 'COMPLETED');
    assert.equal(completion.signals.priorSubmission, 'COMPLETE');
  } finally { db.close(); }
});

test('2: TIME_BUDGET -> PARTIAL', async () => {
  const db = await freshMemoryCorpus();
  try {
    const fx = fixture(2);
    await index(db, 'other-account', fx.source);
    await matureCorpusBackings(db);
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(db, { accountId: 'submitter', canonicalText: fx.submission, excludeAccountId: 'submitter', diagnostics, config: { matchTimeBudgetMs: 0 } });
    assert.equal(diagnostics.stopReason, 'TIME_BUDGET');
    assert.equal(result.partial, true);
    const completion = completionFor(fx, result);
    assert.equal(completion.state, 'PARTIAL');
    assert.equal(completion.signals.priorSubmission, 'PARTIAL');
  } finally { db.close(); }
});

test('3: QUERY_FAILED -> PARTIAL', async () => {
  const db = await freshMemoryCorpus();
  try {
    const fx = fixture(3);
    await index(db, 'other-account', fx.source);
    await matureCorpusBackings(db);
    // The candidate aggregate fails; every other statement goes through.
    const failingCandidateQuery = {
      execute: (stmt) => {
        const sql = typeof stmt === 'string' ? stmt : stmt.sql;
        if (/GROUP BY s\.representation_id/.test(sql)) return Promise.reject(new Error('simulated candidate query failure'));
        return db.execute(stmt);
      },
      batch: (...args) => db.batch(...args),
      transaction: (...args) => db.transaction(...args),
      close: () => {},
    };
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(failingCandidateQuery, { accountId: 'submitter', canonicalText: fx.submission, excludeAccountId: 'submitter', diagnostics });
    assert.equal(diagnostics.stopReason, 'QUERY_FAILED');
    assert.equal(result.status, 'NO_HISTORICAL_MATCH');
    assert.equal(result.partial, true);
    const completion = completionFor(fx, result);
    assert.equal(completion.state, 'PARTIAL', 'a failed search is not a confirmed absence of matches');
    assert.equal(completion.signals.priorSubmission, 'PARTIAL');
  } finally { db.close(); }
});

test('4: a discovered scoring candidate over 20,000 words that cannot be verified -> PARTIAL', async () => {
  const db = await freshMemoryCorpus();
  try {
    const fx = fixture(4);
    await index(db, 'other-account', fx.source);
    const oversizedId = await index(db, 'second-account', fx.secondSource);
    await matureCorpusBackings(db);
    await inflateWordCount(db, oversizedId);
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(db, { accountId: 'submitter', canonicalText: fx.submission, excludeAccountId: 'submitter', diagnostics });
    assert.equal(diagnostics.oversizedScoringCandidatesSkipped, 1);
    assert.equal(diagnostics.stopReason, 'CANDIDATES_EXHAUSTED');
    assert.equal(result.partial, true);
    const completion = completionFor(fx, result);
    assert.equal(completion.state, 'PARTIAL');
    assert.equal(completion.signals.priorSubmission, 'PARTIAL');
  } finally { db.close(); }
});

test('5: SELF-only matches are not partial', async () => {
  const db = await freshMemoryCorpus();
  try {
    const fx = fixture(5);
    for (let k = 1; k <= 12; k += 1) await index(db, 'submitter', fx.ownDraft(k));
    await matureCorpusBackings(db);
    const result = await matchAgainstUserSubmissionCorpus(db, { accountId: 'submitter', canonicalText: fx.submission, excludeAccountId: 'submitter' });
    assert.equal(result.status, 'MATCHED');
    assert.ok(result.matches.every((m) => m.relationshipType === 'SELF'));
    assert.notEqual(result.partial, true, 'two SELF drafts beyond the SELF budget are passed over — not a gap in the score');
    const completion = completionFor(fx, result);
    assert.equal(completion.state, 'COMPLETED');
    assert.equal(completion.signals.priorSubmission, 'COMPLETE');
  } finally { db.close(); }
});

test('6: UNKNOWN-only matches are not partial', async () => {
  const db = await freshMemoryCorpus();
  try {
    const fx = fixture(6);
    for (let k = 1; k <= 12; k += 1) await index(db, `other-account-${k}`, fx.ownDraft(k));
    await matureCorpusBackings(db);
    const result = await matchAgainstUserSubmissionCorpus(db, { accountId: null, canonicalText: fx.submission });
    assert.equal(result.status, 'MATCHED');
    assert.ok(result.matches.every((m) => m.relationshipType === 'UNKNOWN_RELATIONSHIP'));
    assert.notEqual(result.partial, true);
    const completion = completionFor(fx, result);
    assert.equal(completion.state, 'COMPLETED');
    assert.equal(completion.signals.priorSubmission, 'COMPLETE');
  } finally { db.close(); }
});

test('7: a normally exhausted, empty candidate stream is not partial', async () => {
  const db = await freshMemoryCorpus();
  try {
    const fx = fixture(7);
    await index(db, 'other-account', fx.unrelated);
    await matureCorpusBackings(db);
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(db, { accountId: 'submitter', canonicalText: fx.submission, excludeAccountId: 'submitter', diagnostics });
    assert.equal(result.status, 'NO_HISTORICAL_MATCH');
    assert.equal(diagnostics.rawCandidatesConsidered, 0);
    assert.equal(diagnostics.stopReason, 'CANDIDATES_EXHAUSTED');
    assert.notEqual(result.partial, true);
    const completion = completionFor(fx, result);
    assert.equal(completion.state, 'COMPLETED');
    assert.equal(completion.signals.priorSubmission, 'COMPLETE');
  } finally { db.close(); }
});

// ===========================================================================
// 8-10: initial report creation, refresh, old reports — through the real routes
// ===========================================================================

test('8+9: the real POST persists PARTIAL for a partial prior-submission check; GET restores it; a resave recomputes it from the new check', async () => {
  const account = await signUpAccount();
  const fx = fixture(8);
  await index(client, 'pc-other-account-8', fx.source);
  const oversizedId = await index(client, 'pc-second-account-8', fx.secondSource);
  await matureCorpusBackings(client);
  await inflateWordCount(client, oversizedId);

  // Initial save.
  const id = 'prior-completion-partial-1';
  assert.equal((await postReport(account, fx, { id, aiStatus: 'processing' })).status, 200);
  const saved = await storedPayload(account, id);
  assert.equal(saved.unifiedSimilarity.unifiedScore, 20, 'the verified source still scores');
  assert.equal(saved.reportCompletion.state, 'PARTIAL', 'initial report creation carries the partial check into the completion state');
  assert.equal(saved.reportCompletion.signals.priorSubmission, 'PARTIAL');
  assert.equal(saved.reportCompletion.detail, 'The 20% shown is a lower bound — a source we could not reach may add more.');

  // Reopen: GET restores the persisted completion; it never recomputes it.
  const res = await getReport(account, id);
  assert.equal(res.status, 200);
  const { payload } = await res.json();
  assert.deepEqual(payload.reportCompletion, saved.reportCompletion);

  // AI-completion resave: the check runs again and is still partial.
  assert.equal((await postReport(account, fx, { id, aiStatus: 'ready' })).status, 200);
  const resaved = await storedPayload(account, id);
  assert.equal(resaved.reportCompletion.state, 'PARTIAL', 'a resave does not lose the signal');
  assert.equal(resaved.unifiedSimilarity.unifiedScore, 20);

  // Once every candidate can be verified, the next resave is complete — the
  // signal follows the check, it is never left behind.
  await inflateWordCount(client, oversizedId, 720);
  assert.equal((await postReport(account, fx, { id, aiStatus: 'ready' })).status, 200);
  const completed = await storedPayload(account, id);
  assert.equal(completed.reportCompletion.state, 'COMPLETED');
  assert.equal(completed.reportCompletion.signals.priorSubmission, 'COMPLETE');
  assert.equal(completed.unifiedSimilarity.unifiedScore, 20, 'the second source covers the same passage: same score');
});

test('8 (control): the real POST persists COMPLETED with priorSubmission COMPLETE for a complete check', async () => {
  const account = await signUpAccount();
  const fx = fixture(9);
  await index(client, 'pc-other-account-9', fx.source);
  await matureCorpusBackings(client);
  const id = 'prior-completion-complete-1';
  assert.equal((await postReport(account, fx, { id })).status, 200);
  const saved = await storedPayload(account, id);
  assert.equal(saved.unifiedSimilarity.unifiedScore, 20);
  assert.equal(saved.reportCompletion.state, 'COMPLETED');
  assert.equal(saved.reportCompletion.signals.priorSubmission, 'COMPLETE');
});

test('9: the Selective Corpus response-time refresh carries priorSubmission forward instead of dropping it', () => {
  const persisted = resolveReportCompletion({ priorSubmission: 'PARTIAL', verifiedSimilarityPercent: 20, extraction: unknownExtractionDiagnostic() });
  const report = {
    wordCount: 600, score: 0, archiveScore: 0, sources: [], repeats: [], text: '',
    selectiveCorpusAuthoritativeStatus: 'completed',
    reportCompletion: persisted,
  };
  refreshSelectiveCorpusCompletionSignal(report);
  assert.equal(report.reportCompletion.signals.selectiveCorpus, 'COMPLETED', 'the refresh ran');
  assert.equal(report.reportCompletion.signals.priorSubmission, 'PARTIAL');
  assert.equal(report.reportCompletion.state, 'PARTIAL', 'never PARTIAL -> COMPLETED because a refresh forgot the signal');
});

test('10: a report saved before priorSubmission existed still opens, and nothing is inferred for it', async () => {
  // Pure: the view and the refresh accept a completion without the key.
  const old = { state: 'COMPLETED', headline: 'h', detail: null, reasons: [], signals: { academicSearch: null, selectiveCorpus: null, extraction: 'UNKNOWN', unverifiedCandidateCount: 0, userSuppliedReference: null } };
  const view = resolveCompletionView(old, undefined, 12);
  assert.equal(view.state, 'COMPLETED');
  assert.equal('priorSubmission' in view.signals, false, 'no value is invented for an old report');
  const refreshed = { wordCount: 600, score: 0, archiveScore: 0, sources: [], repeats: [], text: '', selectiveCorpusAuthoritativeStatus: 'completed', reportCompletion: structuredClone(old) };
  refreshSelectiveCorpusCompletionSignal(refreshed);
  assert.equal(refreshed.reportCompletion.signals.priorSubmission, null, 'unknown stays unknown');
  assert.equal(refreshed.reportCompletion.state, 'COMPLETED');

  // Through the routes: a stored completion without the key is returned as stored.
  const account = await signUpAccount();
  const fx = fixture(10);
  await index(client, 'pc-other-account-10', fx.source);
  await matureCorpusBackings(client);
  const id = 'prior-completion-old-1';
  assert.equal((await postReport(account, fx, { id })).status, 200);
  await client.execute({
    sql: `UPDATE saved_reports SET payload_json = json_remove(payload_json, '$.reportCompletion.signals.priorSubmission') WHERE device_key = ? AND id = ?`,
    args: [account.deviceKey, id],
  });
  const stored = await storedPayload(account, id);
  assert.equal('priorSubmission' in stored.reportCompletion.signals, false, 'test setup sanity: the row is old-shaped');
  const res = await getReport(account, id);
  assert.equal(res.status, 200, 'an old report must still open');
  const { payload } = await res.json();
  assert.deepEqual(payload.reportCompletion, stored.reportCompletion, 'returned exactly as stored — no migration, no backfill');
  assert.equal(resolveCompletionView(payload.reportCompletion, payload.extractionDiagnostic, payload.unifiedSimilarity.unifiedScore).state, 'COMPLETED');
});

// ===========================================================================
// 11: status only — the similarity output is untouched
// ===========================================================================

test('11: the signal changes reportCompletion and nothing else — score, positions and interpretation are identical', async () => {
  const db = await freshMemoryCorpus();
  try {
    const fx = fixture(11);
    await index(db, 'other-account', fx.source);
    const oversizedId = await index(db, 'second-account', fx.secondSource);
    await matureCorpusBackings(db);
    await inflateWordCount(db, oversizedId);
    const result = await matchAgainstUserSubmissionCorpus(db, { accountId: 'submitter', canonicalText: fx.submission, excludeAccountId: 'submitter' });
    assert.equal(result.partial, true);

    const partialMatch = asReportMatch(result);
    const { partial, ...sameMatchNotPartial } = partialMatch;
    assert.equal(partial, true);
    const unifiedSimilarity = computeUnifiedSimilarity({ wordCount: fx.wordCount, historicalSubmissionMatch: partialMatch });
    assert.deepEqual(computeUnifiedSimilarity({ wordCount: fx.wordCount, historicalSubmissionMatch: sameMatchNotPartial }), unifiedSimilarity, 'the flag never reaches scoring');
    const report = { version: 11, id: 'r', submissionId: 's', title: 't', created: 'x', score: 0, archiveScore: 0, wordCount: fx.wordCount, scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [], text: fx.submission, unifiedSimilarity };

    const withPartial = withEvidenceInterpretation(report, { historicalSubmissionMatch: partialMatch });
    const withoutPartial = withEvidenceInterpretation(report, { historicalSubmissionMatch: sameMatchNotPartial });
    assert.equal(withPartial.reportCompletion.state, 'PARTIAL');
    assert.equal(withoutPartial.reportCompletion.state, 'COMPLETED');
    const { reportCompletion: _a, ...restPartial } = withPartial;
    const { reportCompletion: _b, ...restComplete } = withoutPartial;
    assert.deepEqual(restPartial, restComplete, 'everything but reportCompletion is identical');
    assert.equal(withPartial.unifiedSimilarity, unifiedSimilarity, 'the similarity object is passed through untouched');
    assert.equal(withPartial.unifiedSimilarity.unifiedScore, 20);
  } finally { db.close(); }
});
