import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import { persistAiCompletion } from "../lib/report-ai-completion.ts";
import { storeReportBestEffort } from "../lib/report-store.ts";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import { resetRateForTest } from "../lib/rate-limit.js";

/**
 * Release-hardening audit finding LIFECYCLE-01: a report could get
 * permanently stranded at ai_status='processing' because the AI-enrichment
 * resave (app/reports/rooms/[room]/room-page-shell.tsx's saveEnrichedAiResult,
 * and app/page.tsx's anonymous-flow equivalent) called storeReport/
 * saveReportRemote directly inside an unawaited `.then(...)` with no
 * `.catch()` anywhere in the chain. An IndexedDB rejection there became a
 * genuine unhandled promise rejection, and — since nothing else would ever
 * retry that write — the room's persisted ai_status column simply never
 * moved off "processing", with no route back to a terminal state.
 *
 * lib/report-ai-completion.ts's persistAiCompletion and
 * lib/report-store.ts's storeReportBestEffort are the fix: plain, pure,
 * non-React functions that can be exercised directly here, unlike the two
 * "use client" component files that call them (which this codebase already
 * tests via source-text assertions only — see report-persistence-wiring.test.mjs
 * and room-ai-failed-state.test.mjs's own header comments for why: no React
 * component-test harness exists in this project). Where a scenario is
 * genuinely about component wiring rather than promise-rejection behavior,
 * this file follows that same established source-text convention instead of
 * inventing a new one.
 *
 * This Node test environment has no browser globals at all — no
 * `indexedDB`, no `Worker`. Rather than fighting that with a hand-rolled
 * fake, several tests below use it directly: calling the real storeReport
 * (via storeReportBestEffort) or the real analyzeAiText (via room-page-shell
 * .tsx's exported runAiAnalysis) in this environment IS a genuine,
 * deterministic rejection — a truer test of the failure boundary than a
 * mock would be.
 */

const fakeReport = { id: "report-1", submissionId: "sub-1", title: "essay.pdf" };
const fakeSummary = {
  id: "report-1",
  submissionId: "sub-1",
  title: "essay.pdf",
  createdAt: new Date().toISOString(),
  wordCount: 500,
  archiveScore: 12,
  scoreBand: "Low",
  aiScore: 3,
  aiTone: "low",
  aiStatus: "ready",
};

test("IndexedDB persistence rejection: storeReportBestEffort never throws, even when the underlying store rejects", async () => {
  const rejecting = async () => { throw new Error("QuotaExceededError: simulated IndexedDB failure"); };
  await assert.doesNotReject(storeReportBestEffort(fakeReport, rejecting));
});

test("IndexedDB persistence rejection: storeReportBestEffort still calls through and resolves when the store succeeds", async () => {
  let received = null;
  const succeeding = async (report) => { received = report; };
  await storeReportBestEffort(fakeReport, succeeding);
  assert.deepEqual(received, fakeReport);
});

test("IndexedDB persistence rejection: persistAiCompletion's own local cache write can never block the authoritative remote save — proven against the REAL storeReport, which genuinely rejects here (no indexedDB global in Node)", async () => {
  const okRemote = async () => ({ ok: true });
  const result = await persistAiCompletion(fakeReport, fakeSummary, undefined, okRemote);
  assert.deepEqual(result, { ok: true, summary: fakeSummary });
});

test("AI worker/model rejection: room-page-shell.tsx's runAiAnalysis never rejects, even when the worker itself cannot be constructed (no Worker global in Node)", async () => {
  const { runAiAnalysis } = await import("../app/reports/rooms/[room]/room-page-shell.tsx");
  const result = await runAiAnalysis("some sample document text for analysis", "English");
  assert.equal(result.aiScore, null);
  assert.equal(result.aiAnalysis.status, "error");
  assert.equal(typeof result.aiAnalysis.error, "string");
  assert.ok(result.aiAnalysis.error.length > 0, "a genuine AI failure must carry a useful, non-empty error message, not a blank one");
});

test("report-save/network rejection: persistAiCompletion resolves {ok:false} when the remote save reports a normal, documented failure, never throwing", async () => {
  const failRemote = async () => ({ ok: false, status: 0, quotaExceeded: false, roomOccupied: false });
  const result = await persistAiCompletion(fakeReport, fakeSummary, 3, failRemote);
  assert.deepEqual(result, { ok: false, summary: fakeSummary });
});

test("report-save/network rejection: persistAiCompletion resolves {ok:false} even if the remote save throws unexpectedly (defense in depth — saveReportRemote is documented fail-soft, but this boundary must hold regardless)", async () => {
  const throwingRemote = async () => { throw new Error("simulated unexpected network exception"); };
  await assert.doesNotReject(persistAiCompletion(fakeReport, fakeSummary, 3, throwingRemote));
  const result = await persistAiCompletion(fakeReport, fakeSummary, 3, throwingRemote);
  assert.equal(result.ok, false);
});

test("successful flow unchanged: persistAiCompletion resolves {ok:true} and passes the report/summary/room through to the remote save unmodified", async () => {
  let capturedArgs = null;
  const okRemote = async (report, summary, diagnosticsId, room) => {
    capturedArgs = { report, summary, diagnosticsId, room };
    return { ok: true };
  };
  const result = await persistAiCompletion(fakeReport, fakeSummary, 7, okRemote);
  assert.deepEqual(result, { ok: true, summary: fakeSummary });
  assert.deepEqual(capturedArgs.report, fakeReport);
  assert.deepEqual(capturedArgs.summary, fakeSummary);
  assert.equal(capturedArgs.diagnosticsId, undefined, "persistAiCompletion never threads a diagnostics id through the AI-completion resave — that belongs only to the first/similarity save");
  assert.equal(capturedArgs.room, 7);
});

test("repeated retry/double-click: calling persistAiCompletion twice concurrently for the same report never throws and never corrupts the result — the underlying save is a real UPSERT, so repeated calls are idempotent by construction", async () => {
  let callCount = 0;
  const countingRemote = async () => {
    callCount += 1;
    return { ok: true };
  };
  const [first, second] = await Promise.all([
    persistAiCompletion(fakeReport, fakeSummary, undefined, countingRemote),
    persistAiCompletion(fakeReport, fakeSummary, undefined, countingRemote),
  ]);
  assert.deepEqual(first, { ok: true, summary: fakeSummary });
  assert.deepEqual(second, { ok: true, summary: fakeSummary });
  assert.equal(callCount, 2, "both concurrent calls should reach the remote save independently — safety here comes from the server's own (device_key,id) UPSERT, not from client-side call suppression");
});

test("similarity remaining available when AI fails: runCheck saves the similarity report and marks the room processing BEFORE the AI-completion chain (persistAiCompletion) ever runs — an AI failure downstream can never retroactively touch the already-saved similarity result", async () => {
  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");

  const firstSaveIndex = shell.indexOf("const saveResult = await saveReportRemote(report, summary, academicResult.academicSearchDiagnosticsId, room);");
  const setProcessingIndex = shell.indexOf('setOccupant({ status: "processing", report: summary, cycleEndsAt:');
  const aiChainIndex = shell.indexOf("void completeAiAnalysisWithRecovery(aiAnalysisPromise");

  assert.ok(firstSaveIndex > -1, "the similarity report's own save must be found");
  assert.ok(setProcessingIndex > -1, "the room must be marked processing immediately after the similarity save succeeds");
  assert.ok(aiChainIndex > -1, "the AI-completion chain must be found");
  assert.ok(firstSaveIndex < setProcessingIndex, "the similarity report must be saved before the room is even marked processing");
  assert.ok(setProcessingIndex < aiChainIndex, "the room must already be marked processing (similarity persisted) before the AI-completion chain starts — a later AI failure has nothing left to invalidate");

  // saveEnrichedAiResult only ever spreads {aiScore, aiAnalysis} onto the
  // already-saved report — runAiAnalysis's own return type (module-level,
  // shared by every caller) proves those are its only two fields, so an AI
  // result can structurally never clobber score/archiveScore/archiveMatchedPositions/etc.
  const runAiAnalysisReturnType = shell.match(/export async function runAiAnalysis\(\s*\n\s*text: string,\s*\n\s*detectedLanguage: SimilarityReport\["features"\]\["detectedLanguage"\],\s*\n\s*\): Promise<\{ aiScore: number \| null; aiAnalysis: AiAnalysis \}>/);
  assert.ok(runAiAnalysisReturnType, "runAiAnalysis must only ever resolve {aiScore, aiAnalysis} — any wider shape could risk overwriting similarity fields on spread");
});

test("refresh/reopen after failure, and pre-existing stranded reports: the room's 'processing' branch offers a real retry action once polling is exhausted, not just re-polling the same frozen state — this is also the backward-compatible recovery for any report already stuck at ai_status='processing' before this fix, since deriveRoomStatus treats every processing row identically regardless of age", async () => {
  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");

  // Release-hardening audit finding LIFECYCLE-05: the room card no longer
  // branches on occupant.status === "processing" directly — it branches on
  // !isFullyRevealed(occupant), which also covers an AI/similarity-terminal
  // occupant still waiting on the other pipeline (see room-processing-navigation.test.mjs's
  // own NOT_REVEALED_NEEDLE/READY_NEEDLE constants for the same needles).
  const processingBranchStart = shell.indexOf('{!isFullyRevealed(occupant) && occupant.report && (');
  const readyBranchStart = shell.indexOf('{occupant.status === "ready" && isFullyRevealed(occupant) && occupant.report && (');
  assert.ok(processingBranchStart > -1 && readyBranchStart > processingBranchStart, "the not-revealed branch must be found, before the ready branch");
  const processingBranch = shell.slice(processingBranchStart, readyBranchStart);

  assert.match(processingBranch, /pollExhausted \?/, "the exhausted-poll state must still be distinguished from genuinely still-in-flight");
  assert.match(processingBranch, /onClick=\{checkAgain\}/, "Check again must still be offered — another tab/device may genuinely still be finishing");
  assert.match(
    processingBranch,
    /onClick=\{\(\) => retryAiCheck\(occupant\.report!\.id\)\} disabled=\{retryingAi\}/,
    "a genuine retry action (the same retryAiCheck already trusted for the failed branch) must be reachable from the exhausted-poll processing state — this is the only thing that can recover a room that never reached 'failed' in the first place, whether it got stuck today or was stranded before this fix shipped",
  );
});

test("successful retry: retryAiCheck persists through the same persistAiCompletion-backed saveEnrichedAiResult path as the automatic pass, so a retry after failure and the original attempt can never disagree on how a room becomes ready", async () => {
  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");

  const retryBody = shell.match(/async function retryAiCheck\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(retryBody.length > 0, "retryAiCheck function body must be found");
  assert.match(retryBody, /if \(retryingAi\) return;/, "repeated retry/double-click must still be debounced client-side");
  assert.match(retryBody, /saveEnrichedAiResult\(full, aiResult\)/, "retry must go through the same saveEnrichedAiResult helper — now persistAiCompletion-backed — as the automatic post-upload pass");

  const helperBody = shell.match(/async function saveEnrichedAiResult\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(helperBody, /await persistAiCompletion\(enriched, enrichedSummary, room\)/);
});

test("app/page.tsx's anonymous-flow twin of the same bug is fixed the same way: the AI-completion merge persists through persistAiCompletion and the chain ends in a real .catch()", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /import \{ persistAiCompletion \} from "@\/lib\/report-ai-completion";/);
  assert.match(page, /await persistAiCompletion\(enriched, enrichedSummary\);/);
  assert.doesNotMatch(page, /await storeReport\(enriched\)/, "the AI-completion merge must no longer call storeReport directly — persistAiCompletion owns that now");

  const aiMergeBlockStart = page.indexOf("void aiAnalysisPromise");
  const aiMergeBlockEnd = page.indexOf("});", aiMergeBlockStart);
  const aiMergeBlock = page.slice(aiMergeBlockStart, aiMergeBlockEnd + 3);
  assert.match(aiMergeBlock, /\.catch\(\(error\) => \{/, "the anonymous-flow AI merge must also end in a real .catch()");

  // The first/similarity save also moved to storeReportBestEffort, for the
  // same reason: an IndexedDB failure there must not silently abort the
  // whole generateReport() flow before the authoritative remote save ever
  // runs.
  assert.match(page, /await storeReportBestEffort\(report\);\s*\n\s*return await saveReportRemote\(report, summary, academicSearchDiagnosticsId\);/);
});

/**
 * Release-hardening audit finding LIFECYCLE-01 (follow-up): a bare
 * `.catch()` on the automatic post-upload chain would avoid an unhandled
 * rejection, but if aiAnalysisPromise itself ever rejected (an invariant
 * runAiAnalysis currently guarantees, but not one this boundary should
 * depend on), a bare catch would skip saveEnrichedAiResult entirely —
 * leaving the room stuck at "processing" with no attempt ever made to move
 * it off that status. completeAiAnalysisWithRecovery (extracted from
 * room-page-shell.tsx specifically so it's directly testable without a
 * React render) closes that gap: on any rejection, it still calls `save`
 * with a genuine "failed" terminal result.
 */
test("directly rejected aiAnalysisPromise: completeAiAnalysisWithRecovery still ATTEMPTS terminal failed persistence, never just logging and swallowing", async () => {
  const { completeAiAnalysisWithRecovery } = await import("../app/reports/rooms/[room]/room-page-shell.tsx");

  let savedWith = null;
  const save = async (aiResult) => {
    savedWith = aiResult;
    return true;
  };

  const rejected = Promise.reject(new Error("simulated direct rejection of aiAnalysisPromise"));
  const outcome = await completeAiAnalysisWithRecovery(rejected, save);

  assert.equal(outcome, true, "the recovery attempt succeeded, so the overall result must reflect that");
  assert.ok(savedWith, "save must have been called — a rejected aiAnalysisPromise must never just be logged and discarded");
  assert.equal(savedWith.aiScore, null);
  assert.equal(savedWith.aiAnalysis.status, "error", "the persisted result must be a genuine terminal 'failed' shape, not a fabricated success");
  assert.match(savedWith.aiAnalysis.error, /simulated direct rejection/, "the real error must be carried through, not swallowed");
});

test("directly rejected aiAnalysisPromise: if the recovery persistence attempt ALSO fails, completeAiAnalysisWithRecovery still resolves false rather than throwing a second time (no unhandled rejection either way)", async () => {
  const { completeAiAnalysisWithRecovery } = await import("../app/reports/rooms/[room]/room-page-shell.tsx");

  const alwaysFailingSave = async () => { throw new Error("persistence also broken"); };
  await assert.doesNotReject(completeAiAnalysisWithRecovery(Promise.reject(new Error("boom")), alwaysFailingSave));
  const outcome = await completeAiAnalysisWithRecovery(Promise.reject(new Error("boom")), alwaysFailingSave);
  assert.equal(outcome, false);
});

test("directly rejected aiAnalysisPromise: the happy path is unaffected — a resolving promise is saved as-is, recovery never runs", async () => {
  const { completeAiAnalysisWithRecovery } = await import("../app/reports/rooms/[room]/room-page-shell.tsx");

  let savedWith = null;
  const save = async (aiResult) => {
    savedWith = aiResult;
    return true;
  };
  const resolved = Promise.resolve({ aiScore: 17, aiAnalysis: { status: "complete" } });
  const outcome = await completeAiAnalysisWithRecovery(resolved, save);
  assert.equal(outcome, true);
  assert.deepEqual(savedWith, { aiScore: 17, aiAnalysis: { status: "complete" } });
});

/**
 * Release-hardening audit finding LIFECYCLE-02: two AI-completion resaves
 * for the same report can race (the automatic post-upload pass in one tab
 * still finishing while a different tab/device's "Retry analysis" also
 * completes). Proven here against the REAL POST /api/reports route and a
 * real on-disk database — not a unit-level stand-in — because the guarantee
 * this test exists to prove ("ready" is a sticky terminal state with
 * respect to a later "failed" write) can only be verified where the race
 * actually resolves: the server's own UPSERT. See app/api/reports/route.ts's
 * SAVE_REPORT_SQL for the CASE-guarded columns this test exercises.
 */
{
  const raceDbFile = path.join(process.cwd(), "test_report_ai_completion_race.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${raceDbFile}${suffix}`;
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
  process.env.TURSO_DATABASE_URL = `file:${raceDbFile}`;
  const raceSetupClient = createClient({ url: `file:${raceDbFile}` });
  await applyMigrationsLibsql(raceSetupClient, path.join(process.cwd(), "drizzle"));
  raceSetupClient.close();

  let raceCounter = 0;
  async function postRaceReport(overrides) {
    raceCounter += 1;
    await resetRateForTest(`race-post-${raceCounter}`);
    const req = new Request("http://localhost/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `race-post-${raceCounter}` },
      body: JSON.stringify({
        deviceKey: "race-device",
        submissionId: "race-sub",
        title: "race.pdf",
        createdAt: new Date().toISOString(),
        wordCount: 10,
        archiveScore: 0,
        scoreBand: "Low",
        payload: { note: "race" },
        ...overrides,
      }),
    });
    return reportsRoute.POST(req);
  }

  async function readRaceRow(id) {
    const client = createClient({ url: `file:${raceDbFile}` });
    try {
      const result = await client.execute({
        sql: "SELECT ai_score, ai_tone, ai_status, payload_json FROM saved_reports WHERE device_key = ? AND id = ?",
        args: ["race-device", id],
      });
      return result.rows[0] ?? null;
    } finally {
      client.close();
    }
  }

  test("concurrent opposite outcomes: ready arrives first, a late failure arrives second — ready must never be downgraded", async () => {
    const id = "race-report-ready-then-failed";
    const first = await postRaceReport({ id, aiScore: null, aiTone: null, aiStatus: "processing" });
    assert.equal(first.status, 200);

    const readyRes = await postRaceReport({ id, aiScore: 88, aiTone: "high", aiStatus: "ready", payload: { note: "ready-payload" } });
    assert.equal(readyRes.status, 200);

    const lateFailedRes = await postRaceReport({ id, aiScore: null, aiTone: null, aiStatus: "failed", payload: { note: "failed-payload" } });
    assert.equal(lateFailedRes.status, 200, "the late write itself must still succeed — it's a no-op for the AI columns, not a rejected request");

    const row = await readRaceRow(id);
    assert.equal(row.ai_status, "ready", "a late-arriving 'failed' must never downgrade an already-'ready' row");
    assert.equal(Number(row.ai_score), 88, "the real AI score must survive the late failure");
    assert.equal(row.ai_tone, "high");
    assert.deepEqual(JSON.parse(row.payload_json), { note: "ready-payload" }, "payload_json must also stay the ready version — a partial downgrade (columns preserved, payload overwritten) would still corrupt what /reports/[id] renders");
  });

  test("concurrent opposite outcomes: failed arrives first, ready arrives second (a genuine late success) — ready must still win, matching normal retry behavior", async () => {
    const id = "race-report-failed-then-ready";
    const first = await postRaceReport({ id, aiScore: null, aiTone: null, aiStatus: "processing" });
    assert.equal(first.status, 200);

    const failedRes = await postRaceReport({ id, aiScore: null, aiTone: null, aiStatus: "failed", payload: { note: "failed-payload" } });
    assert.equal(failedRes.status, 200);

    const readyRes = await postRaceReport({ id, aiScore: 55, aiTone: "low", aiStatus: "ready", payload: { note: "ready-payload" } });
    assert.equal(readyRes.status, 200);

    const row = await readRaceRow(id);
    assert.equal(row.ai_status, "ready", "a genuine later success (e.g. a manual retry) must still be able to upgrade a failed row to ready");
    assert.equal(Number(row.ai_score), 55);
    assert.deepEqual(JSON.parse(row.payload_json), { note: "ready-payload" });
  });

  test("concurrent opposite outcomes: every other transition is untouched by the guard (processing->failed, failed->failed, ready->ready)", async () => {
    const processingToFailedId = "race-report-processing-to-failed";
    await postRaceReport({ id: processingToFailedId, aiScore: null, aiTone: null, aiStatus: "processing" });
    await postRaceReport({ id: processingToFailedId, aiScore: null, aiTone: null, aiStatus: "failed", payload: { note: "failed-payload" } });
    const processingToFailedRow = await readRaceRow(processingToFailedId);
    assert.equal(processingToFailedRow.ai_status, "failed", "processing -> failed must still work exactly as before the guard");

    const readyToReadyId = "race-report-ready-to-ready";
    await postRaceReport({ id: readyToReadyId, aiScore: null, aiTone: null, aiStatus: "processing" });
    await postRaceReport({ id: readyToReadyId, aiScore: 10, aiTone: "low", aiStatus: "ready", payload: { note: "first-ready" } });
    await postRaceReport({ id: readyToReadyId, aiScore: 20, aiTone: "moderate", aiStatus: "ready", payload: { note: "second-ready" } });
    const readyToReadyRow = await readRaceRow(readyToReadyId);
    assert.equal(readyToReadyRow.ai_status, "ready");
    assert.equal(Number(readyToReadyRow.ai_score), 20, "a second genuine ready result (e.g. re-running retry after an already-ready state) must still be able to update the score normally — the guard only protects against a 'failed' downgrade");
  });

  // Best-effort cleanup, matching tests/api-ingest.test.mjs's own convention
  // for a scratch on-disk database: not asserted, since a still-pooled
  // libsql connection can legitimately hold the file locked on Windows for
  // a moment after the last query completes.
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${raceDbFile}${suffix}`); } catch { /* best-effort */ }
  }
}
