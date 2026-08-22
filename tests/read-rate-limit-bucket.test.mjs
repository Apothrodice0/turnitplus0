import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as roomsRoute from '../app/api/reports/rooms/route.ts';
import * as uploadLimitRoute from '../app/api/upload-limit/route.ts';
import * as reportByIdRoute from '../app/api/reports/[id]/route.ts';
import * as logoutRoute from '../app/api/auth/logout/route.ts';
import {
  resetAuthRateForTest,
  resetRateForTest,
  resetReadRateForTest,
  resetPollRateForTest,
  checkReadRate,
  checkPollRate,
} from '../lib/rate-limit.ts';

/**
 * Production bug fix: ordinary authenticated browsing (My Reports, opening
 * a room, going back, opening another room) used to draw from the exact
 * same general/strict bucket (10/min) that uploads, login, and destructive
 * operations depend on — a completely normal session could exhaust it and
 * produce "you're signed in, but this device has made a lot of requests" for
 * a user who did nothing abusive. Reproduction: Upload -> Room while AI
 * processing -> Back to My Reports -> Click another room.
 *
 * Fix: three independent buckets, namespaced by distinct bucket-key
 * prefixes so none can ever drain another (see lib/rate-limit.ts's own
 * header comment) —
 *   1. strict/abuse-sensitive (checkRate/checkAuthRate): login, signup,
 *      uploads, account mutations, destructive operations.
 *   2. read/navigation (checkReadRate, new in this fix): the room index,
 *      upload-quota display, a room's own SSR page load, a report's own SSR
 *      page load, and the account-wide/device-key report list.
 *   3. AI status polling (checkPollRate, already isolated — see
 *      tests/poll-rate-limit-isolation.test.mjs, which this file
 *      deliberately does not duplicate).
 *
 * This file proves, with real route-handler calls and actual request
 * counts: (a) ordinary room/report navigation cannot exhaust the strict
 * bucket, (b) repeated navigation stays available under its own generous
 * limit, (c) uploads/login/destructive requests still hit the strict limit
 * and a genuine 429 still looks like one, and (d) the exact reproduction
 * sequence from the bug report no longer touches the strict bucket at all.
 *
 * app/reports/rooms/[room]/page.tsx and app/reports/[id]/page.tsx's own SSR
 * rate-limit gates call checkReadRate directly (see
 * tests/room-detail-route.test.mjs and tests/report-detail-route.test.mjs
 * for their source-text wiring coverage) — they can't be invoked here the
 * way a route handler can (next/headers' cookies()/headers() require a real
 * Next.js request context this test environment doesn't provide), so the
 * "Room 1" / "Room 4" / "Room 2" steps below call checkReadRate(ip) directly
 * to stand in for that gate. That is not a simulation of the fix — it is
 * the literal same function, same bucket key, that the page itself calls.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_read_rate_limit_bucket.db');
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

// Deterministic bucket-state seeding, matching tests/rate-limit-durable.
// test.mjs's own rewindLastRefill technique: directly writes a known
// (bucket_key, tokens, last_refill) state instead of spending dozens of
// real checkRate-family round trips getting there. SQLite serializes writes
// to a single file regardless of how many requests are dispatched
// concurrently (see lib/rate-limit.ts's checkBucket — a single-writer UPSERT
// per call), so a real drain of a bucket this size (60 tokens, refilling at
// exactly 1/sec) accumulates enough real wall-clock time on a loaded machine
// for that same refill to occasionally add back a stray token right at the
// boundary — a flake with nothing to do with the limiter's own correctness.
// Pinning last_refill to "now" immediately before the boundary check removes
// that dependency on real elapsed time entirely.
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

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, ip, password = 'correct-horse-read-1') {
  await resetAuthRateForTest(ip);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password, username: email.split('@')[0], deviceKey: `device-${email}` }),
  });
  return signupRoute.POST(req);
}

function authedHeaders(ip, cookie) {
  return { 'x-forwarded-for': ip, cookie: `tp_session_v1=${cookie}` };
}

function roomIndexRequest(ip, cookie) {
  return new Request('http://localhost/api/reports/rooms', { headers: authedHeaders(ip, cookie) });
}

function uploadLimitRequest(ip, cookie) {
  return new Request('http://localhost/api/upload-limit', { headers: authedHeaders(ip, cookie) });
}

function reportsListRequest(ip, cookie) {
  return new Request('http://localhost/api/reports', { headers: authedHeaders(ip, cookie) });
}

function roomPollRequest(ip, cookie, room) {
  return new Request(`http://localhost/api/reports?room=${room}`, { headers: authedHeaders(ip, cookie) });
}

function loginRequest(ip, email, password) {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password }),
  });
}

function logoutRequest(ip) {
  return new Request('http://localhost/api/auth/logout', { method: 'POST', headers: { 'x-forwarded-for': ip } });
}

function deleteReportRequest(ip, reportId) {
  return new Request(`http://localhost/api/reports/${reportId}?deviceKey=read-bucket-delete-device`, {
    method: 'DELETE',
    headers: { 'x-forwarded-for': ip },
  });
}

let uploadCounter = 0;
function samplePayload(overrides = {}) {
  uploadCounter += 1;
  return {
    version: 11,
    id: overrides.id ?? `read-bucket-upload-${uploadCounter}`,
    submissionId: `read-bucket-sub-${uploadCounter}`,
    title: 'read-bucket-sample.pdf',
    created: new Date().toISOString(),
    score: 3,
    wordCount: 400,
    text: 'sample extracted text for read-rate-limit-bucket testing',
    ...overrides,
  };
}

async function postReport(ip, deviceKey, { cookie, room = 0, id } = {}) {
  const payload = samplePayload({ id });
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceKey,
      id: String(payload.id),
      submissionId: payload.submissionId,
      title: payload.title,
      createdAt: payload.created,
      wordCount: payload.wordCount,
      archiveScore: payload.score,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      room,
      payload,
    }),
  });
  return reportsRoute.POST(req);
}

// --- 1. Ordinary room/report navigation cannot exhaust the strict (write/auth) bucket ---

test('normal room navigation cannot exhaust the strict write/auth bucket', async () => {
  const ip = 'read-bucket-cannot-exhaust-strict';
  const signupRes = await signup('read-1@example.com', ip);
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  await resetRateForTest(ip);
  await resetReadRateForTest(ip);

  // Far more browsing than the strict bucket's entire 10-token budget (20
  // read-bucket requests: room index + upload-quota display, interleaved,
  // 10 times each) — none of it may touch the strict bucket at all.
  for (let i = 0; i < 10; i++) {
    const indexRes = await roomsRoute.GET(roomIndexRequest(ip, cookie));
    assert.equal(indexRes.status, 200, `room-index request ${i + 1} must succeed`);
    const limitRes = await uploadLimitRoute.GET(uploadLimitRequest(ip, cookie));
    assert.equal(limitRes.status, 200, `upload-limit request ${i + 1} must succeed`);
  }

  // The strict bucket, on the SAME IP, must still be fully intact — proven
  // by actually draining all 10 of its own tokens via a real strict-bucket
  // action (logout; see lib/rate-limit.ts's checkRate) with zero shortfall.
  for (let i = 0; i < 10; i++) {
    const res = await logoutRoute.POST(logoutRequest(ip));
    assert.equal(res.status, 200, `strict-bucket request ${i + 1}/10 must still succeed — untouched by the 20 read-bucket requests above`);
  }
  const eleventh = await logoutRoute.POST(logoutRequest(ip));
  assert.equal(eleventh.status, 429, 'the strict bucket must still enforce its own real limit once genuinely exhausted by strict-bucket traffic itself');
});

// --- 2. Repeated room navigation remains available under its own generous limit ---

test('repeated room navigation remains available well past the old 10-token general limit, and the read bucket is itself still a real, bounded limit', async () => {
  const ip = 'read-bucket-repeated-navigation';
  const signupRes = await signup('read-2@example.com', ip);
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  await resetReadRateForTest(ip);

  // Prove generosity with real, actually-counted requests through the real
  // route — well past the OLD 10-token shared general limit.
  for (let i = 0; i < 20; i++) {
    const res = await roomsRoute.GET(roomIndexRequest(ip, cookie));
    assert.equal(res.status, 200, `real read-bucket request ${i + 1}/20 must succeed`);
  }

  // Prove the exact ceiling (60 — READ_MAX_TOKENS in lib/rate-limit.ts)
  // deterministically: seed the bucket directly to "1 token remaining,
  // refilled just now" — the same state it would organically be in after 59
  // of its 60 tokens were already consumed — instead of spending 59 more
  // real round trips getting there (see this file's own seedBucket comment
  // for why that would be timing-fragile for a bucket this size).
  await seedBucket(`read:${ip}`, 1);
  const lastToken = await checkReadRate(ip);
  assert.equal(lastToken.allowed, true, 'the real last token must still be usable');
  const overLimit = await checkReadRate(ip);
  assert.equal(overLimit.allowed, false, 'the read bucket must reject once its real ceiling is reached — a real, bounded limit, not "no limit at all"');

  // Real-route confirmation, at the actual API surface.
  const routeRes = await roomsRoute.GET(roomIndexRequest(ip, cookie));
  assert.equal(routeRes.status, 429, 'a genuinely exhausted read bucket must reject the next real HTTP request too');
  assert.ok(routeRes.headers.get('Retry-After'), 'a genuine read-bucket 429 must carry Retry-After, like any other 429');
});

// --- 3. AI polling remains its own third, isolated bucket ---

test('AI status polling remains isolated from both the strict bucket and the new read/navigation bucket', async () => {
  const ip = 'read-bucket-poll-isolation';
  const signupRes = await signup('read-3@example.com', ip);
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  await resetRateForTest(ip);
  await resetReadRateForTest(ip);
  await resetPollRateForTest(ip);

  // Deterministically exhaust the read bucket (seed straight to 0 tokens,
  // refilled just now) rather than draining it via dozens of real round
  // trips — see seedBucket's own comment on why that's what keeps this
  // reliable on a loaded machine.
  await seedBucket(`read:${ip}`, 0);
  const drainedDirect = await checkReadRate(ip);
  assert.equal(drainedDirect.allowed, false, 'sanity: the read bucket must now genuinely be exhausted');
  const drainedRead = await roomsRoute.GET(roomIndexRequest(ip, cookie));
  assert.equal(drainedRead.status, 429, 'sanity: confirmed at the real route too');

  // Room-status polling, on the SAME now-exhausted IP, is entirely
  // unaffected — its own separate (30/min) budget.
  for (let i = 0; i < 15; i++) {
    const res = await reportsRoute.GET(roomPollRequest(ip, cookie, 0));
    assert.equal(res.status, 200, `poll request ${i + 1} must succeed even with the read bucket fully drained`);
  }

  // And, symmetrically, draining polling never touches the read bucket
  // (already covered end-to-end in tests/poll-rate-limit-isolation.test.mjs
  // against the strict bucket; re-confirmed here against the read bucket
  // specifically, since that bucket didn't exist when that file was written).
  await resetReadRateForTest(ip);
  await seedBucket(`poll:${ip}`, 0);
  const drainedPollDirect = await checkPollRate(ip);
  assert.equal(drainedPollDirect.allowed, false, 'sanity: the poll bucket must now genuinely be exhausted');
  const drainedPollRoute = await reportsRoute.GET(roomPollRequest(ip, cookie, 0));
  assert.equal(drainedPollRoute.status, 429, 'sanity: confirmed at the real route too');
  const readStillFine = await roomsRoute.GET(roomIndexRequest(ip, cookie));
  assert.equal(readStillFine.status, 200, 'the read bucket must be entirely unaffected by a fully-drained poll bucket');
});

// --- 4. Uploads still hit the strict limit ---

test('uploads still hit the strict limit (10/min), unaffected by any amount of read/navigation traffic', async () => {
  const ip = 'read-bucket-uploads-strict';
  const signupRes = await signup('read-4@example.com', ip);
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  await resetRateForTest(ip);
  await resetReadRateForTest(ip);

  // Heavy read traffic first — must have no bearing on the upload count below.
  for (let i = 0; i < 20; i++) {
    await roomsRoute.GET(roomIndexRequest(ip, cookie));
  }

  for (let i = 0; i < 10; i++) {
    const res = await postReport(ip, 'device-read-bucket-uploads', { cookie, room: i, id: `upload-strict-${i}` });
    assert.equal(res.status, 200, `upload ${i + 1}/10 must succeed`);
  }
  const eleventh = await postReport(ip, 'device-read-bucket-uploads', { cookie, room: 0, id: 'upload-strict-11th' });
  assert.equal(eleventh.status, 429, 'the 11th upload in this window must be rejected by the strict bucket');
  assert.ok(eleventh.headers.get('Retry-After'));
});

// --- 5. Login still hits the strict (auth) limit ---

test('login still hits the strict auth limit (5/min) — brute force is still bounded', async () => {
  const ip = 'read-bucket-login-strict';
  await resetAuthRateForTest(ip);
  await signup('read-5@example.com', `${ip}-signup`, 'correct-horse-read-5');
  // signup's own resetAuthRateForTest ran against a different ip; re-reset
  // this test's own ip fresh right before the login attempts it actually measures.
  await resetAuthRateForTest(ip);

  for (let i = 0; i < 5; i++) {
    const res = await loginRoute.POST(loginRequest(ip, 'read-5@example.com', 'wrong-password'));
    assert.equal(res.status, 401, `login attempt ${i + 1}/5 must reach real password verification (401), not be rate-limited yet`);
  }
  const sixth = await loginRoute.POST(loginRequest(ip, 'read-5@example.com', 'wrong-password'));
  assert.equal(sixth.status, 429, 'the 6th login attempt within the window must be rejected by the strict auth bucket');
  assert.ok(sixth.headers.get('Retry-After'));

  // Even the CORRECT password is blocked once the bucket is exhausted — the
  // limiter runs before credential verification.
  const correctButBlocked = await loginRoute.POST(loginRequest(ip, 'read-5@example.com', 'correct-horse-read-5'));
  assert.equal(correctButBlocked.status, 429, 'the auth bucket must reject even a correct password once genuinely exhausted');
});

// --- 6. Genuine abuse (repeated destructive requests) still receives 429 ---

test('repeated destructive requests (DELETE) still receive a genuine 429 with Retry-After', async () => {
  const ip = 'read-bucket-destructive-abuse';
  await resetRateForTest(ip);

  for (let i = 0; i < 10; i++) {
    const res = await reportByIdRoute.DELETE(deleteReportRequest(ip, `nonexistent-${i}`), { params: Promise.resolve({ id: `nonexistent-${i}` }) });
    assert.equal(res.status, 200, `destructive request ${i + 1}/10 must be allowed through (idempotent delete of a nonexistent id still counts against the bucket)`);
  }
  const eleventh = await reportByIdRoute.DELETE(deleteReportRequest(ip, 'nonexistent-11'), { params: Promise.resolve({ id: 'nonexistent-11' }) });
  assert.equal(eleventh.status, 429, 'genuine repeated destructive-request abuse must still be rejected');
  assert.ok(eleventh.headers.get('Retry-After'));
  const body = await eleventh.json();
  assert.equal(body.error, 'Too many requests');
});

// --- 7. The exact reported reproduction, with real request counts ---

test('REPRODUCTION: My Reports -> Room 1 -> Back -> Room 4 -> Back -> Room 2 never touches the strict bucket, and the strict bucket remains fully available afterward', async () => {
  const ip = 'read-bucket-exact-repro';
  const signupRes = await signup('read-repro@example.com', ip);
  const cookie = extractCookie(signupRes);
  assert.ok(cookie);

  await resetRateForTest(ip);
  await resetReadRateForTest(ip);

  let readBucketRequests = 0;

  // "My Reports" page load: room index + upload-quota display.
  async function openMyReports() {
    const indexRes = await roomsRoute.GET(roomIndexRequest(ip, cookie));
    assert.equal(indexRes.status, 200);
    readBucketRequests += 1;
    const limitRes = await uploadLimitRoute.GET(uploadLimitRequest(ip, cookie));
    assert.equal(limitRes.status, 200);
    readBucketRequests += 1;
  }

  // "Click room N": the room page's own SSR gate — see this file's header
  // comment on why checkReadRate is called directly here rather than
  // rendering app/reports/rooms/[room]/page.tsx itself.
  async function openRoom() {
    const rate = await checkReadRate(ip);
    assert.equal(rate.allowed, true);
    readBucketRequests += 1;
  }

  await openMyReports();       // My Reports
  await openRoom();            // Room 1
  await openMyReports();       // Back to My Reports
  await openRoom();            // Room 4
  await openMyReports();       // Back to My Reports
  await openRoom();            // Room 2

  // Real, counted request total for the exact sequence in the bug report:
  // 3x My Reports (2 requests each) + 3x room open (1 request each) = 9.
  // The OLD shared general bucket had exactly 10 tokens total, refilling
  // only 10/min — this ordinary sequence alone would have consumed 9 of
  // them, leaving a single spare token for anything else sharing that same
  // budget (the initial upload that started the reproduction, another
  // back-and-forth, a second tab). That razor-thin margin is exactly why
  // the reported bug was so easy to hit doing nothing abusive.
  assert.equal(readBucketRequests, 9, 'sanity: this many real read-bucket requests were actually made during the reproduction');

  // The strict bucket must be completely untouched by all of the above —
  // proven by draining all 10 of its own tokens via a real strict action.
  for (let i = 0; i < 10; i++) {
    const res = await logoutRoute.POST(logoutRequest(ip));
    assert.equal(res.status, 200, `strict-bucket request ${i + 1}/10 must succeed after the full reproduction sequence above`);
  }
  const eleventh = await logoutRoute.POST(logoutRequest(ip));
  assert.equal(eleventh.status, 429, 'the strict bucket still enforces its own real limit — this fix narrows what draws from it, not the limit itself');
});
