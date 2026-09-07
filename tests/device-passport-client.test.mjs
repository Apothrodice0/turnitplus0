import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createHash, verify as nodeVerify, createPublicKey } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { resetRateForTest } from '../lib/rate-limit.js';
import * as registerRoute from '../app/api/device-passport/register/route.ts';
import * as challengeRoute from '../app/api/device-passport/challenge/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import {
  buildDevicePassportSignedMessage,
  verifyDevicePassportAttestation,
  derivePassportId,
  parseAndValidateSpki,
  DEVICE_PASSPORT_SIGNED_MESSAGE_VERSION,
} from '../lib/device-passport-server.ts';
import {
  ensureDevicePassport,
  buildDevicePassportAttestation,
  buildDevicePassportSignedMessageBytes,
  maybeAttestReportUpload,
  DEVICE_PASSPORT_SIGNED_MESSAGE_VERSION as CLIENT_SIGNED_MESSAGE_VERSION,
  DEVICE_PASSPORT_DB_NAME,
  DEVICE_PASSPORT_STORE_NAME,
  DEVICE_PASSPORT_RECORD_KEY,
  __setDevicePassportStoreForTests,
  __setDevicePassportCryptoForTests,
  __resetDevicePassportStateForTests,
} from '../lib/device-passport.ts';
import { saveReportRemote } from '../lib/reports-remote.ts';

/**
 * Device Passport — Phase 3 (browser client). Exercises the real
 * lib/device-passport.ts key lifecycle (generation, non-exportable private
 * key, IndexedDB persistence + reload, single-flight init), the register +
 * challenge requests, the exact signed-message bytes, end-to-end interop with
 * the real Phase-2 server verifier, the saveReportRemote upload integration,
 * every fail-safe path, and the privacy/structural guarantees. Disposable
 * local libSQL only.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_device_passport_client.db');
function cleanupDb() {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
}
cleanupDb();
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const originalFlag = process.env.DEVICE_PASSPORT_ENABLED;
process.env.DEVICE_PASSPORT_ENABLED = 'true';
const dbClient = createClient({ url: `file:${dbFile}` });
await dbClient.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(dbClient, drizzleDir);

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** In-memory PassportRecordStore, structured-clone in/out exactly like IndexedDB, backing survives "reload". */
function makeFakeStore(backing = new Map()) {
  let writes = 0;
  const store = {
    backing,
    get writes() { return writes; },
    async read() {
      const v = backing.get(DEVICE_PASSPORT_RECORD_KEY);
      return v === undefined ? null : structuredClone(v);
    },
    async write(record) { writes += 1; backing.set(DEVICE_PASSPORT_RECORD_KEY, structuredClone(record)); },
    async clear() { backing.delete(DEVICE_PASSPORT_RECORD_KEY); },
  };
  return store;
}

/** A tiny but faithful in-memory IndexedDB (async callbacks, structured clone, persistent across open()). */
function createFakeIndexedDB() {
  const databases = new Map();
  function later(fn) { queueMicrotask(fn); }
  return {
    _databases: databases,
    deleteDatabase(name) {
      const req = { onsuccess: null, onerror: null };
      later(() => { databases.delete(name); req.onsuccess && req.onsuccess(); });
      return req;
    },
    open(name, version) {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null, error: null };
      later(() => {
        let db = databases.get(name);
        if (!db) { db = { version: 0, stores: new Map() }; databases.set(name, db); }
        const handle = {
          objectStoreNames: { contains: (s) => db.stores.has(s) },
          createObjectStore: (s) => { if (!db.stores.has(s)) db.stores.set(s, new Map()); return {}; },
          transaction: (storeName, mode = 'readonly') => {
            const key = Array.isArray(storeName) ? storeName[0] : storeName;
            const map = db.stores.get(key);
            const tx = { error: null, onabort: null, oncomplete: null };
            tx.objectStore = () => ({
              get: (k) => {
                const r = { onsuccess: null, onerror: null, result: undefined, error: null };
                later(() => {
                  if (!map) { r.error = new Error('no such store'); r.onerror && r.onerror(); return; }
                  r.result = map.has(k) ? structuredClone(map.get(k)) : undefined;
                  r.onsuccess && r.onsuccess();
                });
                return r;
              },
              put: (value, k) => {
                const r = { onsuccess: null, onerror: null, result: undefined, error: null };
                later(() => {
                  if (mode !== 'readwrite' || !map) { r.error = new Error('cannot write'); r.onerror && r.onerror(); return; }
                  map.set(k, structuredClone(value));
                  r.result = k;
                  r.onsuccess && r.onsuccess();
                });
                return r;
              },
              delete: (k) => {
                const r = { onsuccess: null, onerror: null, result: undefined, error: null };
                later(() => { if (map) map.delete(k); r.onsuccess && r.onsuccess(); });
                return r;
              },
            });
            return tx;
          },
          close: () => {},
        };
        if (version !== undefined && version > db.version) {
          db.version = version;
          req.result = handle;
          req.onupgradeneeded && req.onupgradeneeded({ oldVersion: 0, newVersion: version });
          req.onsuccess && req.onsuccess();
        } else {
          req.result = handle;
          req.onsuccess && req.onsuccess();
        }
      });
      return req;
    },
  };
}

function stubWindowLocalStorage() {
  const original = globalThis.window;
  const map = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
    },
  };
  return () => { globalThis.window = original; };
}

/** fetch stub that routes device-passport calls to the REAL Next route handlers against the test DB. */
function installRouteBackedFetch({ onReports } = {}) {
  const original = globalThis.fetch;
  const calls = { register: [], challenge: [], reports: [] };
  let ipSeq = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const ip = `dpc-${++ipSeq}`;
    await resetRateForTest(ip);
    const headers = { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'x-forwarded-for': ip };
    if (u.endsWith('/api/device-passport/register')) {
      calls.register.push({ init });
      return registerRoute.POST(new Request('http://localhost/api/device-passport/register', { method: 'POST', headers, body: init.body }));
    }
    if (u.endsWith('/api/device-passport/challenge')) {
      calls.challenge.push({ init });
      return challengeRoute.POST(new Request('http://localhost/api/device-passport/challenge', { method: 'POST', headers }));
    }
    if (u.endsWith('/api/reports')) {
      calls.reports.push({ init, body: init.body ? JSON.parse(init.body) : null });
      if (onReports) return onReports(init);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return original(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** fetch stub with fully canned responses (no DB). `plan` maps an endpoint suffix to a Response factory. */
function installCannedFetch(plan) {
  const original = globalThis.fetch;
  const calls = { register: [], challenge: [], reports: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/device-passport/register')) { calls.register.push({ init }); return plan.register(init); }
    if (u.endsWith('/api/device-passport/challenge')) { calls.challenge.push({ init }); return plan.challenge(init); }
    if (u.endsWith('/api/reports')) {
      calls.reports.push({ init, body: init.body ? JSON.parse(init.body) : null });
      return (plan.reports ? plan.reports(init) : new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return original(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const okResponse = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const notFoundResponse = () => new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: { 'content-type': 'application/json' } });

/**
 * Like installCannedFetch, but every responder lives on a mutable `control`
 * object so a multi-step test can change one endpoint's behaviour mid-run
 * (e.g. POST /api/reports fails, then succeeds on retry).
 */
function installScriptedFetch(control) {
  const original = globalThis.fetch;
  const calls = { register: [], challenge: [], reports: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/device-passport/register')) { calls.register.push({ init, body: init.body ? JSON.parse(init.body) : null }); return control.register(init); }
    if (u.endsWith('/api/device-passport/challenge')) { calls.challenge.push({ init }); return control.challenge(init); }
    if (u.endsWith('/api/reports')) { calls.reports.push({ init, body: init.body ? JSON.parse(init.body) : null }); return control.reports(init); }
    return original(url, init);
  };
  return { calls, control, restore: () => { globalThis.fetch = original; } };
}

function freshBase64Nonce() {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) b[i] = Math.floor(Math.random() * 256);
  return Buffer.from(b).toString('base64');
}

test.afterEach(() => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(null);
  __setDevicePassportCryptoForTests(undefined);
});

test.after(() => {
  dbClient.close();
  delete process.env.TURSO_DATABASE_URL;
  if (originalFlag === undefined) delete process.env.DEVICE_PASSPORT_ENABLED; else process.env.DEVICE_PASSPORT_ENABLED = originalFlag;
  cleanupDb();
});

// ---------------------------------------------------------------------------
// 1-3: key generation + exportability
// ---------------------------------------------------------------------------

test('1: ensureDevicePassport generates a P-256 ECDSA non-exportable private key with usage ["sign"]', async () => {
  __resetDevicePassportStateForTests();
  const store = makeFakeStore();
  __setDevicePassportStoreForTests(store);
  const { restore } = installCannedFetch({ register: () => okResponse({ ok: true }), challenge: () => notFoundResponse() });
  try {
    const loaded = await ensureDevicePassport();
    assert.ok(loaded, 'a passport is produced');
    const rec = store.backing.get(DEVICE_PASSPORT_RECORD_KEY);
    assert.equal(rec.version, 1);
    assert.equal(rec.privateKey.type, 'private');
    assert.equal(rec.privateKey.extractable, false, 'private key MUST be non-exportable');
    assert.equal(rec.privateKey.algorithm.name, 'ECDSA');
    assert.equal(rec.privateKey.algorithm.namedCurve, 'P-256');
    assert.deepEqual(rec.privateKey.usages, ['sign']);
  } finally {
    restore();
  }
});

test('2: the stored public key exports as a valid EC P-256 SubjectPublicKeyInfo', async () => {
  __resetDevicePassportStateForTests();
  const store = makeFakeStore();
  __setDevicePassportStoreForTests(store);
  const { restore } = installCannedFetch({ register: () => okResponse({ ok: true }), challenge: () => notFoundResponse() });
  try {
    const loaded = await ensureDevicePassport();
    assert.ok(parseAndValidateSpki(loaded.publicKeySpki), 'server accepts the exported SPKI as EC P-256');
    assert.equal(Buffer.from(loaded.publicKeySpki, 'base64').length, 91, 'a P-256 SPKI DER is 91 bytes');
  } finally {
    restore();
  }
});

test('3: the private key genuinely cannot be exported', async () => {
  __resetDevicePassportStateForTests();
  const store = makeFakeStore();
  __setDevicePassportStoreForTests(store);
  const { restore } = installCannedFetch({ register: () => okResponse({ ok: true }), challenge: () => notFoundResponse() });
  try {
    await ensureDevicePassport();
    const rec = store.backing.get(DEVICE_PASSPORT_RECORD_KEY);
    await assert.rejects(() => crypto.subtle.exportKey('pkcs8', rec.privateKey), 'exporting the private key must throw');
    await assert.rejects(() => crypto.subtle.exportKey('jwk', rec.privateKey));
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 4-6: persistence, reuse, concurrency
// ---------------------------------------------------------------------------

test('4: the key survives an IndexedDB "reload" — same identity, still non-exportable, still signs', async () => {
  const backing = new Map();
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore(backing));
  let plan = { register: () => okResponse({ ok: true }), challenge: () => notFoundResponse() };
  let f = installCannedFetch(plan);
  const first = await ensureDevicePassport();
  f.restore();

  // simulate a fresh page load: module state cleared, IndexedDB (backing) intact
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore(backing));
  f = installCannedFetch(plan);
  try {
    const second = await ensureDevicePassport();
    assert.equal(second.publicKeySpki, first.publicKeySpki, 'the same passport public key comes back after reload');
    const rec = backing.get(DEVICE_PASSPORT_RECORD_KEY);
    assert.equal(rec.privateKey.extractable, false);
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rec.privateKey, new Uint8Array([1, 2, 3]));
    assert.equal(sig.byteLength, 64, 'the reloaded private key still produces P-256 signatures');
  } finally {
    f.restore();
  }
});

test('5: repeated initialization within one session reuses the same key — no regeneration, one write', async () => {
  __resetDevicePassportStateForTests();
  const store = makeFakeStore();
  __setDevicePassportStoreForTests(store);
  const { restore } = installCannedFetch({ register: () => okResponse({ ok: true }), challenge: () => notFoundResponse() });
  try {
    const a = await ensureDevicePassport();
    const b = await ensureDevicePassport();
    const c = await ensureDevicePassport();
    assert.equal(a.publicKeySpki, b.publicKeySpki);
    assert.equal(b.publicKeySpki, c.publicKeySpki);
    assert.equal(store.writes, 1, 'the key is generated + persisted exactly once');
    assert.equal(store.backing.size, 1);
  } finally {
    restore();
  }
});

test('6: simultaneous initialization produces exactly one identity (single-flight mutex)', async () => {
  __resetDevicePassportStateForTests();
  const store = makeFakeStore();
  __setDevicePassportStoreForTests(store);
  const { calls, restore } = installCannedFetch({ register: () => okResponse({ ok: true }), challenge: () => notFoundResponse() });
  try {
    const results = await Promise.all([
      ensureDevicePassport(), ensureDevicePassport(), ensureDevicePassport(),
      ensureDevicePassport(), ensureDevicePassport(),
    ]);
    const distinct = new Set(results.map((r) => r?.publicKeySpki));
    assert.equal(distinct.size, 1, 'every concurrent caller gets the same one key');
    assert.equal(store.writes, 1, 'only one key was ever generated + written');
    assert.equal(store.backing.size, 1);
    assert.equal(calls.register.length, 1, 'registration is attempted exactly once, not once per caller');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 7-9: register / challenge / signed-message contract
// ---------------------------------------------------------------------------

test('7: the registration request is POST /api/device-passport/register, same-origin, { publicKeySpki } only', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const { calls, restore } = installCannedFetch({ register: () => okResponse({ ok: true }), challenge: () => notFoundResponse() });
  try {
    const loaded = await ensureDevicePassport();
    assert.equal(calls.register.length, 1);
    const { init } = calls.register[0];
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body), ['publicKeySpki']);
    assert.equal(body.publicKeySpki, loaded.publicKeySpki);
    assert.ok(parseAndValidateSpki(body.publicKeySpki), 'the registered key is a real EC P-256 SPKI');
  } finally {
    restore();
  }
});

test('8: the challenge request is POST /api/device-passport/challenge, same-origin', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const { calls, restore } = installCannedFetch({
    register: () => okResponse({ ok: true }),
    challenge: () => okResponse({ challengeId: 'c-8', nonce: freshBase64Nonce() }),
  });
  try {
    const att = await buildDevicePassportAttestation({ reportId: 'r-8', payloadText: 'hello world' });
    assert.ok(att, 'attestation built');
    assert.equal(calls.challenge.length, 1);
    assert.equal(calls.challenge[0].init.method, 'POST');
    assert.equal(calls.challenge[0].init.credentials, 'same-origin');
  } finally {
    restore();
  }
});

test('9: the client signed-message bytes are byte-identical to the Phase-2 server contract', async () => {
  assert.equal(CLIENT_SIGNED_MESSAGE_VERSION, DEVICE_PASSPORT_SIGNED_MESSAGE_VERSION, 'the version prefix constant is locked to the server');
  const params = {
    nonceBase64: freshBase64Nonce(),
    challengeId: 'challenge-abc-123',
    method: 'POST',
    path: '/api/reports',
    payloadTextSha256Hex: sha256Hex(Buffer.from('the exact document body', 'utf8')),
    reportId: 'report-xyz-789',
  };
  const clientBytes = Buffer.from(buildDevicePassportSignedMessageBytes(params));
  const serverBytes = buildDevicePassportSignedMessage(params);
  assert.ok(clientBytes.equals(serverBytes), 'client and server produce identical signed-message bytes');
  assert.equal(
    clientBytes.toString('utf8'),
    `TP_DEVICE_PASSPORT_V1\n${params.nonceBase64}\n${params.challengeId}\nPOST\n/api/reports\n${params.payloadTextSha256Hex}\n${params.reportId}`,
  );
});

// ---------------------------------------------------------------------------
// 10-11: end-to-end interop with the real server verifier
// ---------------------------------------------------------------------------

test('10: the real Phase-2 verifier accepts a browser-generated attestation end to end', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const { restore } = installRouteBackedFetch();
  try {
    const reportId = 'interop-report-1';
    const payloadText = 'a genuine document body submitted through the real pipeline';
    const att = await buildDevicePassportAttestation({ reportId, payloadText });
    assert.ok(att, 'the browser built an attestation');

    // the register call really inserted the passport
    const expectedId = derivePassportId(new Uint8Array(Buffer.from(att.publicKeySpki, 'base64')));
    const passportRow = (await dbClient.execute({ sql: 'SELECT id FROM device_passports WHERE id = ?', args: [expectedId] })).rows[0];
    assert.ok(passportRow, 'the public key was registered by the client');

    const verified = await verifyDevicePassportAttestation(dbClient, {
      challengeId: att.challengeId,
      nonce: att.nonce,
      publicKeySpki: att.publicKeySpki,
      signature: att.signature,
      method: 'POST',
      path: '/api/reports',
      payloadText,
      reportId,
      currentAccountId: null,
      currentSessionTokenHash: null,
    });
    assert.equal(verified, expectedId, 'the server verified the browser signature and returned the passport id');
  } finally {
    restore();
  }
});

test('11: the server rejects the attestation when the bound text is tampered', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const { restore } = installRouteBackedFetch();
  try {
    const att = await buildDevicePassportAttestation({ reportId: 'interop-report-2', payloadText: 'the original body' });
    assert.ok(att);
    const verified = await verifyDevicePassportAttestation(dbClient, {
      challengeId: att.challengeId,
      nonce: att.nonce,
      publicKeySpki: att.publicKeySpki,
      signature: att.signature,
      method: 'POST',
      path: '/api/reports',
      payloadText: 'the TAMPERED body',
      reportId: 'interop-report-2',
      currentAccountId: null,
      currentSessionTokenHash: null,
    });
    assert.equal(verified, null, 'a signature bound to different text must not verify');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 12-14: saveReportRemote upload integration
// ---------------------------------------------------------------------------

function minimalSummary(id) {
  return { id, submissionId: 's', title: 't.pdf', createdAt: new Date().toISOString(), wordCount: 4, archiveScore: 0, scoreBand: 'Low', aiScore: null, aiTone: null };
}

test('12: saveReportRemote attaches the devicePassport attestation on the first save', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const restoreWindow = stubWindowLocalStorage();
  const { calls, restore } = installCannedFetch({
    register: () => okResponse({ ok: true }),
    challenge: () => okResponse({ challengeId: 'c-12', nonce: freshBase64Nonce() }),
  });
  try {
    const report = { id: 'up-12', text: 'the exact submitted document text', wordCount: 4 };
    const result = await saveReportRemote(report, minimalSummary('up-12'));
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.reports.length, 1);
    const body = calls.reports[0].body;
    assert.ok(body.devicePassport, 'the first save carries an attestation');
    assert.deepEqual(Object.keys(body.devicePassport).sort(), ['challengeId', 'nonce', 'publicKeySpki', 'signature']);
    assert.equal(body.devicePassport.challengeId, 'c-12');
    assert.equal(Buffer.from(body.devicePassport.signature, 'base64').length, 64);

    // a resave of the SAME report id issues no new challenge and attaches nothing
    const resave = await saveReportRemote({ ...report, text: report.text }, minimalSummary('up-12'));
    assert.deepEqual(resave, { ok: true });
    assert.equal(calls.challenge.length, 1, 'no second challenge request for a resave');
    assert.equal(calls.reports[1].body.devicePassport, undefined, 'the resave carries no attestation');
  } finally {
    restore();
    restoreWindow();
  }
});

test('13: the signature is bound to the EXACT payload.text that is sent', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const restoreWindow = stubWindowLocalStorage();
  const nonce = freshBase64Nonce();
  const { calls, restore } = installCannedFetch({
    register: () => okResponse({ ok: true }),
    challenge: () => okResponse({ challengeId: 'c-13', nonce }),
  });
  try {
    const text = 'precisely these characters — Ünïcodë, symbols: \n\t and more.';
    await saveReportRemote({ id: 'up-13', text }, minimalSummary('up-13'));
    const body = calls.reports[0].body;
    assert.equal(body.payload.text, text, 'the text in the body is unchanged');

    const dp = body.devicePassport;
    const message = buildDevicePassportSignedMessage({
      nonceBase64: dp.nonce,
      challengeId: dp.challengeId,
      method: 'POST',
      path: '/api/reports',
      payloadTextSha256Hex: sha256Hex(Buffer.from(body.payload.text, 'utf8')),
      reportId: body.id,
    });
    const pub = createPublicKey({ key: Buffer.from(dp.publicKeySpki, 'base64'), format: 'der', type: 'spki' });
    const okSig = nodeVerify('sha256', message, { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(dp.signature, 'base64'));
    assert.equal(okSig, true, 'the signature verifies against sha256 of the exact sent text');

    const tampered = buildDevicePassportSignedMessage({
      nonceBase64: dp.nonce, challengeId: dp.challengeId, method: 'POST', path: '/api/reports',
      payloadTextSha256Hex: sha256Hex(Buffer.from(`${body.payload.text} `, 'utf8')), reportId: body.id,
    });
    assert.equal(
      nodeVerify('sha256', tampered, { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(dp.signature, 'base64')),
      false,
      'the same signature must not verify against even a one-space-different text',
    );
  } finally {
    restore();
    restoreWindow();
  }
});

test('14: feature endpoint 404 (flag off) → the upload proceeds normally with no attestation', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const restoreWindow = stubWindowLocalStorage();
  const { calls, restore } = installCannedFetch({ register: () => notFoundResponse(), challenge: () => notFoundResponse() });
  try {
    const result = await saveReportRemote({ id: 'up-14', text: 'body' }, minimalSummary('up-14'));
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.reports.length, 1);
    assert.equal(calls.reports[0].body.devicePassport, undefined, 'a 404 from the feature endpoints yields no attestation');
    assert.ok(calls.reports[0].body.deviceKey, 'the ordinary deviceKey is still sent');
  } finally {
    restore();
    restoreWindow();
  }
});

// ---------------------------------------------------------------------------
// 15-18: fail-safe + recovery
// ---------------------------------------------------------------------------

test('15: IndexedDB unavailable → upload proceeds normally, no attestation, no crash', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(null); // real store; no globalThis.indexedDB in Node
  assert.equal(globalThis.indexedDB, undefined);
  const restoreWindow = stubWindowLocalStorage();
  const { calls, restore } = installCannedFetch({
    register: () => { throw new Error('should never be called'); },
    challenge: () => { throw new Error('should never be called'); },
  });
  try {
    const result = await saveReportRemote({ id: 'up-15', text: 'body' }, minimalSummary('up-15'));
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.reports[0].body.devicePassport, undefined);
    assert.equal(calls.register.length, 0);
    assert.equal(calls.challenge.length, 0);
  } finally {
    restore();
    restoreWindow();
  }
});

test('16: WebCrypto unavailable → upload proceeds normally, no attestation', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  __setDevicePassportCryptoForTests(null); // force "no WebCrypto"
  const restoreWindow = stubWindowLocalStorage();
  const { calls, restore } = installCannedFetch({
    register: () => { throw new Error('should never be called'); },
    challenge: () => { throw new Error('should never be called'); },
  });
  try {
    const result = await saveReportRemote({ id: 'up-16', text: 'body' }, minimalSummary('up-16'));
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.reports[0].body.devicePassport, undefined);
  } finally {
    restore();
    restoreWindow();
  }
});

test('17: a signing failure → upload proceeds normally, no attestation', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const real = crypto.subtle;
  __setDevicePassportCryptoForTests({
    generateKey: real.generateKey.bind(real),
    exportKey: real.exportKey.bind(real),
    digest: real.digest.bind(real),
    // the 1-byte probe still signs; the real (longer) attestation message throws
    sign: async (algo, key, data) => {
      const len = data.byteLength ?? data.length ?? 0;
      if (len > 1) throw new Error('simulated signing failure');
      return real.sign(algo, key, data);
    },
  });
  const restoreWindow = stubWindowLocalStorage();
  const { calls, restore } = installCannedFetch({
    register: () => okResponse({ ok: true }),
    challenge: () => okResponse({ challengeId: 'c-17', nonce: freshBase64Nonce() }),
  });
  try {
    const result = await saveReportRemote({ id: 'up-17', text: 'body' }, minimalSummary('up-17'));
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.reports[0].body.devicePassport, undefined, 'a signing failure yields no attestation');
  } finally {
    restore();
    restoreWindow();
  }
});

test('18: a corrupt stored passport record is discarded (only that record), a fresh key generated + re-registered', async () => {
  __resetDevicePassportStateForTests();
  const backing = new Map();
  // pre-seed a structurally-broken record + an unrelated sibling key that must survive
  backing.set(DEVICE_PASSPORT_RECORD_KEY, { version: 1, privateKey: 'not-a-key', publicKeySpki: 'garbage' });
  backing.set('unrelated-turnitplus-key', { keep: true });
  __setDevicePassportStoreForTests(makeFakeStore(backing));
  const { calls, restore } = installCannedFetch({ register: () => okResponse({ ok: true }), challenge: () => notFoundResponse() });
  try {
    const loaded = await ensureDevicePassport();
    assert.ok(loaded, 'recovery produced a usable passport');
    assert.ok(parseAndValidateSpki(loaded.publicKeySpki), 'the regenerated key is a real EC P-256 SPKI');
    const rec = backing.get(DEVICE_PASSPORT_RECORD_KEY);
    assert.notEqual(rec.privateKey, 'not-a-key');
    assert.equal(rec.privateKey.type, 'private');
    assert.equal(rec.privateKey.extractable, false);
    assert.equal(calls.register.length, 1, 'the recovered key is registered again');
    assert.deepEqual(backing.get('unrelated-turnitplus-key'), { keep: true }, 'no other stored key is touched');
  } finally {
    restore();
  }
});

test('18b: a structurally valid record whose key cannot sign is also treated as corrupt and replaced', async () => {
  __resetDevicePassportStateForTests();
  const backing = new Map();
  backing.set(DEVICE_PASSPORT_RECORD_KEY, {
    version: 1,
    publicKeySpki: 'AAAA',
    privateKey: { type: 'private', extractable: false, algorithm: { name: 'ECDSA', namedCurve: 'P-256' }, usages: ['sign'] },
  });
  __setDevicePassportStoreForTests(makeFakeStore(backing));
  const { restore } = installCannedFetch({ register: () => okResponse({ ok: true }), challenge: () => notFoundResponse() });
  try {
    const loaded = await ensureDevicePassport();
    assert.ok(loaded);
    assert.ok(parseAndValidateSpki(loaded.publicKeySpki));
    assert.notEqual(loaded.publicKeySpki, 'AAAA');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 15b: the real IndexedDB store implementation (via the fake IDB global)
// ---------------------------------------------------------------------------

test('the real createIndexedDbPassportStore path round-trips and persists across open()', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(null);
  const originalIdb = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  const { restore } = installCannedFetch({ register: () => okResponse({ ok: true }), challenge: () => notFoundResponse() });
  try {
    const first = await ensureDevicePassport();
    assert.ok(first, 'IndexedDB-backed init works');
    const dbData = globalThis.indexedDB._databases.get(DEVICE_PASSPORT_DB_NAME);
    assert.ok(dbData.stores.get(DEVICE_PASSPORT_STORE_NAME).has(DEVICE_PASSPORT_RECORD_KEY), 'the record is in the dedicated store');

    // reload (new module state, same fake-IDB backing)
    __resetDevicePassportStateForTests();
    const second = await ensureDevicePassport();
    assert.equal(second.publicKeySpki, first.publicKeySpki, 'the IndexedDB-persisted key survives a reload');
  } finally {
    restore();
    globalThis.indexedDB = originalIdb;
  }
});

// ---------------------------------------------------------------------------
// 19: existing device_key behaviour unchanged
// ---------------------------------------------------------------------------

test('19: the existing localStorage device_key is untouched — still its own module, still sent on every save', async () => {
  const deviceKeySrc = fs.readFileSync(path.join(repo, 'lib/device-key.ts'), 'utf8');
  assert.match(deviceKeySrc, /tp_device_key_v1/);
  assert.doesNotMatch(deviceKeySrc, /device-passport|IndexedDB|CryptoKey/, 'device-key.ts must not gain any passport coupling');

  const remoteSrc = fs.readFileSync(path.join(repo, 'lib/reports-remote.ts'), 'utf8');
  assert.match(remoteSrc, /import \{ getDeviceKey \} from "\.\/device-key";/, 'reports-remote still uses the existing device key');
  assert.match(remoteSrc, /const deviceKey = getDeviceKey\(\);/);

  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const restoreWindow = stubWindowLocalStorage();
  const { calls, restore } = installCannedFetch({
    register: () => okResponse({ ok: true }),
    challenge: () => okResponse({ challengeId: 'c-19', nonce: freshBase64Nonce() }),
  });
  try {
    await saveReportRemote({ id: 'up-19', text: 'body' }, minimalSummary('up-19'));
    const body = calls.reports[0].body;
    assert.equal(typeof body.deviceKey, 'string');
    assert.ok(body.deviceKey.length > 0, 'the soft-scoping device key is still present alongside the passport');
    assert.equal(globalThis.window.localStorage.getItem('tp_device_key_v1'), body.deviceKey);
  } finally {
    restore();
    restoreWindow();
  }
});

// ---------------------------------------------------------------------------
// 20: privacy / structural — no passport data anywhere it should not be
// ---------------------------------------------------------------------------

test('20a: lib/device-passport.ts imports no matcher / similarity / ownership / scoring module', () => {
  const src = fs.readFileSync(path.join(repo, 'lib/device-passport.ts'), 'utf8');
  const importLines = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l)).join('\n');
  for (const forbidden of [
    'user-submission-matching', 'user-submission-corpus', 'report-primary-similarity',
    'report-historical-match', 'document-correspondence', 'unified-similarity',
    'corpus-match-generation', 'document-family', 'report-classification',
    'device-passport-server', 'node:crypto', 'summarizeSubmissionOwnership',
  ]) {
    assert.doesNotMatch(importLines, new RegExp(forbidden), `client module must not import ${forbidden}`);
  }
});

test('20b: only lib/reports-remote.ts imports lib/device-passport (no component, no other lib, no app route)', () => {
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const rel = path.relative(repo, full).split(path.sep).join('/');
      if (rel === 'lib/device-passport.ts') continue;
      const src = fs.readFileSync(full, 'utf8');
      // an import whose specifier ends exactly with `device-passport` — never
      // matches `device-passport-server` (followed by `-`, not the quote).
      if (/\bfrom\s+["'][^"']*device-passport["']/.test(src)) offenders.push(rel);
    }
  }
  for (const r of ['lib', 'app', 'components']) walk(path.join(repo, r));
  assert.deepEqual(offenders, ['lib/reports-remote.ts'], `unexpected importer(s) of lib/device-passport: ${offenders.join(', ')}`);
});

test('20c: lib/device-passport.ts has no UI — no JSX, no alert/confirm/prompt, no DOM writes', () => {
  const src = fs.readFileSync(path.join(repo, 'lib/device-passport.ts'), 'utf8');
  for (const forbidden of [/\balert\s*\(/, /\bconfirm\s*\(/, /\bprompt\s*\(/, /document\./, /\.innerHTML/, /window\.localStorage/, /React/, /return\s*</]) {
    assert.doesNotMatch(src, forbidden, `client module must stay headless: ${forbidden}`);
  }
});

test('20d: a verified upload leaks no passport data back into the ordinary report list response', async () => {
  // Persist a report carrying a real attestation through the REAL POST
  // /api/reports, then read it back the ordinary (device-key) way.
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const restoreWindow = stubWindowLocalStorage();
  const { calls, restore } = installRouteBackedFetch({
    onReports: async (init) => {
      const ip = `dpc-report-${Math.random().toString(36).slice(2)}`;
      await resetRateForTest(ip);
      return reportsRoute.POST(new Request('http://localhost/api/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, origin: 'http://localhost', host: 'localhost' },
        body: init.body,
      }));
    },
  });
  try {
    const reportId = 'leak-check-1';
    const text = 'the private body for the leak check';
    const report = { version: 11, id: reportId, submissionId: 's', title: 't.pdf', created: new Date().toISOString(), score: 0, wordCount: 6, text };
    const saveRes = await saveReportRemote(report, { ...minimalSummary(reportId), wordCount: 6 });
    assert.deepEqual(saveRes, { ok: true }, 'the real POST /api/reports accepted the upload');

    const realDeviceKey = globalThis.window.localStorage.getItem('tp_device_key_v1');
    const stored = (await dbClient.execute({
      sql: 'SELECT verified_device_passport_id FROM saved_reports WHERE device_key = ? AND id = ?',
      args: [realDeviceKey, reportId],
    })).rows[0];
    assert.ok(stored && stored.verified_device_passport_id, 'sanity: provenance WAS captured server-side');

    const att = calls.reports.at(-1).body.devicePassport;
    assert.ok(att, 'the upload really carried an attestation');
    const forbidden = [String(stored.verified_device_passport_id), att.publicKeySpki, att.signature, att.nonce, att.challengeId, 'verified_device_passport_id', 'devicePassport'];

    const ip1 = `dpc-list-${Math.random().toString(36).slice(2)}`;
    await resetRateForTest(ip1);
    const listRes = await reportsRoute.GET(new Request(`http://localhost/api/reports?deviceKey=${encodeURIComponent(realDeviceKey)}`, { headers: { 'x-forwarded-for': ip1 } }));
    const listText = await listRes.text();
    for (const s of forbidden) assert.equal(listText.includes(s), false, `report list leaked: ${s.slice(0, 20)}`);
  } finally {
    restore();
    restoreWindow();
  }
});

// ---------------------------------------------------------------------------
// RETRY CORRECTNESS — success is tracked, not "attestation attempted"
// ---------------------------------------------------------------------------

test('R1-R5: a failed first POST does not suppress the passport — the retry gets a fresh challenge + signature, and only a confirmed save stops later resaves', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const restoreWindow = stubWindowLocalStorage();
  let challengeSeq = 0;
  const ctl = installScriptedFetch({
    register: () => okResponse({ ok: true }),
    challenge: () => okResponse({ challengeId: `ch-${++challengeSeq}`, nonce: freshBase64Nonce() }),
    reports: () => new Response('boom', { status: 500 }), // attempt 1: server error
  });
  try {
    // R1: first POST fails, but it DID carry an attestation
    const r1 = await saveReportRemote({ id: 'retry-R', text: 'the document body' }, minimalSummary('retry-R'));
    assert.equal(r1.ok, false, 'the first attempt fails');
    assert.equal(ctl.calls.reports.length, 1);
    const firstDp = ctl.calls.reports[0].body.devicePassport;
    assert.ok(firstDp, 'the failed first POST still carried an attestation');
    assert.equal(ctl.calls.challenge.length, 1);

    // R2 + R3: retry the SAME reportId -> new challenge, fresh signature
    ctl.control.reports = () => okResponse({ ok: true });
    const r2 = await saveReportRemote({ id: 'retry-R', text: 'the document body' }, minimalSummary('retry-R'));
    assert.equal(r2.ok, true, 'the retry succeeds');
    assert.equal(ctl.calls.challenge.length, 2, 'R2: the retry obtained a NEW challenge');
    const retryDp = ctl.calls.reports[1].body.devicePassport;
    assert.ok(retryDp, 'the retry re-attached a passport attestation');
    assert.notEqual(retryDp.challengeId, firstDp.challengeId, 'R2: a different challenge id');
    assert.notEqual(retryDp.nonce, firstDp.nonce, 'R3: a different nonce');
    assert.notEqual(retryDp.signature, firstDp.signature, 'R3: a fresh signature');

    // R4 + R5: now that the save is confirmed, a later AI/resave attaches nothing
    const r3 = await saveReportRemote({ id: 'retry-R', text: 'the document body' }, minimalSummary('retry-R'));
    assert.equal(r3.ok, true);
    assert.equal(ctl.calls.challenge.length, 2, 'R4/R5: no new challenge for a resave after a confirmed save');
    assert.equal(ctl.calls.reports[2].body.devicePassport, undefined, 'R5: the resave carries no attestation');
  } finally {
    ctl.restore();
    restoreWindow();
  }
});

test('R6: a lost first-POST response (server actually saved it) — the retry is safe and never overwrites the captured provenance', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const restoreWindow = stubWindowLocalStorage();
  let dropNextReportsResponse = true;
  const { calls, restore } = installRouteBackedFetch({
    onReports: async (init) => {
      const ip = `dpc-r6-${Math.random().toString(36).slice(2)}`;
      await resetRateForTest(ip);
      const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, origin: 'http://localhost', host: 'localhost' },
        body: init.body,
      }));
      if (dropNextReportsResponse) { dropNextReportsResponse = false; throw new TypeError('Failed to fetch'); } // response lost after the server processed it
      return res;
    },
  });
  try {
    const reportId = 'r6-report';
    const text = 'the body whose captured provenance must survive a retry';
    const report = { version: 11, id: reportId, submissionId: 's', title: 't.pdf', created: new Date().toISOString(), score: 0, wordCount: 9, text };
    const summary = { ...minimalSummary(reportId), wordCount: 9 };

    const first = await saveReportRemote(report, summary);
    assert.equal(first.ok, false, 'the client saw the lost response as a failure');

    const dk = globalThis.window.localStorage.getItem('tp_device_key_v1');
    const afterFirst = (await dbClient.execute({
      sql: 'SELECT verified_device_passport_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [dk, reportId],
    })).rows[0];
    assert.ok(afterFirst && afterFirst.verified_device_passport_id, 'the server DID persist the first save + its device provenance');
    const originalProvenance = String(afterFirst.verified_device_passport_id);

    const retry = await saveReportRemote(report, summary);
    assert.equal(retry.ok, true, 'the retry succeeds');
    assert.ok(calls.reports.at(-1).body.devicePassport, 'the retry re-attached a fresh attestation (the client had no way to know)');

    const rows = (await dbClient.execute({
      sql: 'SELECT verified_device_passport_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [dk, reportId],
    })).rows;
    assert.equal(rows.length, 1, 'still exactly one report row — the retry is not a second report');
    assert.equal(String(rows[0].verified_device_passport_id), originalProvenance, 'the retry (a non-first save server-side) never overwrote the captured provenance');
  } finally {
    restore();
    restoreWindow();
  }
});

test('R7: a register 404 disables Device Passport for the rest of the page session — no further passport requests', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const restoreWindow = stubWindowLocalStorage();
  const ctl = installScriptedFetch({
    register: () => notFoundResponse(),
    challenge: () => { throw new Error('challenge must never be requested after a register 404'); },
    reports: () => okResponse({ ok: true }),
  });
  try {
    const a = await saveReportRemote({ id: 'r7-a', text: 'body one' }, minimalSummary('r7-a'));
    assert.equal(a.ok, true);
    assert.equal(ctl.calls.reports[0].body.devicePassport, undefined, 'no attestation once the endpoint 404s');
    assert.equal(ctl.calls.register.length, 1);
    assert.equal(ctl.calls.challenge.length, 0);

    const b = await saveReportRemote({ id: 'r7-b', text: 'body two' }, minimalSummary('r7-b'));
    assert.equal(b.ok, true);
    assert.equal(ctl.calls.register.length, 1, 'no second register request for the rest of the page session');
    assert.equal(ctl.calls.challenge.length, 0);
    assert.equal(ctl.calls.reports[1].body.devicePassport, undefined);
  } finally {
    ctl.restore();
    restoreWindow();
  }
});

test('R8: a challenge 404 also disables Device Passport for the rest of the page session', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const restoreWindow = stubWindowLocalStorage();
  const ctl = installScriptedFetch({
    register: () => okResponse({ ok: true }),
    challenge: () => notFoundResponse(),
    reports: () => okResponse({ ok: true }),
  });
  try {
    const a = await saveReportRemote({ id: 'r8-a', text: 'body one' }, minimalSummary('r8-a'));
    assert.equal(a.ok, true);
    assert.equal(ctl.calls.challenge.length, 1);
    assert.equal(ctl.calls.reports[0].body.devicePassport, undefined);

    const b = await saveReportRemote({ id: 'r8-b', text: 'body two' }, minimalSummary('r8-b'));
    assert.equal(b.ok, true);
    assert.equal(ctl.calls.challenge.length, 1, 'no second challenge request after the 404');
    assert.equal(ctl.calls.reports[1].body.devicePassport, undefined);
  } finally {
    ctl.restore();
    restoreWindow();
  }
});

test('R9: a transient challenge failure (5xx / network) does NOT permanently disable Device Passport', async () => {
  __resetDevicePassportStateForTests();
  __setDevicePassportStoreForTests(makeFakeStore());
  const restoreWindow = stubWindowLocalStorage();
  let challengeMode = '503';
  const ctl = installScriptedFetch({
    register: () => okResponse({ ok: true }),
    challenge: () => {
      if (challengeMode === '503') return new Response('unavailable', { status: 503 });
      if (challengeMode === 'throw') throw new TypeError('Failed to fetch');
      return okResponse({ challengeId: `r9-${Math.random().toString(36).slice(2)}`, nonce: freshBase64Nonce() });
    },
    reports: () => okResponse({ ok: true }),
  });
  try {
    // 5xx on report A
    const a = await saveReportRemote({ id: 'r9-a', text: 'body' }, minimalSummary('r9-a'));
    assert.equal(a.ok, true);
    assert.equal(ctl.calls.reports[0].body.devicePassport, undefined, 'no attestation while the challenge endpoint is down');

    // network throw on report B — still not permanent
    challengeMode = 'throw';
    const b = await saveReportRemote({ id: 'r9-b', text: 'body' }, minimalSummary('r9-b'));
    assert.equal(b.ok, true);
    assert.equal(ctl.calls.reports[1].body.devicePassport, undefined);

    // endpoint recovers on report C — the attestation is attached again
    challengeMode = 'ok';
    const c = await saveReportRemote({ id: 'r9-c', text: 'body' }, minimalSummary('r9-c'));
    assert.equal(c.ok, true);
    assert.equal(ctl.calls.challenge.length, 3, 'every attempt still tried the challenge endpoint');
    assert.ok(ctl.calls.reports[2].body.devicePassport, 'Device Passport recovered once the transient failure cleared');
  } finally {
    ctl.restore();
    restoreWindow();
  }
});

console.log('device-passport-client: key lifecycle + register/challenge + signing + interop + upload + fail-safe + privacy + retry-correctness passed');
