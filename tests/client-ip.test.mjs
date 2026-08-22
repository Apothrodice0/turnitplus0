import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { clientIpFrom, clientIpFromHeaders } from '../lib/client-ip.ts';
import { resetAuthRateForTest } from '../lib/rate-limit.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';

/**
 * Production audit fix: every route used to take the FIRST entry of
 * X-Forwarded-For as the rate-limiting key, which is exactly the value an
 * attacker's own request supplies — a real reverse proxy (Vercel's edge
 * included) APPENDS the IP it directly observed to the END of the chain,
 * so only the LAST entry is trustworthy. Section A covers the pure
 * extraction function directly; Section B proves the actual security
 * property end to end against the real login route: a spoofed, rotating
 * first entry must no longer grant a fresh rate-limit bucket on every
 * request.
 */

// --- A: pure extraction function -------------------------------------------

test('clientIpFromHeaders: a single-entry X-Forwarded-For is used as-is (no chain, nothing to disambiguate)', () => {
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.7' });
  assert.equal(clientIpFromHeaders(headers), '203.0.113.7');
});

test('clientIpFromHeaders: a multi-hop X-Forwarded-For uses the LAST entry, never the first', () => {
  // The first entry ("9.9.9.9") is exactly what an attacker's own request
  // would set — this must never be trusted. The last entry is what a real
  // proxy appended from its own direct observation of the connection.
  const headers = new Headers({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' });
  assert.equal(clientIpFromHeaders(headers), '203.0.113.7');
});

test('clientIpFromHeaders: X-Real-IP takes precedence over X-Forwarded-For when both are present', () => {
  const headers = new Headers({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7', 'x-real-ip': '198.51.100.4' });
  assert.equal(clientIpFromHeaders(headers), '198.51.100.4');
});

test('clientIpFromHeaders: neither header present falls back to "unknown", never throws', () => {
  assert.equal(clientIpFromHeaders(new Headers()), 'unknown');
});

test('clientIpFromHeaders: whitespace around hops is trimmed', () => {
  const headers = new Headers({ 'x-forwarded-for': '  9.9.9.9  ,  203.0.113.7  ' });
  assert.equal(clientIpFromHeaders(headers), '203.0.113.7');
});

test('clientIpFrom(request) delegates to the same logic via request.headers', () => {
  const req = new Request('http://localhost/', { headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' } });
  assert.equal(clientIpFrom(req), '203.0.113.7');
});

// --- B: end-to-end security property, against the real login route --------

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_client_ip.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

function loginRequest(forwardedFor) {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-on-purpose' }),
  });
}

test('SECURITY: a spoofed, rotating first hop can no longer defeat the login brute-force limiter — the shared real IP (last hop) still gets rate-limited', async () => {
  // A real proxy would append the same genuine client IP as the last hop on
  // every one of these requests, even though the attacker changes the
  // spoofable first hop each time. checkAuthRate's bucket is 5/min — a 6th
  // attempt from what is, in reality, the same client must be refused.
  const realIp = 'client-ip-security-real-203.0.113.9';
  await resetAuthRateForTest(realIp);

  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = await loginRoute.POST(loginRequest(`attacker-spoofed-hop-${i}-${Math.random()}, ${realIp}`));
    statuses.push(res.status);
  }

  assert.ok(statuses.slice(0, 5).every((s) => s === 401), 'the first 5 attempts (wrong password) must be genuine 401s, not already blocked');
  assert.equal(statuses[5], 429, 'the 6th attempt must be rate-limited — the rotating spoofed first hop must never grant a fresh bucket');
});

test('CONTROL: without a shared real hop at all, two genuinely different callers get independent buckets', async () => {
  // Sanity check that the fix does not over-correct into treating every
  // request as the same client — two requests with no common trailing hop
  // are genuinely different clients and must not share a bucket.
  const clientA = `client-ip-independent-a-${Math.random()}`;
  const clientB = `client-ip-independent-b-${Math.random()}`;
  await resetAuthRateForTest(clientA);
  await resetAuthRateForTest(clientB);

  for (let i = 0; i < 5; i++) {
    const res = await loginRoute.POST(loginRequest(clientA));
    assert.equal(res.status, 401, `client A attempt ${i + 1} should be a genuine 401, not already blocked`);
  }
  const sixthA = await loginRoute.POST(loginRequest(clientA));
  assert.equal(sixthA.status, 429, "client A's own 6th attempt must be blocked");

  const firstB = await loginRoute.POST(loginRequest(clientB));
  assert.equal(firstB.status, 401, "client B, a genuinely different caller, must have its own fresh bucket, unaffected by client A's exhaustion");
});

test('the signup route resolves the same trustworthy IP through the same shared helper (source-level wiring check)', async () => {
  const source = await fs.promises.readFile(new URL('../app/api/auth/signup/route.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ clientIpFrom \} from ['"].*client-ip['"];/);
  assert.doesNotMatch(source, /forwarded\.split\(','\)\[0\]/, 'the old first-hop parsing must be fully removed, not left as dead code alongside the import');
});
