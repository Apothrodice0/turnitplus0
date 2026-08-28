import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { webcrypto, createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { resetRateForTest } from '../lib/rate-limit.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as registerRoute from '../app/api/device-passport/register/route.ts';
import * as challengeRoute from '../app/api/device-passport/challenge/route.ts';
import {
  derivePassportId,
  buildDevicePassportSignedMessage,
  createDevicePassportChallenge,
  verifyDevicePassportAttestation,
  DEVICE_PASSPORT_ALGORITHM,
} from '../lib/device-passport-server.ts';

/**
 * Device Passport — Phase 2 PRIVACY + fail-safe.
 *
 * (A) Structural: lib/device-passport-server.ts never pulls in the matcher /
 *     ownership / similarity modules; no app/ file outside the two passport
 *     endpoints and the report route imports it; the ordinary-user report
 *     read paths never SELECT or serialize any passport column.
 * (B) Behavioural: an ordinary user's own report responses (detail + list)
 *     and the passport endpoint responses expose no passport id, public key,
 *     signature, nonce, challenge metadata, or source device provenance.
 * (C) Fail-safe: a passport-store DB error degrades to "no provenance", never
 *     a thrown error or a failed upload.
 */

const repoRoot = path.resolve('.');
const drizzleDir = path.join(repoRoot, 'drizzle');

// ---------------------------------------------------------------------------
// (A) Structural
// ---------------------------------------------------------------------------

function importLines(source) {
  return source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l));
}
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

test('lib/device-passport-server.ts imports no matcher / ownership / similarity module', () => {
  const imports = importLines(fs.readFileSync(path.join(repoRoot, 'lib/device-passport-server.ts'), 'utf8')).join('\n');
  for (const forbidden of [
    'user-submission-matching', 'user-submission-corpus', 'report-primary-similarity',
    'report-historical-match', 'document-correspondence', 'unified-similarity',
    'summarizeSubmissionOwnership', 'summarizeSubmissionProvenance', 'corpus-match-generation',
    'document-family', 'report-classification',
  ]) {
    assert.doesNotMatch(imports, new RegExp(forbidden), `device-passport-server must not import ${forbidden} — Phase 2 captures provenance only`);
  }
});

test('only the two device-passport endpoints and app/api/reports/route.ts import lib/device-passport-server', () => {
  const allowed = new Set([
    'app/api/device-passport/register/route.ts',
    'app/api/device-passport/challenge/route.ts',
    'app/api/reports/route.ts',
  ]);
  const offenders = [];
  for (const file of walk(path.join(repoRoot, 'app'))) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    if (allowed.has(rel)) continue;
    if (/device-passport-server/.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `unexpected app/ importer(s) of lib/device-passport-server: ${offenders.join(', ')}`);
});

test('the ordinary-user report read paths never SELECT or serialize a passport column', () => {
  for (const rel of ['app/api/reports/[id]/route.ts', 'app/api/reports/route.ts', 'lib/reports-repo.ts']) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    // the write path (POST in reports/route.ts) legitimately references it —
    // strip that function so we only scrutinise the GET/list/room-read code.
    const readOnly = rel === 'app/api/reports/route.ts' ? src.split('export async function GET(')[1] ?? '' : src;
    assert.doesNotMatch(readOnly, /verified_device_passport_id/, `${rel} read path must not touch verified_device_passport_id`);
    assert.doesNotMatch(readOnly, /device_passport|devicePassport/, `${rel} read path must not touch device passport data`);
  }
});

test('the deduplicated corpus_document_representations schema block has no device / account identity column', () => {
  // strip line comments first (the comment ABOVE this table talks about
  // account_id living on document_identities), then isolate just the
  // sqliteTable(...) call body.
  const schema = fs.readFileSync(path.join(repoRoot, 'db/schema.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  const start = schema.indexOf('"corpus_document_representations"');
  assert.ok(start > 0);
  const block = schema.slice(start, schema.indexOf(');', start));
  for (const forbidden of ['device_passport_id', 'verified_device_passport_id', 'account_id', 'user_id', 'email', 'device_key']) {
    assert.doesNotMatch(block, new RegExp(`\\b${forbidden}\\b`), `corpus_document_representations must not define ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// (B) + (C) Behavioural
// ---------------------------------------------------------------------------

const dbFile = path.join(repoRoot, 'test_device_passport_privacy.db');
function cleanup() { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } } }
cleanup();
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const originalFlag = process.env.DEVICE_PASSPORT_ENABLED;
process.env.DEVICE_PASSPORT_ENABLED = 'true';
const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);
test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  if (originalFlag === undefined) delete process.env.DEVICE_PASSPORT_ENABLED; else process.env.DEVICE_PASSPORT_ENABLED = originalFlag;
  cleanup();
});

const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
const SAME_ORIGIN = { origin: 'http://localhost', host: 'localhost' };
let seq = 0;
const nextIp = () => `dpp-${++seq}`;

async function keyPair() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spkiDer = Buffer.from(await webcrypto.subtle.exportKey('spki', kp.publicKey));
  return { kp, spkiDer, spkiB64: spkiDer.toString('base64'), id: derivePassportId(spkiDer) };
}

test('a verified upload leaks no passport data into the owner\'s report detail or list responses', async () => {
  const k = await keyPair();
  await client.execute({
    sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, last_seen_at, revoked_at, provenance_generation) VALUES (?,?,?,?,NULL,NULL,0) ON CONFLICT(id) DO NOTHING`,
    args: [k.id, k.spkiDer, DEVICE_PASSPORT_ALGORITHM, Date.now()],
  });
  const deviceKey = `dpp-dev-${seq}`;
  const reportId = `dpp-report-${seq}`;
  const text = 'the private document body';
  const { challengeId, nonce } = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const message = buildDevicePassportSignedMessage({
    nonceBase64: nonce, challengeId, method: 'POST', path: '/api/reports',
    payloadTextSha256Hex: sha256Hex(Buffer.from(text, 'utf8')), reportId,
  });
  const signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.kp.privateKey, message)).toString('base64');

  const ip = nextIp();
  await resetRateForTest(ip);
  const postRes = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...SAME_ORIGIN },
    body: JSON.stringify({
      deviceKey, id: reportId, submissionId: 'sub', title: 't.pdf', createdAt: new Date().toISOString(),
      wordCount: 4, archiveScore: 0, scoreBand: 'Low',
      payload: { version: 11, id: 1, submissionId: 'sub', title: 't.pdf', created: new Date().toISOString(), score: 0, wordCount: 4, text },
      devicePassport: { challengeId, nonce, publicKeySpki: k.spkiB64, signature },
    }),
  }));
  assert.equal(postRes.status, 200);
  // sanity: provenance WAS captured server-side
  const stored = (await client.execute({ sql: 'SELECT verified_device_passport_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, reportId] })).rows[0];
  assert.equal(String(stored.verified_device_passport_id), k.id);

  const forbiddenSubstrings = [k.id, k.spkiB64, signature, nonce, challengeId, 'verified_device_passport_id', 'devicePassport', 'device_passport', 'provenance_generation'];

  // detail (anonymous owner, by device key)
  await resetRateForTest(nextIp());
  const detailRes = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${reportId}?deviceKey=${encodeURIComponent(deviceKey)}`, { headers: { 'x-forwarded-for': nextIp() } }),
    { params: Promise.resolve({ id: reportId }) },
  );
  assert.equal(detailRes.status, 200);
  const detailText = await detailRes.text();
  for (const s of forbiddenSubstrings) assert.equal(detailText.includes(s), false, `report detail leaked: ${s.slice(0, 24)}`);

  // list
  await resetRateForTest(nextIp());
  const listRes = await reportsRoute.GET(new Request(`http://localhost/api/reports?deviceKey=${encodeURIComponent(deviceKey)}`, { headers: { 'x-forwarded-for': nextIp() } }));
  const listText = await listRes.text();
  for (const s of forbiddenSubstrings) assert.equal(listText.includes(s), false, `report list leaked: ${s.slice(0, 24)}`);
});

test('the challenge endpoint response exposes only { challengeId, nonce } — no session hash / binding', async () => {
  await resetRateForTest(nextIp());
  const res = await challengeRoute.POST(new Request('http://localhost/api/device-passport/challenge', { method: 'POST', headers: { 'x-forwarded-for': nextIp(), ...SAME_ORIGIN } }));
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['challengeId', 'nonce']);
  const row = (await client.execute({ sql: 'SELECT session_token_hash FROM device_passport_challenges WHERE id = ?', args: [body.challengeId] })).rows[0];
  // even for an anonymous challenge, nothing binding-related is in the body
  assert.equal(JSON.stringify(body).includes('session'), false);
  assert.equal(JSON.stringify(body).includes('account'), false);
  assert.equal(row.session_token_hash, null);
});

test('the register endpoint response is exactly { ok: true } — no id, no key echo', async () => {
  const k = await keyPair();
  await resetRateForTest(nextIp());
  const res = await registerRoute.POST(new Request('http://localhost/api/device-passport/register', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...SAME_ORIGIN },
    body: JSON.stringify({ publicKeySpki: k.spkiB64 }),
  }));
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
  const raw = JSON.stringify(body);
  assert.equal(raw.includes(k.id), false);
  assert.equal(raw.includes(k.spkiB64), false);
});

test('FAIL-SAFE: a passport-store DB error makes verifyDevicePassportAttestation return null, never throw', async () => {
  const brokenClient = { execute: async () => { throw new Error('simulated device_passports outage'); } };
  const result = await verifyDevicePassportAttestation(brokenClient, {
    challengeId: 'c', nonce: Buffer.alloc(32).toString('base64'), publicKeySpki: (await keyPair()).spkiB64,
    signature: Buffer.alloc(64).toString('base64'), method: 'POST', path: '/api/reports',
    payloadText: 'x', reportId: 'r', currentAccountId: null, currentSessionTokenHash: null,
  });
  assert.equal(result, null);
});

console.log('device-passport-privacy: structural + behavioural + fail-safe passed');
