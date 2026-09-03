import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { deleteAllReportDataForAccount } from "../lib/account-deletion.ts";
import {
  seedPromotedRepresentation,
  seedSavedReport,
  matchedResult,
  corpusMatch,
  authoritativeFor,
  readShadowRow,
  runShadowEval,
  SHADOW_POLICY,
} from "./helpers/corpus-duplicate-shadow.mjs";

/**
 * Phase B2a — deletion is trigger-atomic. The drizzle/0044 AFTER DELETE trigger
 * removes every shadow row for a report inside the DELETE statement that removes
 * its saved_reports row; the evaluator's EXISTS-guarded UPSERT additionally
 * stops a deferred write from recreating a row after deletion. NO route-side B2
 * cleanup wiring exists — the trigger covers every deletion path.
 */

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_corpus_duplicate_suppression_shadow_deletion.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));
test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

const TEXT = "Deletion fixture paragraph for the corpus-duplicate suppression shadow trigger and guarded-upsert coverage.";
let n = 0;
const uniq = (p) => `${p}-${++n}`;

async function evaluateOnce(client, { deviceKey, reportId, accountId, repId, generation = 1 }) {
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: generation,
  });
}

test("the AFTER DELETE trigger exists after migration", async () => {
  const q = "'trigger'";
  const r = await client.execute(`SELECT name, sql FROM sqlite_master WHERE type = ${q} AND name = 'trg_corpus_duplicate_suppression_shadow_cleanup_on_report_delete'`);
  assert.equal(r.rows.length, 1);
  assert.match(String(r.rows[0].sql), /AFTER DELETE ON saved_reports/);
  assert.match(String(r.rows[0].sql), /DELETE FROM corpus_duplicate_suppression_shadow_evaluations/);
});

test("deleting the saved_reports row removes ALL policy_versions of its shadow rows atomically; another report survives", async () => {
  const deviceKey = uniq("dk");
  const reportId = uniq("r");
  const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });
  await evaluateOnce(client, { deviceKey, reportId, accountId, repId });
  // a second, unrelated report + shadow row
  const otherDevice = uniq("dk"); const otherReport = uniq("r");
  await seedSavedReport(client, { deviceKey: otherDevice, reportId: otherReport, accountId, text: TEXT });
  await evaluateOnce(client, { deviceKey: otherDevice, reportId: otherReport, accountId, repId });
  // + a synthetic second policy_version row for the first report (simulates a future policy bump)
  await client.execute({
    sql: `INSERT INTO corpus_duplicate_suppression_shadow_evaluations
          (report_device_key, report_id, status, policy_version, rule_version, unified_similarity_version, counterfactual_version, evaluation_truncated)
          VALUES (?,?,?,?,?,?,?,0)`,
    args: [deviceKey, reportId, "OK", "document-local-corpus-duplicate-shadow-v2", "x", "y", "z"],
  });

  const before = await client.execute({ sql: "SELECT COUNT(*) n FROM corpus_duplicate_suppression_shadow_evaluations WHERE report_device_key = ? AND report_id = ?", args: [deviceKey, reportId] });
  assert.equal(Number(before.rows[0].n), 2, "two policy_version rows for the report");

  const del = await client.execute({ sql: "DELETE FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  assert.equal(Number(del.rowsAffected), 1);

  const afterFirst = await client.execute({ sql: "SELECT COUNT(*) n FROM corpus_duplicate_suppression_shadow_evaluations WHERE report_device_key = ? AND report_id = ?", args: [deviceKey, reportId] });
  assert.equal(Number(afterFirst.rows[0].n), 0, "the trigger cascaded BOTH policy_version rows");
  assert.ok(await readShadowRow(client, otherDevice, otherReport), "the unrelated report's shadow row is untouched");
});

test("account deletion (deleteAllReportDataForAccount) removes the shadow rows via the trigger — no explicit B2 wiring", async () => {
  const accountId = uniq("acct");
  await client.execute({ sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [accountId, `${accountId}@ex.test`, accountId, "h"] });
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const reports = [];
  for (let i = 0; i < 3; i += 1) {
    const deviceKey = uniq("dk"); const reportId = uniq("r");
    await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });
    await evaluateOnce(client, { deviceKey, reportId, accountId, repId });
    reports.push({ deviceKey, reportId });
  }
  for (const r of reports) assert.ok(await readShadowRow(client, r.deviceKey, r.reportId), "seeded");

  await deleteAllReportDataForAccount(client, accountId);

  for (const r of reports) {
    assert.equal(await readShadowRow(client, r.deviceKey, r.reportId), null, "shadow row gone after account deletion");
    const anyPolicy = await client.execute({ sql: "SELECT COUNT(*) n FROM corpus_duplicate_suppression_shadow_evaluations WHERE report_device_key = ? AND report_id = ?", args: [r.deviceKey, r.reportId] });
    assert.equal(Number(anyPolicy.rows[0].n), 0, "no shadow row for this deleted report under any policy_version");
  }
});

test("guarded UPSERT: a deferred evaluator whose report was deleted first CANNOT recreate the row", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });

  // race order B: report deleted BEFORE the deferred evaluator runs its UPSERT
  await client.execute({ sql: "DELETE FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  await evaluateOnce(client, { deviceKey, reportId, accountId, repId });
  assert.equal(await readShadowRow(client, deviceKey, reportId), null, "EXISTS guard: no shadow row for a deleted report");
});

test("race order A: evaluator writes first, THEN report deletion — the trigger removes the just-written row", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });
  await evaluateOnce(client, { deviceKey, reportId, accountId, repId });
  assert.ok(await readShadowRow(client, deviceKey, reportId), "row written while report exists");
  await client.execute({ sql: "DELETE FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  assert.equal(await readShadowRow(client, deviceKey, reportId), null, "trigger removed it");
});

test("guarded UPSERT: a prior shadow row + since-deleted report + a re-run does NOT resurrect or update it", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });
  await evaluateOnce(client, { deviceKey, reportId, accountId, repId });
  // Manually delete only the saved_reports row's trigger effect would remove the shadow row too;
  // to exercise "prior shadow row present but report gone", drop the trigger's target by
  // deleting saved_reports WITHOUT the shadow row (temporarily disable the trigger path by
  // re-inserting the shadow row after deletion, then re-run).
  await client.execute({ sql: "DELETE FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  await client.execute({
    sql: `INSERT INTO corpus_duplicate_suppression_shadow_evaluations
          (report_device_key, report_id, status, policy_version, rule_version, unified_similarity_version, counterfactual_version, authoritative_score, evaluation_truncated)
          VALUES (?,?,?,?,?,?,?,?,0)`,
    args: [deviceKey, reportId, "OK", SHADOW_POLICY, "x", "y", "z", 42],
  });
  await evaluateOnce(client, { deviceKey, reportId, accountId, repId });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.ok(row, "the manually re-inserted row still exists");
  assert.equal(Number(row.authoritative_score), 42, "the guarded UPSERT's DO UPDATE did NOT run — value unchanged");
});

test("deleting a report with a shadow row leaves corpus/document data untouched", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });
  await evaluateOnce(client, { deviceKey, reportId, accountId, repId });

  const repsBefore = Number((await client.execute("SELECT COUNT(*) n FROM corpus_document_representations")).rows[0].n);
  const decisionsBefore = Number((await client.execute("SELECT COUNT(*) n FROM corpus_admission_decisions")).rows[0].n);

  await client.execute({ sql: "DELETE FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });

  assert.equal(Number((await client.execute("SELECT COUNT(*) n FROM corpus_document_representations")).rows[0].n), repsBefore);
  assert.equal(Number((await client.execute("SELECT COUNT(*) n FROM corpus_admission_decisions")).rows[0].n), decisionsBefore);
});

test("STRUCTURAL: the DELETE routes and account-deletion carry NO explicit B2 cleanup wiring — the trigger is the mechanism", () => {
  const del = fs.readFileSync(path.join(repoRoot, "app/api/reports/[id]/route.ts"), "utf8");
  const acct = fs.readFileSync(path.join(repoRoot, "lib/account-deletion.ts"), "utf8");
  for (const [name, src] of [["DELETE route", del], ["account-deletion", acct]]) {
    assert.doesNotMatch(src, /corpus_duplicate_suppression_shadow/, `${name} must not reference the B2 shadow table (trigger-only cleanup)`);
    assert.doesNotMatch(src, /corpus-duplicate-suppression-shadow/, `${name} must not import the B2 evaluator module`);
  }
});
