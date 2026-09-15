import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * UX cleanup — final substantive slice: the customer report's
 * .report-workspace/.report-paper used a fixed 720px paper width at the
 * narrow (<=760px) breakpoint, forcing every phone-width viewport to
 * horizontally scroll to read the report (the product's primary
 * deliverable). Fixed by making .report-paper responsive at that
 * breakpoint, matching the .overview-paper override that already proved
 * this exact pattern renders correctly. Print is architecturally separate
 * (a different, more specific selector with its own fixed page sizing,
 * and .report-workspace is hidden entirely during print) and is asserted
 * unchanged below.
 *
 * RESPONSIVE_EDGE_CASE_FOUND follow-up: that fix alone left .paper-header/
 * .paper-footer's base 44px horizontal padding + 20px gap in place, which
 * was harmless inside the old 720px-wide paper but left only ~212px of
 * content room at a ~320px phone width once the paper itself became
 * responsive -- narrower than the header/footer's own combined min-content
 * (brand lockup + page label + "Submission ID" + id). Fixed by shrinking
 * only the horizontal spacing (padding-left/right 44px->16px, gap 20px->12px)
 * at the same <=760px breakpoint -- vertical padding, the submission id
 * content, desktop spacing, and print sizing are all untouched.
 */

async function readCss() {
  return readFile(new URL("../app/globals.css", import.meta.url), "utf8");
}

// Isolate the exact narrow-screen block under test, so assertions can't
// accidentally match an unrelated selector elsewhere in this ~7800-line file.
function narrowBlock(css) {
  const start = css.indexOf("@media (max-width: 760px)");
  assert.ok(start > -1, "the narrow-screen breakpoint must still exist");
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

// ── A + B: screen .report-paper is responsive, no fixed mobile-exceeding width ──
test("A: the narrow-screen .report-paper rule no longer sets a fixed width that exceeds a 320-390px phone viewport", async () => {
  const block = narrowBlock(await readCss());
  const reportPaperRule = block.match(/\.report-paper\s*\{([^}]*)\}/);
  assert.ok(reportPaperRule, "the narrow-screen .report-paper rule must still exist");
  assert.doesNotMatch(reportPaperRule[1], /width:\s*720px/, "the old fixed 720px width must be gone");
  assert.doesNotMatch(reportPaperRule[1], /width:\s*\d{3,}px/, "no other fixed pixel width wider than 2 digits (i.e. >=100px) should replace it");
});

test("B: the narrow-screen .report-paper rule now shrinks to the available width", async () => {
  const block = narrowBlock(await readCss());
  const reportPaperRule = block.match(/\.report-paper\s*\{([^}]*)\}/);
  assert.match(reportPaperRule[1], /width:\s*100%/, "must fill the available (already-constrained) .report-workspace width");
});

test("B (also): .report-workspace at this breakpoint constrains its own width to the viewport, so .report-paper's 100% cannot itself exceed the screen", async () => {
  const block = narrowBlock(await readCss());
  const workspaceRule = block.match(/\.report-workspace\s*\{([^}]*)\}/);
  assert.ok(workspaceRule, "the narrow-screen .report-workspace rule must still exist");
  assert.match(workspaceRule[1], /width:\s*100%/);
  assert.doesNotMatch(workspaceRule[1], /min-width/, "no min-width should reintroduce a viewport-exceeding floor");
});

// ── C: print sizing preserved, architecturally separate ─────────────────
test("C: print's own .report-paper sizing (8.5in fixed page width) is untouched by the mobile fix", async () => {
  const css = await readCss();
  assert.match(css, /\.print-report-bundle \.report-paper \{[\s\S]*?width:\s*8\.5in;/, "print keeps its own real US Letter page width, independent of the screen breakpoint's value");
  assert.match(css, /\.print-report-bundle \.report-paper \{[\s\S]*?overflow:\s*visible;/, "unrelated pre-existing print rule (regression guard shared with tests/ai-report-print.test.mjs) still intact");
});

test("C (also): .report-workspace (which holds the screen-only .report-paper instances) is still fully hidden during print, so the mobile breakpoint's rules never apply to the print bundle", async () => {
  const css = await readCss();
  assert.match(css, /@media print \{[\s\S]*?\.report-workspace,[\s\S]*?display:\s*none\s*!important;/);
});

// ── D: no overflow-x:hidden was added anywhere to mask the bug ──────────
test("D: no overflow-x: hidden was introduced on body/html/.report-workspace/.report-paper to mask the overflow instead of fixing the width", async () => {
  const css = await readCss();
  const suspiciousSelectors = /(?:^|[\s,{])(?:body|html|\.report-workspace|\.report-paper|\.site-shell)\s*\{[^}]*overflow-x:\s*hidden/;
  assert.doesNotMatch(css, suspiciousSelectors);
  // The one intentional overflow-x on this workspace is the pre-existing,
  // still-safe "auto" fallback (never hides real overflow, just doesn't
  // force a scrollbar when nothing overflows).
  const block = narrowBlock(css);
  const workspaceRule = block.match(/\.report-workspace\s*\{([^}]*)\}/);
  assert.match(workspaceRule[1], /overflow-x:\s*auto/);
});

// ── E: existing long-content safety nets are unchanged and still present ──
test("E: the existing URL/DOI overflow-wrap safety nets in the academic-evidence card were not touched and remain in place", async () => {
  const css = await readCss();
  assert.match(css, /\.academic-evidence-card\s*\{[^}]*min-width:\s*0;/, "the card can still shrink inside a narrower paper");
  assert.match(css, /\.academic-evidence-links span\s*\{[^}]*overflow-wrap:\s*anywhere;/, "long DOI text still wraps safely rather than forcing width");
  assert.match(css, /\.academic-evidence-card h4\s*\{[^}]*overflow-wrap:\s*break-word;/, "long source titles still wrap safely");
});

// ── scope guard: only the narrow-screen block's report-paper/workspace rules changed ──
test("SCOPE: the base (desktop) .report-workspace/.report-paper rules and the >=1180px/920px tiers are untouched", async () => {
  const css = await readCss();
  assert.match(css, /\.report-workspace\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(620px,\s*840px\)\s*250px;/, "base desktop grid is unchanged");
  assert.match(css, /@media \(max-width:\s*1180px\)\s*\{\s*\.report-workspace\s*\{\s*grid-template-columns:\s*minmax\(600px,\s*820px\);/, "tablet tier is unchanged");
});

// ── follow-up F/B: header/footer get a narrow-screen-safe horizontal spacing rule ──
test("F: the narrow-screen block now has a dedicated .paper-header/.paper-footer horizontal-spacing rule, narrower than the base 44px/20px", async () => {
  const block = narrowBlock(await readCss());
  const rule = block.match(/\.paper-header,\s*\n\s*\.paper-footer\s*\{([^}]*)\}/);
  assert.ok(rule, "a narrow-screen .paper-header, .paper-footer rule must exist");
  const body = rule[1];
  assert.match(body, /padding-left:\s*\d{1,2}px/, "horizontal padding must shrink to a two-digit (i.e. <100px) pixel value");
  assert.match(body, /padding-right:\s*\d{1,2}px/);
  const leftPx = Number(body.match(/padding-left:\s*(\d{1,2})px/)[1]);
  const rightPx = Number(body.match(/padding-right:\s*(\d{1,2})px/)[1]);
  assert.ok(leftPx < 44 && rightPx < 44, "must be narrower than the base 44px horizontal padding");
  const gapMatch = body.match(/gap:\s*(\d{1,2})px/);
  if (gapMatch) assert.ok(Number(gapMatch[1]) < 20, "if gap is overridden here, it must be narrower than the base 20px");
  // Only horizontal spacing is touched -- no vertical padding/other property
  // reintroduced here that could clobber the header's 30/18 or footer's
  // 20/30 vertical values set elsewhere.
  assert.doesNotMatch(body, /padding-top|padding-bottom|padding:\s*\d/);
});

// ── follow-up G/C: desktop (base) header/footer spacing is unchanged ────
test("G: the base (desktop) .paper-header/.paper-footer rule still has its original 44px horizontal padding and 20px gap", async () => {
  const css = await readCss();
  const baseRule = css.match(/\.paper-header,\s*\n\.paper-footer\s*\{([^}]*)\}/);
  assert.ok(baseRule, "the base .paper-header, .paper-footer rule must still exist unchanged in shape");
  assert.match(baseRule[1], /grid-template-columns:\s*auto 1fr auto;/);
  assert.match(baseRule[1], /gap:\s*20px;/);
  assert.match(baseRule[1], /padding:\s*30px 44px 18px;/, "the original desktop padding shorthand (including the 44px this task only overrides at <=760px) is untouched");
});

// ── follow-up H/D: no @media print rule for header/footer was added ─────
test("H: no new @media print rule for .paper-header/.paper-footer was introduced -- print sizing for the report/header/footer is unchanged by this correction", async () => {
  const css = await readCss();
  // Every real @media print { ... } block declaration (there are two in
  // this file: the legacy report bundle, and Report V2's own print rules).
  // Matched on the literal "{" so a prose mention of the phrase (e.g. this
  // test file's own sibling comment in the CSS) can never be mistaken for
  // an actual rule block.
  const printBlocks = [...css.matchAll(/@media print \{/g)];
  assert.ok(printBlocks.length >= 1, "at least one real @media print rule must exist");
  for (const match of printBlocks) {
    const start = match.index;
    const end = css.indexOf("\n}", start);
    const block = css.slice(start, end);
    assert.doesNotMatch(block, /\.paper-header|\.paper-footer/, "this correction is screen-only; no @media print block mentions these selectors, so print inherits their normal (unmodified) desktop-shaped rule inside .print-report-bundle");
  }
  // Re-assert the print .report-paper sizing this correction must not disturb.
  assert.match(css, /@media print \{[\s\S]*?\.print-report-bundle \.report-paper \{[\s\S]*?width:\s*8\.5in;/);
});
