import assert from "node:assert/strict";
import test from "node:test";

import * as reportsRoute from "../app/api/reports/route.ts";

/**
 * POST /api/reports outer-catch security/privacy hardening regression.
 *
 * Forces the REAL outer catch (app/api/reports/route.ts's POST, outermost
 * try/catch) via the smallest deterministic, network-free lever available:
 * checkRate() -- the very first statement inside POST's try block, with no
 * local try/catch of its own -- resolves its DB connection through
 * getReportsDbClient() (lib/reports-db.ts), which throws SYNCHRONOUSLY,
 * BEFORE createClient()/any network I/O, whenever TURSO_DATABASE_URL points
 * at a non-"file:" (remote-looking) URL with no TURSO_AUTH_TOKEN set:
 *   'TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points at a
 *   remote database.'
 * That exception is caught by nothing except POST's own outermost catch,
 * guaranteeing a deterministic 500 with zero real DB access, zero network
 * calls, and no mocking infrastructure.
 */

async function withRealOuterCatchTrigger(fn) {
  const savedUrl = process.env.TURSO_DATABASE_URL;
  const savedToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = "https://example.invalid";
  delete process.env.TURSO_AUTH_TOKEN;
  try {
    return await fn();
  } finally {
    if (savedUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = savedUrl;
    if (savedToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = savedToken;
  }
}

async function captureConsoleError(fn) {
  const calls = [];
  const original = console.error;
  console.error = (...args) => {
    calls.push(args);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.error = original;
  }
}

function buildPostRequest(id) {
  return new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `test-500-outer-catch-${id}` },
    body: JSON.stringify({
      deviceKey: "device-500-test",
      id: String(id),
      submissionId: "sub-500-test",
      title: "title.pdf",
      createdAt: new Date().toISOString(),
      wordCount: 1,
      archiveScore: 0,
      scoreBand: "Low",
      payload: { text: "irrelevant -- never reached, checkRate throws first" },
    }),
  });
}

test("POST /api/reports: the real outer catch returns the fixed generic 500 body, never the internal config error", async () => {
  const { result: res } = await captureConsoleError(() =>
    withRealOuterCatchTrigger(() => reportsRoute.POST(buildPostRequest(1))),
  );

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body, { error: "Unable to save report. Please try again." });

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("TURSO_AUTH_TOKEN"), false, "must never echo the internal env-var name");
  assert.equal(serialized.includes("remote database"), false, "must never echo the internal config error text");
});

test("POST /api/reports: an unexpected 500 logs only the fixed marker, never the raw error/message/stack", async () => {
  const { calls } = await captureConsoleError(() =>
    withRealOuterCatchTrigger(() => reportsRoute.POST(buildPostRequest(2))),
  );

  assert.equal(calls.length, 1, "exactly one console.error call for one unexpected failure");
  assert.deepEqual(calls[0], ["POST /api/reports: unexpected error"], "the log call must carry ONLY the fixed marker string -- no second argument, no interpolated value");

  const serializedLog = JSON.stringify(calls[0]);
  assert.equal(serializedLog.includes("TURSO_AUTH_TOKEN"), false, "log must never contain the internal env-var name");
  assert.equal(serializedLog.includes("remote database"), false, "log must never contain the internal config error text");
});
