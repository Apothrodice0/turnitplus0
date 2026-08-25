import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { CRON_SCHEDULES, nextDailyUtcRun } from "../lib/cron-schedule.ts";

/**
 * Schedule-drift guard: lib/cron-schedule.ts's own header comment explains
 * WHY these are hand-maintained constants rather than a runtime parse of
 * vercel.json (that file isn't available to read at request time on a real
 * deployed server) — this test is the other half of that tradeoff: it DOES
 * read vercel.json, but only at test time, so a real schedule change made
 * in one place without the other fails here instead of silently drifting
 * into the admin status strip showing a wrong "next run" time.
 */

const repoRoot = path.resolve(".");

test("CRON_SCHEDULES.admissionRetention matches vercel.json's own corpus-admission-sweep cron entry exactly", () => {
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf8"));
  const entry = vercelConfig.crons.find((c) => c.path === "/api/internal/corpus-admission-sweep");
  assert.ok(entry, "expected a vercel.json cron entry for /api/internal/corpus-admission-sweep");
  assert.equal(CRON_SCHEDULES.admissionRetention.cronExpression, entry.schedule, "REQUIRED: lib/cron-schedule.ts's admissionRetention constant must match vercel.json's real schedule string exactly");
  assert.equal(CRON_SCHEDULES.admissionRetention.path, entry.path);
});

test("CRON_SCHEDULES.promotion matches vercel.json's own corpus-admission-promotion-sweep cron entry exactly", () => {
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf8"));
  const entry = vercelConfig.crons.find((c) => c.path === "/api/internal/corpus-admission-promotion-sweep");
  assert.ok(entry, "expected a vercel.json cron entry for /api/internal/corpus-admission-promotion-sweep");
  assert.equal(CRON_SCHEDULES.promotion.cronExpression, entry.schedule, "REQUIRED: lib/cron-schedule.ts's promotion constant must match vercel.json's real schedule string exactly");
  assert.equal(CRON_SCHEDULES.promotion.path, entry.path);
});

test("vercel.json defines exactly the 2 cron entries this app relies on — no unreviewed new/removed entry silently changing what the status strip should describe", () => {
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf8"));
  assert.equal(vercelConfig.crons.length, 2, "expected exactly 2 cron entries in vercel.json");
});

test("every CRON_SCHEDULES.hourUtc is actually derived from its own cronExpression's minute-hour fields — the two cannot drift apart from each other", () => {
  for (const [key, schedule] of Object.entries(CRON_SCHEDULES)) {
    const parts = schedule.cronExpression.split(/\s+/);
    assert.equal(parts.length, 5, `${key}'s cronExpression must be a standard 5-field cron string`);
    const [minute, hour] = parts;
    assert.equal(minute, "0", `${key}'s schedule is assumed to be exactly on the hour (minute=0) — nextDailyUtcRun only takes an hour, not a minute`);
    assert.equal(Number(hour), schedule.hourUtc, `${key}'s hourUtc must match its own cronExpression's hour field`);
  }
});

test("nextDailyUtcRun: before today's hour has passed, returns today at that UTC hour", () => {
  const now = new Date(Date.UTC(2026, 7, 25, 1, 0, 0)); // 2026-08-25 01:00 UTC
  const next = nextDailyUtcRun(3, now);
  assert.equal(next.toISOString(), "2026-08-25T03:00:00.000Z");
});

test("nextDailyUtcRun: after today's hour has already passed, returns tomorrow at that UTC hour", () => {
  const now = new Date(Date.UTC(2026, 7, 25, 5, 0, 0)); // 2026-08-25 05:00 UTC, past both 03:00 and 04:00
  const next = nextDailyUtcRun(3, now);
  assert.equal(next.toISOString(), "2026-08-26T03:00:00.000Z");
});

test("nextDailyUtcRun: exactly AT the hour counts as already passed (never returns the current instant itself)", () => {
  const now = new Date(Date.UTC(2026, 7, 25, 4, 0, 0));
  const next = nextDailyUtcRun(4, now);
  assert.equal(next.toISOString(), "2026-08-26T04:00:00.000Z", "REQUIRED: 'next run' must always be strictly in the future, never the exact current instant");
});
