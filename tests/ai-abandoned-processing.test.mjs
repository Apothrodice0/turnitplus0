import assert from "node:assert/strict";
import test from "node:test";
import * as fx from "./helpers/large-report-retry-fixture.mjs";
import { synthProse } from "./helpers/real-ai-windows.mjs";
import * as roomsRoute from "../app/api/reports/rooms/route.ts";
import { findReportRowForUser, findRoomOccupant } from "../lib/reports-repo.ts";
import { AI_PROCESSING_ABANDONED_AFTER_MS, deriveRoomStatus, isAiProcessingAbandoned } from "../lib/report-rooms.ts";
import { isAiRetryOffered } from "../lib/ai-unavailable-state.ts";

/**
 * ABANDONED AI ANALYSIS (Preview report 1793371188236, 2026-10-30). The AI half runs only in the uploading tab; that tab was
 * reloaded two minutes into its first model download, so nothing was left to write 'ready' or 'failed' and the report said
 * "Analyzing…" with nothing running anywhere. Now a 'processing' row whose last server write is older than
 * AI_PROCESSING_ABANDONED_AFTER_MS reads as the existing terminal "failed" state (room, rooms index, report list, detail),
 * with the existing Retry. Read-time only: the stored row is never rewritten, so a result that arrives later still lands.
 *
 * The rows are written by the REAL first-save route; only updated_at is moved back (the passage of time), never ai_status.
 */

const env = await fx.createFixtureEnvironment("ai_abandoned_processing");
test.after(() => env.dispose());

const account = await env.signUpAccount();
let ipCounter = 0;
const ip = () => `10.77.0.${++ipCounter}`;

async function firstSave(id, room) {
  await fx.resetRateForTest(ip());
  const body = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id, text: synthProse(700, room + 3), room });
  const res = await fx.reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `tp_session_v1=${account.cookie}`, "x-forwarded-for": ip() },
    body: JSON.stringify(body),
  }));
  assert.equal(res.status, 200, `first save ${id}: ${await res.clone().text()}`);
  return body;
}

async function ageRow(id, ms) {
  await env.client.execute({
    sql: "UPDATE saved_reports SET updated_at = strftime('%Y-%m-%d %H:%M:%S', 'now', ?) WHERE id = ?",
    args: [`-${Math.round(ms / 1000)} seconds`, id],
  });
}

async function storedStatus(id) {
  const row = await env.client.execute({ sql: "SELECT ai_status, ai_score FROM saved_reports WHERE id = ?", args: [id] });
  return { aiStatus: row.rows[0].ai_status, aiScore: row.rows[0].ai_score };
}

test("unit: only an explicit 'processing' row older than the bound is abandoned; every other state is unchanged", () => {
  const now = Date.parse("2026-10-30T15:00:00Z");
  const old = "2026-10-30 14:39:58"; // SQLite CURRENT_TIMESTAMP form (UTC, no zone)
  const recent = "2026-10-30 14:50:00";
  assert.equal(isAiProcessingAbandoned(old, now), true);
  assert.equal(isAiProcessingAbandoned(recent, now), false);
  assert.equal(isAiProcessingAbandoned("2026-10-30T14:39:58Z", now), true);
  assert.equal(isAiProcessingAbandoned(null, now), false);
  assert.equal(isAiProcessingAbandoned("not a date", now), false);
  assert.equal(isAiProcessingAbandoned(new Date(now - AI_PROCESSING_ABANDONED_AFTER_MS).toISOString(), now), false, "the bound itself is not past it");

  assert.equal(deriveRoomStatus(null, "processing", old, now), "failed");
  assert.equal(deriveRoomStatus(null, "processing", recent, now), "processing");
  assert.equal(deriveRoomStatus(null, "processing"), "processing", "no write time: unchanged");
  assert.equal(deriveRoomStatus(null, null, old, now), "processing", "a legacy NULL-status row keeps the legacy rule");
  assert.equal(deriveRoomStatus(7, "processing", old, now), "ready", "a recorded score is still ready");
  assert.equal(deriveRoomStatus(null, "ready", old, now), "ready");
  assert.equal(deriveRoomStatus(null, "failed", recent, now), "failed");
});

test("a fresh 'processing' report is still processing everywhere", async () => {
  const id = "abandon-fresh-1";
  await firstSave(id, 0);
  const occupant = await findRoomOccupant(env.client, account.userId, 0);
  assert.equal(occupant.status, "processing");
  const row = await findReportRowForUser(env.client, id, account.userId);
  assert.equal(deriveRoomStatus(row.ai_score, row.ai_status, row.updated_at), "processing");
});

test("an abandoned report reads as failed with Retry in the room, the rooms index, the report list and the detail page — the row is untouched", async () => {
  const id = "abandon-old-1";
  await firstSave(id, 1);
  await ageRow(id, AI_PROCESSING_ABANDONED_AFTER_MS + 60_000);

  const occupant = await findRoomOccupant(env.client, account.userId, 1);
  assert.equal(occupant.status, "failed", "room occupant");
  assert.equal(isAiRetryOffered(occupant.report), true, "the existing Retry analysis is offered");

  const index = await roomsRoute.GET(new Request("http://localhost/api/reports/rooms", { headers: { cookie: `tp_session_v1=${account.cookie}`, "x-forwarded-for": ip() } }));
  assert.equal(index.status, 200);
  const rooms = (await index.json()).rooms;
  assert.equal(rooms.find((r) => r.room === 1).status, "failed", "rooms index");
  assert.equal(rooms.find((r) => r.room === 0).status, "processing", "the fresh room is unaffected");

  const list = await fx.reportsRoute.GET(new Request(`http://localhost/api/reports?deviceKey=${account.deviceKey}`, { headers: { cookie: `tp_session_v1=${account.cookie}`, "x-forwarded-for": ip() } }));
  assert.equal(list.status, 200);
  const listed = (await list.json()).reports;
  assert.equal(listed.find((r) => r.id === id).aiStatus, "failed", "report list row");
  assert.equal(listed.find((r) => r.id === "abandon-fresh-1").aiStatus, undefined, "fresh list row unchanged");

  const row = await findReportRowForUser(env.client, id, account.userId);
  assert.equal(deriveRoomStatus(row.ai_score, row.ai_status, row.updated_at), "failed", "detail page (page.tsx's derivation)");

  assert.deepEqual(await storedStatus(id), { aiStatus: "processing", aiScore: null }, "read-time only: the stored row is unchanged");
});

test("a result that arrives after the bound is still saved and shown as ready", async () => {
  const id = "abandon-late-1";
  const body = await firstSave(id, 2);
  await ageRow(id, AI_PROCESSING_ABANDONED_AFTER_MS + 60_000);
  assert.equal((await findRoomOccupant(env.client, account.userId, 2)).status, "failed");

  const analysis = fx.syntheticAiAnalysis(body.payload.text);
  await fx.resetRateForTest(ip());
  const res = await fx.reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `tp_session_v1=${account.cookie}`, "x-forwarded-for": ip() },
    body: JSON.stringify({ ...body, aiScore: 4, aiTone: "low", aiStatus: "ready", payload: { ...body.payload, aiScore: analysis.score, aiAnalysis: analysis } }),
  }));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await storedStatus(id)).aiStatus, "ready");
  assert.equal((await findRoomOccupant(env.client, account.userId, 2)).status, "ready");
});
