import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as logoutRoute from '../app/api/auth/logout/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetPollRateForTest, checkPollRate } from '../lib/rate-limit.ts';

/**
 * Production bug fix: app/reports/rooms/[room]/room-page-shell.tsx polls
 * GET /api/reports?room=N every 3 seconds while a check is "processing" —
 * up to MAX_POLL_ATTEMPTS (10) requests per room, per page view. Before
 * this fix, that traffic drew from the exact same general rate-limit
 * bucket (10/min) as every other strict/abuse-sensitive action on the
 * account (login, signup, uploads, account mutations, destructive
 * operations — see lib/rate-limit.ts's own header comment on the
 * three-bucket architecture). A single poll window alone could exhaust the
 * shared budget and make an unrelated action look rate-limited purely as a
 * side effect of watching one room finish. This proves the fix in both
 * directions: draining the poll-specific bucket never touches the general
 * one, and vice versa. Logout (checkRate, the strict bucket, and
 * deliberately idempotent/cookie-optional — see that route's own comment)
 * stands in for "the general bucket" here; the room index and full-report
 * reads have since moved to their own separate read/navigation bucket
 * (checkReadRate) and are covered by tests/read-rate-limit-bucket.test.mjs
 * instead.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_poll_rate_limit_isolation.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

// Deterministic bucket-state seeding (matching tests/rate-limit-durable.
// test.mjs's own rewindLastRefill technique): writes a known
// (bucket_key, tokens, last_refill) state directly instead of spending
// dozens of real checkPollRate round trips getting there. SQLite serializes
// writes to a single file regardless of dispatch concurrency (see
// lib/rate-limit.ts's checkBucket), so a real full-bucket drain can
// accumulate enough wall-clock time on a loaded machine for that same
// bucket's own refill to occasionally add back a stray token right at the
// boundary — a flake with nothing to do with the limiter's own correctness.
async function seedBucket(bucketKey, tokens, lastRefill = Date.now()) {
  const client = createClient({ url: `file:${dbFile}` });
  try {
    await client.execute({
      sql: `INSERT INTO rate_limit_buckets (bucket_key, tokens, last_refill, last_allowed)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(bucket_key) DO UPDATE SET tokens = excluded.tokens, last_refill = excluded.last_refill`,
      args: [bucketKey, tokens, lastRefill],
    });
  } finally {
    client.close();
  }
}

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, ip) {
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password: 'correct-horse-poll-1', username: email.split('@')[0], deviceKey: `device-${email}` }),
  });
  return signupRoute.POST(req);
}

function roomPollRequest(cookie, ip, room) {
  return new Request(`http://localhost/api/reports?room=${room}`, {
    headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${cookie}` },
  });
}

function logoutRequest(ip) {
  return new Request('http://localhost/api/auth/logout', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  });
}

test('DIRECTION 1: repeated room-status polling (up to 30/min) never consumes the general/strict (10/min) bucket that write/auth actions — including logout — depend on', async () => {
  const ip = 'poll-isolation-direction-1';
  const signupRes = await signup('poll-direction1@example.com', ip);
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  await resetRateForTest(ip);
  await resetPollRateForTest(ip);

  // Simulate a full, real poll window: MAX_POLL_ATTEMPTS (10) requests,
  // same as room-page-shell.tsx's own bounded loop — well within the
  // general bucket's own 10-token budget if it were (wrongly) shared, so
  // push further to make the isolation unambiguous: 15 poll requests,
  // more than the ENTIRE general bucket, all against the poll-specific one.
  for (let i = 0; i < 15; i++) {
    const res = await reportsRoute.GET(roomPollRequest(cookie, ip, 0));
    assert.equal(res.status, 200, `poll request ${i + 1} must succeed — the poll bucket (30/min) has ample room for 15 requests`);
  }

  // The general/strict bucket, on the SAME IP, must still be fully intact —
  // a request that depends on it (here, logout — see this file's own
  // header comment for why it's the strict-bucket stand-in) must succeed,
  // proving the 15 poll requests drew from a different bucket entirely.
  const logoutRes = await logoutRoute.POST(logoutRequest(ip));
  assert.equal(logoutRes.status, 200, "the general/strict bucket must be untouched by polling — a write/auth action must never be blocked by it");
});

test('DIRECTION 2: draining the general/strict (10/min) bucket never blocks room-status polling, which has its own separate (30/min) budget', async () => {
  const ip = 'poll-isolation-direction-2';
  const signupRes = await signup('poll-direction2@example.com', ip);
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  await resetRateForTest(ip);
  await resetPollRateForTest(ip);

  // Fully exhaust the general/strict bucket via logout (checkRate).
  for (let i = 0; i < 10; i++) {
    const res = await logoutRoute.POST(logoutRequest(ip));
    assert.equal(res.status, 200, `general/strict-bucket request ${i + 1} must succeed while under the limit`);
  }
  const eleventh = await logoutRoute.POST(logoutRequest(ip));
  assert.equal(eleventh.status, 429, 'the general/strict bucket must now genuinely be exhausted — otherwise this test proves nothing');

  // Room-status polling, on the SAME now-exhausted IP, must be entirely
  // unaffected — this is the literal scenario the production bug caused:
  // a user browsing normally (draining the general bucket) must not lose
  // the ability to watch a processing room finish.
  for (let i = 0; i < 10; i++) {
    const res = await reportsRoute.GET(roomPollRequest(cookie, ip, 0));
    assert.equal(res.status, 200, `poll request ${i + 1} must succeed even though this IP's general bucket is fully drained`);
  }
});

test('the room-scoped GET response shape is unaffected by which bucket served it — a real 429 still looks like a real 429, with Retry-After', async () => {
  const ip = 'poll-isolation-429-shape';
  const signupRes = await signup('poll-429shape@example.com', ip);
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  await resetPollRateForTest(ip);
  // Deterministically exhaust the bucket (seed straight to 0 tokens,
  // refilled just now) rather than draining it via real round trips — see
  // seedBucket's own comment on why that's what keeps this reliable on a
  // loaded machine.
  await seedBucket(`poll:${ip}`, 0);
  const drainedDirect = await checkPollRate(ip);
  assert.equal(drainedDirect.allowed, false, 'sanity: the poll bucket must now genuinely be exhausted');

  // Real-route confirmation: with the bucket now genuinely exhausted, one
  // more request through the actual HTTP handler must come back shaped
  // exactly like any other 429.
  const res = await reportsRoute.GET(roomPollRequest(cookie, ip, 0));
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error, 'Too many requests');
  assert.ok(res.headers.get('Retry-After'), 'a genuine poll-bucket 429 must still carry Retry-After, exactly like a general-bucket one');
});
