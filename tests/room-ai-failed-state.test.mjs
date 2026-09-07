import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deriveRoomStatus } from "../lib/report-rooms.ts";

// Production audit fix: a genuine "failed" AI-lifecycle state, distinct
// from "processing" (still running) and "ready" (a real score landed).
// tests/report-rooms.test.mjs covers the end-to-end server behavior against
// the real API routes; this file covers the pure derivation function
// directly, plus the client-side wiring (My Reports label, the room page's
// dedicated render branch and retry action) via the same source-text
// convention used throughout this test suite for React components with no
// test harness.

test("deriveRoomStatus: 'failed' wins whenever ai_status says so, regardless of ai_score", () => {
  assert.equal(deriveRoomStatus(null, "failed"), "failed");
  // Not expected in practice (a real score alongside a 'failed' status would
  // be a caller bug), but the function itself must still treat ai_status as
  // authoritative rather than silently overriding it from a non-null score.
  assert.equal(deriveRoomStatus(50, "failed"), "failed");
});

test("deriveRoomStatus: legacy/unset ai_status (null) falls back to the original ai_score-only derivation, unchanged", () => {
  assert.equal(deriveRoomStatus(null, null), "processing");
  assert.equal(deriveRoomStatus(0, null), "ready");
  assert.equal(deriveRoomStatus(87, null), "ready");
});

test("deriveRoomStatus: an explicit 'processing' or 'ready' ai_status behaves exactly like the legacy null case", () => {
  assert.equal(deriveRoomStatus(null, "processing"), "processing");
  assert.equal(deriveRoomStatus(20, "ready"), "ready");
});

test("My Reports room-list label distinguishes 'failed' from 'processing' and 'ready'", async () => {
  const source = await readFile(new URL("../components/reports/report-rooms.tsx", import.meta.url), "utf8");
  const fnMatch = source.match(/function statusLabel\(status: RoomStatus\): string \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, "statusLabel function must be found");
  assert.match(fnMatch[0], /if \(status === "failed"\) return /, "statusLabel must have its own branch for the failed status, not fall through to the empty-room default");
});

test("the room page has a dedicated 'failed' render branch — never reuses the 'ready' branch with a blank score", async () => {
  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");

  // Release-hardening audit finding LIFECYCLE-05: both branches additionally
  // require isFullyRevealed(occupant) now — an AI failure alone still gets
  // its own dedicated branch (never reuses "ready" with a blank score), but
  // only once similarity has also resolved; see room-processing-navigation.test.mjs
  // for the dedicated coverage of that combined gate itself.
  assert.match(shell, /\{occupant\.status === "failed" && isFullyRevealed\(occupant\) && occupant\.report && \(/, "a dedicated failed-status render branch must exist");

  const failedBranchStart = shell.indexOf('{occupant.status === "failed" && isFullyRevealed(occupant) && occupant.report && (');
  assert.ok(failedBranchStart > -1);
  const readyBranchStart = shell.indexOf('{occupant.status === "ready" && isFullyRevealed(occupant) && occupant.report && (');
  assert.ok(readyBranchStart > -1 && readyBranchStart < failedBranchStart, "the failed branch must be a sibling of, not nested inside, the ready branch");

  const failedBranch = shell.slice(failedBranchStart);
  assert.match(failedBranch, /onClick=\{\(\) => retryAiCheck\(occupant\.report!\.id\)\}/, "the failed branch must offer a retry action wired to retryAiCheck");
  assert.doesNotMatch(failedBranch.slice(0, failedBranch.indexOf("retryAiCheck")), /room-metric-value">\{occupant\.report\.aiScore/, "the failed branch must never render occupant.report.aiScore as if it were a real value");
});

test("retryAiCheck re-runs AI analysis from the already-extracted text and never re-uploads the document", async () => {
  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  const fnMatch = shell.match(/async function retryAiCheck\([\s\S]*?\n {2}\}/);
  assert.ok(fnMatch, "retryAiCheck function must be found");
  const body = fnMatch[0];
  // Mixed-language misclassification fix: retry no longer reuses
  // full.features.detectedLanguage (which could be a stale, wrong value
  // persisted before this fix shipped) — it recomputes language fresh from
  // the same already-extracted full.text via retryAiAnalysisWithFreshLanguage.
  // Still reuses the already-extracted text, never a freshly chosen file.
  assert.match(body, /retryAiAnalysisWithFreshLanguage\(full\.text\)/, "retry must reuse the already-extracted text from the full stored report, recomputing language fresh rather than trusting a persisted value");
  assert.doesNotMatch(body, /extractFileText\(/, "retry must never re-extract from a freshly chosen file — that's the upload flow, not a retry");
  assert.match(body, /saveEnrichedAiResult\(full, aiResult\)/, "retry must persist through the same save path as the automatic post-upload pass, so the two can never disagree on when a room is 'ready'");
});

test("the stale client-only aiUnavailable flag is gone — a genuine AI failure is now a real, persisted room status, not ephemeral React state", async () => {
  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /aiUnavailable/, "aiUnavailable must be fully removed — its job is now done by occupant.status === \"failed\", which survives a refresh/different tab, unlike the old client-only flag");
});
