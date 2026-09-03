import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { createSession } from "../lib/auth-session.ts";
import { resetRateForTest } from "../lib/rate-limit.js";
import { isE8sReuseContextAllowlisted } from "../lib/e8s-visibility.ts";
import { declareReuseContext } from "../lib/reuse-context-declarations.ts";
import * as statusRoute from "../app/api/reuse-context/status/route.ts";
import * as pendingRoute from "../app/api/reuse-context/pending/route.ts";
import * as declareRoute from "../app/api/reuse-context/declare/route.ts";
import * as confirmRoute from "../app/api/reuse-context/confirm/route.ts";
import * as rejectRoute from "../app/api/reuse-context/reject/route.ts";
import * as revokeRoute from "../app/api/reuse-context/revoke/route.ts";

/**
 * Phase E8S Step 6.1: tests for the default-off E8S_REUSE_CONTEXT_ALLOWLIST
 * gate (lib/e8s-visibility.ts) in front of all six reuse-context routes.
 * Disposable local SQLite only; no production connection. Deliberately a
 * SEPARATE file from tests/reuse-context-routes.test.mjs, whose own purpose
 * is the feature's functional behavior (declare/confirm/reject/revoke),
 * not the gate itself -- that file auto-allowlists every account it
 * creates specifically so the gate never interferes with those tests.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_e8s_visibility.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

let userCounter = 0;
async function createAccount(prefix) {
  userCounter += 1;
  const id = `${prefix}-${userCounter}`;
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [id, `${id}@example.test`, id, "not-a-real-hash"],
  });
  const token = await createSession(client, id);
  return { id, token };
}

async function indexSubmission(accountId, title, rawText) {
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  const indexResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return { identity, indexResult };
}

let ipCounter = 0;
function nextIp(label) {
  ipCounter += 1;
  return `vis-${label}-${ipCounter}`;
}

async function callGet(routeModule, url, token) {
  const ip = nextIp("get");
  await resetRateForTest(ip);
  const headers = { "x-forwarded-for": ip };
  if (token) headers["cookie"] = `tp_session_v1=${token}`;
  const req = new Request(url, { headers });
  return routeModule.GET(req);
}

// E8S Step 6.2: the four POST routes now enforce isSameOriginRequest
// (lib/same-origin.ts). A real browser always sends Origin on an unsafe
// method, so every non-CSRF call here sends a matching same-origin
// Origin/Host by default — mirroring tests/corpus-admission-admin-routes.mjs's
// SAME_ORIGIN convention. `origin: null` / `host: null` omit the header, for
// the dedicated CSRF cases.
async function callPost(routeModule, url, token, body, { origin = "http://localhost", host = "localhost" } = {}) {
  const ip = nextIp("post");
  await resetRateForTest(ip);
  const headers = { "content-type": "application/json", "x-forwarded-for": ip };
  if (token) headers["cookie"] = `tp_session_v1=${token}`;
  if (origin !== null) headers["origin"] = origin;
  if (host !== null) headers["host"] = host;
  const req = new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
  return routeModule.POST(req);
}

function statusUrl(documentIdentityId, representationId) {
  return `http://localhost/api/reuse-context/status?documentIdentityId=${encodeURIComponent(documentIdentityId)}&representationId=${encodeURIComponent(representationId)}`;
}
function pendingUrl(documentIdentityId) {
  return `http://localhost/api/reuse-context/pending?documentIdentityId=${encodeURIComponent(documentIdentityId)}`;
}

async function pairFixture(marker) {
  const text = `Fixture body for E8S visibility gate tests, marker ${marker}, long enough to canonicalize deterministically.`;
  const original = await createAccount(`${marker}-orig`);
  const reuser = await createAccount(`${marker}-reuse`);
  const { identity: identity1, indexResult: ref1 } = await indexSubmission(original.id, "doc", text);
  const { identity: identity2 } = await indexSubmission(reuser.id, "doc", text);
  return { original, reuser, identity1, identity2, ref1 };
}

// --- unset / empty --------------------------------------------------------

test("unset: E8S_REUSE_CONTEXT_ALLOWLIST unset fails closed for every route, even a valid owner/session", async () => {
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  const { reuser, identity2, ref1 } = await pairFixture("unset");

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "Not found.");
});

test("empty: E8S_REUSE_CONTEXT_ALLOWLIST='' fails closed identically to unset", async () => {
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = "";
  const { reuser, identity2, ref1 } = await pairFixture("empty");

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token);
  assert.equal(res.status, 404);
});

test("empty: whitespace-only value also fails closed", async () => {
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = "   ";
  const { reuser, identity2, ref1 } = await pairFixture("wsonly");

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token);
  assert.equal(res.status, 404);
});

// --- exact allowed account / wrong account --------------------------------

test("exact allowed account: an allowlisted session passes the gate and reaches normal route behavior", async () => {
  const { reuser, identity2, ref1 } = await pairFixture("allow");
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = reuser.id;

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.affordance, { canDeclare: true });
});

test("wrong account: a valid session for an account NOT on the list still gets 404", async () => {
  const { reuser, identity2, ref1 } = await pairFixture("wrong");
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = "some-completely-different-account-id";

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token);
  assert.equal(res.status, 404);
});

test("exact Set membership only: a prefix/substring match must not pass the gate", async () => {
  const { reuser, identity2, ref1 } = await pairFixture("prefix");
  // Allowlist a string that is a strict superset/substring relative to reuser.id -- must not match.
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = `${reuser.id}-extra,x${reuser.id}`;

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token);
  assert.equal(res.status, 404);
});

// --- malformed entries / whitespace ----------------------------------------

test("malformed entries: empty segments between commas are ignored, not treated as a wildcard", async () => {
  const { reuser, identity2, ref1 } = await pairFixture("malformed");
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = ",,,";

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token);
  assert.equal(res.status, 404);
  // An empty accountId must never accidentally satisfy an empty allowlist entry.
  assert.equal(isE8sReuseContextAllowlisted(""), false);
  assert.equal(isE8sReuseContextAllowlisted(null), false);
});

test("whitespace: leading/trailing whitespace around a valid id is trimmed and still matches", async () => {
  const { reuser, identity2, ref1 } = await pairFixture("whitespace");
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = `  ${reuser.id}  ,   another-account-id  `;

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token);
  assert.equal(res.status, 200);
});

test("read fresh from process.env on every check: no module-level caching", async () => {
  const { reuser, identity2, ref1 } = await pairFixture("fresh");
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  assert.equal((await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token)).status, 404);

  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = reuser.id;
  assert.equal((await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token)).status, 200, "the change must take effect on the very next call, with no caching or restart needed");

  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  assert.equal((await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token)).status, 404, "clearing it again must immediately re-close the gate");
});

// --- all six routes ----------------------------------------------------------

test("all six routes: every route is gated identically for a non-allowlisted session", async () => {
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  const { original, reuser, identity1, identity2, ref1 } = await pairFixture("sixroutes");

  assert.equal((await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token)).status, 404);
  assert.equal((await callGet(pendingRoute, pendingUrl(identity1.id), original.token)).status, 404);
  assert.equal((await callPost(declareRoute, "http://localhost/api/reuse-context/declare", reuser.token, {
    documentIdentityId: identity2.id, representationId: ref1.representationId, declaredContext: "SUPERVISOR_COPY",
  })).status, 404);
  // declarationId=1 is arbitrary/possibly-nonexistent -- the gate must reject before any lookup happens either way.
  assert.equal((await callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { declarationId: 1 })).status, 404);
  assert.equal((await callPost(rejectRoute, "http://localhost/api/reuse-context/reject", original.token, { declarationId: 1 })).status, 404);
  assert.equal((await callPost(revokeRoute, "http://localhost/api/reuse-context/revoke", reuser.token, { declarationId: 1 })).status, 404);
});

test("all six routes: every route works normally once both parties are allowlisted", async () => {
  const { original, reuser, identity1, identity2, ref1 } = await pairFixture("sixroutes-ok");
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = `${original.id},${reuser.id}`;

  const declareRes = await callPost(declareRoute, "http://localhost/api/reuse-context/declare", reuser.token, {
    documentIdentityId: identity2.id, representationId: ref1.representationId, declaredContext: "SUPERVISOR_COPY",
  });
  assert.equal(declareRes.status, 200);
  const declarationId = (await declareRes.json()).declaration.id;

  assert.equal((await callGet(pendingRoute, pendingUrl(identity1.id), original.token)).status, 200);
  assert.equal((await callPost(confirmRoute, "http://localhost/api/reuse-context/confirm", original.token, { declarationId })).status, 200);
  assert.equal((await callPost(revokeRoute, "http://localhost/api/reuse-context/revoke", reuser.token, { declarationId })).status, 200);
});

// --- session auth preserved (allowlist is additive, not a replacement) -----

test("session authorization is preserved: allowlisted but unauthenticated still gets 401, not 404, and never reaches the gate check", async () => {
  const { reuser, identity2, ref1 } = await pairFixture("preserved");
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = reuser.id;

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), undefined);
  assert.equal(res.status, 401, "no session at all must still fail with 401 -- the allowlist never substitutes for authentication");
});

test("allowlisted but not the owner still gets rejected by the existing ownership check (403), not silently allowed through", async () => {
  const { identity2, ref1 } = await pairFixture("ownership");
  const stranger = await createAccount("ownership-stranger");
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = stranger.id; // allowlisted, but does not own identity2

  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), stranger.token);
  assert.equal(res.status, 403, "being on the allowlist must never bypass the existing per-pair ownership check");
});

// --- no leakage --------------------------------------------------------------

test("no leakage: a non-allowlisted caller gets the identical response whether or not a declaration/pair actually exists", async () => {
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;

  // Scenario 1: a real pair with an active declaration -- allowlist the
  // declarer just long enough to create it, then remove them again.
  const withDeclaration = await pairFixture("leak-with");
  process.env.E8S_REUSE_CONTEXT_ALLOWLIST = withDeclaration.reuser.id;
  const declared = await declareReuseContext(client, {
    documentIdentityId: withDeclaration.identity2.id,
    representationId: withDeclaration.ref1.representationId,
    declaredByAccountId: withDeclaration.reuser.id,
    declaredContext: "COAUTHOR_COPY",
  });
  assert.equal(declared.status, "DECLARED");
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;

  // Scenario 2: a real pair with nothing declared.
  const withoutDeclaration = await pairFixture("leak-without");

  const res1 = await callGet(statusRoute, statusUrl(withDeclaration.identity2.id, withDeclaration.ref1.representationId), withDeclaration.reuser.token);
  const res2 = await callGet(statusRoute, statusUrl(withoutDeclaration.identity2.id, withoutDeclaration.ref1.representationId), withoutDeclaration.reuser.token);

  assert.equal(res1.status, res2.status);
  assert.equal(res1.status, 404);
  const body1 = await res1.json();
  const body2 = await res2.json();
  assert.deepEqual(body1, body2, "the response body must not differ based on whether a declaration exists -- no oracle for 'does this pair have a declaration'");
});

test("no leakage: the not-allowlisted response never contains an account id, email, or declaration field", async () => {
  delete process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  const { reuser, identity2, ref1 } = await pairFixture("leak-shape");
  const res = await callGet(statusRoute, statusUrl(identity2.id, ref1.representationId), reuser.token);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.doesNotMatch(JSON.stringify(body), /@|affordance|activeDeclaration|declaration/i);
});

// --- score independence -------------------------------------------------------

test("score independence (structural): lib/e8s-visibility.ts never references score/archiveScore/aiScore/verifiedSimilarity", () => {
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  const source = stripComments(fs.readFileSync(path.join(repoRoot, "lib/e8s-visibility.ts"), "utf8"));
  assert.doesNotMatch(source, /archiveScore|aiScore|verifiedSimilarity|\.score\b|\bscore\s*[:=]/i);
});

test("score independence (structural): the gate value itself is never printed anywhere in lib/e8s-visibility.ts", () => {
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  const source = stripComments(fs.readFileSync(path.join(repoRoot, "lib/e8s-visibility.ts"), "utf8"));
  assert.doesNotMatch(source, /console\.(log|error|warn|debug)/, "the allowlist/account ids must never be logged");
});
