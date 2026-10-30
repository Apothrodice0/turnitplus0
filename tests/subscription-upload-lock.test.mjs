import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentUploadPanel } from "../components/reports/document-upload-panel.tsx";
import { planBlockMessage, planStateBlockCode, roomCooldownLock, uploadLockFor } from "../lib/account-plan.ts";

// Manual subscriptions (owner decision 2026-10-29): with enforcement on, a customer without an active subscription sees
// the normal upload area LOCKED — dimmed, a lock icon, the subscription message, no file input, no drop target and no
// generate action. The server refuses the same checks on its own (tests/account-activation.test.mjs).

const fileInputRef = { current: null };
function render(props = {}) {
  return renderToStaticMarkup(
    React.createElement(DocumentUploadPanel, {
      file: null,
      isGeneratingReport: false,
      progress: 0,
      processingLabel: "Reading document content",
      fileInputRef,
      onChooseFile: () => {},
      onGenerate: () => {},
      ...props,
    }),
  );
}

test("no subscription: the upload area is locked with the owner's exact message", () => {
  const html = render({ locked: uploadLockFor("ACTIVATION_REQUIRED", null) });
  assert.match(html, /class="drop-zone drop-zone-locked"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /lucide-lock-keyhole/, "a lock icon");
  assert.match(html, />Subscription required</);
  assert.match(html, /You need an active subscription before you can check documents\./);
  assert.match(html, /Please contact TurnitPlus to activate your plan\./);
  assert.doesNotMatch(html, /type="file"/, "no file input to click or drop onto");
  assert.doesNotMatch(html, /Generate (free )?report|Choose file|Drop your document here/);
  assert.match(html, /<button class="button primary full upload-locked-action" type="button" disabled="" aria-disabled="true">/, "the generate action is disabled");
  assert.match(html, /Your account remains available\./);
  assert.doesNotMatch(html, /existing reports/, "no promise about reports without a subscription");
  assert.match(render({ locked: roomCooldownLock(3, Date.UTC(2026, 9, 30, 9, 5)) }), /Your account and existing reports remain available\./, "a room cooldown keeps its line");
});

test("no refusal promises that reports stay available (owner decision 2026-10-30: they are refused, and deleted on expiry)", async () => {
  const { subscriptionNoticeFor } = await import("../lib/account-plan.ts");
  const at = Date.UTC(2026, 9, 1);
  for (const code of ["ACTIVATION_REQUIRED", "PLAN_EXPIRED", "ACCOUNT_SUSPENDED"]) {
    const wording = JSON.stringify([planBlockMessage(code, null), uploadLockFor(code, at), subscriptionNoticeFor(code, at)]);
    assert.doesNotMatch(wording, /reports? (stay|stays|remain|remains)/i, code);
  }
});

test("expired and suspended subscriptions are locked too, with their status line", () => {
  const expiresAt = Date.UTC(2026, 9, 1, 12);
  const expired = render({ locked: uploadLockFor("PLAN_EXPIRED", expiresAt) });
  assert.match(expired, />Subscription required</);
  assert.match(expired, /Please contact TurnitPlus to renew your plan\./);
  assert.match(expired, /Your subscription expired on 1 October 2026/);
  assert.doesNotMatch(expired, /type="file"/);
  const suspended = render({ locked: uploadLockFor("ACCOUNT_SUSPENDED", expiresAt) });
  assert.match(suspended, /Please contact TurnitPlus to restore your plan\./);
  assert.match(suspended, /Your subscription is paused/);
  assert.doesNotMatch(suspended, /type="file"/);
});

test("room-level locks use the same locked design", () => {
  const html = render({ locked: roomCooldownLock(3, Date.UTC(2026, 9, 30, 9, 5)) });
  assert.match(html, />Room cooling down</);
  assert.match(html, /Room 3 accepts a new check again at 30 October 2026, 09:05 UTC\./);
  assert.doesNotMatch(html, /type="file"/);
  assert.match(render({ locked: uploadLockFor("ROOM_NOT_IN_PLAN", null, 5) }), /This room is not part of your plan \(rooms 1–5\)\./);
});

test("unlocked: the normal upload area, and the one action reads Generate report (customers need a subscription — never 'free')", () => {
  const html = render();
  assert.match(html, /type="file"/);
  assert.match(html, /Drop your document here/);
  assert.match(html, />Generate report</);
  assert.doesNotMatch(html, /free report|FREE/i);
  assert.doesNotMatch(html, /drop-zone-locked|Subscription required/);
});

test("a check already running is never replaced by the lock", () => {
  const html = render({ isGeneratingReport: true, progress: 40, locked: uploadLockFor("PLAN_EXPIRED", Date.now()) });
  assert.match(html, /CHECK IN PROGRESS/);
  assert.doesNotMatch(html, /Subscription required/);
});

test("server refusals use the same wording; plan states map to their locks", () => {
  assert.equal(planBlockMessage("ACTIVATION_REQUIRED", null), "You need an active subscription before you can check documents. Please contact TurnitPlus to activate your plan.");
  assert.equal(planStateBlockCode("active"), null);
  assert.equal(planStateBlockCode("none"), "ACTIVATION_REQUIRED");
  assert.equal(planStateBlockCode("expired"), "PLAN_EXPIRED");
  assert.equal(planStateBlockCode("suspended"), "ACCOUNT_SUSPENDED");
  assert.equal(planStateBlockCode("unavailable"), "ACTIVATION_UNAVAILABLE");
});

test("the dashboard and every room wire the lock into the normal upload area", async () => {
  const dashboard = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /locked=\{checkLock\}/);
  assert.match(dashboard, /fetchAccountPlan\(\)/);
  const roomPage = await readFile(new URL("../app/reports/rooms/[room]/page.tsx", import.meta.url), "utf8");
  assert.match(roomPage, /uploadLock=\{result\.uploadLock\}/);
  assert.doesNotMatch(roomPage, /No new check available/, "no separate notice page any more");
  const roomShell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  assert.match(roomShell, /locked=\{uploadLock\}/);
});

test("subscription-required screen: My Reports shows ONE centered card instead of any room; empty room URLs show it too", async () => {
  const { subscriptionNoticeFor } = await import("../lib/account-plan.ts");
  assert.deepEqual(subscriptionNoticeFor("ACTIVATION_REQUIRED", null), {
    title: "Subscription required",
    message: "You need an active subscription before you can check documents.",
    secondary: "Contact TurnitPlus to activate your plan.",
    detail: null,
  });
  assert.equal(subscriptionNoticeFor("PLAN_EXPIRED", Date.UTC(2026, 9, 1)).secondary, "Contact TurnitPlus to renew your plan.");
  assert.match(subscriptionNoticeFor("PLAN_EXPIRED", Date.UTC(2026, 9, 1)).detail, /expired on 1 October 2026/);
  assert.equal(subscriptionNoticeFor("ACCOUNT_SUSPENDED", null).secondary, "Contact TurnitPlus to restore your plan.");

  // the one screen: centered card, lock badge, heading, message, secondary line; links only to rooms holding a report
  const { SubscriptionRequiredState } = await import("../components/reports/subscription-required-state.tsx");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const html = renderToStaticMarkup(React.createElement(SubscriptionRequiredState, {
    notice: subscriptionNoticeFor("PLAN_EXPIRED", Date.UTC(2026, 9, 1)),
  }));
  assert.match(html, /class="subscription-required-stage"/);
  assert.match(html, /class="subscription-required-card"/);
  assert.match(html, /class="subscription-required-icon"><svg/);
  assert.match(html, /<h2 id="subscription-required-title">Subscription required<\/h2>/);
  assert.match(html, /expired on 1 October 2026/);
  assert.doesNotMatch(html, /<a |type="file"|drop-zone|Generate|report-room-row/, "no link, no upload, no room list");
  const bare = renderToStaticMarkup(React.createElement(SubscriptionRequiredState, { notice: subscriptionNoticeFor("ACTIVATION_REQUIRED", null) }));
  assert.doesNotMatch(bare, /subscription-required-back/, "nothing extra without a back link");

  // My Reports: the locked branch returns the screen BEFORE any room row is rendered, and lists only non-empty rooms
  const rooms = await readFile(new URL("../components/reports/report-rooms.tsx", import.meta.url), "utf8");
  const lockedAt = rooms.indexOf("if (planNotice !== null) {");
  assert.ok(lockedAt > 0);
  assert.ok(lockedAt < rooms.indexOf("{roomIndex.map((entry) => {"), "the screen replaces the room list");
  assert.match(rooms, /return <SubscriptionRequiredState notice=\{notice\} \/>;/, "and carries no report link (owner decision 2026-10-30)");
  assert.doesNotMatch(rooms, /className="subscription-notice"/, "the old banner is gone");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /onPlanLockChange=\{setReportsPlanLocked\}/);
  assert.match(page, /reports-card-locked/);

  // a room URL: a blocked account's empty room is the same screen, rendered server-side (never the upload area)
  const roomPage = await readFile(new URL("../app/reports/rooms/[room]/page.tsx", import.meta.url), "utf8");
  assert.match(roomPage, /const accessRefusal = reportAccessRefusal\(policy\);[\s\S]{0,240}status: "subscription-required"/, "decided before any report is read");
  assert.match(roomPage, /<SubscriptionRequiredState notice=\{result\.notice\} backHref="\/#reports" \/>/);

  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.subscription-required-stage \{[^}]*place-items: center/);
  assert.match(css, /@keyframes subscription-card-in/);
  assert.match(css, /@keyframes subscription-lock-float/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.subscription-required-card,\s*\.subscription-required-halo \{ animation: none; \}/);
  assert.doesNotMatch(css, /\.subscription-notice \{/, "the old banner styles are gone");
});
