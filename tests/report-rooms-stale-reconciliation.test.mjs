import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  statusLabel,
  resolveRoomIndexFetch,
} from '../components/reports/report-rooms.tsx';

/**
 * BUG: after "Clear account rooms" (or account deletion / single-report
 * delete / the same account open elsewhere), a deleted report's room card
 * still showed a green "Report ready · Last checked …" accent, because
 * ReportRoomsBrowser's loadIndex() rendered the 24h client cache
 * (lib/report-rooms-cache.ts) — first painting it, then (earlier fix)
 * revalidating. That still let a deleted room flash as "ready".
 *
 * FIX (server-first): loadIndex() now fetches GET /api/reports/rooms FIRST
 * and never renders the cache before a successful fetch. The cache is a
 * fetch-failure fallback only. resolveRoomIndexFetch() is the pure decision
 * this uses; these tests pin it. The end-to-end "an emptied room renders as
 * a canonical empty room" proof is in
 * tests/report-rooms-empty-after-reset.test.mjs (real DB + real routes).
 * This repo has no React render harness — see
 * tests/room-lifecycle-reconciliation.test.mjs's own header comment for the
 * "extract pure decision functions, test them directly" convention.
 */

const cachedReadyIndex = [
  { room: 0, status: 'empty', mostRecentAt: null, cycleEndsAt: null },
  { room: 1, status: 'ready', mostRecentAt: '2026-08-28T09:00:00.000Z', cycleEndsAt: '2026-08-29T09:00:00.000Z' },
  { room: 4, status: 'ready', mostRecentAt: '2026-08-28T10:00:00.000Z', cycleEndsAt: '2026-08-29T10:00:00.000Z' },
];
const freshAllEmptyIndex = [
  { room: 0, status: 'empty', mostRecentAt: null, cycleEndsAt: null },
  { room: 1, status: 'empty', mostRecentAt: null, cycleEndsAt: null },
  { room: 4, status: 'empty', mostRecentAt: null, cycleEndsAt: null },
];

// --- resolveRoomIndexFetch: server first -----------------------------

test('REQUIRED: cached Room 2/5 = ready, authoritative fetch = empty -> the fresh (empty) index is what renders; the stale ready entries are never used', () => {
  const resolution = resolveRoomIndexFetch(cachedReadyIndex, { ok: true, rooms: freshAllEmptyIndex });
  assert.equal(resolution.rooms, freshAllEmptyIndex, 'a successful fetch is authoritative — its exact array is returned, never the cache');
  assert.equal(resolution.error, false);
  for (const entry of resolution.rooms) {
    assert.equal(entry.status, 'empty', 'no ready lifecycle state');
    assert.equal(entry.mostRecentAt, null, 'no stale last-checked date');
    assert.equal(entry.cycleEndsAt, null);
    assert.equal(`report-room-row-${entry.status}`, 'report-room-row-empty', 'no green .report-room-row-ready class');
    assert.equal(statusLabel(entry.status), 'Ready for a new check', 'label is exactly a never-used empty room');
    assert.ok(!('reportId' in entry), 'no report id');
  }
});

test('a successful fetch with no cache is rendered as-is', () => {
  assert.deepEqual(
    resolveRoomIndexFetch(null, { ok: true, rooms: freshAllEmptyIndex }),
    { rooms: freshAllEmptyIndex, error: false },
  );
});

test('FALLBACK: fetch fails but a cache exists -> the cache is used (fetch-failure resilience), no error state', () => {
  const resolution = resolveRoomIndexFetch(cachedReadyIndex, { ok: false, status: 500 });
  assert.equal(resolution.rooms, cachedReadyIndex, 'the cache is the fallback ONLY on a failed fetch');
  assert.equal(resolution.error, false);
});

test('fetch fails with NO cache -> the existing "couldn\'t load your rooms" error state', () => {
  assert.deepEqual(
    resolveRoomIndexFetch(null, { ok: false, status: null }),
    { rooms: null, error: true },
  );
});

// --- statusLabel ---------------------------------------------------

test('statusLabel: an empty room renders "Ready for a new check", identical to a never-used room', () => {
  assert.equal(statusLabel('empty'), 'Ready for a new check');
  assert.equal(statusLabel('ready'), 'Report ready');
  assert.equal(statusLabel('processing'), 'Processing…');
  assert.equal(statusLabel('failed'), 'AI check failed — tap to retry');
});

// --- structural: loadIndex is server-first ------------------------

test('structural: loadIndex fetches BEFORE reading the cache, never renders the cache pre-fetch, and clears any prior account list', async () => {
  const src = await readFile(new URL('../components/reports/report-rooms.tsx', import.meta.url), 'utf8');
  const start = src.indexOf('async function loadIndex()');
  const end = src.indexOf('loadIndex();', start);
  assert.ok(start !== -1 && end > start, 'loadIndex must exist');
  const body = src.slice(start, end);

  // No pre-fetch cache render, ever.
  assert.ok(!/setRoomIndex\(cached\)/.test(body), 'the cache is never rendered directly');
  assert.ok(!/setRoomIndex\(result\.rooms\)/.test(body), 'the raw fetch result is never rendered directly — it goes through resolveRoomIndexFetch');

  // Prior account's list is cleared and a skeleton shown while fetching.
  const clearIdx = body.indexOf('setRoomIndex(null)');
  const fetchIdx = body.indexOf('await fetchReportRoomIndex()');
  const cacheReadIdx = body.indexOf('getCachedRoomIndex(accountEmail)');
  const cancelledIdx = body.indexOf('if (cancelled) return');
  const resolveIdx = body.indexOf('resolveRoomIndexFetch(cached, result)');

  assert.ok(clearIdx !== -1 && clearIdx < fetchIdx, 'setRoomIndex(null) clears any prior account list before the fetch');
  assert.ok(fetchIdx !== -1, 'the authoritative fetch happens');
  assert.ok(cancelledIdx > fetchIdx, 'the in-flight response is dropped when the account changed / component unmounted');
  assert.ok(cacheReadIdx > cancelledIdx, 'the cache is read only AFTER the fetch (it is a fallback, not a pre-render)');
  assert.ok(resolveIdx > cacheReadIdx, 'the render decision goes through the tested pure function');
  assert.ok(/setLoading|setIndexLoading\(true\)/.test(body) && body.indexOf('setIndexLoading(true)') < fetchIdx, 'a loading/skeleton state is shown while fetching');
});
