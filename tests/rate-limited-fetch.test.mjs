import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithRateLimitRetry, isRequestRateLimited, rateLimitWaitMs, RATE_LIMIT_MAX_WAIT_MS } from "../lib/rate-limited-fetch.ts";

/**
 * RATE-LIMIT RETRY (Rule A reliability check 2026-10-25): a legitimate pipeline request that meets the per-IP limiter's 429
 * waits Retry-After and sends the same request again; the daily upload quota's 429 and every other status are returned at once.
 */
const limited = (retryAfter = "7") => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "Retry-After": retryAfter } });
const quota = () => new Response(JSON.stringify({ error: "Daily upload limit reached", resetsAt: "2026-10-26T00:00:00.000Z" }), { status: 429 });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
function scripted(responses) {
  const calls = [];
  return { calls, fetchImpl: async (input, init) => { calls.push({ input, body: init?.body }); const r = responses.shift(); return typeof r === "function" ? r() : r; } };
}

test("the limiter's 429 is waited out (Retry-After) and the SAME request is sent again", async () => {
  const s = scripted([limited("7"), limited("3"), ok]); const waits = [];
  const res = await fetchWithRateLimitRetry("/api/reports", { method: "POST", body: "{\"id\":\"r1\",\"room\":2}" }, { fetchImpl: s.fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(res.status, 200);
  assert.equal(s.calls.length, 3);
  assert.ok(s.calls.every((c) => c.input === "/api/reports" && c.body === "{\"id\":\"r1\",\"room\":2}"), "same report id, same room: nothing new is claimed");
  assert.ok(waits[0] >= 7000 && waits[0] < 7800 && waits[1] >= 3000 && waits[1] < 3800, `waits follow Retry-After: ${waits}`);
});

test("the daily upload quota's 429 (resetsAt) and other statuses are never retried", async () => {
  for (const r of [quota, () => new Response("{}", { status: 500 }), () => new Response("{}", { status: 409 }), () => new Response("{}", { status: 403 })]) {
    const s = scripted([r, ok]); const res = await fetchWithRateLimitRetry("/api/reports", {}, { fetchImpl: s.fetchImpl, sleep: async () => { throw new Error("must not wait"); } });
    assert.equal(s.calls.length, 1); assert.notEqual(res.status, 200);
  }
  assert.equal(await isRequestRateLimited(quota()), false);
  assert.equal(await isRequestRateLimited(limited()), true);
});

test("bounded: gives the 429 back after the retry budget; an abort stops the wait", async () => {
  const s = scripted([limited(), limited(), limited()]);
  const res = await fetchWithRateLimitRetry("/api/academic-evidence", {}, { fetchImpl: s.fetchImpl, retries: 2, sleep: async () => {} });
  assert.equal(res.status, 429); assert.equal(s.calls.length, 3);
  const s2 = scripted([limited("60"), limited("60"), limited("60"), limited("60")]);
  const res2 = await fetchWithRateLimitRetry("/api/academic-evidence", {}, { fetchImpl: s2.fetchImpl, maxTotalWaitMs: 100_000, sleep: async () => {} });
  assert.equal(res2.status, 429); assert.equal(s2.calls.length, 2, "a second 60 s wait would exceed the total budget");
  const ac = new AbortController(); const s3 = scripted([limited("30"), ok]);
  const p = fetchWithRateLimitRetry("/api/reports", { signal: ac.signal }, { fetchImpl: s3.fetchImpl }); setTimeout(() => ac.abort(), 20);
  await assert.rejects(p); assert.equal(s3.calls.length, 1);
});

test("wait: Retry-After seconds plus < 750 ms jitter, 5 s when absent, capped", () => {
  assert.equal(rateLimitWaitMs(limited("12"), () => 0), 12_000);
  assert.equal(rateLimitWaitMs(new Response("{}", { status: 429 }), () => 0), 5_000);
  assert.equal(rateLimitWaitMs(limited("3600"), () => 0), RATE_LIMIT_MAX_WAIT_MS);
});
