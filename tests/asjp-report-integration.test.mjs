import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import http from 'node:http';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { resolvePrimarySimilaritySummary, selfHealUnifiedSimilarity } from '../lib/report-primary-similarity.ts';
import { retryAsjpEvidenceForReport } from '../lib/report-asjp-evidence.ts';
import { asjpChannelOf, ASJP_REPORT_EVIDENCE_SCHEMA } from '../lib/asjp-report-evidence.ts';
import { buildReportV2ViewModel, ASJP_UNAVAILABLE_NOTICE } from '../lib/report-v2-view.ts';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import { tryDecodeReportFromPersistence } from '../lib/report-persistence.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';

/**
 * ASJP Phase 6.5 — generation-pinned persistence + report integration, end to end through the REAL report routes
 * (POST /api/reports, GET /api/reports/[id]) against a stub ASJP matching service on localhost. Covers: flag off is
 * byte-identical; an accepted answer is persisted with its pins and drives the union (each word once) and the source
 * cards; a resave never re-queries and never accepts a client-forged record; a new service generation never changes
 * a saved report; recomputes are deterministic; UNAVAILABLE -> notice -> retry -> atomic score + explanation; refused
 * answers (wrong generation, card/evidence mismatch, dropped connection); legacy / unknown-schema / v1 reports.
 */
const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_asjp_report_integration.db');
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* none */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, path.join(repo, 'drizzle'));

// ---- a manuscript of unique words (normalization 2 == split on spaces here) ----
const SYL = ['ka', 'lo', 'mi', 'ra', 'tu', 'ne', 'so', 'vi'];
const WORDS = []; for (const a of SYL) for (const b of SYL) for (const c of SYL) WORDS.push(a + b + c);
const manuscript = (offset, n = 300) => WORDS.slice(offset, offset + n).join(' ');
const wordsOf = (text) => tokensForScoringNormalization(text, 2).length;

// ---- the stub matching service ----
const G1 = 'gen-asjp-test-1', M1 = 'a'.repeat(64), G2 = 'gen-asjp-test-2';
const stub = { mode: 'accept', calls: 0 };
const card = (id, start, end, extra = {}) => ({
  kind: 'asjp_publication', sourceId: `asjp:${id}`, title: `Article ${id}`, journal: 'Journal of Tests', publicationDate: '2021-05-01', doi: `10.1000/${id}`,
  url: `https://asjp.cerist.dz/en/article/${id}`, authors: ['Doe, J.'], license: 'CC BY 4.0', licenceStatus: 'PERMITTED', relationship: 'INDEPENDENT_PUBLICATION',
  attribution: 'PUBLISHED_SOURCE', scored: true, matchedWordCount: end - start + 1, admittedBy: 'VERIFIER',
  passages: [{ submittedWordStart: start, submittedWordEnd: end, sourceWordStart: 100, sourceWordEnd: 100 + end - start, sourceCharStart: 700, sourceCharEnd: 700 + 8 * (end - start + 1) }],
  labels: [], ...extra,
});
const answerFor = (n, mode) => {
  const cards = [card(101, 10, 79), card(202, 50, 119, { attribution: 'SHARED_TEXT_ORIGIN_NOT_ESTABLISHED', labels: [{ kind: 'SHARED_ACADEMIC_TEXT', submittedWordStart: 50, submittedWordEnd: 119, words: 70, otherArticles: 1 }] })];
  const evidence = cards.map((c) => ({ sourceId: c.sourceId, matchedPassages: c.passages.map((p) => ({ submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, matchedWordCount: p.submittedWordEnd - p.submittedWordStart + 1 })) }));
  if (mode === 'mismatch') evidence[0].matchedPassages[0].submittedWordEnd = 90;
  return {
    state: 'COMPLETE', failureCode: null, wordCount: n, creditedPositions: [], asjpPublicationEvidence: evidence, cards,
    generationId: mode === 'gen2' ? G2 : G1, logicalManifestSha256: M1, laneVersion: 'asjp-academic-lane-v5', licencePolicy: 'permitted-only', normalization: 2,
    catalogLoadedAt: '2026-10-15T00:00:00.000Z', catalogDigest: 'c'.repeat(64), features: { numericTables: false, shortSignal: true },
    research: { shortPassages: { scored: false, label: 'UNSCORED_RESEARCH_SIGNAL', passages: [{ sourceId: 'asjp:303', submittedWordStart: 200, submittedWordEnd: 229 }] } },
  };
};
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    stub.calls += 1;
    if (req.headers.authorization !== 'Bearer stub-token') { res.writeHead(401); return res.end('{}'); }
    if (stub.mode === 'drop') return req.socket.destroy();
    if (stub.mode === 'busy') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ state: 'BUSY', failureCode: 'ASJP_BUSY' })); }
    const { text } = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answerFor(wordsOf(text), stub.mode)));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ASJP_ENV = { ASJP_REPORT_EVIDENCE_ENABLED: 'true', ASJP_SERVICE_URL: `http://127.0.0.1:${server.address().port}`, ASJP_SERVICE_TOKEN: 'stub-token', ASJP_PINNED_GENERATION_ID: G1, ASJP_PINNED_MANIFEST_SHA256: M1, ASJP_SERVICE_TIMEOUT_MS: '3000' };
const setAsjp = (on) => { for (const [k, v] of Object.entries(ASJP_ENV)) { if (on) process.env[k] = v; else delete process.env[k]; } };

test.after(() => { server.close(); client.close(); setAsjp(false); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* none */ } } });

// ---- an account + the real routes ----
let n = 0;
async function account() {
  n += 1;
  const email = `asjp-report-${n}@example.test`, deviceKey = `asjp-report-device-${n}`, tag = `asjp-report-${n}`;
  await resetAuthRateForTest(`${tag}-signup`);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${tag}-signup` }, body: JSON.stringify(withTestIdentity({ email, password: 'asjp-report-pw-1', username: `asjpuser${n}`, deviceKey })) }));
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie').match(/tp_session_v1=([^;]*)/)[1];
  const userId = (await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] })).rows[0].id;
  return { userId, deviceKey, cookie, tag, rooms: new Map() };
}
async function post(acc, id, text, { normalization = 2, payloadOverrides = {} } = {}) {
  await resetRateForTest(`${acc.tag}-post`);
  const wordCount = wordsOf(text);
  if (!acc.rooms.has(id)) acc.rooms.set(id, acc.rooms.size);
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${acc.tag}-post`, cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: `sub-${id}`, title: 'ASJP fixture', createdAt: new Date().toISOString(), wordCount, archiveScore: 0, scoreBand: 'Low', aiScore: null, aiTone: null, aiStatus: null, room: acc.rooms.get(id),
      ...(normalization === 2 ? { scoringNormalization: 2 } : {}),
      payload: { version: 11, id, submissionId: `sub-${id}`, title: 'ASJP fixture', author: '', assignment: '', created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount, scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [], text, ...payloadOverrides },
    }),
  }));
  assert.equal(res.status, 200, `save must succeed (${res.status})`);
  return res;
}
async function getPayload(acc, id) {
  await resetReadRateForTest(`${acc.tag}-get`);
  const res = await reportIdRoute.GET(new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(acc.deviceKey)}`, { headers: { 'x-forwarded-for': `${acc.tag}-get`, cookie: `tp_session_v1=${acc.cookie}` } }), { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200);
  return (await res.json()).payload;
}
async function row(acc, id) {
  const r = (await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [acc.deviceKey, id] })).rows[0];
  const raw = String(r.payload_json);
  const decoded = tryDecodeReportFromPersistence(JSON.parse(raw), { requireContributions: false });
  return { raw, payload: decoded.report };
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('flag off: no service call, no ASJP key anywhere in the saved report (byte-identical path)', async () => {
  setAsjp(false); stub.mode = 'accept'; const calls = stub.calls;
  const acc = await account();
  await post(acc, 'asjp-off-1', manuscript(0));
  const { raw, payload } = await row(acc, 'asjp-off-1');
  assert.equal(stub.calls, calls, 'the service is never called with ASJP off');
  assert.ok(!/"asjp[A-Z]|asjp_publication|asjp-publication/.test(raw), 'no ASJP key, channel or card in payload_json');
  assert.equal(payload.unifiedSimilarity.asjpPublicationOnlyWords, undefined);
});

test('accepted answer: pinned record persisted; union counts each word once; source cards; client never sees the record', async () => {
  setAsjp(true); stub.mode = 'accept'; const calls = stub.calls;
  const acc = await account();
  await post(acc, 'asjp-on-1', manuscript(0));
  assert.equal(stub.calls, calls + 1, 'one service call per new report');
  const { payload } = await row(acc, 'asjp-on-1');
  const rec = payload.asjpEvidence;
  assert.equal(rec.schema, ASJP_REPORT_EVIDENCE_SCHEMA); assert.equal(rec.status, 'ACCEPTED');
  assert.deepEqual([rec.pins.generationId, rec.pins.logicalManifestSha256, rec.pins.laneVersion, rec.pins.normalization, rec.pins.licencePolicy], [G1, M1, 'asjp-academic-lane-v5', 2, 'permitted-only']);
  assert.equal(rec.cards[0].passages[0].sourceCharStart, 700, 'exact source offsets persisted');
  // union: 10..79 and 50..119 overlap on 50..79 -> 110 distinct words, never 140
  assert.deepEqual(payload.unifiedSimilarity.matchedPositions, range(10, 119));
  assert.equal(payload.unifiedSimilarity.asjpPublicationOnlyWords, 110);
  // cards: from the FINAL score's contributions + the record's metadata
  const cards = payload.evidenceInterpretation.sources.filter((s) => s.asjp);
  assert.equal(cards.length, 2);
  const shared = cards.find((c) => c.link === 'https://asjp.cerist.dz/en/article/202');
  assert.equal(shared.asjp.attribution, 'SHARED_TEXT_ORIGIN_NOT_ESTABLISHED'); assert.equal(shared.doi, '10.1000/202'); assert.equal(shared.year, 2021); assert.equal(shared.asjp.sharedWords, 70);
  assert.match(shared.interpretation.reasons[0], /original source is not established/);
  assert.equal(payload.evidenceInterpretation.matchedWordCount, 110, 'the explanation reconciles with the score');
  // outbound: no record (pins, offsets, research), only the check status
  const out = await getPayload(acc, 'asjp-on-1');
  assert.equal(out.asjpEvidence, undefined); assert.deepEqual(out.asjpCheck, { status: 'INCLUDED', sources: 2 });
  assert.ok(!JSON.stringify(out).includes('UNSCORED_RESEARCH_SIGNAL'), 'the research signal never reaches an ordinary client');
  const vm = buildReportV2ViewModel(out);
  assert.deepEqual(vm.sources.filter((s) => s.asjp).map((s) => s.asjp.label).sort(), ['Published article', 'Shared text — original source not established']);
  assert.equal(vm.asjpUnavailableNotice, null);
});

test('resave of the same manuscript: never re-queried, a client-forged record or check is dropped, score unchanged', async () => {
  setAsjp(true); stub.mode = 'accept';
  const acc = await account();
  await post(acc, 'asjp-resave-1', manuscript(0));
  const before = await row(acc, 'asjp-resave-1'); const calls = stub.calls;
  const forged = { ...before.payload.asjpEvidence, cards: [card(999, 0, 299)] };
  await post(acc, 'asjp-resave-1', manuscript(0), { payloadOverrides: { asjpEvidence: forged, asjpCheck: { status: 'INCLUDED', sources: 9 } } });
  const after = await row(acc, 'asjp-resave-1');
  assert.equal(stub.calls, calls, 'no second service call');
  assert.deepEqual(after.payload.asjpEvidence, before.payload.asjpEvidence, 'the persisted record is carried forward unchanged');
  assert.deepEqual(after.payload.unifiedSimilarity.matchedPositions, before.payload.unifiedSimilarity.matchedPositions);
  assert.equal(after.payload.asjpCheck, undefined);
});

test('a new service generation / flag off never changes a saved report; recomputes are deterministic', async () => {
  setAsjp(true); stub.mode = 'accept';
  const acc = await account();
  await post(acc, 'asjp-pin-1', manuscript(0));
  const saved = (await row(acc, 'asjp-pin-1')).payload;
  stub.mode = 'gen2'; // the service now serves another generation
  await post(acc, 'asjp-pin-1', manuscript(0)); // resave
  setAsjp(false); // and ASJP is switched off
  const results = [];
  for (let k = 0; k < 3; k += 1) {
    const healed = await selfHealUnifiedSimilarity(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-pin-1', accountId: acc.userId });
    assert.equal(healed.outcome, 'resolved');
    results.push(JSON.stringify(healed.unifiedSimilarity.matchedPositions));
  }
  const now = (await row(acc, 'asjp-pin-1')).payload;
  assert.deepEqual(now.asjpEvidence, saved.asjpEvidence, 'record unchanged (pins still G1)');
  assert.equal(new Set(results).size, 1, 'identical across recomputes');
  assert.equal(results[0], JSON.stringify(saved.unifiedSimilarity.matchedPositions), 'equal to the saved score');
  // rollback reference: the same report computed WITHOUT the record (an older build) is the pre-ASJP union
  const withoutRecord = await resolvePrimarySimilaritySummary(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-pin-1', accountId: acc.userId, rawText: now.text, wordCount: now.wordCount, archiveMatchedPositions: [], scoringNormalizationVersion: 2, archiveScore: 0 });
  assert.deepEqual(withoutRecord.unifiedSimilarity.matchedPositions, []);
  assert.equal(withoutRecord.unifiedSimilarity.asjpPublicationOnlyWords, undefined);
});

test('UNAVAILABLE at upload: saved without ASJP + notice; retry lands record, score and explanation atomically, once', async () => {
  setAsjp(true); stub.mode = 'busy';
  const acc = await account();
  await post(acc, 'asjp-retry-1', manuscript(0));
  let p = (await row(acc, 'asjp-retry-1')).payload;
  assert.equal(p.asjpEvidence.status, 'UNAVAILABLE'); assert.equal(p.asjpEvidence.reason, 'ASJP_BUSY');
  assert.deepEqual(p.unifiedSimilarity.matchedPositions, []);
  const out = await getPayload(acc, 'asjp-retry-1');
  assert.deepEqual(out.asjpCheck, { status: 'UNAVAILABLE', sources: 0 });
  assert.equal(buildReportV2ViewModel(out).asjpUnavailableNotice, ASJP_UNAVAILABLE_NOTICE);
  // still down: only the attempt count moves
  let r = await retryAsjpEvidenceForReport(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-retry-1', accountId: acc.userId });
  assert.equal(r.outcome, 'STILL_UNAVAILABLE'); assert.equal(r.attempts, 1);
  stub.mode = 'accept';
  r = await retryAsjpEvidenceForReport(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-retry-1', accountId: acc.userId });
  assert.deepEqual(r, { outcome: 'ACCEPTED', scoreWritten: true });
  p = (await row(acc, 'asjp-retry-1')).payload;
  assert.equal(p.asjpEvidence.status, 'ACCEPTED');
  assert.deepEqual(p.unifiedSimilarity.matchedPositions, range(10, 119));
  assert.equal(p.evidenceInterpretation.matchedWordCount, 110, 'explanation landed with the score');
  assert.equal(p.evidenceInterpretation.sources.filter((s) => s.asjp).length, 2);
  r = await retryAsjpEvidenceForReport(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-retry-1', accountId: acc.userId });
  assert.deepEqual(r, { outcome: 'NOT_ELIGIBLE', reason: 'ALREADY_ACCEPTED' }, 'an accepted record is final');
});

test('refused answers become UNAVAILABLE and never block the save: wrong generation, card/evidence mismatch, dropped connection', async () => {
  setAsjp(true);
  const acc = await account();
  for (const [mode, reason] of [['gen2', 'GENERATION_MISMATCH'], ['mismatch', 'EVIDENCE_CARD_MISMATCH'], ['drop', 'SERVICE_UNREACHABLE']]) {
    stub.mode = mode;
    await post(acc, `asjp-refused-${mode}`, manuscript(0));
    const p = (await row(acc, `asjp-refused-${mode}`)).payload;
    assert.equal(p.asjpEvidence.status, 'UNAVAILABLE', mode); assert.equal(p.asjpEvidence.reason, reason, mode);
    assert.deepEqual(p.unifiedSimilarity.matchedPositions, [], `${mode}: scored without ASJP`);
  }
});

test('migration: legacy rows, unknown-schema records and v1 reports are never given ASJP evidence', async () => {
  setAsjp(true); stub.mode = 'accept';
  const acc = await account();
  // a v1 (unstamped) report: no query, no record
  const calls = stub.calls;
  await post(acc, 'asjp-v1-1', manuscript(0), { normalization: 1 });
  assert.equal(stub.calls, calls); assert.equal((await row(acc, 'asjp-v1-1')).payload.asjpEvidence, undefined);
  // an unknown record schema is not applied (and not an error)
  await post(acc, 'asjp-legacy-1', manuscript(0));
  const rec = (await row(acc, 'asjp-legacy-1')).payload.asjpEvidence;
  await client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.asjpEvidence', json(?)) WHERE device_key = ? AND id = ?", args: [JSON.stringify({ ...rec, schema: 'asjp-report-evidence-v0' }), acc.deviceKey, 'asjp-legacy-1'] });
  const healed = await selfHealUnifiedSimilarity(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-legacy-1', accountId: acc.userId });
  assert.deepEqual(healed.unifiedSimilarity.matchedPositions, []);
  assert.equal(asjpChannelOf({ ...rec, schema: 'asjp-report-evidence-v0' }, { wordCount: rec.wordCount, scoringNormalizationVersion: 2 }).reason, 'UNREADABLE_RECORD');
  // a record never applies to another manuscript (text digest) or word count
  assert.equal(asjpChannelOf(rec, { wordCount: rec.wordCount, scoringNormalizationVersion: 2, text: manuscript(1) }).reason, 'TEXT_MISMATCH');
  assert.equal(asjpChannelOf(rec, { wordCount: rec.wordCount + 1, scoringNormalizationVersion: 2 }).reason, 'WORD_COUNT_MISMATCH');
  assert.equal(asjpChannelOf(rec, { wordCount: rec.wordCount, scoringNormalizationVersion: 1 }).reason, 'REPORT_NOT_NORMALIZATION_2');
});

test('a changed manuscript under the same report id is re-checked (the old record never applies to new text)', async () => {
  setAsjp(true); stub.mode = 'accept';
  const acc = await account();
  await post(acc, 'asjp-changed-1', manuscript(0));
  const first = (await row(acc, 'asjp-changed-1')).payload.asjpEvidence; const calls = stub.calls;
  await post(acc, 'asjp-changed-1', manuscript(5));
  const second = (await row(acc, 'asjp-changed-1')).payload.asjpEvidence;
  assert.equal(stub.calls, calls + 1);
  assert.notEqual(second.textSha256, first.textSha256);
});
