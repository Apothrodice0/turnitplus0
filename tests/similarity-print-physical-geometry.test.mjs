import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Physical-sheet print-geometry fix: `.print-report-bundle .report-paper`
 * used to force `display: block` for every print page (AiReport, the legacy
 * Similarity Overview/Manuscript/Sources pages, and the V2 source appendix
 * alike), which silently defeated the screen layout's own `display: flex;
 * flex-direction: column` — under block layout `.paper-content { flex: 1 }`
 * has no effect, so the footer sat right after however tall the content
 * happened to be instead of at the bottom of the declared 8.5in x 11in
 * sheet, leaving the rest of the physical page blank. Verified against real
 * Chromium print rendering (Edge, headless) during this fix: footer
 * top/bottom went from ~83%/~90% (legacy overview), ~33%/~40% (legacy
 * sources), ~73%/~79% (AI report), and a collapsed ~52%-tall page (V2
 * source appendix) to ~94%/100% in every case, with zero PDF page-count
 * change and zero change to the already-correct V2 overview/manuscript
 * pages. These tests assert the CSS/structural facts that made that
 * measured result true, following this file's own convention (see
 * tests/report-mobile-layout.test.mjs) of asserting against the stylesheet
 * source rather than rendering a browser.
 */

async function readCss() {
  return readFile(new URL("../app/globals.css", import.meta.url), "utf8");
}

function block(css, selectorStart) {
  const start = css.indexOf(selectorStart);
  assert.ok(start > -1, `selector "${selectorStart}" must exist`);
  const end = css.indexOf("\n  }", start);
  return css.slice(start, end);
}

test("PHYSICAL WRAPPER: the base print .report-paper rule is a flex column, not block, and keeps its declared 8.5in x 11in physical sheet size", async () => {
  const css = await readCss();
  const rule = block(css, ".print-report-bundle .report-paper {");
  assert.match(rule, /display:\s*flex;/, "must be a flex container so .paper-content{flex:1} can push the footer to the bottom");
  assert.match(rule, /flex-direction:\s*column;/);
  assert.doesNotMatch(rule, /display:\s*block;/);
  assert.match(rule, /width:\s*8\.5in;/, "physical page width must stay untouched");
  assert.match(rule, /min-height:\s*11in;/, "physical page height must stay untouched");
});

test("PHYSICAL WRAPPER: no desktop/screen max-width leaks into the print bundle", async () => {
  const css = await readCss();
  const rule = block(css, ".print-report-bundle {");
  assert.match(rule, /max-width:\s*none;/);
});

test("FOOTER ANCHOR: .paper-content still stretches to fill the flex column, so the footer (its sibling) lands at the bottom of the sheet rather than the middle", async () => {
  const css = await readCss();
  const rule = block(css, ".paper-content {");
  assert.match(rule, /flex:\s*1;/);
});

test("SOURCE DETAILS: the V2 source-appendix page (rv2-print-paper, no page-specific class of its own) now shares the same restored 11in physical wrapper as the overview/manuscript pages, instead of collapsing to its own short content height", async () => {
  const css = await readCss();
  const selectorStart = ".rv2-print-flow .report-paper.rv2-print-paper,";
  const idx = css.indexOf(selectorStart);
  assert.ok(idx > -1, "rv2-print-paper must be included in the min-height restoration selector list");
  const ruleEnd = css.indexOf("\n  }", idx);
  const rule = css.slice(idx, ruleEnd);
  assert.match(rule, /rv2-print-overview/, "must still cover the overview page");
  assert.match(rule, /rv2-print-manuscript-page/, "must still cover manuscript pages");
  assert.match(rule, /min-height:\s*11in;/);
});

test("AI REPORT NON-REGRESSION: AiReport's root still carries the shared report-paper class (so it inherits the flex-column physical-wrapper fix) alongside its own ai-paper class", async () => {
  const aiReport = await readFile(new URL("../components/report/ai-report.tsx", import.meta.url), "utf8");
  assert.match(aiReport, /className=\{`report-paper ai-paper /);
});

test("AI REPORT NON-REGRESSION: the ai-paper print rule (min-height: 11in) is untouched by this fix", async () => {
  const css = await readCss();
  assert.match(css, /\.print-report-bundle \.ai-paper \{[\s\S]*?min-height:\s*11in;/);
});

test("LEGACY PAGES: OverviewReport and SourcesReport both still render through the shared report-paper wrapper, so they inherit the same physical-sheet fix as AiReport and the V2 pages", async () => {
  const papers = await readFile(new URL("../components/report/similarity-report-papers.tsx", import.meta.url), "utf8");
  assert.match(papers, /className="report-paper overview-paper"/);
  assert.match(papers, /className="report-paper sources-paper"/);
});

test("NO PAGE-COUNT / BREAK-BEHAVIOR CHANGE: the forced break-after: page (and its :last-child reset) on .report-paper are untouched by the display fix", async () => {
  const css = await readCss();
  const rule = block(css, ".print-report-bundle .report-paper {");
  assert.match(rule, /break-after:\s*page;/);
  assert.match(rule, /page-break-after:\s*always;/);
  const lastChildRule = block(css, ".print-report-bundle .report-paper:last-child {");
  assert.match(lastChildRule, /break-after:\s*auto;/);
});
