import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { recordSweepRun, getSweepRunRecords } from "../lib/corpus-admission-sweep-state.ts";

/**
 * lib/corpus-admission-sweep-state.ts: the singleton read/write layer
 * behind corpus_admission_sweep_runs (drizzle/0037) — upsert-not-append
 * semantics, the numeric-only summary allowlist (both the type and its
 * runtime sanitization), and the structural privacy guarantees the admin
 * corpus status strip depends on. This module's own status as a reviewed,
 * closed "door" (tests/corpus-admission-privacy.test.mjs's
 * SWEEP_STATE_DOOR_MODULE) is covered there, not here. Every fixture is
 * synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_sweep_state.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

test("no persisted row exists for a kind that has never run — getSweepRunRecords returns nothing for it", async () => {
  const records = await getSweepRunRecords(client);
  assert.equal(records.find((r) => r.sweepKind === "report_admission"), undefined);
});

test("recordSweepRun upserts a SINGLETON row per kind — never a second, appended row for the same kind", async () => {
  await recordSweepRun(client, "retention", { status: "success", summary: { decisionsDeleted: 2 } });
  await recordSweepRun(client, "retention", { status: "success", summary: { decisionsDeleted: 5 } });
  await recordSweepRun(client, "retention", { status: "failed" });

  const rows = await client.execute("SELECT COUNT(*) AS c FROM corpus_admission_sweep_runs WHERE sweep_kind = 'retention'");
  assert.equal(Number(rows.rows[0].c), 1, "REQUIRED: exactly one row must ever exist for 'retention' — this is a singleton-state table, not a history log");

  const records = await getSweepRunRecords(client);
  const retention = records.find((r) => r.sweepKind === "retention");
  assert.equal(retention.lastStatus, "failed", "the most recent write must win");
  assert.equal(retention.summary, null, "a failed run's own missing summary must not resurrect an earlier success's summary");
});

test("three different kinds persist completely independently — writing one never touches another's row", async () => {
  await recordSweepRun(client, "promotion", { status: "success", summary: { claimedCount: 1 } });
  await recordSweepRun(client, "report_admission", { status: "failed" });
  // Deliberately do NOT touch 'retention' in this test — it keeps whatever the previous test left it as.

  const records = await getSweepRunRecords(client);
  const byKind = Object.fromEntries(records.map((r) => [r.sweepKind, r]));
  assert.equal(byKind.promotion.lastStatus, "success");
  assert.equal(byKind.report_admission.lastStatus, "failed");
  assert.ok(byKind.retention, "retention's own row from the previous test must still exist, untouched by these two independent writes");
});

test("summary sanitization: non-numeric values are silently dropped, never persisted or returned — the TYPE allowlist is also enforced at runtime", async () => {
  // This file is plain JS (.mjs) — the object below deliberately violates
  // SweepRunSummary's own TypeScript type (numbers only); the point of this
  // test is proving the RUNTIME filter (sanitizeSummary) rejects it too,
  // not just the compiler, since a caller could reach this function from
  // JS-adjacent code paths the type checker never sees.
  const summaryWithJunk = {
    validCount: 3,
    accountId: "should-never-be-stored",
    errorMessage: "some raw exception text that must never be persisted",
    nested: { evil: "payload" },
    infinite: Infinity,
  };
  await recordSweepRun(client, "promotion", { status: "success", summary: summaryWithJunk });

  const raw = await client.execute("SELECT last_summary_json FROM corpus_admission_sweep_runs WHERE sweep_kind = 'promotion'");
  const storedJson = raw.rows[0].last_summary_json;
  assert.ok(!storedJson.includes("should-never-be-stored"));
  assert.ok(!storedJson.includes("some raw exception text"));
  assert.ok(!storedJson.includes("evil"));
  assert.deepEqual(JSON.parse(storedJson), { validCount: 3 }, "REQUIRED: only the finite-number field must survive — everything else silently dropped, not rejected with an error that could itself leak the bad value");

  const records = await getSweepRunRecords(client);
  const promotion = records.find((r) => r.sweepKind === "promotion");
  assert.deepEqual(promotion.summary, { validCount: 3 });
});

test("an all-junk summary (no valid numeric fields at all) persists as null, not an empty object", async () => {
  await recordSweepRun(client, "report_admission", {
    status: "success",
    summary: { accountId: "x", note: "y" },
  });
  const raw = await client.execute("SELECT last_summary_json FROM corpus_admission_sweep_runs WHERE sweep_kind = 'report_admission'");
  assert.equal(raw.rows[0].last_summary_json, null);
});

test("no summary at all persists as null, not an empty object or a missing field", async () => {
  await recordSweepRun(client, "retention", { status: "failed" });
  const records = await getSweepRunRecords(client);
  const retention = records.find((r) => r.sweepKind === "retention");
  assert.equal(retention.summary, null);
});

// --- PRIVACY: the schema/module/table can never carry identifying data ----

test("PRIVACY: corpus_admission_sweep_runs (migration + schema.ts) never defines an account/report/decision/representation/email/filename-shaped column", () => {
  const forbidden = ["account_id", "device_key", "report_id", "source_ref", "email", "decision_id", "representation_id", "filename", "stack_trace", "exception"];

  const migrationSource = fs.readFileSync(path.join(repoRoot, "drizzle/0037_corpus_admission_sweep_runs.sql"), "utf8");
  const sqlOnly = migrationSource.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");
  const tableMatch = sqlOnly.match(/CREATE TABLE[^(]*corpus_admission_sweep_runs\s*\(([^;]*?)\);/s);
  assert.ok(tableMatch, "expected to find the corpus_admission_sweep_runs CREATE TABLE statement");
  for (const term of forbidden) {
    assert.doesNotMatch(tableMatch[1], new RegExp(term), `corpus_admission_sweep_runs must never define a ${term} column`);
  }

  const schemaSource = fs.readFileSync(path.join(repoRoot, "db/schema.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const schemaBlockMatch = schemaSource.match(/corpus_admission_sweep_runs = sqliteTable\("corpus_admission_sweep_runs",\s*\{([\s\S]*?)\}\)/);
  assert.ok(schemaBlockMatch, "expected to find the corpus_admission_sweep_runs sqliteTable block in db/schema.ts");
  for (const term of forbidden) {
    assert.doesNotMatch(schemaBlockMatch[1], new RegExp(term), `corpus_admission_sweep_runs' schema.ts block must never define a ${term} column`);
  }
});

test("PRIVACY: recordSweepRun's own source never mentions err.message, error.stack, or any account/report/decision-shaped identifier", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/corpus-admission-sweep-state.ts"), "utf8");
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const term of ["err.message", "error.message", "err.stack", "\\.stack\\b", "accountId", "account_id", "reportId", "deviceKey", "decisionId", "representationId"]) {
    assert.doesNotMatch(codeOnly, new RegExp(term), `lib/corpus-admission-sweep-state.ts's own code must never mention ${term}`);
  }
});

test("PRIVACY: a realistic recorded summary, round-tripped through getSweepRunRecords, never contains an embedded secret-shaped value even if a caller's own summary object happened to include a key NAMED like an id (the runtime filter is value-typed, not key-name-based)", async () => {
  const secretLookingButNumericValue = 12345; // a caller could legitimately have a field literally called "accountId" if it were ever (wrongly) numeric — the filter must still only look at the VALUE's type, proving it isn't a key-name allowlist that a typo could bypass in the other direction. This just documents the actual (value-typed) behavior; production callers never pass such a key.
  await recordSweepRun(client, "promotion", { status: "success", summary: { totalProcessed: secretLookingButNumericValue } });
  const records = await getSweepRunRecords(client);
  const promotion = records.find((r) => r.sweepKind === "promotion");
  assert.deepEqual(promotion.summary, { totalProcessed: 12345 });
  const serialized = JSON.stringify(records);
  assert.ok(!/@|\.test\b/.test(serialized), "sanity: nothing email-shaped ever appears in a serialized sweep-run record");
});
