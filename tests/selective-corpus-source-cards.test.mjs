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
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';
import { completeAiAnalysis } from './helpers/complete-ai-analysis.mjs';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';
import { buildFinalizedReportEvidenceInterpretation, withEvidenceInterpretation } from '../lib/report-evidence-interpretation.ts';
import { decodeReportFromPersistence, encodeReportForPersistence } from '../lib/report-persistence.ts';
import { isFormatMarkedPositions } from '../lib/position-runs-persistence.ts';
import { compactEvidenceInterpretationForPersistence, expandEvidenceInterpretationFromPersistence, isCompactEvidenceInterpretation } from '../lib/evidence-interpretation/persistence.ts';
import { MAX_REPORT_SAVE_REQUEST_BYTES } from '../lib/report-transport-limits.ts';
import { SIMILARITY_NOT_FINALIZED_HEADLINE } from '../lib/evidence-interpretation/completion.ts';
import { buildReportV2ViewModel } from '../lib/report-v2-view.ts';
import { finalizeSelectiveCorpusAuthoritativeReport, MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS } from '../lib/selective-corpus-authoritative.ts';

/**
 * SELECTIVE CORPUS EVIDENCE THAT IS IN THE SCORE HAS A SOURCE CARD.
 *
 * The deferred finalizer (lib/selective-corpus-authoritative.ts) is the only resolution that has Selective Corpus
 * evidence. It unioned that evidence into the final similarity and its highlights, but the report's source cards were
 * built without it: a report could read 26 % or 80 % from real Selective Corpus passages beside "0 verified sources".
 *
 * This file pins what replaced that, through the real finalizer, the real routes and the Report V2 view model:
 *   - every verified Selective Corpus source whose words are in the final score has exactly one card, covering exactly
 *     the words it put into the score;
 *   - the card says only what is known of such a source: the generic reference-collection label, no title, no link;
 *   - the score, the matched positions and every other channel are what they were without the card;
 *   - a save (the AI result) and every reload show the same cards, under both compact write gates;
 *   - no Selective Corpus evidence, no card;
 *   - under size pressure a card loses detail (its passage links, then its optional text) and never its existence: a
 *     report too large for even the minimum cards is not stored with a score at all.
 * Every corpus is synthetic.
 */

const ENV_KEYS = [
  'TURSO_DATABASE_URL',
  'CORPUS_SOURCE_MATCHING_ENABLED',
  'REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED',
  'REPORT_COMPACT_POSITIONS_WRITE_ENABLED',
  'IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH',
  'SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED',
  'SELECTIVE_CORPUS_SHADOW_ENABLED',
  'SELECTIVE_CORPUS_ARTIFACT_PATH',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const workDir = mkdtempSync(path.join(process.env.TURNITPLUS_TEST_DB_DIR || tmpdir(), 'sc-source-cards-'));
const dbFile = path.join(workDir, 'sc_source_cards.db');
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

/** Runs `fn` with one write gate pinned on or off, whatever the run's own setting is. */
async function withFlag(key, on, fn) {
  const before = process.env[key];
  if (on) process.env[key] = 'true';
  else delete process.env[key];
  try { return await fn(); } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}
const withPositionsGate = (on, fn) => withFlag('REPORT_COMPACT_POSITIONS_WRITE_ENABLED', on, fn);
const GATES = [['off', false], ['on', true]];

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
const sorted = (positions) => [...positions].sort((a, b) => a - b);

let accounts = 0;
async function signUpOwner({ admin = false } = {}) {
  accounts += 1;
  const tag = `sc-${accounts}`, email = `sc-owner-${accounts}@example.test`, deviceKey = `sc-device-${accounts}`;
  await resetAuthRateForTest(`${tag}-signup`);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${tag}-signup` },
    body: JSON.stringify(withTestIdentity({ email, password: 'sc-owner-pw-1', username: `scowner${accounts}`, deviceKey })),
  }));
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = (res.headers.get('set-cookie') ?? '').match(/tp_session_v1=([^;]*)/)[1];
  const userId = String((await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id);
  if (admin) await client.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [userId] });
  return { userId, deviceKey, cookie, tag };
}

/** The report as the browser holds it after its check: its own archive result, no server score, no AI result yet. */
function localReport(id, text, { archiveMatchedPositions = [], sources = [] } = {}) {
  return {
    version: 11, id, submissionId: `sub-${id}`, title: 'Selective source-card fixture', author: '', assignment: '', created: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    score: 0, archiveScore: 0, scoreBand: 'Low', wordCount: tokensForScoringNormalization(text, 2).length, characterCount: text.length,
    matchedWordCount: archiveMatchedPositions.length, archiveMatchedPositions, scoringNormalizationVersion: 2,
    sources, repeats: [], text, academicEvidenceStatus: 'COMPLETE_NO_MATCHES', externalAcademicEvidence: [],
  };
}

/** The row an authoritative first save persists: no unifiedSimilarity, the marker "pending", the AI check still running. */
async function seedPending(owner, report) {
  const built = withEvidenceInterpretation({ ...report }, { selectiveCorpusBranch: null });
  const payload = { ...encodeReportForPersistence(built), selectiveCorpusAuthoritativeStatus: 'pending' };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_status, payload_json, user_id, room_number)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [report.id, owner.deviceKey, report.submissionId, report.title, report.created, report.wordCount, 0, 'Low', 'processing', JSON.stringify(payload), owner.userId, 0],
  });
}

const EVALUATOR_VERSION = 'selective-corpus-shadow-v1';
const passage = (start, end) => ({ submittedWordStart: start, submittedWordEnd: end, matchedWordCount: end - start + 1 });
/**
 * What the evaluator hands the finalizer: one entry per verified source, labelled S1..Sn (lib/selective-corpus/shadow.ts),
 * each with its own co-source-attributed passages. `evidence` = [[label, [[start, end], ...]], ...].
 */
const shadow = (state, evidence) => ({
  state, evaluatorVersion: EVALUATOR_VERSION, corpusVersion: 'selective-corpus-v1', corpusDigest: 'test-digest', documentCount: 9176,
  ...(state === 'PARTIAL' ? { degradedShardCount: 1 } : {}),
  verifiedEvidence: evidence.map(([sourceLabel, ranges, extra = {}]) => ({ sourceLabel, matchedPassages: ranges.map(([s, e]) => passage(s, e)), ...extra })),
});
const timeoutShadow = () => ({ state: 'TIMEOUT', evaluatorVersion: EVALUATOR_VERSION, failureCode: 'TIMEOUT', failureMessage: 'time budget exceeded during Stage B verification' });
const finalize = (owner, id, shadowResult) =>
  finalizeSelectiveCorpusAuthoritativeReport(client, { reportDeviceKey: owner.deviceKey, reportId: id, accountId: owner.userId, shadowResult, shadowScoringNormalizationVersion: 2 });

/** A pending authoritative report the finalizer has just made terminal with this Selective Corpus evidence. */
async function finalizedReport(id, evidence, { text = words(3000, id.length * 173 + 11), state = 'COMPLETED', archiveMatchedPositions = [], sources = [], admin = false } = {}) {
  const owner = await signUpOwner({ admin });
  const report = localReport(id, text, { archiveMatchedPositions, sources });
  await seedPending(owner, report);
  assert.equal((await finalize(owner, id, shadow(state, evidence))).outcome, 'finalized', 'test setup sanity: the finalizer wrote the final score');
  return { owner, report };
}

let requests = 0;
/** POST /api/reports as the browser's AI save sends it: the report it holds with the AI result spread over it. */
async function aiSave(owner, report, { payload = {}, body = {} } = {}) {
  requests += 1;
  const ip = `${owner.tag}-post-${requests}`;
  await resetRateForTest(ip);
  return reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` },
    body: JSON.stringify({
      deviceKey: owner.deviceKey, id: report.id, submissionId: report.submissionId, title: report.title, createdAt: report.created,
      wordCount: report.wordCount, archiveScore: report.archiveScore, scoreBand: report.scoreBand,
      aiScore: 5, aiTone: 'low', aiStatus: 'ready', scoringNormalization: 2, academicSearchDiagnosticsId: null,
      payload: { ...report, aiScore: 5, aiAnalysis: completeAiAnalysis(), ...payload },
      ...body,
    }),
  }));
}

/** The stored row: the raw payload and its decoded form. */
async function row(owner, id) {
  const r = await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [owner.deviceKey, id] });
  const json = String(r.rows[0].payload_json);
  return { json, raw: JSON.parse(json), report: decodeReportFromPersistence(JSON.parse(json), { requireContributions: true }) };
}
/** GET /api/reports/[id]: the report as its owner is served it, and the response text. */
async function served(owner, id) {
  requests += 1;
  const ip = `${owner.tag}-get-${requests}`;
  await resetReadRateForTest(ip);
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(owner.deviceKey)}`, { headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${owner.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  return { text, payload: JSON.parse(text).payload };
}

const GENERIC_LABEL = 'TurnitPlus reference collection';
const selectiveCards = (report) => report.evidenceInterpretation.sources.filter((s) => s.sourceType === 'selective-corpus');
const cardPositions = (report, card) => sorted(new Set(report.evidenceInterpretation.passages.filter((p) => card.passageRefs.includes(p.id)).flatMap((p) => range(p.wordStart, p.wordEnd))));

/** The score the same inputs give with no card builder involved at all. */
const scoreOf = (report, evidence) => computeUnifiedSimilarity({
  wordCount: report.wordCount, archiveMatchedPositions: report.archiveMatchedPositions,
  selectiveCorpusEvidence: evidence.map(([sourceLabel, ranges]) => ({ sourceId: sourceLabel, matchedPassages: ranges.map(([s, e]) => passage(s, e)) })),
});

/** The explanation is a disjoint partition of exactly the scored union, and cards and passages refer to each other consistently. */
function assertExplainsExactlyTheScore(report, label, { unlinkedSelectiveCards = false } = {}) {
  const u = report.unifiedSimilarity, ei = report.evidenceInterpretation;
  const union = sorted(u.matchedPositions);
  assert.equal(u.uniqueMatchedWords, union.length, `${label}: the score counts the union once`);
  assert.equal(ei.matchedWordCount, union.length, `${label}: the explanation counts the same words`);
  const parts = Object.values(ei.positionsByKind).flat();
  assert.equal(parts.length, new Set(parts).size, `${label}: no word is explained twice`);
  assert.deepEqual(sorted(parts), union, `${label}: the explained words are exactly the scored union`);
  assert.deepEqual(sorted(ei.passages.flatMap((p) => range(p.wordStart, p.wordEnd))), union, `${label}: the highlighted passages are exactly the scored union`);
  const ids = ei.sources.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `${label}: no duplicate card`);
  for (const p of ei.passages) for (const sourceId of p.sourceIds) assert.ok(ids.includes(sourceId), `${label}: passage source ${sourceId} is a card`);
  for (const card of ei.sources) {
    if (unlinkedSelectiveCards && card.sourceType === 'selective-corpus') assert.deepEqual(card.passageRefs, [], `${label}: card ${card.id} is kept without passage links`);
    else assert.ok(card.passageRefs.length > 0, `${label}: card ${card.id} points at its passages`);
    assert.ok(card.matchedWords <= union.length, `${label}: card ${card.id} claims no more than the union`);
  }
}

/** A Selective Corpus card says only what is known of such a source. */
function assertTruthfulSelectiveCard(card, label) {
  assert.deepEqual(Object.keys(card).sort(), ['contributionPercent', 'doi', 'id', 'interpretation', 'label', 'link', 'matchedWords', 'passageRefs', 'sourceType', 'year'], `${label}: the card has the ordinary card fields and no others`);
  assert.match(card.id, /^src-\d+$/, `${label}: a report-local opaque id`);
  assert.equal(card.sourceType, 'selective-corpus', label);
  assert.equal(card.label, GENERIC_LABEL, `${label}: the generic reference-collection label, never a title`);
  assert.equal(card.link, null, `${label}: no link`);
  assert.equal(card.doi, null, `${label}: no DOI`);
  assert.equal(card.year, null, `${label}: no year`);
}

// ===========================================================================
// 1. Selective Corpus evidence alone
// ===========================================================================

for (const [gate, on] of GATES) {
  test(`1. a report whose whole 10 % comes from the Selective Corpus has one verified source, not "0 verified sources" [compact positions ${gate}]`, async () => withPositionsGate(on, async () => {
    const id = `sc-only-${gate}`;
    const evidence = [['S1', [[100, 399]]]];
    const { owner, report } = await finalizedReport(id, evidence);
    const stored = await row(owner, id);
    const u = stored.report.unifiedSimilarity;
    assert.equal(stored.report.selectiveCorpusAuthoritativeStatus, 'completed');
    assert.equal(isFormatMarkedPositions(stored.raw.unifiedSimilarity.matchedPositions), on, 'test setup sanity: the positions are stored in the form this gate writes');
    assert.equal(u.unifiedScore, 10, '300 of 3,000 words');
    assert.equal(u.uniqueMatchedWords, 300);
    assert.deepEqual(u.matchedPositions, range(100, 399));
    assert.deepEqual(u, scoreOf(report, evidence), 'the score is exactly what the evidence gives on its own');

    assertExplainsExactlyTheScore(stored.report, 'selective only');
    const cards = stored.report.evidenceInterpretation.sources;
    assert.equal(cards.length, 1, 'one verified source');
    assertTruthfulSelectiveCard(cards[0], 'selective only');
    assert.equal(cards[0].matchedWords, 300, 'the card covers the words the source put into the score');
    assert.equal(cards[0].contributionPercent, 10);
    assert.deepEqual(cardPositions(stored.report, cards[0]), range(100, 399), 'and points at exactly those words');
    assert.equal(cards[0].interpretation.primaryKind, 'DISTINCTIVE_EXTERNAL_MATCH');
    for (const p of stored.report.evidenceInterpretation.passages) assert.deepEqual(p.sourceIds, [cards[0].id], 'every highlighted passage names its source');

    // What the customer is shown.
    const seen = await served(owner, id);
    assert.deepEqual(seen.payload.evidenceInterpretation, stored.report.evidenceInterpretation, 'the customer is served the stored explanation');
    assert.deepEqual(seen.payload.unifiedSimilarity.contributions, [], 'per-source attribution itself stays admin-only');
    const vm = buildReportV2ViewModel(seen.payload);
    assert.equal(vm.summary.verifiedSimilarityPercent, 10);
    assert.equal(vm.summary.matchedWordCount, 300);
    assert.equal(vm.summary.distinctVerifiedSources, 1, 'the report says "1 verified source"');
    assert.equal(vm.sources.length, 1);
    assert.deepEqual(
      { label: vm.sources[0].label, badge: vm.sources[0].badge, isGeneric: vm.sources[0].isGeneric, link: vm.sources[0].link, doi: vm.sources[0].doi, matchedWords: vm.sources[0].matchedWords, contributionPercent: vm.sources[0].contributionPercent },
      { label: GENERIC_LABEL, badge: GENERIC_LABEL, isGeneric: true, link: null, doi: null, matchedWords: 300, contributionPercent: 10 },
    );
    assert.equal(vm.summary.topSources.length, 1);
    assert.ok(vm.passages.length > 0 && vm.passages.every((p) => p.sourceIds.length === 1), 'every highlighted passage opens its source');
  }));
}

// ===========================================================================
// 2. beside Archive evidence that overlaps it
// ===========================================================================

for (const [gate, on] of GATES) {
  test(`2. Archive and Selective Corpus evidence that overlap: the union is counted once, and each source has its own card [compact positions ${gate}]`, async () => withPositionsGate(on, async () => {
    const id = `sc-archive-${gate}`;
    const evidence = [['S1', [[100, 399]]]];
    const archive = { archiveMatchedPositions: range(350, 449), sources: [{ name: 'Archive Source A', type: 'Publication', percent: 3, matchedWords: 100 }] };
    const { owner, report } = await finalizedReport(id, evidence, archive);
    const stored = await row(owner, id);
    const u = stored.report.unifiedSimilarity;
    assert.deepEqual(u.matchedPositions, range(100, 449), 'Selective 100-399 united with Archive 350-449');
    assert.equal(u.uniqueMatchedWords, 350);
    assert.equal(u.unifiedScore, 12);
    assert.deepEqual({ archive: u.archiveOnlyWords, selective: u.selectiveCorpusOnlyWords, overlap: u.overlapWords }, { archive: 50, selective: 250, overlap: 50 });
    assert.deepEqual(u, scoreOf(report, evidence), 'the score is exactly what the evidence gives on its own');
    assert.deepEqual(stored.report.archiveMatchedPositions, range(350, 449), 'the archive positions are as the browser relayed them');

    assertExplainsExactlyTheScore(stored.report, 'archive + selective');
    const ei = stored.report.evidenceInterpretation;
    assert.equal(ei.sources.length, 2, 'two verified sources');
    const [selective] = selectiveCards(stored.report);
    const archiveCard = ei.sources.find((s) => s.sourceType === 'publication');
    assertTruthfulSelectiveCard(selective, 'archive + selective');
    assert.equal(selective.matchedWords, 300);
    assert.deepEqual(cardPositions(stored.report, selective), range(100, 399));
    assert.equal(archiveCard.matchedWords, 100, 'the archive card is as it was');
    assert.equal(archiveCard.namedSources[0].label, 'Archive Source A');
    assert.deepEqual(cardPositions(stored.report, archiveCard), range(350, 449));
    const shared = ei.passages.filter((p) => p.sourceIds.length === 2);
    assert.deepEqual(sorted(shared.flatMap((p) => range(p.wordStart, p.wordEnd))), range(350, 399), 'the overlapping words name both sources, once');

    const vm = buildReportV2ViewModel((await served(owner, id)).payload);
    assert.equal(vm.summary.distinctVerifiedSources, 2);
    assert.equal(vm.summary.matchedWordCount, 350, 'the headline counts the overlap once');
    assert.equal(vm.summary.verifiedSimilarityPercent, 12);
  }));
}

// ===========================================================================
// 3-4. several sources; what a card may say
// ===========================================================================

test('3. several Selective Corpus sources: one card each, in an order that does not depend on the order the evidence arrived in, and never two for one source', async () => {
  const evidence = [['S1', [[100, 199]]], ['S2', [[500, 799]]], ['S3', [[1000, 1049], [1100, 1149]]]];
  const { owner } = await finalizedReport('sc-several', evidence, { text: words(3000, 3301) });
  const stored = await row(owner, 'sc-several');
  assert.equal(stored.report.unifiedSimilarity.uniqueMatchedWords, 500);
  assertExplainsExactlyTheScore(stored.report, 'several sources');
  const cards = stored.report.evidenceInterpretation.sources;
  assert.equal(cards.length, 3);
  for (const card of cards) assertTruthfulSelectiveCard(card, 'several sources');
  // Largest first; equal sources in a fixed order.
  assert.deepEqual(cards.map((c) => [c.id, c.matchedWords, cardPositions(stored.report, c)[0]]), [['src-1', 300, 500], ['src-2', 100, 100], ['src-3', 100, 1000]]);
  assert.deepEqual(cardPositions(stored.report, cards[2]), [...range(1000, 1049), ...range(1100, 1149)], 'a source with two passages is still one card');
  assert.equal(cards.reduce((n, c) => n + c.matchedWords, 0), 500, 'co-source attribution gives each word to one source, so the cards add up to the score');

  // The same evidence, handed over in another order.
  const reordered = await finalizedReport('sc-several-reordered', [evidence[2], evidence[0], evidence[1]], { text: words(3000, 3301) });
  const other = await row(reordered.owner, 'sc-several-reordered');
  assert.deepEqual(other.report.evidenceInterpretation, stored.report.evidenceInterpretation, 'the same cards, ids and passages');
  assert.deepEqual(other.report.unifiedSimilarity.matchedPositions, stored.report.unifiedSimilarity.matchedPositions);

  // A source listed twice is one source: the score takes its first listing (lib/unified-similarity.ts), and so does its card.
  const repeated = [['S1', [[100, 199]]], ['S2', [[500, 799]]], ['S1', [[100, 199]]], ['S1', [[2000, 2049]]]];
  const twice = await finalizedReport('sc-repeated', repeated, { text: words(3000, 3301) });
  const dup = await row(twice.owner, 'sc-repeated');
  assert.deepEqual(dup.report.unifiedSimilarity.matchedPositions, [...range(100, 199), ...range(500, 799)], 'test setup sanity: the repeated listing added nothing to the score');
  assertExplainsExactlyTheScore(dup.report, 'repeated source');
  assert.deepEqual(dup.report.evidenceInterpretation.sources.map((c) => [c.id, c.matchedWords]), [['src-1', 300], ['src-2', 100]], 'one card per source, covering only what is in the score');
});

test('4. a Selective Corpus source has no title, link or date to show: the card carries none, whatever travels with the evidence, and the internal source label reaches no customer', async () => {
  const id = 'sc-metadata';
  // Fields the evaluator does not produce, as if a later build attached them.
  const evidence = [['INTERNAL-LABEL-ZX81', [[100, 399]], { title: 'Leaked Article Title', url: 'https://leak.example/article', doi: '10.9999/leak', year: 1999, sourceId: 'corpus-doc-7398' }]];
  const { owner } = await finalizedReport(id, evidence);
  const stored = await row(owner, id);
  assert.equal(stored.report.unifiedSimilarity.unifiedScore, 10);
  const [card] = selectiveCards(stored.report);
  assert.ok(card, 'the source has a card');
  assertTruthfulSelectiveCard(card, 'metadata');
  assert.equal(card.matchedWords, 300);

  const seen = await served(owner, id);
  for (const secret of ['INTERNAL-LABEL-ZX81', 'Leaked Article Title', 'leak.example', '10.9999/leak', 'corpus-doc-7398', 'selective-corpus:']) {
    assert.equal(seen.text.includes(secret), false, `the served report does not contain ${secret}`);
    assert.equal(JSON.stringify(stored.raw.evidenceInterpretation).includes(secret), false, `the stored explanation does not contain ${secret}`);
  }
  const vm = buildReportV2ViewModel(seen.payload);
  assert.deepEqual({ label: vm.sources[0].label, link: vm.sources[0].link, doi: vm.sources[0].doi, year: vm.sources[0].year, namedSources: vm.sources[0].namedSources }, { label: GENERIC_LABEL, link: null, doi: null, year: null, namedSources: [] });
  assert.equal(vm.summary.topSources[0].link, null);
});

// ===========================================================================
// 5-7. the cards are part of the stored report
// ===========================================================================

for (const [gate, on] of GATES) {
  test(`5-6. the AI save and every reload show the same cards [compact positions ${gate}]`, async () => withPositionsGate(on, async () => {
    const id = `sc-resave-${gate}`;
    const evidence = [['S1', [[100, 399]]], ['S2', [[1000, 1099]]]];
    const { owner, report } = await finalizedReport(id, evidence, { archiveMatchedPositions: range(350, 449), sources: [{ name: 'Archive Source A', type: 'Publication', percent: 3, matchedWords: 100 }] });
    const before = await row(owner, id);
    const seenBefore = await served(owner, id);
    assert.equal(before.report.evidenceInterpretation.sources.length, 3, 'test setup sanity: two Selective cards and the archive card');
    assert.equal(selectiveCards(before.report).length, 2);

    // The browser's AI save: its own copy of the report, which has no server score, explanation or cards at all.
    assert.equal((await aiSave(owner, report)).status, 200);
    const after = await row(owner, id);
    assert.equal(after.raw.aiAnalysis?.status, 'complete', 'the AI result is stored');
    assert.equal(JSON.stringify(after.raw.evidenceInterpretation), JSON.stringify(before.raw.evidenceInterpretation), 'the stored explanation is byte-identical');
    assert.deepEqual(after.report.unifiedSimilarity, before.report.unifiedSimilarity);

    // A save that carries an explanation of its own (no cards), and one that carries forged cards.
    const cardless = withEvidenceInterpretation({ ...report, unifiedSimilarity: computeUnifiedSimilarity({ wordCount: report.wordCount, archiveMatchedPositions: report.archiveMatchedPositions }) }, { selectiveCorpusBranch: null });
    assert.equal((await aiSave(owner, report, { payload: { unifiedSimilarity: cardless.unifiedSimilarity, evidenceInterpretation: cardless.evidenceInterpretation } })).status, 200);
    const forged = { ...before.report.evidenceInterpretation, sources: before.report.evidenceInterpretation.sources.map((s) => ({ ...s, label: 'Forged Source', link: 'https://forged.example' })) };
    assert.equal((await aiSave(owner, report, { payload: { evidenceInterpretation: forged } })).status, 200);
    assert.equal(JSON.stringify((await row(owner, id)).raw.evidenceInterpretation), JSON.stringify(before.raw.evidenceInterpretation), 'nothing a save carries replaces the stored cards');

    // Reloads.
    const first = await served(owner, id);
    const second = await served(owner, id);
    assert.deepEqual(first.payload.evidenceInterpretation, seenBefore.payload.evidenceInterpretation, 'the same cards after the AI save');
    assert.deepEqual(second.payload.evidenceInterpretation, first.payload.evidenceInterpretation, 'and on every reload');
    assert.deepEqual(first.payload.evidenceInterpretation, before.report.evidenceInterpretation);
    assert.deepEqual(buildReportV2ViewModel(second.payload).sources, buildReportV2ViewModel(seenBefore.payload).sources, 'the rendered cards are the same');
    assert.equal(buildReportV2ViewModel(second.payload).summary.distinctVerifiedSources, 3);
  }));
}

test('7. the cards are the same in every persisted form: compact positions off and on, compact explanation off and on', async () => {
  const evidence = [['S1', [[100, 399]]], ['S2', [[1000, 1099]]]];
  const options = { text: words(3000, 3701), archiveMatchedPositions: range(350, 449), sources: [{ name: 'Archive Source A', type: 'Publication', percent: 3, matchedWords: 100 }] };
  const forms = [];
  for (const [compactWrites, compactPositions] of [[true, false], [true, true], [false, false], [false, true]]) {
    await withFlag('REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED', compactWrites, () => withPositionsGate(compactPositions, async () => {
      const id = `sc-form-${compactWrites ? 'c' : 'l'}-${compactPositions ? 'r' : 'a'}`;
      const { owner } = await finalizedReport(id, evidence, options);
      const stored = await row(owner, id);
      assert.equal(isCompactEvidenceInterpretation(stored.raw.evidenceInterpretation), compactWrites, 'test setup sanity: the explanation is stored in the form this gate writes');
      assert.equal(isFormatMarkedPositions(stored.raw.unifiedSimilarity.matchedPositions), compactPositions, 'test setup sanity: the positions are stored in the form this gate writes');
      forms.push({ id, interpretation: stored.report.evidenceInterpretation, similarity: stored.report.unifiedSimilarity, served: (await served(owner, id)).payload.evidenceInterpretation });
    }));
  }
  const [reference, ...others] = forms;
  assert.equal(selectiveCards({ evidenceInterpretation: reference.interpretation }).length, 2);
  for (const form of others) {
    assert.deepEqual(form.interpretation, reference.interpretation, `${form.id}: the same explanation and cards`);
    assert.deepEqual(form.served, reference.served, `${form.id}: the same cards served`);
    assert.deepEqual(form.similarity, reference.similarity, `${form.id}: the same score`);
  }
});

// ===========================================================================
// 8. the card follows the score, in both directions
// ===========================================================================

test('8a. a partial Selective Corpus search still shows the sources it did verify', async () => {
  const { owner } = await finalizedReport('sc-partial', [['S1', [[100, 399]]]], { state: 'PARTIAL' });
  const stored = await row(owner, 'sc-partial');
  assert.equal(stored.report.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.equal(stored.report.unifiedSimilarity.unifiedScore, 10, 'its evidence is in the score, as a lower bound');
  assertExplainsExactlyTheScore(stored.report, 'partial');
  assert.equal(selectiveCards(stored.report).length, 1);
  assert.equal(buildReportV2ViewModel((await served(owner, 'sc-partial')).payload).summary.distinctVerifiedSources, 1);
});

test('8b. no Selective Corpus evidence in the score, no Selective Corpus card: an empty search, a search that timed out, an ordinary report, and cards a client sends', async () => {
  const archive = { archiveMatchedPositions: range(350, 449), sources: [{ name: 'Archive Source A', type: 'Publication', percent: 3, matchedWords: 100 }] };

  // The search completed and verified nothing.
  const empty = await finalizedReport('sc-none', [], archive);
  const emptyRow = await row(empty.owner, 'sc-none');
  assert.equal(emptyRow.report.selectiveCorpusAuthoritativeStatus, 'completed');
  assert.equal(emptyRow.report.unifiedSimilarity.selectiveCorpusOnlyWords, 0);
  assertExplainsExactlyTheScore(emptyRow.report, 'empty search');
  assert.deepEqual(emptyRow.report.evidenceInterpretation.sources.map((s) => s.sourceType), ['publication'], 'the archive card alone');

  // Every attempt timed out.
  const owner = await signUpOwner();
  const report = localReport('sc-timeout', words(3000, 3801), archive);
  await seedPending(owner, report);
  for (let i = 0; i < MAX_SELECTIVE_CORPUS_AUTHORITATIVE_ATTEMPTS; i += 1) await finalize(owner, report.id, timeoutShadow());
  const timedOut = await row(owner, report.id);
  assert.equal(timedOut.report.selectiveCorpusAuthoritativeStatus, 'incomplete');
  assert.deepEqual(timedOut.report.evidenceInterpretation.sources.map((s) => s.sourceType), ['publication']);

  // A report with no evidence at all keeps saying so.
  const blank = await finalizedReport('sc-blank', []);
  const blankRow = await row(blank.owner, 'sc-blank');
  assert.equal(blankRow.report.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(blankRow.report.evidenceInterpretation.sources, []);
  assert.equal(buildReportV2ViewModel((await served(blank.owner, 'sc-blank')).payload).summary.distinctVerifiedSources, 0);

  // A report that never was authoritative, saved with a forged similarity that claims Selective Corpus sources.
  const ordinaryOwner = await signUpOwner();
  const ordinary = localReport('sc-ordinary', words(3000, 3802), archive);
  const forgedUnified = { ...scoreOf(ordinary, [['S1', [[100, 399]]]]) };
  const forgedCards = withEvidenceInterpretation({ ...ordinary, unifiedSimilarity: forgedUnified }, { selectiveCorpusBranch: null }).evidenceInterpretation;
  assert.equal((await aiSave(ordinaryOwner, ordinary, { payload: { unifiedSimilarity: forgedUnified, evidenceInterpretation: forgedCards }, body: { room: 0 } })).status, 200);
  const ordinaryRow = await row(ordinaryOwner, 'sc-ordinary');
  assert.equal(ordinaryRow.raw.selectiveCorpusAuthoritativeStatus, undefined);
  assert.equal(ordinaryRow.report.unifiedSimilarity.selectiveCorpusOnlyWords, 0, 'the server computed its own score');
  assert.deepEqual(ordinaryRow.report.unifiedSimilarity.matchedPositions, range(350, 449));
  assert.deepEqual(ordinaryRow.report.evidenceInterpretation.sources.map((s) => s.sourceType), ['publication'], 'and its own cards');
});

test('8c. the explanation builder gives a report without Selective Corpus contributions exactly what it gave before, and reads the cards off the score it is handed', () => {
  const text = words(3000, 3901);
  const report = localReport('sc-pure', text, { archiveMatchedPositions: range(350, 449), sources: [{ name: 'Archive Source A', type: 'Publication', percent: 3, matchedWords: 100 }] });
  const without = { ...report, unifiedSimilarity: scoreOf(report, []) };
  assert.deepEqual(
    withEvidenceInterpretation(without, { selectiveCorpusBranch: null }).evidenceInterpretation,
    withEvidenceInterpretation(without, { selectiveCorpusBranch: null, selectiveCorpusAdmittedSources: [] }).evidenceInterpretation,
    'no contributions: the same explanation as with an explicitly empty source list',
  );

  // Passages the score did not take (out of range, or malformed) are not on the card either.
  const unified = computeUnifiedSimilarity({
    wordCount: report.wordCount, archiveMatchedPositions: report.archiveMatchedPositions,
    selectiveCorpusEvidence: [{ sourceId: 'S1', matchedPassages: [passage(2990, 3050), { submittedWordStart: 10.5, submittedWordEnd: 20, matchedWordCount: 10 }, { submittedWordStart: 700, submittedWordEnd: 600, matchedWordCount: 5 }] }],
  });
  assert.deepEqual(unified.selectiveCorpusPositions, range(2990, 2999), 'test setup sanity: the score clamps the passage to the document and drops the malformed ones');
  const built = withEvidenceInterpretation({ ...report, unifiedSimilarity: unified }, { selectiveCorpusBranch: null });
  assertExplainsExactlyTheScore(built, 'clamped');
  const [card] = selectiveCards(built);
  assert.equal(card.matchedWords, 10);
  assert.deepEqual(cardPositions(built, card), range(2990, 2999));

  // An explicit source list from the caller still wins (the option's existing contract).
  const explicit = withEvidenceInterpretation({ ...report, unifiedSimilarity: scoreOf(report, [['S1', [[100, 399]]]]) }, {
    selectiveCorpusBranch: null, selectiveCorpusAdmittedSources: [{ key: 'explicit', spans: [{ start: 100, end: 149, words: 50 }], familyGuardActivated: false, dominantSpanBoilerplate: false }],
  });
  assert.deepEqual(selectiveCards(explicit).map((c) => c.matchedWords), [50]);
});

// ===========================================================================
// 9-10. under size pressure the cards lose detail, never their existence
// ===========================================================================

const expanded = (result) => {
  assert.equal(result.ok, true, 'the report fits');
  const expansion = expandEvidenceInterpretationFromPersistence(result.evidenceInterpretation);
  assert.notEqual(expansion.status, 'unreadable');
  return expansion.value;
};
/** The smallest limit at or under `high` at which `accept(build(limit))` holds; `accept` only ever turns true as the limit grows. */
function smallestLimit(build, accept, high) {
  assert.ok(accept(build(high)), 'test setup sanity: the upper limit is accepted');
  let low = 0;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (accept(build(mid))) high = mid;
    else low = mid + 1;
  }
  return low;
}
const withoutLinks = (card) => { const { passageRefs: _passageRefs, ...rest } = card; return rest; };
const withoutSources = (passage) => { const { sourceIds: _sourceIds, ...rest } = passage; return rest; };
const isSelective = (card) => card.sourceType === 'selective-corpus';
/** The minimum card: which source, what it contributed, and nothing optional. */
const minimalCardOf = (card) => ({
  id: card.id, label: card.label, sourceType: card.sourceType, link: null, doi: null, year: null,
  contributionPercent: card.contributionPercent, matchedWords: card.matchedWords,
  interpretation: { primaryKind: card.interpretation.primaryKind, confidence: card.interpretation.confidence, reasons: [], mixedKinds: [] },
  passageRefs: [],
});
/** The stored size of an explanation in the form a gate writes. */
const storedSize = (interpretation, compactWrites) => JSON.stringify(compactEvidenceInterpretationForPersistence(interpretation, { compactWrites })).length;

for (const [compactWrites, compactPositions] of [[true, false], [true, true], [false, false]]) {
  test(`9. a report with less room than its Selective Corpus cards need gives up their passage links, then their optional text — and never a card: below the minimum card it is not stored at all [compact explanation ${compactWrites ? 'on' : 'off'}, compact positions ${compactPositions ? 'on' : 'off'}]`, () => {
    const report = localReport('sc-ladder', words(3000, 3911), { archiveMatchedPositions: range(350, 449), sources: [{ name: 'Archive Source A', type: 'Publication', percent: 3, matchedWords: 100 }] });
    const evidence = [['S1', Array.from({ length: 20 }, (_, i) => [600 + i * 20, 609 + i * 20])], ['S2', [[1500, 1599]]], ['S3', [[300, 379]]]];
    const finalReport = { ...report, unifiedSimilarity: scoreOf(report, evidence) };
    const build = (maxBytes) => buildFinalizedReportEvidenceInterpretation(finalReport, { maxBytes, compactWrites, compactPositions });
    const selectiveOf = (result) => (result.ok ? expanded(result).sources.filter(isSelective) : []);
    const HIGH = MAX_REPORT_SAVE_REQUEST_BYTES;

    const everything = withEvidenceInterpretation(finalReport, { selectiveCorpusBranch: null }).evidenceInterpretation;
    assert.equal(everything.sources.filter(isSelective).length, 3, 'test setup sanity: three Selective Corpus sources contribute');
    assert.ok(everything.sources.filter(isSelective).every((c) => c.interpretation.reasons.length > 0), 'test setup sanity: a full card carries its explanation');

    const fits = smallestLimit(build, (r) => r.ok, HIGH);
    const fitsWithText = smallestLimit(build, (r) => selectiveOf(r).some((c) => c.interpretation.reasons.length > 0), HIGH);
    const fitsWithLinks = smallestLimit(build, (r) => selectiveOf(r).some((c) => c.passageRefs.length > 0), HIGH);
    assert.ok(fits < fitsWithText && fitsWithText < fitsWithLinks, `three distinct sizes: ${fits} < ${fitsWithText} < ${fitsWithLinks}`);

    // Room for everything.
    assert.deepEqual(expanded(build(HIGH)), everything);
    assert.deepEqual(expanded(build(fitsWithLinks)), everything, 'exactly enough room: every card and every passage link');

    // One unit short of that: every card stays, unlinked.
    const unlinked = expanded(build(fitsWithLinks - 1));
    assertExplainsExactlyTheScore({ unifiedSimilarity: finalReport.unifiedSimilarity, evidenceInterpretation: unlinked }, 'cards without links', { unlinkedSelectiveCards: true });
    assert.deepEqual(unlinked.sources.map(withoutLinks), everything.sources.map(withoutLinks), 'the same cards: sources, labels, matched words, percentages and explanation');
    assert.deepEqual(unlinked.sources.filter((s) => !isSelective(s)), everything.sources.filter((s) => !isSelective(s)), 'every other card keeps its links');
    assert.deepEqual(unlinked.passages.map(withoutSources), everything.passages.map(withoutSources), 'the same highlighted passages');
    const selectiveIds = unlinked.sources.filter(isSelective).map((s) => s.id);
    assert.ok(unlinked.passages.every((p) => !p.sourceIds.some((id) => selectiveIds.includes(id))), 'no passage names a Selective card');
    assert.deepEqual(expanded(build(fitsWithText)), unlinked, 'down to exactly enough room for the unlinked cards');

    // One unit short of THAT: the minimum card — which source, how many words, what share — and nothing optional.
    const minimal = expanded(build(fitsWithText - 1));
    assertExplainsExactlyTheScore({ unifiedSimilarity: finalReport.unifiedSimilarity, evidenceInterpretation: minimal }, 'minimum cards', { unlinkedSelectiveCards: true });
    assert.deepEqual(minimal.sources.filter(isSelective), everything.sources.filter(isSelective).map(minimalCardOf), 'each Selective card is exactly the minimum card of its source');
    assert.deepEqual(minimal.sources.filter((s) => !isSelective(s)), everything.sources.filter((s) => !isSelective(s)), 'every other card is untouched');
    assert.deepEqual(minimal.sources.map((c) => [c.id, c.matchedWords, c.contributionPercent]), everything.sources.map((c) => [c.id, c.matchedWords, c.contributionPercent]), 'no source and no number is lost');
    assert.deepEqual({ ...minimal, sources: null }, { ...unlinked, sources: null }, 'nothing but the cards\' optional text differs from the unlinked form');
    assert.deepEqual(
      { positionsByKind: minimal.positionsByKind, countsByKind: minimal.countsByKind, matchedWordCount: minimal.matchedWordCount },
      { positionsByKind: everything.positionsByKind, countsByKind: everything.countsByKind, matchedWordCount: everything.matchedWordCount },
    );
    assert.deepEqual(expanded(build(fits)), minimal, 'down to exactly enough room for the minimum cards');
    const vm = buildReportV2ViewModel({ ...finalReport, evidenceInterpretation: minimal });
    assert.equal(vm.summary.distinctVerifiedSources, 4, 'the report still counts every verified source');
    assert.deepEqual(vm.sources.filter(isSelective).map((c) => [c.label, c.link, c.doi, c.year, c.matchedWords]), everything.sources.filter(isSelective).map((c) => [GENERIC_LABEL, null, null, null, c.matchedWords]));

    // One unit short of the minimum cards: the report is not stored. There is no smaller form that keeps the percentage.
    assert.deepEqual(build(fits - 1), { ok: false, reason: 'PERSISTED_SIZE_EXCEEDED', persistedBytes: fits, maxBytes: fits - 1 });
    // The explanation without any Selective card WOULD fit a little lower down — and is never chosen.
    const cardless = withEvidenceInterpretation(finalReport, { selectiveCorpusBranch: null, selectiveCorpusAdmittedSources: [] }).evidenceInterpretation;
    const cardBytes = storedSize(minimal, compactWrites) - storedSize(cardless, compactWrites);
    assert.ok(cardBytes > 0, 'test setup sanity: the minimum cards take room');
    for (const limit of [fits - 1, fits - Math.ceil(cardBytes / 2), fits - cardBytes, fits - cardBytes - 1, Math.floor(fits / 2), 1]) {
      const result = build(limit);
      assert.equal(result.ok, false, `limit ${limit}: not stored`);
      assert.equal(result.reason, 'PERSISTED_SIZE_EXCEEDED');
    }
    // Whatever the limit: stored means every contributing Selective source has its card.
    for (let limit = fits - 200; limit <= fitsWithLinks + 200; limit += 37) {
      const result = build(limit);
      if (result.ok) assert.equal(selectiveOf(result).length, 3, `limit ${limit}: a stored score names all three Selective sources`);
      else assert.ok(limit < fits, `limit ${limit}: only a limit under the minimum cards is refused`);
    }

    // A report without Selective Corpus evidence has nothing to give up: one size, nothing in between.
    const plain = { ...report, unifiedSimilarity: scoreOf(report, []) };
    const buildPlain = (maxBytes) => buildFinalizedReportEvidenceInterpretation(plain, { maxBytes, compactWrites, compactPositions });
    const plainFits = smallestLimit(buildPlain, (r) => r.ok, HIGH);
    assert.deepEqual(expanded(buildPlain(plainFits)), expanded(buildPlain(HIGH)));
    assert.deepEqual(buildPlain(plainFits - 1), { ok: false, reason: 'PERSISTED_SIZE_EXCEEDED', persistedBytes: plainFits, maxBytes: plainFits - 1 });
  });
}

test('10. through the finalizer, near the limit: no room for the passage links -> finalized with its score and every source card; no room for even the minimum cards -> "Similarity unavailable", never a score with no Selective source', async () => {
  // The legacy stored form (both compact gates off), where the sizes are largest and easiest to place.
  await withFlag('REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED', false, () => withPositionsGate(false, async () => {
    const text = words(30_000, 4011);
    // Twenty sources, 75 ten-word passages each: 15,000 of 30,000 words.
    const evidence = Array.from({ length: 20 }, (_, n) => [`S${n + 1}`, Array.from({ length: 75 }, (_, i) => { const start = n * 1500 + i * 20; return [start, start + 9]; })]);
    const finalizePadded = async (id, padding) => {
      const owner = await signUpOwner();
      await seedPending(owner, { ...localReport(id, text), testPadding: 'x'.repeat(padding) });
      return { owner, outcome: await finalize(owner, id, shadow('COMPLETED', evidence)) };
    };

    // With room: every card, every link.
    const roomy = await finalizePadded('sc-room', 0);
    assert.deepEqual(roomy.outcome, { outcome: 'finalized', status: 'completed' });
    const full = await row(roomy.owner, 'sc-room');
    assert.equal(full.report.unifiedSimilarity.unifiedScore, 50);
    assert.equal(selectiveCards(full.report).length, 20);
    assert.ok(selectiveCards(full.report).every((c) => c.passageRefs.length === 75), 'test setup sanity: every card links its 75 passages');
    assertExplainsExactlyTheScore(full.report, 'with room');

    // How much of the stored report each layer of card detail is.
    const ei = full.raw.evidenceInterpretation;
    const size = (interpretation) => JSON.stringify(interpretation).length;
    const ids = ei.sources.filter(isSelective).map((s) => s.id);
    const unlinkedForm = { ...ei, sources: ei.sources.map((s) => (ids.includes(s.id) ? { ...s, passageRefs: [] } : s)), passages: ei.passages.map((p) => ({ ...p, sourceIds: p.sourceIds.filter((id) => !ids.includes(id)) })) };
    const minimalForm = { ...unlinkedForm, sources: unlinkedForm.sources.map((s) => (ids.includes(s.id) ? minimalCardOf(s) : s)) };
    const cardlessForm = { ...minimalForm, sources: minimalForm.sources.filter((s) => !ids.includes(s.id)) };
    const links = size(ei) - size(unlinkedForm), optionalText = size(unlinkedForm) - size(minimalForm), cards = size(minimalForm) - size(cardlessForm);
    assert.ok(links > 8_000 && cards > 3_000, `test setup sanity: links ${links}, optional text ${optionalText}, minimum cards ${cards}`);
    const room = MAX_REPORT_SAVE_REQUEST_BYTES - full.json.length;
    assert.ok(room > 0, 'test setup sanity: the unpadded report fits');

    // ADVERSARIAL NEAR-LIMIT: with its links the report is over the limit by half their size; without them it is under by the other half.
    const tight = await finalizePadded('sc-tight', room + Math.floor(links / 2));
    assert.deepEqual(tight.outcome, { outcome: 'finalized', status: 'completed' }, 'the report is finalized, not left without a score');
    const kept = await row(tight.owner, 'sc-tight');
    assert.ok(kept.json.length <= MAX_REPORT_SAVE_REQUEST_BYTES, 'what was stored is within the limit');
    assert.deepEqual(kept.report.unifiedSimilarity, full.report.unifiedSimilarity, 'the same score, positions and attribution');
    assertExplainsExactlyTheScore(kept.report, 'no room for links', { unlinkedSelectiveCards: true });
    assert.deepEqual(selectiveCards(kept.report).map(withoutLinks), selectiveCards(full.report).map(withoutLinks), 'the same twenty sources with the same matched words');
    const seen = buildReportV2ViewModel((await served(tight.owner, 'sc-tight')).payload);
    assert.equal(seen.summary.verifiedSimilarityPercent, 50);
    assert.equal(seen.summary.distinctVerifiedSources, 20, 'the customer sees twenty verified sources, not none');

    // TIGHTER STILL: not even the minimum cards fit (over by half their size) — while the report WITHOUT any Selective card
    // would fit (under by the other half). It must not be stored that way: no score, the existing terminal state.
    const noCards = await finalizePadded('sc-no-cards', room + links + optionalText + Math.floor(cards / 2));
    assert.deepEqual(noCards.outcome, { outcome: 'persistence-limit-exceeded', status: 'incomplete' }, 'not finalized with a score and no Selective source');
    const refused = await row(noCards.owner, 'sc-no-cards');
    assert.equal(refused.raw.selectiveCorpusAuthoritativeStatus, 'incomplete');
    assert.equal(refused.raw.selectiveCorpusAuthoritativeIncompleteReason, 'PERSISTENCE_LIMIT');
    assert.equal(refused.raw.unifiedSimilarity, undefined, 'no score is stored');
    const refusedView = (await served(noCards.owner, 'sc-no-cards')).payload;
    assert.equal(refusedView.unifiedSimilarity, undefined, 'the customer is shown no percentage');
    assert.equal(refusedView.reportCompletion.headline, SIMILARITY_NOT_FINALIZED_HEADLINE, 'and is told the similarity is unavailable');

    // Far over the limit: the same terminal state, as before.
    const over = await finalizePadded('sc-over', room + links + cards + 30_000);
    assert.deepEqual(over.outcome, { outcome: 'persistence-limit-exceeded', status: 'incomplete' });
    assert.equal((await row(over.owner, 'sc-over')).raw.unifiedSimilarity, undefined);
  }));
});
