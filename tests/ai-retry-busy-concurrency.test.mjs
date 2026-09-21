import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as fx from "./helpers/large-report-retry-fixture.mjs";
import * as helpers from "./helpers/real-ai-windows.mjs";
import { createKit, ON, sha, num, payloadOf } from "./helpers/ai-compact-integration-kit.mjs";
import { fetchRemoteReport } from "../lib/reports-remote.ts";
import { persistAiRetryResult } from "../lib/report-ai-completion.ts";
import * as codec from "../lib/ai-passage-table.ts";

/**
 * G2 — the SQLITE_BUSY regression of the narrow Retry route (POST /api/reports/[id]/ai-retry).
 *
 * THE REGRESSION: two near-simultaneous Retry writes on one report race for SQLite's single write lock. The route opened ONE
 * write transaction with no BUSY handling, so the loser got a bare 500 ("200 + 500" — where the old whole-report path,
 * POST /api/reports, always gave "200 + 200" because insertReportWithRoomCheck retries BUSY on a fresh connection).
 * THE FIX: the same bounded fresh-connection retry loop (5 attempts, backoff + jitter), because every decision the route makes
 * is inside the one write transaction — re-running it re-reads current state and lands on last-writer-wins, as the old path did.
 *
 * Its own file: this suite deliberately opens many native libsql connections at once (and holds a write lock on another), and
 * DB-backed suites in this repo have a known, pre-existing native teardown flake under load — so it must not share a process
 * with the others. Run it at most once per validation pass.
 */

// Set up EVERYTHING before the first test() is registered (node:test starts a test the moment it is registered).
const env = await fx.createFixtureEnvironment("ai_retry_busy");
// tests/database-isolation.test.mjs: a file that drives DB-backed routes must override this itself.
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;

// The rate limiter (checkRate, and the resetRateForTest the fixture uses) WRITES to the same database as everything else, so a
// write lock held on the reports DB would block it before the route's own retry loop is ever reached. lib/rate-limit.ts's
// documented test-only escape hatch RATE_LIMIT_TEST_DB_URL moves ONLY the rate-limit state to a separate migrated file, which
// makes the lock-holder tests below exercise exactly the transaction the fix is about.
const rateDbFile = path.join(path.dirname(env.dbFile), "test_ai_retry_busy_ratelimit.db");
const removeRateDbFiles = () => { for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${rateDbFile}${suffix}`); } catch { /* not there */ } } };
removeRateDbFiles();
const rateClient = createClient({ url: `file:${rateDbFile}` });
await applyMigrationsLibsql(rateClient, path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle"));
const previousRateDbUrl = process.env.RATE_LIMIT_TEST_DB_URL;
process.env.RATE_LIMIT_TEST_DB_URL = `file:${rateDbFile}`;

const kit = createKit(env);
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites(undefined);
test.after(() => {
  restoreAi();
  restoreC2();
  if (previousRateDbUrl === undefined) delete process.env.RATE_LIMIT_TEST_DB_URL;
  else process.env.RATE_LIMIT_TEST_DB_URL = previousRateDbUrl;
  rateClient.close();
  removeRateDbFiles();
  env.dispose();
});

test("CONCURRENT RETRY: near-simultaneous valid Retry writes are no longer 200 + 500 from SQLITE_BUSY — every one is 200 and the final row is entirely ONE writer's result (last-writer-wins, as the old path)", async () => {
  const text = helpers.synthProse(60_000, { seed: 111, messiness: 0.01 });
  const account = await env.signUpAccount();
  const outcomes = [];
  await kit.asBrowser(account, async (route) => {
    for (let pair = 0; pair < 10; pair += 1) {
      const id = `conc-${pair}`;
      await kit.seedFailedReport(account, id, text, pair % 10);
      const full = await fetchRemoteReport(id);
      const A = kit.readyEnrichment(full, fx.syntheticAiAnalysis(text, { seed: 1001 }), 5);
      const B = kit.readyEnrichment(full, fx.syntheticAiAnalysis(text, { seed: 2002 }), 9);
      A.summary.aiScore = 21; A.summary.aiTone = "low";
      B.summary.aiScore = 42; B.summary.aiTone = "review";
      const startedAt = route.requests.length;
      const results = await fx.withAiCompactWrites(ON, () => Promise.all([persistAiRetryResult(A.enriched, A.summary), persistAiRetryResult(B.enriched, B.summary)]));
      const statuses = route.requests.slice(startedAt).filter((r) => r.path === `/api/reports/${id}/ai-retry`).map((r) => r.status).sort();
      outcomes.push(statuses.join("+"));
      assert.deepEqual(statuses, [200, 200], `pair ${pair}: both writes succeed (not 200 + 500)`);
      assert.deepEqual(results.map((r) => r.ok), [true, true]);
      // The final row is ENTIRELY A or ENTIRELY B: flat columns, raw score and the AI result all from one writer.
      const row = await kit.readRow(id);
      const payload = payloadOf(row);
      const isA = num(row.ai_score) === 21;
      assert.ok(isA || num(row.ai_score) === 42, `pair ${pair}: ai_score is one writer's`);
      assert.equal(row.ai_tone, isA ? "low" : "review");
      assert.equal(payload.aiScore, isA ? 5 : 9);
      const expectedAi = codec.compactAiAnalysis(fx.syntheticAiAnalysis(text, { seed: isA ? 1001 : 2002 }), text).analysis;
      assert.deepEqual(payload.aiAnalysis, JSON.parse(JSON.stringify(expectedAi)), `pair ${pair}: the AI result is that same writer's, complete`);
      assert.equal(row.ai_status, "ready");
    }
  });
  console.log("[ai-compact] concurrent retry outcomes:", JSON.stringify(outcomes));
});

test("SQLITE_BUSY handling is BOUNDED: with the write lock held elsewhere for the whole request the route gives up after its bounded retries with the generic 500 (nothing written, no hang); once the lock is released the same request succeeds", async () => {
  const text = helpers.synthProse(30_000, { seed: 121, messiness: 0.01 });
  const account = await env.signUpAccount();
  await kit.asBrowser(account, async () => { await kit.seedFailedReport(account, "busy-hold", text, 0); });
  const before = await kit.readRow("busy-hold");
  const aiAnalysis = JSON.parse(JSON.stringify(codec.compactAiAnalysis(fx.syntheticAiAnalysis(text), text).analysis));

  const holder = env.openConnection();
  const lock = await holder.transaction("write"); // BEGIN IMMEDIATE — the write lock, held by another connection
  let heldResult;
  const startedAt = Date.now();
  try {
    heldResult = await kit.callRetryRoute("busy-hold", { body: kit.retryBodyFor(aiAnalysis), cookie: account.cookie });
  } finally {
    await lock.rollback().catch(() => {});
    lock.close();
    holder.close();
  }
  const elapsedMs = Date.now() - startedAt;
  assert.equal(heldResult.status, 500, "bounded retries exhausted -> the generic 500");
  assert.deepEqual(heldResult.json, { error: "Unable to save the AI result. Please try again." });
  assert.doesNotMatch(heldResult.text, /SQLITE|BUSY|locked|database/i, "no driver text reaches the customer");
  assert.ok(elapsedMs >= 250, `it really backed off and retried (${elapsedMs} ms)`);
  assert.ok(elapsedMs < 5000, `and gave up promptly (${elapsedMs} ms)`);
  assert.equal(sha((await kit.readRow("busy-hold")).payload_json), sha(before.payload_json), "nothing was written");

  const afterRelease = await kit.callRetryRoute("busy-hold", { body: kit.retryBodyFor(aiAnalysis), cookie: account.cookie });
  assert.equal(afterRelease.status, 200, "with the lock released the very same request succeeds");
  assert.equal((await kit.readRow("busy-hold")).ai_status, "ready");
  console.log("[ai-compact] BUSY exhaustion:", JSON.stringify({ status: heldResult.status, elapsedMs }));
});

test("A lock that clears DURING the retries is ridden out: the request succeeds (200) instead of failing on the first SQLITE_BUSY", async () => {
  const text = helpers.synthProse(30_000, { seed: 131, messiness: 0.01 });
  const account = await env.signUpAccount();
  await kit.asBrowser(account, async () => { await kit.seedFailedReport(account, "busy-clears", text, 0); });
  const aiAnalysis = JSON.parse(JSON.stringify(codec.compactAiAnalysis(fx.syntheticAiAnalysis(text), text).analysis));
  const holder = env.openConnection();
  const lock = await holder.transaction("write");
  const request = kit.callRetryRoute("busy-clears", { body: kit.retryBodyFor(aiAnalysis), cookie: account.cookie });
  await new Promise((resolve) => setTimeout(resolve, 90)); // the first attempt(s) are BUSY ...
  await lock.rollback();
  lock.close();
  holder.close();
  const result = await request; // ... a later attempt, on a fresh connection, lands.
  assert.equal(result.status, 200);
  assert.equal((await kit.readRow("busy-clears")).ai_status, "ready");
});
