import assert from "node:assert/strict";
import test from "node:test";
import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../lib/document-correspondence.ts";

const BASE_DOCUMENT = [
  "Speleologists mapping an unexplored limestone cave system documented a previously unrecorded colony of blind cave salamanders clustered near a subterranean thermal vent.",
  "Water temperature readings collected across six survey seasons showed the vent maintained a remarkably stable output despite substantial surface seasonal variation.",
  "Genetic sampling of the salamander population indicated significant isolation from surface-dwelling relatives, consistent with many thousands of years of separate subterranean adaptation.",
  "Researchers proposed that the thermal vent itself functions as a keystone microhabitat sustaining an otherwise energy-poor deep cave ecosystem.",
  "Continued monitoring is planned to determine whether comparable thermal microhabitats exist elsewhere within the same extensive karst network.",
].join(" ");

const UNRELATED_DOCUMENT = [
  "Urban planners redesigning a congested downtown intersection studied pedestrian crossing patterns recorded across three consecutive weekday rush-hour periods.",
  "Traffic signal timing adjustments reduced average pedestrian wait times without measurably increasing vehicle congestion on adjacent connecting streets.",
  "A follow-up survey found pedestrians reported feeling meaningfully safer crossing the intersection after the adjusted signal timing was implemented.",
  "Planners recommended extending the same signal-timing adjustments to two other comparably congested intersections within the same district.",
  "Budget approval for the wider rollout is expected during the next municipal capital-improvement planning cycle.",
].join(" ");

// Every word here is either shorter than four characters or present in
// lib/similarity-core.ts's COMMON_WORDS set (the same fixture discipline
// used in tests/discovery-signals.test.mjs's FILLER_TEXT) — this guarantees
// zero informative shingles regardless of position, which is what actually
// makes a phrase "common" in the sense lib/similarity-core.ts's
// informativeGram() suppresses. Real academic-transition words like
// "study"/"results"/"indicate" are individually long enough to count as
// *informative* under that existing heuristic even though they read as
// generic to a human — reusing that exact, already-established heuristic
// (rather than inventing new semantic detection) means the fixture must
// respect its actual rules, not just its intent.
const COMMON_PHRASE_ONLY = "the a an is was are be to of in on at by for and or with as that this which le la les des une un et de du en";

// --- CASE A: exact canonical copy -----------------------------------------------

test("CASE A: an exact canonical copy produces strong correspondence via the canonical-hash short-circuit", () => {
  const result = computeDocumentCorrespondence(BASE_DOCUMENT, BASE_DOCUMENT);
  assert.equal(result.method, "canonical_hash");
  assert.equal(result.exactCanonicalMatch, true);
  assert.equal(result.strongCorrespondence, true);
  assert.equal(result.containment, 1);
});

// --- CASE B: formatting-only differences ----------------------------------------

test("CASE B: formatting-only differences (extra whitespace/line breaks) still produce strong correspondence", () => {
  const reformatted = BASE_DOCUMENT.replace(/\. /g, ".\n\n   ");
  const result = computeDocumentCorrespondence(BASE_DOCUMENT, reformatted);
  assert.equal(result.strongCorrespondence, true);
});

// --- CASE C/D: title/author alone ------------------------------------------------

test("CASE C: sharing only a short title-like line does NOT produce strong correspondence", () => {
  const titleOnly = "A Study of Subterranean Ecosystems";
  const result = computeDocumentCorrespondence(`${titleOnly}. ${BASE_DOCUMENT}`, `${titleOnly}. ${UNRELATED_DOCUMENT}`);
  assert.equal(result.strongCorrespondence, false);
});

test("CASE D: sharing only an author-like line does NOT produce strong correspondence", () => {
  const authorLine = "By Doctor Priyanka Vasquez Chen";
  const result = computeDocumentCorrespondence(`${authorLine}. ${BASE_DOCUMENT}`, `${authorLine}. ${UNRELATED_DOCUMENT}`);
  assert.equal(result.strongCorrespondence, false);
});

// --- CASE E: short common phrase -------------------------------------------------

test("CASE E: a short common/generic phrase does NOT produce strong correspondence", () => {
  const result = computeDocumentCorrespondence(COMMON_PHRASE_ONLY, `${COMMON_PHRASE_ONLY} ${UNRELATED_DOCUMENT}`);
  assert.equal(result.strongCorrespondence, false);
  assert.equal(result.passages.length, 0, "generic boilerplate must not even register as a passage");
});

// --- CASE F: 95% overlap ----------------------------------------------------------

test("CASE F: near-total (95%+) overlap produces strong correspondence", () => {
  const words = BASE_DOCUMENT.split(" ");
  const trimmed = words.slice(0, Math.floor(words.length * 0.95)).join(" ");
  const result = computeDocumentCorrespondence(BASE_DOCUMENT, trimmed);
  assert.equal(result.strongCorrespondence, true);
  assert.ok(result.containment >= 0.9);
});

// --- CASE G/L: 20% overlap is configurable ----------------------------------------

test("CASE G/L: ~20% overlap is not strong under default thresholds, but becomes strong once the threshold is lowered — proving the threshold is configurable and load-bearing", () => {
  const sharedPortion = BASE_DOCUMENT.split(" ").slice(0, Math.floor(BASE_DOCUMENT.split(" ").length * 0.2)).join(" ");
  const partial = `${sharedPortion} ${UNRELATED_DOCUMENT}`;

  const defaultResult = computeDocumentCorrespondence(BASE_DOCUMENT, partial);
  assert.equal(defaultResult.strongCorrespondence, false, "20% containment must not be strong under this phase's default (0.6) threshold");

  const lowered = { ...DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS, strongContainmentThreshold: Math.max(0.01, defaultResult.containment - 0.05) };
  const loweredResult = computeDocumentCorrespondence(BASE_DOCUMENT, partial, lowered);
  assert.equal(loweredResult.strongCorrespondence, true, "the same input must become strong once the threshold is lowered below its actual containment");
});

// --- CASE H: small but extremely long contiguous copied passage -------------------

test("CASE H: a single long verbatim passage is preserved as passage evidence even when whole-document containment is low", () => {
  const longVerbatimPassage = Array.from({ length: 40 }, (_, i) => `distinctivewordforpassage${i}`).join(" ");
  const hostA = `${UNRELATED_DOCUMENT} ${longVerbatimPassage} ${UNRELATED_DOCUMENT}`;
  const hostB = `${BASE_DOCUMENT} ${longVerbatimPassage} ${BASE_DOCUMENT}`;

  const result = computeDocumentCorrespondence(hostA, hostB);
  assert.ok(result.containment < DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.strongContainmentThreshold, "the fixture must actually have low overall containment for this test to mean anything");
  assert.ok(result.passages.length > 0, "the long copied passage must still be preserved as passage-level evidence");
  assert.ok(result.longestMatchWords >= 30, "the long contiguous match must be reflected in longestMatchWords regardless of the low overall percentage");
});

// --- CASE I: multiple copied passages ---------------------------------------------

test("CASE I: multiple separated copied passages produce multiple passage records", () => {
  // Fully synthetic, disjoint vocabularies for every filler segment — any
  // reused real-text filler (even reordered or re-cased) would still share
  // shingles by set membership regardless of position, merging what should
  // be two separate passages into one contiguous accepted span. Only
  // passageOne/passageTwo are shared between hostA and hostB; every filler
  // block is unique to its own host.
  const words = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
  const passageOne = words("sharedpassageonetoken", 15);
  const passageTwo = words("sharedpassagetwotoken", 15);

  const hostA = `${words("onlyinhostafillera", 20)} ${passageOne} ${words("onlyinhostafillerb", 20)} ${passageTwo} ${words("onlyinhostafillerc", 20)}`;
  const hostB = `${words("onlyinhostbfillera", 20)} ${passageOne} ${words("onlyinhostbfillerb", 20)} ${passageTwo} ${words("onlyinhostbfillerc", 20)}`;

  const result = computeDocumentCorrespondence(hostA, hostB);
  assert.ok(result.passages.length >= 2, `expected at least 2 distinct passages, got ${result.passages.length}`);
});

// --- CASE J: reordered unrelated content -------------------------------------------

test("CASE J: reordering unrelated content does not manufacture false correspondence", () => {
  const reordered = UNRELATED_DOCUMENT.split(". ").reverse().join(". ");
  const result = computeDocumentCorrespondence(BASE_DOCUMENT, reordered);
  assert.equal(result.strongCorrespondence, false);
  assert.ok(result.containment < 0.1, "two genuinely unrelated documents must show near-zero containment regardless of word order");
});

// --- CASE K: determinism -----------------------------------------------------------

test("CASE K: the correspondence result is deterministic for identical input", () => {
  const first = computeDocumentCorrespondence(BASE_DOCUMENT, UNRELATED_DOCUMENT + " " + BASE_DOCUMENT.split(" ").slice(0, 20).join(" "));
  const second = computeDocumentCorrespondence(BASE_DOCUMENT, UNRELATED_DOCUMENT + " " + BASE_DOCUMENT.split(" ").slice(0, 20).join(" "));
  assert.deepEqual(first, second);
});

// --- Additional: sourceConcentration / thresholdsVersion / no-shingle edge case ---

test("sourceConcentration reflects how much of the EXTERNAL text's content is accounted for, distinct from containment", () => {
  // A short submission whose shingles are fully contained in a LARGER
  // external text (the same base content plus unrelated padding): since the
  // submitted side is the smaller denominator for `containment` but the
  // padded-larger external side is the denominator for `sourceConcentration`,
  // the two ratios necessarily diverge here (containment saturates at 1;
  // sourceConcentration does not, since much of the external text's own
  // shingles are never touched by the match at all).
  const shortSubmitted = BASE_DOCUMENT.split(" ").slice(0, 30).join(" ");
  const largerExternal = `${BASE_DOCUMENT} ${UNRELATED_DOCUMENT}`;
  const result = computeDocumentCorrespondence(shortSubmitted, largerExternal);
  assert.equal(result.containment, 1);
  assert.ok(result.sourceConcentration > 0 && result.sourceConcentration < 1);
  assert.notEqual(result.sourceConcentration, result.containment, "these two ratios use different denominators and should not coincidentally be computed as the same field");
});

test("thresholdsVersion is included on every result, exact match or not", () => {
  const exact = computeDocumentCorrespondence(BASE_DOCUMENT, BASE_DOCUMENT);
  const different = computeDocumentCorrespondence(BASE_DOCUMENT, UNRELATED_DOCUMENT);
  assert.equal(typeof exact.thresholdsVersion, "string");
  assert.equal(exact.thresholdsVersion, different.thresholdsVersion);
});

test("two completely empty/whitespace-only texts do not throw and are not a strong correspondence", () => {
  const result = computeDocumentCorrespondence("   ", "   ");
  assert.equal(result.strongCorrespondence, false);
});
