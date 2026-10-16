import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { createSession, SESSION_COOKIE_NAME } from '../lib/auth-session.ts';
import { resetAdminRateForTest } from '../lib/rate-limit.js';
import { asjpEvidenceRecordFromAnswer, signAsjpRecord } from '../lib/asjp-report-evidence.ts';
import { ASJP_SIXWORD_CONTRACT_VERSION, ASJP_SIXWORD_OVERLAP_LABEL } from '../lib/asjp-sixword-contract.ts';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import * as route from '../app/api/admin/reports/[id]/asjp-sixword/route.ts';

/**
 * Developer six-word route, end to end on a real migrated database and a stub /sixword service: authorization and
 * same-origin; flag off = route absent and nothing written; the saved report row (payload, score, word count) is
 * never written; exact positions; labels for multiple holders / origin not established; a stopped or failed search is
 * never "zero matches"; generation pins; signed, owner-bound records (cross-user isolation); retraction; deletion.
 */
const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_asjp_sixword_report_route.db');
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* none */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, path.join(repo, 'drizzle'));
test.after(() => { client.close(); server.close(); if (process.env.KEEP_DB) return; for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* none */ } } });

const G1 = 'gen-p7-fixture-1', M1 = 'b'.repeat(64);
const KEY = crypto.randomBytes(24).toString('hex');
const SVC_TOKEN = crypto.randomBytes(24).toString('hex');
// ---- stub /sixword service ----
const stub = { mode: 'complete', last: null };
const block = (wordCount, extra = {}) => ({
  contract: ASJP_SIXWORD_CONTRACT_VERSION, state: 'COMPLETE', reason: null, scored: false, label: ASJP_SIXWORD_OVERLAP_LABEL,
  pins: { contract: ASJP_SIXWORD_CONTRACT_VERSION, evidenceVersion: 'asjp-sixword-evidence-v1', indexFormat: 'asjp-sixword-index-v1', indexPostingsSha256: 'c'.repeat(64), tokenStoreSha256: 'd'.repeat(64), generationId: G1, logicalManifestSha256: M1, normalization: 2, catalogDigest: 'e'.repeat(64), licencePolicy: 'local-research-all', referenceDate: stub.last?.referenceDate ?? null },
  wordCount, summary: { matches: 2, unique: 1, shared: 1, common: 0, withoutEligibleHolder: 0, wordsInAnyMatch: 16, wordsInEligibleMatch: 16, wordsAlreadyCreditedByLane: 0, runs: 3 },
  matches: [
    { submittedWordStart: 10, submittedWordEnd: 17, words: 8, band: '6-9', scored: false, originEstablished: false, commonness: 'UNIQUE', holdersInIndex: 1, eligibleHolders: 1, holders: [{ sourceId: 'asjp:501', sourceWordStart: 40, sourceWordEnd: 47, sourceCharStart: 300, sourceCharEnd: 350, occurrences: 1 }], holdersOmitted: 0, ineligibleHolders: {}, wordsAlreadyCreditedByLane: 0, labels: { form: null, legal: false, religious: false } },
    { submittedWordStart: 30, submittedWordEnd: 37, words: 8, band: '6-9', scored: false, originEstablished: false, commonness: 'SHARED', holdersInIndex: 3, eligibleHolders: 2, holders: [{ sourceId: 'asjp:502', sourceWordStart: 5, sourceWordEnd: 12, sourceCharStart: null, sourceCharEnd: null, occurrences: 1 }, { sourceId: 'asjp:503', sourceWordStart: 9, sourceWordEnd: 16, sourceCharStart: 60, sourceCharEnd: 110, occurrences: 1 }], holdersOmitted: 0, ineligibleHolders: { PUBLISHED_AFTER_REFERENCE_DATE: 1 }, wordsAlreadyCreditedByLane: 0, labels: { form: null, legal: false, religious: false } },
  ],
  sources: Object.fromEntries([501, 502, 503].map((id) => [`asjp:${id}`, { sourceId: `asjp:${id}`, articleId: String(id), title: `Article ${id}`, journal: 'J', publicationDate: '2020-01-01', canonicalUrl: `https://asjp.cerist.dz/en/article/${id}` }])),
  truncation: { matchesOmitted: 0, commonOmitted: 0, matchesWithHoldersOmitted: 0, holdersWithoutCharOffsets: 1 }, timings: { findMs: 1, evidenceMs: 1, gatesMs: 0, offsetsMs: 1, totalMs: 3 }, ...extra,
});
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const body = JSON.parse(raw || '{}'); stub.last = body;
    const n = tokensForScoringNormalization(body.text ?? '', 2).length;
    const send = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url !== '/sixword' || req.headers.authorization !== `Bearer ${SVC_TOKEN}`) return send(404, { error: 'not found' });
    if (stub.mode === 'complete') return send(200, block(n));
    if (stub.mode === 'budget') return send(200, { ...block(n), state: 'INCOMPLETE_BUDGET', reason: 'TIME_BUDGET', summary: null, matches: [], sources: {}, timings: null });
    if (stub.mode === 'busy') return send(503, { state: 'BUSY', failureCode: 'ASJP_BUSY' });
    if (stub.mode === 'forged') return send(200, { ...block(n), matches: block(n).matches.map((m) => ({ ...m, scored: true })) });
    if (stub.mode === 'gen2') return send(200, { ...block(n), pins: { ...block(n).pins, generationId: 'gen-other' } });
    send(500, { error: 'internal error' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = { ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED: 'true', ASJP_EVIDENCE_SIGNING_KEY: KEY, ASJP_REPORT_EVIDENCE_ENABLED: 'true', ASJP_SERVICE_URL: `http://127.0.0.1:${server.address().port}`, ASJP_SERVICE_TOKEN: SVC_TOKEN, ASJP_PINNED_GENERATION_ID: G1, ASJP_PINNED_MANIFEST_SHA256: M1, ASJP_ALLOW_LOCAL_RESEARCH_POLICY: 'true' };
Object.assign(process.env, env);

// ---- users, sessions, saved reports ----
let ip = 0;
async function user(role) {
  const id = `sixword-${role}-${++ip}`;
  await client.execute({ sql: 'INSERT INTO users (id, email, username, password_hash, role) VALUES (?,?,?,?,?)', args: [id, `${id}@example.test`, id, 'not-a-real-hash', role] });
  return { id, token: await createSession(client, id) };
}
const WORDS = Array.from({ length: 400 }, (_, k) => `w${k.toString(36)}x`);
const TEXT = WORDS.join(' ');
async function seedReport({ deviceKey, reportId, owner, withAsjp = true }) {
  const binding = { reportDeviceKey: deviceKey, reportId, accountId: owner };
  const card = { kind: 'asjp_publication', sourceId: 'asjp:777', title: 'Scored article', journal: 'J', publicationDate: '2020-01-01', doi: null, url: 'https://asjp.cerist.dz/en/article/777', authors: ['A'], license: 'CC BY 4.0', licenceStatus: 'PERMITTED', relationship: 'INDEPENDENT_PUBLICATION', attribution: 'PUBLISHED_SOURCE', scored: true, matchedWordCount: 61, admittedBy: 'VERIFIER', passages: [{ submittedWordStart: 100, submittedWordEnd: 160, sourceWordStart: 1, sourceWordEnd: 61, sourceCharStart: 10, sourceCharEnd: 500 }], labels: [] };
  const answer = { state: 'COMPLETE', failureCode: null, wordCount: 400, creditedPositions: [], asjpPublicationEvidence: [{ sourceId: 'asjp:777', matchedPassages: [{ submittedWordStart: 100, submittedWordEnd: 160, matchedWordCount: 61 }] }], cards: [card], generationId: G1, logicalManifestSha256: M1, laneVersion: 'asjp-academic-lane-v5', licencePolicy: 'local-research-all', normalization: 2, catalogDigest: 'e'.repeat(64), catalogLoadedAt: '2026-01-01T00:00:00Z', features: { numericTables: false, shortSignal: false } };
  const record = asjpEvidenceRecordFromAnswer(answer, { generationId: G1, logicalManifestSha256: M1, wordCount: 400, text: TEXT, allowLocalResearchPolicy: true }, true);
  assert.equal(record.status, 'ACCEPTED');
  const payload = { version: 11, id: 1, submissionId: `sub-${reportId}`, title: 't.pdf', text: TEXT, wordCount: 400, score: 15, archiveScore: 15, sources: [], repeats: [], ...(withAsjp ? { asjpEvidence: signAsjpRecord(record, binding, KEY) } : {}) };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, `sub-${reportId}`, 't.pdf', '2025-03-14T10:00:00.000Z', 400, 15, 'Low', JSON.stringify(payload), owner],
  });
}
const rowOf = async (deviceKey, id) => (await client.execute({ sql: 'SELECT payload_json, archive_score, word_count, score_band, updated_at, user_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, id] })).rows[0];
const recordRow = async (deviceKey, id) => (await client.execute({ sql: 'SELECT record_json FROM asjp_sixword_overlap_records WHERE device_key = ? AND report_id = ?', args: [deviceKey, id] }).catch(() => ({ rows: [] }))).rows[0];
async function call(method, { id, deviceKey, token, origin = 'http://localhost', action = 'run' }) {
  const headers = { 'x-forwarded-for': `sixword-ip-${++ip}`, host: 'localhost', ...(origin ? { origin } : {}), ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}) };
  await resetAdminRateForTest(headers['x-forwarded-for']);
  const url = `http://localhost/api/admin/reports/${encodeURIComponent(id)}/asjp-sixword${method === 'GET' ? `?deviceKey=${encodeURIComponent(deviceKey)}` : ''}`;
  const res = method === 'GET' ? await route.GET(new Request(url, { headers }), { params: Promise.resolve({ id }) })
    : await route.POST(new Request(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ deviceKey, action }) }), { params: Promise.resolve({ id }) });
  return { status: res.status, cacheControl: res.headers.get('cache-control'), body: res.status === 200 ? await res.json() : null };
}

const admin = await user('admin'), owner = await user('user'), other = await user('user');
await seedReport({ deviceKey: 'dev-a', reportId: 'rep-a', owner: owner.id });
await seedReport({ deviceKey: 'dev-b', reportId: 'rep-b', owner: other.id });

test('only an admin, same-origin, with the flag on; otherwise 404 and nothing written', async () => {
  assert.equal((await call('POST', { id: 'rep-a', deviceKey: 'dev-a' })).status, 404, 'no session');
  assert.equal((await call('POST', { id: 'rep-a', deviceKey: 'dev-a', token: owner.token })).status, 404, 'the report owner is not an admin');
  assert.equal((await call('POST', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token, origin: 'https://evil.example' })).status, 404, 'cross-origin');
  process.env.ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED = 'false';
  try {
    assert.equal((await call('POST', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).status, 404, 'flag off: the route does not exist');
    assert.equal((await call('GET', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).status, 404);
  } finally { process.env.ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED = 'true'; }
  assert.equal(await recordRow('dev-a', 'rep-a'), undefined, 'nothing written');
  assert.equal((await call('GET', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).body.view.outcome, 'NOT_RUN');
});

test('explicit run: exact positions, labels, scored lane positions and report date forwarded; the saved report row is never written', async () => {
  stub.mode = 'complete';
  const before = await rowOf('dev-a', 'rep-a');
  const r = await call('POST', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token });
  assert.equal(r.status, 200); assert.equal(r.cacheControl, 'no-store');
  assert.deepEqual(await rowOf('dev-a', 'rep-a'), before, 'payload, score, word count, band and updated_at unchanged');
  assert.ok(!String(before.payload_json).includes('sixword'), 'never inside the report payload');
  assert.equal(stub.last.referenceDate, '2025-03-14', 'publication must precede the report date');
  assert.deepEqual(stub.last.creditedPositions, Array.from({ length: 61 }, (_, k) => 100 + k), 'the scored lane positions come from the report\'s own signed record');
  const view = r.body.view;
  assert.equal(view.outcome, 'COMPLETE'); assert.equal(view.label, ASJP_SIXWORD_OVERLAP_LABEL);
  assert.deepEqual(view.items.map((i) => i.words), [[10, 17], [30, 37]]);
  assert.ok(view.items.every((i) => i.scored === false && /original source not established/.test(i.held)));
  assert.equal(view.items[1].multipleHolders, true); assert.match(view.items[1].held, /multiple source holders/);
  assert.deepEqual(view.items[1].notEligible, { PUBLISHED_AFTER_REFERENCE_DATE: 1 });
  assert.equal(view.items[1].holders[0].sourceChars, null, 'no character offsets -> none invented');
  const stored = JSON.parse((await recordRow('dev-a', 'rep-a')).record_json);
  assert.match(stored.signature, /^[0-9a-f]{64}$/);
  assert.equal((await call('GET', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).body.view.outcome, 'COMPLETE', 'reload');
});

test('a stopped, refused, unreachable, forged or other-generation search is never shown as zero matches', async () => {
  const cases = { budget: ['SEARCH_STOPPED_AT_LIMIT', /INCOMPLETE_BUDGET/], busy: ['SEARCH_UNAVAILABLE', /ASJP_BUSY|BUSY/], forged: ['SEARCH_UNAVAILABLE', /MALFORMED/], gen2: ['SEARCH_UNAVAILABLE', /GENERATION_MISMATCH/] };
  for (const [mode, [outcome, reason]] of Object.entries(cases)) {
    stub.mode = mode;
    const view = (await call('POST', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).body.view;
    assert.equal(view.outcome, outcome, mode); assert.match(String(view.reason), reason, mode);
    assert.deepEqual(view.items, [], mode); assert.match(view.message, /does NOT mean zero matches/, mode);
  }
  const url = process.env.ASJP_SERVICE_URL; process.env.ASJP_SERVICE_URL = 'http://127.0.0.1:9';
  try {
    const view = (await call('POST', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).body.view;
    assert.equal(view.outcome, 'SEARCH_UNAVAILABLE'); assert.match(view.reason, /SERVICE_UNREACHABLE/);
  } finally { process.env.ASJP_SERVICE_URL = url; }
});

test('generation: a record from another pinned generation is flagged stale', async () => {
  stub.mode = 'complete';
  await call('POST', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token });
  process.env.ASJP_PINNED_GENERATION_ID = 'gen-next';
  try {
    const view = (await call('GET', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).body.view;
    assert.equal(view.staleGeneration, true); assert.equal(view.currentGenerationId, 'gen-next');
  } finally { process.env.ASJP_PINNED_GENERATION_ID = G1; }
});

test('cross-user isolation: a record copied to another report, or a report that changed owner, is never shown', async () => {
  stub.mode = 'complete';
  await call('POST', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token });
  const json = (await recordRow('dev-a', 'rep-a')).record_json;
  await client.execute({ sql: "INSERT OR REPLACE INTO asjp_sixword_overlap_records (device_key, report_id, record_json, status) VALUES ('dev-b', 'rep-b', ?, 'ACCEPTED')", args: [json] });
  assert.equal((await call('GET', { id: 'rep-b', deviceKey: 'dev-b', token: admin.token })).body.view.outcome, 'UNTRUSTED_RECORD');
  await client.execute({ sql: 'UPDATE saved_reports SET user_id = ? WHERE device_key = ? AND id = ?', args: [other.id, 'dev-a', 'rep-a'] });
  try { assert.equal((await call('GET', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).body.view.outcome, 'UNTRUSTED_RECORD'); }
  finally { await client.execute({ sql: 'UPDATE saved_reports SET user_id = ? WHERE device_key = ? AND id = ?', args: [owner.id, 'dev-a', 'rep-a'] }); }
  const tampered = JSON.parse(json); tampered.matches[0].submittedWordStart = 9;
  await client.execute({ sql: "UPDATE asjp_sixword_overlap_records SET record_json = ? WHERE device_key = 'dev-a' AND report_id = 'rep-a'", args: [JSON.stringify(tampered)] });
  assert.equal((await call('GET', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).body.view.outcome, 'UNTRUSTED_RECORD', 'tampered');
});

test('retraction shows nothing; deleting the report deletes its record', async () => {
  stub.mode = 'complete';
  await call('POST', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token });
  const view = (await call('POST', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token, action: 'retract' })).body.view;
  assert.equal(view.outcome, 'RETRACTED'); assert.deepEqual(view.items, []);
  assert.equal((await call('GET', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).body.view.outcome, 'RETRACTED');
  await client.execute({ sql: 'DELETE FROM saved_reports WHERE device_key = ? AND id = ?', args: ['dev-a', 'rep-a'] });
  assert.equal(await recordRow('dev-a', 'rep-a'), undefined, 'removed with its report');
  assert.equal((await call('GET', { id: 'rep-a', deviceKey: 'dev-a', token: admin.token })).status, 404);
});
