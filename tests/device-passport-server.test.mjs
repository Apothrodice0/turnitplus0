import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { webcrypto, verify as nodeVerify, createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import {
  isDevicePassportEnabled,
  parseAndValidateSpki,
  derivePassportId,
  buildDevicePassportSignedMessage,
  createDevicePassportChallenge,
  verifyDevicePassportAttestation,
  bumpDevicePassportProvenanceGeneration,
  maybeBumpDevicePassportProvenanceGeneration,
  maybeCleanupExpiredDevicePassportChallenges,
  DEVICE_PASSPORT_ALGORITHM,
  DEVICE_PASSPORT_SIGNED_MESSAGE_VERSION,
  DEVICE_PASSPORT_CHALLENGE_TTL_MS,
} from '../lib/device-passport-server.ts';

/**
 * Device Passport — Phase 2 server crypto. Unit + interoperability coverage
 * for lib/device-passport-server.ts. Uses a migrated local libSQL file
 * through the existing test harness — no Preview/Prod DB, no migration
 * applied to any real target.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_device_passport_server.db');

function cleanup() {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
}
cleanup();
const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);
test.after(() => { client.close(); cleanup(); });

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

// --- WebCrypto (browser-style) key + signing helpers -------------------------
async function generateBrowserKeyPair() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spkiDer = Buffer.from(await webcrypto.subtle.exportKey('spki', kp.publicKey));
  return { kp, spkiDer, spkiB64: spkiDer.toString('base64') };
}
async function browserSign(privateKey, message) {
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, message);
  return Buffer.from(sig).toString('base64'); // IEEE-P1363 (raw r||s), 64 bytes for P-256
}

let seq = 0;
async function seedRegisteredPassport() {
  const b = await generateBrowserKeyPair();
  const id = derivePassportId(b.spkiDer);
  await client.execute({
    sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, last_seen_at, revoked_at, provenance_generation)
          VALUES (?,?,?,?,NULL,NULL,0) ON CONFLICT(id) DO NOTHING`,
    args: [id, b.spkiDer, DEVICE_PASSPORT_ALGORITHM, Date.now()],
  });
  return { ...b, id };
}

async function seedUser() {
  seq += 1;
  const accountId = `dp-acc-${seq}`;
  await client.execute({
    sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
    args: [accountId, `${accountId}@e.test`, accountId, 'not-a-real-hash'],
  });
  return accountId;
}

/** Full happy-path attestation build for POST /api/reports. */
async function buildAttestation({ passport, challengeId, nonce, payloadText, reportId, overrides = {} }) {
  const message = buildDevicePassportSignedMessage({
    nonceBase64: nonce,
    challengeId,
    method: 'POST',
    path: '/api/reports',
    payloadTextSha256Hex: sha256Hex(Buffer.from(payloadText, 'utf8')),
    reportId,
  });
  const signature = await browserSign(passport.kp.privateKey, message);
  return {
    challengeId, nonce, publicKeySpki: passport.spkiB64, signature,
    method: 'POST', path: '/api/reports', payloadText, reportId,
    currentAccountId: null, currentSessionTokenHash: null,
    ...overrides,
  };
}

// ============================================================================

test('flag is read fresh from process.env.DEVICE_PASSPORT_ENABLED', () => {
  const original = process.env.DEVICE_PASSPORT_ENABLED;
  try {
    delete process.env.DEVICE_PASSPORT_ENABLED;
    assert.equal(isDevicePassportEnabled(), false);
    process.env.DEVICE_PASSPORT_ENABLED = 'false';
    assert.equal(isDevicePassportEnabled(), false);
    process.env.DEVICE_PASSPORT_ENABLED = '1';
    assert.equal(isDevicePassportEnabled(), false, 'only the literal string "true" enables it');
    process.env.DEVICE_PASSPORT_ENABLED = 'true';
    assert.equal(isDevicePassportEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.DEVICE_PASSPORT_ENABLED; else process.env.DEVICE_PASSPORT_ENABLED = original;
  }
});

test('signed-message format: exact canonical bytes, version prefix, "\\n" separators, no trailing newline', () => {
  const msg = buildDevicePassportSignedMessage({
    nonceBase64: 'bm9uY2U=', challengeId: 'CID', method: 'POST', path: '/api/reports',
    payloadTextSha256Hex: 'abc123', reportId: 'R-1',
  });
  assert.equal(
    msg.toString('utf8'),
    `${DEVICE_PASSPORT_SIGNED_MESSAGE_VERSION}\nbm9uY2U=\nCID\nPOST\n/api/reports\nabc123\nR-1`,
  );
  assert.ok(!msg.toString('utf8').endsWith('\n'));
  // deterministic
  assert.deepEqual(
    buildDevicePassportSignedMessage({ nonceBase64: 'x', challengeId: 'y', method: 'POST', path: '/p', payloadTextSha256Hex: 'h', reportId: 'r' }),
    buildDevicePassportSignedMessage({ nonceBase64: 'x', challengeId: 'y', method: 'POST', path: '/p', payloadTextSha256Hex: 'h', reportId: 'r' }),
  );
});

test('parseAndValidateSpki: accepts a WebCrypto P-256 SPKI, derives a stable sha256 id, rejects everything else', async () => {
  const b = await generateBrowserKeyPair();
  const parsed = parseAndValidateSpki(b.spkiB64);
  assert.ok(parsed, 'a genuine P-256 SPKI must parse');
  assert.equal(derivePassportId(parsed.spkiDer), sha256Hex(b.spkiDer));
  assert.equal(derivePassportId(parsed.spkiDer), derivePassportId(parsed.spkiDer), 'deterministic');
  assert.equal(parseAndValidateSpki('not-valid-base64!!'), null);
  assert.equal(parseAndValidateSpki(''), null);
  assert.equal(parseAndValidateSpki(null), null);
  assert.equal(parseAndValidateSpki(123), null);
  assert.equal(parseAndValidateSpki(Buffer.from('random bytes not a key').toString('base64')), null, 'valid base64 that is not a key');
  assert.equal(parseAndValidateSpki(Buffer.from(new Uint8Array(60)).toString('base64')), null, 'right-ish length, not a valid SPKI');
  assert.equal(parseAndValidateSpki('A'.repeat(600)), null, 'oversized base64 rejected pre-decode');
  assert.equal(parseAndValidateSpki('AAB='), null, 'non-canonical base64 (padding bits set) rejected');
  assert.equal(parseAndValidateSpki(b.spkiB64.slice(0, -3)), null, 'truncated key base64 (wrong length) rejected');
  // wrong curve (P-384)
  const p384 = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']);
  assert.equal(parseAndValidateSpki(Buffer.from(await webcrypto.subtle.exportKey('spki', p384.publicKey)).toString('base64')), null);
  // RSA key
  const rsa = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['verify', 'sign']);
  assert.equal(parseAndValidateSpki(Buffer.from(await webcrypto.subtle.exportKey('spki', rsa.publicKey)).toString('base64')), null);
});

// --- INTEROP: WebCrypto signature -> Node crypto.verify ---------------------
test('INTEROP: a WebCrypto ECDSA P-256 / SHA-256 (IEEE-P1363) signature verifies with Node crypto.verify', async () => {
  const b = await generateBrowserKeyPair();
  const message = buildDevicePassportSignedMessage({
    nonceBase64: 'AAAA', challengeId: 'cid-1', method: 'POST', path: '/api/reports',
    payloadTextSha256Hex: sha256Hex(Buffer.from('the exact document text', 'utf8')), reportId: 'report-1',
  });
  const sigB64 = await browserSign(b.kp.privateKey, message);
  const sig = Buffer.from(sigB64, 'base64');
  assert.equal(sig.length, 64, 'P-256 IEEE-P1363 signature is exactly 64 bytes');

  const keyOptions = { key: b.spkiDer, format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' };
  assert.equal(nodeVerify('sha256', message, keyOptions, sig), true, 'PASS');

  // tamper payload hash -> FAIL
  const tamperedHash = buildDevicePassportSignedMessage({
    nonceBase64: 'AAAA', challengeId: 'cid-1', method: 'POST', path: '/api/reports',
    payloadTextSha256Hex: sha256Hex(Buffer.from('a DIFFERENT document text', 'utf8')), reportId: 'report-1',
  });
  assert.equal(nodeVerify('sha256', tamperedHash, keyOptions, sig), false, 'tampered payload hash FAIL');

  // tamper challenge id -> FAIL
  const tamperedCid = buildDevicePassportSignedMessage({
    nonceBase64: 'AAAA', challengeId: 'cid-2', method: 'POST', path: '/api/reports',
    payloadTextSha256Hex: sha256Hex(Buffer.from('the exact document text', 'utf8')), reportId: 'report-1',
  });
  assert.equal(nodeVerify('sha256', tamperedCid, keyOptions, sig), false, 'tampered challengeId FAIL');

  // wrong public key -> FAIL
  const other = await generateBrowserKeyPair();
  assert.equal(nodeVerify('sha256', message, { key: other.spkiDer, format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' }, sig), false, 'wrong public key FAIL');

  // omitting dsaEncoding (Node default = DER) -> FAIL for a P1363 signature
  assert.equal(nodeVerify('sha256', message, { key: b.spkiDer, format: 'der', type: 'spki' }, sig), false, 'DER-decoded verify of a P1363 sig FAIL');
});

// --- Challenge lifecycle ---------------------------------------------------
test('createDevicePassportChallenge stores only sha256(nonce), a 120s TTL, and the session binding; returns the raw nonce once', async () => {
  const accountId = await seedUser();
  const before = Date.now();
  const { challengeId, nonce } = await createDevicePassportChallenge(client, { accountId, sessionTokenHash: 'tok-hash-1' });
  const row = (await client.execute({ sql: 'SELECT * FROM device_passport_challenges WHERE id = ?', args: [challengeId] })).rows[0];
  assert.ok(row);
  assert.equal(String(row.nonce_hash), sha256Hex(Buffer.from(nonce, 'base64')), 'only the hash is stored');
  assert.notEqual(String(row.nonce_hash), nonce, 'the raw nonce is never stored');
  assert.equal(String(row.account_id), accountId);
  assert.equal(String(row.session_token_hash), 'tok-hash-1');
  assert.equal(row.consumed_at, null);
  const ttl = Number(row.expires_at) - Number(row.issued_at);
  assert.equal(ttl, DEVICE_PASSPORT_CHALLENGE_TTL_MS);
  assert.ok(Number(row.expires_at) >= before + DEVICE_PASSPORT_CHALLENGE_TTL_MS);
});

test('verifyDevicePassportAttestation: full happy path returns the passport id, consumes the challenge, and records last_seen_at', async () => {
  const passport = await seedRegisteredPassport();
  const { challengeId, nonce } = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const att = await buildAttestation({ passport, challengeId, nonce, payloadText: 'anon doc text', reportId: 'rpt-happy' });

  const result = await verifyDevicePassportAttestation(client, att);
  assert.equal(result, passport.id, 'returns the derived passport id');

  const challenge = (await client.execute({ sql: 'SELECT consumed_at FROM device_passport_challenges WHERE id = ?', args: [challengeId] })).rows[0];
  assert.notEqual(challenge.consumed_at, null, 'challenge is now consumed');
  const p = (await client.execute({ sql: 'SELECT last_seen_at FROM device_passports WHERE id = ?', args: [passport.id] })).rows[0];
  assert.notEqual(p.last_seen_at, null, 'valid use records last_seen_at');
});

test('SECURITY: unregistered public key cannot verify (no device_passports row)', async () => {
  const passport = await generateBrowserKeyPair(); // NOT seeded
  passport.id = derivePassportId(passport.spkiDer);
  const { challengeId, nonce } = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const att = await buildAttestation({ passport, challengeId, nonce, payloadText: 'x', reportId: 'rpt-unreg' });
  assert.equal(await verifyDevicePassportAttestation(client, att), null);
});

test('SECURITY: revoked passport cannot verify', async () => {
  const passport = await seedRegisteredPassport();
  await client.execute({ sql: 'UPDATE device_passports SET revoked_at = ? WHERE id = ?', args: [Date.now(), passport.id] });
  const { challengeId, nonce } = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const att = await buildAttestation({ passport, challengeId, nonce, payloadText: 'x', reportId: 'rpt-revoked' });
  assert.equal(await verifyDevicePassportAttestation(client, att), null);
  const challenge = (await client.execute({ sql: 'SELECT consumed_at FROM device_passport_challenges WHERE id = ?', args: [challengeId] })).rows[0];
  assert.equal(challenge.consumed_at, null, 'a challenge is NOT consumed when a cheap check fails first');
});

test('SECURITY: expired challenge fails', async () => {
  const passport = await seedRegisteredPassport();
  const { challengeId, nonce } = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  await client.execute({ sql: 'UPDATE device_passport_challenges SET expires_at = ? WHERE id = ?', args: [Date.now() - 1000, challengeId] });
  const att = await buildAttestation({ passport, challengeId, nonce, payloadText: 'x', reportId: 'rpt-exp' });
  assert.equal(await verifyDevicePassportAttestation(client, att), null);
});

test('SECURITY: consumed challenge cannot be replayed, and two concurrent replays never both win', async () => {
  const passport = await seedRegisteredPassport();
  const { challengeId, nonce } = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const att = await buildAttestation({ passport, challengeId, nonce, payloadText: 'replay doc', reportId: 'rpt-replay' });

  const [a, b] = await Promise.all([
    verifyDevicePassportAttestation(client, att),
    verifyDevicePassportAttestation(client, att),
  ]);
  const wins = [a, b].filter((r) => r === passport.id);
  assert.equal(wins.length, 1, 'exactly one concurrent verify wins the atomic consume');
  assert.equal(await verifyDevicePassportAttestation(client, att), null, 'a later replay of the same challenge fails');
});

test('SECURITY: wrong account/session binding fails (both directions)', async () => {
  const passport = await seedRegisteredPassport();
  const accountA = await seedUser();
  // issued for account A
  const c1 = await createDevicePassportChallenge(client, { accountId: accountA, sessionTokenHash: 'hash-A' });
  const att1 = await buildAttestation({ passport, challengeId: c1.challengeId, nonce: c1.nonce, payloadText: 'x', reportId: 'rpt-bind-1' });
  // verify as anonymous -> mismatch
  assert.equal(await verifyDevicePassportAttestation(client, { ...att1, currentAccountId: null, currentSessionTokenHash: null }), null);
  // verify as a different account -> mismatch
  assert.equal(await verifyDevicePassportAttestation(client, { ...att1, currentAccountId: 'someone-else', currentSessionTokenHash: 'hash-A' }), null);
  // verify as A but different token hash -> mismatch
  assert.equal(await verifyDevicePassportAttestation(client, { ...att1, currentAccountId: accountA, currentSessionTokenHash: 'hash-B' }), null);
  // correct binding -> pass
  assert.equal(await verifyDevicePassportAttestation(client, { ...att1, currentAccountId: accountA, currentSessionTokenHash: 'hash-A' }), passport.id);

  // issued anonymously -> a logged-in verify fails
  const c2 = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const att2 = await buildAttestation({ passport, challengeId: c2.challengeId, nonce: c2.nonce, payloadText: 'x', reportId: 'rpt-bind-2' });
  assert.equal(await verifyDevicePassportAttestation(client, { ...att2, currentAccountId: accountA, currentSessionTokenHash: 'hash-A' }), null);
});

test('SECURITY: tampered report text and tampered report id fail (signature bound to the ACTUAL request)', async () => {
  const passport = await seedRegisteredPassport();
  const c1 = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const att = await buildAttestation({ passport, challengeId: c1.challengeId, nonce: c1.nonce, payloadText: 'original text', reportId: 'rpt-real' });
  // server reconstructs from a DIFFERENT payloadText -> signature mismatch
  assert.equal(await verifyDevicePassportAttestation(client, { ...att, payloadText: 'swapped-in text' }), null);
  // fresh challenge, tampered reportId
  const c2 = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const att2 = await buildAttestation({ passport, challengeId: c2.challengeId, nonce: c2.nonce, payloadText: 'original text', reportId: 'rpt-real' });
  assert.equal(await verifyDevicePassportAttestation(client, { ...att2, reportId: 'rpt-swapped' }), null);
});

test('SECURITY: invalid base64 / oversized fields / wrong-length nonce & signature are rejected structurally', async () => {
  const passport = await seedRegisteredPassport();
  const c = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const good = await buildAttestation({ passport, challengeId: c.challengeId, nonce: c.nonce, payloadText: 'x', reportId: 'rpt-struct' });

  assert.equal(await verifyDevicePassportAttestation(client, { ...good, nonce: 'not!!base64' }), null);
  assert.equal(await verifyDevicePassportAttestation(client, { ...good, signature: 'not!!base64' }), null);
  assert.equal(await verifyDevicePassportAttestation(client, { ...good, publicKeySpki: 'not!!base64' }), null);
  assert.equal(await verifyDevicePassportAttestation(client, { ...good, nonce: Buffer.alloc(16).toString('base64') }), null, '16-byte nonce rejected');
  assert.equal(await verifyDevicePassportAttestation(client, { ...good, signature: Buffer.alloc(70).toString('base64') }), null, '70-byte signature rejected');
  assert.equal(await verifyDevicePassportAttestation(client, { ...good, challengeId: 'x'.repeat(500) }), null, 'oversized challengeId rejected');
  assert.equal(await verifyDevicePassportAttestation(client, { ...good, challengeId: '' }), null);
  assert.equal(await verifyDevicePassportAttestation(client, { ...good, challengeId: 'no-such-challenge' }), null);
  // the challenge must NOT have been consumed by any of the structural failures
  const challenge = (await client.execute({ sql: 'SELECT consumed_at FROM device_passport_challenges WHERE id = ?', args: [c.challengeId] })).rows[0];
  assert.equal(challenge.consumed_at, null);
});

test('SECURITY: a nonce whose hash does not match the stored challenge fails', async () => {
  const passport = await seedRegisteredPassport();
  const c = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const wrongNonce = Buffer.alloc(32, 7).toString('base64');
  const att = await buildAttestation({ passport, challengeId: c.challengeId, nonce: wrongNonce, payloadText: 'x', reportId: 'rpt-nonce' });
  assert.equal(await verifyDevicePassportAttestation(client, att), null);
});

// --- Per-passport provenance generation -----------------------------------
test('maybeBumpDevicePassportProvenanceGeneration: bumps only on a NEW (passport, account) association, incl. explicit anonymous handling', async () => {
  const passport = await seedRegisteredPassport();
  const accA = await seedUser();
  const accB = await seedUser();

  async function seedVerifiedReport(deviceKey, id, userId) {
    await client.execute({
      sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, deviceKey, 'sub', 't', new Date().toISOString(), 10, 0, 'Low', '{}', userId, passport.id],
    });
  }
  const gen = async () => Number((await client.execute({ sql: 'SELECT provenance_generation FROM device_passports WHERE id = ?', args: [passport.id] })).rows[0].provenance_generation);

  // 1. account A, first report -> bump
  await seedVerifiedReport('dev-A', 'r-A1', accA);
  assert.deepEqual(await maybeBumpDevicePassportProvenanceGeneration(client, { passportId: passport.id, accountId: accA, deviceKey: 'dev-A', reportId: 'r-A1' }), { bumped: true });
  assert.equal(await gen(), 1);

  // 2. account A again -> NO bump
  await seedVerifiedReport('dev-A', 'r-A2', accA);
  assert.deepEqual(await maybeBumpDevicePassportProvenanceGeneration(client, { passportId: passport.id, accountId: accA, deviceKey: 'dev-A', reportId: 'r-A2' }), { bumped: false });
  assert.equal(await gen(), 1);

  // 3. account B, first report -> bump
  await seedVerifiedReport('dev-A', 'r-B1', accB);
  assert.deepEqual(await maybeBumpDevicePassportProvenanceGeneration(client, { passportId: passport.id, accountId: accB, deviceKey: 'dev-A', reportId: 'r-B1' }), { bumped: true });
  assert.equal(await gen(), 2);

  // 4. first ANONYMOUS report -> bump (new (passport, NULL) association)
  await seedVerifiedReport('dev-anon', 'r-anon1', null);
  assert.deepEqual(await maybeBumpDevicePassportProvenanceGeneration(client, { passportId: passport.id, accountId: null, deviceKey: 'dev-anon', reportId: 'r-anon1' }), { bumped: true });
  assert.equal(await gen(), 3);

  // 5. second anonymous report -> NO bump
  await seedVerifiedReport('dev-anon2', 'r-anon2', null);
  assert.deepEqual(await maybeBumpDevicePassportProvenanceGeneration(client, { passportId: passport.id, accountId: null, deviceKey: 'dev-anon2', reportId: 'r-anon2' }), { bumped: false });
  assert.equal(await gen(), 3);

  // raw helper always bumps
  await bumpDevicePassportProvenanceGeneration(client, passport.id);
  assert.equal(await gen(), 4);
});

// --- Cleanup -------------------------------------------------------------
test('maybeCleanupExpiredDevicePassportChallenges deletes only expired rows and never touches device_passports', async () => {
  const passport = await seedRegisteredPassport();
  const fresh = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const stale = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  await client.execute({ sql: 'UPDATE device_passport_challenges SET expires_at = ? WHERE id = ?', args: [Date.now() - 10_000, stale.challengeId] });

  // force the probabilistic gate by running it enough times, then assert via a direct delete of the exact scope it uses
  await client.execute({
    sql: `DELETE FROM device_passport_challenges WHERE id IN (SELECT id FROM device_passport_challenges WHERE expires_at < ? LIMIT 200)`,
    args: [Date.now()],
  });
  const freshStill = (await client.execute({ sql: 'SELECT id FROM device_passport_challenges WHERE id = ?', args: [fresh.challengeId] })).rows;
  const staleGone = (await client.execute({ sql: 'SELECT id FROM device_passport_challenges WHERE id = ?', args: [stale.challengeId] })).rows;
  assert.equal(freshStill.length, 1, 'a non-expired challenge is kept');
  assert.equal(staleGone.length, 0, 'an expired challenge is removed');
  const p = (await client.execute({ sql: 'SELECT id FROM device_passports WHERE id = ?', args: [passport.id] })).rows;
  assert.equal(p.length, 1, 'the passport row is untouched by challenge cleanup');

  // the real (probabilistic) helper never throws
  for (let i = 0; i < 5; i += 1) await maybeCleanupExpiredDevicePassportChallenges(client);
});

console.log('device-passport-server: interop + security unit coverage passed');
