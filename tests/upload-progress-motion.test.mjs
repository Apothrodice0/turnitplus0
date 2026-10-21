/**
 * UPLOAD PROGRESS MOTION (2026-10-21): the upload card's animation is decoration only. These checks pin that it never
 * changes what the panel claims: the number it animates toward is the one lib/upload-progress.ts allows (≤ 95 % until the
 * save is confirmed, 100 % only then), there is still one bar, the panel adds no JavaScript timers, and every decorative
 * effect is switched off under prefers-reduced-motion.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DocumentUploadPanel } from "../components/reports/document-upload-panel.tsx";

const render = (over = {}) =>
  renderToStaticMarkup(
    React.createElement(DocumentUploadPanel, {
      file: { name: "thesis.pdf", size: 1024 },
      isGeneratingReport: true,
      progress: 0,
      processingLabel: "Saving your report",
      fileInputRef: { current: null },
      onChooseFile() {},
      onGenerate() {},
      ...over,
    }),
  );

const percentTarget = (html) => Number(/--upload-progress-pct:\s*(\d+)/.exec(html)?.[1]);
const percentText = (html) => /class="upload-progress-percent-text">(\d+)%</.exec(html)?.[1];

test("MOTION: the animated number targets exactly the displayed percent — 95 % at most before confirmation, 100 % only once confirmed", () => {
  for (const progress of [0, 2.4, 47.6, 94.99, 99.9, 100, 140]) {
    const html = render({ progress });
    assert.ok(percentTarget(html) <= 95, `progress ${progress} targets ${percentTarget(html)}`);
    assert.equal(String(percentTarget(html)), percentText(html), "the counter and the real text agree");
    assert.doesNotMatch(html, /100%/, `no 100 % anywhere before confirmation (progress ${progress})`);
  }
  assert.equal(percentTarget(render({ progress: 47.6 })), 47, "floored, never rounded up");
  const done = render({ progress: 95, complete: true, processingLabel: "Report saved" });
  assert.equal(percentTarget(done), 100);
  assert.equal(percentText(done), "100");
});

test("MOTION: still one bar, the stage text is unchanged, and the decoration runs only while the check is busy", () => {
  const html = render({ progress: 61, processingLabel: "Checking for matching passages" });
  assert.equal(html.match(/role="progressbar"/g)?.length, 1, "one progress bar");
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /class="upload-progress-status">Checking for matching passages<span class="upload-progress-dots" aria-hidden="true">/, "the stage label, then decorative dots hidden from assistive tech");
  assert.match(html, /class="upload-progress-encouragement">Getting there…</);
  const done = render({ progress: 95, complete: true, processingLabel: "Report saved" });
  assert.match(done, /aria-busy="false"/, "the shimmer and glow selectors stop once the report is saved");
  assert.doesNotMatch(done, /upload-progress-dots/, "no animated dots on 'Report saved'");
  const failed = render({ saveFailure: { message: "Not saved", retrying: false, onRetry() {} } });
  assert.doesNotMatch(failed, /aria-busy/, "the save-failed card has no ambient motion");
});

test("MOTION: CSS only — no timers in the panel, decoration scoped to the busy upload card, reduced motion turns it off", async () => {
  const panel = await readFile(new URL("../components/reports/document-upload-panel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /setInterval|setTimeout|requestAnimationFrame|useEffect/, "the panel adds no JavaScript animation loop");
  const css = (await readFile(new URL("../app/globals.css", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const start = css.indexOf("UPLOAD PROGRESS MOTION");
  assert.ok(start > 0);
  const block = css.slice(start);
  for (const selector of [".progress-track span::before", ".progress-track span::after", ".upload-locked-icon::after"]) {
    assert.ok(block.includes(`.upload-locked-panel[aria-busy="true"] ${selector}`), `${selector} only while busy`);
  }
  // the motion block's own reduced-motion rule (the first one after the block's header comment)
  const reducedAt = block.indexOf("@media (prefers-reduced-motion: reduce)");
  const reduced = block.slice(reducedAt, block.indexOf("\n}\n", reducedAt) + 2);
  for (const needle of ["transition: none", "display: none", "animation: none", ".upload-progress-dots span", ".upload-progress-status"]) {
    assert.ok(reduced.includes(needle), `reduced motion: ${needle}`);
  }
});
