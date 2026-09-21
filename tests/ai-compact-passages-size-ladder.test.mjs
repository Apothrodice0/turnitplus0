import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import * as fx from "./helpers/large-report-retry-fixture.mjs";
import * as helpers from "./helpers/real-ai-windows.mjs";
import { createKit, CEILING, ON, OFF, sha, bytesOf, num, payloadOf, lastPost } from "./helpers/ai-compact-integration-kit.mjs";
import { fetchRemoteReport, fetchReportRoomContents } from "../lib/reports-remote.ts";
import { persistAiCompletion, persistAiRetryResult } from "../lib/report-ai-completion.ts";
import * as codec from "../lib/ai-passage-table.ts";

/**
 * ai-compact-v1 — THE SIZE LADDER, end to end through the REAL handlers with the request/persistence ceiling untouched.
 *
 * THE FORMER DEAD END: a ~600k-character report saved and opened perfectly, then its first automatic AI save 413'd (the whole
 * report plus ~1.5M of copied window text > 2,000,000) and the Retry it offered 413'd too (the projected persisted row >
 * 2,000,000). At 850k and 1M — the archive engine's text regime — even the Retry REQUEST alone is over the ceiling. With the
 * writer gate ON the AI result is a compact table pointing into the manuscript and every one of these succeeds.
 *
 * The AI result is REALISTIC (real overlapping 240/120-token windows, ~2.4-2.5x the manuscript) on low-similarity synthetic
 * prose, i.e. the case whose ONLY size problem is the AI result. Heavy on purpose, so it is its own file (see
 * tests/helpers/ai-compact-integration-kit.mjs). The finer-grained ladder (100k … 1.8M and the residual band) is measured by
 * the task's scratch scripts, not committed.
 */

// Set up EVERYTHING before the first test() is registered (node:test starts a test the moment it is registered).
const env = await fx.createFixtureEnvironment("ai_compact_ladder");
// tests/database-isolation.test.mjs: a file that drives DB-backed routes must override this itself.
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const kit = createKit(env);
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites(undefined); // the DEFAULT (OFF); each step pins what it needs
test.after(() => {
  restoreAi();
  restoreC2();
  env.dispose();
});

const similarityOf = (full) => ({ unifiedSimilarity: full.unifiedSimilarity, evidenceInterpretation: full.evidenceInterpretation, reportCompletion: full.reportCompletion });

/** Everything measured for one manuscript size, through the real handlers: automatic AI save and Retry, gate OFF then ON. */
async function exerciseSize(chars, seed) {
  const text = helpers.synthProse(chars, { seed, messiness: 0.01 });
  const legacyAi = fx.syntheticAiAnalysis(text);
  const account = await env.signUpAccount();
  const out = {
    manuscriptChars: text.length,
    windows: legacyAi.passages.length,
    legacyAiBytes: bytesOf(legacyAi),
    compactAiBytes: bytesOf(codec.prepareAiAnalysisForTransport(legacyAi, text, { compactWrites: true })),
  };
  assert.ok(out.legacyAiBytes / text.length > 2.0, `fixture sanity: realistic legacy AI (${(out.legacyAiBytes / text.length).toFixed(2)}x)`);
  await kit.asBrowser(account, async (route) => {
    // ---------------- A. the automatic post-upload AI save (POST /api/reports carries the whole report) ----------------
    const autoId = `auto-${chars}`;
    const report = await kit.firstSave(account, autoId, text, 0);
    out.firstSaveBytes = lastPost(route).bytes;
    const afterFirst = await kit.readRow(autoId);
    const fullFirst = await fetchRemoteReport(autoId);
    const { enriched, summary } = kit.readyEnrichment(report, legacyAi);

    const legacy = await fx.withAiCompactWrites(OFF, () => persistAiCompletion(enriched, summary, 0));
    const legacyRequest = lastPost(route);
    const afterLegacy = await kit.readRow(autoId);
    out.automatic = { legacy: { ok: legacy.ok, status: legacyRequest.status, bytes: legacyRequest.bytes, aiStatusAfter: afterLegacy.ai_status, rowUnchanged: sha(afterLegacy.payload_json) === sha(afterFirst.payload_json) } };

    const compact = await fx.withAiCompactWrites(ON, () => persistAiCompletion(enriched, summary, 0));
    const compactRequest = lastPost(route);
    const afterCompact = await kit.readRow(autoId);
    out.automatic.compact = { ok: compact.ok, status: compactRequest.status, bytes: compactRequest.bytes, aiStatusAfter: afterCompact.ai_status, persistedChars: num(afterCompact.chars) };
    if (compact.ok) {
      const full = await fetchRemoteReport(autoId);
      out.automatic.compact.getKeepsCompact = Boolean(full.aiAnalysis.compactPassages) && full.aiAnalysis.passages.length === 0;
      const expanded = codec.expandCompactAiPassages(full.aiAnalysis, full.text);
      out.automatic.compact.endToEndExact = expanded.ok && isDeepStrictEqual(expanded.passages, legacyAi.passages);
      // (The automatic resave re-finalizes similarity server-side with a wall-clock-budgeted matcher, so this comparison is only
      // asserted at the smaller size; the Retry route never recomputes similarity and is compared at every size.)
      out.automatic.compact.similarityUnchanged = isDeepStrictEqual(similarityOf(full), similarityOf(fullFirst));
      out.automatic.compact.aiScoreColumn = num(afterCompact.ai_score);
    }

    // ---------------- B. a manual Retry (POST /api/reports/[id]/ai-retry carries only the AI result) ----------------
    const retryId = `retry-${chars}`;
    await kit.seedFailedReport(account, retryId, text, 1);
    const beforeRetry = await kit.readRow(retryId);
    const fullBefore = await fetchRemoteReport(retryId);
    const retryEnrichment = kit.readyEnrichment(fullBefore, legacyAi);

    const legacyRetry = await fx.withAiCompactWrites(OFF, () => persistAiRetryResult(retryEnrichment.enriched, retryEnrichment.summary));
    const legacyRetryRequest = lastPost(route, (r) => r.path === `/api/reports/${retryId}/ai-retry`);
    const afterLegacyRetry = await kit.readRow(retryId);
    out.retry = {
      legacy: {
        ok: legacyRetry.ok, status: legacyRetryRequest.status, bytes: legacyRetryRequest.bytes,
        rowUnchanged: sha(afterLegacyRetry.payload_json) === sha(beforeRetry.payload_json), aiStatusAfter: afterLegacyRetry.ai_status,
        projectedPersisted: num(beforeRetry.chars) - bytesOf(payloadOf(beforeRetry).aiAnalysis) + out.legacyAiBytes,
      },
    };

    const compactRetry = await fx.withAiCompactWrites(ON, () => persistAiRetryResult(retryEnrichment.enriched, retryEnrichment.summary));
    const compactRetryRequest = lastPost(route, (r) => r.path === `/api/reports/${retryId}/ai-retry`);
    const afterCompactRetry = await kit.readRow(retryId);
    out.retry.compact = { ok: compactRetry.ok, status: compactRetryRequest.status, bytes: compactRetryRequest.bytes, aiStatusAfter: afterCompactRetry.ai_status, persistedChars: num(afterCompactRetry.chars) };
    if (compactRetry.ok) {
      const full = await fetchRemoteReport(retryId);
      const expanded = codec.expandCompactAiPassages(full.aiAnalysis, full.text);
      out.retry.compact.endToEndExact = expanded.ok && isDeepStrictEqual(expanded.passages, legacyAi.passages);
      out.retry.compact.similarityUnchanged = isDeepStrictEqual(similarityOf(full), similarityOf(fullBefore));
      const roomContents = await fetchReportRoomContents(1);
      out.retry.compact.roomReady = roomContents.ok && roomContents.contents.status === "ready";
    }
  });
  return out;
}

function assertSizeResult(result, label, { legacyRetryOverRequestCeiling, assertAutomaticSimilarity }) {
  const { automatic, retry } = result;
  // BEFORE (gate OFF): the former dead end — both refused, nothing written, the report left as it was.
  assert.equal(automatic.legacy.status, 413, `${label}: the legacy automatic AI save is refused 413`);
  assert.equal(automatic.legacy.ok, false);
  assert.equal(automatic.legacy.rowUnchanged, true, `${label}: and the saved report is byte-identical (nothing was written)`);
  assert.equal(automatic.legacy.aiStatusAfter, "processing", `${label}: the room stays 'processing' — the dead end`);
  assert.ok(automatic.legacy.bytes > CEILING, `${label}: the legacy request (${automatic.legacy.bytes}) is over the ceiling`);
  assert.equal(retry.legacy.status, 413, `${label}: and so is the legacy Retry`);
  assert.equal(retry.legacy.rowUnchanged, true);
  assert.ok(retry.legacy.projectedPersisted > CEILING, `${label}: the legacy Retry's projected persisted row (${retry.legacy.projectedPersisted}) is over the ceiling`);
  if (legacyRetryOverRequestCeiling) assert.ok(retry.legacy.bytes > CEILING, `${label}: the legacy Retry REQUEST alone is over the ceiling`);
  else assert.ok(retry.legacy.bytes < CEILING, `${label}: the legacy Retry REQUEST fits — it is the PERSISTED projection that refuses (the second dead end)`);
  // AFTER (gate ON): both succeed, the limits untouched, the AI half persisted compact and exactly reproducible.
  assert.equal(automatic.compact.status, 200, `${label}: the compact automatic AI save succeeds`);
  assert.equal(automatic.compact.ok, true);
  assert.equal(automatic.compact.aiStatusAfter, "ready");
  assert.ok(automatic.compact.bytes < CEILING && automatic.compact.persistedChars < CEILING, `${label}: under the unchanged ceiling (${automatic.compact.bytes} / ${automatic.compact.persistedChars})`);
  assert.equal(automatic.compact.getKeepsCompact, true, `${label}: GET returns the compact form (nothing inflated it)`);
  assert.equal(automatic.compact.endToEndExact, true, `${label}: expand(GET) is deep-equal to the browser's original passages`);
  if (assertAutomaticSimilarity) assert.equal(automatic.compact.similarityUnchanged, true, `${label}: similarity state unchanged`);
  assert.equal(retry.compact.status, 200, `${label}: the compact Retry succeeds`);
  assert.equal(retry.compact.ok, true);
  assert.equal(retry.compact.aiStatusAfter, "ready");
  assert.ok(retry.compact.bytes < CEILING * 0.2, `${label}: the compact Retry request is tiny (${retry.compact.bytes})`);
  assert.ok(retry.compact.persistedChars < CEILING);
  assert.equal(retry.compact.endToEndExact, true);
  assert.equal(retry.compact.similarityUnchanged, true, `${label}: a Retry never moves similarity`);
  assert.equal(retry.compact.roomReady, true, `${label}: the room poll reports the retry's result`);
  assert.ok(result.compactAiBytes / result.manuscriptChars < 0.115, `${label}: compact AI ~0.08-0.1x the manuscript (${(result.compactAiBytes / result.manuscriptChars).toFixed(3)}x)`);
  assert.ok(result.legacyAiBytes / result.manuscriptChars > 2.0);
}

test("FORMER 600K DEAD END: a report that saved and opened perfectly no longer 413s on its first automatic AI save OR on Retry once the AI result is compact — both limits untouched, similarity unchanged", async () => {
  assert.equal(CEILING, 2_000_000, "the request/persistence ceiling is unchanged");
  const result = await exerciseSize(600_000, 601);
  assertSizeResult(result, "600k", { legacyRetryOverRequestCeiling: false, assertAutomaticSimilarity: true });
  console.log("[ai-compact] 600k:", JSON.stringify(result));
});

test("850K (archive-engine regime): automatic AI save and Retry both succeed with compact AI; the legacy form is refused, its Retry request alone being over the ceiling", async () => {
  const result = await exerciseSize(850_000, 851);
  assertSizeResult(result, "850k", { legacyRetryOverRequestCeiling: true, assertAutomaticSimilarity: false });
  console.log("[ai-compact] 850k:", JSON.stringify(result));
});

test("1M (the archive-engine's text cap): automatic AI save and Retry both succeed with compact AI, with wide headroom; the legacy form is refused", async () => {
  const result = await exerciseSize(1_000_000, 1001);
  assertSizeResult(result, "1000k", { legacyRetryOverRequestCeiling: true, assertAutomaticSimilarity: false });
  assert.ok(result.automatic.compact.persistedChars < CEILING * 0.6, "1M characters leaves wide headroom under the ceiling once compact");
  assert.ok(result.retry.compact.bytes < result.retry.legacy.bytes / 20, "Retry request: compact is >20x smaller than legacy");
  console.log("[ai-compact] 1000k:", JSON.stringify(result));
});
