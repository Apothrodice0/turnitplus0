import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as meRoute from '../app/api/auth/me/route.ts';
import * as requestRoute from '../app/api/auth/password-reset/request/route.ts';
import * as confirmRoute from '../app/api/auth/password-reset/confirm/route.ts';
import { resetAuthRateForTest, resetPasswordResetRatesForTest } from '../lib/rate-limit.js';
import { __setEmailDeliveryProviderForTest } from '../lib/mail/email-delivery.ts';
import { __setResendFetchForTest, resendEmailDeliveryProvider } from '../lib/mail/resend-email-provider.ts';
import { PASSWORD_RESET_MESSAGES, PASSWORD_RESET_TTL_MS } from '../lib/password-reset.ts';
import { resolveTrustedAppBaseUrl } from '../lib/trusted-app-origin.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';

// Customer password recovery — real route handlers over a local libSQL file with every migration (0054 included).
// The mail provider is a fake; NO real email is ever sent.
const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_password_reset.db');
for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${dbFile}${suffix}`)) fs.unlinkSync(`${dbFile}${suffix}`);
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.EMAIL_VERIFICATION_CODE_SECRET = 'test-only-email-verification-code-secret';
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_VERIFICATION_FROM_ADDRESS;
delete process.env.PASSWORD_RESET_BASE_URL;
delete process.env.VERCEL;
const db = createClient({ url: `file:${dbFile}` });
await db.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(db, path.join(repo, 'drizzle'));

const resets = [];
let failNextReset = false;
const fakeProvider = {
  async sendEmailVerification() {},
  async sendPasswordReset(message) {
    if (failNextReset) { failNextReset = false; throw new Error('provider down'); }
    resets.push(message);
  },
};
__setEmailDeliveryProviderForTest(fakeProvider);

let seq = 0;
const ip = (label) => `pr-${label}-${++seq}`;
const cookieOf = (res) => res.headers.get('set-cookie')?.match(/tp_session_v1=([^;]*)/)?.[1] ?? null;
const post = (route, url, body, clientIp) => route.POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp }, body: JSON.stringify(body) }));
async function signup(email, password = 'original-pass-1') {
  const i = ip('su'); await resetAuthRateForTest(i);
  const res = await post(signupRoute, 'http://localhost/api/auth/signup', withTestIdentity({ email, password, username: 'pruser', deviceKey: `dk-${i}` }), i);
  assert.ok(res.ok, `signup works (${res.status})`);
  return cookieOf(res);
}
async function login(email, password) {
  const i = ip('li'); await resetAuthRateForTest(i);
  return post(loginRoute, 'http://localhost/api/auth/login', { email, password, username: 'pruser', deviceKey: `dk-${i}` }, i);
}
async function requestReset(email, { url = 'http://localhost/api/auth/password-reset/request', clientIp } = {}) {
  const i = clientIp ?? ip('rq'); if (!clientIp) await resetPasswordResetRatesForTest(i, createHash('sha256').update(email.trim().toLowerCase()).digest('hex'));
  const res = await post(requestRoute, url, { email }, i);
  return { res, body: await res.json() };
}
async function confirm(body, clientIp) {
  const i = clientIp ?? ip('cf'); if (!clientIp) await resetPasswordResetRatesForTest(i);
  const res = await post(confirmRoute, 'http://localhost/api/auth/password-reset/confirm', body, i);
  return { res, body: await res.json() };
}
const tokenOf = (message) => message.resetUrl.match(/#token=([0-9a-f]{64})$/)?.[1];
async function me(cookie) {
  const res = await meRoute.GET(new Request('http://localhost/api/auth/me', { headers: { cookie: `tp_session_v1=${cookie}` } }));
  return (await res.json()).user ?? null;
}

test('known and unknown emails get the identical neutral answer; only the known account is emailed, with a localhost link', async () => {
  await signup('known@example.com');
  const before = resets.length;
  const known = await requestReset('Known@Example.com ');
  const unknown = await requestReset('nobody@example.com');
  assert.equal(known.res.status, 200); assert.equal(unknown.res.status, 200);
  assert.deepEqual(known.body, unknown.body, 'same body: no account enumeration');
  assert.equal(known.body.message, PASSWORD_RESET_MESSAGES.requested);
  assert.equal(resets.length, before + 1, 'exactly one email, for the known account');
  const msg = resets.at(-1);
  assert.equal(msg.to, 'known@example.com');
  assert.match(msg.resetUrl, /^http:\/\/localhost\/reset-password#token=[0-9a-f]{64}$/);
  const raw = tokenOf(msg);
  const rows = (await db.execute('SELECT token_digest, expires_at, created_at FROM password_reset_tokens')).rows;
  assert.ok(rows.every((r) => r.token_digest !== raw), 'the raw token is never stored');
  assert.ok(rows.some((r) => r.token_digest === createHash('sha256').update(raw).digest('hex')), 'its SHA-256 digest is');
  assert.ok(rows.every((r) => Number(r.expires_at) - Number(r.created_at) === PASSWORD_RESET_TTL_MS), '30-minute expiry');
});

test('a reset replaces the password, revokes every session of the account, and the link is single-use', async () => {
  const cookieA = await signup('reset@example.com');
  const loginB = await login('reset@example.com', 'original-pass-1');
  const cookieB = cookieOf(loginB);
  assert.ok(await me(cookieA) && await me(cookieB), 'two live sessions before the reset');
  await requestReset('reset@example.com');
  const token = tokenOf(resets.at(-1));
  assert.equal((await confirm({ token, checkOnly: true })).body.status, 'VALID');
  const done = await confirm({ token, password: 'brand-new-pass-2' });
  assert.equal(done.res.status, 200); assert.equal(done.body.status, 'reset');
  assert.match(done.res.headers.get('set-cookie') ?? '', /tp_session_v1=;/, 'this browser cookie is cleared');
  assert.equal(await me(cookieA), null, 'session A revoked'); assert.equal(await me(cookieB), null, 'session B revoked');
  assert.equal((await login('reset@example.com', 'original-pass-1')).status, 401, 'old password no longer works');
  assert.equal((await login('reset@example.com', 'brand-new-pass-2')).status, 200, 'new password works');
  const replay = await confirm({ token, password: 'attacker-pass-3' });
  assert.equal(replay.res.status, 400); assert.equal(replay.body.status, 'USED'); assert.equal(replay.body.error, PASSWORD_RESET_MESSAGES.USED);
  assert.equal((await login('reset@example.com', 'brand-new-pass-2')).status, 200, 'the replay changed nothing');
});

test('concurrent redemption of one link: exactly one wins, and the password is the winner\'s', async () => {
  await signup('race@example.com');
  await requestReset('race@example.com');
  const token = tokenOf(resets.at(-1));
  const [a, b] = await Promise.all([confirm({ token, password: 'racer-one-pass' }), confirm({ token, password: 'racer-two-pass' })]);
  const winners = [a, b].filter((r) => r.res.status === 200);
  assert.equal(winners.length, 1, 'exactly one redemption succeeds');
  const winnerPassword = a.res.status === 200 ? 'racer-one-pass' : 'racer-two-pass';
  const loserPassword = a.res.status === 200 ? 'racer-two-pass' : 'racer-one-pass';
  assert.equal([a, b].find((r) => r.res.status !== 200).body.status, 'USED');
  assert.equal((await login('race@example.com', winnerPassword)).status, 200);
  assert.equal((await login('race@example.com', loserPassword)).status, 401);
});

test('expired, superseded, unknown and malformed links are refused with clear messages and change nothing', async () => {
  await signup('expiry@example.com');
  await requestReset('expiry@example.com');
  const first = tokenOf(resets.at(-1));
  await requestReset('expiry@example.com');
  const second = tokenOf(resets.at(-1));
  assert.equal((await confirm({ token: first, password: 'whatever-pass-1' })).body.status, 'INVALID', 'a newer link revokes the older one');
  await db.execute({ sql: 'UPDATE password_reset_tokens SET expires_at = created_at + 1 WHERE token_digest = ?', args: [createHash('sha256').update(second).digest('hex')] });
  const expired = await confirm({ token: second, password: 'whatever-pass-1' });
  assert.equal(expired.body.status, 'EXPIRED'); assert.equal(expired.body.error, PASSWORD_RESET_MESSAGES.EXPIRED);
  assert.equal((await confirm({ token: 'f'.repeat(64), password: 'whatever-pass-1' })).body.status, 'INVALID');
  assert.equal((await confirm({ token: 'not-a-token', password: 'whatever-pass-1' })).body.status, 'INVALID');
  assert.equal((await login('expiry@example.com', 'original-pass-1')).status, 200, 'password unchanged');
});

test('the new password follows the signup rule', async () => {
  await signup('policy@example.com');
  await requestReset('policy@example.com');
  const token = tokenOf(resets.at(-1));
  const short = await confirm({ token, password: 'short' });
  assert.equal(short.res.status, 400); assert.match(short.body.error, /at least 8 characters/);
  assert.equal((await confirm({ token, checkOnly: true })).body.status, 'VALID', 'a rejected password does not burn the link');
});

test('rate limits: per IP and per address (identical for unknown addresses), with Retry-After', async () => {
  const sameIp = ip('flood');
  await resetPasswordResetRatesForTest(sameIp);
  let last;
  for (let n = 0; n < 6; n += 1) last = await requestReset(`flood${n}@example.com`, { clientIp: sameIp });
  assert.equal(last.res.status, 429); assert.ok(Number(last.res.headers.get('retry-after')) > 0);
  const email = 'target@example.com';
  await resetPasswordResetRatesForTest('x', createHash('sha256').update(email).digest('hex'));
  const codes = [];
  for (let n = 0; n < 4; n += 1) { const i = ip(`addr${n}`); await resetPasswordResetRatesForTest(i); codes.push((await requestReset(email, { clientIp: i })).res.status); }
  assert.deepEqual(codes, [200, 200, 200, 429], 'the 4th request for one address within an hour is refused, whatever the IP');
});

test('no false "sent": unconfigured email, an untrusted host or an undeliverable message', async () => {
  await signup('fail@example.com');
  __setEmailDeliveryProviderForTest(null);
  const off = await requestReset('fail@example.com');
  assert.equal(off.res.status, 503); assert.equal(off.body.error, PASSWORD_RESET_MESSAGES.unavailable);
  assert.deepEqual((await requestReset('nobody-else@example.com')).body, off.body, 'unavailable is the same for everyone');
  __setEmailDeliveryProviderForTest(fakeProvider);
  const evil = await requestReset('fail@example.com', { url: 'https://evil.example/api/auth/password-reset/request' });
  assert.equal(evil.res.status, 503, 'a link is never minted for an untrusted host');
  const before = (await db.execute('SELECT COUNT(*) n FROM password_reset_tokens WHERE revoked_at IS NULL AND consumed_at IS NULL')).rows[0].n;
  const errors = []; const original = console.error; console.error = (...args) => errors.push(args.join(' '));
  failNextReset = true;
  const undeliverable = await requestReset('fail@example.com');
  console.error = original;
  assert.equal(undeliverable.res.status, 200, 'neutral answer (a different one would reveal the account)');
  const after = (await db.execute('SELECT COUNT(*) n FROM password_reset_tokens WHERE revoked_at IS NULL AND consumed_at IS NULL')).rows[0].n;
  assert.ok(Number(after) <= Number(before), 'the undelivered link was revoked, not left usable');
  assert.ok(errors.every((line) => !/[0-9a-f]{64}/.test(line) && !/fail@example\.com/.test(line)), 'no token or address in logs');
});

test('trusted origin: configured base URL wins; otherwise only this deployment\'s own Vercel hosts or local dev', () => {
  const req = (u) => new Request(u);
  assert.equal(resolveTrustedAppBaseUrl(req('https://anything.example/x'), { PASSWORD_RESET_BASE_URL: 'https://turnitplus-vercel-v5-amber.vercel.app' }), 'https://turnitplus-vercel-v5-amber.vercel.app');
  assert.equal(resolveTrustedAppBaseUrl(req('https://a.example/x'), { PASSWORD_RESET_BASE_URL: 'http://plain.example', VERCEL: '1' }), null, 'http refused on Vercel');
  assert.equal(resolveTrustedAppBaseUrl(req('https://a.example/x'), { PASSWORD_RESET_BASE_URL: 'not a url' }), null);
  assert.equal(resolveTrustedAppBaseUrl(req('https://dep-123.vercel.app/x'), { VERCEL: '1', VERCEL_URL: 'dep-123.vercel.app' }), 'https://dep-123.vercel.app');
  assert.equal(resolveTrustedAppBaseUrl(req('https://other.vercel.app/x'), { VERCEL: '1', VERCEL_URL: 'dep-123.vercel.app' }), null);
  assert.equal(resolveTrustedAppBaseUrl(req('http://localhost:3000/x'), { VERCEL: '1' }), null, 'no localhost on Vercel');
  assert.equal(resolveTrustedAppBaseUrl(req('http://localhost:3000/x'), {}), 'http://localhost:3000');
});

test('Resend provider sends the reset link (escaped) and fails closed', async () => {
  process.env.RESEND_API_KEY = 'test-key'; process.env.EMAIL_VERIFICATION_FROM_ADDRESS = 'TurnitPlus <no-reply@example.test>';
  const calls = [];
  __setResendFetchForTest(async (url, init) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); });
  await resendEmailDeliveryProvider.sendPasswordReset({ to: 'user@example.com', resetUrl: 'https://host.example/reset-password#token=' + 'a'.repeat(64), expiresAt: Date.now() + PASSWORD_RESET_TTL_MS });
  assert.equal(calls[0].subject, 'Reset your TurnitPlus password');
  assert.match(calls[0].text, /reset-password#token=a{64}/); assert.match(calls[0].html, /href="https:\/\/host\.example\/reset-password#token=a{64}"/);
  __setResendFetchForTest(async () => new Response('{}', { status: 500 }));
  await assert.rejects(resendEmailDeliveryProvider.sendPasswordReset({ to: 'u@example.com', resetUrl: 'https://h/x', expiresAt: Date.now() + 1000 }), { name: 'EmailDeliveryUnavailableError' });
  __setResendFetchForTest(null); delete process.env.RESEND_API_KEY; delete process.env.EMAIL_VERIFICATION_FROM_ADDRESS;
});

test('customer pages: Forgot password goes to the reset page; the page keeps the token in the fragment and clears it', async () => {
  const home = fs.readFileSync(path.join(repo, 'app/page.tsx'), 'utf8');
  assert.match(home, /window\.location\.href = "\/reset-password"/);
  assert.doesNotMatch(home, /Password recovery will be added with the account service/);
  const page = fs.readFileSync(path.join(repo, 'app/reset-password/page.tsx'), 'utf8');
  assert.match(page, /window\.location\.hash/); assert.match(page, /window\.history\.replaceState\(null, "", window\.location\.pathname\)/);
  for (const label of ['Reset your password', 'Send reset link', 'Choose a new password', 'Set new password', 'Request a new link', 'Back to sign in']) assert.ok(page.includes(label), label);
  assert.doesNotMatch(page, /console\.(log|error)/);
});

test.after(() => { db.close(); });
