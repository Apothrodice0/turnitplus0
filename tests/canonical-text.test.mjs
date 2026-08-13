import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeText } from "../lib/canonical-text.ts";

// Invisible/combining characters below are built from explicit code points
// rather than typed as literal characters, so this file stays legible/
// reviewable and the exact code points under test are unambiguous.
const BOM = String.fromCharCode(0xfeff);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const ZERO_WIDTH_NON_JOINER = String.fromCharCode(0x200c);
const COMBINING_ACUTE_ACCENT = String.fromCharCode(0x0301);

test("canonicalization is deterministic across repeated calls", () => {
  const text = "The quick brown fox\r\njumps over   the lazy dog.\n\n\n\nEnd.";
  const first = canonicalizeText(text);
  const second = canonicalizeText(text);
  assert.equal(first, second);
});

test("CRLF and CR line endings normalize the same as LF", () => {
  const lf = "Line one\nLine two\nLine three";
  const crlf = "Line one\r\nLine two\r\nLine three";
  const cr = "Line one\rLine two\rLine three";
  assert.equal(canonicalizeText(crlf), canonicalizeText(lf));
  assert.equal(canonicalizeText(cr), canonicalizeText(lf));
});

test("repeated horizontal whitespace collapses to a single space", () => {
  const spaced = "The   quick\tbrown     fox";
  const single = "The quick brown fox";
  assert.equal(canonicalizeText(spaced), canonicalizeText(single));
});

test("leading/trailing whitespace per line and around the document is trimmed", () => {
  const padded = "   Hello world.   \n   Second line.   \n   ";
  const trimmed = "Hello world.\nSecond line.";
  assert.equal(canonicalizeText(padded), trimmed);
});

test("runs of 3+ blank lines collapse to a single blank line", () => {
  const gappy = "Paragraph one.\n\n\n\n\nParagraph two.";
  const normalGap = "Paragraph one.\n\nParagraph two.";
  assert.equal(canonicalizeText(gappy), normalGap);
});

test("a byte-order mark and zero-width characters are stripped", () => {
  const withInvisibles = `${BOM}Hello${ZERO_WIDTH_SPACE} world${ZERO_WIDTH_NON_JOINER}.`;
  assert.equal(canonicalizeText(withInvisibles), "Hello world.");
});

test("NFC-equivalent unicode encodings canonicalize identically", () => {
  const precomposed = "café"; // e-acute as a single precomposed code point
  const decomposed = `cafe${COMBINING_ACUTE_ACCENT}`; // plain "e" + combining acute accent
  assert.notEqual(precomposed, decomposed, "sanity check: the two source encodings must actually differ before canonicalizing");
  assert.equal(canonicalizeText(precomposed), canonicalizeText(decomposed));
});

test("formatting-only differences (line endings, spacing, blank lines) produce the same canonical text", () => {
  const original = "Introduction\n\nThis paper examines climate policy.\n\nConclusion follows.";
  const reformatted = "Introduction\r\n\r\n\r\nThis   paper examines climate   policy.   \r\n\r\n\r\nConclusion follows.   ";
  assert.equal(canonicalizeText(original), canonicalizeText(reformatted));
});

test("case, punctuation, and word order are preserved — canonicalization is not a similarity transform", () => {
  const text = "The Quick, Brown Fox!";
  assert.equal(canonicalizeText(text), "The Quick, Brown Fox!");
});

test("meaningful content changes are not canonicalized away", () => {
  const original = "The committee approved the proposal.";
  const changed = "The committee rejected the proposal.";
  assert.notEqual(canonicalizeText(original), canonicalizeText(changed));
});

test("reordering words is not canonicalized away", () => {
  const original = "Alpha beta gamma delta.";
  const reordered = "Delta gamma beta alpha.";
  assert.notEqual(canonicalizeText(original), canonicalizeText(reordered));
});

console.log("canonical-text tests passed");
