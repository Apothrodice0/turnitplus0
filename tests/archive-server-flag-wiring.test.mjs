import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import {
  analyzeArchive,
  resolveArchiveEngine,
  __resetArchiveEngineForTests,
  __getArchiveRuntimeTestState,
} from "../lib/archive-analysis-runtime.ts";

/**
 * Slice 2E, Phases 8 + 9 + the fail-closed correction — the engine switch in
 * lib/archive-analysis-runtime.ts.
 *
 *   Explicit archiveServerSide:false  => engine "browser" (worker spawned).
 *   Explicit archiveServerSide:true   => engine "server"  (worker NEVER spawned).
 *   AMBIGUOUS mode discovery — GET network failure / non-2xx / non-JSON /
 *   missing-or-non-boolean archiveServerSide — THROWS; archive analysis fails
 *   and the similarity worker is NEVER instantiated as a consolation.
 *   Once "server" resolved, a POST failure REJECTS — no browser fallback.
 *
 * Phase 9 also proves server mode fetches no packed-archive asset (.bin /
 * document-index.meta.json / risk-calibration.json) — the basis for dropping
 * the ~28 MB browser archive download later.
 *
 * Slice 2G — the legacy browser worker now lives in a separate module
 * (lib/archive-browser-runtime.ts) reached ONLY through a lazy
 * `import("./archive-browser-runtime")`. archive-analysis-runtime.ts holds no
 * static `new Worker(...)` / similarity-worker.ts reference. The 2G section
 * below proves that lazy boundary: engine resolution alone never imports it,
 * only the explicit browser path does, and server / ambiguous / POST-failure
 * paths never reach it. __getArchiveRuntimeTestState().browserRuntimeRequested
 * is the accessor for "was the lazy browser module requested".
 */

const FROZEN_RESULT = {
  wordCount: 100, databaseSize: 5, excludedDocuments: 0, matchedWordCount: 0,
  archiveMatchedPositions: [], score: 0, scoreBand: "Low", riskStatus: "Lower",
  riskTarget: 15, riskCutoff: 7, riskCalibration: { auc: 0.78, precision: 0.48, recall: 0.73, sampleSize: 284 },
  features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: "English" },
  corpusVersion: "archive-v5-321-48e64e70ec", sources: [], repeats: [],
};

let fetchCalls = [];
let workerCtorCalls = [];
const realFetch = globalThis.fetch;
const realWorker = globalThis.Worker;

class FakeWorker {
  constructor(url, opts) {
    workerCtorCalls.push({ url: String(url), opts });
    this._listeners = [];
  }
  addEventListener(type, fn) { if (type === "message") this._listeners.push(fn); }
  removeEventListener(type, fn) { this._listeners = this._listeners.filter((l) => l !== fn); }
  postMessage(msg) {
    queueMicrotask(() => {
      for (const l of this._listeners) l({ data: { id: msg.id, ok: true, result: { ...FROZEN_RESULT, __echoedText: msg.text, __fileName: msg.fileName } } });
    });
  }
  terminate() {}
}

function installFetch(handler) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init && init.method) || "GET";
    fetchCalls.push({ url, method, body: init && init.body });
    return handler({ url, method, init });
  };
}
function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function nonJsonResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => { throw new SyntaxError("Unexpected token < in JSON"); }, text: async () => "<html>not json</html>" };
}

test.beforeEach(() => {
  fetchCalls = [];
  workerCtorCalls = [];
  globalThis.Worker = FakeWorker;
  __resetArchiveEngineForTests();
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.Worker = realWorker;
  __resetArchiveEngineForTests();
});

// ── preserved behaviour ────────────────────────────────────────────────────

test("explicit archiveServerSide:false => engine \"browser\"", async () => {
  installFetch(({ method }) => (method === "GET" ? jsonResponse({ archiveServerSide: false }) : jsonResponse({}, 500)));
  assert.equal(await resolveArchiveEngine(), "browser");
});

test("explicit archiveServerSide:true => engine \"server\"", async () => {
  installFetch(() => jsonResponse({ archiveServerSide: true }));
  assert.equal(await resolveArchiveEngine(), "server");
});

test("explicit false => the similarity worker IS spawned and returns its result", async () => {
  installFetch(({ method }) => (method === "GET" ? jsonResponse({ archiveServerSide: false }) : jsonResponse({}, 500)));
  const labels = [];
  const out = await analyzeArchive("some submission text", "paper.pdf", (_p, l) => labels.push(l));
  assert.equal(workerCtorCalls.length, 1);
  assert.match(workerCtorCalls[0].url, /app[\\/]similarity-worker\.ts$/);
  assert.deepEqual(workerCtorCalls[0].opts, { type: "module" });
  assert.equal(out.__echoedText, "some submission text");
  assert.equal(out.__fileName, "paper.pdf");
  assert.equal(fetchCalls.some((c) => c.method === "POST"), false, "no server POST on the browser path");
});

test("explicit true => the browser worker is NEVER spawned; result comes from POST /api/archive/match", async () => {
  installFetch(({ url, method }) => {
    if (method === "GET") return jsonResponse({ archiveServerSide: true });
    if (method === "POST" && url === "/api/archive/match") return jsonResponse({ result: FROZEN_RESULT });
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  const out = await analyzeArchive("submission", "doc.txt", () => {});
  assert.deepEqual(out, FROZEN_RESULT);
  assert.equal(workerCtorCalls.length, 0);
});

// ── fail-closed correction: ambiguous discovery THROWS, worker never spawned ─

test("GET network failure => resolveArchiveEngine THROWS, worker never spawned", async () => {
  installFetch(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(() => resolveArchiveEngine(), /could not be determined — the configuration request failed/);
  await assert.rejects(() => analyzeArchive("submission", "doc.txt", () => {}), /could not be determined/);
  assert.equal(workerCtorCalls.length, 0, "a failed config request must never fall back to the worker");
});

test("GET non-2xx => resolveArchiveEngine THROWS, worker never spawned", async () => {
  installFetch(() => jsonResponse({ error: "boom" }, 503));
  await assert.rejects(() => resolveArchiveEngine(), /could not be determined — the configuration request returned 503/);
  await assert.rejects(() => analyzeArchive("submission", "doc.txt", () => {}));
  assert.equal(workerCtorCalls.length, 0);
});

test("GET returns non-JSON => resolveArchiveEngine THROWS, worker never spawned", async () => {
  installFetch(() => nonJsonResponse(200));
  await assert.rejects(() => resolveArchiveEngine(), /could not be determined — the configuration response was not valid JSON/);
  await assert.rejects(() => analyzeArchive("submission", "doc.txt", () => {}));
  assert.equal(workerCtorCalls.length, 0);
});

test("GET response missing archiveServerSide => resolveArchiveEngine THROWS, worker never spawned", async () => {
  installFetch(() => jsonResponse({}));
  await assert.rejects(() => resolveArchiveEngine(), /could not be determined — the configuration response had no archiveServerSide flag/);
  await assert.rejects(() => analyzeArchive("submission", "doc.txt", () => {}));
  assert.equal(workerCtorCalls.length, 0);
});

test("GET response with a non-boolean archiveServerSide => resolveArchiveEngine THROWS", async () => {
  for (const bad of ["true", 1, 0, null, "false", {}]) {
    __resetArchiveEngineForTests();
    installFetch(() => jsonResponse({ archiveServerSide: bad }));
    await assert.rejects(() => resolveArchiveEngine(), /had no archiveServerSide flag/, `value ${JSON.stringify(bad)}`);
  }
  assert.equal(workerCtorCalls.length, 0);
});

test("a failed discovery is NOT memoised — the next call re-attempts", async () => {
  let call = 0;
  installFetch(({ method }) => {
    if (method !== "GET") return jsonResponse({ result: FROZEN_RESULT });
    call += 1;
    return call === 1 ? jsonResponse({}, 500) : jsonResponse({ archiveServerSide: true });
  });
  await assert.rejects(() => resolveArchiveEngine());
  assert.equal(await resolveArchiveEngine(), "server", "recovers on the next attempt");
  assert.equal(call, 2);
});

// ── server-mode POST failure: reject, no browser fallback ──────────────────

test("server POST failure => analyzeArchive REJECTS, worker never spawned", async () => {
  installFetch(({ method }) => (method === "GET" ? jsonResponse({ archiveServerSide: true }) : jsonResponse({ error: "matcher exploded" }, 500)));
  await assert.rejects(() => analyzeArchive("submission", "doc.txt", () => {}), /archive comparison service returned 500/);
  assert.equal(workerCtorCalls.length, 0, "must NOT fall back to the worker");
});

test("server POST malformed response => analyzeArchive REJECTS, worker never spawned", async () => {
  installFetch(({ method }) => (method === "GET" ? jsonResponse({ archiveServerSide: true }) : jsonResponse({ nope: 1 })));
  await assert.rejects(() => analyzeArchive("submission", "doc.txt", () => {}), /unexpected response/);
  assert.equal(workerCtorCalls.length, 0);
});

// ── Phase 9: server mode loads no packed archive ──────────────────────────

test("Phase 9: server engine fetches NO packed-archive asset (.bin / meta / risk-calibration / /data/)", async () => {
  installFetch(({ url, method }) => {
    if (method === "GET" && url === "/api/archive/match") return jsonResponse({ archiveServerSide: true });
    if (method === "POST" && url === "/api/archive/match") return jsonResponse({ result: FROZEN_RESULT });
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  await analyzeArchive("submission", "doc.txt", () => {});
  for (const c of fetchCalls) {
    assert.doesNotMatch(c.url, /\.bin(\?|$)/, c.url);
    assert.doesNotMatch(c.url, /document-index\.meta\.json/, c.url);
    assert.doesNotMatch(c.url, /risk-calibration\.json/, c.url);
    assert.doesNotMatch(c.url, /^\/data\//, c.url);
  }
  assert.deepEqual(fetchCalls.map((c) => `${c.method} ${c.url}`), ["GET /api/archive/match", "POST /api/archive/match"]);
  assert.equal(JSON.parse(fetchCalls[1].body).text, "submission");
});

test("a successful resolution is memoised — GET /api/archive/match runs once per page load", async () => {
  let getCount = 0;
  installFetch(({ method }) => {
    if (method === "GET") { getCount += 1; return jsonResponse({ archiveServerSide: true }); }
    return jsonResponse({ result: FROZEN_RESULT });
  });
  await analyzeArchive("a", "a.txt", () => {});
  await analyzeArchive("b", "b.txt", () => {});
  assert.equal(getCount, 1);
});

// ── slice 2G: the lazy browser-runtime module boundary ────────────────────
//
// archive-analysis-runtime.ts must contain NO `new Worker(...)` and NO
// `similarity-worker.ts` reference; the legacy engine is
// lib/archive-browser-runtime.ts, imported on demand ONLY on the explicit
// archiveServerSide:false path. `browserRuntimeRequested` flips true the
// moment that dynamic import is kicked off.

test("2G source: archive-analysis-runtime.ts has no static Worker / similarity-worker.ts reference", async () => {
  const src = await fs.readFile(new URL("../lib/archive-analysis-runtime.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""); // strip comments — prose may mention the file
  assert.doesNotMatch(code, /new\s+Worker\s*\(/, "no `new Worker(` in the runtime module");
  assert.doesNotMatch(code, /similarity-worker/, "no similarity-worker.ts reference in the runtime module code");
  assert.match(code, /import\(\s*["']\.\/archive-browser-runtime["']\s*\)/, "reaches the browser engine via a lazy import");
});

test("2G source: lib/archive-browser-runtime.ts is the ONLY runtime holder of the similarity-worker.ts URL", async () => {
  const browser = await fs.readFile(new URL("../lib/archive-browser-runtime.ts", import.meta.url), "utf8");
  const browserCode = browser.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  assert.match(browserCode, /new URL\(\s*["']\.\.\/app\/similarity-worker\.ts["']/, "browser runtime owns the worker URL");
  assert.match(browserCode, /new\s+Worker\s*\(/, "browser runtime owns Worker construction");
  assert.match(browser, /createBrowserArchiveRunner/, "exposes createBrowserArchiveRunner()");
});

test("2G #1: explicit-false engine resolution ALONE does not request the legacy browser runtime", async () => {
  installFetch(({ method }) => (method === "GET" ? jsonResponse({ archiveServerSide: false }) : jsonResponse({}, 500)));
  assert.equal(await resolveArchiveEngine(), "browser");
  assert.equal(__getArchiveRuntimeTestState().browserRuntimeRequested, false, "not requested until analyzeArchive runs it");
  assert.equal(workerCtorCalls.length, 0, "no Worker constructed by resolution alone");
});

test("2G #2: analyzeArchive with explicit false DOES request the browser runtime and constructs the Worker", async () => {
  installFetch(({ method }) => (method === "GET" ? jsonResponse({ archiveServerSide: false }) : jsonResponse({}, 500)));
  const out = await analyzeArchive("submission text", "paper.pdf", () => {});
  assert.equal(__getArchiveRuntimeTestState().browserRuntimeRequested, true);
  assert.equal(workerCtorCalls.length, 1);
  assert.match(workerCtorCalls[0].url, /app[\\/]similarity-worker\.ts$/);
  assert.deepEqual(workerCtorCalls[0].opts, { type: "module" });
  assert.equal(out.__echoedText, "submission text");
});

test("2G #3: explicit true never requests the legacy browser runtime", async () => {
  installFetch(({ url, method }) => {
    if (method === "GET") return jsonResponse({ archiveServerSide: true });
    if (method === "POST" && url === "/api/archive/match") return jsonResponse({ result: FROZEN_RESULT });
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  await analyzeArchive("submission", "doc.txt", () => {});
  assert.equal(__getArchiveRuntimeTestState().browserRuntimeRequested, false);
  assert.equal(workerCtorCalls.length, 0);
});

test("2G #4: GET network failure never requests the legacy browser runtime", async () => {
  installFetch(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(() => analyzeArchive("submission", "doc.txt", () => {}), /could not be determined/);
  assert.equal(__getArchiveRuntimeTestState().browserRuntimeRequested, false);
  assert.equal(workerCtorCalls.length, 0);
});

test("2G #5: every ambiguous discovery (non-2xx / non-JSON / missing / non-boolean flag) never reaches the legacy runtime", async () => {
  const ambiguous = [
    () => jsonResponse({ error: "boom" }, 503),
    () => nonJsonResponse(200),
    () => jsonResponse({}),
    () => jsonResponse({ archiveServerSide: "true" }),
    () => jsonResponse({ archiveServerSide: 1 }),
    () => jsonResponse({ archiveServerSide: null }),
  ];
  for (const handler of ambiguous) {
    __resetArchiveEngineForTests();
    fetchCalls = [];
    workerCtorCalls = [];
    installFetch(({ method }) => (method === "GET" ? handler() : jsonResponse({ result: FROZEN_RESULT })));
    await assert.rejects(() => analyzeArchive("submission", "doc.txt", () => {}));
    assert.equal(__getArchiveRuntimeTestState().browserRuntimeRequested, false, "ambiguous discovery must not import the browser runtime");
    assert.equal(workerCtorCalls.length, 0);
  }
});

test("2G #6: server POST failure never requests the legacy browser runtime and never falls back", async () => {
  installFetch(({ method }) => (method === "GET" ? jsonResponse({ archiveServerSide: true }) : jsonResponse({ error: "matcher exploded" }, 500)));
  await assert.rejects(() => analyzeArchive("submission", "doc.txt", () => {}), /archive comparison service returned 500/);
  assert.equal(__getArchiveRuntimeTestState().browserRuntimeRequested, false, "no browser fallback after a server-mode failure");
  assert.equal(workerCtorCalls.length, 0);
});

test("2G #7: server mode fetches ONLY GET + POST /api/archive/match — no .bin / meta / risk / data asset, no browser runtime", async () => {
  installFetch(({ url, method }) => {
    if (method === "GET" && url === "/api/archive/match") return jsonResponse({ archiveServerSide: true });
    if (method === "POST" && url === "/api/archive/match") return jsonResponse({ result: FROZEN_RESULT });
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  await analyzeArchive("submission", "doc.txt", () => {});
  for (const c of fetchCalls) {
    assert.doesNotMatch(c.url, /\.bin(\?|$)/, c.url);
    assert.doesNotMatch(c.url, /document-index\.meta\.json/, c.url);
    assert.doesNotMatch(c.url, /risk-calibration\.json/, c.url);
    assert.doesNotMatch(c.url, /^\/data\//, c.url);
  }
  assert.deepEqual(fetchCalls.map((c) => `${c.method} ${c.url}`), ["GET /api/archive/match", "POST /api/archive/match"]);
  assert.equal(__getArchiveRuntimeTestState().browserRuntimeRequested, false);
  assert.equal(workerCtorCalls.length, 0);
});
