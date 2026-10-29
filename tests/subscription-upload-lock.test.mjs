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
  assert.match(html, /Your account and existing reports remain available\./);
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

test("My Reports subscription notice: heading, readable message, secondary line, lock icon, responsive styles", async () => {
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
  const rooms = await readFile(new URL("../components/reports/report-rooms.tsx", import.meta.url), "utf8");
  assert.match(rooms, /className="subscription-notice"/);
  assert.match(rooms, /<LockKeyhole aria-hidden="true" \/>/);
  assert.match(rooms, /<h3 id="subscription-notice-title">/);
  assert.doesNotMatch(rooms, /ai-analysis-message report-rooms-plan-notice/, "the old oversized banner is gone");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.subscription-notice h3 \{[^}]*font-size: 16px/);
  assert.match(css, /\.subscription-notice-message \{[^}]*font-size: 14px/);
  assert.match(css, /@media \(max-width: 560px\) \{\s*\.subscription-notice \{/);
});
