import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { runCorpusAdmissionPromotionSweep } from "../lib/corpus-admission-promotion.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";
import { tokens, tokenSpans, mergeAdjacentPositions } from "../lib/similarity-core.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import {
  primaryMatchedWordCount,
  unifiedMatchedPositions,
  referenceSourceMatchedPositions,
  referenceSourceContributionPercent,
} from "../lib/report-types.ts";
import { SourcesReport, SubmissionReport, findHighlightRanges } from "../components/report/similarity-report-papers.tsx";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from './helpers/test-signup.mjs';

/**
 * Task A, final correctness bug: the visible matched-word highlighting must
 * be derived from the same unique matched-position union that produced the
 * authoritative unified similarity result. Previously it was not —
 * lib/unified-similarity.ts's computeUnifiedSimilarity built the full
 * deduplicated position union (allEligiblePositions) purely to derive the
 * *OnlyWords/overlapWords counts, then discarded it; components/report/
 * similarity-report-papers.tsx's findHighlightRanges only ever read
 * report.sources (the archive) and report.webCheck (Wikipedia) — a report
 * whose entire 100%/9,925-matched-word result came from a promoted
 * TurnitPlus corpus source (zero archive overlap) highlighted nothing at
 * all in the submission body, and Source Details showed "No weighted
 * source matches" despite the 100% headline.
 *
 * See lib/unified-similarity.ts's own UnifiedSimilarityResult.matchedPositions/
 * previousUploadPositions comments and lib/report-types.ts's
 * unifiedMatchedPositions/referenceSourceMatchedPositions comments for the
 * data-model fix; components/report/similarity-report-papers.tsx's
 * findHighlightRanges own header comment for the render-layer fix.
 */

// --- REAL PROMOTED-CORPUS INTEGRATION — placed FIRST, before any other -----
// --- test() in this file, matching tests/report-source-presentation-  ------
// --- correction.test.mjs's own proven-necessary structure exactly: its ----
// --- own header comment documents a real, reproducible false negative -----
// --- when synthetic-fixture tests are registered before this section's ----
// --- own top-level DB-writing awaits finish (Node's test runner can -------
// --- interleave their execution with these pending writes). ---------------

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_unified_similarity_highlighting.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));
const openConnection = () => createClient({ url: `file:${dbFile}` });

test.after(() => {
  client.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

async function insertDecision(hash) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      id, null, `uwh-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 200, "English", 0.95, hash, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}

async function promoteDocumentIntoCorpus(text) {
  const hash = canonicalSha256(text);
  const decisionId = await insertDecision(hash);
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, 200, "v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, text, "v1", "LICENSED_REUSE"],
  });
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome?.outcome, "indexed", "test setup sanity: promotion must succeed");
  // Phase A: these INTEGRATION tests match end to end against the promoted
  // source, not the 7-day activation gate — age it so it is matchable "now".
  await matureCorpusBackings(client);
}

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, deviceKey, tag) {
  await resetAuthRateForTest(tag);
  const req = new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag },
    body: JSON.stringify(withTestIdentity({ email, password: "uwh-password-1", username: tag.replace(/[^a-z0-9]/gi, ""), deviceKey })),
  });
  const res = await signupRoute.POST(req);
  assert.equal(res.status, 201, `signup must succeed for ${email}`);
  return { cookie: extractCookie(res) };
}

async function postReport({ deviceKey, cookie, id, title, text, wordCount, room, tag }) {
  await resetRateForTest(tag);
  const req = new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag, cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({
      deviceKey, id, submissionId: "sub-" + id, title,
      createdAt: new Date().toISOString(), wordCount, archiveScore: 0, scoreBand: "Low",
      aiScore: 1, aiTone: "low", aiStatus: "ready", room,
      payload: {
        version: 11, id, submissionId: "sub-" + id, title,
        author: "", assignment: "", created: new Date().toISOString(),
        score: 0, archiveScore: 0, wordCount, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text,
      },
    }),
  });
  const res = await reportsRoute.POST(req);
  assert.equal(res.status, 200, `save must succeed for ${id}`);
  return res;
}

async function getReport(id, { cookie, tag }) {
  await resetReadRateForTest(tag);
  const req = new Request(`http://localhost/api/reports/${id}`, {
    headers: { "x-forwarded-for": tag, cookie: `tp_session_v1=${cookie}` },
  });
  const res = await reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
  const body = await res.json();
  return { res, body };
}

const CORPUS_TEXT =
  "Paleoclimatologists analyzing a newly extracted ice core identified an abrupt isotopic shift coinciding with a documented volcanic eruption, " +
  "providing a precise chronological anchor that let the team recalibrate every other dated layer in the core with substantially tighter uncertainty bounds than before.";
const CORPUS_WORD_COUNT = tokens(CORPUS_TEXT).length;

await promoteDocumentIntoCorpus(CORPUS_TEXT);
const ordinary = await signup("uwh-ordinary@example.com", "uwh-ordinary-device", "uwh-ordinary-signup");
await postReport({
  deviceKey: "uwh-ordinary-device", cookie: ordinary.cookie,
  id: "uwh-ordinary-report", title: "ordinary-corpus-match.pdf",
  text: CORPUS_TEXT, wordCount: CORPUS_WORD_COUNT, room: 0, tag: "uwh-ordinary-post",
});

test("INTEGRATION: a real promoted TurnitPlus corpus source, matched end to end through the real routes, produces unifiedScore 100 with the full document's matched-word count", async () => {
  const { res, body } = await getReport("uwh-ordinary-report", { cookie: ordinary.cookie, tag: "uwh-get-1" });
  assert.equal(res.status, 200);
  assert.ok(body.payload.unifiedSimilarity, "REQUIRED: the real promoted-corpus match must produce a persisted, returned unifiedSimilarity");
  assert.equal(body.payload.unifiedSimilarity.unifiedScore, 100, "test setup sanity: exact match against the promoted source");
  assert.equal(body.payload.unifiedSimilarity.uniqueMatchedWords, CORPUS_WORD_COUNT, "the full document's word count must be the matched-word count");
});

test("INTEGRATION (REQUIRED): unique highlighted positions equal the authoritative unified matched positions for the real 100%/full-document case", async () => {
  const { body } = await getReport("uwh-ordinary-report", { cookie: ordinary.cookie, tag: "uwh-get-2" });
  assert.equal(body.payload.historicalSubmissionMatch, undefined, "test setup sanity: this is the ordinary (non-admin) viewer's own response");

  assert.equal(unifiedMatchedPositions(body.payload).length, body.payload.unifiedSimilarity.uniqueMatchedWords, "REQUIRED: the canonical position set's size must equal the authoritative matched-word count");
  assert.equal(unifiedMatchedPositions(body.payload).length, primaryMatchedWordCount(body.payload), "REQUIRED: uniqueHighlightedWordCount (data-model level) === primaryMatchedWordCount(report)");

  const ranges = findHighlightRanges(body.payload);
  assert.equal(ranges.length, 1, "REQUIRED: an exact full-document match must render as ONE continuous highlight, not scattered fragments");
  assert.equal(ranges[0].kind, "reference-source", "REQUIRED: with zero archive/academic evidence, the entire match must render under the generic TurnitPlus reference-sources bucket");
  const spans = tokenSpans(body.payload.text);
  assert.equal(ranges[0].start, spans[0].start, "REQUIRED: the highlight must visually account for the very first matched word");
  assert.equal(ranges[0].end, spans[spans.length - 1].end, "REQUIRED: the highlight must visually account for the very last matched word — the full document, matching the full matched-word count");

  assert.equal(uniqueHighlightedWordCount(body.payload), unifiedMatchedPositions(body.payload).length, "REQUIRED: rendered highlight coverage must equal the authoritative matched-position count exactly");
});

test("INTEGRATION (PRIVACY, REQUIRED): ordinary-user Source Details never name 'TurnitPlus reference sources' (an internal-system label), never a fake publication, never internal identity — but never falsely claim no matches exist either", async () => {
  const { body } = await getReport("uwh-ordinary-report", { cookie: ordinary.cookie, tag: "uwh-get-3" });
  const html = renderToStaticMarkup(React.createElement(SourcesReport, { report: body.payload }));

  // Task A, final report simplification (supersedes this test's earlier
  // expectation): "TurnitPlus reference sources" is itself now a forbidden
  // internal-system label for an ordinary viewer (see SourceList's
  // canSeeSourceBreakdown gate) — but Source Details must still be honest
  // that real matches exist (never "No weighted source matches") when the
  // entire result came from this internal-only channel; it just points the
  // ordinary viewer at the highlighted submission text instead of naming
  // the channel.
  assert.doesNotMatch(html, /TurnitPlus reference sources/, "REQUIRED: an ordinary viewer must never see this internal-system label");
  assert.doesNotMatch(html, /No weighted source matches/, "REQUIRED: Source Details must not claim no matches exist when the corpus contribution is the entire result");
  assert.match(html, /Matched passages found/, "REQUIRED: an honest, generic notice must still appear, pointing to the highlighted body");

  // Never the report's OWN id/submissionId — its own owner is entitled to
  // see those (they appear in the page header/footer by design). The
  // concern here is specifically internal CORPUS-SOURCE identity: the raw
  // relationship classification, the promoted representation's own id, the
  // admission decision id, or any account identity.
  const forbidden = [
    "TURNITPLUS_CORPUS_SOURCE", "PRIOR_SUBMISSION", "SELF", "UNKNOWN_RELATIONSHIP",
    "representation", "decision_id", "@example.com", "uwh-ordinary-device",
  ];
  for (const term of forbidden) {
    assert.doesNotMatch(html, new RegExp(term, "i"), `REQUIRED: Source Details must never leak "${term}" to an ordinary viewer`);
  }
});

test("INTEGRATION (PRIVACY, REQUIRED): the highlighted submission body renders no internal corpus identity, and no channel label, either", async () => {
  const { body } = await getReport("uwh-ordinary-report", { cookie: ordinary.cookie, tag: "uwh-get-4" });
  const html = renderToStaticMarkup(React.createElement(SubmissionReport, { report: body.payload }));
  // Task A, final report simplification (supersedes this test's earlier
  // expectation): the highlight's own title attribute is now fully generic
  // ("Matched passage") — it never names "TurnitPlus reference sources" or
  // any other internal-system label, matching the "no color/label
  // difference based on how or where TurnitPlus found the match" requirement.
  assert.doesNotMatch(html, /TurnitPlus reference sources/, "REQUIRED: the highlight's own title attribute must never leak this internal-system label");
  assert.match(html, /Matched passage/, "the highlight's own title attribute must still render, generically");
  const forbidden = ["TURNITPLUS_CORPUS_SOURCE", "PRIOR_SUBMISSION", "representation", "decision_id", "@example.com"];
  for (const term of forbidden) {
    assert.doesNotMatch(html, new RegExp(term, "i"), `REQUIRED: the highlighted body must never leak "${term}"`);
  }
});

test("INTEGRATION: referenceSourceContributionPercent(report) on the real persisted report equals 100%, matching the real unifiedScore exactly", async () => {
  const { body } = await getReport("uwh-ordinary-report", { cookie: ordinary.cookie, tag: "uwh-get-5" });
  assert.equal(referenceSourceContributionPercent(body.payload), 100);
  assert.equal(referenceSourceContributionPercent(body.payload), body.payload.unifiedSimilarity.unifiedScore);
});

// --- Everything below uses synthetic fixtures only (no DB, no HTTP) --------

/** Sums, without double-counting, how many of tokenSpans(report.text)'s own word indices fall entirely within ANY accepted highlight range — the render-layer counterpart to unifiedMatchedPositions(report).length. */
function uniqueHighlightedWordCount(report) {
  const spans = tokenSpans(report.text);
  const ranges = findHighlightRanges(report);
  const covered = new Set();
  spans.forEach((span, wordIndex) => {
    if (ranges.some((range) => span.start >= range.start && span.end <= range.end)) covered.add(wordIndex);
  });
  return covered.size;
}

// --- Part 1: tokenSpans/tokens equivalence — the foundation the whole ------
// --- word-index -> character-offset conversion depends on -----------------

const TOKEN_SPAN_FIXTURES = [
  "Simple ASCII text with punctuation, commas, and a period.",
  "Contractions like don't, TurnitPlus's, and won't must tokenize the same way tokens() already does.",
  "Numbers 123 and mixed4lpha7numeric tokens, plus a lone 42.",
  "Multiple   spaces\tand\nnewlines   between     words.",
  "Café résumé naïve — NFKD-decomposable accented words stay one token each.",
  "في هذا النص بعض الكلمات العربية للتأكد من التوافق مع المحلل.",
  "Un texte en français avec des mots comme déjà, où, et être.",
  "A hyphenated-word and an em—dash-separated pair, plus (parenthetical) content.",
  "References\n[1] Smith, J. (2020). A paper. Journal of Testing, 12(3), 45-67.",
];

test("FOUNDATION: tokenSpans(text) produces the exact same word sequence as tokens(text), for every fixture this test suite's own realistic texts resemble", () => {
  for (const fixture of TOKEN_SPAN_FIXTURES) {
    const expected = tokens(fixture);
    const spans = tokenSpans(fixture);
    assert.deepEqual(spans.map((s) => s.word.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")), expected, `word sequence must match for: ${JSON.stringify(fixture)}`);
  }
});

test("FOUNDATION: tokenSpans' character offsets actually locate each word inside the original text", () => {
  for (const fixture of TOKEN_SPAN_FIXTURES) {
    const spans = tokenSpans(fixture);
    for (const span of spans) {
      const slice = fixture.slice(span.start, span.end);
      assert.equal(slice, span.word, `span [${span.start},${span.end}) must slice back to exactly "${span.word}" in ${JSON.stringify(fixture)}`);
    }
  }
});

test("FOUNDATION: mergeAdjacentPositions merges contiguous/touching indices and leaves gaps as separate ranges", () => {
  assert.deepEqual(mergeAdjacentPositions([0, 1, 2, 5, 6, 9]), [[0, 2], [5, 6], [9, 9]]);
  assert.deepEqual(mergeAdjacentPositions([]), []);
  assert.deepEqual(mergeAdjacentPositions([7]), [[7, 7]]);
  assert.deepEqual(mergeAdjacentPositions([3, 1, 2]), [[1, 3]], "order-independent — sorts internally");
});

// --- Part 2: the strong data-model invariant, via the REAL resolver -------

const INVARIANT_TEXT_WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango"];
const INVARIANT_TEXT = INVARIANT_TEXT_WORDS.join(" ");
const INVARIANT_WORD_COUNT = INVARIANT_TEXT_WORDS.length;

function corpusMatch({ start, end, relationshipType = "TURNITPLUS_CORPUS_SOURCE" }) {
  const words = INVARIANT_TEXT_WORDS.slice(start, end + 1);
  return {
    status: "MATCHED",
    computedAt: new Date().toISOString(),
    matcherVersion: "v1", fingerprintVersion: "v1", canonicalizationVersion: "v1",
    matches: [{
      relationshipType,
      matchedRepresentationId: "unified-highlighting-fixture-representation",
      matchType: "STRONG_TEXT_MATCH",
      containment: (end - start + 1) / INVARIANT_WORD_COUNT,
      matchedWordCount: end - start + 1,
      passageCount: 1,
      longestMatchWords: end - start + 1,
      passages: [{ submittedText: words.join(" "), submittedWordStart: start, submittedWordEnd: end, matchedWordCount: end - start + 1 }],
      historicalSubmissionCount: 1,
    }],
  };
}

test("INVARIANT: unifiedMatchedPositions(report).length === primaryMatchedWordCount(report) for archive-only, corpus-only, and mixed-overlap results — computed via the real resolver, not hand-typed", () => {
  const archiveOnly = computeUnifiedSimilarity({ wordCount: INVARIANT_WORD_COUNT, archiveMatchedPositions: [0, 1, 2, 3, 4] });
  const corpusOnly = computeUnifiedSimilarity({ wordCount: INVARIANT_WORD_COUNT, historicalSubmissionMatch: corpusMatch({ start: 0, end: INVARIANT_WORD_COUNT - 1 }) });
  const mixedOverlap = computeUnifiedSimilarity({
    wordCount: INVARIANT_WORD_COUNT,
    archiveMatchedPositions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    historicalSubmissionMatch: corpusMatch({ start: 5, end: 14 }),
  });

  for (const [label, unified] of [["archive-only", archiveOnly], ["corpus-only", corpusOnly], ["mixed-overlap", mixedOverlap]]) {
    const report = { unifiedSimilarity: unified };
    assert.equal(unifiedMatchedPositions(report).length, primaryMatchedWordCount(report), `${label}: matchedPositions length must equal primaryMatchedWordCount`);
    assert.equal(unifiedMatchedPositions(report).length, unified.uniqueMatchedWords, `${label}: matchedPositions length must equal uniqueMatchedWords exactly (the same union, not independently derived)`);
  }

  assert.equal(mixedOverlap.overlapWords, 5, "test setup sanity: positions 5-9 are matched by both archive and corpus");
  assert.equal(mixedOverlap.archiveOnlyWords, 5, "positions 0-4");
  assert.equal(mixedOverlap.previousUploadOnlyWords, 5, "positions 10-14");
  assert.equal(referenceSourceMatchedPositions({ unifiedSimilarity: mixedOverlap }).length, 5, "the generic reference-source position set must be the EXCLUSIVE (non-overlapping) subset, matching previousUploadOnlyWords exactly");
});

test("INVARIANT: a report with no unifiedSimilarity at all returns an empty canonical position set, never a crash or a guess", () => {
  const report = {};
  assert.deepEqual(unifiedMatchedPositions(report), []);
  assert.deepEqual(referenceSourceMatchedPositions(report), []);
});

// --- Part 3: render-layer proof — highlighted word count must match too ---

function baseReport(overrides = {}) {
  return {
    version: 11, id: 1, submissionId: "sub-uwh-1", title: "unified-highlighting-fixture.pdf",
    author: "", assignment: "", created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount: INVARIANT_WORD_COUNT, characterCount: INVARIANT_TEXT.length,
    pageCount: 1, fileSize: "10 KB", databaseSize: 230, corpusVersion: "archive-v1-230-test",
    scoreBand: "Low", riskStatus: "Lower", riskTarget: 0.5, riskCutoff: 0.5,
    riskCalibration: { auc: 0.9, precision: 0.9, recall: 0.9, sampleSize: 100 },
    features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: "English" },
    excludedDocuments: 0, matchedWordCount: 0, sources: [], repeats: [], text: INVARIANT_TEXT,
    ...overrides,
  };
}

test("RENDER INVARIANT: mixed archive + corpus overlap — the rendered highlight ranges never overlap in character space, and the unique highlighted word count equals the authoritative matched-word count exactly (no double-highlight, no gap)", () => {
  const unified = computeUnifiedSimilarity({
    wordCount: INVARIANT_WORD_COUNT,
    archiveMatchedPositions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    historicalSubmissionMatch: corpusMatch({ start: 5, end: 14 }),
  });
  const report = baseReport({
    unifiedSimilarity: unified,
    sources: [{
      name: "Archive Source", type: "Publication", percent: 50, matches: 1,
      phrases: [INVARIANT_TEXT_WORDS.slice(0, 10).join(" ")], color: "#d7263d",
    }],
  });

  const ranges = findHighlightRanges(report);
  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      const overlaps = ranges[i].start < ranges[j].end && ranges[i].end > ranges[j].start;
      assert.equal(overlaps, false, `REQUIRED: highlight ranges must never overlap — found overlap between ${JSON.stringify(ranges[i])} and ${JSON.stringify(ranges[j])}`);
    }
  }

  assert.equal(uniqueHighlightedWordCount(report), unifiedMatchedPositions(report).length, "REQUIRED: uniqueHighlightedWordCount === the authoritative matched-position count");
  assert.equal(uniqueHighlightedWordCount(report), primaryMatchedWordCount(report), "REQUIRED: uniqueHighlightedWordCount === primaryMatchedWordCount(report)");

  assert.ok(ranges.some((r) => r.kind === "source"), "the archive portion (positions 0-9, including the overlap) must still be highlighted as a named archive source");
  assert.ok(ranges.some((r) => r.kind === "reference-source"), "the exclusive corpus-only portion (positions 10-14) must be highlighted as the generic TurnitPlus reference-sources bucket");
  assert.equal(ranges.filter((r) => r.kind === "reference-source").length, 1, "the overlapping positions 5-9 must not ALSO produce a separate reference-source range — highlighted once, under archive");
});

test("RENDER INVARIANT: a partial (50%-style) corpus match highlights only the exact matched word positions, never the whole document", () => {
  const unified = computeUnifiedSimilarity({
    wordCount: INVARIANT_WORD_COUNT,
    historicalSubmissionMatch: corpusMatch({ start: 0, end: 9 }), // exactly half
  });
  assert.equal(unified.unifiedScore, 50, "test setup sanity: exactly half the document matched");
  const report = baseReport({ unifiedSimilarity: unified });

  const ranges = findHighlightRanges(report);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].kind, "reference-source");
  const spans = tokenSpans(report.text);
  assert.equal(ranges[0].start, spans[0].start, "the highlight must start exactly at the first matched word");
  assert.equal(ranges[0].end, spans[9].end, "the highlight must end exactly at the last matched word — not extend into the unmatched second half");
  assert.ok(ranges[0].end < report.text.length, "REQUIRED: a 50% match must not highlight the entire text");

  assert.equal(uniqueHighlightedWordCount(report), 10);
  assert.equal(uniqueHighlightedWordCount(report), primaryMatchedWordCount(report));
});

test("RENDER: archive-only/external-only behavior is unchanged — with no historicalSubmissionMatch and no externalAcademicEvidence, findHighlightRanges produces ONLY archive-kind ranges, exactly as before this fix", () => {
  const archiveOnlyUnified = computeUnifiedSimilarity({ wordCount: INVARIANT_WORD_COUNT, archiveMatchedPositions: [0, 1, 2, 3, 4] });
  const report = baseReport({
    unifiedSimilarity: archiveOnlyUnified,
    sources: [{
      name: "Archive Source", type: "Publication", percent: 25, matches: 1,
      phrases: [INVARIANT_TEXT_WORDS.slice(0, 5).join(" ")], color: "#d7263d",
    }],
  });
  const ranges = findHighlightRanges(report);
  assert.ok(ranges.length > 0, "test setup sanity: the archive phrase must actually match");
  assert.ok(ranges.every((r) => r.kind === "source"), "REQUIRED: with no corpus/academic evidence present, no 'academic' or 'reference-source' range may appear — the new code paths must be true no-ops");
});

test("RENDER: a report with no unifiedSimilarity at all (predates Phase 4A) still renders — archive/Wikipedia highlighting only, no crash from the new reference-source lookup", () => {
  const report = baseReport({ unifiedSimilarity: undefined });
  const ranges = findHighlightRanges(report);
  assert.deepEqual(ranges, []);
});

// --- Part 4: Phase B1 — the shadow hypothetical exclusion never alters the ---
// --- authoritative matched-position union that drives highlighting ----------

test("PHASE B1: computeUnifiedSimilarity's matchedPositions / previousUploadPositions are byte-identical with hypotheticalExcludedRepresentationIds absent vs [] vs undefined", () => {
  const params = {
    wordCount: INVARIANT_WORD_COUNT,
    archiveMatchedPositions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    historicalSubmissionMatch: corpusMatch({ start: 5, end: 14 }),
  };
  const base = computeUnifiedSimilarity(params);
  for (const variant of [undefined, null, [], new Set()]) {
    const withParam = computeUnifiedSimilarity({ ...params, hypotheticalExcludedRepresentationIds: variant });
    assert.deepEqual(withParam.matchedPositions, base.matchedPositions);
    assert.deepEqual(withParam.previousUploadPositions, base.previousUploadPositions);
    assert.deepEqual(withParam, base, "the whole authoritative result is unchanged, not just the position arrays");
  }
});

test("PHASE B1: passing the hypothetical set only shrinks the position union — it never adds a position the authoritative result did not have", () => {
  const params = {
    wordCount: INVARIANT_WORD_COUNT,
    archiveMatchedPositions: [0, 1, 2, 3, 4],
    historicalSubmissionMatch: corpusMatch({ start: 0, end: INVARIANT_WORD_COUNT - 1 }),
  };
  const authoritative = computeUnifiedSimilarity(params);
  const hypothetical = computeUnifiedSimilarity({
    ...params,
    hypotheticalExcludedRepresentationIds: ["unified-highlighting-fixture-representation"],
  });
  const authoritativeSet = new Set(authoritative.matchedPositions);
  for (const position of hypothetical.matchedPositions) {
    assert.ok(authoritativeSet.has(position), `hypothetical position ${position} must be a subset of the authoritative union`);
  }
  assert.ok(hypothetical.matchedPositions.length < authoritative.matchedPositions.length, "excluding the corpus source must remove positions");
  // the 5 archive-covered positions still survive
  assert.deepEqual(hypothetical.matchedPositions, [0, 1, 2, 3, 4]);
});
