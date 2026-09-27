import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./helpers/ai-worker-transformers-hooks.mjs", import.meta.url);

import * as core from "../lib/ai-core.ts";
import { detectLanguage } from "../lib/similarity-core.ts";
import { buildReportSummary } from "../lib/report-types.ts";
import { fetchRemoteReport } from "../lib/reports-remote.ts";
import { persistAiCompletion, persistAiRetryResult } from "../lib/report-ai-completion.ts";
import { expandCompactAiPassages } from "../lib/ai-passage-table.ts";
import * as fx from "./helpers/large-report-retry-fixture.mjs";
import { createKit } from "./helpers/ai-compact-integration-kit.mjs";
import { diagnosticsFor, pseudoBpeTokenizer, synthProse, workerShapedAnalysis } from "./helpers/real-ai-windows.mjs";
import { resetStub, stubState } from "./helpers/ai-worker-transformers-stub.mjs";

/**
 * LARGE-INPUT AI RangeError. lib/ai-core.ts's calculateAiLogOddsDiagnostics (the one the worker calls) and
 * calculateAiDiagnostics took their extrema as `Math.max(0, ...array)`, where one array holds a value PER TOKEN of the
 * analysed document. A spread passes every element as a call argument, so past ~105-125k tokens (V8's stack, Node 22 and
 * Chrome alike) it throws `RangeError: Maximum call stack size exceeded` — the worker then posts an error, and a large
 * English report never gets an AI result, on the automatic pass or on Retry. The browser engine accepts ~1.85M-character
 * manuscripts (~460k tokens), well past that.
 *
 * The worker, the room page's runAiAnalysis / retryAiAnalysisWithFreshLanguage, the persistence helpers and the route
 * handlers are the REAL code; only `@huggingface/transformers` is a deterministic stand-in for the worker (see
 * helpers/ai-worker-transformers-hooks.mjs), and `Worker` is bridged in-process to the real worker module. All text is synthetic.
 */

// The two functions exactly as they were at df3856e (spread extrema) — the reference the fix must equal wherever they ran.
function legacyCalculateAiDiagnostics(chunks, threshold = core.AI_PASSAGE_THRESHOLD) {
  const totalWords = Math.max(0, ...chunks.map((chunk) => chunk.wordEnd));
  const wordProbabilities = Array.from({ length: totalWords }, () => 0);
  chunks.forEach((chunk) => {
    for (let word = chunk.wordStart; word < chunk.wordEnd; word += 1) {
      wordProbabilities[word] = Math.max(wordProbabilities[word], chunk.probability);
    }
  });
  const flaggedWords = wordProbabilities.filter((probability) => probability >= threshold).length;
  const meanProbability = totalWords === 0
    ? 0
    : wordProbabilities.reduce((total, probability) => total + probability, 0) / totalWords;
  return {
    totalWords,
    flaggedWords,
    percentFlagged: totalWords === 0 ? 0 : Math.round((flaggedWords / totalWords) * 100),
    meanProbability: Math.round(meanProbability * 1000) / 1000,
    maxProbability: Math.round(Math.max(0, ...wordProbabilities) * 1000) / 1000,
  };
}

function legacyCalculateAiLogOddsDiagnostics(chunks, threshold = core.AI_PASSAGE_LOG_ODDS_THRESHOLD) {
  const totalWords = Math.max(0, ...chunks.map((chunk) => chunk.wordEnd));
  const wordLogOdds = Array.from({ length: totalWords }, () => Number.NEGATIVE_INFINITY);
  chunks.forEach((chunk) => {
    for (let word = chunk.wordStart; word < chunk.wordEnd; word += 1) {
      wordLogOdds[word] = Math.max(wordLogOdds[word], chunk.logOdds);
    }
  });
  const flaggedWords = wordLogOdds.filter((value) => core.isAiPassageFlagged(value, threshold)).length;
  const wordProbabilities = wordLogOdds.map((value) => Number.isFinite(value) ? core.probabilityFromLogOdds(value) : 0);
  const meanProbability = totalWords === 0
    ? 0
    : wordProbabilities.reduce((total, probability) => total + probability, 0) / totalWords;
  return {
    totalWords,
    flaggedWords,
    flaggedPassages: chunks.filter((chunk) => core.isAiPassageFlagged(chunk.logOdds, threshold)).length,
    percentFlagged: totalWords === 0 ? 0 : Math.round((flaggedWords / totalWords) * 100),
    meanProbability: Math.round(meanProbability * 1000) / 1000,
    maxProbability: Math.round(Math.max(0, ...wordProbabilities) * 1000) / 1000,
  };
}

/** Production-shaped 240/120 token windows over `totalTokens` tokens (anchored last window), deterministic signals. */
function syntheticWindows(totalTokens, seed = 7) {
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const finalStart = Math.max(0, totalTokens - 240);
  const windows = [];
  for (let start = 0; ; start += 120) {
    const bounded = Math.min(start, finalStart);
    const logOdds = random() < 0.03 ? core.AI_PASSAGE_LOG_ODDS_THRESHOLD + random() : -2.6 + 1.4 * (random() - 0.5);
    windows.push({ wordStart: bounded, wordEnd: Math.min(totalTokens, bounded + 240), logOdds, probability: core.probabilityFromLogOdds(logOdds) });
    if (bounded >= finalStart) break;
  }
  return windows;
}

// ---- the real worker, in-process -------------------------------------------------------------------------------
const workerScope = {
  navigator: {},
  listeners: [],
  addEventListener(type, handler) {
    if (type === "message") this.listeners.push(handler);
  },
  postMessage(data) {
    BridgedWorker.current?.deliver(data);
  },
};
globalThis.__AI_WORKER_SCOPE__ = workerScope;
await import("../app/ai-detector-worker.ts");

class BridgedWorker {
  static current = null;
  static requests = 0;
  static errors = []; // the raw `ok: false` messages the worker posted (runAiAnalysis maps them to a user-facing label)
  constructor() {
    this.listeners = new Set();
  }
  addEventListener(type, handler) {
    if (type === "message") this.listeners.add(handler);
  }
  removeEventListener(type, handler) {
    if (type === "message") this.listeners.delete(handler);
  }
  postMessage(data) {
    BridgedWorker.current = this;
    BridgedWorker.requests += 1;
    setImmediate(() => workerScope.listeners.forEach((handler) => handler({ data })));
  }
  deliver(data) {
    if (data && data.ok === false) BridgedWorker.errors.push(data.error);
    for (const handler of [...this.listeners]) handler({ data });
  }
  terminate() {}
}
globalThis.Worker = BridgedWorker;
const roomShell = await import("../app/reports/rooms/[room]/room-page-shell.tsx");

/** What the worker must return for `text`: rebuilt independently from the recorded model outputs (loop diagnostics above 100k tokens). */
function referenceAnalysis(text) {
  const chunks = core.buildAiTokenChunks(text, pseudoBpeTokenizer());
  assert.equal(stubState.signals.length, chunks.length, "the model saw every window exactly once");
  return JSON.parse(JSON.stringify(workerShapedAnalysis(text, chunks, stubState.signals, { engine: "CPU" })));
}

function assertNoTruncation(analysis, text) {
  const tokens = pseudoBpeTokenizer().encode(core.eligibleAiText(text)).length;
  const chunks = core.buildAiTokenChunks(text, pseudoBpeTokenizer());
  assert.equal(analysis.analyzedTokenCount, tokens, "every eligible token is covered");
  assert.equal(analysis.passages.length, chunks.length, "every window is kept");
  assert.equal(analysis.passages.at(-1).wordEnd, tokens, "the last window ends at the last token");
  assert.equal(analysis.truncatedPassageCount, 0);
  assert.equal(analysis.eligibleWordCount, core.eligibleAiWordCount(text));
}

// ---- DB fixture (auto completion + retry) ------------------------------------------------------------------------
const env = await fx.createFixtureEnvironment("ai_large_array_extrema");
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const kit = createKit(env);
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites("true");
test.after(() => {
  restoreAi();
  restoreC2();
  env.dispose();
});

function summaryFor(report, aiResult) {
  const enriched = { ...report, aiScore: aiResult.aiScore, aiAnalysis: aiResult.aiAnalysis };
  const aiStatus = aiResult.aiAnalysis.status === "complete" ? "ready" : "failed";
  return { enriched, summary: { ...buildReportSummary(enriched), aiStatus, similarityStatus: "pending" } };
}

// Past the spread limit with margin (~150k tokens), and still small enough that the real result is stored (not the size marker).
const LARGE_REPORT_CHARS = 600_000;

// ----------------------------------------------------------------------------------------------------------------

test("small vectors: both diagnostics equal the old spread expression exactly — representative windows, empty, NaN, ±Infinity, -0, missing wordEnd", () => {
  const representative = syntheticWindows(2_000, 11);
  const cases = [
    representative,
    [],
    [{ wordStart: 0, wordEnd: 3, probability: 0.9, logOdds: 2.2 }, { wordStart: 1, wordEnd: 4, probability: 0.1, logOdds: -2.2 }],
    [{ wordStart: 0, wordEnd: 3, probability: Number.NaN, logOdds: Number.NaN }, { wordStart: 2, wordEnd: 5, probability: 0.4, logOdds: 0.3 }],
    [{ wordStart: 0, wordEnd: 2, probability: 1, logOdds: Number.POSITIVE_INFINITY }, { wordStart: 1, wordEnd: 3, probability: 0, logOdds: Number.NEGATIVE_INFINITY }],
    [{ wordStart: 0, wordEnd: 2, probability: -0, logOdds: -0 }],
    [{ wordStart: 0, wordEnd: 2, probability: -0.5, logOdds: -40 }],
    [{ wordStart: 0, wordEnd: undefined, probability: 0.5, logOdds: 0 }],
    [{ wordStart: 0, wordEnd: Number.NaN, probability: 0.5, logOdds: 0 }],
  ];
  for (const [index, chunks] of cases.entries()) {
    for (const threshold of [undefined, 0.5, 0]) {
      assert.deepStrictEqual(core.calculateAiDiagnostics(chunks, threshold), legacyCalculateAiDiagnostics(chunks, threshold), `calculateAiDiagnostics case ${index} threshold ${threshold}`);
      assert.deepStrictEqual(core.calculateAiLogOddsDiagnostics(chunks, threshold), legacyCalculateAiLogOddsDiagnostics(chunks, threshold), `calculateAiLogOddsDiagnostics case ${index} threshold ${threshold}`);
    }
  }
  assert.deepStrictEqual(core.calculateAiLogOddsDiagnostics([]), { totalWords: 0, flaggedWords: 0, flaggedPassages: 0, percentFlagged: 0, meanProbability: 0, maxProbability: 0 });
  assert.ok(Number.isNaN(core.calculateAiDiagnostics(cases[3]).maxProbability), "a NaN probability still propagates to maxProbability, as before");
});

test("large vector: ~460k tokens (the ~1.85M-character browser regime) made the old spread throw RangeError; both diagnostics now succeed and equal a loop reference", () => {
  const windows = syntheticWindows(460_000);
  assert.throws(() => legacyCalculateAiLogOddsDiagnostics(windows), (error) => error instanceof RangeError && /Maximum call stack size exceeded/.test(error.message), "fixture sanity: the old expression overflows at this size");
  assert.throws(() => legacyCalculateAiDiagnostics(windows), RangeError);

  const logOdds = core.calculateAiLogOddsDiagnostics(windows);
  const reference = diagnosticsFor(windows); // real-ai-windows' loop clone above 100k tokens
  assert.equal(logOdds.totalWords, 460_000);
  for (const key of Object.keys(reference)) assert.equal(logOdds[key], reference[key], key);
  assert.equal(logOdds.flaggedPassages, windows.filter((w) => core.isAiPassageFlagged(w.logOdds)).length);

  const probability = core.calculateAiDiagnostics(windows);
  const perWord = new Float64Array(460_000);
  for (const w of windows) for (let i = w.wordStart; i < w.wordEnd; i += 1) if (w.probability > perWord[i]) perWord[i] = w.probability;
  let max = 0;
  let sum = 0;
  let flagged = 0;
  for (const value of perWord) {
    if (value > max) max = value;
    sum += value;
    if (value >= core.AI_PASSAGE_THRESHOLD) flagged += 1;
  }
  assert.deepStrictEqual(probability, {
    totalWords: 460_000,
    flaggedWords: flagged,
    percentFlagged: Math.round((flagged / 460_000) * 100),
    meanProbability: Math.round((sum / 460_000) * 1000) / 1000,
    maxProbability: Math.round(max * 1000) / 1000,
  });
});

test("real worker, ~1.85M characters: analyze() completes (no RangeError) and its result equals the independently rebuilt reference, untruncated", async () => {
  const text = synthProse(1_850_000, { seed: 4242, messiness: 0.01 });
  resetStub();
  BridgedWorker.errors = [];
  const { aiScore, aiAnalysis } = await roomShell.runAiAnalysis(text, detectLanguage(text));
  assert.deepEqual(BridgedWorker.errors, [], "the worker posted no error");
  assert.equal(aiAnalysis.error, undefined, `no worker error (${aiAnalysis.error})`);
  assert.equal(aiAnalysis.status, "complete");
  assert.ok(aiAnalysis.analyzedTokenCount > 400_000, `fixture sanity: ${aiAnalysis.analyzedTokenCount} tokens is far past the spread limit`);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(aiAnalysis)), referenceAnalysis(text));
  assert.equal(aiScore, aiAnalysis.score);
  assertNoTruncation(aiAnalysis, text);
});

test("AUTOMATIC AI completion on a large report: the real runAiAnalysis -> completeAiAnalysisWithRecovery -> persistAiCompletion path stores the real, complete result (ai_status ready)", async () => {
  const account = await env.signUpAccount();
  const text = synthProse(LARGE_REPORT_CHARS, { seed: 5151, messiness: 0.01 });
  await kit.asBrowser(account, async () => {
    const id = "ai-extrema-auto";
    const report = await kit.firstSave(account, id, text, 0);
    resetStub();
    BridgedWorker.errors = [];
    let computed = null;
    let saved = null;
    const ok = await roomShell.completeAiAnalysisWithRecovery(roomShell.runAiAnalysis(text, detectLanguage(text)), async (aiResult) => {
      computed = aiResult;
      const { enriched, summary } = summaryFor(report, aiResult);
      saved = await persistAiCompletion(enriched, summary, 0);
      return saved.ok;
    });
    assert.deepEqual(BridgedWorker.errors, [], "the worker posted no error");
    assert.equal(computed.aiAnalysis.error, undefined, `no worker error (${computed.aiAnalysis.error})`);
    assert.equal(computed.aiAnalysis.status, "complete");
    assert.ok(computed.aiAnalysis.analyzedTokenCount > 130_000, `fixture sanity: ${computed.aiAnalysis.analyzedTokenCount} tokens is past the spread limit`);
    const reference = referenceAnalysis(text);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(computed.aiAnalysis)), reference, "score / classification / passages equal the reference");
    assertNoTruncation(computed.aiAnalysis, text);
    assert.equal(ok, true);
    assert.equal(saved.summary.aiStatus, "ready");
    const row = await kit.readRow(id);
    assert.equal(row.ai_status, "ready");
    assert.equal(Number(row.ai_score), reference.score);
    const stored = await fetchRemoteReport(id);
    const persisted = stored.aiAnalysis;
    assert.equal(persisted.status, "complete");
    assert.equal(persisted.score, reference.score);
    assert.equal(persisted.coveragePercent, reference.coveragePercent);
    assert.equal(persisted.flaggedWordCount, reference.flaggedWordCount);
    assert.equal(persisted.maxProbability, reference.maxProbability);
    const expanded = expandCompactAiPassages(persisted, stored.text);
    assert.equal(expanded.ok, true, "the stored (compact) AI result decodes");
    assert.deepStrictEqual(expanded.passages, reference.passages, "every stored passage equals the reference — nothing dropped or altered");
  });
});

test("MANUAL AI Retry on a large report: the real retryAiAnalysisWithFreshLanguage -> persistAiRetryResult path turns a failed report into the real, complete result", async () => {
  const account = await env.signUpAccount();
  const text = synthProse(LARGE_REPORT_CHARS, { seed: 6262, messiness: 0.01 });
  await kit.asBrowser(account, async () => {
    const id = "ai-extrema-retry";
    const report = await kit.seedFailedReport(account, id, text, 1);
    assert.equal((await kit.readRow(id)).ai_status, "failed", "fixture sanity: the report starts failed (Retry offered)");
    resetStub();
    BridgedWorker.errors = [];
    const aiResult = await roomShell.retryAiAnalysisWithFreshLanguage(text);
    assert.deepEqual(BridgedWorker.errors, [], "the worker posted no error");
    assert.equal(aiResult.aiAnalysis.error, undefined, `no worker error (${aiResult.aiAnalysis.error})`);
    assert.equal(aiResult.aiAnalysis.status, "complete");
    const reference = referenceAnalysis(text);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(aiResult.aiAnalysis)), reference, "score / classification / passages equal the reference");
    assertNoTruncation(aiResult.aiAnalysis, text);
    const { enriched, summary } = summaryFor(report, aiResult);
    const saved = await persistAiRetryResult(enriched, summary);
    assert.equal(saved.ok, true);
    assert.equal(saved.summary.aiStatus, "ready");
    const row = await kit.readRow(id);
    assert.equal(row.ai_status, "ready");
    assert.equal(Number(row.ai_score), reference.score);
    const stored = await fetchRemoteReport(id);
    const persisted = stored.aiAnalysis;
    assert.equal(persisted.status, "complete");
    assert.equal(persisted.score, reference.score);
    const expanded = expandCompactAiPassages(persisted, stored.text);
    assert.equal(expanded.ok, true, "the stored (compact) AI result decodes");
    assert.deepStrictEqual(expanded.passages, reference.passages, "every stored passage equals the reference — nothing dropped or altered");
  });
});
