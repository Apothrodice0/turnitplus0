import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./helpers/ssr-next-hooks.mjs", import.meta.url);

import * as fx from "./helpers/large-report-retry-fixture.mjs";
import { createKit, sha, num, payloadOf, lastPost, bytesOf } from "./helpers/ai-compact-integration-kit.mjs";
import { synthProse } from "./helpers/real-ai-windows.mjs";
import { fetchRemoteReport, fetchReportRoomContents } from "../lib/reports-remote.ts";
import { persistAiCompletion, persistAiRetryResult } from "../lib/report-ai-completion.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES, persistedPayloadSize } from "../lib/report-transport-limits.ts";
import { prepareAiAnalysisForTransport } from "../lib/ai-passage-table.ts";
import * as unavailable from "../lib/ai-unavailable-state.ts";
import { computeDetailRevealState } from "../lib/report-detail-poll.ts";

const roomShell = await import("../app/reports/rooms/[room]/room-page-shell.tsx");

/**
 * G2 — POLICY_B_KEEP_REPORT_AI_UNAVAILABLE_FOR_SIZE: the two HEAVY regressions, real handlers, throwaway DB, synthetic text only.
 * (The rest of the policy is in tests/ai-size-unavailable-policy.test.mjs; this file is separate on purpose — it builds multi-hundred-
 * thousand-word manuscripts and AI results, and a load-related native teardown flake here must not take that suite down with it.)
 *
 *   1. ~1.85M characters (browser-engine regime — the server archive engine's 1,000,000-character cap does not apply there): the first
 *      save is accepted and similarity resolves; the automatic AI save used to 413 and the report stayed `processing` forever, with Retry
 *      a deterministic 413 too. Now it reaches a terminal state, similarity is unchanged, the room and detail open, and there is no loop.
 *   2. DENSE EVIDENCE inside the ~1M matcher regime (manuscript <= 1,000,000 characters, ten promoted corpus sources embedded verbatim):
 *      the first save fits but its persisted evidence leaves no room for the real compact AI result. Same policy, same outcome.
 *   3. The real result is never replaced by the marker when it fits (small / medium / ~600k / ~850k / ~1M low-evidence manuscripts).
 *   4. KNOWN BOUNDARY: with the ai-compact-v1 WRITER gate at its shipped default (OFF) a result whose legacy form exceeds the request
 *      ceiling cannot even be SENT — unchanged by this policy, and exactly what activating the writer resolves. Pinned so it is visible.
 *
 * Both writer gates — report-compact-persistence (C2) and ai-compact-v1 — are pinned ON (process-locally) for 1–3 — the full
 * activation configuration — and restored afterwards. Dense evidence (case 2) needs C2 ON to fit the first save at all: under
 * deterministic matching (matchAgainstUserSubmissionCorpus no longer wall-clock budgeted) the expanded persisted form of a full
 * ten-source match reliably exceeds the persistence limit, where the compact form does not.
 * Set G2_SIZE_REGRESSION_OUT=<dir> to have the measurements written as JSON.
 */

const MAX = MAX_REPORT_SAVE_REQUEST_BYTES;
const MARKER = unavailable.buildSizeUnavailableAiAnalysis();
const OUT = process.env.G2_SIZE_REGRESSION_OUT;
const writeOut = (name, value) => { if (OUT) fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2)); };

const env = await fx.createFixtureEnvironment("g2_size_large");
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const kit = createKit(env);
const restoreC2 = fx.pinCompactWrites("true");
const restoreAi = fx.pinAiCompactWrites("true");
test.after(() => {
  restoreAi();
  restoreC2();
  env.dispose();
});

const enrich = (report, aiAnalysis, aiScore = 7) => kit.readyEnrichment(report, aiAnalysis, aiScore);

/** The stored row's AI columns and its size in the CANONICAL persisted-size unit (persistedPayloadSize: UTF-16 units of the stored JSON), not SQL length(). */
async function rowStats(id) {
  const result = await env.client.execute({ sql: "SELECT ai_status, ai_score, ai_tone, payload_json FROM saved_reports WHERE id = ?", args: [id] });
  const row = result.rows[0];
  if (!row) return null;
  const payload = String(row.payload_json);
  const ai = JSON.parse(payload).aiAnalysis;
  return { ai_status: row.ai_status, ai_score: num(row.ai_score), ai_tone: row.ai_tone, chars: persistedPayloadSize(payload), aiChars: ai === undefined ? null : JSON.stringify(ai).length };
}

/** The canonical size the report WOULD have with `analysis` merged in (an actual json_set in a rolled-back transaction, read back as a JS string). */
async function mergedUnits(id, analysis, rawAiScore) {
  const tx = await env.client.transaction("write");
  try {
    await tx.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.aiAnalysis', json(?), '$.aiScore', ?) WHERE id = ?", args: [JSON.stringify(analysis), rawAiScore, id] });
    return persistedPayloadSize(String((await tx.execute({ sql: "SELECT payload_json FROM saved_reports WHERE id = ?", args: [id] })).rows[0].payload_json));
  } finally {
    await tx.rollback().catch(() => {});
    tx.close();
  }
}

async function subtrees(id) {
  const result = await env.client.execute({
    sql: `SELECT json_extract(payload_json, '$.unifiedSimilarity') AS us, json_extract(payload_json, '$.evidenceInterpretation') AS ei,
                 json_extract(payload_json, '$.reportCompletion') AS rc, json_extract(payload_json, '$.unifiedSimilarityGeneration') AS gen FROM saved_reports WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0];
  return sha(JSON.stringify([String(row.us), String(row.ei), String(row.rc), num(row.gen)]));
}

const renderRoom = (occupant) => renderToStaticMarkup(React.createElement(roomShell.RoomPageShell, { room: 0, accountEmail: "large@example.test", initialOccupant: occupant }));

/** Everything a customer-facing surface decides from, for a size-unavailable report — asserted identically for both regressions. */
async function assertCustomerSurfaces(id, before, label) {
  const roomFetch = await fetchReportRoomContents(before.room);
  assert.equal(roomFetch.ok, true, label);
  const contents = roomFetch.contents;
  assert.equal(contents.status, "failed", `${label}: room status`);
  assert.equal(contents.report.aiUnavailableReason, "REPORT_SIZE", `${label}: the room carries the server's reason`);
  assert.equal(contents.report.similarityStatus, "resolved", `${label}: similarity resolved`);
  assert.equal(contents.report.primaryScore, before.primaryScore, `${label}: similarity unchanged`);
  assert.equal(roomShell.isFullyRevealed(contents), true, `${label}: room fully revealed`);
  assert.equal(roomShell.evaluatePollTick(roomFetch, 1, roomShell.MAX_POLL_ATTEMPTS).outcome, "revealed", `${label}: polling ends`);
  const html = renderRoom(contents);
  for (const banned of [/Retry analysis/, /Try again/, /Analyzing/, /Preparing/]) assert.doesNotMatch(html, banned, `${label}: room copy`);
  assert.match(html, />Download</, `${label}: receipt available`);
  assert.match(html, /Open full report/, `${label}: detail reachable`);
  assert.equal((html.match(/\d+%/g) ?? []).length, 1, `${label}: the only percentage is the similarity result`);
  const detail = await fetchRemoteReport(id);
  assert.ok(detail, `${label}: the owner GET opens the report`);
  assert.equal(detail.aiAnalysis.unavailableReason, "REPORT_SIZE");
  assert.equal(detail.unifiedSimilarity.unifiedScore, before.unifiedScore, `${label}: same similarity score in the report`);
  assert.deepEqual(computeDetailRevealState({ aiStatus: "failed", similarityStatus: "resolved", pollExhausted: false }), { screen: "revealed", aiUnavailable: true, similarityUnavailable: false });
  assert.deepEqual(await fetchReportRoomContents(before.room), roomFetch, `${label}: refresh is stable`);
  return { room: contents.status, detailOpens: true };
}

// ----------------------------------------------------------------------------------------------------------------
// 1. ~1.85M characters
// ----------------------------------------------------------------------------------------------------------------

test("REGRESSION 1.85M: a ~1.85M-character report (first save accepted, similarity resolved) whose automatic AI save used to 413 and whose Retry used to 413 forever now reaches a terminal state — no 413 loop, similarity byte-identical, room and detail open, Retry hidden", async () => {
  const account = await env.signUpAccount();
  const text = synthProse(1_850_000, { seed: 4242, messiness: 0.01 });
  const ai = fx.syntheticAiAnalysis(text);
  const compactBytes = bytesOf(prepareAiAnalysisForTransport(ai, text, { compactWrites: true }));
  const out = { manuscriptChars: text.length, ceiling: MAX, node: process.version, aiWindows: ai.passages.length, legacyAiBytes: bytesOf(ai), compactAiBytes: compactBytes };

  await kit.asBrowser(account, async (route) => {
    const id = "lg1850-a";
    // ---- initial save: accepted, similarity resolved, room 'processing'
    const report = await kit.firstSave(account, id, text, 0);
    const first = lastPost(route);
    assert.equal(first.status, 200, "the first save is accepted");
    const before = await rowStats(id);
    assert.equal(before.ai_status, "processing");
    assert.ok(before.chars <= MAX - unavailable.TERMINAL_AI_RESERVE_CHARS, `the accepted report (${before.chars}) leaves the terminal-AI reserve free`);
    const fullBefore = await fetchRemoteReport(id);
    assert.ok(fullBefore.unifiedSimilarity, "similarity resolved at first save");
    const roomBefore = await fetchReportRoomContents(0);
    assert.equal(roomBefore.contents.status, "processing");
    assert.equal(roomBefore.contents.report.similarityStatus, "resolved");
    assert.equal(roomShell.isFullyRevealed(roomBefore.contents), false, "before the AI half is terminal the room withholds the finished report");
    const subtreesBefore = await subtrees(id);
    const surfaces = { room: 0, primaryScore: roomBefore.contents.report.primaryScore, unifiedScore: fullBefore.unifiedSimilarity.unifiedScore };
    out.initialSave = { status: first.status, requestBytes: first.bytes, persistedChars: before.chars, headroomChars: MAX - before.chars };

    // ---- the automatic AI save (whole-report resave first, as before)
    const { enriched, summary } = enrich(report, ai);
    const auto = await persistAiCompletion(enriched, summary, 0);
    const whole = route.requests.filter((r) => r.path === "/api/reports" && r.method === "POST").at(-1);
    const narrow = route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).at(-1);
    assert.equal(whole.status, 413, "the whole-report resave is still refused for size (the limits were not raised)");
    assert.ok(whole.bytes > MAX, `that request (${whole.bytes}) is over the request ceiling — as before`);
    assert.ok(narrow, "the automatic path fell back to the narrow route");
    assert.equal(narrow.status, 200, "no 413");
    assert.ok(narrow.bytes < MAX / 4, `the fallback request (${narrow.bytes}) is small: it carries only the compact AI result`);
    assert.equal(auto.ok, true, "the automatic save reached a terminal state");
    assert.equal(auto.summary.aiStatus, "failed");
    assert.equal(auto.summary.aiScore, null);
    assert.equal(auto.summary.aiUnavailableReason, "REPORT_SIZE");

    // ---- terminal, and the similarity half untouched
    const after = await rowStats(id);
    assert.equal(after.ai_status, "failed", "never 'processing' any more");
    assert.equal(after.ai_score, null, "no AI score");
    assert.equal(after.ai_tone, "unavailable");
    assert.ok(after.chars <= MAX, "the saved report fits the unchanged ceiling");
    assert.ok(after.aiChars < 400, `only the tiny marker was added (${after.aiChars} chars), not the ${compactBytes}-byte real result`);
    assert.deepEqual(payloadOf(await kit.readRow(id)).aiAnalysis, MARKER);
    assert.equal(await subtrees(id), subtreesBefore, "CASE_1850K_SIMILARITY_CHANGED = NO: unifiedSimilarity / evidenceInterpretation / reportCompletion / generation byte-identical");
    out.automaticAiSave = { wholeReportStatus: whole.status, wholeReportBytes: whole.bytes, fallbackStatus: narrow.status, fallbackBytes: narrow.bytes, aiStatusAfter: after.ai_status, markerChars: after.aiChars, persistedCharsAfter: after.chars };

    // ---- what the customer gets
    out.customer = await assertCustomerSurfaces(id, surfaces, "1.85M");

    // ---- Retry: hidden in the UI; a stale client that still sends it gets a 200 and the same terminal state — never a 413 loop
    const beforeRetry = await rowStats(id);
    const snapshot = sha(JSON.stringify(await kit.readRow(id)));
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const retried = await persistAiRetryResult(enriched, summary);
      const retryRequest = route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).at(-1);
      assert.equal(retryRequest.status, 200, `stale Retry #${attempt}: not a 413`);
      assert.equal(retried.ok, true);
      assert.equal(retried.summary.aiUnavailableReason, "REPORT_SIZE");
    }
    assert.equal(sha(JSON.stringify(await kit.readRow(id))), snapshot, "and nothing changed");
    assert.deepEqual(await rowStats(id), beforeRetry);
    out.staleRetry = { status: 200, attempts: 2, rowUnchanged: true };
  });
  out.result = { CASE_1850K_TERMINATES: true, CASE_1850K_SIMILARITY_CHANGED: false, CASE_1850K_RETRY_413_LOOP: false };
  writeOut("1850k-regression.json", out);
});

// ----------------------------------------------------------------------------------------------------------------
// 2. DENSE EVIDENCE (~1M matcher regime)
// ----------------------------------------------------------------------------------------------------------------

test("REGRESSION DENSE ~1M: a dense-evidence report inside the production matcher regime (<= 1,000,000 chars) whose persisted evidence leaves no room for the real compact AI result gets the terminal marker — similarity byte-identical, report opens, Retry hidden", async () => {
  const W = 13_000;
  const corpus = fx.buildCorpusPassages(W);
  for (const passage of corpus) await env.promoteDocumentIntoCorpus(passage);
  const text = fx.buildMatchedManuscript(corpus.map((p) => p.split(/\s+/).slice(0, W).join(" ")));
  assert.ok(text.length <= 1_000_000, `fixture sanity: inside the server archive engine's own cap (${text.length})`);
  const account = await env.signUpAccount();
  const ai = fx.syntheticAiAnalysis(text);
  const wire = prepareAiAnalysisForTransport(ai, text, { compactWrites: true });
  const aiChars = JSON.stringify(wire).length;
  const out = { passageWords: W, manuscriptChars: text.length, node: process.version, ceiling: MAX, compactAiChars: aiChars };

  await kit.asBrowser(account, async (route) => {
    const id = "lgdense-a";
    const report = await kit.firstSave(account, id, text, 0);
    assert.equal(lastPost(route).status, 200, "the first save fits");
    const first = await rowStats(id);
    const fullBefore = await fetchRemoteReport(id);
    const matched = fullBefore.unifiedSimilarity.matchedPositions?.length ?? 0;
    assert.ok(matched > 10_000, `dense evidence: ${matched} matched positions`);
    assert.equal(fullBefore.reportCompletion?.state, "COMPLETED");
    assert.ok(first.chars > 1_500_000, `the persisted report is dominated by evidence (${first.chars}, ${(first.chars / MAX * 100).toFixed(1)} % of the ceiling)`);
    assert.ok(first.chars <= MAX - unavailable.TERMINAL_AI_RESERVE_CHARS);

    // The persisted evidence size is not a pure function of the manuscript (the matcher is wall-clock budgeted; identical input has
    // varied by ~165k chars between runs). So the "no room left" condition is made deterministic — and only when the natural run does not
    // already produce it — by growing the stored report with a plain filler field until the real result exceeds the ceiling by one char.
    // The evidence itself (hundreds of KB) is the real one; the filler is recorded and bounded.
    const RAW = 7; // the raw score the automatic fallback sends (enrich() -> aiScore 7)
    const natural = await mergedUnits(id, wire, RAW);
    let fillerChars = 0;
    if (natural <= MAX) {
      const setFiller = (n) => env.client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.__pad', ?) WHERE id = ?", args: ["p".repeat(n), id] });
      fillerChars = MAX + 1 - natural - ',"__pad":""'.length;
      await setFiller(fillerChars);
      fillerChars += MAX + 1 - (await mergedUnits(id, wire, RAW)); // exact: the merged report is now one unit over the ceiling
      await setFiller(fillerChars);
      assert.ok(fillerChars < MAX * 0.2, `the filler (${fillerChars}) stays small next to the evidence`);
    }
    assert.ok((await mergedUnits(id, wire, RAW)) > MAX, "fixture sanity: the real compact result no longer fits next to the report (canonical units, measured on the actual merge)");
    const subtreesBefore = await subtrees(id);
    const roomBefore = await fetchReportRoomContents(0);
    const surfaces = { room: 0, primaryScore: roomBefore.contents.report.primaryScore, unifiedScore: fullBefore.unifiedSimilarity.unifiedScore };

    // The automatic path resaves the WHOLE report, and the server re-finalizes it from the client's payload (not from the padded stored
    // row) — so the same filler, plus a margin larger than the observed run-to-run evidence variance, rides in the client's echo:
    // the resave's persisted size then exceeds the ceiling with the request itself well inside it — the failure mode this case
    // exists to reproduce (PERSISTED_PAYLOAD_TOO_LARGE at a request ~half the ceiling).
    const { enriched, summary } = enrich(report, ai);
    const echo = { ...enriched, padding: "x".repeat(fillerChars + 250_000) };
    const auto = await persistAiCompletion(echo, summary, 0);
    const whole = route.requests.filter((r) => r.path === "/api/reports" && r.method === "POST").at(-1);
    const narrow = route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).at(-1);
    assert.equal(whole.status, 413, "the whole-report resave is refused for size");
    assert.ok(narrow, "and the automatic path fell back to the narrow route");
    assert.equal(auto.ok, true);
    assert.equal(narrow.status, 200, "no 413 anywhere on the way to the terminal state");
    assert.equal(auto.summary.aiUnavailableReason, "REPORT_SIZE");
    out.wholeReportResave = { status: whole.status, requestBytes: whole.bytes, requestPctOfCeiling: +(whole.bytes / MAX * 100).toFixed(1) };

    const after = await rowStats(id);
    assert.equal(after.ai_status, "failed");
    assert.equal(after.ai_score, null);
    assert.deepEqual(payloadOf(await kit.readRow(id)).aiAnalysis, MARKER);
    assert.ok(after.chars <= MAX);
    assert.equal(await subtrees(id), subtreesBefore, "similarity / evidence / completion byte-identical");
    out.firstSave = { persistedChars: first.chars, pctOfCeiling: +(first.chars / MAX * 100).toFixed(1), matchedPositions: matched, unifiedScore: surfaces.unifiedScore, reportCompletion: fullBefore.reportCompletion?.state };
    out.forcedNoRoom = { fillerChars, naturalMergedUnits: natural, naturallyOverCeiling: natural > MAX, unit: "UTF-16 code units of the serialized JSON (persistedPayloadSize)" };
    out.automaticAiSave = { fallbackStatus: narrow.status, aiStatusAfter: after.ai_status, markerChars: after.aiChars, persistedCharsAfter: after.chars };
    out.customer = await assertCustomerSurfaces(id, surfaces, "dense ~1M");

    // Retry (stale client): idempotent, 200.
    const retried = await persistAiRetryResult(echo, summary);
    assert.equal(route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).at(-1).status, 200);
    assert.equal(retried.summary.aiUnavailableReason, "REPORT_SIZE");
  });
  out.result = { DENSE_1M_SIZE_UNAVAILABLE: "PASS" };
  writeOut("dense-1m-regression.json", out);
});

// ----------------------------------------------------------------------------------------------------------------
// 3. NORMAL REAL RESULT — never replaced by the marker when it fits
// ----------------------------------------------------------------------------------------------------------------

test("NORMAL REAL RESULT: small / medium / ~600k / ~850k / ~1M reports whose compact real result fits get that real result — ready, scored, byte-for-byte the analysis the model produced — never the marker", async () => {
  const account = await env.signUpAccount();
  const rows = [];
  await kit.asBrowser(account, async (route) => {
    let room = 0;
    for (const chars of [20_000, 120_000, 600_000, 850_000, 1_000_000]) {
      const text = synthProse(chars, { seed: 700 + room, messiness: 0.01 });
      const id = `lgnorm-${chars}`;
      const report = await kit.firstSave(account, id, text, room);
      const ai = fx.syntheticAiAnalysis(text);
      const { enriched, summary } = enrich(report, ai);
      const subtreesBefore = await subtrees(id);
      const saved = await persistAiCompletion(enriched, summary, room);
      const after = await rowStats(id);
      assert.equal(saved.ok, true, `${chars}: saved`);
      assert.equal(saved.summary, summary, `${chars}: the summary is the caller's own — nothing overridden`);
      assert.equal(after.ai_status, "ready", `${chars}: ready`);
      assert.equal(after.ai_score, summary.aiScore, `${chars}: its score`);
      const payload = payloadOf(await kit.readRow(id));
      assert.equal(payload.aiAnalysis.status, "complete");
      assert.equal("unavailableReason" in payload.aiAnalysis, false, `${chars}: not the marker`);
      assert.ok(payload.aiAnalysis.compactPassages || payload.aiAnalysis.passages.length > 0, `${chars}: the real per-window result was kept`);
      assert.equal(await subtrees(id), subtreesBefore, `${chars}: similarity untouched`);
      assert.ok(after.chars <= MAX);
      rows.push({ manuscriptChars: text.length, persistedAfter: after.chars, aiChars: after.aiChars, ai_status: after.ai_status, viaWholeReportResave: route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).length === 0 });
      room += 1;
    }
  });
  writeOut("normal-ai-regression.json", { ceiling: MAX, rows, FITTING_AI_RESULT_REPLACED_BY_MARKER: false });
});

// ----------------------------------------------------------------------------------------------------------------
// 4. KNOWN BOUNDARY — the compact WRITER gate at its shipped default
// ----------------------------------------------------------------------------------------------------------------

test("KNOWN BOUNDARY (documented, unchanged): with the AI compact writer OFF (the shipped default) a ~1.85M report's LEGACY AI result is ~2.4x the manuscript — over the request ceiling — so neither save path can even deliver it to the server: no decision is possible and the report stays as it was; this is what activating ai-compact-v1 resolves", async () => {
  const account = await env.signUpAccount();
  const text = synthProse(1_850_000, { seed: 909, messiness: 0.01 });
  const ai = fx.syntheticAiAnalysis(text);
  await kit.asBrowser(account, async (route) => {
    const id = "lgoff-a";
    const report = await kit.firstSave(account, id, text, 0);
    const { enriched, summary } = enrich(report, ai);
    const result = await fx.withAiCompactWrites(undefined, () => persistAiCompletion(enriched, summary, 0));
    const whole = route.requests.filter((r) => r.path === "/api/reports" && r.method === "POST").at(-1);
    const narrow = route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).at(-1);
    assert.equal(whole.status, 413);
    assert.equal(narrow.status, 413, "the narrow request (the legacy AI result alone) is over the request ceiling and refused before it is read");
    assert.ok(narrow.bytes > MAX, `${narrow.bytes} > ${MAX}`);
    assert.equal(result.ok, false);
    assert.equal((await rowStats(id)).ai_status, "processing", "unchanged from before this policy: nothing could be decided");
    writeOut("writer-off-boundary.json", { manuscriptChars: text.length, wholeReportStatus: whole.status, narrowStatus: narrow.status, narrowBytes: narrow.bytes, aiStatusAfter: "processing", note: "requires ai-compact-v1 writer ON (activation configuration)" });
  });
});
