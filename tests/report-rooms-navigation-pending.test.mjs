import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  roomNavReducer,
  canActivateRoom,
  shouldRecoverFromSettledTransition,
  IDLE_NAV_STATE,
} from "../components/reports/report-rooms.tsx";

/**
 * Production bug fix: My Reports' room cards (components/reports/report-rooms.tsx)
 * were bare <Link>s with no pending/disabled state at all. A slow or
 * cold-started room-page render (that route had no loading.tsx) left the
 * old page fully interactive with zero feedback, so a user would click
 * other rooms while waiting — each an independent, un-deduped navigation —
 * and whichever one happened to resolve last silently won, overriding
 * whatever the user was already looking at. See production logs: repeated
 * GET /reports/rooms/0, followed by room 1/2 requests, all 200.
 *
 * Post-review correction: the first version of this fix cleared the pending
 * room outright after a 30s safety-net timeout, which would have let a
 * DIFFERENT room start a second, real router.push while the original fetch
 * could still resolve later — reintroducing the exact "last one wins" bug,
 * just delayed. roomNavReducer replaces that with a real state machine
 * (idle -> pending -> stuck -> idle) where TIMEOUT only ever relabels the
 * SAME target, never releases the gate; only a genuine settle (SETTLED) or
 * a hard navigation (Retry, window.location.assign) ever returns to idle.
 *
 * roomNavReducer/canActivateRoom/shouldRecoverFromSettledTransition are
 * real, exported, pure functions — called directly below with explicit
 * event sequences, not string-matched — for exactly the parts of this fix
 * (dedup, single-request, timeout-without-release, retry targeting, and
 * settle-recovery) that matter most and are cleanly separable from
 * rendering. Everything else (visible pending/stuck state, accessible aria
 * semantics, keyboard operability via a real <a href>, timer cleanup) is
 * verified structurally, this suite's established convention for
 * components with no React test harness (this repo has no jsdom/click-
 * simulation infrastructure — see tests/report-historical-ui-consolidation.
 * test.mjs's own "J" test and tests/report-rooms-browser-error-state.test.mjs
 * for the same pattern).
 */

async function readComponent() {
  return readFile(new URL("../components/reports/report-rooms.tsx", import.meta.url), "utf8");
}

function activate(room, href = `/reports/rooms/${room}`) {
  return { type: "ACTIVATE", room, href };
}

// --- canActivateRoom / ACTIVATE: rapid multi-click / single-request --------

test("canActivateRoom: idle allows an activation", () => {
  assert.equal(canActivateRoom(IDLE_NAV_STATE), true);
});

test("roomNavReducer + canActivateRoom: rapid re-clicking the SAME room while pending is refused every time, state never changes", () => {
  let state = roomNavReducer(IDLE_NAV_STATE, activate(0));
  assert.deepEqual(state, { phase: "pending", room: 0, href: "/reports/rooms/0" });
  for (let i = 0; i < 10; i++) {
    assert.equal(canActivateRoom(state), false, `click ${i + 1} on the already-pending room must be refused`);
    const next = roomNavReducer(state, activate(0));
    assert.deepEqual(next, state, "a refused ACTIVATE must never mutate the state");
    state = next;
  }
});

test("roomNavReducer + canActivateRoom: clicking OTHER rooms while one is pending is refused every time — exactly one navigation per activation, across the whole list", () => {
  const pending = roomNavReducer(IDLE_NAV_STATE, activate(0));
  // Simulates the reported scenario: Room 1 (index 0) is pending, the user
  // impatiently clicks Room 2, Room 3, Room 1 again, Room 2 again...
  for (const room of [1, 2, 0, 1, 2, 3, 0]) {
    assert.equal(canActivateRoom(pending), false, `activating room ${room} while room 0 is pending must be refused`);
    assert.deepEqual(roomNavReducer(pending, activate(room)), pending, `state must be unchanged after refusing room ${room}`);
  }
});

test("roomNavReducer: a NEW activation is allowed again once SETTLED returns to idle", () => {
  const pending = roomNavReducer(IDLE_NAV_STATE, activate(2));
  assert.equal(canActivateRoom(pending), false);
  const settled = roomNavReducer(pending, { type: "SETTLED" });
  assert.deepEqual(settled, IDLE_NAV_STATE);
  assert.equal(canActivateRoom(settled), true, "a fresh activation is allowed once idle again");
});

// --- TIMEOUT / stuck: the actual correction under review --------------------

test("1. TIMEOUT fires: pending -> stuck, preserving the exact same room/href", () => {
  const pending = roomNavReducer(IDLE_NAV_STATE, activate(4, "/reports/rooms/4"));
  const stuck = roomNavReducer(pending, { type: "TIMEOUT" });
  assert.deepEqual(stuck, { phase: "stuck", room: 4, href: "/reports/rooms/4" });
});

test("2. after TIMEOUT, a DIFFERENT room remains blocked — canActivateRoom is false and ACTIVATE is a no-op", () => {
  const pending = roomNavReducer(IDLE_NAV_STATE, activate(4));
  const stuck = roomNavReducer(pending, { type: "TIMEOUT" });
  assert.equal(canActivateRoom(stuck), false, "stuck must refuse activation exactly like pending does");
  for (const otherRoom of [0, 1, 2, 3, 5, 6]) {
    const attempted = roomNavReducer(stuck, activate(otherRoom, `/reports/rooms/${otherRoom}`));
    assert.deepEqual(attempted, stuck, `activating room ${otherRoom} after timeout must leave the stuck state on room 4 untouched`);
  }
});

test("3. no second navigation is possible after timeout: the reducer state (which gates the component's own router.push call) never leaves 'stuck' via ACTIVATE", () => {
  const pending = roomNavReducer(IDLE_NAV_STATE, activate(7));
  const stuck = roomNavReducer(pending, { type: "TIMEOUT" });
  // Re-clicking the SAME room after timeout must also refuse — retry is a
  // hard navigation (handleRetry/window.location.assign), never a second
  // router.push through the same activation path.
  const reclicked = roomNavReducer(stuck, activate(7));
  assert.deepEqual(reclicked, stuck, "re-clicking the stuck room itself must not re-enter pending / trigger a second push");
  assert.equal(reclicked.phase, "stuck");
});

test("4. Retry targets only the original room: stuck.href is immutable across every subsequent (refused) ACTIVATE attempt", () => {
  let stuck = roomNavReducer(roomNavReducer(IDLE_NAV_STATE, activate(1, "/reports/rooms/1")), { type: "TIMEOUT" });
  assert.equal(stuck.phase, "stuck");
  assert.equal(stuck.href, "/reports/rooms/1");
  for (const room of [9, 2, 1, 0]) {
    stuck = roomNavReducer(stuck, activate(room, `/reports/rooms/${room}`));
    assert.equal(stuck.phase, "stuck");
    assert.equal(stuck.href, "/reports/rooms/1", `stuck.href must still be the original target after an attempted room-${room} activation`);
    assert.equal(stuck.room, 1);
  }
});

test("TIMEOUT is a no-op from idle or from an already-stuck state (defensive — the effect that dispatches it is structured to never fire twice, but the reducer must not misbehave if it somehow did)", () => {
  assert.deepEqual(roomNavReducer(IDLE_NAV_STATE, { type: "TIMEOUT" }), IDLE_NAV_STATE);
  const stuck = roomNavReducer(roomNavReducer(IDLE_NAV_STATE, activate(3)), { type: "TIMEOUT" });
  assert.deepEqual(roomNavReducer(stuck, { type: "TIMEOUT" }), stuck);
});

test("normal recovery still works past the 30s mark: SETTLED returns a stuck state to idle, unlocking every room again", () => {
  const stuck = roomNavReducer(roomNavReducer(IDLE_NAV_STATE, activate(5)), { type: "TIMEOUT" });
  const settled = roomNavReducer(stuck, { type: "SETTLED" });
  assert.deepEqual(settled, IDLE_NAV_STATE);
  assert.equal(canActivateRoom(settled), true);
  assert.deepEqual(roomNavReducer(settled, activate(9)), { phase: "pending", room: 9, href: "/reports/rooms/9" }, "a genuinely fresh activation for ANY room, including a different one, is allowed once idle again");
});

// --- shouldRecoverFromSettledTransition -------------------------------------

test("shouldRecoverFromSettledTransition: true for a settled transition while pending OR stuck", () => {
  const pending = roomNavReducer(IDLE_NAV_STATE, activate(0));
  const stuck = roomNavReducer(pending, { type: "TIMEOUT" });
  assert.equal(shouldRecoverFromSettledTransition(false, pending), true);
  assert.equal(shouldRecoverFromSettledTransition(false, stuck), true, "recovery must still apply after the timeout, not just before it");
});

test("shouldRecoverFromSettledTransition: false while still in flight, and false when already idle", () => {
  const pending = roomNavReducer(IDLE_NAV_STATE, activate(0));
  assert.equal(shouldRecoverFromSettledTransition(true, pending), false);
  assert.equal(shouldRecoverFromSettledTransition(false, IDLE_NAV_STATE), false);
  assert.equal(shouldRecoverFromSettledTransition(true, IDLE_NAV_STATE), false);
});

// --- structural: exactly one navigation call site, no per-row duplication --

test("structural: startTransition wraps exactly one router.push call, in exactly one place — the mechanism itself cannot fire more than one request per allowed activation", async () => {
  const source = await readComponent();
  const startTransitionCalls = source.match(/startTransition\(/g) ?? [];
  assert.equal(startTransitionCalls.length, 1, "startTransition must be called from exactly one place");
  const routerPushCalls = source.match(/router\.push\(/g) ?? [];
  assert.equal(routerPushCalls.length, 1, "router.push must be called from exactly one place");
  assert.match(source, /startTransition\(\(\) => \{\s*\n\s*router\.push\(href\);/, "router.push must run inside the startTransition callback, not alongside it");
});

test("structural: router.push is gated by canActivateRoom before it can ever fire", async () => {
  const source = await readComponent();
  const handlerMatch = source.match(/function handleRoomActivate\([\s\S]*?\n {2}\}/);
  assert.ok(handlerMatch, "handleRoomActivate must be found");
  const body = handlerMatch[0];
  const gateIndex = body.indexOf("canActivateRoom(navState)");
  const dispatchIndex = body.indexOf('dispatch({ type: "ACTIVATE"');
  const pushIndex = body.indexOf("router.push(href)");
  assert.ok(gateIndex > -1 && dispatchIndex > -1 && pushIndex > -1);
  assert.ok(gateIndex < dispatchIndex && dispatchIndex < pushIndex, "the gate must be checked, then ACTIVATE dispatched, then router.push started — in that order");
});

test("structural: Retry calls window.location.assign with navState.href — a hard navigation, never router.push, and only reachable from the stuck phase", async () => {
  const source = await readComponent();
  const handlerMatch = source.match(/function handleRetry\(\) \{[\s\S]*?\n {2}\}/);
  assert.ok(handlerMatch, "handleRetry must be found");
  const body = handlerMatch[0];
  assert.match(body, /if \(navState\.phase === "stuck"\) window\.location\.assign\(navState\.href\);/);
  assert.doesNotMatch(body, /router\.push/, "Retry must never call router.push — that would be a second SPA transition, the exact thing being prevented");
});

// --- modifier-key / non-primary-click passthrough ---------------------------

test("structural: modified or non-primary clicks (new-tab, etc.) bypass the custom handler entirely, preserving native browser behavior", async () => {
  const source = await readComponent();
  assert.match(
    source,
    /if \(event\.defaultPrevented \|\| event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\) \{\s*\n\s*return;\s*\n\s*\}/,
    "ctrl/cmd/shift/alt/middle-click must return early, before any gating or preventDefault, so \"open in a new tab\" keeps working",
  );
});

// --- visible pending/stuck state + accessible semantics ---------------------

test("structural: the pending target gets aria-busy, an 'Opening…' label, and a spinner instead of the chevron", async () => {
  const source = await readComponent();
  assert.match(source, /aria-busy=\{isThisTarget \? true : undefined\}/);
  assert.match(source, /\{isThisTarget \? "Opening…" : statusLabel\(entry\.status\)\}/);
  assert.match(source, /isThisTarget\s*\n\s*\? <span className="report-room-row-spinner" aria-hidden="true" \/>\s*\n\s*: <ChevronRight/);
});

test("structural: the stuck target renders 'Still opening…' with a Retry button, as a plain div (not a Link) — no click on the row itself can do anything", async () => {
  const source = await readComponent();
  const stuckBranch = source.match(/if \(isThisStuck\) \{[\s\S]*?\n {8}\}/);
  assert.ok(stuckBranch, "the isThisStuck render branch must be found");
  const body = stuckBranch[0];
  assert.doesNotMatch(body, /<Link/, "a stuck row must not be a Link — the only escape hatch is the explicit Retry button");
  assert.match(body, /Still opening…/);
  assert.match(body, /<button type="button" className="report-room-row-retry" onClick=\{handleRetry\}>Retry<\/button>/);
  assert.match(body, /aria-busy="true"/);
});

test("structural: every other room becomes aria-disabled and visually inert while anything is pending or stuck", async () => {
  const source = await readComponent();
  assert.match(source, /const isBlocked = navState\.phase !== "idle" && !isThisTarget;/);
  assert.match(source, /aria-disabled=\{isBlocked \? true : undefined\}/);
  assert.match(source, /report-room-row-blocked/);
});

test("structural: the room-row status text is a live region, so 'Opening…'/'Still opening…' changes are announced", async () => {
  const source = await readComponent();
  const matches = source.match(/aria-live="polite"/g) ?? [];
  assert.ok(matches.length >= 2, "both the pending-Link status text and the stuck-div status text must be live regions");
});

// --- keyboard use: a real, focusable, native <a href> for the normal path --

test("structural: each non-stuck room row is a real Next Link (renders as a native <a href>), not a div/button — Enter-to-activate keeps working natively", async () => {
  const source = await readComponent();
  assert.match(
    source,
    /<Link\s*\n\s*key=\{entry\.room\}\s*\n\s*href=\{href\}[\s\S]*?onClick=\{\(event\) => handleRoomActivate\(event, entry\.room, href\)\}/,
    "href and onClick must be on the same, single Link element",
  );
});

// --- route-level loading fallback: deliberately absent ----------------------

test("app/reports/rooms/[room]/ deliberately has NO loading.tsx — it would break notFound()'s real 404 for an invalid room, same constraint tests/report-detail-route.test.mjs documents for the sibling /reports/[id] route", async () => {
  await assert.rejects(
    () => readFile(new URL("../app/reports/rooms/[room]/loading.tsx", import.meta.url), "utf8"),
    /ENOENT/,
    "a loading.tsx here would flush a 200 before the page's own notFound() check can run",
  );
  const pageSource = await readFile(new URL("../app/reports/rooms/[room]/page.tsx", import.meta.url), "utf8");
  assert.match(pageSource, /notFound\(\)/, "the page must still genuinely rely on notFound() for an invalid room number");
});

// --- 5. timers are cleaned up on navigation/unmount -------------------------

test("5. structural: the timeout effect is keyed on navState identity and returns a real cleanup — a stale timer can never fire against a later/different navState (covers both unmount and any state change, including a successful navigation unmounting the component)", async () => {
  const source = await readComponent();
  const effectMatch = source.match(/useEffect\(\(\) => \{\s*\n\s*if \(navState\.phase !== "pending"\) return;[\s\S]*?\n {2}\}, \[navState\]\);/);
  assert.ok(effectMatch, "the safety-net timeout effect must be found, keyed on [navState]");
  const body = effectMatch[0];
  assert.match(body, /const timer = window\.setTimeout\(\(\) => dispatch\(\{ type: "TIMEOUT" \}\), STUCK_NAVIGATION_TIMEOUT_MS\);/);
  assert.match(body, /return \(\) => window\.clearTimeout\(timer\);/, "the effect must return a cleanup that clears the timer — React runs this on every dependency change and on unmount alike");
});

test("5b. structural: the recovery (SETTLED) effect is similarly a real effect with its own dependency array — it re-evaluates, and any component unmount tears down every effect (including the timer effect above) via React's own guarantee, not a manual flag", async () => {
  const source = await readComponent();
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*\n\s*if \(shouldRecoverFromSettledTransition\(isPending, navState\)\) dispatch\(\{ type: "SETTLED" \}\);\s*\n\s*\}, \[isPending, navState\]\);/,
  );
});
