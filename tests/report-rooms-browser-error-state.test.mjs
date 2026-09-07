import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Production bug fix: components/reports/report-rooms.tsx (My Reports'
 * room directory) used to render fetchReportRoomIndex()'s result directly
 * as `roomIndex` — a failed request (429/500/network error) resolved to
 * `[]` and rendered as a real, empty-looking room list, indistinguishable
 * from "this account genuinely has zero rooms" (impossible) and giving no
 * hint that anything failed, let alone that the account is still signed
 * in. Source-text wiring test, matching this suite's established
 * convention for components with no React test harness — the underlying
 * fetchReportRoomIndex contract itself is covered functionally in
 * tests/reports-remote-error-handling.test.mjs.
 *
 * Stale-room fix (2026-08): loadIndex() now paints the client cache then
 * ALWAYS revalidates, routing the fetch result through the pure
 * resolveRoomIndexFetch() decision. The error-state guarantee below is
 * unchanged in intent — a failed fetch with nothing valid to show is still
 * a distinct error state, never a silent empty list — only its wiring
 * moved into that function (covered by
 * tests/report-rooms-stale-reconciliation.test.mjs).
 */

async function readComponent() {
  return readFile(new URL("../components/reports/report-rooms.tsx", import.meta.url), "utf8");
}

test("a failed index fetch is a distinct error state (when nothing is cached), never a silent empty/loaded list", async () => {
  const source = await readComponent();
  const effectMatch = source.match(/async function loadIndex\(\) \{[\s\S]*?\n {4}\}/);
  assert.ok(effectMatch, "loadIndex must be found");
  const body = effectMatch[0];

  assert.match(body, /const result = await fetchReportRoomIndex\(\);/);
  assert.match(body, /if \(result\.ok\) \{/);
  // setRoomIndex is GATED by resolveRoomIndexFetch's `rooms` (null on a
  // failed fetch with no cache) — a `{ ok: false }` result with nothing to
  // fall back on can never reach setRoomIndex with empty/undefined data.
  assert.match(body, /const resolution = resolveRoomIndexFetch\(cached, result\);/);
  assert.match(body, /if \(resolution\.rooms\) \{[\s\S]*?setRoomIndex\(/);
  assert.doesNotMatch(body, /setRoomIndex\(result\.rooms\)/, "the fetch result is never rendered directly — it goes through resolveRoomIndexFetch");
  assert.doesNotMatch(body, /setRoomIndex\(cached\)/, "the cache is never rendered before a successful fetch");
  assert.match(body, /setIndexError\(resolution\.error\);/);

  // resolveRoomIndexFetch itself (server-first): a successful fetch is
  // authoritative; a failed fetch falls back to the cache if present, and is
  // a real error state only when there is no cache at all.
  const fnMatch = source.match(/export function resolveRoomIndexFetch\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "resolveRoomIndexFetch must be exported for testing");
  const fn = fnMatch[0];
  assert.match(fn, /if \(result\.ok\) return \{ rooms: result\.rooms, error: false \};/);
  assert.match(fn, /if \(cached\) return \{ rooms: cached, error: false \};/, "a failed fetch falls back to the cache when one exists");
  assert.match(fn, /return \{ rooms: null, error: true \};/, "a failed fetch with no cache is the genuine error state");
});

test("the error state renders before the loading/skeleton check, and never silently renders an empty room list", async () => {
  const source = await readComponent();
  const errorBranchIndex = source.indexOf("if (indexError) {");
  const loadingBranchIndex = source.indexOf("if (indexLoading || !roomIndex) {");
  assert.ok(errorBranchIndex > -1, "an indexError render branch must exist");
  assert.ok(loadingBranchIndex > -1, "the loading/skeleton branch must exist");
  assert.ok(errorBranchIndex < loadingBranchIndex, "the error check must run before the loading/skeleton fallback, so a failed fetch never falls through to a skeleton or (worse) an empty list");

  const errorBranch = source.slice(errorBranchIndex, loadingBranchIndex);
  assert.doesNotMatch(errorBranch, /report-rooms-list/, "the error branch must never render the room-list container — that would look like a real, empty result");
});

test("the error state offers a real retry that re-runs the fetch, and never touches account/session state — that lives entirely in the parent and this component never sees it", async () => {
  const source = await readComponent();
  const errorBranchIndex = source.indexOf("if (indexError) {");
  const loadingBranchIndex = source.indexOf("if (indexLoading || !roomIndex) {");
  const errorBranch = source.slice(errorBranchIndex, loadingBranchIndex);

  assert.match(errorBranch, /You&apos;re still signed in/, "the error message must explicitly reassure the user their session is intact");
  assert.match(errorBranch, /onClick=\{\(\) => setRetryToken\(\(token\) => token \+ 1\)\}/, "a real retry action must be wired up");

  // This component's props are exactly accountEmail + onTotalCountChange —
  // it has no setAccount/signOut-style callback at all, so it structurally
  // cannot clear or touch the parent's signed-in state even by accident.
  assert.doesNotMatch(source, /setAccount|signOut|clearAccountDisplayState/, "this component must have no way to touch the parent's account/session state");

  // retryToken must be a real effect dependency, so clicking "Try again" actually re-fetches.
  assert.match(source, /\}, \[accountEmail, retryToken\]\);/);
});
