import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSelectiveCorpusShadowTelemetryEvent,
  logSelectiveCorpusShadowTelemetry,
  SELECTIVE_CORPUS_SHADOW_TELEMETRY_EVENT,
} from "../lib/selective-corpus/shadow-telemetry.ts";
import { runSelectiveCorpusShadowEvaluation } from "../lib/selective-corpus/shadow-evaluation.ts";
import { clearSelectiveCorpusArtifactCache } from "../lib/selective-corpus/artifact.ts";
import { SELECTIVE_CORPUS_EXPECTED_DIGEST } from "../lib/selective-corpus/constants.ts";

/**
 * SELECTIVE CORPUS SHADOW TELEMETRY — structured production observability.
 *
 * Covers: exact allowlisted shape per state, the privacy exclusion list
 * (sentinel fake-sensitive values must never survive serialization),
 * exactly-one-event-per-invocation (including PARTIAL, which used to have a
 * SEPARATE ad hoc console.warn), DISABLED/log-level routing, and the
 * best-effort invariant that a telemetry-layer failure (a throwing
 * console.log/warn/error) can NEVER alter the evaluator's own returned
 * result -- telemetry must only ever observe, never influence, behavior.
 */

async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Temporarily replaces console.log/warn/error, collecting every call as
 *  { level, args }, and restores the originals in `finally` regardless of
 *  how `fn` exits. */
async function captureConsole(fn) {
  const calls = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => calls.push({ level: "log", args });
  console.warn = (...args) => calls.push({ level: "warn", args });
  console.error = (...args) => calls.push({ level: "error", args });
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

/** Temporarily replaces ONE console method (log/warn/error) with one that
 *  throws synchronously, restoring the original in `finally` regardless of
 *  how `fn` exits -- used to prove the telemetry layer's best-effort
 *  invariant without ever leaking a broken console method into other tests. */
async function withThrowingConsoleMethod(method, fn) {
  const original = console[method];
  console[method] = () => {
    throw new Error(`simulated console.${method} failure (test-only)`);
  };
  try {
    return await fn();
  } finally {
    console[method] = original;
  }
}

function writeMinimalSelectiveCorpusArtifact(dir) {
  mkdirSync(join(dir, "packed"), { recursive: true });
  writeFileSync(
    join(dir, "corpus-version.json"),
    JSON.stringify({
      corpusVersion: "selective-corpus-v1",
      corpusIdentityDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
      fingerprintVersion: "selective-corpus-fp-w15-s5-v1",
      winnowWindow: 15,
      shingleSize: 5,
      stopPolicy: "global DF>=13",
      documentCount: 1,
    }),
  );
  writeFileSync(join(dir, "packed", "docmap.tsv"), "0\ta\tA_wikipedia\tbulk:a\t500\tORDINARY_REFERENCE");
  writeFileSync(join(dir, "packed", "stopset.bin"), Buffer.alloc(0));
  for (let s = 0; s < 256; s++) {
    writeFileSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), Buffer.alloc(4));
  }
}

const SHARD_QUERY_TEXT = Array.from(
  { length: 640 },
  (_, i) => `term${(i * 2654435761) % 1009}x${(i * 40503) % 251}`,
).join(" ");

// ═══════════════════════════════════════════════════════════════════════
// 1. PURE FORMATTER — exact allowlisted shape per state
// ═══════════════════════════════════════════════════════════════════════

test("formatter: COMPLETED produces exactly the allowlisted fields it has", () => {
  const result = {
    state: "COMPLETED",
    evaluatorVersion: "selective-corpus-shadow-v1",
    corpusVersion: "selective-corpus-v1",
    corpusDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
    documentCount: 9176,
    candidateCount: 42,
    topCandidateRanks: [0, 3, 7],
    stageATruncated: false,
    verifiedSourceCount: 2,
    matchedPositionCount: 15,
    counterfactualUnifiedSimilarity: 12,
    authoritativeUnifiedSimilarity: 8,
    deltaVsAuthoritative: 4,
    runtimeStageAMs: 3.21,
    runtimeStageBMs: 44.5,
    familyGuardActivations: 1,
    coSourceAttributionActivations: 0,
    interpretationVersion: "v1",
    interpretationCounts: { DISTINCTIVE_EXTERNAL_MATCH: 1 },
    interpretationBreakdown: [{ sourceLabel: "S1", spans: [] }],
  };
  const event = buildSelectiveCorpusShadowTelemetryEvent(result, 55.9);
  assert.deepEqual(event, {
    event: "selective_corpus_shadow",
    state: "COMPLETED",
    evaluationWallMs: 55.9,
    evaluatorVersion: "selective-corpus-shadow-v1",
    corpusVersion: "selective-corpus-v1",
    corpusDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
    documentCount: 9176,
    candidateCount: 42,
    stageATruncated: false,
    verifiedSourceCount: 2,
    matchedPositionCount: 15,
    runtimeStageAMs: 3.21,
    runtimeStageBMs: 44.5,
    familyGuardActivations: 1,
    coSourceAttributionActivations: 0,
  });
});

test("formatter: queryFingerprintsRawCount/queryFingerprintsTrimmed survive exactly when set, alongside existing privacy exclusions", () => {
  const result = {
    state: "COMPLETED",
    evaluatorVersion: "selective-corpus-shadow-v1",
    corpusDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
    documentCount: 9176,
    candidateCount: 5,
    stageATruncated: false,
    queryFingerprintsRawCount: 4979,
    queryFingerprintsTrimmed: true,
    runtimeStageAMs: 44.1,
    // deliberately also set on this same result, to prove the two new
    // fields' presence does not loosen any pre-existing exclusion.
    failureMessage: "should never be emitted even when fingerprint fields are present",
    degradedShards: [1, 2, 3],
    degradedDetail: "should never be emitted either",
  };
  const event = buildSelectiveCorpusShadowTelemetryEvent(result, 60);
  assert.equal(event.queryFingerprintsRawCount, 4979, "exact value passthrough, no transformation");
  assert.equal(event.queryFingerprintsTrimmed, true);
  assert.equal(event.stageATruncated, false, "distinct field, independently correct -- never conflated with queryFingerprintsTrimmed");
  assert.equal("failureMessage" in event, false);
  assert.equal("degradedShards" in event, false);
  assert.equal("degradedDetail" in event, false);
});

test("formatter: queryFingerprintsRawCount/queryFingerprintsTrimmed are omitted (not defaulted) when the result never set them", () => {
  const result = {
    state: "ARTIFACT_UNAVAILABLE",
    evaluatorVersion: "selective-corpus-shadow-v1",
    failureCode: "NO_PATH_CONFIGURED",
  };
  const event = buildSelectiveCorpusShadowTelemetryEvent(result, 1);
  assert.equal("queryFingerprintsRawCount" in event, false, "Stage A never ran -- must not be fabricated as 0 or any other value");
  assert.equal("queryFingerprintsTrimmed" in event, false, "Stage A never ran -- must not default to false");
});

test("formatter: PARTIAL includes degradedShardCount/degradedShardCodes but not degradedShards/degradedDetail", () => {
  const result = {
    state: "PARTIAL",
    evaluatorVersion: "selective-corpus-shadow-v1",
    corpusDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
    documentCount: 9176,
    candidateCount: 10,
    verifiedSourceCount: 0,
    matchedPositionCount: 0,
    runtimeStageAMs: 5,
    runtimeStageBMs: 10,
    familyGuardActivations: 0,
    coSourceAttributionActivations: 0,
    degradedShardCount: 3,
    degradedShards: [12, 45, 67],
    degradedShardCodes: { MISSING: 2, CORRUPT: 1 },
    degradedDetail: "3 packed shard(s) unavailable at query time (MISSING:2, CORRUPT:1); affected shards: [12,45,67]",
  };
  const event = buildSelectiveCorpusShadowTelemetryEvent(result, 20);
  assert.equal(event.state, "PARTIAL");
  assert.equal(event.degradedShardCount, 3);
  assert.deepEqual(event.degradedShardCodes, { MISSING: 2, CORRUPT: 1 });
  assert.equal("degradedShards" in event, false, "raw shard-number array must not appear");
  assert.equal("degradedDetail" in event, false, "free-text summary must not appear");
});

test("formatter: TIMEOUT includes runtimeStageAMs (already computed) but not runtimeStageBMs (never finished)", () => {
  const result = {
    state: "TIMEOUT",
    evaluatorVersion: "selective-corpus-shadow-v1",
    failureCode: "TIMEOUT",
    failureMessage: "time budget exceeded during Stage B",
    corpusVersion: "selective-corpus-v1",
    corpusDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
    documentCount: 9176,
    runtimeStageAMs: 4321.9,
  };
  const event = buildSelectiveCorpusShadowTelemetryEvent(result, 6001.2);
  assert.equal(event.state, "TIMEOUT");
  assert.equal(event.failureCode, "TIMEOUT");
  assert.equal(event.runtimeStageAMs, 4321.9);
  assert.equal("runtimeStageBMs" in event, false, "Stage B never finished on a real TIMEOUT -- must not be fabricated");
  assert.equal("failureMessage" in event, false, "free-text failure message must never be emitted");
});

test("formatter: ARTIFACT_UNAVAILABLE has failureCode but no corpus/document fields (artifact never loaded)", () => {
  const result = {
    state: "ARTIFACT_UNAVAILABLE",
    evaluatorVersion: "selective-corpus-shadow-v1",
    failureCode: "WRONG_DIGEST",
    failureMessage: "artifact digest mismatch — expected 7b1a2fd1..., got 4fcfdd6f...",
  };
  const event = buildSelectiveCorpusShadowTelemetryEvent(result, 12.3);
  assert.deepEqual(event, {
    event: "selective_corpus_shadow",
    state: "ARTIFACT_UNAVAILABLE",
    evaluationWallMs: 12.3,
    evaluatorVersion: "selective-corpus-shadow-v1",
    failureCode: "WRONG_DIGEST",
  });
});

test("formatter: FAILED has only failureCode, no failureMessage, no corpus fields", () => {
  const result = {
    state: "FAILED",
    evaluatorVersion: "selective-corpus-shadow-v1",
    failureCode: "UNEXPECTED",
    failureMessage: "some internal error at D:\\Github\\Turnitin\\lib\\selective-corpus\\shadow.ts:123",
  };
  const event = buildSelectiveCorpusShadowTelemetryEvent(result, 3.4);
  assert.deepEqual(event, {
    event: "selective_corpus_shadow",
    state: "FAILED",
    evaluationWallMs: 3.4,
    evaluatorVersion: "selective-corpus-shadow-v1",
    failureCode: "UNEXPECTED",
  });
});

test("formatter: DISABLED has minimal shape", () => {
  const result = { state: "DISABLED", evaluatorVersion: "selective-corpus-shadow-v1" };
  const event = buildSelectiveCorpusShadowTelemetryEvent(result, 0);
  assert.deepEqual(event, {
    event: "selective_corpus_shadow",
    state: "DISABLED",
    evaluationWallMs: 0,
    evaluatorVersion: "selective-corpus-shadow-v1",
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. PRIVACY — sentinel fake-sensitive values must never survive
// ═══════════════════════════════════════════════════════════════════════

test("privacy: sentinel fake-sensitive values on every excluded field never appear in the serialized event", () => {
  const SENTINELS = {
    reportId: "SENTINEL-REPORT-ID-9f8e7d",
    accountId: "SENTINEL-ACCOUNT-abc123",
    email: "sentinel-user@example.com",
    ip: "203.0.113.42",
    devicePassport: "SENTINEL-DEVICE-PASSPORT-token",
    manuscriptExcerpt: "SENTINEL manuscript text about a very specific topic",
    sourceExcerpt: "SENTINEL source text excerpt content",
    sourceUrl: "https://example.com/sentinel-source-article",
    sourceTitle: "Sentinel Source Document Title",
    filePath: "D:\\Github\\Turnitin\\SENTINEL\\path\\to\\file.txt",
    blobUrl: "https://blob.vercel-storage.com/sentinel-object-key",
    credential: "sk_live_SENTINEL_TOKEN_VALUE",
  };
  const result = {
    state: "PARTIAL",
    evaluatorVersion: "selective-corpus-shadow-v1",
    corpusDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
    documentCount: 9176,
    // fields that genuinely exist on SelectiveCorpusShadowResult and are
    // deliberately excluded from the telemetry allowlist -- stuffed with
    // sentinel fake-sensitive strings to prove exclusion actually holds.
    failureMessage: `boom at ${SENTINELS.filePath} for account ${SENTINELS.accountId} token=${SENTINELS.credential}`,
    degradedDetail: `shards down; source=${SENTINELS.sourceUrl} title="${SENTINELS.sourceTitle}"`,
    degradedShards: [1, 2, 3],
    interpretationBreakdown: [
      { sourceLabel: "S1", spans: [{ wordRange: [0, 5], kind: "DISTINCTIVE_EXTERNAL_MATCH", confidence: "HIGH", reasons: [SENTINELS.manuscriptExcerpt, SENTINELS.sourceExcerpt] } ] },
    ],
    // Not real fields on the type, but prove the builder never echoes back
    // arbitrary extra input properties either.
    reportId: SENTINELS.reportId,
    accountId: SENTINELS.accountId,
    email: SENTINELS.email,
    ip: SENTINELS.ip,
    devicePassport: SENTINELS.devicePassport,
    blobUrl: SENTINELS.blobUrl,
  };
  const event = buildSelectiveCorpusShadowTelemetryEvent(result, 42);
  const serialized = JSON.stringify(event);
  for (const [label, value] of Object.entries(SENTINELS)) {
    assert.equal(serialized.includes(value), false, `sentinel ${label} must not appear in serialized telemetry`);
  }
  // also verify via logSelectiveCorpusShadowTelemetry's actual console output
  return captureConsole(() => {
    logSelectiveCorpusShadowTelemetry(result, 42);
  }).then(({ calls }) => {
    assert.equal(calls.length, 1);
    const loggedLine = calls[0].args[0];
    for (const [label, value] of Object.entries(SENTINELS)) {
      assert.equal(loggedLine.includes(value), false, `sentinel ${label} must not appear in the actual logged line`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. LOG-LEVEL ROUTING + EXACTLY-ONE-EVENT (pure logger, all 6 states)
// ═══════════════════════════════════════════════════════════════════════

const STATE_LEVEL_CASES = [
  { state: "COMPLETED", expectedLevel: "log" },
  { state: "DISABLED", expectedLevel: "log" },
  { state: "PARTIAL", expectedLevel: "warn" },
  { state: "TIMEOUT", expectedLevel: "warn" },
  { state: "ARTIFACT_UNAVAILABLE", expectedLevel: "error" },
  { state: "FAILED", expectedLevel: "error" },
];

for (const { state, expectedLevel } of STATE_LEVEL_CASES) {
  test(`logger: state ${state} emits exactly one call at level "${expectedLevel}" carrying the event identifier`, async () => {
    const result = { state, evaluatorVersion: "selective-corpus-shadow-v1" };
    const { calls } = await captureConsole(() => {
      logSelectiveCorpusShadowTelemetry(result, 1.5);
    });
    assert.equal(calls.length, 1, "exactly one console call for one terminal result");
    assert.equal(calls[0].level, expectedLevel);
    const parsed = JSON.parse(calls[0].args[0]);
    assert.equal(parsed.event, SELECTIVE_CORPUS_SHADOW_TELEMETRY_EVENT);
    assert.equal(parsed.state, state);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 4. INTEGRATION — runSelectiveCorpusShadowEvaluation emits exactly one
//    structured event end-to-end, including the PARTIAL case that used to
//    ALSO fire a separate ad hoc console.warn (now unified into one call).
// ═══════════════════════════════════════════════════════════════════════

function countStructuredEvents(calls) {
  let count = 0;
  for (const c of calls) {
    try {
      const parsed = JSON.parse(c.args[0]);
      if (parsed && parsed.event === SELECTIVE_CORPUS_SHADOW_TELEMETRY_EVENT) count += 1;
    } catch {
      /* non-JSON console output (e.g. a stray unrelated log) -- ignore */
    }
  }
  return count;
}

test("integration: flag OFF (DISABLED) emits exactly one structured event, no disk access", async () => {
  const { result, calls } = await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: undefined }, () =>
    captureConsole(() =>
      runSelectiveCorpusShadowEvaluation({ reportId: "r-telemetry-disabled", rawText: "word ".repeat(400), authoritativeUnifiedSimilarity: null }),
    ),
  );
  assert.equal(result.state, "DISABLED");
  assert.equal(countStructuredEvents(calls), 1);
});

test("integration: a real COMPLETED evaluation emits exactly one structured event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-telemetry-completed-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, async () => {
    const { result, calls } = await captureConsole(() =>
      runSelectiveCorpusShadowEvaluation({
        reportId: "r-telemetry-completed",
        rawText: SHARD_QUERY_TEXT,
        authoritativeUnifiedSimilarity: { unifiedScore: 5, matchedPositions: [1, 2] },
      }),
    );
    assert.equal(result.state, "COMPLETED");
    assert.equal(countStructuredEvents(calls), 1, "exactly one structured event for one COMPLETED evaluation");
    const structured = calls.find((c) => { try { return JSON.parse(c.args[0]).event === SELECTIVE_CORPUS_SHADOW_TELEMETRY_EVENT; } catch { return false; } });
    assert.equal(structured.level, "log");
    const parsed = JSON.parse(structured.args[0]);
    assert.equal(parsed.documentCount, 1, "documentCount sourced from the real loaded artifact, not fabricated");
    assert.equal(parsed.corpusDigest, SELECTIVE_CORPUS_EXPECTED_DIGEST);
    assert.equal(typeof parsed.runtimeStageAMs, "number");
    assert.equal(typeof parsed.runtimeStageBMs, "number");
    assert.equal(typeof parsed.evaluationWallMs, "number");

    // Real end-to-end propagation: Stage A (stage-a.ts) -> the shadow result
    // (shadow.ts) -> the telemetry event (shadow-telemetry.ts), with no
    // hand-built literal result object anywhere in this test -- the SAME
    // values must appear, unmodified, at every layer.
    assert.equal(typeof result.queryFingerprintsRawCount, "number");
    assert.equal(typeof result.queryFingerprintsTrimmed, "boolean");
    assert.equal(result.queryFingerprintsTrimmed, false, "SHARD_QUERY_TEXT (640 words) is far under the 4096 cap");
    assert.ok(result.queryFingerprintsRawCount > 0);
    assert.equal(parsed.queryFingerprintsRawCount, result.queryFingerprintsRawCount, "telemetry event carries the exact shadow-result value, no transformation");
    assert.equal(parsed.queryFingerprintsTrimmed, result.queryFingerprintsTrimmed);
  });
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

test("integration: a real PARTIAL evaluation emits exactly ONE structured event (not two -- the old separate ad hoc warning is gone)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-telemetry-partial-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, async () => {
    await import("../lib/selective-corpus/artifact.ts").then((m) => m.loadSelectiveCorpusArtifact(dir)); // clean init
    for (let s = 0; s < 256; s++) rmSync(join(dir, "packed", `shard-${String(s).padStart(3, "0")}.bin`), { force: true });

    const { result, calls } = await captureConsole(() =>
      runSelectiveCorpusShadowEvaluation({
        reportId: "r-telemetry-partial",
        rawText: SHARD_QUERY_TEXT,
        authoritativeUnifiedSimilarity: { unifiedScore: 5, matchedPositions: [] },
      }),
    );
    assert.equal(result.state, "PARTIAL");
    assert.equal(countStructuredEvents(calls), 1, "exactly one structured event -- PARTIAL must not double-count");
    assert.equal(calls.length, 1, "no OTHER console output (the old separate free-text warning is gone) alongside the structured event");
    assert.equal(calls[0].level, "warn");
    const parsed = JSON.parse(calls[0].args[0]);
    assert.ok(parsed.degradedShardCount > 0);
    assert.equal(parsed.reportId, undefined, "reportId must never appear, not even by accident");
  });
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});

// ═══════════════════════════════════════════════════════════════════════
// 5. BEST-EFFORT LOGGING — a telemetry-layer failure must never alter the
//    evaluator's own returned result. This is the exact invariant a prior
//    review flagged: if console.log/warn/error ever threw, the surrounding
//    try/catch in runSelectiveCorpusShadowEvaluation could otherwise
//    mistake that for a real evaluator failure and substitute a synthetic
//    FAILED result in place of an already-computed real one.
// ═══════════════════════════════════════════════════════════════════════

// Each method is paired with a state that GENUINELY routes to it (per the
// log-level table), so the throwing mock is actually on the call path that
// executes -- not a method the given state would never touch anyway.
const METHOD_STATE_PAIRS = [
  { method: "log", state: "COMPLETED" },
  { method: "warn", state: "PARTIAL" },
  { method: "error", state: "ARTIFACT_UNAVAILABLE" },
];

for (const { method, state } of METHOD_STATE_PAIRS) {
  test(`best-effort: logSelectiveCorpusShadowTelemetry itself never throws when console.${method} throws (state ${state} genuinely routes to it)`, async () => {
    const result = { state, evaluatorVersion: "selective-corpus-shadow-v1" };
    await withThrowingConsoleMethod(method, async () => {
      assert.doesNotThrow(() => logSelectiveCorpusShadowTelemetry(result, 1));
    });
  });
}

test("best-effort: a real COMPLETED evaluation is returned unchanged -- NOT replaced with FAILED -- when console.log throws during telemetry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scv-telemetry-throwing-console-"));
  writeMinimalSelectiveCorpusArtifact(dir);
  clearSelectiveCorpusArtifactCache();
  await withEnv({ SELECTIVE_CORPUS_SHADOW_ENABLED: "true", SELECTIVE_CORPUS_ARTIFACT_PATH: dir }, async () => {
    await withThrowingConsoleMethod("log", async () => {
      // COMPLETED routes through console.log (see the log-level table above)
      // -- this is the exact method that would fire for the real result below.
      let result;
      await assert.doesNotReject(async () => {
        result = await runSelectiveCorpusShadowEvaluation({
          reportId: "r-telemetry-throwing-console",
          rawText: SHARD_QUERY_TEXT,
          authoritativeUnifiedSimilarity: { unifiedScore: 5, matchedPositions: [1, 2] },
        });
      }, "runSelectiveCorpusShadowEvaluation must not reject even though console.log throws internally");

      assert.equal(result.state, "COMPLETED", "must remain the REAL computed result");
      assert.notEqual(result.state, "FAILED", "a telemetry failure must never be reported as an evaluator failure");
      assert.equal(result.failureCode, undefined, "no failureCode should appear on what is actually a real COMPLETED result");
      // Authoritative/scoring behavior is exactly what an ordinary COMPLETED
      // run produces -- untouched by the telemetry failure.
      assert.equal(result.authoritativeUnifiedSimilarity, 5);
      assert.equal(typeof result.counterfactualUnifiedSimilarity, "number");
      assert.equal(typeof result.candidateCount, "number");
    });
  });
  rmSync(dir, { recursive: true, force: true });
  clearSelectiveCorpusArtifactCache();
});
