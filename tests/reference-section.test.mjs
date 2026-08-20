import assert from "node:assert/strict";
import test from "node:test";
import { findReferenceSectionStart, stripReferenceSection } from "../lib/reference-section.ts";

/**
 * "Investigate two real detection issues" ISSUE 1 — direct unit coverage
 * for the shared reference-section detector, isolated from the real PDF/
 * DOCX fixtures (tests/pdf-docx-extraction-parity.test.mjs covers those
 * end to end). See this module's own header comment for the full
 * root-cause account.
 */

test("FORMAT-AGNOSTIC: a numbered reference list is detected whether or not the heading has surrounding newlines", () => {
  const withNewlines = "Body text ends here.\n\nReferences\n\n[1] Author, A. Title of work. Journal, 2020.\n[2] Other, B. Second title. Conf, 2019.";
  const withoutNewlines = "Body text ends here.  References  [1] Author, A. Title of work. Journal, 2020. [2] Other, B. Second title. Conf, 2019.";

  const withNewlinesBody = stripReferenceSection(withNewlines);
  const withoutNewlinesBody = stripReferenceSection(withoutNewlines);

  assert.match(withNewlinesBody, /Body text ends here\./);
  assert.doesNotMatch(withNewlinesBody, /Author, A\./);
  assert.match(withoutNewlinesBody, /Body text ends here\./);
  assert.doesNotMatch(withoutNewlinesBody, /Author, A\./, "the exact regression: PDF-style space-joined text (no newlines) must still have its reference list detected");
});

test("author-year style reference lists (no numbered brackets) are also detected", () => {
  const text = "The study concludes here.\n\nReferences\n\nSmith, J., & Doe, A. (2020). A study of things. Journal of Studies, 12(3), 45-67.\nJohnson, K. (2019). Another study. Publisher House.\nLee, M. (2018). Third study. Conf. Proc., 100-110.";
  const body = stripReferenceSection(text);
  assert.equal(body.trim(), "The study concludes here.");
});

test("FALSE POSITIVE GUARD: ordinary prose mentioning \"references\" without an actual list is never stripped", () => {
  const text = "This section references several prior studies in the field. As the references above indicate, the topic has been well studied, and many references converge on similar conclusions.";
  assert.equal(findReferenceSectionStart(text), -1);
  assert.equal(stripReferenceSection(text), text);
});

test("FALSE POSITIVE GUARD: a single bracketed in-text citation is not mistaken for a reference list opening", () => {
  const text = "Recent work [13] has shown that this approach generalizes well across a variety of unrelated downstream tasks discussed at length in the following sections of this paper.";
  assert.equal(findReferenceSectionStart(text), -1, "one isolated citation with ordinary prose after it must not be treated as the start of a reference list");
});

test("BIBLIOGRAPHY and WORKS CITED headings are recognized identically to REFERENCES", () => {
  const bibliography = "End of body.\n\nBibliography\n\n[1] A. One. Title. 2021.\n[2] B. Two. Title. 2020.";
  const worksCited = "End of body.\n\nWorks Cited\n\n[1] A. One. Title. 2021.\n[2] B. Two. Title. 2020.";
  assert.equal(stripReferenceSection(bibliography).trim(), "End of body.");
  assert.equal(stripReferenceSection(worksCited).trim(), "End of body.");
});

test("case-insensitive matching", () => {
  const text = "End of body.\n\nREFERENCES\n\n[1] A. One. Title. 2021.\n[2] B. Two. Title. 2020.";
  assert.equal(stripReferenceSection(text).trim(), "End of body.");
});

test("a document with no reference section at all is returned unchanged", () => {
  const text = "This is a short document with no bibliography or reference list of any kind, just plain body prose from start to finish.";
  assert.equal(findReferenceSectionStart(text), -1);
  assert.equal(stripReferenceSection(text), text);
});

test("the LAST qualifying heading wins when an earlier prose mention precedes the real section", () => {
  const text = "Our references to prior work are discussed throughout. We conclude here.\n\nReferences\n\n[1] Real, C. Actual entry. 2022.\n[2] Second, D. Another entry. 2021.";
  const body = stripReferenceSection(text);
  assert.match(body, /Our references to prior work are discussed throughout/, "the early incidental mention of \"references\" must survive as body text");
  assert.match(body, /We conclude here\./);
  assert.doesNotMatch(body, /Real, C\./);
});

test("empty input never throws", () => {
  assert.equal(findReferenceSectionStart(""), -1);
  assert.equal(stripReferenceSection(""), "");
});
