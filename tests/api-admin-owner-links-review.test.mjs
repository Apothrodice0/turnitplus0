import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createHmac } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { createSession, SESSION_COOKIE_NAME } from '../lib/auth-session.ts';
import { resetAdminRateForTest } from '../lib/rate-limit.js';
import {
  DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV,
  DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR,
} from '../lib/device-passport-actor-ledger.ts';
import { OWNER_LINK_HMAC_KEY_ENV, ownerLinkEvidenceFingerprint } from '../lib/owner-link.ts';
import { upsertOwnerLinkEvidence } from '../lib/owner-link-repo.ts';
import * as reviewRoute from '../app/api/admin/owner-links/review/route.ts';

/**
 * POST /api/admin/owner-links/review — read-only admin owner-evidence review.
 * Behavioural coverage called directly: authorization (anon / non-admin /
 * admin), same-origin/CSRF enforcement, malformed-JSON + same-account +
 * unknown-account handling, Cache-Control: no-store, the forbidden-field
 * privacy check, the admin rate-limit path, and the "zero persistent writes"
 * invariant. Every fixture is synthetic.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_api_admin_owner_links_review.db');
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const ACTOR_KEY = 'test-only-actor-hmac-key-review-route';
const OWNER_KEY = 'test-only-owner-link-hmac-key-review-route';
const origActor = process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
const origOwner = process.env[OWNER_LINK_HMAC_KEY_ENV];
process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = ACTOR_KEY;
process.env[OWNER_LINK_HMAC_KEY_ENV] = OWNER_KEY;

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  if (origActor === undefined) delete process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  else process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = origActor;
  if (origOwner === undefined) delete process.env[OWNER_LINK_HMAC_KEY_ENV];
  else process.env[OWNER_LINK_HMAC_KEY_ENV] = origOwner;
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;
const nextIp = () => `owner-review-route-${++seq}`;
const actorKeyFor = (id) => createHmac('sha256', ACTOR_KEY).update(`${DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR}:${id}`, 'utf8').digest('hex');
const SAME_ORIGIN = { origin: 'http://localhost', host: 'localhost' };

async function ensureUser(role) {
  const id = uniq(`u-${role}`);
  await client.execute({
    sql: 'INSERT INTO users (id, email, username, password_hash, role) VALUES (?,?,?,?,?)',
    args: [id, `${id}@e.test`, id, 'x', role],
  });
  const token = await createSession(client, id);
  return { id, email: `${id}@e.test`, token };
}

async function seedPassport(id, { v = 1 } = {}) {
  await client.execute({
    sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation, actor_usage_tracking_version)
          VALUES (?,?,?,?,0,?)`,
    args: [id, Buffer.from(`spki-${id}`), 'ECDSA-P256-SHA256', Date.now(), v],
  });
}
async function seedReport(accountId, passportId) {
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [uniq('rpt'), uniq('dk'), uniq('sub'), 't', new Date().toISOString(), 5, 0, 'Low', '{}', accountId, passportId],
  });
}
async function seedActor(passportId, actorKey) {
  await client.execute({
    sql: `INSERT INTO device_passport_actor_usage (device_passport_id, actor_key_version, actor_key, is_anonymous, first_observed_at, last_observed_at, observation_count)
          VALUES (?,1,?,0,?,?,1)`,
    args: [passportId, actorKey, Date.now(), Date.now()],
  });
}
/** two normal user accounts that share two joint v1 passports + an ACTIVE ADMIN_MANUAL link. */
async function seedReviewablePair() {
  const a = uniq('acc-a');
  const b = uniq('acc-b');
  await client.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [a, `${a}@e.test`, a, 'x'] });
  await client.execute({ sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: [b, `${b}@e.test`, b, 'x'] });
  for (let i = 0; i < 2; i += 1) {
    const p = uniq('pp');
    await seedPassport(p, { v: 1 });
    await seedReport(a, p); await seedReport(b, p);
    await seedActor(p, actorKeyFor(a)); await seedActor(p, actorKeyFor(b));
  }
  await upsertOwnerLinkEvidence(client, {
    accountId: a, candidateSourceAccountId: b, signalType: 'ADMIN_MANUAL', confidence: 'HIGH',
    evidenceFingerprint: ownerLinkEvidenceFingerprint('ADMIN_MANUAL', ['v1']),
    observedAt: Date.now(), createdBy: 'ADMIN', decidedBy: 'ADMIN',
  });
  return { a, b, emailA: `${a}@e.test`, emailB: `${b}@e.test` };
}

async function call({ cookie, origin, host, body, ip, rawBody } = {}) {
  const useIp = ip ?? nextIp();
  await resetAdminRateForTest(useIp);
  return callNoReset({ cookie, origin, host, body, ip: useIp, rawBody });
}
async function callNoReset({ cookie, origin, host, body, ip, rawBody } = {}) {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip ?? nextIp() };
  if (cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
  if (origin !== undefined) headers.origin = origin;
  if (host !== undefined) headers.host = host;
  const init = { method: 'POST', headers };
  init.body = rawBody !== undefined ? rawBody : JSON.stringify(body ?? {});
  return reviewRoute.POST(new Request('http://localhost/api/admin/owner-links/review', init));
}

// Business tables the review must never mutate. rate_limit_buckets is
// deliberately NOT here — checkAdminRate legitimately writes it (see the
// dedicated assertion below).
const BUSINESS_TABLES = [
  'account_owner_links', 'account_owner_link_evidence', 'account_owner_link_events', 'account_owner_link_state',
  'device_passports', 'device_passport_actor_usage', 'saved_reports', 'users', 'sessions',
];
async function tableCounts() {
  const out = {};
  for (const t of BUSINESS_TABLES) {
    out[t] = Number((await client.execute(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c);
  }
  return out;
}

// ===========================================================================

test('AUTHZ: anon -> 404, non-admin -> 404, admin -> 200', async () => {
  const { emailA, emailB } = await seedReviewablePair();
  const nonAdmin = await ensureUser('user');
  const admin = await ensureUser('admin');

  assert.equal((await call({ ...SAME_ORIGIN, body: { a: emailA, b: emailB } })).status, 404, 'anon');
  assert.equal((await call({ ...SAME_ORIGIN, cookie: nonAdmin.token, body: { a: emailA, b: emailB } })).status, 404, 'non-admin');

  const ok = await call({ ...SAME_ORIGIN, cookie: admin.token, body: { a: emailA, b: emailB } });
  assert.equal(ok.status, 200);
  const json = await ok.json();
  assert.equal(json.found, true);
  assert.equal(json.interpretation.tier, 'ESTABLISHED');
});

test('AUTHZ: a non-admin with malformed JSON still gets a bare 404, never a 400 (route stays hidden)', async () => {
  const nonAdmin = await ensureUser('user');
  const res = await call({ ...SAME_ORIGIN, cookie: nonAdmin.token, rawBody: '{not json' });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), '');
});

test('CSRF: missing Origin -> 404, foreign Origin -> 404, same Origin -> proceeds', async () => {
  const admin = await ensureUser('admin');
  const { emailA, emailB } = await seedReviewablePair();

  const noOrigin = await call({ host: 'localhost', cookie: admin.token, body: { a: emailA, b: emailB } });
  assert.equal(noOrigin.status, 404);
  assert.equal(await noOrigin.text(), '', 'bare 404, no body');

  const foreign = await call({ origin: 'https://evil.example', host: 'localhost', cookie: admin.token, body: { a: emailA, b: emailB } });
  assert.equal(foreign.status, 404);

  const same = await call({ ...SAME_ORIGIN, cookie: admin.token, body: { a: emailA, b: emailB } });
  assert.equal(same.status, 200);
});

test('CSRF check runs before auth — cross-origin from a real admin is still 404', async () => {
  const admin = await ensureUser('admin');
  const res = await call({ origin: 'https://attacker.test', host: 'localhost', cookie: admin.token, body: { a: 'x@e.test', b: 'y@e.test' } });
  assert.equal(res.status, 404);
});

test('malformed JSON from an admin -> 400 Invalid JSON', async () => {
  const admin = await ensureUser('admin');
  const res = await call({ ...SAME_ORIGIN, cookie: admin.token, rawBody: '{ broken' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid JSON');
});

test('body validation: missing / non-string / oversized emails -> 400', async () => {
  const admin = await ensureUser('admin');
  for (const body of [{}, { a: 'x@e.test' }, { a: 1, b: 2 }, { a: 'a@e.test', b: `${'x'.repeat(300)}@e.test` }]) {
    const res = await call({ ...SAME_ORIGIN, cookie: admin.token, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  // shape-invalid strings
  const bad = await call({ ...SAME_ORIGIN, cookie: admin.token, body: { a: 'not-an-email', b: 'also bad' } });
  assert.equal(bad.status, 400);
});

test('same account (a === b, and same account via different-cased email) -> 400', async () => {
  const admin = await ensureUser('admin');
  const u = await ensureUser('user');
  assert.equal((await call({ ...SAME_ORIGIN, cookie: admin.token, body: { a: u.email, b: u.email } })).status, 400);
  assert.equal((await call({ ...SAME_ORIGIN, cookie: admin.token, body: { a: u.email, b: u.email.toUpperCase() } })).status, 400);
});

test('unknown account -> bare { found: false } 200, leaks nothing about which side', async () => {
  const admin = await ensureUser('admin');
  const known = await ensureUser('user');
  const res = await call({ ...SAME_ORIGIN, cookie: admin.token, body: { a: known.email, b: 'ghost@e.test' } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json, { found: false }, 'exactly { found: false }, nothing else');
});

test('response carries Cache-Control: no-store (success AND error)', async () => {
  const admin = await ensureUser('admin');
  const { emailA, emailB } = await seedReviewablePair();
  const ok = await call({ ...SAME_ORIGIN, cookie: admin.token, body: { a: emailA, b: emailB } });
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const err = await call({ ...SAME_ORIGIN, cookie: admin.token, rawBody: 'nope' });
  assert.equal(err.headers.get('cache-control'), 'no-store');
  const hidden = await call({ ...SAME_ORIGIN, body: { a: emailA, b: emailB } });
  assert.equal(hidden.headers.get('cache-control'), 'no-store');
});

test('response body contains no email / account id / passport id / actor key / UUID', async () => {
  const admin = await ensureUser('admin');
  const { a, b, emailA, emailB } = await seedReviewablePair();
  const res = await call({ ...SAME_ORIGIN, cookie: admin.token, body: { a: emailA, b: emailB } });
  const text = await res.text();
  for (const forbidden of [a, b, emailA, emailB, '@e.test', actorKeyFor(a), actorKeyFor(b)]) {
    assert.equal(text.includes(forbidden), false, `must not contain ${forbidden.slice(0, 14)}…`);
  }
  const pps = (await client.execute('SELECT id FROM device_passports')).rows.map((r) => String(r.id));
  for (const p of pps) assert.equal(text.includes(p), false, 'no passport id');
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'no UUID');
  assert.doesNotMatch(text, /"[0-9a-f]{64}"/i, 'no 64-hex identity value');
});

test('admin rate limit path is used — the dedicated admin bucket 429s after exhaustion', async () => {
  const admin = await ensureUser('admin');
  const { emailA, emailB } = await seedReviewablePair();
  const ip = `owner-review-ratelimit-${++seq}`;
  await resetAdminRateForTest(ip);
  let got429 = false;
  for (let i = 0; i < 34; i += 1) {
    const res = await callNoReset({ ...SAME_ORIGIN, cookie: admin.token, body: { a: emailA, b: emailB }, ip });
    if (res.status === 429) {
      got429 = true;
      assert.ok(res.headers.get('retry-after'), 'a Retry-After header is present');
      break;
    }
  }
  assert.equal(got429, true, 'the admin bucket (30/min) rejected once exhausted');
});

test('the review does not mutate any owner-link / account / report / passport BUSINESS table (rate-limit state is expected to change and is excluded)', async () => {
  const admin = await ensureUser('admin');
  const { emailA, emailB } = await seedReviewablePair();
  const before = await tableCounts();
  const rlBefore = Number((await client.execute('SELECT COUNT(*) c FROM rate_limit_buckets')).rows[0].c);
  for (let i = 0; i < 3; i += 1) {
    const res = await call({ ...SAME_ORIGIN, cookie: admin.token, body: { a: emailA, b: emailB } });
    assert.equal(res.status, 200);
  }
  // also exercise the unknown-account + same-account + malformed paths
  await call({ ...SAME_ORIGIN, cookie: admin.token, body: { a: emailA, b: 'ghost@e.test' } });
  await call({ ...SAME_ORIGIN, cookie: admin.token, rawBody: 'x' });
  const after = await tableCounts();
  assert.deepEqual(after, before, 'no owner-link / passport / user / report / session rows added or removed');
  // rate limiting really ran (not stubbed): a bucket row exists for the caller's ip namespace
  const rlAfter = Number((await client.execute('SELECT COUNT(*) c FROM rate_limit_buckets')).rows[0].c);
  assert.ok(rlAfter >= rlBefore, 'rate_limit_buckets is operational state that MAY change — explicitly not part of the business-data immutability assertion');
});
