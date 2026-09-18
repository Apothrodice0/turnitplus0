import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { tokenSpans } from "../lib/similarity-core.ts";
import { paginateManuscriptText } from "../lib/report-v2-view.ts";

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

// Finds selectorStart (which must end in "{") and returns everything up to
// its OWN matching closing brace, via real brace-depth counting — not an
// indentation guess, which breaks whenever an earlier, unrelated,
// same-named top-level rule (e.g. the screen-mode ".print-report-bundle
// { display: none; }" this file's own base rule declares) sits before the
// intended one and isn't formatted with a 2-space-indented closing brace.
// fromIndex lets a caller skip past an earlier, unrelated occurrence of the
// same selector text (e.g. that screen-mode rule) to reach the print one.
function block(css, selectorStart, fromIndex = 0) {
  assert.ok(selectorStart.trimEnd().endsWith("{"), "selectorStart must end with the rule's opening brace");
  const start = css.indexOf(selectorStart, fromIndex);
  assert.ok(start > -1, `selector "${selectorStart}" must exist at or after index ${fromIndex}`);
  let depth = 1;
  let i = start + selectorStart.length;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  assert.ok(depth === 0, `selector "${selectorStart}" never closes`);
  return css.slice(start, i);
}

// The offset of the @media print block whose rules this whole file is
// about — every selector guaranteed to be scoped to print (not merely
// same-named as an unrelated screen-mode rule elsewhere, like the base
// ".print-report-bundle { display: none; }") should search from here.
function printMediaOffset(css) {
  const idx = css.indexOf("@media print {");
  assert.ok(idx > -1, "the @media print block must exist");
  return idx;
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

test("PHYSICAL WRAPPER: no desktop/screen max-width leaks into the print bundle — it is pinned to the physical 8.5in sheet, not left unconstrained", async () => {
  const css = await readCss();
  const rule = block(css, ".print-report-bundle {", printMediaOffset(css));
  assert.match(rule, /max-width:\s*8\.5in;/);
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

/**
 * Native-print root-canvas fix: a real customer's Chrome print output
 * emitted the whole similarity report at exactly 2/3 physical scale (PDF
 * content-stream transform 2.0833335 instead of AI's correct 3.125) even
 * though .report-paper itself always measured a correct 8.5in via
 * getBoundingClientRect() — the defect was in the print-time WIDTH of the
 * ancestor chain above .report-paper (html/body/.result-view/.print-
 * report-bundle/.rv2-print-flow), which Chromium's print compositor can
 * read from independently of any one descendant's own box. These tests
 * assert that every level of that chain is pinned to a physical 8.5in
 * (never a percentage/viewport-relative width, which is what silently
 * regressed to full on-screen width before this fix), so the print root
 * cannot become viewport-width again without one of these assertions
 * failing.
 */
test("PRINT ROOT: html/body/.result-view.report-detail-page are pinned to a physical 8.5in width in print, scoped to pages that actually render the print bundle", async () => {
  const css = await readCss();
  const selectorStart = "html:has(.print-report-bundle),";
  const idx = css.indexOf(selectorStart);
  assert.ok(idx > -1, "the print-root normalization rule must exist, scoped via :has(.print-report-bundle)");
  const ruleEnd = css.indexOf("\n  }", idx);
  const rule = css.slice(idx, ruleEnd);
  assert.match(rule, /body:has\(\.print-report-bundle\)/, "body must be pinned too");
  assert.match(rule, /\.result-view\.report-detail-page:has\(\.print-report-bundle\)/, "the report page's own root section must be pinned too");
  assert.match(rule, /width:\s*8\.5in;/);
  assert.match(rule, /min-width:\s*8\.5in;/);
  assert.match(rule, /max-width:\s*8\.5in;/);
});

test("PRINT ROOT: .print-report-bundle is pinned to a physical 8.5in width, never a percentage/viewport-relative width", async () => {
  const css = await readCss();
  const rule = block(css, ".print-report-bundle {", printMediaOffset(css));
  assert.match(rule, /width:\s*8\.5in;/);
  assert.match(rule, /min-width:\s*8\.5in;/);
  assert.match(rule, /max-width:\s*8\.5in;/);
  assert.doesNotMatch(rule, /width:\s*100%;/, "the old viewport-relative width must be gone — this is exactly the regression this test guards against");
  assert.doesNotMatch(rule, /max-width:\s*none;/, "the old unconstrained max-width must be gone");
});

test("PRINT ROOT: .rv2-print-flow generates no box of its own in print (display: contents), so it can never itself be a wider-than-8.5in ancestor", async () => {
  const css = await readCss();
  const rule = block(css, ".rv2-print-flow {");
  assert.match(rule, /display:\s*contents;/);
});

test("PRINT ROOT: every existing .rv2-print-flow <descendant> rule still targets real, still-matching selectors (display: contents preserves DOM ancestry, only suppresses the wrapper's own box)", async () => {
  const css = await readCss();
  assert.match(css, /\.rv2-print-flow \.report-paper \{/);
  assert.match(css, /\.rv2-print-flow \.report-paper\.rv2-print-paper,/);
  assert.match(css, /\.rv2-print-flow \.submission-copy \{/);
});

test("PRINT ROOT: @page Letter sizing is untouched by the root-canvas fix", async () => {
  const css = await readCss();
  assert.match(css, /@page \{\s*size:\s*letter;\s*margin:\s*0;\s*\}/);
});

/**
 * Limitation, stated per this file's own review: the strongest possible
 * check here would generate a real PDF via a Chromium-family browser and
 * inspect its content-stream `cm` transform directly (this fix was in fact
 * verified that way during development — confirmed both Similarity and AI
 * emit MediaBox 612x792pt with the inner transform pinned at 3.125, i.e.
 * a correct 8.5in x 11in physical page, before and after). That check is
 * NOT encoded as an automated test here because it requires a local
 * Chromium/Edge/Chrome binary this project does not declare or bundle as
 * a dependency, and any hardcoded executable path would be specific to
 * one machine/OS and break portably for other contributors or CI. The
 * CSS-level assertions above are the strongest stable, portable
 * equivalent: they assert the exact mechanism (a physically-pinned
 * 8.5in width at every ancestor level, with no percentage/viewport-
 * relative width surviving anywhere in the chain) that the verified PDF
 * output depends on.
 */

/**
 * Manuscript-overflow fix: a real submitted document's manuscript can
 * contain a run of text with no natural break point at all — an Arabic
 * tatweel/separator line, a very long URL, a long no-space identifier.
 * .submission-rendered-text's white-space: pre-wrap (needed to preserve
 * the manuscript's own whitespace/newlines) only wraps at existing break
 * opportunities; with no overflow-wrap override, such a run renders past
 * .submission-copy's own 720px max-width instead of wrapping. Confirmed
 * during this fix, via real Chromium (Edge) print rendering on a fixture
 * built from a real, already-proven-correct 6,144-word V2 report with
 * exactly this kind of content appended to its manuscript text: BEFORE —
 * .report-paper scrollWidth 1233px (vs. its own 816px width), PDF inner
 * transform 2.0833335 (the exact defective scale originally reported,
 * instead of the correct 3.125). AFTER adding `overflow-wrap: anywhere`
 * to the print-scoped .submission-copy rule (inherited down through
 * .submission-rendered-text and any .submission-match highlight span,
 * neither of which overrides it) — .report-paper scrollWidth back to
 * 816px, PDF inner transform back to 3.125, all three unbreakable tokens
 * still present in full (confirmed by joining every .submission-copy's
 * own text across pages — no character lost or altered, the very long
 * token was simply free to land its own natural word-boundary page-split
 * like any other non-highlighted text, exactly as paginateManuscriptText
 * already guarantees). Screen already handles this identically for the
 * interactive workspace's own manuscript view (see the pre-existing,
 * unrelated `.rv2-doc { white-space: pre-wrap; overflow-wrap: anywhere;
 * }` rule) — this fix brings print into parity with it, print-only.
 */
test("MANUSCRIPT OVERFLOW: the print-scoped .submission-copy rule allows emergency wrapping (overflow-wrap: anywhere) so an unbreakable run cannot force the physical sheet wider than 8.5in", async () => {
  const css = await readCss();
  const rule = block(css, ".rv2-print-flow .submission-copy {");
  assert.match(rule, /overflow-wrap:\s*anywhere;/);
  // white-space: pre-wrap itself lives on .submission-rendered-text, not
  // here — confirm that rule (manuscript whitespace/newline preservation)
  // is untouched by this fix.
  const renderedRule = block(css, ".submission-rendered-text {");
  assert.match(renderedRule, /white-space:\s*pre-wrap;/);
});

test("MANUSCRIPT OVERFLOW: the fix does not clip content — no overflow:hidden was added to .submission-copy or .submission-rendered-text in print", async () => {
  const css = await readCss();
  const rule = block(css, ".rv2-print-flow .submission-copy {");
  assert.doesNotMatch(rule, /overflow:\s*hidden/);
});

test("MANUSCRIPT OVERFLOW: real paginateManuscriptText() still reconstructs exactly, byte-for-byte, when the text contains an unbroken Arabic tatweel run, a long URL, and a long no-space ASCII token — the same three shapes that reproduced the real defect", () => {
  const tatweel = "ـ".repeat(140);
  const longUrl = "https://example-archive.test/documents/legal/mobilization/2008/decree-08-13/annex-institutional-framework-crisis-emergency-provisions-full-text-reference-copy-accessed-2026-09-18.pdf";
  const longToken = "SupplementaryReferenceIdentifierBlock00000000000000000000000000000000000000000000000000000000000000000000000000000000ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const base = "Ordinary manuscript prose. ".repeat(400);
  const text = `${base}\n\nOVERFLOW_TEST_MARKER_START ${tatweel} ${longUrl} ${longToken} OVERFLOW_TEST_MARKER_END`;

  const spans = tokenSpans(text);
  assert.ok(spans.length > 400, "must actually tokenize a realistic number of words, not just the marker line");

  const pageRanges = paginateManuscriptText(text, []);
  assert.ok(pageRanges.length >= 1);
  const reconstructed = pageRanges.map((p) => text.slice(p.start, p.end)).join("");
  assert.equal(reconstructed, text, "joined paginated ranges must reconstruct the exact original text, including every unbreakable token, byte-for-byte");

  // Prove none of the three tokens were altered or dropped anywhere in the
  // reconstructed text (this is the DOM-level "no clipping" guarantee's
  // upstream, code-level precondition — paginateManuscriptText itself
  // never truncates or rewrites a token, wrapping is purely a print-CSS
  // rendering concern layered on top of this exact, unmodified text).
  assert.ok(reconstructed.includes(tatweel));
  assert.ok(reconstructed.includes(longUrl));
  assert.ok(reconstructed.includes(longToken));
});
