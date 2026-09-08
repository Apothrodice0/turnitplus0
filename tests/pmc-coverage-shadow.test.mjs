import assert from "node:assert/strict";
import test from "node:test";
import {
  freshDb, seedCorpus, makeText, spliceSubmission,
  seedReport, authoritativeFor, matchedResult, noHistoricalMatch,
  runEval, readRow, countRows, enableFlag, disableFlag, STATUS,
} from "./helpers/pmc-coverage-shadow.mjs";

/**
 * The deferred PMC coverage shadow evaluator (lib/pmc-coverage-shadow.ts).
 * MEASUREMENT ONLY — never touches the authoritative unifiedScore, never throws.
 */

test("flag OFF => immediate no-op: no row, no query, no throw even with a broken client", async () => {
  disableFlag();
  const brokenClient = {
    execute: async () => { throw new Error("the flag-OFF path must never reach a query"); },
    close: () => {},
  };
  const authoritative = authoritativeFor({ wordCount: 100 });
  // Must resolve without throwing and without touching brokenClient.
  await runEval(brokenClient, {
    reportDeviceKey: "dk", reportId: "r-flagoff", rawText: "some text",
    authoritativeUnifiedSimilarity: authoritative,
  });
  enableFlag();
});

test("flag ON but corpus empty => SKIPPED_EMPTY_CORPUS, no score fields", async () => {
  enableFlag();
  const { client, cleanup } = await freshDb("empty-corpus");
  try {
    const text = makeText("empty-corpus-report", 300);
    const authoritative = authoritativeFor({ wordCount: text.split(" ").length });
    await seedReport(client, { deviceKey: "dk", reportId: "r-empty", text, unifiedSimilarity: authoritative });
    await runEval(client, {
      reportDeviceKey: "dk", reportId: "r-empty", rawText: text,
      authoritativeUnifiedSimilarity: authoritative,
    });
    const row = await readRow(client, "r-empty");
    assert.ok(row);
    assert.equal(String(row.status), STATUS.SKIPPED_EMPTY_CORPUS);
    assert.equal(row.baseline_unified_score, null);
    assert.equal(row.counterfactual_unified_score, null);
  } finally { cleanup(); }
});

test("authoritative unavailable => SKIPPED_NO_AUTHORITATIVE", async () => {
  enableFlag();
  const { client, cleanup } = await freshDb("no-auth");
  try {
    await seedCorpus(client, [{ pmcId: "PMC1", text: makeText("a", 400) }]);
    const text = makeText("no-auth-report", 300);
    await seedReport(client, { deviceKey: "dk", reportId: "r-noauth", text });
    await runEval(client, {
      reportDeviceKey: "dk", reportId: "r-noauth", rawText: text,
      authoritativeUnifiedSimilarity: null,
    });
    const row = await readRow(client, "r-noauth");
    assert.equal(String(row.status), STATUS.SKIPPED_NO_AUTHORITATIVE);
  } finally { cleanup(); }
});

test("OK row: a real PMC overlap raises the counterfactual score; authoritative is untouched", async () => {
  enableFlag();
  const { client, cleanup } = await freshDb("ok-delta");
  try {
    const sourceText = makeText("pmc-overlap-source", 800);
    await seedCorpus(client, [
      { pmcId: "PMC50001", text: sourceText, doi: "10.1000/abc" },
      ...Array.from({ length: 10 }, (_, i) => ({ pmcId: `PMC500${10 + i}`, text: makeText(`noise-${i}`, 600) })),
    ]);

    const srcWords = sourceText.split(" ");
    const passage = srcWords.slice(150, 210).join(" "); // ~60 verbatim words
    const submission = spliceSubmission({ hostSeed: "ok-host", hostWords: 440, passage });
    const wordCount = submission.split(" ").length;

    // authoritative: no archive / academic / prior coverage at all => score 0
    const authoritative = authoritativeFor({ wordCount });
    assert.equal(authoritative.unifiedScore, 0);
    const frozenAuthoritative = JSON.parse(JSON.stringify(authoritative));

    const payloadBefore = await seedReport(client, {
      deviceKey: "dk", reportId: "r-ok", text: submission, unifiedSimilarity: authoritative,
    });

    await runEval(client, {
      reportDeviceKey: "dk", reportId: "r-ok", rawText: submission,
      productionResult: noHistoricalMatch(),
      authoritativeUnifiedSimilarity: authoritative,
      authoritativeArchiveMatchedPositions: null,
      authoritativeExternalAcademicEvidence: null,
    });

    const row = await readRow(client, "r-ok");
    assert.ok(row, "a shadow row was written");
    assert.ok([STATUS.OK, STATUS.BOUNDED].includes(String(row.status)), `status OK/BOUNDED, got ${row.status}`);
    assert.equal(Number(row.baseline_unified_score), 0, "baseline == authoritative unifiedScore");
    assert.ok(Number(row.counterfactual_unified_score) > 0, "PMC coverage raises the counterfactual");
    assert.equal(Number(row.score_delta), Number(row.counterfactual_unified_score) - Number(row.baseline_unified_score));
    assert.ok(Number(row.score_delta) >= 0, "delta never negative");
    assert.ok(Number(row.pmc_matched_word_count) >= 40, "the ~60-word passage is verified");
    assert.equal(Number(row.pmc_verified_source_count), 1);
    const sources = JSON.parse(String(row.pmc_sources_json));
    assert.equal(sources[0].pmcId, "PMC50001");
    assert.equal(sources[0].doi, "10.1000/abc");
    const positions = JSON.parse(String(row.pmc_matched_positions_json));
    assert.ok(Array.isArray(positions) && positions.every((p) => Number.isInteger(p)), "positions_json is int[]");

    // authoritative object + persisted payload are byte-identical.
    assert.deepEqual(JSON.parse(JSON.stringify(authoritative)), frozenAuthoritative, "the authoritative result object was not mutated");
    const reread = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE id = ?", args: ["r-ok"] });
    assert.equal(String(reread.rows[0].payload_json), JSON.stringify(payloadBefore), "saved_reports.payload_json is unchanged");
  } finally { cleanup(); }
});

test("idempotent UPSERT: POST then GET then GET converge on ONE row", async () => {
  enableFlag();
  const { client, cleanup } = await freshDb("idempotent");
  try {
    const sourceText = makeText("idem-source", 700);
    await seedCorpus(client, [{ pmcId: "PMC40001", text: sourceText }]);
    const submission = spliceSubmission({ hostSeed: "idem-host", hostWords: 400, passage: sourceText.split(" ").slice(100, 150).join(" ") });
    const authoritative = authoritativeFor({ wordCount: submission.split(" ").length });
    await seedReport(client, { deviceKey: "dk", reportId: "r-idem", text: submission, unifiedSimilarity: authoritative });

    const params = {
      reportDeviceKey: "dk", reportId: "r-idem", rawText: submission,
      authoritativeUnifiedSimilarity: authoritative,
    };
    await runEval(client, params);
    const first = await readRow(client, "r-idem");
    await runEval(client, params);
    await runEval(client, params);
    assert.equal(await countRows(client, "r-idem"), 1, "still exactly one row after three runs");
    const last = await readRow(client, "r-idem");
    assert.equal(Number(last.id), Number(first.id), "same row id (UPSERT, not re-insert)");
    assert.equal(Number(last.score_delta), Number(first.score_delta), "stable result");
    assert.equal(Number(last.created_at != null), 1);
  } finally { cleanup(); }
});

test("guarded UPSERT: no row is written for a report that does not exist", async () => {
  enableFlag();
  const { client, cleanup } = await freshDb("guarded");
  try {
    await seedCorpus(client, [{ pmcId: "PMC1", text: makeText("g", 400) }]);
    const text = makeText("ghost-report", 300);
    const authoritative = authoritativeFor({ wordCount: text.split(" ").length });
    // No seedReport => the EXISTS guard must suppress the write.
    await runEval(client, {
      reportDeviceKey: "dk", reportId: "r-ghost", rawText: text,
      authoritativeUnifiedSimilarity: authoritative,
    });
    assert.equal(await countRows(client, "r-ghost"), 0);
  } finally { cleanup(); }
});

test("deletion: the AFTER DELETE trigger removes the shadow row with its report", async () => {
  enableFlag();
  const { client, cleanup } = await freshDb("deletion");
  try {
    const sourceText = makeText("del-source", 700);
    await seedCorpus(client, [{ pmcId: "PMC30001", text: sourceText }]);
    const submission = spliceSubmission({ hostSeed: "del-host", hostWords: 400, passage: sourceText.split(" ").slice(100, 150).join(" ") });
    const authoritative = authoritativeFor({ wordCount: submission.split(" ").length });
    await seedReport(client, { deviceKey: "dk", reportId: "r-del", text: submission, unifiedSimilarity: authoritative });
    await runEval(client, { reportDeviceKey: "dk", reportId: "r-del", rawText: submission, authoritativeUnifiedSimilarity: authoritative });
    assert.equal(await countRows(client, "r-del"), 1);

    await client.execute({ sql: "DELETE FROM saved_reports WHERE id = ?", args: ["r-del"] });
    assert.equal(await countRows(client, "r-del"), 0, "trigger cleaned the shadow row atomically");
  } finally { cleanup(); }
});

test("ordinary-user privacy: pmc_sources_json carries only public OA identifiers; no report route reads the table", async () => {
  enableFlag();
  const { client, cleanup } = await freshDb("privacy");
  try {
    const sourceText = makeText("priv-source", 700);
    await seedCorpus(client, [{ pmcId: "PMC20001", text: sourceText, doi: "10.9/xyz" }]);
    const submission = spliceSubmission({ hostSeed: "priv-host", hostWords: 400, passage: sourceText.split(" ").slice(120, 175).join(" ") });
    const authoritative = authoritativeFor({ wordCount: submission.split(" ").length });
    await seedReport(client, { deviceKey: "dk-secret", reportId: "r-priv", accountId: "acct-secret", text: submission, unifiedSimilarity: authoritative });
    await runEval(client, {
      reportDeviceKey: "dk-secret", reportId: "r-priv", accountId: "acct-secret",
      rawText: submission, authoritativeUnifiedSimilarity: authoritative,
    });
    const row = await readRow(client, "r-priv");
    const sources = JSON.parse(String(row.pmc_sources_json));
    for (const s of sources) {
      assert.deepEqual(Object.keys(s).sort(), ["doi", "matchedWords", "pmcId", "title"], "only public fields per source");
    }
    // No account id, device key (other than the routing handle column), email, or hash of the text in the JSON blobs.
    const blob = `${row.pmc_sources_json}||${row.pmc_matched_positions_json}`;
    assert.ok(!blob.includes("acct-secret"), "no account id in the JSON payloads");
    assert.ok(!blob.includes("dk-secret"), "no device key in the JSON payloads");
  } finally { cleanup(); }
});

test("structural: no report-serving route references pmc_coverage_shadow_evaluations", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && readFileSync(full, "utf8").includes("pmc_coverage_shadow_evaluations")) hits.push(full);
    }
  };
  walk("app");
  assert.deepEqual(hits, [], "the shadow table must not be referenced anywhere under app/");
});
