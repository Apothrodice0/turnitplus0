import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";

/**
 * The unified similarity result persists with the report (owner decision 2026-10-30): an accepted System 2 estimate is
 * stored server-side at payload_json.$.system2Estimate (lib/system2-estimate-record.ts), survives every resave in either
 * order, can never come from a browser, and is what the room, the report page and the receipt all read.
 * Runs the EXACT exported SQL text (SAVE_REPORT_SQL, PERSIST_SYSTEM2_ESTIMATE_SQL) against a throwaway database.
 */

const repo = path.resolve(".");
const dbFile = path.join(repo, "test_system2_estimate_persistence.db");
for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(`${dbFile}${suffix}`)) fs.unlinkSync(`${dbFile}${suffix}`);
const originalTursoUrl = process.env.TURSO_DATABASE_URL;
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, path.join(repo, "drizzle"));

const { SAVE_REPORT_SQL } = await import("../app/api/reports/route.ts");
const R = await import("../lib/system2-estimate-record.ts");
const { unifySimilarity } = await import("../lib/system2-unified.ts");
const { buildReportSummary } = await import("../lib/report-types.ts");
const { findRoomOccupant } = await import("../lib/reports-repo.ts");
const { tryDecodeReportFromPersistence } = await import("../lib/report-persistence.ts");

test.after(() => {
  client.close();
  if (originalTursoUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = originalTursoUrl;
  for (const suffix of ["", "-wal", "-shm"]) try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
});

const DEVICE = "s2-persist-device";
const USER = "s2-persist-user";
await client.execute({ sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, ?)", args: [USER, "s2-persist@example.test", "s2persist", "x"] });

const COMPLETE_ANALYSIS = { status: "complete", scoringVersion: 10, medianLogOdds: -1, model: "m", engine: "CPU", threshold: 0.7, eligibleWordCount: 400, analyzedWordCount: 400, passages: [] };
const payload = (extra = {}) => ({ version: 11, id: "x", submissionId: "sub-x", title: "doc.docx", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: 1000, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text: "sample", ...extra });
const save = (c, id, { aiStatus = "processing", aiScore = null, body = payload(), room = 0 } = {}) =>
  c.execute({ sql: SAVE_REPORT_SQL, args: [id, DEVICE, `sub-${id}`, "Fixture", new Date().toISOString(), 1000, 0, "Low", aiScore, aiScore === null ? null : "low", aiStatus, JSON.stringify(body), USER, room] });
const stored = (percent = 4) => R.acceptedSystem2Estimate({ state: "CONSERVATIVE_WITHIN_RANGE", estimate_shown: true, final_text: "x", conservative_estimate_percent: percent }, "2026-10-30T00:00:00.000Z");
const persist = (c, id, value = stored()) => c.execute({ sql: R.PERSIST_SYSTEM2_ESTIMATE_SQL, args: [JSON.stringify(value), DEVICE, id, USER] });
const readPayload = async (id) => JSON.parse(String((await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [DEVICE, id] })).rows[0].payload_json));

test("accepted estimates only: shown, integer 0-20; the stored form keeps only what the percentage needs", () => {
  assert.deepEqual(stored(4), { state: "CONSERVATIVE_WITHIN_RANGE", estimate_shown: true, final_text: "", conservative_estimate_percent: 4, recordedAt: "2026-10-30T00:00:00.000Z" });
  for (const bad of [{ estimate_shown: false, conservative_estimate_percent: 4 }, { estimate_shown: true, conservative_estimate_percent: 21 }, { estimate_shown: true, conservative_estimate_percent: 4.5 }, { estimate_shown: true }, null]) {
    assert.equal(R.acceptedSystem2Estimate(bad && { state: "S", final_text: "", ...bad }, "t"), null);
  }
  assert.equal(R.storedSystem2Estimate({ system2Estimate: { estimate_shown: true, conservative_estimate_percent: 25 } }), null, "an invalid stored value is ignored");
  assert.deepEqual(R.system2EstimateField('{"estimate_shown":true,"conservative_estimate_percent":4}'), { system2EstimatePercent: 4 });
  assert.deepEqual(R.system2EstimateField("not json"), {});
  assert.deepEqual(R.system2EstimateField(null), {});
});

test("the browser can never supply an estimate: the save route drops it before anything reads the payload", async () => {
  const p = { system2Estimate: stored(20), title: "t" };
  assert.equal(R.withoutClientSystem2Estimate(p), p);
  assert.equal("system2Estimate" in p, false);
  const route = await readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8");
  assert.match(route, /= body as Record<string, unknown>;\r?\n(?:\s*\/\/.*\r?\n)*\s*withoutClientSystem2Estimate\(payload\);/, "stripped right after the body is read");
  // the route is the gate (SAVE_REPORT_SQL stores what it is given): a payload after the route's strip carries none
  await save(client, "forged2", { body: R.withoutClientSystem2Estimate(payload({ system2Estimate: stored(20) })) });
  assert.equal((await readPayload("forged2")).system2Estimate, undefined);
});

test("an estimate stored first survives every later resave shape (AI completion, similarity-only, replay)", async () => {
  await save(client, "order-a");
  assert.equal((await persist(client, "order-a")).rowsAffected, 1);
  // AI completion resave (ready + aiAnalysis), payload without the estimate
  await save(client, "order-a", { aiStatus: "ready", aiScore: 1.1, body: payload({ aiAnalysis: COMPLETE_ANALYSIS, aiScore: 1.1 }) });
  let p = await readPayload("order-a");
  assert.equal(p.system2Estimate.conservative_estimate_percent, 4); assert.equal(p.aiAnalysis.status, "complete");
  // a replayed 'processing' save against the ready row (KEEP_STORED_READY_AI branch) and a stale-generation resave
  await save(client, "order-a", { aiStatus: "processing" });
  await client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.unifiedSimilarityGeneration', 9) WHERE id = 'order-a'" });
  await save(client, "order-a", { aiStatus: "ready", aiScore: 1.1, body: payload({ aiAnalysis: COMPLETE_ANALYSIS, aiScore: 1.1 }) });
  p = await readPayload("order-a");
  assert.equal(p.system2Estimate.conservative_estimate_percent, 4, "kept through every branch of the payload merge");
  assert.equal(p.aiAnalysis.status, "complete"); assert.equal(p.unifiedSimilarityGeneration, 9);
});

test("an AI result saved first is kept when the estimate lands after it", async () => {
  await save(client, "order-b");
  await save(client, "order-b", { aiStatus: "ready", aiScore: 1.1, body: payload({ aiAnalysis: COMPLETE_ANALYSIS, aiScore: 1.1 }) });
  await persist(client, "order-b", stored(7));
  const p = await readPayload("order-b");
  assert.equal(p.aiAnalysis.status, "complete"); assert.equal(p.aiScore, 1.1); assert.equal(p.system2Estimate.conservative_estimate_percent, 7);
});

test("concurrent AI-result save and estimate store on separate connections: neither overwrites the other (40 races)", async () => {
  for (let i = 0; i < 40; i++) {
    const id = `race-${i}`;
    await save(client, id);
    const a = createClient({ url: `file:${dbFile}` }), b = createClient({ url: `file:${dbFile}` });
    const busy = async (fn) => { for (let t = 0; ; t++) { try { return await fn(); } catch (e) { if (!/SQLITE_BUSY/i.test(String(e)) || t > 20) throw e; await new Promise((r) => setTimeout(r, 5)); } } };
    const ops = [busy(() => save(a, id, { aiStatus: "ready", aiScore: 1.1, body: payload({ aiAnalysis: COMPLETE_ANALYSIS, aiScore: 1.1 }) })), busy(() => persist(b, id, stored(5)))];
    await Promise.all(i % 2 ? ops : ops.reverse());
    a.close(); b.close();
    const p = await readPayload(id);
    assert.equal(p.aiAnalysis?.status, "complete", `race ${i}: AI result kept`);
    assert.equal(p.system2Estimate?.conservative_estimate_percent, 5, `race ${i}: estimate kept`);
  }
});

test("only the owner's own row is written; a refused or failed estimate stores nothing and keeps an earlier one", async () => {
  await save(client, "own");
  const wrongUser = await client.execute({ sql: R.PERSIST_SYSTEM2_ESTIMATE_SQL, args: [JSON.stringify(stored()), DEVICE, "own", "someone-else"] });
  assert.equal(wrongUser.rowsAffected, 0);
  assert.equal((await readPayload("own")).system2Estimate, undefined);
  await persist(client, "own", stored(6));
  assert.equal(R.acceptedSystem2Estimate({ state: "UNAVAILABLE", estimate_shown: false, final_text: "" }, "t"), null, "the route writes only an accepted result");
  assert.equal((await readPayload("own")).system2Estimate.conservative_estimate_percent, 6);
});

test("every view reads the same stored value: room summary (server), client summary, report decode, unified max rule", async () => {
  await save(client, "views", { room: 3 });
  await persist(client, "views", stored(4));
  const occupant = await findRoomOccupant(client, USER, 3);
  assert.equal(occupant.report.system2EstimatePercent, 4, "the room read (refresh, another device) carries it");
  const decoded = tryDecodeReportFromPersistence(await readPayload("views"), { requireContributions: false });
  assert.ok(decoded.ok); assert.equal(decoded.report.system2Estimate.conservative_estimate_percent, 4, "the report GET serves it");
  assert.equal(buildReportSummary(decoded.report).system2EstimatePercent, 4, "a summary built from the full report agrees");
  // max(System 1, System 2): System 1 = 0 -> 4; System 1 = 9 -> 9; no estimate -> System 1
  assert.equal(unifySimilarity(0, R.storedSystem2Estimate(decoded.report)).percent, 4);
  assert.equal(unifySimilarity(9, R.storedSystem2Estimate(decoded.report)).percent, 9);
  assert.equal(unifySimilarity(3, R.storedSystem2Estimate({})).percent, 3);
  await save(client, "plain", { room: 4 });
  assert.equal("system2EstimatePercent" in (await findRoomOccupant(client, USER, 4)).report, false, "a report without one is unchanged");
});

test("the room tile, report page and receipt all read the stored estimate; no browser storage, no extra label", async () => {
  const roomShell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  assert.match(roomShell, /const unified = unifySimilarity\(score, system2Estimate \?\? storedEstimate\);/);
  assert.match(roomShell, /await downloadReceipt\(full\);/);
  const detail = await readFile(new URL("../app/reports/[id]/report-detail-shell.tsx", import.meta.url), "utf8");
  assert.match(detail, /const system2Estimate = storedSystem2Estimate\(report\);/);
  assert.match(detail, /await downloadReceipt\(report\);/);
  const pipeline = await readFile(new URL("../lib/document-check-pipeline.ts", import.meta.url), "utf8");
  assert.match(pipeline, /const combined = unifySimilarity\(primaryScore, storedSystem2Estimate\(report\)\);/);
  const client2 = await readFile(new URL("../components/report/system2-estimate.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(client2, /localStorage/);
  for (const f of ["../app/reports/rooms/[room]/room-page-shell.tsx", "../app/reports/[id]/report-detail-shell.tsx", "../components/report/report-v2/report-v2-view.tsx", "../lib/document-check-pipeline.ts", "../lib/receipt-pdf.ts", "../lib/system2-unified.ts", "../app/globals.css"]) {
    const src = await readFile(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /statistical estimation|UNIFIED_ESTIMATE_NOTE|statisticalEstimateNote|incl\. estimate|unified-estimate-note/, `${f}: no extra label`);
  }
});
