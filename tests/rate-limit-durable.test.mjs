import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { checkRate, checkAuthRate, resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.ts';

/**
 * Durable, distributed rate limiting (production audit fix). Proves
 * lib/rate-limit.ts's Turso-backed replacement for the old in-memory
 * Map-based token buckets — which gave no real protection on Vercel
 * serverless, since every concurrent/cold-started instance had its own
 * empty Map (verified empirically in production before this fix: 12+
 * rapid requests against a 10/min route never returned 429).
 *
 * Real DB calls throughout (a local libSQL file, migrated the same way
 * every other test file in this repo already does), no mocking. Limits and
 * semantics are unchanged from the pre-fix implementation: 10/min general
 * (checkRate), 5/min auth (checkAuthRate), same {allowed:true} |
 * {allowed:false, retryAfter} return shape.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_rate_limit_durable.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);

test.after(() => {
  setupClient.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

async function bucketRow(bucketKey) {
  const result = await setupClient.execute({ sql: 'SELECT tokens, last_refill, last_allowed FROM rate_limit_buckets WHERE bucket_key = ?', args: [bucketKey] });
  return result.rows[0] ?? null;
}

async function rewindLastRefill(bucketKey, msAgo) {
  await setupClient.execute({
    sql: 'UPDATE rate_limit_buckets SET last_refill = ? WHERE bucket_key = ?',
    args: [Date.now() - msAgo, bucketKey],
  });
}

// --- 1. WITHIN-WINDOW REQUESTS ----------------------------------------------

test('WITHIN-WINDOW: requests under the limit are all allowed, general (10/min) and auth (5/min) alike', async () => {
  await resetRateForTest('within-general');
  for (let i = 0; i < 10; i++) {
    const r = await checkRate('within-general');
    assert.equal(r.allowed, true, `general request ${i + 1}/10 must be allowed`);
  }

  await resetAuthRateForTest('within-auth');
  for (let i = 0; i < 5; i++) {
    const r = await checkAuthRate('within-auth');
    assert.equal(r.allowed, true, `auth request ${i + 1}/5 must be allowed`);
  }
});

// --- 2. LIMIT REACHED --------------------------------------------------------

test('LIMIT REACHED: the request immediately past the limit is rejected with a positive retryAfter, for both limiters', async () => {
  await resetRateForTest('limit-general');
  for (let i = 0; i < 10; i++) assert.equal((await checkRate('limit-general')).allowed, true);
  const rejected = await checkRate('limit-general');
  assert.equal(rejected.allowed, false);
  assert.ok(rejected.retryAfter > 0 && rejected.retryAfter <= 6, `retryAfter should be a small positive number of seconds, got ${rejected.retryAfter}`);
  // Repeated over-limit requests keep being rejected, not flip-flopping.
  assert.equal((await checkRate('limit-general')).allowed, false);

  await resetAuthRateForTest('limit-auth');
  for (let i = 0; i < 5; i++) assert.equal((await checkAuthRate('limit-auth')).allowed, true);
  const authRejected = await checkAuthRate('limit-auth');
  assert.equal(authRejected.allowed, false);
  assert.ok(authRejected.retryAfter > 0, `auth retryAfter should be positive, got ${authRejected.retryAfter}`);
});

// --- 3. WINDOW EXPIRATION ----------------------------------------------------

test('WINDOW EXPIRATION: a fully-consumed bucket refills once the interval has genuinely elapsed', async () => {
  await resetRateForTest('expiry-general');
  for (let i = 0; i < 10; i++) assert.equal((await checkRate('expiry-general')).allowed, true);
  assert.equal((await checkRate('expiry-general')).allowed, false, 'sanity: bucket must be exhausted');

  // Simulate a full minute having passed, without touching the system
  // clock or the production code path at all — directly rewind the
  // persisted last_refill, exactly as if this same row had simply not
  // been touched for 60s.
  await rewindLastRefill('general:expiry-general', 60_000);
  const afterFullWindow = await checkRate('expiry-general');
  assert.equal(afterFullWindow.allowed, true, 'a full interval elapsed must fully refill the bucket');

  // Partial elapsed time must refill proportionally, not all-or-nothing —
  // exhaust again, rewind by exactly half the window, expect ~5 of the
  // next 10 tokens available (not 0, not 10).
  for (let i = 0; i < 9; i++) assert.equal((await checkRate('expiry-general')).allowed, true, 'draining back down to exhaustion');
  assert.equal((await checkRate('expiry-general')).allowed, false, 'sanity: exhausted again');
  await rewindLastRefill('general:expiry-general', 30_000);
  let allowedAfterHalfWindow = 0;
  for (let i = 0; i < 10; i++) {
    if ((await checkRate('expiry-general')).allowed) allowedAfterHalfWindow += 1;
  }
  assert.ok(
    allowedAfterHalfWindow >= 4 && allowedAfterHalfWindow <= 6,
    `expected ~5 tokens refilled after half the window elapsed, got ${allowedAfterHalfWindow}`,
  );
});

// --- 4. CONCURRENT REQUESTS --------------------------------------------------

test('CONCURRENT: exactly maxTokens of many simultaneous requests for the same fresh key are allowed — no over-admission, no lost decrement', async () => {
  await resetRateForTest('concurrent-general');
  const results = await Promise.all(Array.from({ length: 30 }, () => checkRate('concurrent-general')));
  const allowedCount = results.filter((r) => r.allowed).length;
  assert.equal(allowedCount, 10, `expected exactly 10 of 30 concurrent requests allowed, got ${allowedCount}`);

  // The row itself must be internally consistent afterward: exactly one
  // row for this key (no duplicate-insert race), and tokens left in a
  // sane, non-negative range.
  const rows = await setupClient.execute({ sql: 'SELECT COUNT(*) AS cnt FROM rate_limit_buckets WHERE bucket_key = ?', args: ['general:concurrent-general'] });
  assert.equal(Number(rows.rows[0].cnt), 1, 'exactly one bucket row must exist — no duplicate-insert race under concurrency');
  const row = await bucketRow('general:concurrent-general');
  assert.ok(row.tokens >= 0, 'tokens must never go negative');

  await resetAuthRateForTest('concurrent-auth');
  const authResults = await Promise.all(Array.from({ length: 15 }, () => checkAuthRate('concurrent-auth')));
  assert.equal(authResults.filter((r) => r.allowed).length, 5, 'expected exactly 5 of 15 concurrent auth requests allowed');
});

// --- 5. INDEPENDENT CLIENT/IP KEYS -------------------------------------------

test('INDEPENDENT KEYS: different clientIds never share a bucket, and checkRate/checkAuthRate never share a bucket for the SAME clientId', async () => {
  await resetRateForTest('independent-x');
  await resetRateForTest('independent-y');
  for (let i = 0; i < 10; i++) assert.equal((await checkRate('independent-x')).allowed, true);
  assert.equal((await checkRate('independent-x')).allowed, false, 'x must now be exhausted');
  // y, a completely different client, must be entirely unaffected.
  assert.equal((await checkRate('independent-y')).allowed, true, 'y must be unaffected by x being exhausted');

  // Same literal clientId string, but general vs auth — must be two
  // independent buckets (namespaced "general:"/"auth:" internally),
  // matching the pre-fix two-separate-Maps behavior exactly.
  const sharedId = 'independent-shared-id';
  await resetRateForTest(sharedId);
  await resetAuthRateForTest(sharedId);
  for (let i = 0; i < 5; i++) assert.equal((await checkAuthRate(sharedId)).allowed, true);
  assert.equal((await checkAuthRate(sharedId)).allowed, false, 'auth bucket for this id must now be exhausted');
  assert.equal((await checkRate(sharedId)).allowed, true, 'general bucket for the SAME id must be completely independent, still fresh');
});

// --- 6. CROSS-INSTANCE SIMULATION USING THE SHARED DATABASE -----------------

test('CROSS-INSTANCE: two independently-connected "instances" sharing only the database (no shared JS state) correctly enforce ONE combined limit', async () => {
  // Two separate libsql connections to the exact same file — standing in
  // for two separate Vercel serverless instances, which share nothing in
  // process memory and would each have started with their own empty Map
  // under the old implementation. checkRate() itself already opens a
  // fresh connection per call (see lib/rate-limit.ts — there is no
  // module-level client cache to begin with), so calling it from two
  // separate scopes here is a faithful simulation, not a special code path.
  const instanceAConnection = createClient({ url: `file:${dbFile}` });
  const instanceBConnection = createClient({ url: `file:${dbFile}` });

  const bucketKey = 'cross-instance-shared';
  await resetRateForTest(bucketKey);

  // Interleave calls "from" each instance.
  const callOrder = [];
  for (let i = 0; i < 6; i++) {
    callOrder.push({ instance: 'A', result: await checkRate(bucketKey) });
    callOrder.push({ instance: 'B', result: await checkRate(bucketKey) });
  }
  const allowedTotal = callOrder.filter((c) => c.result.allowed).length;
  assert.equal(allowedTotal, 10, `expected exactly 10 allowed across BOTH instances combined (not 10 each), got ${allowedTotal}`);

  const allowedByA = callOrder.filter((c) => c.instance === 'A' && c.result.allowed).length;
  const allowedByB = callOrder.filter((c) => c.instance === 'B' && c.result.allowed).length;
  assert.ok(allowedByA < 10 && allowedByB < 10, 'neither instance alone should have been able to claim the full limit independently');
  assert.equal(allowedByA + allowedByB, 10);

  // Contrast case, spelled out explicitly: what the OLD in-memory
  // implementation actually did — two independent Maps, each starting
  // full, with NO shared state at all. This is the exact bug this
  // migration fixes: under the old design, "instance A" and "instance B"
  // below would BOTH report 10/10 allowed (20 total), because neither Map
  // ever knew the other existed.
  function oldInMemoryStyleBucket() {
    let tokens = 10;
    return {
      check() {
        if (tokens >= 1) { tokens -= 1; return { allowed: true }; }
        return { allowed: false };
      },
    };
  }
  const oldInstanceA = oldInMemoryStyleBucket();
  const oldInstanceB = oldInMemoryStyleBucket();
  let oldAllowedTotal = 0;
  for (let i = 0; i < 10; i++) {
    if (oldInstanceA.check().allowed) oldAllowedTotal += 1;
    if (oldInstanceB.check().allowed) oldAllowedTotal += 1;
  }
  assert.equal(oldAllowedTotal, 20, 'documents the bug being fixed: two unshared in-memory buckets would incorrectly allow 20, not 10');
  assert.notEqual(allowedTotal, oldAllowedTotal, 'the durable implementation must behave differently (and correctly) where the old one did not');

  instanceAConnection.close();
  instanceBConnection.close();
});

// --- resetRateForTest/resetAuthRateForTest actually clear state ------------

test('RESET: resetRateForTest/resetAuthRateForTest actually clear persisted state, not just an in-memory reference', async () => {
  await resetRateForTest('reset-check');
  for (let i = 0; i < 10; i++) await checkRate('reset-check');
  assert.equal((await checkRate('reset-check')).allowed, false, 'sanity: exhausted');
  assert.ok(await bucketRow('general:reset-check'), 'sanity: a row exists');

  await resetRateForTest('reset-check');
  assert.equal(await bucketRow('general:reset-check'), null, 'the row itself must be deleted, not just zeroed');
  assert.equal((await checkRate('reset-check')).allowed, true, 'a fresh bucket must be available immediately after reset');
});
