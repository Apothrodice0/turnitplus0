import assert from "node:assert/strict";
import test from "node:test";
import { resolveAiDisplayState } from "../lib/ai-display-state.ts";
import { aiSignalDisplay, buildReportSummary } from "../lib/report-types.ts";
import { AI_SCORING_VERSION, calibratedAiDisplaySignal } from "../lib/ai-core.ts";

/**
 * The production bug this covers: on Preview, the room/list card showed
 * "0% AI" for a report while opening that same report showed "AI report
 * pending" (report id 1787833395119). Root cause: the flat
 * saved_reports.ai_status / ai_score / ai_tone columns (which the room/list
 * read) and payload_json.aiAnalysis (which the detail page read for its AI
 * headline) are two independently-persisted signals, and app/api/reports/
 * route.ts's SAVE_REPORT_SQL generation guard can update the columns while
 * rejecting a payload_json that carries the fresh aiAnalysis — leaving
 * ai_status='ready' + ai_score=0 next to a payload with no aiAnalysis at
 * all. resolveAiDisplayState is the one shared interpreter every surface
 * now routes through so they can never disagree again.
 */

const A_COMPLETE_ZERO_ANALYSIS = {
  status: "complete",
  scoringVersion: AI_SCORING_VERSION,
  medianLogOdds: -1, // calibratedAiDisplaySignal(-1) === { score: 0 }
};
const A_COMPLETE_HIGH_ANALYSIS = {
  status: "complete",
  scoringVersion: AI_SCORING_VERSION,
  medianLogOdds: 5, // calibratedAiDisplaySignal(5) === { score: 100 }
};

// Sanity-anchor the fixtures against the real calibration so a future
// recalibration that moves these can't let a stale assumption pass silently.
test("fixtures: the calibration anchors this suite relies on still hold", () => {
  assert.equal(calibratedAiDisplaySignal(-1)?.score, 0);
  assert.equal(calibratedAiDisplaySignal(5)?.score, 100);
});

// --- 1 & 2: a missing / null AI result must NEVER become 0% ------------------

test("1. pending + null score does NOT display 0%", () => {
  const r = resolveAiDisplayState({ aiStatus: "processing", aiScore: null, aiTone: null });
  assert.equal(r.state, "pending");
  assert.equal(r.score, null);
});

test("2. pending + undefined/missing score does NOT display 0%", () => {
  const r = resolveAiDisplayState({}); // nothing persisted at all
  assert.equal(r.state, "pending");
  assert.equal(r.score, null);

  // and the same via the report-facing wrapper, with no payload analysis
  const signal = aiSignalDisplay({ aiAnalysis: undefined });
  assert.equal(signal.value, null);
  assert.equal(signal.label, "AI report pending");
});

// --- 3 & 4: a genuinely completed analysis shows its real number ------------

test("3. completed + score 0 displays 0% (ai_status is the completion signal, never score===0)", () => {
  const r = resolveAiDisplayState({ aiStatus: "ready", aiScore: 0, aiTone: "low" });
  assert.equal(r.state, "complete");
  assert.equal(r.score, 0);
  assert.equal(r.tone, "low");
});

test("4. completed + positive score displays the correct %", () => {
  const r = resolveAiDisplayState({ aiStatus: "ready", aiScore: 63, aiTone: "high" });
  assert.equal(r.state, "complete");
  assert.equal(r.score, 63);
  assert.equal(r.tone, "high");
});

// --- 5: room/list and detail resolve the SAME state for the bug shape ------

test("5. room/list and detail resolve the same state for the exact bug row (ai_status=ready, ai_score=0, payload_json.aiAnalysis lost)", () => {
  const persisted = { aiStatus: "ready", aiScore: 0, aiTone: "low" };

  // room/list surface: only the flat columns, no aiAnalysis
  const roomView = resolveAiDisplayState(persisted);

  // detail surface: same flat columns, plus a payload that has NO aiAnalysis
  // (the stale-generation overwrite dropped it)
  const detailSignal = aiSignalDisplay({ aiAnalysis: undefined }, persisted);

  assert.equal(roomView.state, "complete");
  assert.equal(roomView.score, 0);
  assert.equal(detailSignal.value, 0, "detail must show 0%, matching the room card — not 'AI report pending'");
  assert.notEqual(detailSignal.label, "AI report pending");
});

test("5b. the OLD detail-page behavior (payload-only, ignoring the flat columns) is what produced the split — proven here so the regression is unambiguous", () => {
  // aiSignalDisplay with NO persisted argument === the pre-fix behavior
  const oldDetail = aiSignalDisplay({ aiAnalysis: undefined });
  assert.equal(oldDetail.value, null);
  assert.equal(oldDetail.label, "AI report pending");

  // the room card, then and now, reads the flat column and shows 0%
  const room = resolveAiDisplayState({ aiStatus: "ready", aiScore: 0, aiTone: "low" });
  assert.equal(room.score, 0);

  // -> different verdicts for the same report. The fix (passing `persisted`)
  //    makes them agree; see test 5.
});

// --- 6: legacy rows ---------------------------------------------------------

test("6a. a persisted legacy pending report (no ai_status column, no score) does NOT become 0%", () => {
  const r = resolveAiDisplayState({ aiStatus: null, aiScore: null, aiTone: null });
  assert.equal(r.state, "pending");
  assert.equal(r.score, null);
});

test("6b. a legacy row WITH a persisted numeric score still resolves as completed (matches deriveRoomStatus's own legacy ai_score-only rule)", () => {
  const r = resolveAiDisplayState({ aiStatus: null, aiScore: 12, aiTone: "low" });
  assert.equal(r.state, "complete");
  assert.equal(r.score, 12);
});

// --- 7: failed / not-eligible never render 0% ------------------------------

test("7a. a persisted failed AI status does not display 0%", () => {
  const r = resolveAiDisplayState({ aiStatus: "failed", aiScore: null, aiTone: null });
  assert.equal(r.state, "failed");
  assert.equal(r.score, null);

  const signal = aiSignalDisplay({ aiAnalysis: undefined }, { aiStatus: "failed", aiScore: null, aiTone: null });
  assert.equal(signal.value, null);
  assert.equal(signal.label, "Analysis unavailable");
});

test("7b. an in-payload 'error' analysis does not display 0%, and keeps its own error detail", () => {
  const signal = aiSignalDisplay({ aiAnalysis: { status: "error", error: "The local AI model could not load." } });
  assert.equal(signal.value, null);
  assert.equal(signal.detail, "The local AI model could not load.");
});

test("7c. an in-payload 'unsupported' analysis resolves as not_eligible, never 0%", () => {
  const r = resolveAiDisplayState({ aiStatus: "failed", aiAnalysis: { status: "unsupported" } });
  assert.equal(r.state, "not_eligible");
  assert.equal(r.score, null);

  const signal = aiSignalDisplay({ aiAnalysis: { status: "unsupported" } });
  assert.equal(signal.value, null);
  assert.equal(signal.label, "Not enough text");
});

test("7d. a 'ready' status with a null score (analysis completed but produced no calibratable number) is pending, never 0%", () => {
  const r = resolveAiDisplayState({ aiStatus: "ready", aiScore: null, aiTone: "unavailable" });
  assert.equal(r.state, "pending");
  assert.equal(r.score, null);
});

// --- 8: existing completed-report behavior is unchanged -------------------

test("8a. a report whose payload still carries a current, complete aiAnalysis resolves from that analysis, exactly as before", () => {
  const zero = aiSignalDisplay({ aiAnalysis: A_COMPLETE_ZERO_ANALYSIS });
  assert.equal(zero.value, 0);
  assert.equal(zero.tone, "low");
  assert.equal(zero.label, "Low AI indicators");

  const high = aiSignalDisplay({ aiAnalysis: A_COMPLETE_HIGH_ANALYSIS });
  assert.equal(high.value, 100);
  assert.equal(high.tone, "high");
  assert.equal(high.label, "Strong AI indicators");
});

test("8b. when a current in-payload analysis is present it drives the result — bogus persisted columns cannot override it", () => {
  const withBogusColumns = resolveAiDisplayState({
    aiStatus: "ready",
    aiScore: 999,
    aiTone: "high",
    aiAnalysis: A_COMPLETE_ZERO_ANALYSIS,
  });
  assert.equal(withBogusColumns.state, "complete");
  assert.equal(withBogusColumns.score, 0, "the real analysis wins, not the impossible persisted 999");
});

test("8c. a stale-scoringVersion analysis falls through to the flat column instead of being stranded as 'pending' while the room shows a number", () => {
  const staleAnalysis = { status: "complete", scoringVersion: AI_SCORING_VERSION - 1, medianLogOdds: -1 };

  // payload-only (no persisted): unchanged from before — cannot trust a stale
  // version, so pending.
  assert.equal(aiSignalDisplay({ aiAnalysis: staleAnalysis }).value, null);

  // with the persisted columns available (the detail page): show the frozen
  // authoritative number, consistent with the room/list which only ever had
  // that column.
  const withColumns = resolveAiDisplayState({ aiStatus: "ready", aiScore: 7, aiTone: "low", aiAnalysis: staleAnalysis });
  assert.equal(withColumns.state, "complete");
  assert.equal(withColumns.score, 7);
});

test("8d. buildReportSummary still freezes the calibrated display value (not the raw percentile) into the ai_score column", () => {
  const report = baseReport({
    aiScore: 42.7, // SimilarityReport.aiScore is the RAW human-reference percentile
    aiAnalysis: A_COMPLETE_HIGH_ANALYSIS,
  });
  const summary = buildReportSummary(report);
  assert.equal(summary.aiScore, 100, "the column must carry the calibrated display value, not the raw percentile");
  assert.equal(summary.aiTone, "high");
});

test("8e. buildReportSummary on a not-yet-analyzed report writes a null ai_score, never 0", () => {
  const summary = buildReportSummary(baseReport({ aiScore: null, aiAnalysis: undefined }));
  assert.equal(summary.aiScore, null);
  assert.equal(summary.aiTone, "unavailable");
});

// --- helpers --------------------------------------------------------------

function baseReport(overrides = {}) {
  return {
    version: 11,
    id: 1,
    submissionId: "sub-1",
    title: "doc.pdf",
    author: "A",
    assignment: "",
    created: new Date().toISOString(),
    score: 0,
    archiveScore: 0,
    wordCount: 1000,
    databaseSize: 230,
    corpusVersion: "archive-v1-230-test",
    scoreBand: "Low",
    riskStatus: "Lower",
    riskTarget: 40,
    riskCutoff: 40,
    riskCalibration: { auc: 0.9, precision: 0.8, recall: 0.8, sampleSize: 100 },
    features: {
      maxSourceContainment: 0,
      longestMatchedSpan: 0,
      quotationDensity: 0,
      referenceListRatio: 0,
      highFrequencyShingleCount: 0,
      repeatedThreeGramCount: 0,
      detectedLanguage: "English",
    },
    excludedDocuments: 0,
    matchedWordCount: 0,
    sources: [],
    repeats: [],
    text: "sample",
    ...overrides,
  };
}
