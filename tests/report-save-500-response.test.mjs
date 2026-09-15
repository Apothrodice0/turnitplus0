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

async function captureConsole(fn) {
  const calls = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => calls.push({ level: "warn", args });
  console.error = (...args) => calls.push({ level: "error", args });
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function reportSaveRejectedEventsFrom(calls) {
  return calls
    .map((c) => {
      try {
        const parsed = JSON.parse(c.args[0]);
        return parsed && parsed.event === "report_save_rejected" ? { level: c.level, parsed } : null;
      } catch {
        return null;
      }
    })
    .filter((c) => c !== null);
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
  const { result: res } = await captureConsole(() =>
    withRealOuterCatchTrigger(() => reportsRoute.POST(buildPostRequest(1))),
  );

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body, { error: "Unable to save report. Please try again." });

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("TURSO_AUTH_TOKEN"), false, "must never echo the internal env-var name");
  assert.equal(serialized.includes("remote database"), false, "must never echo the internal config error text");
});

test("POST /api/reports: an unexpected 500 logs exactly one report_save_rejected/INTERNAL_ERROR telemetry event, never the raw error/message/stack", async () => {
  const { calls } = await captureConsole(() =>
    withRealOuterCatchTrigger(() => reportsRoute.POST(buildPostRequest(2))),
  );

  assert.equal(calls.length, 1, "exactly one console call for one unexpected failure");
  assert.equal(calls[0].level, "error", "INTERNAL_ERROR must log at error level (genuine server malfunction)");
  assert.equal(calls[0].args.length, 1, "no second/dynamic argument");
  const parsed = JSON.parse(calls[0].args[0]);
  assert.deepEqual(parsed, { event: "report_save_rejected", reason: "INTERNAL_ERROR", status: 500 }, "purely categorical -- no authMode (sessionUser is not in scope at the outer catch), no dynamic error data");

  const serializedLog = calls[0].args[0];
  assert.equal(serializedLog.includes("TURSO_AUTH_TOKEN"), false, "log must never contain the internal env-var name");
  assert.equal(serializedLog.includes("remote database"), false, "log must never contain the internal config error text");
});

// ═══════════════════════════════════════════════════════════════════════
// report_save_rejected telemetry (lib/report-save-telemetry.ts) -- focused
// route-level integration coverage for two more representative categories.
// Both fire BEFORE any DB/session access (checkRate is POST's first
// statement; the Content-Length check is the second), so no fixture beyond
// a plain constructed Request is needed -- real code path, zero mocking.
// ═══════════════════════════════════════════════════════════════════════

test("POST /api/reports: a real RAW_CONTENT_LENGTH 413 emits exactly one report_save_rejected event with no authMode (fires before session resolution)", async () => {
  const req = new Request("http://localhost/api/reports", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "test-raw-content-length",
      // A real, oversized Content-Length header -- the actual body below is
      // tiny, proving this rejection is driven by the header check alone
      // (app/api/reports/route.ts's own second guard), not by the body ever
      // being read.
      "content-length": "999999999",
    },
    body: JSON.stringify({ deviceKey: "d", id: "raw-cl-1" }),
  });

  const { result: res, calls } = await captureConsole(() => reportsRoute.POST(req));

  // Response completely unchanged by adding telemetry.
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.deepEqual(body, { error: "Payload too large" });

  const events = reportSaveRejectedEventsFrom(calls);
  assert.equal(events.length, 1, "exactly one report_save_rejected event");
  assert.equal(events[0].level, "warn", "an intentional client rejection must log at warn, not error");
  assert.deepEqual(events[0].parsed, { event: "report_save_rejected", reason: "RAW_CONTENT_LENGTH", status: 413 }, "no authMode -- this fires before getSessionUser is ever called");
});

test("POST /api/reports: a real CLIENT_PAYLOAD_TOO_LARGE 413 emits exactly one report_save_rejected event with no authMode (fires before session resolution)", async () => {
  const hugeText = "a".repeat(3_000_000); // exceeds MAX_REPORT_SAVE_REQUEST_BYTES (2,000,000)
  const req = new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "test-client-payload-too-large" },
    body: JSON.stringify({
      deviceKey: "d",
      id: "client-payload-1",
      submissionId: "s",
      title: "t",
      createdAt: new Date().toISOString(),
      wordCount: 1,
      archiveScore: 0,
      scoreBand: "Low",
      payload: { text: hugeText },
    }),
  });

  const { result: res, calls } = await captureConsole(() => reportsRoute.POST(req));

  assert.equal(res.status, 413);
  const body = await res.json();
  assert.deepEqual(body, { error: "Payload too large" });

  const events = reportSaveRejectedEventsFrom(calls);
  assert.equal(events.length, 1, "exactly one report_save_rejected event");
  assert.equal(events[0].level, "warn");
  assert.deepEqual(events[0].parsed, { event: "report_save_rejected", reason: "CLIENT_PAYLOAD_TOO_LARGE", status: 413 }, "no authMode -- this fires before getSessionUser is ever called");

  // Non-exposure: the huge text itself must never appear in the log line.
  const serializedLog = calls.map((c) => c.args.join(" ")).join("\n");
  assert.equal(serializedLog.includes(hugeText.slice(0, 100)), false, "manuscript text must never appear in telemetry output");
});
