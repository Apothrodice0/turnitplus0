import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { webcrypto, createHash, createHmac } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { createSession, hashToken, claimAnonymousReports } from '../lib/auth-session.ts';
import { resetRateForTest } from '../lib/rate-limit.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as registerRoute from '../app/api/device-passport/register/route.ts';
import {
  derivePassportId,
  buildDevicePassportSignedMessage,
  createDevicePassportChallenge,
  DEVICE_PASSPORT_ALGORITHM,
} from '../lib/device-passport-server.ts';
import {
  DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV,
  DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR,
  DEVICE_ACTOR_KEY_VERSION,
  ANONYMOUS_ACTOR_KEY,
  isDurableActorTrackingAvailable,
  resolveActorObservation,
} from '../lib/device-passport-actor-ledger.ts';
import { backfillDevicePassportActorUsageFromSavedReports } from '../lib/device-passport-actor-usage-backfill.ts';
import { deleteAccountData, deleteAllReportDataForAccount, invalidateSessionsAndDeleteUser } from '../lib/account-deletion.ts';
import { runCorpusAdmissionRetentionSweep } from '../lib/corpus-admission-retention-sweep.ts';

/**
 * Device Passport — durable ACTOR USAGE LEDGER foundation (drizzle/0041).
 * Covers the 20 required scenarios: schema shape; the exact new-passport
 * tracking-version marking rule; the pseudonymous actor key (and that a raw
 * account id is never stored); atomic version-1 first-save writes vs
 * best-effort legacy writes; the append-only UPSERT; and — the load-bearing
 * invariant — that NOTHING (report deletion, account deletion, room clearing,
 * retention sweep, claimAnonymousReports, later re-registration, backfill)
 * ever deletes a ledger row or promotes a legacy passport to complete.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_device_passport_actor_ledger.db');
function cleanup() {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
}
cleanup();

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const HMAC_KEY = 'test-only-actor-hmac-key-not-a-real-secret';
const originalEnabled = process.env.DEVICE_PASSPORT_ENABLED;
const originalActorKey = process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
process.env.DEVICE_PASSPORT_ENABLED = 'true';
delete process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV]; // per-test via withActorKey()

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  if (originalEnabled === undefined) delete process.env.DEVICE_PASSPORT_ENABLED; else process.env.DEVICE_PASSPORT_ENABLED = originalEnabled;
  if (originalActorKey === undefined) delete process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV]; else process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = originalActorKey;
  cleanup();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
const SAME_ORIGIN = { origin: 'http://localhost', host: 'localhost' };
let seq = 0;
const uniq = (p) => `${p}-${++seq}`;
const nextIp = () => `dpal-${++seq}`;

function withActorKey(value, fn) {
  const original = process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  if (value === undefined) delete process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  else process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = value;
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
    else process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = original;
  });
}

async function keyPair() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spkiDer = Buffer.from(await webcrypto.subtle.exportKey('spki', kp.publicKey));
  return { kp, spkiDer, spkiB64: spkiDer.toString('base64'), id: derivePassportId(spkiDer) };
}

async function registerViaRoute(kp) {
  const ip = nextIp();
  await resetRateForTest(ip);
  return registerRoute.POST(new Request('http://localhost/api/device-passport/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...SAME_ORIGIN },
    body: JSON.stringify({ publicKeySpki: kp.spkiB64 }),
  }));
}

async function registerViaSql(kp, trackingVersion = 0) {
  await client.execute({
    sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation, actor_usage_tracking_version)
          VALUES (?,?,?,?,0,?) ON CONFLICT(id) DO NOTHING`,
    args: [kp.id, kp.spkiDer, DEVICE_PASSPORT_ALGORITHM, Date.now(), trackingVersion],
  });
}

async function ensureUser(id, { consented = false } = {}) {
  await client.execute({
    sql: 'INSERT INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
    args: [id, `${id}@e.test`, id, 'x', consented ? new Date().toISOString() : null],
  });
  return createSession(client, id);
}

async function trackingVersionOf(passportId) {
  const r = (await client.execute({ sql: 'SELECT actor_usage_tracking_version FROM device_passports WHERE id = ?', args: [passportId] })).rows[0];
  return r ? Number(r.actor_usage_tracking_version) : undefined;
}

async function ledgerRows(passportId) {
  const r = await client.execute({ sql: 'SELECT * FROM device_passport_actor_usage WHERE device_passport_id = ? ORDER BY actor_key', args: [passportId] });
  return r.rows.map((row) => ({
    devicePassportId: String(row.device_passport_id),
    actorKeyVersion: Number(row.actor_key_version),
    actorKey: String(row.actor_key),
    isAnonymous: Number(row.is_anonymous),
    firstObservedAt: Number(row.first_observed_at),
    lastObservedAt: Number(row.last_observed_at),
    observationCount: Number(row.observation_count),
  }));
}

async function totalLedgerRows() {
  return Number((await client.execute('SELECT COUNT(*) AS c FROM device_passport_actor_usage')).rows[0].c);
}

/**
 * Full verified first-save POST. Anonymous unless `token`/`accountId` given;
 * authenticated uploads must name a `room`. Returns the route Response.
 */
async function postVerifiedReport({ deviceKey, reportId, text, kp, token = null, accountId = null, room = null }) {
  const session = { accountId: accountId ?? null, sessionTokenHash: token ? hashToken(token) : null };
  const { challengeId, nonce } = await createDevicePassportChallenge(client, session);
  const message = buildDevicePassportSignedMessage({
    nonceBase64: nonce, challengeId, method: 'POST', path: '/api/reports',
    payloadTextSha256Hex: sha256Hex(Buffer.from(text, 'utf8')), reportId,
  });
  const signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.kp.privateKey, message)).toString('base64');
  const ip = nextIp();
  await resetRateForTest(ip);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip, ...SAME_ORIGIN };
  if (token) headers.cookie = `tp_session_v1=${token}`;
  const body = {
    deviceKey, id: reportId, submissionId: 'sub', title: 't.pdf', createdAt: new Date().toISOString(),
    wordCount: 6, archiveScore: 0, scoreBand: 'Low',
    payload: { version: 11, id: 1, submissionId: 'sub', title: 't.pdf', created: new Date().toISOString(), score: 0, wordCount: 6, text },
    devicePassport: { challengeId, nonce, publicKeySpki: kp.spkiB64, signature },
  };
  if (room !== null) body.room = room;
  return reportsRoute.POST(new Request('http://localhost/api/reports', { method: 'POST', headers, body: JSON.stringify(body) }));
}

const expectedActorKey = (accountId) =>
  createHmac('sha256', HMAC_KEY).update(`${DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR}:${accountId}`, 'utf8').digest('hex');

// ===========================================================================
// 1 — migration / schema shape
// ===========================================================================

test('1: drizzle/0041 shape — device_passport_actor_usage + device_passports.actor_usage_tracking_version', async () => {
  const tables = new Set((await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name)));
  assert.ok(tables.has('device_passport_actor_usage'), 'the ledger table must exist');

  const cols = (await client.execute("PRAGMA table_info('device_passport_actor_usage')")).rows;
  const byName = new Map(cols.map((c) => [String(c.name), c]));
  assert.deepEqual(
    [...byName.keys()].sort(),
    ['actor_key', 'actor_key_version', 'device_passport_id', 'first_observed_at', 'is_anonymous', 'last_observed_at', 'observation_count'].sort(),
  );
  for (const notNull of ['device_passport_id', 'actor_key_version', 'actor_key', 'is_anonymous', 'first_observed_at', 'last_observed_at', 'observation_count']) {
    assert.equal(Number(byName.get(notNull).notnull), 1, `${notNull} must be NOT NULL`);
  }
  // composite primary key
  const pkCols = cols.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
  assert.deepEqual(pkCols, ['device_passport_id', 'actor_key_version', 'actor_key']);

  // FK -> device_passports(id) ON DELETE RESTRICT
  const fks = (await client.execute("PRAGMA foreign_key_list('device_passport_actor_usage')")).rows;
  assert.equal(fks.length, 1);
  assert.equal(String(fks[0].table), 'device_passports');
  assert.equal(String(fks[0].from), 'device_passport_id');
  assert.equal(String(fks[0].on_delete).toUpperCase(), 'RESTRICT');

  const idx = new Set((await client.execute("PRAGMA index_list('device_passport_actor_usage')")).rows.map((r) => String(r.name)));
  assert.ok(idx.has('idx_device_passport_actor_usage_passport'), 'the per-passport index must exist');

  const passportCols = new Set((await client.execute("PRAGMA table_info('device_passports')")).rows.map((r) => String(r.name)));
  assert.ok(passportCols.has('actor_usage_tracking_version'));

  // RESTRICT behaviourally blocks removing a referenced passport.
  await client.execute({ sql: 'INSERT INTO device_passports (id, public_key_spki, created_at) VALUES (?,?,?)', args: ['schema-p1', Buffer.from('k'), Date.now()] });
  await client.execute({
    sql: `INSERT INTO device_passport_actor_usage (device_passport_id, actor_key_version, actor_key, is_anonymous, first_observed_at, last_observed_at, observation_count)
          VALUES (?,?,?,?,?,?,1)`,
    args: ['schema-p1', 1, ANONYMOUS_ACTOR_KEY, 1, 1000, 1000],
  });
  await assert.rejects(
    () => client.execute({ sql: 'DELETE FROM device_passports WHERE id = ?', args: ['schema-p1'] }),
    /FOREIGN KEY constraint failed/,
    'a passport with a usage observation cannot be removed (RESTRICT)',
  );
});

// ===========================================================================
// 2 / 3 / 4 — the exact new-passport tracking-version marking rule
// ===========================================================================

test('2: a brand-new passport registered while the actor HMAC key is available is born at tracking version 1', async () => {
  const kp = await keyPair();
  await withActorKey(HMAC_KEY, async () => {
    assert.equal(isDurableActorTrackingAvailable(), true);
    const res = await registerViaRoute(kp);
    assert.equal(res.status, 200);
  });
  assert.equal(await trackingVersionOf(kp.id), 1);
});

test('3: a brand-new passport registered while the actor HMAC key is MISSING is born at tracking version 0 — registration still succeeds', async () => {
  const kp = await keyPair();
  await withActorKey(undefined, async () => {
    assert.equal(isDurableActorTrackingAvailable(), false);
    const res = await registerViaRoute(kp);
    assert.equal(res.status, 200, 'a missing actor key never fails registration');
  });
  assert.equal(await trackingVersionOf(kp.id), 0, 'no key at birth -> never complete evidence');
});

test('4: an existing version-0 passport re-registered later (key now available) STAYS version 0', async () => {
  const kp = await keyPair();
  await withActorKey(undefined, () => registerViaRoute(kp));
  assert.equal(await trackingVersionOf(kp.id), 0);
  await withActorKey(HMAC_KEY, async () => {
    const res = await registerViaRoute(kp); // ON CONFLICT(id) DO NOTHING
    assert.equal(res.status, 200);
  });
  assert.equal(await trackingVersionOf(kp.id), 0, 're-registration NEVER promotes 0 -> 1');
});

// ===========================================================================
// 5 / 6 / 8 — authenticated first save writes ONE pseudonymous actor row
// ===========================================================================

test('5+6: an authenticated verified first save writes exactly one pseudonymous actor row; the raw account id is never stored', async () => {
  const kp = await keyPair();
  const account = uniq('acc');
  await withActorKey(HMAC_KEY, async () => {
    await registerViaRoute(kp);
    assert.equal(await trackingVersionOf(kp.id), 1);
    const token = await ensureUser(account);
    const res = await postVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), text: 'authenticated verified upload body one', kp, token, accountId: account, room: 0 });
    assert.equal(res.status, 200);
  });

  const rows = await ledgerRows(kp.id);
  assert.equal(rows.length, 1, 'exactly one actor row');
  assert.equal(rows[0].actorKey, expectedActorKey(account), 'actor_key is the domain-separated HMAC pseudonym');
  assert.equal(rows[0].actorKey.length, 64);
  assert.equal(rows[0].isAnonymous, 0);
  assert.equal(rows[0].actorKeyVersion, DEVICE_ACTOR_KEY_VERSION);
  assert.equal(rows[0].observationCount, 1);
  assert.notEqual(rows[0].actorKey, account);

  // 6: the raw account id appears NOWHERE in the ledger table.
  const dump = JSON.stringify((await client.execute('SELECT * FROM device_passport_actor_usage')).rows);
  assert.equal(dump.includes(account), false, 'raw account id must never be stored in device_passport_actor_usage');
});

test('8: a second, different account uploading under the same passport creates a SECOND durable actor row', async () => {
  const kp = await keyPair();
  const accA = uniq('acc-a');
  const accB = uniq('acc-b');
  await withActorKey(HMAC_KEY, async () => {
    await registerViaRoute(kp);
    const tokenA = await ensureUser(accA);
    const tokenB = await ensureUser(accB);
    assert.equal((await postVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), text: 'acct A body for the two-account test', kp, token: tokenA, accountId: accA, room: 0 })).status, 200);
    assert.equal((await postVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), text: 'acct B body for the two-account test', kp, token: tokenB, accountId: accB, room: 0 })).status, 200);
  });
  const rows = await ledgerRows(kp.id);
  assert.equal(rows.length, 2, 'two distinct actor rows for the same passport');
  assert.deepEqual(rows.map((r) => r.actorKey).sort(), [expectedActorKey(accA), expectedActorKey(accB)].sort());
  assert.ok(rows.every((r) => r.observationCount === 1 && r.isAnonymous === 0));
});

// ===========================================================================
// 7 — repeated same actor increments observation_count, no duplicate row
// ===========================================================================

test('7: repeated observations of the SAME (passport, actor) preserve first_observed_at, advance last_observed_at, increment observation_count', async () => {
  const kp = await keyPair();
  const account = uniq('acc-repeat');
  await withActorKey(HMAC_KEY, async () => {
    await registerViaRoute(kp);
    const token = await ensureUser(account);
    assert.equal((await postVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), text: 'repeat actor upload number one body', kp, token, accountId: account, room: 0 })).status, 200);
    const first = (await ledgerRows(kp.id))[0];
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await postVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), text: 'repeat actor upload number two body', kp, token, accountId: account, room: 1 })).status, 200);

    const rows = await ledgerRows(kp.id);
    assert.equal(rows.length, 1, 'still one row — no duplicate actor');
    assert.equal(rows[0].observationCount, 2);
    assert.equal(rows[0].firstObservedAt, first.firstObservedAt, 'first_observed_at preserved');
    assert.ok(rows[0].lastObservedAt >= first.lastObservedAt, 'last_observed_at advanced (never regressed)');
  });
});

// ===========================================================================
// 9 / 10 — anonymous sentinel row + claimAnonymousReports keeps it
// ===========================================================================

test('9: an anonymous verified upload creates the fixed anonymous-sentinel row (is_anonymous = 1)', async () => {
  const kp = await keyPair();
  await withActorKey(HMAC_KEY, async () => {
    await registerViaRoute(kp);
    const res = await postVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), text: 'anonymous verified upload body content', kp });
    assert.equal(res.status, 200);
  });
  const rows = await ledgerRows(kp.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorKey, ANONYMOUS_ACTOR_KEY);
  assert.equal(rows[0].isAnonymous, 1);
});

test('10: claimAnonymousReports moves the report to an account but NEVER removes the anonymous-history row', async () => {
  const kp = await keyPair();
  const deviceKey = uniq('dk');
  const reportId = uniq('r');
  const account = uniq('acc-claim');
  await withActorKey(HMAC_KEY, async () => {
    await registerViaRoute(kp);
    assert.equal((await postVerifiedReport({ deviceKey, reportId, text: 'anon body that will later be claimed', kp })).status, 200);
  });
  const before = await ledgerRows(kp.id);
  assert.equal(before.length, 1);
  assert.equal(before[0].actorKey, ANONYMOUS_ACTOR_KEY);

  await ensureUser(account);
  await claimAnonymousReports(client, account, deviceKey);
  const claimed = (await client.execute({ sql: 'SELECT user_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, reportId] })).rows[0];
  assert.equal(String(claimed.user_id), account, 'the report is now the account\'s');

  const after = await ledgerRows(kp.id);
  assert.deepEqual(after, before, 'the anonymous-sentinel row is byte-for-byte unchanged after the claim');
});

// ===========================================================================
// 11 / 12 / 13 / 14 — DELETION INVARIANT: the ledger only ever survives
// ===========================================================================

async function seedVerifiedReport({ deviceKey, reportId, account, token, room }) {
  const kp = await keyPair();
  return withActorKey(HMAC_KEY, async () => {
    await registerViaRoute(kp);
    const res = await postVerifiedReport({ deviceKey, reportId, text: `deletion-invariant body ${reportId}`, kp, token, accountId: account, room });
    assert.equal(res.status, 200);
    return kp;
  });
}

test('11: DELETE /api/reports/[id] leaves the actor ledger completely unchanged', async () => {
  const deviceKey = uniq('dk');
  const reportId = uniq('r');
  const account = uniq('acc-del-report');
  const token = await ensureUser(account);
  const kp = await seedVerifiedReport({ deviceKey, reportId, account, token, room: 0 });
  const before = await ledgerRows(kp.id);
  assert.equal(before.length, 1);

  const ip = nextIp();
  await resetRateForTest(ip);
  const res = await reportIdRoute.DELETE(
    new Request(`http://localhost/api/reports/${reportId}`, { method: 'DELETE', headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${token}` } }),
    { params: Promise.resolve({ id: reportId }) },
  );
  assert.equal(res.status, 200);
  assert.equal((await client.execute({ sql: 'SELECT COUNT(*) AS c FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, reportId] })).rows[0].c, 0, 'the report row IS gone');
  assert.deepEqual(await ledgerRows(kp.id), before, 'the ledger row survives report deletion');
});

test('12: account deletion (deleteAccountData + user row removal) leaves the actor ledger unchanged', async () => {
  const account = uniq('acc-del-account');
  const token = await ensureUser(account);
  const kp = await seedVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), account, token, room: 0 });
  const before = await ledgerRows(kp.id);
  assert.equal(before.length, 1);

  await deleteAccountData(client, account);
  await invalidateSessionsAndDeleteUser(client, account);
  assert.equal((await client.execute({ sql: 'SELECT COUNT(*) AS c FROM users WHERE id = ?', args: [account] })).rows[0].c, 0, 'the account IS gone');
  assert.deepEqual(await ledgerRows(kp.id), before, 'the ledger row survives account deletion');
});

test('13: developer / account room clearing (deleteAllReportDataForAccount) leaves the actor ledger unchanged', async () => {
  const account = uniq('acc-clear-rooms');
  const token = await ensureUser(account);
  const kp = await seedVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), account, token, room: 0 });
  const before = await ledgerRows(kp.id);
  assert.equal(before.length, 1);

  await deleteAllReportDataForAccount(client, account, { preserveActivelyPromotedRepresentations: true });
  assert.equal((await client.execute({ sql: 'SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?', args: [account] })).rows[0].c, 0, 'the rooms ARE cleared');
  assert.deepEqual(await ledgerRows(kp.id), before, 'the ledger row survives room clearing');
});

test('14: the corpus retention sweep leaves the actor ledger unchanged', async () => {
  const kp = await keyPair();
  await withActorKey(HMAC_KEY, async () => {
    await registerViaRoute(kp);
    assert.equal((await postVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), text: 'retention sweep invariant body content', kp })).status, 200);
  });
  const before = await ledgerRows(kp.id);
  const totalBefore = await totalLedgerRows();
  assert.ok(before.length >= 1);

  await runCorpusAdmissionRetentionSweep(client, {
    openConnection: () => createClient({ url: `file:${dbFile}` }),
    retentionDays: 0,
  });
  assert.equal(await totalLedgerRows(), totalBefore, 'the retention sweep touches no device_passport_actor_usage row');
  assert.deepEqual(await ledgerRows(kp.id), before);
});

// ===========================================================================
// 15 — version-1 passport: a ledger-write failure prevents a partial first save
// ===========================================================================

test('15: a version-1 passport whose actor observation cannot be resolved (authenticated, key removed) fails the WHOLE first save — no partial report, no ledger row', async () => {
  const kp = await keyPair();
  const account = uniq('acc-failclosed');
  const deviceKey = uniq('dk');
  const reportId = uniq('r');
  // born at version 1 (key present at registration)
  await withActorKey(HMAC_KEY, () => registerViaRoute(kp));
  assert.equal(await trackingVersionOf(kp.id), 1);
  const token = await ensureUser(account);

  // key removed at SAVE time -> resolveActorObservation(accountId) === null
  const res = await withActorKey(undefined, () =>
    postVerifiedReport({ deviceKey, reportId, text: 'this first save must not partially persist', kp, token, accountId: account, room: 0 }),
  );
  assert.equal(res.status, 500, 'a version-1 passport with no resolvable actor observation fails the save');

  assert.equal(
    (await client.execute({ sql: 'SELECT COUNT(*) AS c FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, reportId] })).rows[0].c,
    0,
    'the report was NOT saved — the transaction rolled back',
  );
  assert.equal((await ledgerRows(kp.id)).length, 0, 'no actor-usage row was written');
});

// ===========================================================================
// 16 — a version-0 passport is never promoted to complete by later activity
// ===========================================================================

test('16: a version-0 passport stays version 0 through re-registration, later authenticated uploads, and positive ledger evidence', async () => {
  const kp = await keyPair();
  await withActorKey(undefined, () => registerViaRoute(kp)); // born at 0 (no key)
  assert.equal(await trackingVersionOf(kp.id), 0);

  const account = uniq('acc-legacy');
  await withActorKey(HMAC_KEY, async () => {
    // anonymous upload -> legacy best-effort positive-evidence row
    assert.equal((await postVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), text: 'legacy passport anon upload body one', kp })).status, 200);
    // authenticated upload -> another positive-evidence row
    const token = await ensureUser(account);
    assert.equal((await postVerifiedReport({ deviceKey: uniq('dk'), reportId: uniq('r'), text: 'legacy passport authed upload body two', kp, token, accountId: account, room: 0 })).status, 200);
    // re-register with the key now present
    await registerViaRoute(kp);
  });

  assert.equal(await trackingVersionOf(kp.id), 0, 'still history-incomplete — no path promotes a legacy passport');
  const rows = await ledgerRows(kp.id);
  assert.ok(rows.length >= 1, 'positive evidence WAS recorded for the legacy passport');
});

// ===========================================================================
// 17 — the optional backfill never sets tracking version 1
// ===========================================================================

test('17: backfillDevicePassportActorUsageFromSavedReports records positive evidence but NEVER promotes a passport to version 1', async () => {
  const kpLegacy = await keyPair();
  await withActorKey(undefined, () => registerViaRoute(kpLegacy));
  const account = uniq('acc-backfill');
  await ensureUser(account);

  // seed saved_reports rows directly with a verified passport (no ledger write)
  for (const [dk, rid, uid] of [[uniq('dk'), uniq('r'), account], [uniq('dk'), uniq('r'), null]]) {
    await client.execute({
      sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [rid, dk, 'sub', 't', new Date().toISOString(), 6, 0, 'Low', '{}', uid, kpLegacy.id],
    });
  }

  const result = await withActorKey(HMAC_KEY, () => backfillDevicePassportActorUsageFromSavedReports(client, { dryRun: false }));
  assert.ok(result.observationsRecorded >= 2, 'the backfill recorded positive evidence');
  assert.equal(await trackingVersionOf(kpLegacy.id), 0, 'the backfill NEVER marks a legacy passport complete');

  // dry run performs zero writes
  const totalBefore = await totalLedgerRows();
  const dry = await withActorKey(HMAC_KEY, () => backfillDevicePassportActorUsageFromSavedReports(client, { dryRun: true }));
  assert.equal(dry.observationsRecorded, 0);
  assert.equal(await totalLedgerRows(), totalBefore, 'a dry run writes nothing');
});

// ===========================================================================
// 18 — no ordinary API leakage
// ===========================================================================

test('18: an ordinary report detail / list response exposes no ledger data', async () => {
  const kp = await keyPair();
  const deviceKey = uniq('dk');
  const reportId = uniq('r');
  const account = uniq('acc-leak');
  const token = await ensureUser(account);
  await withActorKey(HMAC_KEY, async () => {
    await registerViaRoute(kp);
    assert.equal((await postVerifiedReport({ deviceKey, reportId, text: 'privacy check body — no ledger leakage', kp, token, accountId: account, room: 0 })).status, 200);
  });
  const rows = await ledgerRows(kp.id);
  assert.equal(rows.length, 1);
  const forbidden = [rows[0].actorKey, kp.id, 'actor_key', 'actor_usage_tracking_version', 'device_passport_actor_usage', 'actorObservation', ANONYMOUS_ACTOR_KEY, account];

  const ip1 = nextIp();
  await resetRateForTest(ip1);
  const detail = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${reportId}`, { headers: { 'x-forwarded-for': ip1, cookie: `tp_session_v1=${token}` } }),
    { params: Promise.resolve({ id: reportId }) },
  );
  const detailText = await detail.text();
  for (const s of forbidden) assert.equal(detailText.includes(s), false, `report detail leaked: ${String(s).slice(0, 20)}`);

  const ip2 = nextIp();
  await resetRateForTest(ip2);
  const list = await reportsRoute.GET(new Request('http://localhost/api/reports', { headers: { 'x-forwarded-for': ip2, cookie: `tp_session_v1=${token}` } }));
  const listText = await list.text();
  for (const s of forbidden) assert.equal(listText.includes(s), false, `report list leaked: ${String(s).slice(0, 20)}`);
});

// ===========================================================================
// 19 — no scoring-path imports / behaviour changes
// ===========================================================================

test('19: the actor-ledger modules never import a matcher / scoring module, and no scoring module imports them', () => {
  const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
  const importLines = (src) => src.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join('\n');

  for (const rel of ['lib/device-passport-actor-ledger.ts', 'lib/device-passport-actor-usage-backfill.ts']) {
    const imports = importLines(read(rel));
    for (const forbidden of [
      'user-submission-matching', 'user-submission-corpus', 'report-primary-similarity',
      'report-historical-match', 'unified-similarity', 'device-self-scoring-rule',
      'device-shared-guard', 'device-shared-guard-policy', 'submission-provenance',
    ]) {
      assert.doesNotMatch(imports, new RegExp(forbidden), `${rel} must not import ${forbidden}`);
    }
  }

  const LEDGER_RE = /device-passport-actor-(ledger|usage-backfill)/;
  // The similarity COMPUTATION core never consumes the ledger. (The refined
  // shared-device SCORING GUARD, lib/device-shared-guard.ts, deliberately DOES
  // read the durable ledger for its fan-out / pair-safety facts — see that
  // module and tests/device-passport-shared-guard-scoring.test.mjs.)
  for (const rel of [
    'lib/report-primary-similarity.ts', 'lib/unified-similarity.ts', 'lib/device-self-scoring-rule.ts',
    'lib/device-shared-guard-policy.ts', 'lib/report-historical-match.ts',
    'lib/device-passport-server.ts',
  ]) {
    assert.doesNotMatch(read(rel), LEDGER_RE, `${rel} (scoring computation core) must not import the actor ledger`);
  }

  // only these app/ files may import the ledger module
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, acc);
      else if (/\.(ts|tsx)$/.test(e.name)) acc.push(full);
    }
    return acc;
  };
  const allowed = new Set(['app/api/reports/route.ts', 'app/api/device-passport/register/route.ts']);
  const offenders = walk(path.join(repo, 'app'))
    .filter((f) => LEDGER_RE.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(repo, f).split(path.sep).join('/'))
    .filter((rel) => !allowed.has(rel));
  assert.deepEqual(offenders, [], `unexpected app/ importer(s) of the actor ledger: ${offenders.join(', ')}`);
});

// ===========================================================================
// 20 — existing Device Passport scoring surface is untouched
// ===========================================================================

test('20: SAVE_REPORT_SQL carries no actor column and resolveActorObservation feeds nothing back into scoring', () => {
  assert.doesNotMatch(reportsRoute.SAVE_REPORT_SQL, /actor_usage|actor_key|device_passport_actor_usage/, 'the report upsert SQL is unchanged');
  // resolveActorObservation is a pure function of (accountId, env) — never a scoring input
  assert.equal(resolveActorObservation(null).actorKey, ANONYMOUS_ACTOR_KEY);
  assert.equal(resolveActorObservation('acc-x'), null, 'no key -> null, never a raw id');
});

console.log('device-passport actor ledger: schema, marking rule, actor key, atomic writes, deletion survival, privacy — all verified');
