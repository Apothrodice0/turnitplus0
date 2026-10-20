import assert from "node:assert/strict";
import test from "node:test";
import { formatAiScore } from "../lib/ai-display-state.ts";
import { aiSignalDisplay } from "../lib/report-types.ts";

// Display format only: a complete experimental AI score reads "N%"; the detector's number is unchanged, and no
// unavailable / pending / failed / not-eligible state is ever turned into a number.

test("a complete score is written as a percentage, a genuine zero included", () => {
  assert.equal(formatAiScore(0), "0%");
  assert.equal(formatAiScore(35), "35%");
  assert.equal(formatAiScore(78), "78%");
});

test("a genuine zero stays a real number; states without a score have no value to format", () => {
  const report = { aiAnalysis: null };
  assert.equal(aiSignalDisplay(report, { aiStatus: "ready", aiScore: 0, aiTone: "low" }).value, 0);
  assert.equal(aiSignalDisplay(report, { aiStatus: "ready", aiScore: 35, aiTone: "review" }).value, 35);
  assert.equal(aiSignalDisplay(report).value, null, "pending");
  assert.equal(aiSignalDisplay(report, { aiStatus: "failed", aiScore: null, aiTone: null }).value, null, "failed");
  const arabic = { aiAnalysis: { status: "skipped", score: null, reason: "language-unsupported", detectedLanguage: "ar", passages: [] } };
  const shown = aiSignalDisplay(arabic, { aiStatus: "ready", aiScore: null, aiTone: null });
  assert.equal(shown.value, null, "not available for this language");
});

test("the wording still says the score is not the share of AI-written text", () => {
  const shown = aiSignalDisplay({ aiAnalysis: null }, { aiStatus: "ready", aiScore: 35, aiTone: "review" });
  assert.match(shown.detail, /not the percentage of the text written by AI/);
  assert.match(shown.detail, /Experimental/);
});
