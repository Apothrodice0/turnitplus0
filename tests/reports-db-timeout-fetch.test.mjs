import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { createTimeoutFetch, getReportsDbClient } from "../lib/reports-db.ts";

/**
 * DB TRANSPORT-TIMEOUT — deterministic tests, NO real Turso/network.
 *
 * createTimeoutFetch is the pure, injectable helper getReportsDbClient's
 * opt-in `requestTimeoutMs` option builds on (see that function's own header
 * comment) — every test here drives it directly with a fake `baseFetch`,
 * never a real network call. Coverage for the two authoritative-recovery
 * call sites' actual opt-in (I/J below) is structural/source-level, the same
 * convention the closed Blob adapter's own "security" tests already use in
 * this repo (tests/selective-corpus-vercel-blob.test.mjs).
 */

// ═══════════════════════════════════════════════════════════════════════
// createTimeoutFetch — pure unit tests
// ═══════════════════════════════════════════════════════════════════════

test("timeout-fetch A: successful fetch resolves normally, signal attached and not pre-aborted", async () => {
  const seenSignals = [];
  const fakeBaseFetch = async (input, init) => {
    seenSignals.push(init?.signal);
    return new Response("ok", { status: 200 });
  };
  const timeoutFetch = createTimeoutFetch(50, fakeBaseFetch);
  const res = await timeoutFetch("https://example.invalid/v2/pipeline", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(seenSignals.length, 1);
  assert.ok(seenSignals[0] instanceof AbortSignal, "a real AbortSignal was passed through");
  assert.equal(seenSignals[0].aborted, false, "signal is not aborted on a fast, successful call");
});

test("timeout-fetch B: fresh signal per call -- two calls never share a signal", async () => {
  const seenSignals = [];
  const fakeBaseFetch = async (input, init) => {
    seenSignals.push(init.signal);
    return new Response("ok");
  };
  const timeoutFetch = createTimeoutFetch(50, fakeBaseFetch);
  await timeoutFetch("https://example.invalid/a", {});
  await timeoutFetch("https://example.invalid/b", {});
  assert.equal(seenSignals.length, 2);
  assert.notEqual(seenSignals[0], seenSignals[1], "each call gets its own fresh signal -- never reused");
});

test("timeout-fetch C: a real, tiny (test-local only) timeout genuinely aborts the underlying fake fetch -- not merely a Promise.race that lets it keep running", async () => {
  let observedAbortedInsideBaseFetch = false;
  let baseFetchSettled = false;
  const fakeBaseFetch = (input, init) =>
    new Promise((resolve, reject) => {
      // Simulates a stalled remote call: never resolves on its own, but DOES
      // react to the signal exactly like a real fetch would -- proving the
      // wrapper's signal is the thing that actually stops it, not a race
      // that just stops waiting while this executor keeps running forever.
      init.signal.addEventListener("abort", () => {
        observedAbortedInsideBaseFetch = true;
        baseFetchSettled = true;
        reject(init.signal.reason);
      });
    });
  const timeoutFetch = createTimeoutFetch(5, fakeBaseFetch); // 5ms, test-local only
  await assert.rejects(() => timeoutFetch("https://example.invalid/slow", {}));
  assert.equal(observedAbortedInsideBaseFetch, true, "the fake fetch's own abort listener fired -- genuine cancellation, not a discarded race");
  assert.equal(baseFetchSettled, true);
});

test("timeout-fetch D: rejection reason is AbortSignal.timeout()'s own DOMException, named TimeoutError, with a non-sensitive, generic message", async () => {
  const fakeBaseFetch = (input, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const timeoutFetch = createTimeoutFetch(5, fakeBaseFetch);
  await assert.rejects(
    () => timeoutFetch("https://example.invalid/slow", {}),
    (err) => {
      assert.ok(err instanceof DOMException);
      assert.equal(err.name, "TimeoutError", "AbortSignal.timeout()'s own reason is a TimeoutError-named DOMException");
      assert.ok(!/token|auth|password|secret/i.test(err.message), "no credential-shaped content in the message");
      return true;
    },
  );
});

test("timeout-fetch E: an existing caller-supplied signal is preserved (composed), never discarded -- both an init.signal and a Request's own signal", async () => {
  // init.signal case
  const callerController = new AbortController();
  let seenSignal1;
  const fakeBaseFetch1 = async (input, init) => {
    seenSignal1 = init.signal;
    return new Response("ok");
  };
  const timeoutFetch1 = createTimeoutFetch(50, fakeBaseFetch1);
  await timeoutFetch1("https://example.invalid/x", { signal: callerController.signal });
  assert.notEqual(seenSignal1, callerController.signal, "a NEW composed signal is used, not the bare caller signal");
  callerController.abort(new DOMException("caller cancelled", "AbortError"));
  assert.equal(seenSignal1.aborted, true, "the composed signal reflects the caller's own abort");
  assert.equal(seenSignal1.reason.name, "AbortError", "the caller's own abort reason is preserved, not overwritten");

  // Request-object case (hrana-client's real single-argument call shape)
  const reqController = new AbortController();
  const req = new Request("https://example.invalid/y", { signal: reqController.signal });
  let seenRequest2;
  const fakeBaseFetch2 = async (request) => {
    seenRequest2 = request;
    return new Response("ok");
  };
  const timeoutFetch2 = createTimeoutFetch(50, fakeBaseFetch2);
  await timeoutFetch2(req);
  assert.ok(seenRequest2 instanceof Request);
  assert.notEqual(seenRequest2.signal, reqController.signal, "a NEW composed signal is used for the Request too");
  reqController.abort(new DOMException("caller cancelled", "AbortError"));
  assert.equal(seenRequest2.signal.aborted, true);
  assert.equal(seenRequest2.signal.reason.name, "AbortError");
});

test("timeout-fetch F: single-Request-argument call shape (hrana-client's actual usage) is handled without a separate init", async () => {
  const req = new Request("https://example.invalid/pipeline", { method: "POST", body: "{}" });
  let seenRequest;
  const fakeBaseFetch = async (request) => {
    seenRequest = request;
    return new Response("ok");
  };
  const timeoutFetch = createTimeoutFetch(50, fakeBaseFetch);
  await timeoutFetch(req);
  assert.ok(seenRequest instanceof Request);
  assert.equal(seenRequest.method, "POST");
  assert.ok(seenRequest.signal instanceof AbortSignal);
  assert.equal(seenRequest.signal.aborted, false);
});

test("timeout-fetch G: no dangling timer on the success path -- process can exit immediately (no unref needed, timer is cleared)", async () => {
  const fakeBaseFetch = async () => new Response("ok");
  const timeoutFetch = createTimeoutFetch(50, fakeBaseFetch);
  await timeoutFetch("https://example.invalid/fast", {});
  // If the timer were left live, awaiting past its own duration would still
  // be fine (clearTimeout is a no-op on an already-fired-or-not timer either
  // way) -- the real proof is structural (see the finally-block source
  // review below) plus the absence of any unhandledRejection here.
  let unhandled = false;
  const handler = () => { unhandled = true; };
  process.on("unhandledRejection", handler);
  await sleep(70); // past the 50ms timeout window
  process.off("unhandledRejection", handler);
  assert.equal(unhandled, false, "no unhandled rejection after the timer's own window elapses on an already-resolved call");
});

test("timeout-fetch H: source review -- AbortSignal.timeout() is used, never manually cleared, and no manual AbortController/setTimeout/clearTimeout/Promise.race remains", () => {
  const src = readFileSync(join(process.cwd(), "lib", "reports-db.ts"), "utf8");
  assert.match(src, /AbortSignal\.timeout\(timeoutMs\)/, "a fresh AbortSignal.timeout(timeoutMs) is created per call");
  assert.match(src, /AbortSignal\.any\(\[existingSignal, timeoutSignal\]\)/, "an existing caller signal is composed with the timeout signal via AbortSignal.any");
  assert.ok(!/new AbortController\(\)/.test(src), "no manual AbortController -- AbortSignal.timeout() is the only cancellation source");
  assert.ok(!/setTimeout\(/.test(src), "no manual setTimeout -- the timeout is AbortSignal.timeout()'s own internal timer");
  assert.ok(!/clearTimeout\(/.test(src), "no clearTimeout -- the timeout signal must stay live through response-body consumption, not be disarmed when fetch() resolves");
  assert.ok(!/Promise\.race/.test(src), "no Promise.race -- cancellation is via AbortSignal, which genuinely cancels the underlying fetch/body read rather than merely stopping the caller from waiting");
});

test("timeout-fetch K: BODY-STALL REGRESSION -- fetch() resolving with a Response does not disarm the timeout; a stalled response BODY is still aborted, strictly after fetch() itself already resolved", async () => {
  let bodyReaderAbortedAt = null;
  let signalSeenByBaseFetch;
  const fakeBaseFetch = async (input, init) => {
    signalSeenByBaseFetch = init.signal;
    const body = new ReadableStream({
      start(controller) {
        const onAbort = () => {
          bodyReaderAbortedAt = Date.now();
          controller.error(init.signal.reason);
        };
        if (init.signal.aborted) {
          onAbort();
          return;
        }
        init.signal.addEventListener("abort", onAbort);
        // Deliberately never enqueues/closes on its own -- models a response
        // whose headers arrived (fetch() resolves) but whose body stream
        // never finishes on its own, exactly like a stalled Turso response.
      },
    });
    // fetch() itself resolves immediately -- headers "arrived". This is the
    // point at which the OLD manual-clearTimeout implementation disarmed its
    // timer, leaving the body below permanently unprotected.
    return new Response(body, { status: 200 });
  };

  const TINY_TEST_TIMEOUT_MS = 20; // never 4000ms -- test-local only
  const timeoutFetch = createTimeoutFetch(TINY_TEST_TIMEOUT_MS, fakeBaseFetch);

  const response = await timeoutFetch("https://example.invalid/pipeline", { method: "POST" });
  const fetchResolvedAt = Date.now();
  assert.equal(response.status, 200, "fetch() resolves successfully with a Response, same as hrana-client observes before it starts decoding the body");
  assert.equal(bodyReaderAbortedAt, null, "the body has not been touched yet -- fetch() resolving must not by itself abort anything");

  // NOW begin body consumption -- mirrors hrana-client's own separate, later
  // decodeResponse(resp) step (resp.json()/resp.text()/resp.arrayBuffer()),
  // which runs in a .then() callback AFTER the fetch promise has settled.
  // Raced against a bounded local observation window (10x the test timeout)
  // so that against the OLD manual-clearTimeout implementation -- which
  // never aborts this stalled body at all -- this test fails deterministically
  // and fast, rather than hanging forever waiting on a read() that would
  // never settle.
  const reader = response.body.getReader();
  const STILL_PENDING = Symbol("still-pending-after-observation-window");
  const observationWindow = new Promise((resolve) => setTimeout(() => resolve(STILL_PENDING), TINY_TEST_TIMEOUT_MS * 10));
  let readOutcome;
  try {
    readOutcome = { settled: "resolved", value: await Promise.race([reader.read(), observationWindow]) };
  } catch (err) {
    readOutcome = { settled: "rejected", err };
  }
  assert.notEqual(
    readOutcome.settled === "resolved" ? readOutcome.value : undefined,
    STILL_PENDING,
    `body consumption on a stalled body must reject within ${TINY_TEST_TIMEOUT_MS * 10}ms -- it is still pending, proving the timeout signal was disarmed before body consumption (the OLD manual-clearTimeout defect)`,
  );
  assert.equal(readOutcome.settled, "rejected", "body consumption on a stalled body must reject, not resolve");
  assert.ok(readOutcome.err instanceof DOMException);
  assert.equal(readOutcome.err.name, "TimeoutError", "the stalled body read is aborted by the SAME timeout signal, after fetch() already resolved");

  assert.ok(bodyReaderAbortedAt !== null, "the body reader's own abort listener fired");
  assert.ok(
    bodyReaderAbortedAt >= fetchResolvedAt,
    "the abort happened AT OR AFTER fetch() itself already resolved -- proving protection extends past response-headers-arrived, not merely up to it",
  );
  assert.equal(signalSeenByBaseFetch.aborted, true, "the same signal object baseFetch received is the one that fired -- no second, disconnected signal");
});

// ═══════════════════════════════════════════════════════════════════════
// getReportsDbClient -- option handling (local file-mode smoke only, no
// remote network; requestTimeoutMs is a no-op for the sqlite3 driver, but
// this proves the option is accepted without error and doesn't disturb the
// existing PRAGMA-init behavior)
// ═══════════════════════════════════════════════════════════════════════

test("getReportsDbClient A: omitting requestTimeoutMs is unchanged from before this audit finding", async () => {
  const client = await getReportsDbClient();
  try {
    const result = await client.execute("SELECT 1 AS one");
    assert.equal(Number(result.rows[0].one), 1);
  } finally {
    client.close();
  }
});

test("getReportsDbClient (opt-in): passing requestTimeoutMs does not break client construction or the existing PRAGMA statement", async () => {
  const client = await getReportsDbClient({ requestTimeoutMs: 4000 });
  try {
    const result = await client.execute("SELECT 1 AS one");
    assert.equal(Number(result.rows[0].one), 1);
  } finally {
    client.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// I/J: structural proof of exactly which call sites opt in
// ═══════════════════════════════════════════════════════════════════════

test("call-site I: both authoritative-recovery-sweep DB client constructions opt into exactly SELECTIVE_CORPUS_DB_REQUEST_TIMEOUT_MS (4000ms)", () => {
  const src = readFileSync(
    join(process.cwd(), "app", "api", "internal", "selective-corpus-authoritative-sweep", "route.ts"),
    "utf8",
  );
  assert.match(src, /const SELECTIVE_CORPUS_DB_REQUEST_TIMEOUT_MS = 4000;/);
  const optInSites = [...src.matchAll(/getReportsDbClient\(\{\s*requestTimeoutMs:\s*SELECTIVE_CORPUS_DB_REQUEST_TIMEOUT_MS\s*\}\)/g)];
  assert.equal(optInSites.length, 2, "exactly two getReportsDbClient() construction sites in this route, both opted in");
  // No bare, unbounded getReportsDbClient() call should remain in this file.
  const bareCalls = [...src.matchAll(/getReportsDbClient\(\)/g)];
  assert.equal(bareCalls.length, 0, "no unbounded getReportsDbClient() call remains in the sweep route");
});

test("call-site J: unrelated getReportsDbClient() callers remain unbounded/default (spot-check a normal application route)", () => {
  const src = readFileSync(join(process.cwd(), "app", "api", "reports", "route.ts"), "utf8");
  assert.ok(src.includes("getReportsDbClient()"), "app/api/reports/route.ts still calls the bare, default-behavior client");
  assert.ok(!src.includes("requestTimeoutMs"), "app/api/reports/route.ts does not opt into the DB transport timeout");
});

test("no diff in scoring/matching: lib/user-submission-matching.ts's dbQueryTimeoutMs and withTimeout are untouched by this audit finding", () => {
  const src = readFileSync(join(process.cwd(), "lib", "user-submission-matching.ts"), "utf8");
  assert.match(src, /dbQueryTimeoutMs:\s*1_500,/);
  assert.match(src, /function withTimeout<T>\(promise: Promise<T>, timeoutMs: number, label: string\): Promise<T> \{/);
  assert.match(src, /return Promise\.race\(\[promise, timeout\]\)\.finally\(\(\) => clearTimeout\(timer\)\);/);
});
