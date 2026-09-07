import assert from "node:assert/strict";
import test from "node:test";
import { LibsqlError } from "@libsql/client";
import {
  createArchiveReadRetryClient,
  classifyArchiveReadError,
  isArchiveReadShapedSql,
  ARCHIVE_READ_MAX_RETRIES_PER_READ,
  ARCHIVE_READ_SHARED_RETRY_BUDGET,
  ARCHIVE_READ_BACKOFF_MS,
} from "../lib/archive-read-retry.ts";

/**
 * Bounded transient-read-retry for the server-side archive matcher
 * (lib/archive-read-retry.ts). Deterministic: every test injects sleep (record
 * + resolve now) and random (fixed) — nothing here waits real backoff time.
 *
 * LOCKED policy exercised: 3 attempts per individual read (initial + 2
 * retries), ~250 ms then ~600 ms backoff, ONE shared budget of 6 retries per
 * matcher request. Retriable ONLY for HTTP 502/503/504 and a narrow set of
 * connection-reset / timeout transport codes; everything else propagates.
 */

// ── fakes ────────────────────────────────────────────────────────────────

const OK = (tag) => ({ rows: [{ ok: 1, tag }], columns: ["ok", "tag"], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined });

/** The shape @libsql/client hands the caller for a transient gateway blip:
 *  a SERVER_ERROR LibsqlError whose message carries the HTTP status and whose
 *  cause is hrana's HttpServerError (has a numeric .status). */
function httpError(status) {
  const cause = Object.assign(new Error(`Server returned HTTP status ${status}`), { name: "HttpServerError", status });
  return new LibsqlError(`Server returned HTTP status ${status}`, "SERVER_ERROR", undefined, undefined, cause);
}
/** A raw Node transport error (socket reset / timeout). */
function transportError(code) {
  return Object.assign(new Error(`socket failure (${code})`), { code });
}
/** undici "fetch failed" wrapping a transport cause. */
function fetchFailed(code) {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}

const SELECT = { sql: "SELECT total FROM archive_document_representations WHERE fingerprint_version = ?", args: ["v1"] };

/** A base client driven by a script: each entry is an Error (throw) or a value
 *  (resolve). Records every SQL it was asked to run. */
function scriptedBase(script) {
  let i = 0;
  const calls = [];
  return {
    calls,
    execute: async (stmt) => {
      const n = i;
      i += 1;
      calls.push(typeof stmt === "string" ? stmt : stmt.sql);
      const step = script[n];
      if (step instanceof Error) throw step;
      return step ?? OK(`call-${n}`);
    },
  };
}

const NO_WAIT = { sleep: async () => {}, random: () => 0.5 };
function recorder() {
  const sleeps = [];
  return { sleeps, hooks: { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 } };
}

// ── 1..4: attempt counting + backoff ─────────────────────────────────────

test("1. success on first attempt — 1 execution, budget untouched, no sleep", async () => {
  const base = scriptedBase([OK("a")]);
  const { sleeps, hooks } = recorder();
  const { client, state } = createArchiveReadRetryClient(base, hooks);
  const rs = await client.execute(SELECT);
  assert.ok(rs.rows);
  assert.equal(state.executions, 1);
  assert.equal(state.retriesConsumed, 0);
  assert.equal(state.retriesRemaining, ARCHIVE_READ_SHARED_RETRY_BUDGET);
  assert.deepEqual(sleeps, []);
});

test("2. 502 then success — 2 executions, 1 retry consumed, first backoff requested", async () => {
  const base = scriptedBase([httpError(502), OK("b")]);
  const { sleeps, hooks } = recorder();
  const { client, state } = createArchiveReadRetryClient(base, hooks);
  await client.execute(SELECT);
  assert.equal(state.executions, 2);
  assert.equal(state.retriesConsumed, 1);
  assert.equal(state.retriesRemaining, ARCHIVE_READ_SHARED_RETRY_BUDGET - 1);
  assert.deepEqual(sleeps, [ARCHIVE_READ_BACKOFF_MS[0]]);
});

test("3. 502, 503, then success — 3 executions, 2 retries consumed, both backoffs requested", async () => {
  const base = scriptedBase([httpError(502), httpError(503), OK("c")]);
  const { sleeps, hooks } = recorder();
  const { client, state } = createArchiveReadRetryClient(base, hooks);
  await client.execute(SELECT);
  assert.equal(state.executions, 3);
  assert.equal(state.retriesConsumed, 2);
  assert.deepEqual(sleeps, [ARCHIVE_READ_BACKOFF_MS[0], ARCHIVE_READ_BACKOFF_MS[1]]);
});

test("4. three consecutive transient failures — exactly 3 executions, throws the final error, no 4th attempt", async () => {
  const base = scriptedBase([httpError(502), httpError(503), httpError(504), OK("would-succeed")]);
  const { sleeps, hooks } = recorder();
  const { client, state } = createArchiveReadRetryClient(base, hooks);
  await assert.rejects(() => client.execute(SELECT), /HTTP status 504/);
  assert.equal(state.executions, 3);
  assert.equal(base.calls.length, 3, "the 4th (would-succeed) step is never reached");
  assert.equal(state.retriesConsumed, ARCHIVE_READ_MAX_RETRIES_PER_READ);
  assert.deepEqual(sleeps, [ARCHIVE_READ_BACKOFF_MS[0], ARCHIVE_READ_BACKOFF_MS[1]]);
});

// ── 5..7: retriable transport classes ────────────────────────────────────

test("5. HTTP 504 is retriable", async () => {
  assert.equal(classifyArchiveReadError(httpError(504)).retriable, true);
  const base = scriptedBase([httpError(504), OK("d")]);
  const { client, state } = createArchiveReadRetryClient(base, NO_WAIT);
  await client.execute(SELECT);
  assert.equal(state.retriesConsumed, 1);
  assert.equal(state.executions, 2);
});

test("6. a network timeout is retriable (ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT, raw or fetch-wrapped)", async () => {
  for (const err of [
    transportError("ETIMEDOUT"),
    transportError("UND_ERR_CONNECT_TIMEOUT"),
    fetchFailed("UND_ERR_HEADERS_TIMEOUT"),
    fetchFailed("UND_ERR_BODY_TIMEOUT"),
  ]) {
    assert.equal(classifyArchiveReadError(err).retriable, true, String(err));
    const base = scriptedBase([err, OK()]);
    const { client, state } = createArchiveReadRetryClient(base, NO_WAIT);
    await client.execute(SELECT);
    assert.equal(state.retriesConsumed, 1);
  }
});

test("7. a connection reset is retriable (ECONNRESET, raw or fetch-wrapped)", async () => {
  for (const err of [transportError("ECONNRESET"), fetchFailed("ECONNRESET"), transportError("EPIPE")]) {
    assert.equal(classifyArchiveReadError(err).retriable, true, String(err));
    const base = scriptedBase([err, OK()]);
    const { client, state } = createArchiveReadRetryClient(base, NO_WAIT);
    await client.execute(SELECT);
    assert.equal(state.retriesConsumed, 1);
  }
});

// ── 8..10: never retried ─────────────────────────────────────────────────

test("8. SQL / schema / constraint errors are never retried", async () => {
  for (const err of [
    new LibsqlError('near "SELEC": syntax error', "SQL_INPUT_ERROR"),
    new LibsqlError("no such table: archive_document_fingerprints", "SQLITE_UNKNOWN"),
    new LibsqlError("no such column: bogus", "SQLITE_UNKNOWN"),
    new LibsqlError("UNIQUE constraint failed: x.y", "SQLITE_CONSTRAINT_PRIMARYKEY"),
  ]) {
    assert.equal(classifyArchiveReadError(err).retriable, false, err.message);
    const base = scriptedBase([err, OK("unreached")]);
    const { client, state } = createArchiveReadRetryClient(base, NO_WAIT);
    await assert.rejects(() => client.execute(SELECT));
    assert.equal(state.executions, 1);
    assert.equal(state.retriesConsumed, 0);
    assert.equal(base.calls.length, 1);
  }
});

test("9. HTTP 4xx (incl. 429) and non-transient 5xx are never retried", async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 501, 505]) {
    assert.equal(classifyArchiveReadError(httpError(status)).retriable, false, `HTTP ${status}`);
    const base = scriptedBase([httpError(status), OK("unreached")]);
    const { client, state } = createArchiveReadRetryClient(base, NO_WAIT);
    await assert.rejects(() => client.execute(SELECT), new RegExp(`HTTP status ${status}`));
    assert.equal(state.executions, 1, `HTTP ${status} -> single execution`);
    assert.equal(state.retriesConsumed, 0);
  }
});

test("10. unknown / opaque errors are never retried — incl. a bare SERVER_ERROR with no transient status", async () => {
  for (const err of [
    new Error("boom"),
    new TypeError("something weird"),
    new LibsqlError("opaque internal hiccup", "SERVER_ERROR"),
    new LibsqlError("stream closed", "HRANA_CLOSED_ERROR"),
    { message: "not even an Error instance" },
  ]) {
    assert.equal(classifyArchiveReadError(err).retriable, false, String(err && err.message));
  }
  const base = scriptedBase([new Error("boom"), OK("unreached")]);
  const { client, state } = createArchiveReadRetryClient(base, NO_WAIT);
  await assert.rejects(() => client.execute(SELECT), /boom/);
  assert.equal(state.executions, 1);
  assert.equal(state.retriesConsumed, 0);
});

// ── shared per-request budget ────────────────────────────────────────────

test("the 6-retry budget is SHARED across different queries; once exhausted the next transient failure propagates with no retry", async () => {
  // A: 2 retries -> ok ; B: 2 -> ok ; C: 2 -> ok  (budget now 0) ; D: 502 -> propagate immediately
  const script = [
    httpError(502), httpError(503), OK("A"),
    httpError(504), httpError(502), OK("B"),
    httpError(503), httpError(504), OK("C"),
    httpError(502), OK("D-would-succeed"),
  ];
  const base = scriptedBase(script);
  const { sleeps, hooks } = recorder();
  const { client, state } = createArchiveReadRetryClient(base, hooks);

  await client.execute({ sql: "SELECT 'A' FROM archive_hash_df_bands", args: [] });
  await client.execute({ sql: "SELECT 'B' FROM archive_document_fingerprints", args: [] });
  await client.execute({ sql: "SELECT 'C' FROM archive_document_cosources", args: [] });
  assert.equal(state.retriesRemaining, 0, "3 queries x 2 retries drained the shared budget");
  assert.equal(state.retriesConsumed, ARCHIVE_READ_SHARED_RETRY_BUDGET);

  await assert.rejects(() => client.execute({ sql: "SELECT 'D' FROM archive_phrase_fts", args: [] }), /HTTP status 502/);
  assert.equal(state.retriesConsumed, 6, "total retries across the WHOLE request is exactly the budget — not one more");
  assert.equal(base.calls.length, 10, "3+3+3 executions for A/B/C, then exactly 1 for D (no retry)");
  assert.equal(sleeps.length, 6);
});

test("a query that succeeds on the first attempt consumes none of the shared budget", async () => {
  const script = [
    httpError(502), OK("A"),   // A: 1 retry
    OK("B"),                   // B: first-attempt success, 0 retries
    httpError(503), OK("C"),   // C: 1 retry
    OK("D"),                   // D: first-attempt success, 0 retries
  ];
  const base = scriptedBase(script);
  const { client, state } = createArchiveReadRetryClient(base, NO_WAIT);
  for (const q of ["A", "B", "C", "D"]) await client.execute({ sql: `SELECT '${q}' FROM archive_hash_df_bands`, args: [] });
  assert.equal(state.retriesConsumed, 2);
  assert.equal(state.retriesRemaining, ARCHIVE_READ_SHARED_RETRY_BUDGET - 2);
  assert.equal(state.executions, 6);
});

test("per-read cap and shared budget both bind: 3 queries each wanting 3 retries stop at 2 apiece and then the budget stops the rest", async () => {
  // Each query fails 4x in a row. Per-read cap (2) means each throws after 3
  // executions having consumed 2 retries. Budget 6 => first 3 queries can do
  // that; but query 3's 2nd retry hits budget 0 first... trace it precisely:
  const fail4 = () => [httpError(502), httpError(502), httpError(502), httpError(502)];
  const base = scriptedBase([...fail4(), ...fail4(), ...fail4()]);
  const { client, state } = createArchiveReadRetryClient(base, NO_WAIT);
  // q1: exec,exec,exec -> throw (2 retries; budget 6->4)
  await assert.rejects(() => client.execute({ sql: "SELECT 1 FROM archive_phrase_fts", args: [] }));
  // q2: exec,exec,exec -> throw (2 retries; budget 4->2)
  await assert.rejects(() => client.execute({ sql: "SELECT 2 FROM archive_phrase_fts", args: [] }));
  // q3: exec (fail, retry: budget 2->1), exec (fail, retry: budget 1->0), exec (fail; per-read cap) -> throw
  await assert.rejects(() => client.execute({ sql: "SELECT 3 FROM archive_phrase_fts", args: [] }));
  assert.equal(state.retriesConsumed, 6);
  assert.equal(state.retriesRemaining, 0);
  assert.equal(state.executions, 9);
});

// ── backoff / jitter ─────────────────────────────────────────────────────

test("backoff jitter stays within +/-20% and is deterministic under an injected RNG", async () => {
  const low = recorder();
  low.hooks.random = () => 0; // -20%
  const b1 = scriptedBase([httpError(502), httpError(503), OK()]);
  await createArchiveReadRetryClient(b1, low.hooks).client.execute(SELECT);
  assert.deepEqual(low.sleeps, [
    Math.round(ARCHIVE_READ_BACKOFF_MS[0] * 0.8),
    Math.round(ARCHIVE_READ_BACKOFF_MS[1] * 0.8),
  ]);

  const high = { sleeps: [], hooks: { sleep: async (ms) => high.sleeps.push(ms), random: () => 0.999999 } }; // ~+20%
  const b2 = scriptedBase([httpError(502), httpError(503), OK()]);
  await createArchiveReadRetryClient(b2, high.hooks).client.execute(SELECT);
  for (const [i, requested] of high.sleeps.entries()) {
    assert.ok(requested >= ARCHIVE_READ_BACKOFF_MS[i], `sleep ${requested} >= base ${ARCHIVE_READ_BACKOFF_MS[i]}`);
    assert.ok(requested <= Math.round(ARCHIVE_READ_BACKOFF_MS[i] * 1.2), `sleep ${requested} <= +20%`);
  }
});

// ── read-shape guard ─────────────────────────────────────────────────────

test("read-shape guard: every matcher SELECT is read-shaped; writes / DDL / PRAGMA are not", () => {
  for (const sql of [
    "SELECT COUNT(*) AS total FROM archive_document_representations WHERE fingerprint_version = ?",
    "SELECT shingle_hash, df_bucket FROM archive_hash_df_bands WHERE policy_version = ?",
    "SELECT representation_id, COUNT(*) AS shared FROM archive_document_fingerprints WHERE fingerprint_version = ? AND fingerprint_hash IN (?,?) GROUP BY representation_id HAVING COUNT(*) >= 1 ORDER BY shared DESC, representation_id ASC LIMIT ?",
    "SELECT id, canonical_text FROM corpus_document_representations WHERE id IN (?,?)",
    "SELECT m.representation_id AS representation_id FROM archive_phrase_fts f JOIN archive_phrase_fts_map m ON m.fts_rowid = f.rowid WHERE f.archive_phrase_fts MATCH ? LIMIT ?",
    "SELECT COUNT(*) AS n FROM archive_phrase_fts f WHERE f.archive_phrase_fts MATCH ?",
    "SELECT co_representation_id FROM archive_document_cosources WHERE policy_version = ? AND representation_id IN (?,?)",
    "  \n\t SELECT 1",
    "WITH x AS (SELECT 1) SELECT * FROM x",
  ]) {
    assert.equal(isArchiveReadShapedSql(sql), true, sql.slice(0, 48));
  }
  for (const sql of [
    "INSERT INTO archive_phrase_fts(archive_phrase_fts) VALUES('optimize')",
    "INSERT INTO archive_phrase_fts(archive_phrase_fts) VALUES('delete-all')",
    "DELETE FROM archive_hash_df_bands WHERE policy_version = ?",
    "UPDATE corpus_document_representations SET canonical_text = ? WHERE id = ?",
    "INSERT INTO archive_document_cosources (representation_id, co_representation_id, shared_gram_count, policy_version) VALUES (?,?,?,?)",
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE x (a)",
    "BEGIN",
  ]) {
    assert.equal(isArchiveReadShapedSql(sql), false, sql.slice(0, 48));
  }
});

test("a non-read statement handed to the wrapper runs exactly once and is NEVER retried, even on a transient error", async () => {
  const base = scriptedBase([httpError(502), OK("unreached")]);
  const { client, state } = createArchiveReadRetryClient(base, NO_WAIT);
  await assert.rejects(
    () => client.execute({ sql: "INSERT INTO archive_phrase_fts(archive_phrase_fts) VALUES('optimize')", args: [] }),
    /HTTP status 502/,
  );
  assert.equal(state.executions, 1);
  assert.equal(state.retriesConsumed, 0);
  assert.equal(base.calls.length, 1);
});
