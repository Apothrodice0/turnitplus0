import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Archive engine-discovery hardening — GET /api/archive/match is now a pure,
 * DB-independent read of ARCHIVE_SERVER_SIDE_ENABLED.
 *
 * Before: GET ran checkReadRate(clientIpFrom(request)) first, which goes
 * through lib/rate-limit.ts -> getRateLimitDbClient() -> getReportsDbClient()
 * and executes SQL against Turso. With ARCHIVE_SERVER_SIDE_ENABLED off (the
 * default) that gave the browser-engine path a server/DB failure dependency
 * it has no need for: any DB hiccup made the GET return 500, which the client
 * (lib/archive-analysis-runtime.ts) treats as AMBIGUOUS and THROWS on —
 * archive analysis fails instead of simply resolving to the browser worker.
 *
 * After: GET reads process.env only. No DB client, no rate-limit bucket, no
 * DB dependency of any kind. Fail-closed client semantics are UNCHANGED
 * (a genuine network error / non-2xx / malformed body still throws, never a
 * silent browser fallback), and POST is UNCHANGED (still rate-limited via
 * checkRate + still runs the DB matcher via getReportsDbClient()).
 *
 * This file must NOT set ARCHIVE_SERVER_SIDE_ENABLED persistently; each test
 * restores it. It deletes TURSO_DATABASE_URL / points it at an unreachable
 * remote with no auth token to prove GET never reaches a DB.
 */

const repoRoot = path.resolve(".");
const routeSrcPath = path.join(repoRoot, "app/api/archive/match/route.ts");
const routeSrc = fs.readFileSync(routeSrcPath, "utf8");

// GET spans from its declaration to POST's declaration; POST is the rest.
const getStart = routeSrc.indexOf("export async function GET");
const postStart = routeSrc.indexOf("export async function POST");
assert.ok(getStart > 0 && postStart > getStart, "route.ts must declare GET then POST");
const getBody = routeSrc.slice(getStart, postStart);
const postBody = routeSrc.slice(postStart);
// Strip comments so prose mentioning "rate-limit" / "DB" doesn't trip the scans.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const getCode = stripComments(getBody);
const postCode = stripComments(postBody);

// ── 4. GET implementation has no DB / rate-limit dependency ────────────────

test("route.ts no longer imports or references the read-rate helper it used before", () => {
  assert.doesNotMatch(routeSrc, /checkReadRate/, "checkReadRate must be gone from the module entirely");
  assert.match(routeSrc, /import \{ checkRate \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/rate-limit"/,
    "only checkRate (POST's limiter) should remain imported from lib/rate-limit");
});

test("the GET handler body touches no rate-limit / DB / IP machinery", () => {
  for (const forbidden of [
    "checkReadRate", "checkRate", "checkBucket", "clientIpFrom",
    "getReportsDbClient", "getRateLimitDbClient", "createClient",
    "rate_limit_buckets", "TURSO_", "await request", "request.",
  ]) {
    assert.equal(getCode.includes(forbidden), false, `GET must not reference "${forbidden}"`);
  }
  assert.match(getCode, /isArchiveServerSideEnabled\(\)/, "GET returns the pure flag read");
  assert.doesNotMatch(getCode, /\btry\b/, "GET has no failure path, so no try/catch that could mask one / downgrade to false");
  assert.doesNotMatch(getCode, /archiveServerSide:\s*false/, "GET must never hard-code a false fallback");
});

test("the POST handler is untouched — still rate-limited and still DB-backed", () => {
  assert.match(postCode, /checkRate\(clientIpFrom\(request\)\)/, "POST still rate-limits by client IP");
  assert.match(postCode, /isArchiveServerSideEnabled\(\)/, "POST still 404s when the flag is off");
  assert.match(postCode, /getReportsDbClient\(\)/, "POST still opens the reports DB client");
  assert.match(postCode, /analyzeArchiveOnServer\(client, text\)/, "POST still runs the server matcher");
  assert.match(postCode, /client\.close\(\)/, "POST still closes its DB client");
  assert.match(postCode, /status: 413/, "POST still enforces the size ceiling");
});

// ── behavioural: GET resolves with the DB unreachable ─────────────────────

test("GET returns 200 + the flag even when any DB access would throw", async () => {
  // A remote-looking URL with no auth token: getReportsDbClient() throws
  // synchronously ("TURSO_AUTH_TOKEN is required ..."), so the OLD GET —
  // which reached it via checkReadRate — would have returned 500 here.
  const savedUrl = process.env.TURSO_DATABASE_URL;
  const savedToken = process.env.TURSO_AUTH_TOKEN;
  const savedRlOverride = process.env.RATE_LIMIT_TEST_DB_URL;
  const savedFlag = process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  process.env.TURSO_DATABASE_URL = "libsql://archive-get-hardening-probe.invalid";
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.RATE_LIMIT_TEST_DB_URL;
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  try {
    const route = await import("../app/api/archive/match/route.ts");

    // 2. absent => false
    let res = await route.GET();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { archiveServerSide: false });

    // 3. non-exact values => false
    for (const v of ["TRUE", "1", "yes", "false", "True", " true", "true "]) {
      process.env.ARCHIVE_SERVER_SIDE_ENABLED = v;
      res = await route.GET();
      assert.equal(res.status, 200, `value ${JSON.stringify(v)}`);
      assert.equal((await res.json()).archiveServerSide, false, `value ${JSON.stringify(v)} => false`);
    }

    // 1. exact "true" => true
    process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
    res = await route.GET();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { archiveServerSide: true });

    // GET never rate-limits — hammer it well past any bucket ceiling.
    delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
    for (let i = 0; i < 200; i++) {
      const r = await route.GET();
      assert.equal(r.status, 200, `call ${i} must not 429/500`);
    }
  } finally {
    if (savedUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = savedUrl;
    if (savedToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = savedToken;
    if (savedRlOverride === undefined) delete process.env.RATE_LIMIT_TEST_DB_URL; else process.env.RATE_LIMIT_TEST_DB_URL = savedRlOverride;
    if (savedFlag === undefined) delete process.env.ARCHIVE_SERVER_SIDE_ENABLED; else process.env.ARCHIVE_SERVER_SIDE_ENABLED = savedFlag;
  }
});

// ── 5/6/7. the client's fail-closed discovery contract is unchanged ───────
// (comprehensively covered by tests/archive-server-flag-wiring.test.mjs;
// re-checked here at the resolveArchiveEngine() level alongside the GET change)

const realFetch = globalThis.fetch;
function mockGet(handler) {
  globalThis.fetch = async (input, init) => {
    const method = (init && init.method) || "GET";
    assert.equal(method, "GET", "engine discovery only ever issues a GET");
    return handler();
  };
}
function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}
function nonJsonResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => { throw new SyntaxError("bad json"); } };
}

test("client discovery: valid false selects the browser runtime, valid true selects the server runtime", async () => {
  const { resolveArchiveEngine, __resetArchiveEngineForTests } = await import("../lib/archive-analysis-runtime.ts");
  try {
    __resetArchiveEngineForTests();
    mockGet(() => jsonResponse({ archiveServerSide: false }));
    assert.equal(await resolveArchiveEngine(), "browser");

    __resetArchiveEngineForTests();
    mockGet(() => jsonResponse({ archiveServerSide: true }));
    assert.equal(await resolveArchiveEngine(), "server");
  } finally {
    globalThis.fetch = realFetch;
    __resetArchiveEngineForTests();
  }
});

test("client discovery still THROWS (fail closed) on every ambiguous GET outcome — no silent browser fallback", async () => {
  const { resolveArchiveEngine, __resetArchiveEngineForTests } = await import("../lib/archive-analysis-runtime.ts");
  const ambiguous = [
    ["network failure", () => { throw new TypeError("Failed to fetch"); }],
    ["non-2xx", () => jsonResponse({ error: "boom" }, 503)],
    ["malformed JSON", () => nonJsonResponse(200)],
    ["missing archiveServerSide", () => jsonResponse({})],
    ["non-boolean archiveServerSide", () => jsonResponse({ archiveServerSide: "true" })],
  ];
  try {
    for (const [label, handler] of ambiguous) {
      __resetArchiveEngineForTests();
      mockGet(handler);
      await assert.rejects(() => resolveArchiveEngine(), /could not be determined/, label);
    }
  } finally {
    globalThis.fetch = realFetch;
    __resetArchiveEngineForTests();
  }
});
