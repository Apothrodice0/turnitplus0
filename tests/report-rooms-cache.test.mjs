import assert from 'node:assert';
import test from 'node:test';

// Verifies the 10-room architecture's client-side 24h cache
// (lib/report-rooms-cache.ts) in isolation: this file has no React
// component-test harness available (see tests/report-persistence-wiring.test.mjs's
// own header comment for the same discipline), so this exercises the cache
// module directly against a minimal in-memory localStorage stand-in rather
// than rendering ReportRoomsBrowser.

function createMockLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

// lib/report-rooms-cache.ts reads `window.localStorage` lazily, inside each
// function call, not at module load — so this stub just needs to exist
// before any cache function is actually called, which import ordering here
// already guarantees (ESM imports are hoisted, but nothing in the module
// touches `window` at the top level).
globalThis.window = { localStorage: createMockLocalStorage() };

const {
  getCachedRoomIndex,
  setCachedRoomIndex,
  getCachedRoom,
  setCachedRoom,
  invalidateRoomCache,
  clearAllReportRoomCaches,
} = await import('../lib/report-rooms-cache.ts');

const REAL_DATE_NOW = Date.now;
function withFakeNow(ms, fn) {
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = REAL_DATE_NOW;
  }
}

const sampleIndex = [{ room: 0, status: 'ready', mostRecentAt: '2026-08-20T00:00:00.000Z', cycleEndsAt: '2026-08-21T00:00:00.000Z' }];
const sampleRoomContents = {
  status: 'ready',
  report: { id: '1', submissionId: 's1', title: 't', createdAt: '2026-08-20T00:00:00.000Z', wordCount: 10, archiveScore: 1, scoreBand: 'Low', aiScore: null, aiTone: null },
  cycleEndsAt: '2026-08-21T00:00:00.000Z',
};

test('a freshly-written room index is served from cache immediately', () => {
  withFakeNow(1_000_000, () => setCachedRoomIndex('a@example.com', sampleIndex));
  const result = withFakeNow(1_000_000, () => getCachedRoomIndex('a@example.com'));
  assert.deepEqual(result, sampleIndex);
});

test('a room index cached just under 24h ago is still served from cache', () => {
  const writeAt = 1_000_000;
  const almost24h = writeAt + 24 * 60 * 60 * 1000 - 1000;
  withFakeNow(writeAt, () => setCachedRoomIndex('b@example.com', sampleIndex));
  const result = withFakeNow(almost24h, () => getCachedRoomIndex('b@example.com'));
  assert.deepEqual(result, sampleIndex, 'a cache entry must remain usable for up to 24 hours');
});

test('a room index cached more than 24h ago is treated as a miss (null), not stale data', () => {
  const writeAt = 1_000_000;
  const past24h = writeAt + 24 * 60 * 60 * 1000 + 1000;
  withFakeNow(writeAt, () => setCachedRoomIndex('c@example.com', sampleIndex));
  const result = withFakeNow(past24h, () => getCachedRoomIndex('c@example.com'));
  assert.equal(result, null, 'an entry past its 24h TTL must refresh, not be served indefinitely');
});

test('room contents follow the same 24h TTL, independently of the index', () => {
  const writeAt = 2_000_000;
  withFakeNow(writeAt, () => setCachedRoom('d@example.com', 4, sampleRoomContents));
  assert.deepEqual(withFakeNow(writeAt + 1000, () => getCachedRoom('d@example.com', 4)), sampleRoomContents);
  assert.equal(withFakeNow(writeAt + 24 * 60 * 60 * 1000 + 1, () => getCachedRoom('d@example.com', 4)), null);
});

test('different accounts never share a cache entry, even for the same room number', () => {
  withFakeNow(3_000_000, () => {
    setCachedRoomIndex('account-one@example.com', sampleIndex);
    setCachedRoom('account-one@example.com', 2, sampleRoomContents);
  });
  const otherIndex = withFakeNow(3_000_000, () => getCachedRoomIndex('account-two@example.com'));
  const otherRoom = withFakeNow(3_000_000, () => getCachedRoom('account-two@example.com', 2));
  assert.equal(otherIndex, null, 'a different account must never read the first account\'s cached index');
  assert.equal(otherRoom, null, 'a different account must never read the first account\'s cached room contents');
});

test('invalidateRoomCache clears only the targeted room plus the index — every other room is untouched', () => {
  withFakeNow(4_000_000, () => {
    setCachedRoomIndex('e@example.com', sampleIndex);
    setCachedRoom('e@example.com', 1, sampleRoomContents);
    setCachedRoom('e@example.com', 2, sampleRoomContents);
  });
  withFakeNow(4_000_000, () => invalidateRoomCache('e@example.com', 1));

  assert.equal(withFakeNow(4_000_000, () => getCachedRoomIndex('e@example.com')), null, 'the index must be invalidated so the next view refetches authoritative counts');
  assert.equal(withFakeNow(4_000_000, () => getCachedRoom('e@example.com', 1)), null, 'room 1 (the affected room) must be invalidated');
  assert.deepEqual(withFakeNow(4_000_000, () => getCachedRoom('e@example.com', 2)), sampleRoomContents, 'room 2 (unrelated) must be left completely untouched — this feature must never force reloading every room');
});

test('clearAllReportRoomCaches wipes the index and every one of the 10 rooms for that account', () => {
  withFakeNow(5_000_000, () => {
    setCachedRoomIndex('f@example.com', sampleIndex);
    for (let room = 0; room < 10; room++) setCachedRoom('f@example.com', room, sampleRoomContents);
  });
  clearAllReportRoomCaches('f@example.com');
  assert.equal(withFakeNow(5_000_000, () => getCachedRoomIndex('f@example.com')), null);
  for (let room = 0; room < 10; room++) {
    assert.equal(withFakeNow(5_000_000, () => getCachedRoom('f@example.com', room)), null, `room ${room} must be cleared`);
  }
});
