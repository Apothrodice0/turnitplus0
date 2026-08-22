import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source-text wiring test for the dedicated room page
// (app/reports/rooms/[room]/page.tsx), matching the convention used by
// tests/report-detail-route.test.mjs for its sibling report-detail route.

test("the room page stays force-dynamic and only calls notFound() for a genuinely invalid room number", async () => {
  const route = await readFile(new URL("../app/reports/rooms/[room]/page.tsx", import.meta.url), "utf8");

  assert.match(route, /export const dynamic = "force-dynamic";/);
  assert.match(route, /if \(!token\) return \{ status: "no-session" \};/);
  assert.match(route, /if \(!sessionUser\) return \{ status: "no-session" \};/);
  assert.match(route, /if \(!Number\.isInteger\(room\) \|\| room < 0 \|\| room >= roomCount\) return \{ status: "invalid-room" \};/);

  const bodyMatch = route.match(/export default async function RoomPage[\s\S]*$/);
  assert.ok(bodyMatch, "RoomPage function body must be found");
  assert.match(bodyMatch[0], /if \(result\.status === "invalid-room"\) notFound\(\);/);
});

test("a rate-limited request is never conflated with no-session — an already signed-in owner never sees a false sign-in prompt", async () => {
  // Production audit fix: this account's own general rate-limit bucket
  // (lib/rate-limit.ts, IP-keyed) can trip even though a session cookie is
  // already present. Before this fix that case was folded into
  // "no-session", which rendered "Sign in to view this room" — a false
  // negative for an account that is, in fact, signed in.
  const route = await readFile(new URL("../app/reports/rooms/[room]/page.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(
    route,
    /if \(!rate\.allowed\) return \{ status: "no-session" \};/,
    "a rate-limit rejection must never be reported as no-session",
  );
  assert.match(
    route,
    /if \(!rate\.allowed\) return \{ status: "rate-limited", retryAfterSeconds: rate\.retryAfter \};/,
  );

  const bodyMatch = route.match(/export default async function RoomPage[\s\S]*$/);
  assert.ok(bodyMatch, "RoomPage function body must be found");
  const body = bodyMatch[0];

  const noSessionBranchIndex = body.indexOf('if (result.status === "no-session")');
  const rateLimitedBranchIndex = body.indexOf('if (result.status === "rate-limited")');
  const shellRenderIndex = body.indexOf("<RoomPageShell");
  assert.ok(noSessionBranchIndex >= 0, "a dedicated no-session branch must exist");
  assert.ok(rateLimitedBranchIndex >= 0, "a dedicated rate-limited branch must exist");
  assert.ok(noSessionBranchIndex !== rateLimitedBranchIndex, "no-session and rate-limited must be handled by two separate branches, not merged");
  assert.ok(rateLimitedBranchIndex < shellRenderIndex, "the rate-limited branch must return before RoomPageShell renders");

  // The rate-limited branch's own copy must never say "sign in" — that
  // would just re-introduce the same false-negative under different words.
  const rateLimitedSection = body.slice(rateLimitedBranchIndex, shellRenderIndex);
  assert.doesNotMatch(rateLimitedSection, /sign in/i);
});

test("the room-list link never prefetches — it renders in a loop (up to 40 rows) against a rate-limited, force-dynamic route", async () => {
  const rooms = await readFile(new URL("../components/reports/report-rooms.tsx", import.meta.url), "utf8");
  const linkMatch = rooms.match(/<Link[\s\S]*?<\/Link>/);
  assert.ok(linkMatch, "the room row Link must be found");
  assert.match(linkMatch[0], /prefetch=\{false\}/);
});
