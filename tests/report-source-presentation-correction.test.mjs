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
import { tokens } from "../lib/similarity-core.ts";
import { CategorySummary, OverviewReport } from "../components/report/similarity-report-papers.tsx";
import { primarySimilarityScore, referenceSourceContributionPercent, unifiedEvidenceSummary } from "../lib/report-types.ts";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";

/**
 * Report-source presentation correction: a corpus/internal-only 100% match
 * (previousUploadOnlyWords === uniqueMatchedWords) previously showed
 * "TurnitPlus Similarity 100%" alongside "0% Indexed publications" and
 * match-group summaries that never accounted for the 100% — CategorySummary/
 * MatchGroups derive purely from report.sources (archive-only), with zero
 * awareness of report.unifiedSimilarity. Separately, several surfaces
 * (report-detail-shell.tsx's Report Notes paragraph, the receipt PDF, the
 * pending-state message) leaked "previous TurnitPlus submission"/"retained
 * source" wording to ordinary users unconditionally, not just to admins.
 * Fixed presentation-only: the
 * underlying data (lib/unified-similarity.ts's previousUploadOnlyWords) and
 * scoring/matching/corpus admission/consent/atomic-reveal are all untouched.
 * The pre-existing admin-only breakdown in UnifiedSimilaritySection (UI-02,
 * covered by tests/report-historical-match-visibility.test.mjs) is
 * deliberately left unchanged — this file must never weaken that gate.
 */

// --- REAL PROMOTED-CORPUS INTEGRATION: not a synthetic unified() fixture ---
// Deliberately placed FIRST, before any other test() in this file, and its
// entire setup (promotion/signup/save) runs as plain top-level awaits with
// NO test() registered yet — matching tests/report-historical-match-
// visibility.test.mjs's own proven-reliable structure exactly. Registering
// synthetic-fixture tests before this section's own top-level awaits finish
// lets Node's test runner interleave their execution with this section's
// pending DB writes; on this environment's local libsql/WAL file driver
// that interleaving was measured to produce a real, reproducible false
// negative (the promotion sweep's own writes were fully committed and
// independently re-queryable afterward, but the route's own read during
// that interleaved window still returned NO_HISTORICAL_MATCH). Keeping every
// DB-touching top-level await first, before any other test() call in the
// file, removes that hazard entirely.
//
// Traces a real TURNITPLUS_CORPUS_SOURCE match end to end:
//   1. promoteDocumentIntoCorpus: a real corpus_admission_decisions row
//      (decision=ACCEPT) + corpus_admission_accepted_representations +
//      corpus_admission_content_store rows, then a real
//      runCorpusAdmissionPromotionSweep — the actual "promoted representation
//      matching" write path (lib/corpus-admission-promotion.ts), not a
//      hand-inserted "already indexed" fixture.
//   2. A real POST /api/reports of text IDENTICAL to the promoted source
//      triggers, at GET time, app/api/reports/[id]/route.ts's
//      resolvePrimarySimilaritySummary -> lib/report-historical-match.ts's
//      getOrComputeHistoricalMatchSnapshot -> lib/user-submission-matching.ts's
//      matchAgainstUserSubmissionCorpus, which classifies a representation
//      with zero real submission-reference ownership but active corpus-
//      admission promotion as relationshipType: "TURNITPLUS_CORPUS_SOURCE"
//      (lib/user-submission-matching.ts's own RelationshipType union and its
//      "TURNITPLUS_CORPUS_SOURCE" comment) — this is the historical/corpus
//      match snapshot the user asked this trace to go through.
//   3. That snapshot becomes computeUnifiedSimilarity's own
//      historicalSubmissionMatch input (lib/report-primary-similarity.ts's
//      resolvePrimarySimilaritySummary, called from the GET route). Inside
//      lib/unified-similarity.ts, TURNITPLUS_CORPUS_SOURCE is neither "SELF"
//      nor "UNKNOWN_RELATIONSHIP", so its status is "included" — its matched
//      positions flow into priorSet exactly like a real PRIOR_SUBMISSION
//      match would, and end up counted in previousUploadOnlyWords.
//   4. The route persists resolution.unifiedSimilarity onto payload_json
//      AND returns it in the response body for EVERY viewer (only
//      historicalSubmissionMatch itself and unifiedSimilarity.contributions
//      are admin-gated — see that route's own comment) — this is the
//      "persisted unifiedSimilarity" step, and it is what an ordinary
//      viewer's own report-types.ts/CategorySummary render from in
//      production.
//
// CORPUS_TEXT below is submitted as an EXACT_CANONICAL_MATCH (the matcher's
// own cheap short-circuit — lib/unified-similarity.ts's own comment on
// previousUploadPassageRanges) specifically so archiveOnlyWords and
// liveAcademicOnlyWords are both genuinely 0 and the report's only evidence
// is the promoted corpus source, matching the exact "internal-only 100%"
// scenario this whole correction targets.

const repoRoot = path.resolve(".");
const uispcDbFile = path.join(repoRoot, "test_report_source_presentation_correction.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${uispcDbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${uispcDbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";

const uispcClient = createClient({ url: `file:${uispcDbFile}` });
await uispcClient.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(uispcClient, path.join(repoRoot, "drizzle"));
const uispcOpenConnection = () => createClient({ url: `file:${uispcDbFile}` });

test.after(() => {
  uispcClient.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${uispcDbFile}${suffix}`); } catch { /* ignore */ }
  }
});

async function uispcInsertDecision(hash) {
  const id = randomUUID();
  await uispcClient.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      id, null, `uispc-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 200, "English", 0.95, hash, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}

/** Real promotion write path — mirrors tests/report-historical-match-visibility.test.mjs's own promoteDocumentIntoCorpus exactly. */
async function uispcPromoteDocumentIntoCorpus(text) {
  const hash = canonicalSha256(text);
  const decisionId = await uispcInsertDecision(hash);
  await uispcClient.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, 200, "v1"],
  });
  await uispcClient.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, text, "v1", "LICENSED_REUSE"],
  });
  await matureCorpusBackings(uispcClient); // Phase A: age the promoted backing so it is matchable "now"
  const sweep = await runCorpusAdmissionPromotionSweep(uispcClient, { openConnection: uispcOpenConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome?.outcome, "indexed", "test setup sanity: promotion must succeed");
}

function uispcExtractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function uispcSignup(email, deviceKey, tag) {
  await resetAuthRateForTest(tag);
  const req = new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag },
    body: JSON.stringify({ email, password: "uispc-password-1", username: tag.replace(/[^a-z0-9]/gi, ""), deviceKey }),
  });
  const res = await signupRoute.POST(req);
  assert.equal(res.status, 201, `signup must succeed for ${email}`);
  return { cookie: uispcExtractCookie(res) };
}

async function uispcPostReport({ deviceKey, cookie, id, title, text, wordCount, room, tag }) {
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

async function uispcGetReport(id, { cookie, tag }) {
  await resetReadRateForTest(tag);
  const req = new Request(`http://localhost/api/reports/${id}`, {
    headers: { "x-forwarded-for": tag, cookie: `tp_session_v1=${cookie}` },
  });
  const res = await reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
  const body = await res.json();
  return { res, body };
}

const UISPC_CORPUS_TEXT =
  "Deep-sea hydrothermal vent microbial communities exhibit chemosynthetic metabolic pathways that diverge sharply from photosynthesis-driven surface ecosystems, " +
  "with sulfur-oxidizing bacterial symbionts supplying host tubeworms a complete nutritional substitute through a vascular trophosome rather than any digestive tract at all.";
// Computed via the real tokenizer (lib/similarity-core.ts's own tokens()) —
// never eyeballed/hand-counted — since computeUnifiedSimilarity's own
// clampedPositions clamps a match's end position to wordCount-1; a
// hand-counted wordCount that undershoots the tokenizer's real count would
// silently truncate/reject the real match's own position range and mask
// exactly the wiring this integration test exists to prove.
const UISPC_CORPUS_WORD_COUNT = tokens(UISPC_CORPUS_TEXT).length;

await uispcPromoteDocumentIntoCorpus(UISPC_CORPUS_TEXT);

const uispcOrdinary = await uispcSignup("uispc-ordinary@example.com", "uispc-ordinary-device", "uispc-ordinary-signup");
await uispcPostReport({
  deviceKey: "uispc-ordinary-device", cookie: uispcOrdinary.cookie,
  id: "uispc-ordinary-report", title: "ordinary-corpus-match.pdf",
  text: UISPC_CORPUS_TEXT, wordCount: UISPC_CORPUS_WORD_COUNT, room: 0, tag: "uispc-ordinary-post",
});

test("INTEGRATION: a real promoted TurnitPlus corpus source, matched end to end through the real routes, produces unifiedScore 100 with previousUploadOnlyWords accounting for the full matched-word count", async () => {
  const { res, body } = await uispcGetReport("uispc-ordinary-report", { cookie: uispcOrdinary.cookie, tag: "uispc-get-ordinary" });
  assert.equal(res.status, 200);
  assert.ok(body.payload.unifiedSimilarity, "REQUIRED: the real promoted-corpus match must produce a persisted, returned unifiedSimilarity — not just a synthetic fixture");
  const unifiedResult = body.payload.unifiedSimilarity;
  assert.equal(unifiedResult.unifiedScore, 100, "test setup sanity: the promoted corpus source is an exact match, so the real combined result must be 100%");
  assert.equal(unifiedResult.archiveOnlyWords, 0, "this report's ONLY similarity evidence is the promoted corpus source — no archive contribution");
  assert.equal(unifiedResult.liveAcademicOnlyWords, 0, "no live-academic evidence was ever attached to this report");
  assert.ok(unifiedResult.previousUploadOnlyWords > 0, "REQUIRED: the real TURNITPLUS_CORPUS_SOURCE match must have actually reached previousUploadOnlyWords, not been dropped somewhere in the trace");
  assert.equal(unifiedResult.previousUploadOnlyWords, unifiedResult.uniqueMatchedWords, "with zero archive/academic/overlap contribution, the full matched-word count must be attributed to the promoted corpus source specifically");
});

test("INTEGRATION: referenceSourceContributionPercent(report) on the REAL persisted report equals 100%, matching the real unifiedScore exactly", async () => {
  const { body } = await uispcGetReport("uispc-ordinary-report", { cookie: uispcOrdinary.cookie, tag: "uispc-get-percent" });
  const percent = referenceSourceContributionPercent(body.payload);
  assert.equal(percent, 100);
  assert.equal(percent, body.payload.unifiedSimilarity.unifiedScore, "the two must agree exactly for a report whose only evidence is the promoted corpus source");
});

test("INTEGRATION: CategorySummary itself (rendered in isolation from the REAL persisted report) still computes the 100% TurnitPlus reference-source row correctly — the component's own logic, independent of whether any call site chooses to render it", async () => {
  const { body } = await uispcGetReport("uispc-ordinary-report", { cookie: uispcOrdinary.cookie, tag: "uispc-get-render" });
  assert.equal(body.payload.historicalSubmissionMatch, undefined, "test setup sanity: this is the ordinary (non-admin) viewer's own response — the admin-only field must be absent");
  // Task A, final report simplification: an ordinary viewer's OverviewReport/
  // report-detail-shell.tsx sidebar no longer CALLS CategorySummary at all
  // (see the PRIVACY test below) — this test only proves the component's own
  // percentage math is still correct when something does render it (admin
  // call sites).
  const html = renderToStaticMarkup(React.createElement(CategorySummary, { report: body.payload }));
  assert.match(html, /<strong>100%<\/strong>[\s\S]*?TurnitPlus reference sources/);
  assert.match(html, /<strong>0%<\/strong>[\s\S]*?Indexed publications/, "no archive source exists here, so Indexed publications must honestly stay 0% alongside the real 100% reference-source figure");
});

// --- Everything below uses synthetic fixtures only (no DB, no HTTP) ---------

const repo = path.resolve(".");

function baseReport(overrides = {}) {
  return {
    version: 11,
    id: 1,
    submissionId: "sub-uispc-1",
    title: "uispc-fixture.pdf",
    author: "",
    assignment: "",
    created: new Date().toISOString(),
    score: 0,
    archiveScore: 0,
    wordCount: 9925,
    characterCount: 60000,
    pageCount: 20,
    fileSize: "80 KB",
    databaseSize: 230,
    corpusVersion: "archive-v1-230-test",
    scoreBand: "Low",
    riskStatus: "Lower",
    riskTarget: 0.5,
    riskCutoff: 0.5,
    riskCalibration: { auc: 0.9, precision: 0.9, recall: 0.9, sampleSize: 100 },
    features: {
      maxSourceContainment: 0,
      longestMatchedSpan: 0,
      quotationDensity: 0,
      referenceListRatio: 0,
      highFrequencyShingleCount: 0,
      repeatedThreeGramCount: 0,
      detectedLanguage: "English",
    },
    excludedDocuments: 0,
    matchedWordCount: 0,
    sources: [],
    repeats: [],
    text: "fixture text not used by these components directly",
    ...overrides,
  };
}

function unified(overrides = {}) {
  return {
    version: "unified-similarity-v1",
    wordCount: 9925,
    unifiedScore: 100,
    uniqueMatchedWords: 9925,
    archiveOnlyWords: 0,
    liveAcademicOnlyWords: 0,
    previousUploadOnlyWords: 9925,
    overlapWords: 0,
    selfExcludedWords: 0,
    unknownExcludedWords: 0,
    contributions: [],
    ...overrides,
  };
}

const INTERNAL_ONLY_100 = baseReport({ unifiedSimilarity: unified() });

function renderCategories(report) {
  return renderToStaticMarkup(React.createElement(CategorySummary, { report }));
}
function renderOverview(report) {
  return renderToStaticMarkup(React.createElement(OverviewReport, { report }));
}

// --- REQUIREMENT 1: internal-only 100% match shows 100% TurnitPlus reference-source contribution ---

test("CategorySummary: an internal-only 100% match shows a 100% 'TurnitPlus reference sources' row, not 0% across every category", () => {
  const html = renderCategories(INTERNAL_ONLY_100);
  assert.match(html, /<strong>100%<\/strong>[\s\S]*?TurnitPlus reference sources/, "the internal contribution must visibly account for the 100%, not disappear");
});

test("CategorySummary: Indexed publications stays a genuine 0% for an internal-only match — never silently relabeled", () => {
  const html = renderCategories(INTERNAL_ONLY_100);
  assert.match(html, /<strong>0%<\/strong>[\s\S]*?Indexed publications/, "archive-derived Indexed publications must still report its own true (zero) figure");
});

// --- REQUIREMENT 2: unified score remains unchanged ---

test("SCORE ISOLATION: adding the reference-source category never touches unifiedScore/primarySimilarityScore", () => {
  renderCategories(INTERNAL_ONLY_100);
  assert.equal(primarySimilarityScore(INTERNAL_ONLY_100), 100);
  assert.equal(INTERNAL_ONLY_100.unifiedSimilarity.unifiedScore, 100, "rendering CategorySummary must never mutate the underlying report");
});

// --- REQUIREMENT 3: archive/external breakdowns stay accurate, never relabeled as TurnitPlus reference sources ---

test("CategorySummary: an archive-only match reports its true archive percent and a 0% reference-source row — the two are never conflated", () => {
  const report = baseReport({
    sources: [{ name: "Some Journal", type: "Publication", percent: 40, matches: 1, phrases: [] }],
    unifiedSimilarity: unified({ unifiedScore: 40, uniqueMatchedWords: 400, wordCount: 1000, archiveOnlyWords: 400, previousUploadOnlyWords: 0 }),
  });
  const html = renderCategories(report);
  assert.match(html, /<strong>40%<\/strong>[\s\S]*?Indexed publications/, "the real archive-derived figure must still render under its own correct label");
  assert.match(html, /<strong>0%<\/strong>[\s\S]*?TurnitPlus reference sources/, "no internal contribution exists here — the new category must honestly report 0%, not borrow the archive figure");
  assert.equal(referenceSourceContributionPercent(report), 0);
});

test("CategorySummary: a legacy report with no unifiedSimilarity renders no 'TurnitPlus reference sources' row at all", () => {
  const html = renderCategories(baseReport({ sources: [{ name: "Some Journal", type: "Publication", percent: 12, matches: 1, phrases: [] }] }));
  assert.doesNotMatch(html, /TurnitPlus reference sources/, "there is no unified bucket to show for an archive-only/legacy report — nothing should be invented");
});

// --- REQUIREMENT 4: ordinary-user output contains none of the internal terms ---

const FORBIDDEN_ORDINARY_TERMS = /\bcorpus\b|\bprior submission|\bprevious submission|previously submitted|retained source|retained content|\brepresentation\b|\badmission\b|\bpromotion\b/i;

test("PRIVACY: an ordinary viewer's full OverviewReport render (no historicalSubmissionMatch) for an internal-only 100% match contains none of the forbidden internal terms", () => {
  const html = renderOverview(INTERNAL_ONLY_100);
  assert.doesNotMatch(html, FORBIDDEN_ORDINARY_TERMS);
  // Task A, final report simplification (supersedes this test's earlier
  // expectation): "TurnitPlus reference sources" is itself now an
  // internal-system label hidden from ordinary viewers — the per-source-type
  // CategorySummary block is admin-only (see report-detail-shell.tsx and
  // OverviewReport's own canSeeSourceBreakdown gate on that section). The
  // ordinary viewer still gets the one authoritative score below.
  assert.doesNotMatch(html, /TurnitPlus reference sources/, "REQUIRED: an ordinary viewer must never see this internal-system label");
  assert.doesNotMatch(html, /Indexed publications/, "REQUIRED: the source-type percentage breakdown must not render for an ordinary viewer");
  assert.match(html, /<span>100%<\/span> TurnitPlus Similarity/);
});

test("PRIVACY: no email/account/filename/report identifier appears in an ordinary viewer's render", () => {
  const html = renderOverview(INTERNAL_ONLY_100);
  assert.doesNotMatch(html, /@/, "no email-shaped string");
  assert.doesNotMatch(html, /accountId|account_id/i);
});

// --- REQUIREMENT 6: admin-only classification remains unaffected (regression guard) ---

test("REGRESSION: an admin-visible internal-only match still shows the unchanged, richer admin wording in UnifiedSimilaritySection — this fix must never touch that gate", () => {
  const html = renderOverview(baseReport({
    // Task A correction: viewerIsAdmin is the explicit authorization
    // signal now — historicalSubmissionMatch's own presence below is real
    // match data, not itself an authorization check.
    viewerIsAdmin: true,
    unifiedSimilarity: unified(),
    historicalSubmissionMatch: {
      status: "MATCHED",
      computedAt: new Date().toISOString(),
      matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v",
      matches: [{
        relationshipType: "TURNITPLUS_CORPUS_SOURCE",
        matchedRepresentationId: "rep-uispc-admin-only",
        matchType: "EXACT_CANONICAL_MATCH",
        containment: 1, matchedWordCount: 9925, passageCount: 1, longestMatchWords: 9925,
        passages: [{ submittedText: "an excerpt", submittedWordStart: 0, submittedWordEnd: 3, matchedWordCount: 3 }],
        historicalSubmissionCount: 0,
      }],
    },
  }));
  assert.match(html, /9,925 words? from an eligible previous TurnitPlus submission/, "the admin-only breakdown wording must be completely unaffected by this presentation fix");
  assert.match(html, /matches a TurnitPlus corpus reference source/, "the admin-only historical-match entry wording must be completely unaffected");
  // Task A, final report simplification (+ authorization correction):
  // CategorySummary's own call site is gated on viewerIsAdmin — this
  // fixture sets it true, so the category still renders here.
  assert.match(html, /TurnitPlus reference sources/);
});

// --- REQUIREMENT 5: receipt follows the same terminology ---

test("RECEIPT: unifiedEvidenceSummary describes an internal-only contribution as 'TurnitPlus reference sources', never 'a prior submission'", () => {
  const summary = unifiedEvidenceSummary(unified());
  assert.equal(summary, "TurnitPlus reference sources");
  assert.doesNotMatch(summary, FORBIDDEN_ORDINARY_TERMS);
});

test("RECEIPT (structural): lib/receipt-pdf.ts's disclaimer line no longer names 'eligible prior submissions'", () => {
  const source = fs.readFileSync(path.join(repo, "lib/receipt-pdf.ts"), "utf8");
  assert.doesNotMatch(source, /eligible prior submissions/);
  assert.match(source, /TurnitPlus reference sources/);
});

// --- app/reports/[id]/report-detail-shell.tsx: structural coverage, matching the ---
// established convention (tests/similarity-result-consistency.test.mjs) for this
// stateful "use client" component, which cannot be safely rendered via renderToStaticMarkup.

test("REPORT NOTES (structural): report-detail-shell.tsx's sidebar paragraph no longer unconditionally names 'eligible previous TurnitPlus submissions', 'TurnitPlus reference sources', or 'retained source'", () => {
  const shell = fs.readFileSync(path.join(repo, "app/reports/[id]/report-detail-shell.tsx"), "utf8");
  assert.doesNotMatch(shell, /retained source/, "the forbidden term must be gone entirely, not merely conditional");
  // Task A, final report simplification (supersedes this test's earlier
  // expectation): the ordinary-user branch no longer names "TurnitPlus
  // reference sources" either — it now uses fully neutral wording that
  // names no matching channel at all.
  assert.match(shell, /isUnified && canSeeSourceBreakdown\s*\n\s*\? <>TurnitPlus Similarity combines text found through TurnitPlus&apos;s own checks, verified external academic sources, and eligible previous TurnitPlus submissions/, "the admin branch keeps the existing detailed wording, gated on isUnified && canSeeSourceBreakdown");
  assert.match(shell, /TurnitPlus Similarity reflects matched text identified across the sources checked for this submission\. Highlighted passages show the text contributing to the result\./, "the ordinary-user (and non-unified) branch must use the fully neutral wording, matching the receipt's own established phrasing");
  // Task A correction: canSeeSourceBreakdown must derive from the explicit
  // viewerIsAdmin signal, never from historicalSubmissionMatch's own
  // presence — see SimilarityReport.viewerIsAdmin's own comment for why
  // that proxy is wrong (a real admin's own no-match report would read as
  // ordinary).
  assert.match(shell, /const canSeeSourceBreakdown = Boolean\(report\.viewerIsAdmin\);/, "must reuse the explicit, server-decided viewerIsAdmin signal, not a data-presence proxy");
  assert.doesNotMatch(shell, /canSeeSourceBreakdown = Boolean\(report\.historicalSubmissionMatch\)/, "REQUIRED: the old data-presence proxy must be gone");
});

test("REPORT NOTES (structural): report-detail-shell.tsx's 'Top source types' CategorySummary block is admin-only", () => {
  const shell = fs.readFileSync(path.join(repo, "app/reports/[id]/report-detail-shell.tsx"), "utf8");
  assert.match(shell, /mode === "similarity" && canSeeSourceBreakdown && <div className="inspector-section">\s*\n\s*<h3>Top source types<\/h3>/, "the source-type percentage breakdown must only render for an admin viewer");
});

test("PENDING MESSAGE (structural): OverviewReport's pending-state copy no longer names 'previously submitted content'", () => {
  const source = fs.readFileSync(path.join(repo, "components/report/similarity-report-papers.tsx"), "utf8");
  assert.doesNotMatch(source, /including previously submitted content/);
});

// --- MIXED-SOURCE SEMANTICS: exclusive contribution, never double-counted ---
// lib/unified-similarity.ts's computeUnifiedSimilarity already partitions
// every matched position into exactly one of archiveOnlyWords/
// liveAcademicOnlyWords/previousUploadOnlyWords/overlapWords — a position
// found by more than one source becomes overlapWords and is deliberately
// EXCLUDED from previousUploadOnlyWords (see that file's own "sourcesHere
// > 1" branch). referenceSourceContributionPercent reads
// previousUploadOnlyWords directly, so it inherits that exclusivity for
// free — these tests prove it stays that way, not that they merely trust it.

test("MIXED SOURCES: referenceSourceContributionPercent reflects only the exclusive (non-overlapping) internal contribution, never overlapWords folded in", () => {
  // 300 total words: 100 exclusively from a promoted corpus source, 50 found
  // by BOTH the archive and the corpus source at the same position (already
  // counted once in overlapWords by computeUnifiedSimilarity), 150 unmatched.
  // A naive (previousUploadOnlyWords + overlapWords) / wordCount would read
  // 50% — the correct, exclusive figure is 100/300 = 33%.
  const report = baseReport({
    unifiedSimilarity: unified({
      unifiedScore: 50,
      wordCount: 300,
      uniqueMatchedWords: 150,
      archiveOnlyWords: 0,
      liveAcademicOnlyWords: 0,
      previousUploadOnlyWords: 100,
      overlapWords: 50,
    }),
  });
  assert.equal(referenceSourceContributionPercent(report), 33, "must equal round(100/300*100), never round((100+50)/300*100)");
  assert.notEqual(referenceSourceContributionPercent(report), 50, "overlapWords must never be folded into the exclusive internal-contribution figure");
});

test("MIXED SOURCES: CategorySummary's reference-source row and Indexed publications row never naively sum past what the unified model actually attributes — each category reports only its own exclusive share", () => {
  // archiveOnlyWords 120 + previousUploadOnlyWords 60 + overlapWords 40 + 80
  // unmatched = 300 total; unifiedScore (from combineMatchedWordPositions)
  // is 220/300 = 73%, i.e. less than a naive 120+60+40=220 sum would already
  // suggest on its own if any category counted overlap twice.
  const report = baseReport({
    sources: [{ name: "Some Journal", type: "Publication", percent: 40, matches: 1, phrases: [] }],
    unifiedSimilarity: unified({
      unifiedScore: 73,
      wordCount: 300,
      uniqueMatchedWords: 220,
      archiveOnlyWords: 120,
      liveAcademicOnlyWords: 0,
      previousUploadOnlyWords: 60,
      overlapWords: 40,
    }),
  });
  const referencePercent = referenceSourceContributionPercent(report);
  assert.equal(referencePercent, 20, "round(60/300*100) — the reference-source row's own exclusive share, independent of report.sources' own (unrelated-axis) percent");
  const html = renderCategories(report);
  assert.match(html, new RegExp(`<strong>${referencePercent}%</strong>[\\s\\S]*?TurnitPlus reference sources`));
  // The two category rows are independent axes (report.sources vs.
  // unifiedSimilarity) that are never added together anywhere in this
  // component — there is no code path that could produce a combined figure
  // exceeding either source's own honest, already-deduplicated count.
  assert.equal(referencePercent <= 100, true);
});

// --- ZERO-PERCENT ROW BEHAVIOR: inspected, kept intentionally ---
// This codebase's existing convention (Indexed publications, above) already
// renders every searched category unconditionally, including a genuine 0%
// — CategorySummary has never hidden a zero-value row. The new reference-
// source row deliberately follows the identical convention (gated only on
// hasUnifiedSimilarity, never on percent > 0) rather than introducing a
// new, inconsistent "hide when zero" rule for just one category.

test("ZERO-PERCENT ROW: Indexed publications (the pre-existing category) already renders at a genuine 0% today — confirms the established convention this fix follows", () => {
  const html = renderCategories(baseReport({ sources: [] }));
  assert.match(html, /<strong>0%<\/strong>[\s\S]*?Indexed publications/, "the pre-existing category has always shown 0% rather than disappearing — establishes the convention CategorySummary already follows");
});

test("ZERO-PERCENT ROW: TurnitPlus reference sources deliberately follows the same always-shown convention — a unified report with zero internal contribution still shows the row at 0%, not hidden", () => {
  const report = baseReport({
    unifiedSimilarity: unified({ unifiedScore: 40, wordCount: 1000, uniqueMatchedWords: 400, archiveOnlyWords: 400, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0 }),
  });
  const html = renderCategories(report);
  assert.match(html, /<strong>0%<\/strong>[\s\S]*?TurnitPlus reference sources/, "must render at 0%, matching Indexed publications' own established zero-value behavior, not disappear below some threshold");
});
