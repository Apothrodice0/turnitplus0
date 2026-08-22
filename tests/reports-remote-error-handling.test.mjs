import assert from "node:assert/strict";
import test from "node:test";
import { fetchReportRoomIndex, fetchReportRoomContents } from "../lib/reports-remote.ts";

/**
 * Production bug fix: fetchReportRoomIndex/fetchReportRoomContents used to
 * collapse EVERY failure mode (429 rate-limited, 500 server error, network
 * failure, malformed response) into the exact same shape a genuinely empty
 * room/room-list returns — "request failed" and "empty" (and, one layer up
 * in the UI, "logged out") must never be conflated; a failed request proves
 * nothing about what's actually in the account. Real fetch stubbing (no
 * mocking framework in this codebase's existing conventions) against the
 * actual exported functions — these two specifically never touch
 * lib/device-key.ts's window-dependent getDeviceKey(), so they're safe to
 * call directly in this Node test environment.
 */

function stubFetchOnce(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => handler(...args);
  return () => {
    globalThis.fetch = original;
  };
}

test("fetchReportRoomIndex: a 429 response is reported as a real failure, never as an empty rooms array", async () => {
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }));
  try {
    const result = await fetchReportRoomIndex();
    assert.deepEqual(result, { ok: false, status: 429 });
  } finally {
    restore();
  }
});

test("fetchReportRoomIndex: a 500 response is reported as a real failure, never as an empty rooms array", async () => {
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Internal error" }), { status: 500 }));
  try {
    const result = await fetchReportRoomIndex();
    assert.deepEqual(result, { ok: false, status: 500 });
  } finally {
    restore();
  }
});

test("fetchReportRoomIndex: a thrown network error is reported as a real failure (status: null), never as an empty rooms array", async () => {
  const restore = stubFetchOnce(async () => {
    throw new TypeError("Failed to fetch");
  });
  try {
    const result = await fetchReportRoomIndex();
    assert.deepEqual(result, { ok: false, status: null });
  } finally {
    restore();
  }
});

test("fetchReportRoomIndex: a genuine 200 with real rooms still resolves ok:true with the actual data — the fix didn't break the success path", async () => {
  const rooms = [{ room: 0, status: "empty", mostRecentAt: null, cycleEndsAt: null }];
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ rooms }), { status: 200 }));
  try {
    const result = await fetchReportRoomIndex();
    assert.deepEqual(result, { ok: true, rooms });
  } finally {
    restore();
  }
});

test("fetchReportRoomContents: a 429 response is reported as a real failure, never as an empty-room result", async () => {
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }));
  try {
    const result = await fetchReportRoomContents(3);
    assert.deepEqual(result, { ok: false, status: 429 });
  } finally {
    restore();
  }
});

test("fetchReportRoomContents: a 500 response is reported as a real failure, never as an empty-room result", async () => {
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Internal error" }), { status: 500 }));
  try {
    const result = await fetchReportRoomContents(3);
    assert.deepEqual(result, { ok: false, status: 500 });
  } finally {
    restore();
  }
});

test("fetchReportRoomContents: a thrown network error is reported as a real failure (status: null), never as an empty-room result", async () => {
  const restore = stubFetchOnce(async () => {
    throw new TypeError("Failed to fetch");
  });
  try {
    const result = await fetchReportRoomContents(3);
    assert.deepEqual(result, { ok: false, status: null });
  } finally {
    restore();
  }
});

test("fetchReportRoomContents: a genuine 200 for a truly empty room still resolves ok:true with status 'empty' — the fix didn't break the real empty case", async () => {
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ status: "empty", report: null, cycleEndsAt: null }), { status: 200 }));
  try {
    const result = await fetchReportRoomContents(3);
    assert.deepEqual(result, { ok: true, contents: { status: "empty", report: null, cycleEndsAt: null } });
  } finally {
    restore();
  }
});
