import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import crypto from 'node:crypto';
import path from 'path';
import http from 'node:http';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { resolvePrimarySimilaritySummary, selfHealUnifiedSimilarity } from '../lib/report-primary-similarity.ts';
import { retryAsjpEvidenceForReport, retractAsjpEvidenceForReport } from '../lib/report-asjp-evidence.ts';
import { asjpChannelOf, asjpRecordDoesNotFit, signAsjpRecord, ASJP_REPORT_EVIDENCE_SCHEMA } from '../lib/asjp-report-evidence.ts';
import { buildReportV2ViewModel, ASJP_UNAVAILABLE_NOTICE, ASJP_DOES_NOT_FIT_NOTICE, ASJP_UNVERIFIED_NOTICE } from '../lib/report-v2-view.ts';
import { unifiedEvidenceSummary } from '../lib/report-types.ts';
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
const STUB_TOKEN = crypto.randomBytes(32).toString('hex');
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
  const cards = mode === 'own' ? [card(404, 0, 269, { attribution: 'PREVIOUSLY_PUBLISHED_WORK', relationship: 'SAME_WORK_PUBLISHED_VERSION', evidence: { documentShare: 0.9, titleMatch: true, authorNamesInByline: 1 } })]
    // B1 fixture: 50 cards with long titles (a large but valid record, < 256 KB)
    : mode === 'many' ? Array.from({ length: 50 }, (_, i) => card(1000 + i, i * 5, i * 5 + 4, { title: 'T'.repeat(1900) }))
    : [card(101, 10, 79), card(202, 50, 119, { attribution: 'SHARED_TEXT_ORIGIN_NOT_ESTABLISHED', labels: [{ kind: 'SHARED_ACADEMIC_TEXT', submittedWordStart: 50, submittedWordEnd: 119, words: 70, otherArticles: 1 }] })];
  const evidence = cards.map((c) => ({ sourceId: c.sourceId, matchedPassages: c.passages.map((p) => ({ submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, matchedWordCount: p.submittedWordEnd - p.submittedWordStart + 1 })) }));
  if (mode === 'mismatch') evidence[0].matchedPassages[0].submittedWordEnd = 90;
  if (mode === 'badurl') cards[0].url = 'javascript:alert(1)';
  if (mode === 'badlabel') cards[1].labels[0].kind = 'BOGUS';
  return {
    state: 'COMPLETE', failureCode: null, wordCount: n, creditedPositions: [], asjpPublicationEvidence: evidence, cards,
    generationId: mode === 'gen2' ? G2 : G1, logicalManifestSha256: M1, laneVersion: 'asjp-academic-lane-v5', licencePolicy: 'permitted-only', normalization: 2,
    catalogLoadedAt: '2026-10-15T00:00:00.000Z', catalogDigest: 'c'.repeat(64), features: { numericTables: false, shortSignal: true },
    research: { shortPassages: { scored: false, label: 'UNSCORED_RESEARCH_SIGNAL', passages: Array.from({ length: mode === 'bigresearch' ? 5000 : 1 }, () => ({ sourceId: 'asjp:303', band: '25-39', submittedWordStart: 200, submittedWordEnd: 229, sourceWordStart: 10, sourceWordEnd: 39, sourceCharStart: 50, sourceCharEnd: 260, title: 'x'.repeat(mode === 'bigresearch' ? 100 : 5), url: 'https://asjp.cerist.dz/en/article/303' })) } },
  };
};
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    stub.calls += 1;
    try { stub.lastBody = JSON.parse(body); } catch { stub.lastBody = null; }
    if (req.headers.authorization !== `Bearer ${STUB_TOKEN}`) { res.writeHead(401); return res.end('{}'); }
    if (stub.mode === 'drop') return req.socket.destroy();
    if (stub.mode === 'busy') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ state: 'BUSY', failureCode: 'ASJP_BUSY' })); }
    const { text } = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answerFor(wordsOf(text), stub.mode)));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ASJP_ENV = { ASJP_REPORT_EVIDENCE_ENABLED: 'true', ASJP_SERVICE_URL: `http://127.0.0.1:${server.address().port}`, ASJP_SERVICE_TOKEN: STUB_TOKEN, ASJP_PINNED_GENERATION_ID: G1, ASJP_PINNED_MANIFEST_SHA256: M1, ASJP_SERVICE_TIMEOUT_MS: '3000' };
// the signing key is server configuration, independent of the flag: records stay verifiable after ASJP is switched off
process.env.ASJP_EVIDENCE_SIGNING_KEY = 'k'.repeat(48);
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
  assert.equal(shared.asjp.label, 'SHARED_TEXT_ORIGIN_NOT_ESTABLISHED'); assert.equal(shared.doi, '10.1000/202'); assert.equal(shared.year, 2021); assert.equal(shared.asjp.sharedWords, 70);
  assert.match(shared.interpretation.reasons[0], /original source is not established/);
  assert.equal(payload.evidenceInterpretation.matchedWordCount, 110, 'the explanation reconciles with the score');
  // outbound: no record (pins, offsets, research), only the check status
  const out = await getPayload(acc, 'asjp-on-1');
  assert.equal(out.asjpEvidence, undefined); assert.deepEqual(out.asjpCheck, { status: 'INCLUDED', sources: 2 });
  assert.ok(!JSON.stringify(out).includes('UNSCORED_RESEARCH_SIGNAL'), 'the research signal never reaches an ordinary client');
  const vm = buildReportV2ViewModel(out);
  assert.deepEqual(vm.sources.filter((s) => s.asjp).map((s) => s.asjp.label).sort(), ['Published article (ASJP)', 'Shared text — original source not established']);
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
  assert.deepEqual(out.asjpCheck, { status: 'UNAVAILABLE', sources: 0, reason: 'ASJP_BUSY' });
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
  const binding = { reportDeviceKey: acc.deviceKey, reportId: 'asjp-legacy-1', accountId: acc.userId };
  assert.equal(asjpChannelOf(rec, { wordCount: rec.wordCount, scoringNormalizationVersion: 2, binding: { ...binding, reportId: 'another-report' } }).reason, 'UNVERIFIED_RECORD', 'a record never applies to another report');
  await client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.asjpEvidence', json(?)) WHERE device_key = ? AND id = ?", args: [JSON.stringify({ ...rec, schema: 'asjp-report-evidence-v0' }), acc.deviceKey, 'asjp-legacy-1'] });
  const healed = await selfHealUnifiedSimilarity(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-legacy-1', accountId: acc.userId });
  assert.deepEqual(healed.unifiedSimilarity.matchedPositions, []);
  assert.equal(asjpChannelOf({ ...rec, schema: 'asjp-report-evidence-v0' }, { wordCount: rec.wordCount, scoringNormalizationVersion: 2, binding }).reason, 'UNREADABLE_RECORD');
  // a record never applies to another manuscript (text digest) or word count
  assert.equal(asjpChannelOf(rec, { wordCount: rec.wordCount, scoringNormalizationVersion: 2, text: manuscript(1), binding }).reason, 'TEXT_MISMATCH');
  assert.equal(asjpChannelOf(rec, { wordCount: rec.wordCount + 1, scoringNormalizationVersion: 2, binding }).reason, 'WORD_COUNT_MISMATCH');
  assert.equal(asjpChannelOf(rec, { wordCount: rec.wordCount, scoringNormalizationVersion: 1, binding }).reason, 'REPORT_NOT_NORMALIZATION_2');
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

function plantedRecord(text) {
  const n = wordsOf(text); const a = answerFor(n, 'accept');
  return { schema: ASJP_REPORT_EVIDENCE_SCHEMA, status: 'ACCEPTED', reason: null, checkedAt: '2026-01-01T00:00:00.000Z', wordCount: n, textSha256: crypto.createHash('sha256').update(text).digest('hex'), pins: { generationId: G1, logicalManifestSha256: M1, catalogDigest: null, catalogLoadedAt: null, laneVersion: 'x', licencePolicy: 'permitted-only', normalization: 2, features: { numericTables: false, shortSignal: false } }, cards: a.cards, attempts: 0 };
}

test('review 1: a planted (unsigned) or forged record is never applied, carried forward or described to the client', async () => {
  setAsjp(false);
  const acc = await account();
  await post(acc, 'asjp-planted-1', manuscript(0));
  const forged = plantedRecord(manuscript(0));
  for (const record of [forged, { ...forged, signature: 'f'.repeat(64) }]) {
    await client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.asjpEvidence', json(?)) WHERE device_key = ? AND id = ?", args: [JSON.stringify(record), acc.deviceKey, 'asjp-planted-1'] });
    const healed = await selfHealUnifiedSimilarity(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-planted-1', accountId: acc.userId });
    assert.deepEqual(healed.unifiedSimilarity.matchedPositions, [], 'not applied');
  }
  const out = await getPayload(acc, 'asjp-planted-1');
  assert.equal(out.asjpEvidence, undefined);
  // A4: a record carrying a signature this server cannot verify is never described as included (this server has an
  // evidence key, so it says the record cannot be verified)
  assert.deepEqual(out.asjpCheck, { status: 'UNVERIFIED', sources: 0, reason: 'UNVERIFIED_RECORD' });
  setAsjp(true); stub.mode = 'accept'; const calls = stub.calls;
  assert.deepEqual((await getPayload(acc, 'asjp-planted-1')).asjpCheck, { status: 'UNVERIFIED', sources: 0, reason: 'UNVERIFIED_RECORD' }, 'never INCLUDED');
  // A5: a resave of the same manuscript asks nothing and keeps the stored report exactly as it was (the forged record
  // stays unapplied; it is neither trusted nor silently dropped)
  const before = (await row(acc, 'asjp-planted-1')).raw;
  await post(acc, 'asjp-planted-1', manuscript(0));
  assert.equal(stub.calls, calls);
  assert.equal((await row(acc, 'asjp-planted-1')).raw, before, 'the stored report is unchanged');
  assert.deepEqual((await row(acc, 'asjp-planted-1')).payload.unifiedSimilarity.matchedPositions, [], 'still not applied');
  // an UNSIGNED planted record is dropped on a same-manuscript resave (it never came from a server)
  await client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.asjpEvidence', json(?)) WHERE device_key = ? AND id = ?", args: [JSON.stringify(forged), acc.deviceKey, 'asjp-planted-1'] });
  await post(acc, 'asjp-planted-1', manuscript(0));
  assert.equal(stub.calls, calls); assert.equal((await row(acc, 'asjp-planted-1')).payload.asjpEvidence, undefined);
  // a record planted through the POST payload is replaced by the server record
  await post(acc, 'asjp-planted-2', manuscript(0), { payloadOverrides: { asjpEvidence: forged } });
  const p2 = (await row(acc, 'asjp-planted-2')).payload;
  assert.equal(p2.asjpEvidence.cards.length, 2); assert.equal(typeof p2.asjpEvidence.signature, 'string', 'the server record replaced it');
});

test('review 5: a report saved without ASJP never gains ASJP on a same-manuscript resave', async () => {
  setAsjp(false);
  const acc = await account();
  await post(acc, 'asjp-legacy-resave-1', manuscript(0));
  setAsjp(true); stub.mode = 'accept'; const calls = stub.calls;
  await post(acc, 'asjp-legacy-resave-1', manuscript(0));
  assert.equal(stub.calls, calls, 'no service call');
  const p = (await row(acc, 'asjp-legacy-resave-1')).payload;
  assert.equal(p.asjpEvidence, undefined); assert.deepEqual(p.unifiedSimilarity.matchedPositions, []);
});

test('review 7: retraction (kill switch / takedown) removes ASJP from score and explanation atomically; RETRACTED is final', async () => {
  setAsjp(true); stub.mode = 'accept';
  const acc = await account();
  await post(acc, 'asjp-retract-1', manuscript(0));
  const r = await retractAsjpEvidenceForReport(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-retract-1', accountId: acc.userId, reason: 'TAKEDOWN' });
  assert.deepEqual(r, { outcome: 'RETRACTED' });
  const p = (await row(acc, 'asjp-retract-1')).payload;
  assert.equal(p.asjpEvidence.status, 'RETRACTED'); assert.equal(p.asjpEvidence.reason, 'TAKEDOWN');
  assert.deepEqual(p.unifiedSimilarity.matchedPositions, []);
  assert.equal(p.evidenceInterpretation.sources.filter((s) => s.asjp).length, 0, 'no ASJP card left');
  // B3: the report says the articles were withdrawn (they are listed in the record and never credited again)
  const retractedOut = await getPayload(acc, 'asjp-retract-1');
  assert.deepEqual(retractedOut.asjpCheck, { status: 'WITHDRAWN', sources: 0, reason: 'TAKEDOWN', withdrawn: 2 });
  assert.match(buildReportV2ViewModel(retractedOut).asjpUnavailableNotice, /2 published articles were withdrawn/);
  assert.deepEqual(p.asjpEvidence.withdrawnSourceIds, ['asjp:101', 'asjp:202']);
  assert.equal((await retryAsjpEvidenceForReport(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-retract-1', accountId: acc.userId })).outcome, 'NOT_ELIGIBLE');
  const healed = await selfHealUnifiedSimilarity(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-retract-1', accountId: acc.userId });
  assert.deepEqual(healed.unifiedSimilarity.matchedPositions, [], 'a recompute keeps it retracted');
});

test('review 3: a self-heal that read the UNAVAILABLE record cannot overwrite a retry that landed meanwhile', async () => {
  setAsjp(true); stub.mode = 'busy';
  const acc = await account();
  await post(acc, 'asjp-race-1', manuscript(0));
  stub.mode = 'accept';
  const healed = await selfHealUnifiedSimilarity(client, {
    reportDeviceKey: acc.deviceKey, reportId: 'asjp-race-1', accountId: acc.userId,
    testOnlyBeforePersist: async () => {
      assert.equal((await retryAsjpEvidenceForReport(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-race-1', accountId: acc.userId })).outcome, 'ACCEPTED');
    },
  });
  assert.equal(healed.outcome, 'resolved'); assert.equal(healed.presentationResolved, false, 'the stale self-heal write did not land');
  const p = (await row(acc, 'asjp-race-1')).payload;
  assert.deepEqual(p.unifiedSimilarity.matchedPositions, range(10, 119), 'the retry result stands');
  assert.equal(p.evidenceInterpretation.matchedWordCount, 110);
});

test('review 2/4: Selective-owned reports and reports with supplied references are never retried', async () => {
  setAsjp(true); stub.mode = 'busy';
  const acc = await account();
  await post(acc, 'asjp-selective-1', manuscript(0));
  await client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.selectiveCorpusAuthoritativeStatus', 'pending') WHERE device_key = ? AND id = ?", args: [acc.deviceKey, 'asjp-selective-1'] });
  stub.mode = 'accept';
  assert.deepEqual(await retryAsjpEvidenceForReport(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-selective-1', accountId: acc.userId }), { outcome: 'NOT_ELIGIBLE', reason: 'SELECTIVE_CORPUS_OWNED' });
  stub.mode = 'busy';
  await post(acc, 'asjp-refs-1', manuscript(0));
  await client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.userSuppliedReferenceEvidence', json(?)) WHERE device_key = ? AND id = ?", args: [JSON.stringify([{ key: 'r1', admitted: true, verifiedPassages: [] }]), acc.deviceKey, 'asjp-refs-1'] });
  stub.mode = 'accept';
  assert.deepEqual(await retryAsjpEvidenceForReport(client, { reportDeviceKey: acc.deviceKey, reportId: 'asjp-refs-1', accountId: acc.userId }), { outcome: 'NOT_ELIGIBLE', reason: 'HAS_SUPPLIED_REFERENCES' });
});

test('review 6/8/12: unsafe card content refused; research signal capped; misconfiguration recorded', async () => {
  setAsjp(true);
  const acc = await account();
  for (const mode of ['badurl', 'badlabel']) {
    stub.mode = mode; await post(acc, `asjp-strict-${mode}`, manuscript(0));
    const p = (await row(acc, `asjp-strict-${mode}`)).payload;
    assert.equal(p.asjpEvidence.status, 'UNAVAILABLE', mode); assert.equal(p.asjpEvidence.reason, 'MALFORMED_EVIDENCE', mode);
  }
  stub.mode = 'bigresearch'; await post(acc, 'asjp-big-1', manuscript(0));
  const big = (await row(acc, 'asjp-big-1')).payload.asjpEvidence;
  assert.equal(big.status, 'ACCEPTED'); assert.equal(big.research.shortPassages.passages.length, 100); assert.equal(big.research.shortPassages.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(big)) < 256 * 1024);
  const key = process.env.ASJP_EVIDENCE_SIGNING_KEY; delete process.env.ASJP_EVIDENCE_SIGNING_KEY;
  try {
    stub.mode = 'accept'; const calls = stub.calls;
    await post(acc, 'asjp-misconfigured-1', manuscript(0));
    const p = (await row(acc, 'asjp-misconfigured-1')).payload;
    assert.equal(stub.calls, calls); assert.equal(p.asjpEvidence.reason, 'CLIENT_MISCONFIGURED'); assert.deepEqual(p.unifiedSimilarity.matchedPositions, []);
    // A6: the misconfiguration is visible to the user (this server's own unsigned marker, while it has no key)
    assert.deepEqual((await getPayload(acc, 'asjp-misconfigured-1')).asjpCheck, { status: 'UNAVAILABLE', sources: 0, reason: 'CLIENT_MISCONFIGURED' });
  } finally { process.env.ASJP_EVIDENCE_SIGNING_KEY = key; }
  // once the key is back, an unsigned marker is not described (it could have been planted)
  assert.equal((await getPayload(acc, 'asjp-misconfigured-1')).asjpCheck, undefined);
});

test('Phase 7 C: a signed record cannot be substituted into another user\'s report, replayed into another report, or read by a client', async () => {
  setAsjp(true); stub.mode = 'accept';
  const alice = await account(), bob = await account();
  await post(alice, 'asjp-owner-a', manuscript(0));
  setAsjp(false);
  await post(bob, 'asjp-owner-b', manuscript(0)); // same manuscript, saved without ASJP
  await post(alice, 'asjp-owner-a2', manuscript(0)); // alice's second report, same manuscript, no ASJP
  const signed = (await row(alice, 'asjp-owner-a')).payload.asjpEvidence;
  assert.equal(typeof signed.signature, 'string');
  // substitute alice's signed record into bob's report (another owner) and into alice's other report (replay)
  for (const [acc, id] of [[bob, 'asjp-owner-b'], [alice, 'asjp-owner-a2']]) {
    await client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.asjpEvidence', json(?)) WHERE device_key = ? AND id = ?", args: [JSON.stringify(signed), acc.deviceKey, id] });
    const healed = await selfHealUnifiedSimilarity(client, { reportDeviceKey: acc.deviceKey, reportId: id, accountId: acc.userId });
    assert.deepEqual(healed.unifiedSimilarity.matchedPositions, [], `${id}: not applied`);
    const out = await getPayload(acc, id);
    assert.equal(out.asjpEvidence, undefined);
  }
  // the owner itself: applied; the owner's reload never exposes the signature, pins or offsets
  const healedA = await selfHealUnifiedSimilarity(client, { reportDeviceKey: alice.deviceKey, reportId: 'asjp-owner-a', accountId: alice.userId });
  assert.deepEqual(healedA.unifiedSimilarity.matchedPositions, range(10, 119));
  const body = JSON.stringify(await getPayload(alice, 'asjp-owner-a'));
  for (const secret of [signed.signature, signed.textSha256, G1, '"sourceCharStart"']) assert.ok(!body.includes(secret), `outbound copy never contains ${secret.slice(0, 20)}`);
  // even with the owner claimed by the caller, a mismatching account fails verification (the binding is the row's owner)
  const wrongOwner = await resolvePrimarySimilaritySummary(client, { reportDeviceKey: alice.deviceKey, reportId: 'asjp-owner-a', accountId: bob.userId, rawText: manuscript(0), wordCount: wordsOf(manuscript(0)), archiveMatchedPositions: [], scoringNormalizationVersion: 2, archiveScore: 0, asjpReportEvidence: signed });
  assert.equal(wrongOwner.unifiedSimilarity.asjpPublicationOnlyWords, undefined);
});

test('Phase 7 decision 3: cards state only facts — no claimed relationship, observations as notes', async () => {
  setAsjp(true); stub.mode = 'own';
  const acc = await account();
  await post(acc, 'asjp-facts-1', manuscript(0));
  const p = (await row(acc, 'asjp-facts-1')).payload;
  const card = p.evidenceInterpretation.sources.find((s) => s.asjp);
  assert.equal(card.asjp.label, 'PUBLISHED_ARTICLE');
  assert.ok(card.asjp.notes.some((n) => /contains \d+% of your document's words/.test(n)));
  assert.ok(card.asjp.notes.some((n) => /title closely matches/.test(n)));
  assert.ok(card.asjp.notes.some((n) => /author name listed for this article appears/.test(n)));
  const text = JSON.stringify(card) + JSON.stringify(buildReportV2ViewModel(await getPayload(acc, 'asjp-facts-1')).sources);
  for (const claim of [/published version of this manuscript/i, /same authors/i, /your own/i, /previously published/i]) assert.ok(!claim.test(text), `no claimed relationship: ${claim}`);
});

// ───────────────────────── Phase 7 security review remediation (route level) ─────────────────────────
async function postStatus(acc, id, text, payloadOverrides = {}) {
  await resetRateForTest(`${acc.tag}-post`);
  const wordCount = wordsOf(text);
  if (!acc.rooms.has(id)) acc.rooms.set(id, acc.rooms.size);
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${acc.tag}-post`, cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({ deviceKey: acc.deviceKey, id, submissionId: `sub-${id}`, title: 'ASJP fixture', createdAt: new Date().toISOString(), wordCount, archiveScore: 0, scoreBand: 'Low', aiScore: null, aiTone: null, aiStatus: null, room: acc.rooms.get(id), scoringNormalization: 2, payload: { version: 11, id, submissionId: `sub-${id}`, title: 'ASJP fixture', author: '', assignment: '', created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount, scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [], text, ...payloadOverrides } }),
  }));
  return res.status;
}
const asjpPositionsOf = (record) => [...new Set((record?.cards ?? []).filter((c) => c.scored).flatMap((c) => c.passages.flatMap((p) => range(p.submittedWordStart, p.submittedWordEnd))))].sort((a, b) => a - b);

test('B1: ASJP never makes a save fail — below / at / above the persisted ceiling; the ASJP contribution is left out whole, never truncated', async () => {
  const acc = await account();
  const text = manuscript(0);
  // every probe and case is a FIRST save of the same report id (same payload shape apart from the padding and ASJP)
  const id = 'b1-report';
  const firstSave = async (padding) => { await client.execute({ sql: 'DELETE FROM saved_reports WHERE device_key = ? AND id = ?', args: [acc.deviceKey, id] }); return postStatus(acc, id, text, { padding: 'p'.repeat(padding) }); };
  // the exact ceiling for THIS report: the largest padding that saves with ASJP OFF (binary search)
  setAsjp(false);
  let lo = 1_000_000, hi = 2_100_000;
  assert.equal(await firstSave(lo), 200);
  assert.equal(await firstSave(hi), 413);
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await firstSave(mid) === 200) lo = mid; else hi = mid; }
  const atCeiling = lo;
  setAsjp(true); stub.mode = 'many';
  const cases = [
    ['well-below', atCeiling - 400_000, 'ACCEPTED'],
    ['just-below', atCeiling - 5_000, 'RECORD_DOES_NOT_FIT'],
    ['at-ceiling', atCeiling, 'NO_RECORD'],
  ];
  for (const [name, padding, expected] of cases) {
    assert.equal(await firstSave(padding), 200, `${name}: the save succeeds`);
    const { raw, payload } = await row(acc, id);
    const rec = payload.asjpEvidence;
    if (expected === 'ACCEPTED') {
      assert.equal(rec.status, 'ACCEPTED', name); assert.equal(rec.cards.length, 50);
      assert.deepEqual(payload.unifiedSimilarity.asjpPublicationPositions, asjpPositionsOf(rec), `${name}: the score holds exactly the record's words`);
    } else if (expected === 'RECORD_DOES_NOT_FIT') {
      assert.equal(rec.status, 'UNAVAILABLE', name); assert.equal(rec.reason, 'RECORD_DOES_NOT_FIT'); assert.deepEqual(rec.cards, [], 'no partial cards');
      assert.equal(typeof rec.signature, 'string', 'the marker is signed');
      assert.equal(payload.unifiedSimilarity.asjpPublicationOnlyWords, undefined, `${name}: no ASJP word in the score`);
      assert.equal(payload.evidenceInterpretation.sources.filter((s) => s.asjp).length, 0, 'no ASJP card');
      const out = await getPayload(acc, id);
      assert.deepEqual(out.asjpCheck, { status: 'UNAVAILABLE', sources: 0, reason: 'RECORD_DOES_NOT_FIT' });
      assert.equal(buildReportV2ViewModel(out).asjpUnavailableNotice, ASJP_DOES_NOT_FIT_NOTICE);
    } else {
      assert.equal(rec, undefined, `${name}: even the marker does not fit — saved exactly as with ASJP off`);
      assert.equal(payload.unifiedSimilarity.asjpPublicationOnlyWords, undefined);
    }
    assert.ok(raw.length <= 2_000_000, `${name}: persisted within the ceiling (${raw.length})`);
  }
  // above the ceiling: refused with or without ASJP (ASJP never decides it)
  assert.equal(await firstSave(atCeiling + 1), 413);
  setAsjp(false); assert.equal(await firstSave(atCeiling + 1), 413);
  stub.mode = 'accept';
});

test('A5: key versions — a rotation keeps every saved report verifiable; a lost or changed key never silently drops ASJP (stored report kept, UNVERIFIED shown)', async () => {
  const K1 = process.env.ASJP_EVIDENCE_SIGNING_KEY, K2 = 'r'.repeat(20) + crypto.randomBytes(16).toString('hex');
  setAsjp(true); stub.mode = 'accept';
  const acc = await account();
  await post(acc, 'a5-1', manuscript(0));
  const saved = await row(acc, 'a5-1');
  assert.equal(saved.payload.asjpEvidence.keyId, 'k1');
  const score = saved.payload.unifiedSimilarity.unifiedScore;
  assert.ok(score > 0);
  try {
    // (1) planned rotation: new key k2, k1 kept for verification only -> a same-manuscript resave keeps everything
    process.env.ASJP_EVIDENCE_SIGNING_KEY = K2; process.env.ASJP_EVIDENCE_SIGNING_KEY_ID = 'k2'; process.env.ASJP_EVIDENCE_VERIFY_KEYS = JSON.stringify({ k1: K1 });
    let calls = stub.calls;
    await post(acc, 'a5-1', manuscript(0));
    assert.equal(stub.calls, calls, 'never re-queried');
    let p = (await row(acc, 'a5-1')).payload;
    assert.equal(p.unifiedSimilarity.unifiedScore, score); assert.equal(p.asjpEvidence.keyId, 'k1');
    assert.deepEqual((await getPayload(acc, 'a5-1')).asjpCheck, { status: 'INCLUDED', sources: 2 });
    // a new report is signed with the new key
    await post(acc, 'a5-2', manuscript(0));
    assert.equal((await row(acc, 'a5-2')).payload.asjpEvidence.keyId, 'k2');
    // (2) the old key is LOST (not in the keyring): the same-manuscript resave keeps the stored report byte for byte
    delete process.env.ASJP_EVIDENCE_VERIFY_KEYS;
    const before = (await row(acc, 'a5-1')).raw; calls = stub.calls;
    await post(acc, 'a5-1', manuscript(0));
    assert.equal(stub.calls, calls);
    assert.equal((await row(acc, 'a5-1')).raw, before, 'score, cards and record preserved — never 23 % -> 0 %');
    let out = await getPayload(acc, 'a5-1');
    assert.deepEqual(out.asjpCheck, { status: 'UNVERIFIED', sources: 0, reason: 'KEY_UNAVAILABLE' });
    assert.equal(buildReportV2ViewModel(out).asjpUnavailableNotice, ASJP_UNVERIFIED_NOTICE);
    assert.equal(out.unifiedSimilarity.unifiedScore, score, 'the saved score is shown unchanged');
    // (3) the key VALUE changed under the same id (operator error): same protection
    process.env.ASJP_EVIDENCE_SIGNING_KEY = 's'.repeat(20) + crypto.randomBytes(16).toString('hex'); process.env.ASJP_EVIDENCE_SIGNING_KEY_ID = 'k1';
    await post(acc, 'a5-1', manuscript(0));
    assert.equal((await row(acc, 'a5-1')).raw, before);
    assert.equal((await getPayload(acc, 'a5-1')).asjpCheck.reason, 'UNVERIFIED_RECORD');
    // (4) restoring the key restores normal behaviour — nothing was lost
    process.env.ASJP_EVIDENCE_SIGNING_KEY = K1; process.env.ASJP_EVIDENCE_SIGNING_KEY_ID = 'k1';
    out = await getPayload(acc, 'a5-1');
    assert.deepEqual(out.asjpCheck, { status: 'INCLUDED', sources: 2 }); assert.equal(out.unifiedSimilarity.unifiedScore, score);
  } finally { process.env.ASJP_EVIDENCE_SIGNING_KEY = K1; delete process.env.ASJP_EVIDENCE_SIGNING_KEY_ID; delete process.env.ASJP_EVIDENCE_VERIFY_KEYS; }
});

test('B3: a withdrawn article is never credited again — edit, revert, per-article takedown, deployment takedown list', async () => {
  setAsjp(true); stub.mode = 'accept';
  const acc = await account();
  // whole-record retraction, then an EDIT and a REVERT: the service is asked to exclude the articles, and even a service
  // that ignores the exclusion (this stub) cannot get them credited
  await post(acc, 'b3-1', manuscript(0));
  assert.equal((await retractAsjpEvidenceForReport(client, { reportDeviceKey: acc.deviceKey, reportId: 'b3-1', accountId: acc.userId, reason: 'TAKEDOWN' })).outcome, 'RETRACTED');
  for (const text of [manuscript(0) + ' extra words', manuscript(0)]) {
    await post(acc, 'b3-1', text);
    const p = (await row(acc, 'b3-1')).payload;
    assert.deepEqual(stub.lastBody.excludeSourceIds, ['asjp:101', 'asjp:202'], 'the exclusion is sent to the service');
    assert.equal(p.asjpEvidence.status, 'ACCEPTED'); assert.deepEqual(p.asjpEvidence.cards, []);
    assert.deepEqual(p.asjpEvidence.withdrawnSourceIds, ['asjp:101', 'asjp:202'], 'the list is carried forward');
    assert.equal(p.unifiedSimilarity.asjpPublicationOnlyWords, undefined, 'no withdrawn word scored');
    assert.equal(p.evidenceInterpretation.sources.filter((s) => s.asjp).length, 0, 'no withdrawn card');
  }
  // per-article takedown: only asjp:202 goes; asjp:101 stays credited (its words exactly)
  await post(acc, 'b3-2', manuscript(0));
  assert.equal((await retractAsjpEvidenceForReport(client, { reportDeviceKey: acc.deviceKey, reportId: 'b3-2', accountId: acc.userId, reason: 'TAKEDOWN', sourceIds: ['asjp:202'] })).outcome, 'RETRACTED');
  let p = (await row(acc, 'b3-2')).payload;
  assert.deepEqual(p.asjpEvidence.cards.map((c) => c.sourceId), ['asjp:101']);
  assert.deepEqual(p.unifiedSimilarity.matchedPositions, range(10, 79), 'exactly the remaining article\'s words');
  const out = await getPayload(acc, 'b3-2');
  assert.deepEqual(out.asjpCheck, { status: 'INCLUDED', sources: 1, withdrawn: 1 });
  assert.match(buildReportV2ViewModel(out).asjpUnavailableNotice, /1 published article was withdrawn/);
  await post(acc, 'b3-2', manuscript(0) + ' edit');
  p = (await row(acc, 'b3-2')).payload;
  assert.deepEqual(p.asjpEvidence.cards.map((c) => c.sourceId), ['asjp:101'], 'still excluded after an edit');
  // deployment-wide takedown list: a NEW report never credits the listed article
  process.env.ASJP_WITHDRAWN_SOURCE_IDS = 'asjp:101';
  try {
    await post(acc, 'b3-3', manuscript(0));
    assert.deepEqual(stub.lastBody.excludeSourceIds, ['asjp:101']);
    assert.deepEqual((await row(acc, 'b3-3')).payload.asjpEvidence.cards.map((c) => c.sourceId), ['asjp:202']);
  } finally { delete process.env.ASJP_WITHDRAWN_SOURCE_IDS; }
});

test('B2: the receipt agrees with the score and the cards — ASJP-only, ASJP overlapping another channel, no ASJP', async () => {
  setAsjp(true); stub.mode = 'accept';
  const acc = await account();
  await post(acc, 'b2-1', manuscript(0));
  const u = (await getPayload(acc, 'b2-1')).unifiedSimilarity;
  assert.ok(u.unifiedScore > 0); assert.ok(u.asjpPublicationOnlyWords > 0);
  assert.equal(unifiedEvidenceSummary(u), 'published articles (ASJP)', 'never "no matched sources" next to an ASJP score');
  // every ASJP word also matched by the archive: still named (the ASJP cards are shown too)
  await post(acc, 'b2-2', manuscript(0), { payloadOverrides: { archiveMatchedPositions: range(10, 119) } });
  const u2 = (await getPayload(acc, 'b2-2')).unifiedSimilarity;
  assert.equal(u2.asjpPublicationOnlyWords, 0);
  assert.equal(unifiedEvidenceSummary(u2), 'own reference material, published articles (ASJP)');
  setAsjp(false);
  await post(acc, 'b2-3', manuscript(0));
  assert.equal(unifiedEvidenceSummary((await getPayload(acc, 'b2-3')).unifiedSimilarity), 'no matched sources', 'unchanged without ASJP');
});

test('A7: a self-heal binds the record to the ROW\'s owner — a caller passing another account cannot drop the evidence', async () => {
  setAsjp(true); stub.mode = 'accept';
  const alice = await account(), bob = await account();
  await post(alice, 'a7-1', manuscript(0));
  const healed = await selfHealUnifiedSimilarity(client, { reportDeviceKey: alice.deviceKey, reportId: 'a7-1', accountId: bob.userId });
  assert.deepEqual(healed.unifiedSimilarity.matchedPositions, range(10, 119), 'still applied: the row owner is alice');
});

test('A1 at the report path: an expired tunnel URL held by someone else gets neither manuscript nor token; the save completes with the notice', async () => {
  const seen = [];
  const impostor = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { seen.push({ path: req.url, auth: req.headers.authorization ?? null, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...answerFor(wordsOf(manuscript(0)), 'accept') })); }); });
  await new Promise((r) => impostor.listen(0, '127.0.0.1', r));
  setAsjp(true);
  const savedUrl = process.env.ASJP_SERVICE_URL;
  process.env.ASJP_SERVICE_URL = `http://127.0.0.1:${impostor.address().port}`;
  process.env.ASJP_SERVICE_REQUEST_SIGNING_KEY = crypto.randomBytes(32).toString('hex');
  try {
    const acc = await account();
    await post(acc, 'a1-expired-1', manuscript(0));
    const p = (await row(acc, 'a1-expired-1')).payload;
    assert.equal(p.asjpEvidence.status, 'UNAVAILABLE'); assert.equal(p.asjpEvidence.reason, 'SERVICE_NOT_AUTHENTICATED');
    assert.equal(p.unifiedSimilarity.asjpPublicationOnlyWords, undefined, 'its "answer" is never scored');
    assert.deepEqual(seen.map((s) => s.path), ['/attest']);
    assert.ok(seen.every((s) => s.auth === null && !s.body.includes(WORDS[0])), 'no bearer token, no manuscript');
    assert.equal(buildReportV2ViewModel(await getPayload(acc, 'a1-expired-1')).asjpUnavailableNotice, ASJP_UNAVAILABLE_NOTICE);
  } finally { process.env.ASJP_SERVICE_URL = savedUrl; delete process.env.ASJP_SERVICE_REQUEST_SIGNING_KEY; impostor.close(); }
});

test('re-review N1: with ASJP OFF a planted signed-looking record never freezes a report — the resave recomputes exactly as Production does', async () => {
  const key = process.env.ASJP_EVIDENCE_SIGNING_KEY;
  for (const [label, withKey] of [['key configured', true], ['no key (Production today)', false]]) {
    setAsjp(false);
    if (!withKey) delete process.env.ASJP_EVIDENCE_SIGNING_KEY;
    try {
      const acc = await account();
      const id = `n1-${withKey ? 'k' : 'nk'}`;
      await post(acc, id, manuscript(0));
      await client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.asjpEvidence', json(?)) WHERE device_key = ? AND id = ?", args: [JSON.stringify({ ...plantedRecord(manuscript(0)), signature: 'f'.repeat(64) }), acc.deviceKey, id] });
      await post(acc, id, manuscript(0), { payloadOverrides: { archiveMatchedPositions: range(0, 149) } });
      const p = (await row(acc, id)).payload;
      assert.equal(p.asjpEvidence, undefined, `${label}: the planted key is dropped`);
      assert.deepEqual(p.unifiedSimilarity.matchedPositions, range(0, 149), `${label}: the resave's new score lands`);
    } finally { process.env.ASJP_EVIDENCE_SIGNING_KEY = key; }
  }
});

test('re-review N3: the size fallback never turns an unverified record into a server-signed marker', () => {
  const binding = { reportDeviceKey: 'd', reportId: 'r', accountId: 'u' };
  const planted = { ...plantedRecord(manuscript(0)), withdrawnSourceIds: ['asjp:101'], signature: 'f'.repeat(64) };
  assert.equal(asjpRecordDoesNotFit(planted, binding), null, 'unverified: left out, never re-signed');
  const genuine = signAsjpRecord(plantedRecord(manuscript(0)), binding);
  assert.equal(asjpRecordDoesNotFit(genuine, binding).reason, 'RECORD_DOES_NOT_FIT', 'a verified record becomes the signed marker');
});

test('concurrent outages: many simultaneous first saves while the service drops connections all complete, each with the notice and no ASJP', async () => {
  setAsjp(true); stub.mode = 'drop';
  const acc = await account();
  const ids = Array.from({ length: 6 }, (_, i) => `outage-${i}`);
  for (const id of ids) acc.rooms.set(id, acc.rooms.size);
  const statuses = await Promise.all(ids.map((id, i) => postStatus(acc, id, manuscript(i))));
  assert.deepEqual(statuses, ids.map(() => 200));
  for (const id of ids) {
    const p = (await row(acc, id)).payload;
    assert.equal(p.asjpEvidence.status, 'UNAVAILABLE'); assert.equal(p.unifiedSimilarity.asjpPublicationOnlyWords, undefined);
  }
  stub.mode = 'accept';
});
