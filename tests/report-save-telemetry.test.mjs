import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReportSaveRejectedTelemetryEvent,
  logReportSaveRejectedTelemetry,
} from "../lib/report-save-telemetry.ts";

/**
 * lib/report-save-telemetry.ts -- unit coverage for the pure formatter and
 * the logger, mirroring the same test style already established for
 * lib/selective-corpus/shadow-telemetry.ts (exact deepEqual on the whole
 * event, a privacy/allowlist test, and log-level routing).
 */

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

// ═══════════════════════════════════════════════════════════════════════
// 1. PURE FORMATTER
// ═══════════════════════════════════════════════════════════════════════

test("buildReportSaveRejectedTelemetryEvent: exact shape with authMode supplied", () => {
  const event = buildReportSaveRejectedTelemetryEvent({
    reason: "OWNERSHIP_CONFLICT",
    status: 404,
    authMode: "authenticated",
  });
  assert.deepEqual(event, {
    event: "report_save_rejected",
    reason: "OWNERSHIP_CONFLICT",
    status: 404,
    authMode: "authenticated",
  });
});

test("buildReportSaveRejectedTelemetryEvent: authMode omitted entirely when not supplied (never defaulted)", () => {
  const event = buildReportSaveRejectedTelemetryEvent({
    reason: "IP_RATE_LIMIT",
    status: 429,
  });
  assert.deepEqual(event, {
    event: "report_save_rejected",
    reason: "IP_RATE_LIMIT",
    status: 429,
  });
  assert.equal("authMode" in event, false, "must be genuinely absent, not authMode: undefined");
});

test("buildReportSaveRejectedTelemetryEvent: no arbitrary extra fields survive -- exact key set for every reason", () => {
  const reasons = [
    "IP_RATE_LIMIT",
    "RAW_CONTENT_LENGTH",
    "MALFORMED_REQUEST",
    "CLIENT_PAYLOAD_TOO_LARGE",
    "OWNERSHIP_CONFLICT",
    "DAILY_UPLOAD_QUOTA",
    "REFERENCE_TRANSPORT_BUDGET",
    "PERSISTED_PAYLOAD_TOO_LARGE",
    "ROOM_OCCUPIED",
    "INTERNAL_ERROR",
  ];
  for (const reason of reasons) {
    const withoutAuth = buildReportSaveRejectedTelemetryEvent({ reason, status: 400 });
    assert.deepEqual(Object.keys(withoutAuth).sort(), ["event", "reason", "status"]);
    const withAuth = buildReportSaveRejectedTelemetryEvent({ reason, status: 400, authMode: "anonymous" });
    assert.deepEqual(Object.keys(withAuth).sort(), ["authMode", "event", "reason", "status"]);
  }
});

test("buildReportSaveRejectedTelemetryEvent: exact value passthrough, no transformation", () => {
  const event = buildReportSaveRejectedTelemetryEvent({
    reason: "PERSISTED_PAYLOAD_TOO_LARGE",
    status: 413,
    authMode: "anonymous",
  });
  assert.equal(event.event, "report_save_rejected");
  assert.equal(event.reason, "PERSISTED_PAYLOAD_TOO_LARGE");
  assert.equal(event.status, 413);
  assert.equal(event.authMode, "anonymous");
});

// ═══════════════════════════════════════════════════════════════════════
// 2. LOG-LEVEL ROUTING
// ═══════════════════════════════════════════════════════════════════════

const WARN_REASONS = [
  "IP_RATE_LIMIT",
  "RAW_CONTENT_LENGTH",
  "MALFORMED_REQUEST",
  "CLIENT_PAYLOAD_TOO_LARGE",
  "OWNERSHIP_CONFLICT",
  "DAILY_UPLOAD_QUOTA",
  "REFERENCE_TRANSPORT_BUDGET",
  "PERSISTED_PAYLOAD_TOO_LARGE",
  "ROOM_OCCUPIED",
];

for (const reason of WARN_REASONS) {
  test(`logReportSaveRejectedTelemetry: reason ${reason} logs at warn level`, async () => {
    const { calls } = await captureConsole(() => {
      logReportSaveRejectedTelemetry({ reason, status: 400 });
    });
    assert.equal(calls.length, 1, "exactly one console call for one rejection");
    assert.equal(calls[0].level, "warn");
    const parsed = JSON.parse(calls[0].args[0]);
    assert.equal(parsed.event, "report_save_rejected");
    assert.equal(parsed.reason, reason);
  });
}

test("logReportSaveRejectedTelemetry: reason INTERNAL_ERROR logs at error level", async () => {
  const { calls } = await captureConsole(() => {
    logReportSaveRejectedTelemetry({ reason: "INTERNAL_ERROR", status: 500 });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, "error");
  const parsed = JSON.parse(calls[0].args[0]);
  assert.deepEqual(parsed, { event: "report_save_rejected", reason: "INTERNAL_ERROR", status: 500 });
});

test("logReportSaveRejectedTelemetry: emits authMode when supplied, in a single structured line", async () => {
  const { calls } = await captureConsole(() => {
    logReportSaveRejectedTelemetry({ reason: "DAILY_UPLOAD_QUOTA", status: 429, authMode: "authenticated" });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, "warn");
  const parsed = JSON.parse(calls[0].args[0]);
  assert.deepEqual(parsed, {
    event: "report_save_rejected",
    reason: "DAILY_UPLOAD_QUOTA",
    status: 429,
    authMode: "authenticated",
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. BEST-EFFORT (never throws, never corrupts the real request flow)
// ═══════════════════════════════════════════════════════════════════════

test("logReportSaveRejectedTelemetry: never throws even if console.warn itself throws", async () => {
  const original = console.warn;
  console.warn = () => {
    throw new Error("simulated console failure");
  };
  try {
    assert.doesNotThrow(() => {
      logReportSaveRejectedTelemetry({ reason: "MALFORMED_REQUEST", status: 400 });
    });
  } finally {
    console.warn = original;
  }
});

test("logReportSaveRejectedTelemetry: never throws even if console.error itself throws (INTERNAL_ERROR path)", async () => {
  const original = console.error;
  console.error = () => {
    throw new Error("simulated console failure");
  };
  try {
    assert.doesNotThrow(() => {
      logReportSaveRejectedTelemetry({ reason: "INTERNAL_ERROR", status: 500 });
    });
  } finally {
    console.error = original;
  }
});
