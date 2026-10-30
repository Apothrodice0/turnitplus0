import assert from "node:assert/strict";
import test from "node:test";
import { attachPredictedHighlights, canViewPredictedHighlights, highlightModelConfig, sanitizePredictedRanges } from "../lib/highlight-model.ts";
import { findHighlightRanges } from "../components/report/similarity-report-papers.tsx";
import { encodeReportForPersistence } from "../lib/report-persistence.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";
import { renderPlainWithPredicted } from "../components/report/report-v2/report-v2-view.tsx";

/**
 * TURNITIN HIGHLIGHT MODEL prototype: off unless configured, never on production, admin/owner only, response-only, and
 * a predicted passage never gets a source, never takes a verified word and never changes a number.
 */
const KEY = "k".repeat(32);
const ENV = { HIGHLIGHT_MODEL_ENABLED: "1", HIGHLIGHT_MODEL_URL: "http://127.0.0.1:47600/predict", HIGHLIGHT_MODEL_KEY: KEY, HIGHLIGHT_MODEL_OWNER_EMAILS: "Owner@Example.com" };
const admin = { email: "a@example.com", role: "admin" };
const owner = { email: "owner@example.com", role: "user" };
const customer = { email: "c@example.com", role: "user" };
const TEXT = "The first sentence was verified against a real source. The second sentence is only predicted by the model. The third one is plain.";
const report = (extra = {}) => ({ text: TEXT, sources: [], score: 7, matchedWordCount: 9, wordCount: 23, ...extra });
const ok = (ranges) => async () => new Response(JSON.stringify({ ranges }), { status: 200 });

test("off by default, and never enabled on a production deployment", () => {
  assert.equal(highlightModelConfig({}).enabled, false);
  assert.equal(highlightModelConfig({ ...ENV, HIGHLIGHT_MODEL_ENABLED: "0" }).enabled, false);
  assert.equal(highlightModelConfig({ ...ENV, HIGHLIGHT_MODEL_KEY: "short" }).enabled, false);
  assert.equal(highlightModelConfig({ ...ENV, VERCEL_ENV: "production" }).enabled, false);
  assert.equal(highlightModelConfig({ ...ENV, VERCEL_ENV: "preview" }).enabled, true);
});

test("only an administrator or an allowlisted owner may see predictions", () => {
  const config = highlightModelConfig(ENV);
  assert.equal(canViewPredictedHighlights(admin, config), true);
  assert.equal(canViewPredictedHighlights(owner, config), true);
  assert.equal(canViewPredictedHighlights(customer, config), false);
  assert.equal(canViewPredictedHighlights(null, config), false);
  assert.equal(canViewPredictedHighlights(admin, highlightModelConfig({})), false);
});

test("a viewer who is not allowed never reaches the model", async () => {
  const r = report();
  let calls = 0;
  await attachPredictedHighlights(r, customer, highlightModelConfig(ENV), async () => { calls += 1; throw new Error("no"); });
  assert.equal(calls, 0);
  assert.equal("predictedHighlights" in r, false);
});

test("a model failure leaves the report exactly as it was", async () => {
  const r = report();
  const before = JSON.stringify(r);
  const error = console.error;
  console.error = () => {};
  try {
    await attachPredictedHighlights(r, owner, highlightModelConfig(ENV), async () => { throw new Error("down"); });
    await attachPredictedHighlights(r, owner, highlightModelConfig(ENV), async () => new Response("no", { status: 500 }));
  } finally {
    console.error = error;
  }
  assert.equal(JSON.stringify(r), before);
});

test("the backend's ranges are never passed through unchecked", () => {
  const raw = [{ start: 5, end: 9, source: "x" }, { start: 8, end: 12 }, { start: -1, end: 3 }, { start: 3, end: 3 }, { start: 1.5, end: 2 }, { start: 90, end: 120 }, null];
  assert.deepEqual(sanitizePredictedRanges(raw, 100), [{ start: 5, end: 12 }]);
  assert.deepEqual(sanitizePredictedRanges("nope", 100), []);
});

test("only the text before the reference section is sent, and offsets stay valid for the full text", async () => {
  const text = `${TEXT}\n\nReferences\n1. Someone. A title. Journal, 2020.`;
  const r = report({ text });
  let sent;
  await attachPredictedHighlights(r, admin, highlightModelConfig(ENV), async (_url, init) => {
    sent = JSON.parse(init.body).text;
    return ok([{ start: 0, end: 3 }])();
  });
  assert.equal(text.startsWith(sent), true);
  assert.equal(r.predictedHighlights.length, 1);
});

test("no predicted ranges: output is identical to the report without the field", () => {
  const source = { name: "S", type: "Publication", color: "#d7263d", matches: 1, matchedWords: 9, percent: 7, phrases: ["The first sentence was verified against a real source"] };
  assert.deepEqual(findHighlightRanges(report({ sources: [source], predictedHighlights: [] })), findHighlightRanges(report({ sources: [source] })));
});

test("a predicted span is clipped around a verified match, has no source, and no word is drawn twice", () => {
  const source = { name: "S", type: "Publication", color: "#d7263d", matches: 1, matchedWords: 9, percent: 7, phrases: ["The first sentence was verified against a real source"] };
  const end = TEXT.indexOf("The third");
  const ranges = findHighlightRanges(report({ sources: [source], predictedHighlights: [{ start: 4, end }] }));
  const verified = ranges.filter((r) => r.kind === "source");
  const predicted = ranges.filter((r) => r.kind === "predicted");
  assert.equal(verified.length, 1);
  assert.equal(verified[0].start, 0);
  assert.equal(predicted.length, 1);
  assert.equal(predicted[0].start, verified[0].end);
  assert.equal(predicted[0].end, end);
  assert.equal(predicted[0].sourceIndex, -1);
  assert.equal(predicted[0].label, "");
  assert.equal(predicted[0].url, undefined);
  ranges.slice(1).forEach((r, i) => assert.ok(r.start >= ranges[i].end));
});

test("predictions change no number and are never stored", () => {
  const r = report({ predictedHighlights: [{ start: 0, end: 20 }] });
  findHighlightRanges(r);
  assert.equal(r.score, 7);
  assert.equal(r.matchedWordCount, 9);
  assert.equal("predictedHighlights" in encodeReportForPersistence(r), false);
});

test("screen manuscript: no predicted ranges keeps the single plain span, predicted text is marked and carries no link or number", () => {
  const html = (ranges) => renderToStaticMarkup(createElement(Fragment, null, ...renderPlainWithPredicted(TEXT, 0, 30, ranges, "t")));
  assert.equal(html([]), `<span>${TEXT.slice(0, 30)}</span>`);
  const marked = html([{ start: 4, end: 9 }, { start: 25, end: 60 }]);
  assert.equal((marked.match(/class="predicted-highlight"/g) ?? []).length, 2);
  assert.equal(/<mark/.test(marked), false);
  assert.equal(marked.replace(/<[^>]+>/g, ""), TEXT.slice(0, 30));
  assert.equal(/href|title=|<sup|role=/.test(marked), false);
});
