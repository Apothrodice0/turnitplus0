import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HighlightModelError, highlightModelConfig, requestPredictedHighlights, sanitizePredictedRanges } from "../lib/highlight-model.ts";
import { findHighlightRanges } from "../components/report/similarity-report-papers.tsx";
import { usablePredictedFragment } from "../lib/predicted-highlight-fragments.ts";
import { encodeReportForPersistence } from "../lib/report-persistence.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";
import { renderPlainWithPredicted } from "../components/report/report-v2/report-v2-view.tsx";

/**
 * TURNITIN HIGHLIGHT MODEL: off unless configured, not on production unless enabled there, stored outside the report, and
 * a predicted passage never gets a source, never takes a verified word and never changes a number.
 */
const KEY = "k".repeat(32);
const ENV = { HIGHLIGHT_MODEL_ENABLED: "1", HIGHLIGHT_MODEL_URL: "http://127.0.0.1:47600/predict", HIGHLIGHT_MODEL_KEY: KEY, HIGHLIGHT_MODEL_VERSION: "v1-test", HIGHLIGHT_MODEL_OWNER_EMAILS: "Owner@Example.com" };
const admin = { email: "a@example.com", role: "admin" };
const owner = { email: "owner@example.com", role: "user" };
const customer = { email: "c@example.com", role: "user" };
const TEXT = "The first sentence was verified against a real source. The second sentence is only predicted by the model. The third one is plain.";
const report = (extra = {}) => ({ text: TEXT, sources: [], score: 7, matchedWordCount: 9, wordCount: 23, ...extra });
const ok = (ranges) => async () => new Response(JSON.stringify({ ranges }), { status: 200 });

test("off by default, and off on a production deployment unless enabled there", () => {
  assert.equal(highlightModelConfig({}).enabled, false);
  assert.equal(highlightModelConfig({ ...ENV, HIGHLIGHT_MODEL_ENABLED: "0" }).enabled, false);
  assert.equal(highlightModelConfig({ ...ENV, HIGHLIGHT_MODEL_KEY: "short" }).enabled, false);
  assert.equal(highlightModelConfig({ ...ENV, VERCEL_ENV: "production" }).enabled, false);
  assert.equal(highlightModelConfig({ ...ENV, VERCEL_ENV: "preview" }).enabled, true);
  assert.equal(highlightModelConfig({ ...ENV, HIGHLIGHT_MODEL_VERSION: "" }).enabled, false, "a result must always name its model");
});

test("a service failure says whether asking again can help", async () => {
  const config = highlightModelConfig(ENV);
  const failure = async (status) => requestPredictedHighlights(TEXT, config, async () => new Response("no", { status })).catch((err) => err);
  for (const status of [429, 500, 503]) assert.equal((await failure(status)).retryable, true, String(status));
  for (const status of [404, 413]) assert.equal((await failure(status)).retryable, false, String(status));
  const other = await requestPredictedHighlights(TEXT, config, async () => new Response(JSON.stringify({ ranges: [], modelVersion: "other" }), { status: 200 })).catch((err) => err);
  assert.ok(other instanceof HighlightModelError);
  assert.equal(other.retryable, false, "a result from another model is never used");
  const bad = await requestPredictedHighlights(TEXT, config, async () => new Response("{}", { status: 200 })).catch((err) => err);
  assert.equal(bad.retryable, true, "a malformed answer is not an empty result");
});

test("the backend's ranges are never passed through unchecked", () => {
  const raw = [{ start: 5, end: 9, source: "x" }, { start: 8, end: 12 }, { start: -1, end: 3 }, { start: 3, end: 3 }, { start: 1.5, end: 2 }, { start: 90, end: 120 }, null];
  assert.deepEqual(sanitizePredictedRanges(raw, 100), [{ start: 5, end: 12 }]);
  assert.deepEqual(sanitizePredictedRanges("nope", 100), []);
});

test("only the text before the reference section is sent, and offsets stay valid for the full text", async () => {
  const text = `${TEXT}

References
1. Someone. A title. Journal, 2020.`;
  let sent;
  const ranges = await requestPredictedHighlights(text, highlightModelConfig(ENV), async (_url, init) => {
    sent = JSON.parse(init.body).text;
    return ok([{ start: 0, end: 3 }])();
  });
  assert.equal(text.startsWith(sent), true);
  assert.equal(ranges.length, 1);
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
  assert.equal(predicted[0].start, TEXT.indexOf("The second"), "whole words only: no dash over the space after the match");
  assert.equal(TEXT.slice(predicted[0].start, predicted[0].end), "The second sentence is only predicted by the model");
  assert.equal(predicted[0].sourceIndex, -1);
  assert.equal(predicted[0].label, "");
  assert.equal(predicted[0].url, undefined);
  ranges.slice(1).forEach((r, i) => assert.ok(r.start >= ranges[i].end));
});

test("a piece left beside a verified match is drawn only if it still reads as a passage", () => {
  const text = "Alpha beta gamma delta. Cronbach's alpha was used to measure the scale, and so on to the very end of it.";
  const piece = (from, to) => { const start = text.indexOf(from), end = to ? text.indexOf(to) + to.length : start + from.length; const found = usablePredictedFragment(text, start, end); return found && text.slice(found.start, found.end); };
  assert.equal(usablePredictedFragment(text, text.indexOf(". Cron"), text.indexOf(". Cron") + 2), null, "punctuation and a space between two matches");
  assert.equal(piece(" "), null, "whitespace alone");
  assert.equal(piece("to"), null, "a stray word");
  assert.equal(piece("alpha was used"), null, "three words");
  assert.equal(piece("s alpha was used to"), "alpha was used to", "the tail of a word a match cut in two is dropped, and the rest stands");
  assert.equal(piece("Cronbach's alpha was us"), "Cronbach's alpha was", "as is the head of one, counting words as the model does");
  assert.equal(piece(" alpha was used to measure the scale, "), "alpha was used to measure the scale", "whole words, no dash over a space or a comma");
  const found = usablePredictedFragment(text, text.indexOf(" alpha"), text.indexOf(" measure"));
  assert.equal(found.start, text.indexOf("alpha was"), "offsets stay those of the report text");
});

test("a passage no match touches is drawn exactly as the model returned it, even when short", () => {
  const start = TEXT.indexOf("The second"), end = start + 3;
  const predicted = findHighlightRanges(report({ predictedHighlights: [{ start, end }] })).filter((r) => r.kind === "predicted");
  assert.deepEqual(predicted.map((r) => [r.start, r.end]), [[start, end]]);
});

test("screen and PDF draw the one list of displayed predictions", () => {
  const read = (file) => readFileSync(file, "utf8");
  assert.match(read("components/report/report-v2/report-v2-view.tsx"), /buildDisplayedPredicted\(report\)/);
  assert.match(read("components/report/report-v2/similarity-print-report.tsx"), /predicted: buildDisplayedPredicted\(report\)/);
  assert.equal(read("components/report/report-v2/report-v2-view.tsx").includes("onSelectPassage, report.predictedHighlights"), false);
  assert.match(read("components/report/report-v2/report-v2-view.tsx"), /mark unverified predicted passages\./);
});

test("no answer becomes a result with no passages unless the service shows it read the document", async () => {
  const HOSTED = { ...ENV, HIGHLIGHT_MODEL_URL: "https://model.example.test/predict" };
  const answer = (body) => async () => new Response(JSON.stringify(body), { status: 200 });
  const refused = (body, env = HOSTED) => requestPredictedHighlights(TEXT, highlightModelConfig(env), answer(body)).then(() => null, (err) => err);
  for (const body of [{ ranges: [] }, { ranges: [], modelVersion: "v1-test" }, { ranges: [], modelVersion: "v1-test", words: 0 }, { ranges: [], words: 23 }]) {
    const err = await refused(body);
    assert.equal(err?.retryable, true, JSON.stringify(body));
  }
  for (const ranges of [[{ start: -1, end: 3 }], [null], [{ start: 0, end: 5 }, { start: 3, end: TEXT.length + 9 }]]) {
    const err = await refused({ ranges, modelVersion: "v1-test", words: 23 });
    assert.equal(err?.message, "BAD_RESPONSE", "a garbled range fails the answer, it does not shrink it");
  }
  assert.deepEqual(await requestPredictedHighlights(TEXT, highlightModelConfig(HOSTED), answer({ ranges: [], modelVersion: "v1-test", words: 23 })), [], "a real empty result");
  assert.deepEqual(await requestPredictedHighlights(TEXT, highlightModelConfig(ENV), answer({ ranges: [] })), [], "the local sidecar names neither");
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
