import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createSession } from "../lib/auth-session.ts";
import { resetRateForTest } from "../lib/rate-limit.js";
import * as declareRoute from "../app/api/reuse-context/declare/route.ts";
import * as withdrawRoute from "../app/api/reuse-context/withdraw/route.ts";
import * as revokeRoute from "../app/api/reuse-context/revoke/route.ts";
import * as confirmRoute from "../app/api/reuse-context/confirm/route.ts";
import * as rejectRoute from "../app/api/reuse-context/reject/route.ts";

/**
 * Pins the reviewed security-checkpoint order for every reuse-context POST:
 *
 *   rate -> same-origin (generic hidden 404) -> JSON parse + body validation
 *        -> session + raw cookie (401) -> allowlist (hidden 404)
 *        -> session key -> business
 *
 * Body validation must not require DB or session work; a foreign/missing
 * Origin must be rejected before the body is even read.
 */

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_reuse_context_mutation_order.db");
for (const s of ["", "-wal", "-shm"]) { const c = `${dbFile}${s}`; if (fs.existsSync(c)) fs.unlinkSync(c); }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.E8S_REUSE_CONTEXT_ALLOWLIST = "";

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  for (const s of ["", "-wal", "-shm"]) { const c = `${dbFile}${s}`; try { fs.unlinkSync(c); } catch { /* ignore */ } }
});

let n = 0;
async function account({ allowlist = true } = {}) {
  n += 1;
  const id = `mo-${n}`;
  await client.execute({ sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [id, `${id}@o.test`, id, "h"] });
  const token = await createSession(client, id);
  if (allowlist) {
    const cur = process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
    process.env.E8S_REUSE_CONTEXT_ALLOWLIST = cur ? `${cur},${id}` : id;
  }
  return { id, token };
}

let ip = 0;
async function raw(routeModule, { token, origin = "http://localhost", host = "localhost", body }) {
  ip += 1;
  const ipv = `mo-${ip}`;
  await resetRateForTest(ipv);
  const headers = { "content-type": "application/json", "x-forwarded-for": ipv };
  if (token) headers.cookie = `tp_session_v1=${token}`;
  if (origin !== null) headers.origin = origin;
  if (host !== null) headers.host = host;
  return routeModule.POST(new Request("http://localhost/api/reuse-context/x", { method: "POST", headers, body }));
}

const ROUTES = [
  ["declare", declareRoute],
  ["withdraw", withdrawRoute],
  ["revoke", revokeRoute],
  ["confirm", confirmRoute],
  ["reject", rejectRoute],
];

for (const [name, mod] of ROUTES) {
  test(`${name}: foreign Origin + malformed JSON -> generic hidden 404 BEFORE body parsing`, async () => {
    const acct = await account();
    const res = await raw(mod, { token: acct.token, origin: "http://evil.example", body: "{ this is not json" });
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(await res.json()), ["error"]);
  });

  test(`${name}: missing Origin + malformed JSON -> generic hidden 404 BEFORE body parsing`, async () => {
    const acct = await account();
    const res = await raw(mod, { token: acct.token, origin: null, body: "not json at all" });
    assert.equal(res.status, 404);
  });

  test(`${name}: same-origin + malformed JSON -> normal 400 validation path`, async () => {
    const acct = await account();
    const res = await raw(mod, { token: acct.token, body: "{ broken" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Invalid JSON/);
  });

  test(`${name}: same-origin + missing reportId + NO session -> 400 (body validation runs before session/DB)`, async () => {
    const res = await raw(mod, { token: null, body: JSON.stringify({}) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /reportId is required/);
  });

  test(`${name}: same-origin + valid-shaped body + NO session -> 401 (after body validation)`, async () => {
    const body = name === "declare"
      ? JSON.stringify({ reportId: "x", declaredContext: "SUPERVISOR_COPY" })
      : JSON.stringify({ reportId: "x", actionRef: "a".repeat(64) });
    const res = await raw(mod, { token: null, body });
    assert.equal(res.status, 401);
  });

  test(`${name}: same-origin + valid body + session but NOT allowlisted -> generic hidden 404`, async () => {
    const acct = await account({ allowlist: false });
    const body = name === "declare"
      ? JSON.stringify({ reportId: "x", declaredContext: "SUPERVISOR_COPY" })
      : JSON.stringify({ reportId: "x", actionRef: "a".repeat(64) });
    const res = await raw(mod, { token: acct.token, body });
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(await res.json()), ["error"]);
  });
}

test("declare: same-origin + invalid declaredContext + no session -> 400 (enum validated before session)", async () => {
  const res = await raw(declareRoute, { token: null, body: JSON.stringify({ reportId: "x", declaredContext: "NOT_A_CONTEXT" }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /declaredContext must be one of/);
});

for (const [name, mod] of [["withdraw", withdrawRoute], ["revoke", revokeRoute], ["confirm", confirmRoute], ["reject", rejectRoute]]) {
  test(`${name}: same-origin + malformed actionRef + no session -> 404 (actionRef validated before session, not weakened)`, async () => {
    const res = await raw(mod, { token: null, body: JSON.stringify({ reportId: "x", actionRef: "too-short" }) });
    assert.equal(res.status, 404);
  });
}

test("STRUCTURAL: every mutation route runs guardReuseContextRequest before request.json(), and resolveReuseContextSession after", () => {
  for (const [name] of ROUTES) {
    const src = fs.readFileSync(path.join(repoRoot, `app/api/reuse-context/${name}/route.ts`), "utf8");
    const gReq = src.indexOf("guardReuseContextRequest(request)");
    const parse = src.indexOf("request.json()");
    const gSess = src.indexOf("resolveReuseContextSession(request");
    assert.ok(gReq > -1 && parse > -1 && gSess > -1, `${name}: all three checkpoints present`);
    assert.ok(gReq < parse, `${name}: rate/same-origin before body parse`);
    assert.ok(parse < gSess, `${name}: body validation before session resolution`);
  }
});
