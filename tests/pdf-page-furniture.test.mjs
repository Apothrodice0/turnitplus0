import assert from "node:assert/strict";
import test from "node:test";
import { stripRepeatedPageFurniture } from "../lib/pdf-page-furniture.ts";

/**
 * "Investigate two production issues" ISSUE 2 — direct unit coverage for
 * the repeated-page-furniture stripper. See lib/pdf-page-furniture.ts's
 * own header comment for the full algorithm and root-cause account. The
 * header pattern below is modeled directly on the real one measured live
 * (title + decorative rule + author + page number, repeating on 17 of 19
 * real pages) — not copied verbatim from the real (unpublished, not this
 * project's own) document.
 */

function page(headerLine, body) {
  return `${headerLine} ${body}`;
}

test("REAL PATTERN: a running header (title + author + varying page number) repeating across most pages is stripped, leaving body text intact", () => {
  const header = (n) => `Media-Related Crimes Arising from Artificial Intelligence Applications in Algeria ---- Author Name ${n}`;
  const text = [
    "Cover page content with no repeated header at all.",
    page(header(214), "The discussion of the topic continues at considerable length here."),
    page(header(215), "A new subsection introduces further detail on the same subject."),
    page(header(216), "The legislative framework is examined in greater depth on this page."),
    page(header(217), "This concluding page wraps up the first section of the analysis."),
  ].join("\n\n");

  const stripped = stripRepeatedPageFurniture(text);

  assert.doesNotMatch(stripped, /Media-Related Crimes Arising from Artificial Intelligence Applications in Algeria/, "the repeated header text must be gone");
  assert.doesNotMatch(stripped, /Author Name \d+/, "every page's own header instance, page number included, must be stripped");
  assert.match(stripped, /The discussion of the topic continues at considerable length here\./);
  assert.match(stripped, /A new subsection introduces further detail on the same subject\./);
  assert.match(stripped, /The legislative framework is examined in greater depth on this page\./);
  assert.match(stripped, /This concluding page wraps up the first section of the analysis\./);
  assert.match(stripped, /Cover page content with no repeated header at all\./, "the one page that never matched the template must survive unchanged");
});

test("REAL PATTERN: a repeated running FOOTER (page number at the end of each page) is also stripped", () => {
  const footer = (n) => `Journal of Example Studies — page ${n}`;
  const text = [
    `First page body text goes here without any footer at all yet. ${footer(1)}`,
    `Second page body text continues the discussion in depth. ${footer(2)}`,
    `Third page body text wraps up the section nicely. ${footer(3)}`,
    `Fourth page body text starts the next major part. ${footer(4)}`,
  ].join("\n\n");

  const stripped = stripRepeatedPageFurniture(text);

  assert.doesNotMatch(stripped, /Journal of Example Studies/, "the repeated footer must be gone");
  assert.match(stripped, /First page body text goes here without any footer at all yet\./);
  assert.match(stripped, /Fourth page body text starts the next major part\./);
});

test("FALSE POSITIVE GUARD: a short document with fewer than the minimum chunk count is returned unchanged", () => {
  const text = "Page one content here.\n\nPage two content here, slightly different.";
  assert.equal(stripRepeatedPageFurniture(text), text);
});

test("FALSE POSITIVE GUARD: ordinary prose where a few paragraphs coincidentally start with the same common word is NOT stripped", () => {
  const text = [
    "The committee reviewed the proposal in detail before reaching a decision.",
    "The results were mixed across every subgroup studied in this analysis.",
    "The methodology section explains each step of the experimental design.",
    "A completely different opening sentence starts this fourth paragraph here.",
    "The conclusion summarizes the main findings of the entire study overall.",
  ].join("\n\n");

  const stripped = stripRepeatedPageFurniture(text);
  assert.equal(stripped, text, "a single shared word (\"The\") falls well short of MIN_FURNITURE_WORDS and must never trigger stripping");
});

test("FALSE POSITIVE GUARD: a document with no repeated structure at all is returned byte-for-byte unchanged", () => {
  const text = [
    "Introduction: this document explores several unrelated topics in depth.",
    "Methods: a variety of approaches were combined to answer the question.",
    "Results: the combined approach outperformed every baseline considered here.",
    "Discussion: these findings have implications for future research directions.",
    "Conclusion: further work is needed to confirm these preliminary results.",
  ].join("\n\n");
  assert.equal(stripRepeatedPageFurniture(text), text);
});

test("FALSE POSITIVE GUARD: a header-shaped pattern appearing on only 2 of 10 pages (below MIN_REPEAT_FRACTION) is left alone", () => {
  const rareHeader = "Unrelated Conference Proceedings 2020";
  const text = [
    `${rareHeader} First page unique content about topic A goes here in detail.`,
    "Second page has no header at all, just ordinary body prose continuing.",
    "Third page also has no header, discussing topic B at further length.",
    `${rareHeader} Fourth page repeats the header once more, about topic C.`,
    "Fifth through tenth pages never repeat it again in this short fixture.",
  ].join("\n\n");
  const stripped = stripRepeatedPageFurniture(text);
  assert.equal(stripped, text, "2 of 5 chunks (40%... but MIN_REPEAT_COUNT=3 is the binding constraint here) must not be enough evidence with fewer than 3 occurrences");
});

test("empty input never throws", () => {
  assert.equal(stripRepeatedPageFurniture(""), "");
});

test("a document that IS mostly header (degenerate case) never throws or infinite-loops", () => {
  const text = Array.from({ length: 5 }, (_, i) => `Header Line Repeats Every Time ${i}`).join("\n\n");
  assert.doesNotThrow(() => stripRepeatedPageFurniture(text));
});
