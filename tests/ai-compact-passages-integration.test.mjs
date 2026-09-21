import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as fx from "./helpers/large-report-retry-fixture.mjs";
import * as helpers from "./helpers/real-ai-windows.mjs";
import { createKit, ON, OFF, sha, bytesOf, num, payloadOf, lastPost } from "./helpers/ai-compact-integration-kit.mjs";
import { saveReportRemote, fetchRemoteReport, fetchReportRoomContents } from "../lib/reports-remote.ts";
import { persistAiCompletion, persistAiRetryResult } from "../lib/report-ai-completion.ts";
import { buildReportSummary, aiSignalDisplay } from "../lib/report-types.ts";
import * as codec from "../lib/ai-passage-table.ts";
import { AiReport } from "../components/report/ai-report.tsx";

/**
 * ai-compact-v1 END TO END (moderate sizes) through the REAL route handlers (POST /api/reports, POST /api/reports/[id]/ai-retry,
 * GET /api/reports/[id]) and the REAL client helpers (saveReportRemote, persistAiCompletion, persistAiRetryResult,
 * fetchRemoteReport) against a real, throwaway, migrated SQLite DB (fetch is routed to the handlers, with an explicit
 * content-length as a browser sends).
 *
 * The AI result is REALISTIC: the real overlapping 240/120-token windows (~2.4x the manuscript; see syntheticAiAnalysis). All
 * text is synthetic; nothing is a customer report or the real imported package. The pure codec/validator/reader/parity checks
 * against the REAL ModernBERT tokenizer live in tests/ai-passage-table.test.mjs; the 600k/850k/1M ladder in
 * tests/ai-compact-passages-size-ladder.test.mjs; the SQLITE_BUSY behaviour in tests/ai-retry-busy-concurrency.test.mjs.
 */

// Set up EVERYTHING before the first test() is registered (node:test starts a test the moment it is registered).
const env = await fx.createFixtureEnvironment("ai_compact_integration");
// tests/database-isolation.test.mjs: a file that drives DB-backed routes must override this itself.
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const kit = createKit(env);
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites(undefined); // the DEFAULT (OFF); each case pins what it needs
test.after(() => {
  restoreAi();
  restoreC2();
  env.dispose();
});

const asRendered = (report) => renderToStaticMarkup(React.createElement(AiReport, { report, printMode: true }));

// ----------------------------------------------------------------------------------------------------------------
// 1. The gate: OFF = legacy exactly as before; the reader always reads compact; mixed legacy/compact shapes
// ----------------------------------------------------------------------------------------------------------------

test("GATE OFF (the default) sends and persists the LEGACY passages exactly as before — and a compact row written earlier is still read and rendered with the gate OFF", async () => {
  const text = helpers.synthProse(40_000, { seed: 71, messiness: 0.02 });
  const legacyAi = fx.syntheticAiAnalysis(text);
  const account = await env.signUpAccount();
  await kit.asBrowser(account, async (route) => {
    // OFF: legacy on the wire and at rest.
    const reportOff = await kit.firstSave(account, "gate-off", text, 0);
    const off = kit.readyEnrichment(reportOff, legacyAi);
    assert.equal((await fx.withAiCompactWrites(OFF, () => persistAiCompletion(off.enriched, off.summary, 0))).ok, true);
    const requestOff = lastPost(route);
    assert.ok(requestOff.bytes > bytesOf(legacyAi), "the whole report + the FULL legacy AI result leave the browser");
    const rowOff = payloadOf(await kit.readRow("gate-off"));
    assert.equal(rowOff.aiAnalysis.compactPassages, undefined, "no compact table anywhere");
    assert.deepEqual(rowOff.aiAnalysis.passages, legacyAi.passages, "the persisted passages are the browser's, unchanged");
    assert.deepEqual(rowOff.aiAnalysis, legacyAi);
    assert.equal(process.env.NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED, undefined, "the gate is left unset");

    // ON: compact on the wire and at rest.
    const reportOn = await kit.firstSave(account, "gate-on", text, 1);
    const on = kit.readyEnrichment(reportOn, legacyAi);
    assert.equal((await fx.withAiCompactWrites(ON, () => persistAiCompletion(on.enriched, on.summary, 1))).ok, true);
    const requestOn = lastPost(route);
    assert.ok(requestOn.bytes < requestOff.bytes * 0.5, `compact request (${requestOn.bytes}) is far smaller than legacy (${requestOff.bytes})`);
    const rowOn = payloadOf(await kit.readRow("gate-on"));
    assert.equal(rowOn.aiAnalysis.passages.length, 0);
    assert.equal(rowOn.aiAnalysis.compactPassages.format, "turnitplus.ai-passages");
    const { compactPassages, passages, ...restOn } = rowOn.aiAnalysis;
    const { passages: legacyPassages, ...restLegacy } = legacyAi;
    assert.deepEqual(restOn, restLegacy, "every top-level AI scalar persisted compact == legacy (scores, counts, median, status …)");
    assert.equal(passages.length, 0);
    assert.equal(compactPassages.rows.length, legacyPassages.length);

    // A compact row written with the gate ON is read and rendered identically with the gate now OFF (the reader ignores the gate).
    assert.equal(process.env.NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED, undefined);
    const fullOn = await fetchRemoteReport("gate-on");
    const fullOff = await fetchRemoteReport("gate-off");
    assert.ok(fullOn.aiAnalysis.compactPassages && fullOn.aiAnalysis.passages.length === 0, "GET stays compact (nothing inflated it)");
    assert.equal(fullOff.aiAnalysis.compactPassages, undefined);
    // Each report against ITS OWN legacy rendering (their submission ids differ, so the two reports are never compared with each other).
    assert.equal(asRendered(fullOn), asRendered({ ...fullOn, aiAnalysis: legacyAi }), "the customer sees the same AI report from the compact row as from the legacy one");
    assert.equal(asRendered(fullOff), asRendered({ ...fullOff, aiAnalysis: legacyAi }));
    assert.match(asRendered(fullOn), /ai-passage-list/, "non-vacuous: the passage list is rendered from the compact row");
    assert.deepEqual(aiSignalDisplay(fullOn), aiSignalDisplay({ ...fullOn, aiAnalysis: legacyAi }), "headline status / score / tone identical");
    // The room poll and list surfaces read flat columns only and are identical too.
    const roomOn = await fetchReportRoomContents(1);
    const roomOff = await fetchReportRoomContents(0);
    assert.equal(roomOn.contents.report.aiScore, roomOff.contents.report.aiScore);
    assert.equal(roomOn.contents.status, "ready");
    assert.equal(roomOff.contents.status, "ready");
  });
});

test("MIXED SHAPES: legacy AI + legacy similarity, legacy AI + compact similarity, compact AI + legacy similarity, compact AI + compact similarity — all persist, GET and render", async () => {
  const text = helpers.synthProse(30_000, { seed: 81, messiness: 0.02 });
  const account = await env.signUpAccount();
  const legacyAi = fx.syntheticAiAnalysis(text);
  let room = 0;
  await kit.asBrowser(account, async () => {
    for (const [evidenceLabel, c2] of [["legacy similarity", OFF], ["compact similarity", ON]]) {
      for (const [aiLabel, ai] of [["legacy AI", OFF], ["compact AI", ON]]) {
        const id = `mixed-${evidenceLabel.split(" ")[0]}-${aiLabel.split(" ")[0]}`;
        // The C2 gate decides the evidence shape at save time (the server re-finalizes on every save), so it is held for both saves.
        const restoreC2ForSaves = fx.pinCompactWrites(c2);
        try {
          const report = await kit.firstSave(account, id, text, room);
          const { enriched, summary } = kit.readyEnrichment(report, legacyAi);
          assert.equal((await fx.withAiCompactWrites(ai, () => persistAiCompletion(enriched, summary, room))).ok, true, `${id}: persists`);
        } finally {
          restoreC2ForSaves();
        }
        room += 1;
        const row = payloadOf(await kit.readRow(id));
        assert.equal(row.evidenceInterpretation?.format === "compact", c2 === ON, `${id}: similarity really is ${evidenceLabel}`);
        assert.equal(row.aiAnalysis.compactPassages !== undefined, ai === ON, `${id}: AI really is ${aiLabel}`);
        const full = await fetchRemoteReport(id);
        assert.ok(full, `${id}: GET decodes (R2 fail-closed does not trigger)`);
        assert.equal(asRendered(full), asRendered({ ...full, aiAnalysis: legacyAi }), `${id}: the AI report renders exactly as the legacy one`);
        assert.match(asRendered(full), /ai-passage-list/, `${id}: non-vacuous — the passage list is rendered`);
        assert.ok(full.unifiedSimilarity && full.evidenceInterpretation, `${id}: similarity present and readable`);
      }
    }
  });
});

// ----------------------------------------------------------------------------------------------------------------
// 2. Server-side validation over the wire (reader-first: accepted whatever the client gate says)
// ----------------------------------------------------------------------------------------------------------------

test("READER-FIRST: neither server route consults the writer gate, and the retry route still has no compaction/write-flag dependency of its own", async () => {
  const [postRoute, retryRoute] = await Promise.all([
    readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/[id]/ai-retry/route.ts", import.meta.url), "utf8"),
  ]);
  for (const [label, source] of [["POST /api/reports", postRoute], ["POST /api/reports/[id]/ai-retry", retryRoute]]) {
    assert.doesNotMatch(source, /AI_COMPACT_PASSAGES_WRITE|isAiCompactPassagesWriteEnabled|resolveAiCompactPassagesWrites|NEXT_PUBLIC_/, `${label} never consults the client-side writer gate — it validates and accepts a valid compact table whatever that gate says`);
    assert.match(source, /validateCompactAiAnalysis/, `${label} validates a compact table`);
  }
  assert.doesNotMatch(retryRoute, /REPORT_COMPACT_PERSISTENCE_WRITE|encodeReportForPersistence|resolveCompactPersistenceWrites/, "the retry route never encodes/compacts anything itself — it persists exactly what it validated");
  // The bounded busy-retry idiom is the repo's own (same bound and backoff as insertReportWithRoomCheck in POST /api/reports).
  assert.match(retryRoute, /MAX_AI_RETRY_BUSY_RETRIES = 5;/);
  assert.match(retryRoute, /30 \* attempt \+ Math\.floor\(Math\.random\(\) \* 30\)/);
  assert.match(postRoute, /MAX_ROOM_INSERT_BUSY_RETRIES = 5;/);
  assert.match(postRoute, /30 \* attempt \+ Math\.floor\(Math\.random\(\) \* 30\)/);
  assert.match(retryRoute, /const txClient = await getReportsDbClient\(\);\s*\n\s*try \{\s*\n\s*return await persistAiRetry\(/, "a FRESH connection per attempt");
  assert.match(retryRoute, /if \(!isSqliteBusyError\(err\) \|\| attempt >= MAX_AI_RETRY_BUSY_RETRIES\) throw err;/, "only SQLITE_BUSY is retried, and only up to the bound");
});

test("SERVER VALIDATION (Retry route): a valid compact table is accepted with the writer gate OFF; a table for another manuscript, a tampered hash, a forged layout or hostile keys are refused 400 and NOTHING is written", async () => {
  const text = helpers.synthProse(60_000, { seed: 91, messiness: 0.01 });
  const other = helpers.synthProse(60_000, { seed: 92, messiness: 0.01 });
  const account = await env.signUpAccount();
  await kit.asBrowser(account, async () => { await kit.seedFailedReport(account, "val-retry", text, 0); });
  const before = await kit.readRow("val-retry");
  const good = codec.compactAiAnalysis(fx.syntheticAiAnalysis(text), text);
  assert.equal(good.ok, true);
  const goodWire = JSON.parse(JSON.stringify(good.analysis));
  const foreign = codec.compactAiAnalysis(fx.syntheticAiAnalysis(other), other);
  assert.equal(foreign.ok, true);
  const mutate = (fn) => { const wire = JSON.parse(JSON.stringify(goodWire)); fn(wire, wire.compactPassages, wire.compactPassages.rows); return wire; };

  const refused = [
    ["a table computed on a DIFFERENT manuscript (structurally perfect)", JSON.parse(JSON.stringify(foreign.analysis))],
    ["tampered text hash", mutate((w, t) => { t.textHash = (t.textHash ^ 1) >>> 0; })],
    ["wrong text length", mutate((w, t) => { t.textLength += 1; })],
    ["char range past the basis", mutate((w, t, rows) => { rows[3][3] = t.basisLength + 10; })],
    ["forged token layout", mutate((w, t, rows) => { rows[4][0] += 1; rows[4][1] += 1; })],
    ["more rows than the token count allows", mutate((w) => { w.analyzedTokenCount = 500; })],
    ["unsupported format version", mutate((w, t) => { t.formatVersion = 2; })],
    ["non-finite model value", mutate((w, t, rows) => { rows[2][4] = null; })],
    ["both forms at once", mutate((w) => { w.passages = [{ start: 0 }]; })],
    ["smuggled top-level key", mutate((w) => { w.smuggled = "x"; })],
    ["oversized literal table", mutate((w, t, rows) => { for (const i of [2, 3, 4]) { rows[i][2] = -1; rows[i][3] = -1; } t.literals = { 2: "x".repeat(16000), 3: "x".repeat(16000), 4: "x".repeat(16000) }; })],
    ["compactPassages is not an object", mutate((w) => { w.compactPassages = "nope"; })],
  ];
  for (const [label, wire] of refused) {
    const result = await kit.callRetryRoute("val-retry", { body: kit.retryBodyFor(wire), cookie: account.cookie });
    assert.equal(result.status, 400, `${label} -> 400`);
    assert.deepEqual(result.json, { error: "Invalid AI result" }, `${label}: generic body`);
  }
  const untouched = await kit.readRow("val-retry");
  assert.equal(sha(untouched.payload_json), sha(before.payload_json), "nothing was written by any refused request");
  assert.equal(untouched.ai_status, "failed");

  // ... and the valid one is accepted with the writer gate OFF (reader-first), persisted exactly as validated.
  assert.equal(process.env.NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED, undefined);
  const accepted = await kit.callRetryRoute("val-retry", { body: kit.retryBodyFor(goodWire), cookie: account.cookie });
  assert.equal(accepted.status, 200);
  const after = await kit.readRow("val-retry");
  assert.deepEqual(payloadOf(after).aiAnalysis, goodWire, "persisted byte-for-byte as validated — not expanded, not rewritten");
  assert.equal(after.ai_status, "ready");
});

test("REAL-WORLD MANUSCRIPT CHARACTERS: a stored manuscript containing NUL, a lone surrogate, astral glyphs and other control characters still accepts its compact Retry (the route reads the stored text exactly as GET does) — and is still strict about a table for a DIFFERENT text", async () => {
  // Regression: the route once read the stored manuscript with SQL json_extract, which the driver truncates at an embedded NUL —
  // so on a manuscript with a U+0000 (a real ~1M-character extracted document had one at index 873,772) every compact Retry was 400.
  const words = helpers.synthProse(40_000, { seed: 151, messiness: 0.01 }).split(" ");
  words[100] += "\u0000";              // early, so a truncated read would lose almost the whole manuscript
  words[400] += "\uD800";              // lone surrogate (JSON escapes it; JSON.parse restores it)
  words[700] += " \u{1F600} 漢字 \u{1D7D8}";
  words[1000] += "\u0007\u001B";
  const text = words.join(" ");
  const account = await env.signUpAccount();
  await kit.asBrowser(account, async (route) => {
    await kit.seedFailedReport(account, "nul-text", text, 0);
    const before = await fetchRemoteReport("nul-text");
    assert.equal(before.text, text, "fixture sanity: GET returns the manuscript exactly (NUL, lone surrogate and all)");
    // What the OLD read would have produced — proof this fixture reproduces the bug's precondition.
    const viaSql = (await env.client.execute({ sql: "SELECT json_extract(payload_json,'$.text') AS t FROM saved_reports WHERE id = ?", args: ["nul-text"] })).rows[0].t;
    assert.ok(typeof viaSql === "string" && viaSql.length < text.length, `fixture sanity: SQL json_extract truncates this manuscript (${viaSql.length} < ${text.length})`);

    const analysis = fx.syntheticAiAnalysis(text);
    const enrichment = kit.readyEnrichment(before, analysis);
    const retried = await fx.withAiCompactWrites(ON, () => persistAiRetryResult(enrichment.enriched, enrichment.summary));
    assert.equal(retried.ok, true, "the compact Retry is accepted");
    assert.equal(lastPost(route, (r) => r.path === "/api/reports/nul-text/ai-retry").status, 200);
    const row = payloadOf(await kit.readRow("nul-text"));
    assert.ok(row.aiAnalysis.compactPassages, "persisted compact");
    const after = await fetchRemoteReport("nul-text");
    assert.equal(after.text, text, "the manuscript itself is untouched by the AI write");
    const expanded = codec.expandCompactAiPassages(after.aiAnalysis, after.text);
    assert.equal(expanded.ok, true);
    assert.deepEqual(expanded.passages, analysis.passages, "expand(GET) equals the browser's original passages");

    // Still strict: a table computed on the same manuscript WITHOUT the NUL is a different text -> 400, nothing written.
    const wrongText = text.replace("\u0000", " ");
    const wrongWire = codec.compactAiAnalysis(fx.syntheticAiAnalysis(wrongText), wrongText);
    assert.equal(wrongWire.ok, true);
    const beforeRefused = await kit.readRow("nul-text");
    const refused = await kit.callRetryRoute("nul-text", { body: kit.retryBodyFor(JSON.parse(JSON.stringify(wrongWire.analysis))), cookie: account.cookie });
    assert.equal(refused.status, 400, "a table for a different text is refused even on a manuscript with a NUL");
    assert.equal(sha((await kit.readRow("nul-text")).payload_json), sha(beforeRefused.payload_json), "nothing written");
  });
});

test("SERVER VALIDATION (POST /api/reports): a compact AI table is checked against THIS request's own manuscript — mismatches are refused 400 with nothing persisted; a valid one is accepted with the gate OFF", async () => {
  const text = helpers.synthProse(40_000, { seed: 95, messiness: 0.01 });
  const other = helpers.synthProse(40_000, { seed: 96, messiness: 0.01 });
  const account = await env.signUpAccount();
  const legacyAi = fx.syntheticAiAnalysis(text);
  const good = JSON.parse(JSON.stringify(codec.compactAiAnalysis(legacyAi, text).analysis));
  const foreign = JSON.parse(JSON.stringify(codec.compactAiAnalysis(fx.syntheticAiAnalysis(other), other).analysis));
  await kit.asBrowser(account, async (route) => {
    const post = async (id, aiAnalysis, room) => {
      const report = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id, text, room }).payload;
      const enriched = { ...report, aiScore: 7, aiAnalysis };
      const summary = { ...buildReportSummary(enriched), aiStatus: "ready", similarityStatus: "pending" };
      // saveReportRemote directly with the gate OFF: the payload carries `aiAnalysis` exactly as given (a hand-made client).
      const result = await fx.withAiCompactWrites(OFF, () => saveReportRemote(enriched, summary, undefined, room));
      return { result, request: lastPost(route) };
    };
    const wrongText = await post("post-foreign", foreign, 0);
    assert.equal(wrongText.request.status, 400, "a table for another manuscript");
    assert.equal(wrongText.result.ok, false);
    assert.equal(await kit.readRow("post-foreign"), null, "nothing persisted");
    const forgedHash = JSON.parse(JSON.stringify(good));
    forgedHash.compactPassages.textHash = (forgedHash.compactPassages.textHash ^ 1) >>> 0;
    assert.equal((await post("post-hash", forgedHash, 1)).request.status, 400);
    assert.equal(await kit.readRow("post-hash"), null);
    const smuggled = JSON.parse(JSON.stringify(good));
    smuggled.evilKey = { x: 1 };
    assert.equal((await post("post-key", smuggled, 2)).request.status, 400);
    assert.equal(await kit.readRow("post-key"), null);

    const accepted = await post("post-good", good, 3);
    assert.equal(accepted.request.status, 200, "a valid table is accepted with the writer gate OFF");
    const row = await kit.readRow("post-good");
    assert.deepEqual(payloadOf(row).aiAnalysis, good, "persisted as validated");
    assert.equal(row.ai_status, "ready");
    // A legacy analysis is not validated at all — exactly as before.
    assert.equal((await post("post-legacy", legacyAi, 4)).request.status, 200);
    assert.deepEqual(payloadOf(await kit.readRow("post-legacy")).aiAnalysis, legacyAi);
  });
});

// ----------------------------------------------------------------------------------------------------------------
// 3. Stale client / R2 with a compact Retry
// ----------------------------------------------------------------------------------------------------------------

test("STALE CLIENT and R2 hold for a compact Retry: a stale browser copy cannot overwrite newer similarity, and an unreadable report is refused untouched — the compact table changes neither", async () => {
  const late = fx.buildLateSourcePassage(2500);
  const text = `${helpers.synthProse(30_000, { seed: 141, messiness: 0.01 })} ${late}`;
  const account = await env.signUpAccount();
  await kit.asBrowser(account, async (route) => {
    await kit.seedFailedReport(account, "aic-stale", text, 0);
    const stale = await fetchRemoteReport("aic-stale"); // version A
    // The server moves on: the late passage enters the corpus and the report is re-finalized (version B).
    await env.promoteDocumentIntoCorpus(late);
    const restoreC2ForResave = fx.pinCompactWrites(ON);
    try {
      const clientReport = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id: "aic-stale", text, room: 0 }).payload;
      assert.equal((await saveReportRemote(clientReport, { ...buildReportSummary(clientReport), aiStatus: "failed", similarityStatus: "pending" }, undefined, 0)).ok, true);
    } finally {
      restoreC2ForResave();
    }
    const rowB = await kit.readRow("aic-stale");
    const subtrees = async () => (await env.client.execute({ sql: "SELECT json_extract(payload_json,'$.unifiedSimilarity') us, json_extract(payload_json,'$.evidenceInterpretation') ei, json_extract(payload_json,'$.unifiedSimilarityGeneration') gen FROM saved_reports WHERE id = ?", args: ["aic-stale"] })).rows[0];
    const subtreesB = await subtrees();
    assert.notEqual(String(subtreesB.us), JSON.stringify(stale.unifiedSimilarity), "fixture sanity: version B genuinely differs from the stale copy");
    const enriched = kit.readyEnrichment(stale, fx.syntheticAiAnalysis(text));
    const retried = await fx.withAiCompactWrites(ON, () => persistAiRetryResult(enriched.enriched, enriched.summary));
    assert.equal(retried.ok, true);
    assert.equal(lastPost(route, (r) => r.path === "/api/reports/aic-stale/ai-retry").status, 200);
    const afterRow = await kit.readRow("aic-stale");
    assert.ok(payloadOf(afterRow).aiAnalysis.compactPassages, "the retry landed compact");
    const subtreesAfter = await subtrees();
    assert.equal(String(subtreesAfter.us), String(subtreesB.us), "the NEWER unifiedSimilarity survived byte-for-byte");
    assert.equal(String(subtreesAfter.ei), String(subtreesB.ei));
    assert.equal(num(subtreesAfter.gen), num(subtreesB.gen));
    assert.notEqual(sha(rowB.payload_json), sha(afterRow.payload_json), "only the AI half changed");

    // R2: corrupt the persisted explanation -> a compact retry is refused (503) and the row is byte-identical.
    const r2Text = text.slice(0, 40_000);
    await kit.seedFailedReport(account, "aic-r2", r2Text, 1);
    const payload = payloadOf(await kit.readRow("aic-r2"));
    payload.evidenceInterpretation = { format: "future-compact/9", formatVersion: 9 };
    await env.client.execute({ sql: "UPDATE saved_reports SET payload_json = ? WHERE id = ?", args: [JSON.stringify(payload), "aic-r2"] });
    const beforeR2 = await kit.readRow("aic-r2");
    const browserCopy = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id: "aic-r2", text: r2Text, room: 1 }).payload;
    const r2Enriched = kit.readyEnrichment(browserCopy, fx.syntheticAiAnalysis(r2Text));
    const r2Result = await fx.withAiCompactWrites(ON, () => persistAiRetryResult(r2Enriched.enriched, r2Enriched.summary));
    assert.equal(r2Result.ok, false);
    assert.equal(lastPost(route, (r) => r.path === "/api/reports/aic-r2/ai-retry").status, 503);
    assert.equal(sha((await kit.readRow("aic-r2")).payload_json), sha(beforeR2.payload_json), "R2: the unreadable report is untouched");
  });
});
