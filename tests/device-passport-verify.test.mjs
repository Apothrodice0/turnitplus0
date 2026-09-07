import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { webcrypto, createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { createSession } from '../lib/auth-session.ts';
import { resetRateForTest } from '../lib/rate-limit.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as registerRoute from '../app/api/device-passport/register/route.ts';
import * as challengeRoute from '../app/api/device-passport/challenge/route.ts';
import {
  derivePassportId,
  buildDevicePassportSignedMessage,
  createDevicePassportChallenge,
  DEVICE_PASSPORT_ALGORITHM,
} from '../lib/device-passport-server.ts';
import {
  createPendingReportAdmissionJob,
  processReportAdmissionJob,
  buildReportAdmissionSourceRef,
} from '../lib/corpus-admission-report-integration.ts';

/**
 * Device Passport — Phase 2. End-to-end coverage: the register + challenge
 * endpoints (flag OFF / cross-origin / happy path), the POST /api/reports
 * attestation verification and immutable provenance, the per-passport
 * generation bump through the route, and the ACCEPT source-provenance write.
 * Disposable local libSQL only; no migration applied to any real target.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_device_passport_verify.db');
function cleanup() {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
}
cleanup();
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

const originalFlag = process.env.DEVICE_PASSPORT_ENABLED;
const originalAdmission = process.env.CORPUS_ADMISSION_ENABLED;
const originalPromotion = process.env.CORPUS_PROMOTION_ENABLED;
function setFlag(v) { if (v === undefined) delete process.env.DEVICE_PASSPORT_ENABLED; else process.env.DEVICE_PASSPORT_ENABLED = v; }
test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  setFlag(originalFlag);
  if (originalAdmission === undefined) delete process.env.CORPUS_ADMISSION_ENABLED; else process.env.CORPUS_ADMISSION_ENABLED = originalAdmission;
  if (originalPromotion === undefined) delete process.env.CORPUS_PROMOTION_ENABLED; else process.env.CORPUS_PROMOTION_ENABLED = originalPromotion;
  cleanup();
});

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
const SAME_ORIGIN_HEADERS = { origin: 'http://localhost', host: 'localhost' };

let seq = 0;
function nextIp() { seq += 1; return `dpv-${seq}`; }

async function generateKeyPair() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spkiDer = Buffer.from(await webcrypto.subtle.exportKey('spki', kp.publicKey));
  return { kp, spkiDer, spkiB64: spkiDer.toString('base64'), id: derivePassportId(spkiDer) };
}
async function sign(privateKey, message) {
  return Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, message)).toString('base64');
}
async function seedUser(consented = false) {
  seq += 1;
  const id = `dpv-user-${seq}`;
  await client.execute({
    sql: 'INSERT INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,?)',
    args: [id, `${id}@e.test`, id, 'x', consented ? new Date().toISOString() : null],
  });
  const token = await createSession(client, id);
  return { id, token };
}
async function registerViaSql(kp) {
  await client.execute({
    sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, last_seen_at, revoked_at, provenance_generation)
          VALUES (?,?,?,?,NULL,NULL,0) ON CONFLICT(id) DO NOTHING`,
    args: [kp.id, kp.spkiDer, DEVICE_PASSPORT_ALGORITHM, Date.now()],
  });
}
function req(url, { headers = {}, body } = {}) {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function callRegister(headers, body) {
  await resetRateForTest(headers['x-forwarded-for']);
  return registerRoute.POST(req('http://localhost/api/device-passport/register', { headers, body }));
}
async function callChallenge(headers) {
  await resetRateForTest(headers['x-forwarded-for']);
  return challengeRoute.POST(req('http://localhost/api/device-passport/challenge', { headers }));
}

let reportSeq = 0;
async function postReport({ deviceKey, token, devicePassport, text = 'the exact submitted document text', reportId } = {}) {
  reportSeq += 1;
  const ip = nextIp();
  await resetRateForTest(ip);
  const id = reportId ?? `dpv-report-${reportSeq}`;
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip, ...SAME_ORIGIN_HEADERS };
  if (token) headers.cookie = `tp_session_v1=${token}`;
  const payload = { version: 11, id: Number.isFinite(Number(id)) ? Number(id) : 1, submissionId: 'sub', title: 't.pdf', created: new Date().toISOString(), score: 0, wordCount: 5, text };
  const bodyObj = {
    deviceKey, id, submissionId: 'sub', title: 't.pdf', createdAt: payload.created,
    wordCount: 5, archiveScore: 0, scoreBand: 'Low', payload,
  };
  if (token) bodyObj.room = 0;
  if (devicePassport) bodyObj.devicePassport = devicePassport;
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', { method: 'POST', headers, body: JSON.stringify(bodyObj) }));
  return { res, id, text };
}

/** Register + anonymous challenge + sign, returning a devicePassport attestation for a given (reportId, text). */
async function fullAttestation({ kp, reportId, text, session = { accountId: null, sessionTokenHash: null }, tamper }) {
  const { challengeId, nonce } = await createDevicePassportChallenge(client, session);
  const message = buildDevicePassportSignedMessage({
    nonceBase64: nonce, challengeId, method: 'POST', path: '/api/reports',
    payloadTextSha256Hex: sha256Hex(Buffer.from(text, 'utf8')), reportId,
  });
  let signature = await sign(kp.kp.privateKey, message);
  if (tamper === 'signature') signature = signature.slice(0, -4) + (signature.endsWith('A') ? 'B' : 'A') + signature.slice(-3);
  return { challengeId, nonce, publicKeySpki: kp.spkiB64, signature };
}

// ============================================================================
// REGISTER endpoint
// ============================================================================

test('register: flag OFF -> generic 404, no row', async () => {
  setFlag('false');
  const kp = await generateKeyPair();
  const res = await callRegister({ 'x-forwarded-for': nextIp(), ...SAME_ORIGIN_HEADERS }, { publicKeySpki: kp.spkiB64 });
  assert.equal(res.status, 404);
  const rows = (await client.execute({ sql: 'SELECT id FROM device_passports WHERE id = ?', args: [kp.id] })).rows;
  assert.equal(rows.length, 0);
});

test('register: cross-origin -> 404 even with the flag ON', async () => {
  setFlag('true');
  const kp = await generateKeyPair();
  const res = await callRegister({ 'x-forwarded-for': nextIp(), origin: 'http://evil.example', host: 'localhost' }, { publicKeySpki: kp.spkiB64 });
  assert.equal(res.status, 404);
  // no origin header at all -> also 404 (fail closed)
  const res2 = await callRegister({ 'x-forwarded-for': nextIp(), host: 'localhost' }, { publicKeySpki: kp.spkiB64 });
  assert.equal(res2.status, 404);
});

test('register: flag ON, same-origin, valid key -> { ok: true }, idempotent, never returns the id', async () => {
  setFlag('true');
  const kp = await generateKeyPair();
  const res = await callRegister({ 'x-forwarded-for': nextIp(), ...SAME_ORIGIN_HEADERS }, { publicKeySpki: kp.spkiB64 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
  assert.equal(JSON.stringify(body).includes(kp.id), false, 'the passport id is never in the response');

  const row = (await client.execute({ sql: 'SELECT * FROM device_passports WHERE id = ?', args: [kp.id] })).rows[0];
  assert.ok(row);
  assert.equal(String(row.algorithm), DEVICE_PASSPORT_ALGORITHM);
  assert.equal(row.last_seen_at, null, 'registration alone does not set last_seen_at');
  assert.equal(Number(row.provenance_generation), 0);

  const res2 = await callRegister({ 'x-forwarded-for': nextIp(), ...SAME_ORIGIN_HEADERS }, { publicKeySpki: kp.spkiB64 });
  assert.equal(res2.status, 200);
  const count = (await client.execute({ sql: 'SELECT COUNT(*) AS c FROM device_passports WHERE id = ?', args: [kp.id] })).rows[0];
  assert.equal(Number(count.c), 1, 'ON CONFLICT DO NOTHING — still one row');
});

test('register: invalid / non-P-256 / oversized key -> 400', async () => {
  setFlag('true');
  for (const bad of ['not-base64!!', '', Buffer.from('short').toString('base64'), 'A'.repeat(600)]) {
    const res = await callRegister({ 'x-forwarded-for': nextIp(), ...SAME_ORIGIN_HEADERS }, { publicKeySpki: bad });
    assert.equal(res.status, 400, `rejected: ${JSON.stringify(bad).slice(0, 20)}`);
  }
});

// ============================================================================
// CHALLENGE endpoint
// ============================================================================

test('challenge: flag OFF / cross-origin -> 404', async () => {
  setFlag('false');
  assert.equal((await callChallenge({ 'x-forwarded-for': nextIp(), ...SAME_ORIGIN_HEADERS })).status, 404);
  setFlag('true');
  assert.equal((await callChallenge({ 'x-forwarded-for': nextIp(), origin: 'http://evil.example', host: 'localhost' })).status, 404);
});

test('challenge: anonymous -> { challengeId, nonce }, row bound to NULL account, no session hash exposed', async () => {
  setFlag('true');
  const res = await callChallenge({ 'x-forwarded-for': nextIp(), ...SAME_ORIGIN_HEADERS });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['challengeId', 'nonce']);
  assert.equal(Buffer.from(body.nonce, 'base64').length, 32);
  const row = (await client.execute({ sql: 'SELECT * FROM device_passport_challenges WHERE id = ?', args: [body.challengeId] })).rows[0];
  assert.equal(row.account_id, null);
  assert.equal(row.session_token_hash, null);
  assert.equal(String(row.nonce_hash), sha256Hex(Buffer.from(body.nonce, 'base64')));
  assert.equal(JSON.stringify(body).includes(String(row.nonce_hash)), false, 'the nonce hash is never in the response');
});

test('challenge: authenticated -> row bound to the account AND the session token hash', async () => {
  setFlag('true');
  const user = await seedUser();
  const res = await callChallenge({ 'x-forwarded-for': nextIp(), ...SAME_ORIGIN_HEADERS, cookie: `tp_session_v1=${user.token}` });
  assert.equal(res.status, 200);
  const { challengeId } = await res.json();
  const row = (await client.execute({ sql: 'SELECT account_id, session_token_hash FROM device_passport_challenges WHERE id = ?', args: [challengeId] })).rows[0];
  assert.equal(String(row.account_id), user.id);
  assert.equal(String(row.session_token_hash), sha256Hex(Buffer.from(user.token, 'utf8')));
});

// ============================================================================
// POST /api/reports — verification + immutable provenance + generation bump
// ============================================================================

async function passportIdOnReport(deviceKey, id) {
  const r = (await client.execute({ sql: 'SELECT verified_device_passport_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, id] })).rows[0];
  return r ? r.verified_device_passport_id : undefined;
}
async function passportGeneration(passportId) {
  const r = (await client.execute({ sql: 'SELECT provenance_generation FROM device_passports WHERE id = ?', args: [passportId] })).rows[0];
  return r ? Number(r.provenance_generation) : undefined;
}

test('POST /api/reports: flag OFF + devicePassport present -> upload unchanged, verified_device_passport_id stays NULL', async () => {
  setFlag('false');
  const kp = await generateKeyPair();
  await registerViaSql(kp);
  const deviceKey = `dk-off-${nextIp()}`;
  const att = await fullAttestation({ kp, reportId: 'flagoff-1', text: 'doc text off' });
  const { res } = await postReport({ deviceKey, devicePassport: att, text: 'doc text off', reportId: 'flagoff-1' });
  assert.equal(res.status, 200);
  assert.equal(await passportIdOnReport(deviceKey, 'flagoff-1'), null);
});

test('POST /api/reports: flag ON, no devicePassport (a copied plain device_key alone) -> no provenance', async () => {
  setFlag('true');
  const deviceKey = `dk-plain-${nextIp()}`;
  const { res } = await postReport({ deviceKey, reportId: 'plain-1', text: 'plain doc' });
  assert.equal(res.status, 200);
  assert.equal(await passportIdOnReport(deviceKey, 'plain-1'), null, 'a device_key by itself never proves a passport');
});

test('POST /api/reports: flag ON + valid attestation -> verified_device_passport_id set + generation bumped to 1', async () => {
  setFlag('true');
  const kp = await generateKeyPair();
  await registerViaSql(kp);
  const deviceKey = `dk-ok-${nextIp()}`;
  const text = 'a genuine submitted document body for the attestation test';
  const att = await fullAttestation({ kp, reportId: 'ok-1', text });
  const { res } = await postReport({ deviceKey, devicePassport: att, text, reportId: 'ok-1' });
  assert.equal(res.status, 200);
  assert.equal(await passportIdOnReport(deviceKey, 'ok-1'), kp.id);
  assert.equal(await passportGeneration(kp.id), 1, 'first (passport, anonymous) association bumps once');

  // a second anonymous report from the SAME passport -> stored, but NO extra bump
  const att2 = await fullAttestation({ kp, reportId: 'ok-2', text: 'another doc' });
  const r2 = await postReport({ deviceKey: `dk-ok2-${nextIp()}`, devicePassport: att2, text: 'another doc', reportId: 'ok-2' });
  assert.equal(r2.res.status, 200);
  assert.equal(await passportGeneration(kp.id), 1, 'a repeat anonymous report does not bump again');
});

test('POST /api/reports: flag ON + tampered signature -> upload STILL succeeds, no provenance', async () => {
  setFlag('true');
  const kp = await generateKeyPair();
  await registerViaSql(kp);
  const deviceKey = `dk-bad-${nextIp()}`;
  const text = 'doc for the tampered-signature case';
  const att = await fullAttestation({ kp, reportId: 'bad-1', text, tamper: 'signature' });
  const { res } = await postReport({ deviceKey, devicePassport: att, text, reportId: 'bad-1' });
  assert.equal(res.status, 200, 'a bad attestation NEVER fails the upload');
  assert.equal(await passportIdOnReport(deviceKey, 'bad-1'), null);
  assert.equal(await passportGeneration(kp.id), 0, 'no bump on a failed verification');
});

test('POST /api/reports: unregistered passport -> upload succeeds, no provenance', async () => {
  setFlag('true');
  const kp = await generateKeyPair(); // NOT registered
  const deviceKey = `dk-unreg-${nextIp()}`;
  const text = 'doc for the unregistered-passport case';
  const att = await fullAttestation({ kp, reportId: 'unreg-1', text });
  const { res } = await postReport({ deviceKey, devicePassport: att, text, reportId: 'unreg-1' });
  assert.equal(res.status, 200);
  assert.equal(await passportIdOnReport(deviceKey, 'unreg-1'), null);
});

test('POST /api/reports: verified_device_passport_id is immutable across a resave', async () => {
  setFlag('true');
  const kp = await generateKeyPair();
  await registerViaSql(kp);
  const deviceKey = `dk-immut-${nextIp()}`;
  const text = 'doc for the immutability test';
  const att = await fullAttestation({ kp, reportId: 'immut-1', text });
  await postReport({ deviceKey, devicePassport: att, text, reportId: 'immut-1' });
  assert.equal(await passportIdOnReport(deviceKey, 'immut-1'), kp.id);

  // resave the same (deviceKey, id) — even with a fresh valid attestation, the
  // route gates verification on isFirstSaveOfThisReport, so nothing changes.
  const kp2 = await generateKeyPair();
  await registerViaSql(kp2);
  const att2 = await fullAttestation({ kp: kp2, reportId: 'immut-1', text });
  const r = await postReport({ deviceKey, devicePassport: att2, text, reportId: 'immut-1' });
  assert.equal(r.res.status, 200);
  assert.equal(await passportIdOnReport(deviceKey, 'immut-1'), kp.id, 'still the ORIGINAL passport');
});

// ============================================================================
// ACCEPTED SOURCE PROVENANCE (corpus_admission_decision_device_provenance)
// ============================================================================

const WORD_BANK = 'research analysis population sample variable hypothesis method outcome region temperature pressure reaction material structure process signal pattern network sediment species habitat climate growth measurement instrument observation protocol significant distinct gradual consistent notable substantial minor extensive localized documented identified recorded analyzed examined compared measured observed reported'.split(' ');
function articleText(seed, targetWords = 3400) {
  let s = seed >>> 0 || 1;
  const rng = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0xffffffff; };
  const parts = [];
  let n = 0;
  while (n < targetWords) {
    const sentence = 'The ' + Array.from({ length: 12 + Math.floor(rng() * 16) }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]).join(' ') + '.';
    const para = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => sentence).join(' ');
    parts.push(para); n += para.split(/\s+/).length;
  }
  return parts.join('\n\n');
}

async function seedAdmittableReport(accountId, deviceKey, reportId, text) {
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, room_number, ai_status, updated_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportId, deviceKey, 'sub', 'Fixture', 40, 0, 'Low', JSON.stringify({ version: 11, id: reportId, text }), accountId, 0, 'ready'],
  });
}

test('processReportAdmissionJob: on ACCEPT with a verified passport, writes corpus_admission_decision_device_provenance (idempotent)', async () => {
  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  process.env.CORPUS_PROMOTION_ENABLED = 'false';
  const kp = await generateKeyPair();
  await registerViaSql(kp);
  const user = await seedUser(true);
  const deviceKey = `dk-accept-${nextIp()}`;
  const reportId = `accept-${nextIp()}`;
  const text = articleText(90210);
  await seedAdmittableReport(user.id, deviceKey, reportId, text);

  const created = await createPendingReportAdmissionJob(client, { accountId: user.id, deviceKey, reportId, verifiedDevicePassportId: kp.id });
  assert.ok(created);
  const openConnection = () => createClient({ url: `file:${dbFile}` });
  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(outcome.decision, 'ACCEPT', 'fixture must genuinely ACCEPT');

  const prov = (await client.execute({ sql: 'SELECT * FROM corpus_admission_decision_device_provenance WHERE decision_id = ?', args: [outcome.decisionId] })).rows;
  assert.equal(prov.length, 1);
  assert.equal(String(prov[0].device_passport_id), kp.id);
  assert.ok(Number(prov[0].verified_at) > 0);

  // re-processing the same job is a safe no-op; provenance is not double-written
  await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  const provAgain = (await client.execute({ sql: 'SELECT COUNT(*) AS c FROM corpus_admission_decision_device_provenance WHERE decision_id = ?', args: [outcome.decisionId] })).rows[0];
  assert.equal(Number(provAgain.c), 1);

  // the deduplicated representation table gains no passport/account column
  const repCols = new Set((await client.execute("PRAGMA table_info('corpus_document_representations')")).rows.map((r) => String(r.name)));
  for (const forbidden of ['device_passport_id', 'verified_device_passport_id', 'account_id']) assert.ok(!repCols.has(forbidden));
});

test('processReportAdmissionJob: a required-provenance write failure NEVER finalizes the job — a plain retry re-finalizes the SAME decision, exactly one provenance row, promotion + representation + admission not duplicated', async () => {
  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  process.env.CORPUS_PROMOTION_ENABLED = 'true';
  const kp = await generateKeyPair();
  await registerViaSql(kp);
  const user = await seedUser(true);
  const deviceKey = `dk-atomic-${nextIp()}`;
  const reportId = `atomic-${nextIp()}`;
  const text = articleText(778101);
  await seedAdmittableReport(user.id, deviceKey, reportId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId: user.id, deviceKey, reportId });

  const created = await createPendingReportAdmissionJob(client, { accountId: user.id, deviceKey, reportId, verifiedDevicePassportId: kp.id });
  assert.ok(created);
  const openConnection = () => createClient({ url: `file:${dbFile}` });

  const count = async (sql, args) => Number((await client.execute({ sql, args })).rows[0].c);
  const jobRow = async () => (await client.execute({ sql: 'SELECT * FROM corpus_admission_report_jobs WHERE id = ?', args: [created.jobId] })).rows[0];

  // --- attempt 1: force the required per-decision provenance INSERT to fail ---
  const failed = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection, testOnlySimulateProvenanceWriteFailure: true });
  assert.equal(failed.outcome, 'failed', 'the job must NOT report success when its required provenance write failed');

  // the report upload itself is entirely unaffected — the saved_reports row and its
  // retained text are untouched by an admission-job failure (this fixture seeds the
  // report directly, so the passport lives only on the admission job, not saved_reports)
  const savedRow = (await client.execute({ sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, reportId] })).rows[0];
  assert.ok(savedRow, 'the saved_reports row still exists');
  assert.equal(JSON.parse(String(savedRow.payload_json)).text, text, 'the retained report text is intact');

  const j1 = await jobRow();
  assert.notEqual(String(j1.status), 'succeeded', 'REQUIRED: the job is NOT irreversibly finalized without its provenance');
  assert.ok(['pending', 'failed'].includes(String(j1.status)), 'the job is left in an existing retryable state');
  assert.ok(j1.decision_id, 'the decision id is preserved on the job so a retry re-finalizes THAT decision, never re-evaluates');
  assert.equal(j1.claimed_at, null, 'a failed attempt releases any claim');

  const decisionId = String(j1.decision_id);
  const d = (await client.execute({ sql: 'SELECT decision, canonical_sha256 FROM corpus_admission_decisions WHERE id = ?', args: [decisionId] })).rows[0];
  assert.equal(String(d.decision), 'ACCEPT', 'fixture must genuinely ACCEPT for this test to exercise the provenance path');
  const hash = String(d.canonical_sha256);

  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_decision_device_provenance WHERE decision_id = ?', [decisionId]), 0, 'no provenance row after the failed attempt — the batch rolled back atomically');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_promotions WHERE decision_id = ?', [decisionId]), 0, 'promotion is never attempted while finalization is unfinished');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_accepted_representations WHERE canonical_sha256 = ?', [hash]), 1, 'exactly one accepted representation from the single evaluation');

  // --- attempt 2: a plain retry, no fault injected ---
  const retried = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(retried.outcome, 'succeeded');
  assert.equal(retried.decision, 'ACCEPT');
  assert.equal(retried.decisionId, decisionId, 'the retry re-finalized the SAME decision — it never re-evaluated');

  const j2 = await jobRow();
  assert.equal(String(j2.status), 'succeeded');
  assert.equal(String(j2.decision_id), decisionId);

  const prov = (await client.execute({ sql: 'SELECT * FROM corpus_admission_decision_device_provenance WHERE decision_id = ?', args: [decisionId] })).rows;
  assert.equal(prov.length, 1, 'exactly one provenance row after the successful retry');
  assert.equal(String(prov[0].device_passport_id), kp.id);

  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE source_ref = ?', [sourceRef]), 1, 'admission not duplicated — no divergent second decision for this source_ref');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_accepted_representations WHERE canonical_sha256 = ?', [hash]), 1, 'accepted representation not duplicated');

  const promo = (await client.execute({ sql: 'SELECT * FROM corpus_admission_promotions WHERE decision_id = ?', args: [decisionId] })).rows;
  assert.equal(promo.length, 1, 'exactly one promotion row');
  assert.equal(String(promo[0].status), 'indexed');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?', [hash]), 1, 'representation not duplicated');

  // --- attempt 3: a further retry is a clean idempotent no-op ---
  const again = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(again.outcome, 'already_succeeded');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_decision_device_provenance WHERE decision_id = ?', [decisionId]), 1, 'still exactly one provenance row');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_promotions WHERE decision_id = ?', [decisionId]), 1, 'still exactly one promotion row');
});

test('processReportAdmissionJob: ACCEPT WITHOUT a verified passport writes no provenance row', async () => {
  process.env.CORPUS_ADMISSION_ENABLED = 'true';
  process.env.CORPUS_PROMOTION_ENABLED = 'false';
  const user = await seedUser(true);
  const deviceKey = `dk-noprov-${nextIp()}`;
  const reportId = `noprov-${nextIp()}`;
  await seedAdmittableReport(user.id, deviceKey, reportId, articleText(31337));

  const created = await createPendingReportAdmissionJob(client, { accountId: user.id, deviceKey, reportId });
  const openConnection = () => createClient({ url: `file:${dbFile}` });
  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(outcome.decision, 'ACCEPT');
  const prov = (await client.execute({ sql: 'SELECT COUNT(*) AS c FROM corpus_admission_decision_device_provenance WHERE decision_id = ?', args: [outcome.decisionId] })).rows[0];
  assert.equal(Number(prov.c), 0);
});

console.log('device-passport-verify: endpoints + POST /api/reports + ACCEPT provenance passed');
