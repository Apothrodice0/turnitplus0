import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Production audit fix: this app had no error.tsx anywhere. An uncaught
 * exception during render (most realistically a transient DB connectivity
 * blip) fell through to Next's generic, unstyled crash page instead of the
 * app's own visual language — and, worse, a corrupt payload_json row threw
 * a raw SyntaxError out of app/reports/[id]/page.tsx's loadOwnedReport with
 * no boundary to catch it at all. Source-text wiring tests, matching the
 * convention used throughout tests/report-detail-route.test.mjs and
 * tests/room-detail-route.test.mjs for these same Server Components (no
 * React test harness in this codebase — see those files' own header
 * comments).
 */

test("app/reports/[id]/error.tsx exists, is a real error boundary (accepts error+reset), and renders the shared panel", async () => {
  const dir = fileURLToPath(new URL("../app/reports/[id]/", import.meta.url));
  assert.equal(existsSync(`${dir}error.tsx`), true);

  const source = await readFile(`${dir}error.tsx`, "utf8");
  assert.match(source, /^"use client";/, "error.tsx must be a Client Component — Next requires this");
  assert.match(source, /error: Error & \{ digest\?: string \}; reset: \(\) => void/, "must accept Next's real error boundary props, not a placeholder shape");
  assert.match(source, /<RouteErrorPanel reset=\{reset\}/, "must actually wire reset() through, not just accept and discard it");
});

test("app/reports/rooms/[room]/error.tsx exists, is a real error boundary, and renders the shared panel", async () => {
  const dir = fileURLToPath(new URL("../app/reports/rooms/[room]/", import.meta.url));
  assert.equal(existsSync(`${dir}error.tsx`), true);

  const source = await readFile(`${dir}error.tsx`, "utf8");
  assert.match(source, /^"use client";/);
  assert.match(source, /error: Error & \{ digest\?: string \}; reset: \(\) => void/);
  assert.match(source, /<RouteErrorPanel reset=\{reset\}/);
});

test("the shared RouteErrorPanel offers a real retry (Next's reset()) and a way back to My Reports, not a dead end", async () => {
  const source = await readFile(new URL("../components/report/route-error-panel.tsx", import.meta.url), "utf8");
  assert.match(source, /^"use client";/);
  assert.match(source, /onClick=\{reset\}/);
  assert.match(source, /href="\/#reports"/);
});

test("a corrupt payload_json row is treated as not-found-for-session (reusing the existing, tested not-found path), never left to throw a raw SyntaxError uncaught", async () => {
  const route = await readFile(new URL("../app/reports/[id]/page.tsx", import.meta.url), "utf8");

  const loaderMatch = route.match(/const loadOwnedReport = cache\(async[\s\S]*?\n\}\);/);
  assert.ok(loaderMatch, "loadOwnedReport must be found");
  const loader = loaderMatch[0];

  const tryBlockMatch = loader.match(/try \{\s*\n\s*const payload = JSON\.parse\(row\.payload_json\) as SimilarityReport;[\s\S]*?\} catch \{\s*\n\s*return \{ status: "not-found-for-session" \};\s*\n\s*\}/);
  assert.ok(tryBlockMatch, "JSON.parse must be wrapped, and a failure must resolve to the same not-found-for-session status a missing row already uses — not a new, untested state");
});
