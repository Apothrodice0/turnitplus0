import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExtractedText } from "../lib/extracted-text-normalization.ts";

/**
 * "Investigate two real detection issues" ISSUE 1 — direct unit coverage
 * for the shared post-extraction cleanup step, isolated from the real PDF/
 * DOCX fixtures (tests/pdf-docx-extraction-parity.test.mjs covers those).
 * See this module's own header comment for the full root-cause account:
 * the original `/<[^>]*>/g` tag-strip was unbounded and, given a single
 * stray "<" with no real closing tag nearby, would consume everything up
 * to the next literal ">" anywhere later in the text.
 */

test("REGRESSION: a stray math inequality '<' does not consume the rest of the document up to a much later '>'", () => {
  const text = "Given a value n < the total sequence length, the model computes attention scores. Later, a vector product x > y is evaluated in a different unrelated sentence.";
  const result = normalizeExtractedText(text);

  assert.match(result, /the model computes attention scores/, "text between the stray '<' and the later, unrelated '>' must survive");
  assert.match(result, /a different unrelated sentence/);
});

test("a real, well-formed HTML tag is still stripped", () => {
  const result = normalizeExtractedText("<p>Hello world</p> and <br/> a line break, plus <div class=\"note\">a note</div>.");
  assert.doesNotMatch(result, /<p>|<\/p>|<br\/>|<div/);
  assert.match(result, /Hello world/);
  assert.match(result, /a line break/);
  assert.match(result, /a note/);
});

test("a bare '<' or '>' with no plausible tag shape on either side is left alone (not swallowed)", () => {
  const result = normalizeExtractedText("The threshold is set where x < 10 and y > 5, which the model treats as body text.");
  assert.match(result, /the model treats as body text/);
});

test("whitespace collapsing and paragraph-break normalization still work exactly as before", () => {
  const result = normalizeExtractedText("Word1    Word2\t\tWord3\n\n\n\n\nWord4");
  assert.equal(result, "Word1 Word2 Word3\n\nWord4");
});

test("empty and whitespace-only input never throws", () => {
  assert.equal(normalizeExtractedText(""), "");
  assert.equal(normalizeExtractedText("   \n\n  "), "");
});
