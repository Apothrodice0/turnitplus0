import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as roomsRoute from '../app/api/reports/rooms/route.ts';
import { resetAuthRateForTest, resetRateForTest, resetPollRateForTest } from '../lib/rate-limit.ts';

/**
 * Production bug fix: app/reports/rooms/[room]/room-page-shell.tsx polls
 * GET /api/reports?room=N every 3 seconds while a check is "processing" —
 * up to MAX_POLL_ATTEMPTS (10) requests per room, per page view. Before
 * this fix, that traffic drew from the exact same general rate-limit
 * bucket (10/min) as every other browsing/upload/auth action on the
 * account, including opening the full report at /reports/[id] (which also
 * calls checkRate). A single poll window alone could exhaust the shared
 * budget and make an unrelated action look rate-limited purely as a side
 * effect of watching one room finish. This proves the fix in both
 * directions: draining the poll-specific bucket never touches the general
 * one, and vice versa.
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

function roomIndexRequest(cookie, ip) {
  return new Request('http://localhost/api/reports/rooms', {
    headers: { 'x-forwarded-for': ip, cookie: `tp_session_v1=${cookie}` },
  });
}

test('DIRECTION 1: repeated room-status polling (up to 30/min) never consumes the general (10/min) bucket that other actions — including opening the full report — depend on', async () => {
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

  // The general bucket, on the SAME IP, must still be fully intact — a
  // request that depends on it (here, the room index; app/reports/[id]/
  // page.tsx's own loadOwnedReport calls the exact same checkRate) must
  // succeed, proving the 15 poll requests drew from a different bucket
  // entirely.
  const indexRes = await roomsRoute.GET(roomIndexRequest(cookie, ip));
  assert.equal(indexRes.status, 200, "the general bucket must be untouched by polling — opening the full report/room index must never be blocked by it");
  const indexBody = await indexRes.json();
  assert.ok(Array.isArray(indexBody.rooms));
});

test('DIRECTION 2: draining the general (10/min) bucket never blocks room-status polling, which has its own separate (30/min) budget', async () => {
  const ip = 'poll-isolation-direction-2';
  const signupRes = await signup('poll-direction2@example.com', ip);
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  await resetRateForTest(ip);
  await resetPollRateForTest(ip);

  // Fully exhaust the general bucket via the room index (checkRate).
  for (let i = 0; i < 10; i++) {
    const res = await roomsRoute.GET(roomIndexRequest(cookie, ip));
    assert.equal(res.status, 200, `general-bucket request ${i + 1} must succeed while under the limit`);
  }
  const eleventh = await roomsRoute.GET(roomIndexRequest(cookie, ip));
  assert.equal(eleventh.status, 429, 'the general bucket must now genuinely be exhausted — otherwise this test proves nothing');

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
  for (let i = 0; i < 30; i++) {
    await reportsRoute.GET(roomPollRequest(cookie, ip, 0));
  }
  const res = await reportsRoute.GET(roomPollRequest(cookie, ip, 0));
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error, 'Too many requests');
  assert.ok(res.headers.get('Retry-After'), 'a genuine poll-bucket 429 must still carry Retry-After, exactly like a general-bucket one');
});
