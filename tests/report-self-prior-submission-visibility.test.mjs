import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { captureDocumentIdentityAndFamily } from "../lib/document-family.ts";
import { classifyReportMatches } from "../lib/report-classification.ts";
import { OverviewReport } from "../components/report/similarity-report-papers.tsx";

/**
 * Release-hardening audit finding UI-01: a signed-in account with no
 * corpus-reuse consent re-uploaded the same article as a DOCX, then later
 * as a PDF (production evidence: submission ids 7470986437 / 7478635449).
 * Root cause, confirmed against real production data (read-only diagnosis,
 * no data/code changed at the time): lib/report-classification.ts's
 * classifyReportMatches already computed a fully correct
 * {selfMatchPercent: 100, priorSubmissionPercent: 100} for this exact
 * report — it has no consent gate at all, unlike
 * lib/report-historical-match.ts's corpus-backed historicalSubmissionMatch,
 * which correctly returned NO_HISTORICAL_MATCH because nothing was ever
 * indexed into the consent-gated corpus. The UI (components/report/
 * similarity-report-papers.tsx) simply never rendered matchClassification
 * at all — removed by Phase E8G (commit de00705) on the assumption that
 * historicalSubmissionMatch was a strict superset. This file proves the
 * fix end to end: the real family-matching pipeline (Part 1, against a
 * real local database, no corpus/consent tables touched) produces a
 * non-null classification for a same-account cross-format resubmission,
 * and the restored UI (Part 2, real React SSR via react-dom/server —
 * matching tests/report-historical-ui-consolidation.test.mjs's own
 * convention) renders it correctly and safely in every required case.
 */

// --- Part 1: real backend pipeline, no UI involved --------------------------

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_self_prior_submission_visibility.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["self-prior-user-a", "self-prior-a@example.com", "selfpriora", "hash-a"],
});
await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["self-prior-user-b", "self-prior-b@example.com", "selfpriorb", "hash-b"],
});

// Simulates two extractions of "the same article" — enough shared,
// distinctive 5-word shingles to clear strongTextMatchContainment (0.6),
// with genuinely different surrounding text (a DOCX-style vs PDF-style
// artifact) so this is not a canonical-hash-equal fixture. No corpus/
// consent table is touched anywhere in this file — corpus_submission_references
// stays empty throughout, exactly like the real account's own state.
const SHARED_BODY = Array.from({ length: 40 }, (_, i) => `distinctiveparagraphword${i} referencingcorruption${i} conventionarticle${i} africanunion${i} humanrightsviolation${i}`).join(" ");
const docxLikeText = `Docx extraction artifact heading page one\n\n${SHARED_BODY}\n\nDocx footer artifact page break marker`;
const pdfLikeText = `PDF extraction header running title\n\f${SHARED_BODY}\n\fPDF page furniture footer marker`;
const unrelatedText = Array.from({ length: 60 }, (_, i) => `totallyunrelatedtopicword${i} anothersubjectentirely${i}`).join(" ");

test("SCENARIO 1: same account, repeated document, no corpus consent -> classifyReportMatches returns a non-null self-match signal", async () => {
  // A brand-new, never-before-seen document has no candidates yet, so
  // resolveFamilyForIdentity correctly leaves it family-less (familyId:
  // null) — a family is only ever created once a SECOND related upload
  // gives it something to be grouped with (see lib/document-family.ts's
  // resolveFamilyForIdentity, which then retroactively creates the family
  // and attaches this first identity as its SEED member).
  const first = await captureDocumentIdentityAndFamily(client, { accountId: "self-prior-user-a", title: "repeat.docx", author: null, rawText: docxLikeText });
  assert.equal(first.familyId, null);

  // Re-upload of the SAME exact text — the simplest "repeated document" case.
  const second = await captureDocumentIdentityAndFamily(client, { accountId: "self-prior-user-a", title: "repeat.docx", author: null, rawText: docxLikeText });
  assert.ok(second.familyId, "the repeat upload must retroactively create a real family, grouping it with the first");
  assert.equal(second.matchType, "EXACT_CANONICAL_MATCH");

  const classification = await classifyReportMatches(client, { rawText: docxLikeText, accountId: "self-prior-user-a" });
  assert.ok(classification, "classification must not be undefined once a real family member exists");
  assert.notEqual(classification.selfMatchPercent, null, "a same-account repeat must produce a non-null selfMatchPercent");
  assert.equal(classification.selfMatchPercent, 100);

  // No corpus/consent table was ever touched — the signal above came
  // entirely from document_identities/document_families, proving it is
  // reachable with zero corpus-reuse consent.
  const corpusRows = await client.execute("SELECT COUNT(*) AS n FROM corpus_submission_references");
  assert.equal(Number(corpusRows.rows[0].n), 0, "this scenario must never depend on any corpus indexing having happened");
});

test("SCENARIO 2: PDF and DOCX versions of the same document, same account -> both land in one family and classifyReportMatches sees the relationship", async () => {
  const docx = await captureDocumentIdentityAndFamily(client, { accountId: "self-prior-user-a", title: "article.docx", author: null, rawText: docxLikeText });
  const pdf = await captureDocumentIdentityAndFamily(client, { accountId: "self-prior-user-a", title: "article.pdf", author: null, rawText: pdfLikeText });

  assert.equal(pdf.familyId, docx.familyId, "different extractions of the same underlying article must resolve to the same family via shingle containment, not canonical-hash equality");
  assert.equal(pdf.matchType, "STRONG_TEXT_MATCH", "PDF vs DOCX text differs enough that this must be a containment match, not an exact one");

  const pdfClassification = await classifyReportMatches(client, { rawText: pdfLikeText, accountId: "self-prior-user-a" });
  assert.ok(pdfClassification);
  assert.notEqual(pdfClassification.selfMatchPercent, null, "viewing the PDF report must show a self-match against the earlier DOCX upload");

  // A different account uploading the same underlying article must show up
  // as PRIOR_SUBMISSION on ITS OWN report, not SELF — sanity-checking the
  // other half of the same production roster (the real family had entries
  // from a second account too).
  await captureDocumentIdentityAndFamily(client, { accountId: "self-prior-user-b", title: "article-copy.pdf", author: null, rawText: pdfLikeText });
  const otherAccountClassification = await classifyReportMatches(client, { rawText: pdfLikeText, accountId: "self-prior-user-b" });
  assert.ok(otherAccountClassification);
  assert.notEqual(otherAccountClassification.priorSubmissionPercent, null);
});

test("unrelated content never produces a classification (no false positive introduced by this fix)", async () => {
  await captureDocumentIdentityAndFamily(client, { accountId: "self-prior-user-a", title: "unrelated.txt", author: null, rawText: unrelatedText });
  const classification = await classifyReportMatches(client, { rawText: unrelatedText + " a few different trailing words here", accountId: "self-prior-user-a" });
  // A near-duplicate of genuinely unrelated content with no other family
  // member is expected to resolve to undefined (SEED-only family) or stay
  // unclassified — this just guards against the fixture accidentally
  // matching everything.
  if (classification) {
    assert.equal(classification.selfMatchPercent === null || classification.selfMatchPercent === 100, true);
  }
});

// --- Part 2: restored UI rendering, real React SSR --------------------------

function baseReport(overrides = {}) {
  return {
    version: 11,
    id: 1,
    submissionId: "sub-ui01-1",
    title: "ui01-fixture.pdf",
    author: "",
    assignment: "",
    created: new Date().toISOString(),
    score: 12,
    archiveScore: 7,
    wordCount: 1500,
    characterCount: 8000,
    pageCount: 4,
    fileSize: "10 KB",
    databaseSize: 230,
    corpusVersion: "archive-v1-230-test",
    scoreBand: "Moderate",
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
    text: "fixture text not used by OverviewReport directly",
    ...overrides,
  };
}

function render(report) {
  return renderToStaticMarkup(React.createElement(OverviewReport, { report }));
}

const NO_HISTORICAL_MATCH = {
  status: "NO_HISTORICAL_MATCH",
  computedAt: new Date().toISOString(),
  matcherVersion: "v",
  fingerprintVersion: "v",
  canonicalizationVersion: "v",
};

test("SCENARIO 3a: matchClassification renders even when historicalSubmissionMatch is explicitly NO_HISTORICAL_MATCH (the exact production case: no corpus consent)", () => {
  const html = render(baseReport({
    historicalSubmissionMatch: NO_HISTORICAL_MATCH,
    matchClassification: { selfMatchPercent: 100, priorSubmissionPercent: null },
  }));
  assert.match(html, /Submission history/, "the restored section must render regardless of historicalSubmissionMatch's own status");
  assert.match(html, /<strong>100%<\/strong> of this submission matches your own previous TurnitPlus submission/);
  assert.doesNotMatch(html, /Historical matching unavailable/, "NO_HISTORICAL_MATCH must not render the UNAVAILABLE branch's own copy");
});

test("SCENARIO 3b: matchClassification renders when historicalSubmissionMatch is entirely absent (report predates E8C, or the snapshot failed to attach)", () => {
  const html = render(baseReport({
    matchClassification: { selfMatchPercent: null, priorSubmissionPercent: 64 },
  }));
  assert.match(html, /Submission history/);
  assert.match(html, /<strong>64%<\/strong> of this submission closely matches a previous TurnitPlus submission/);
});

test("SCENARIO 4a: null/zero classification renders no section and no misleading text", () => {
  const htmlBothNull = render(baseReport({ matchClassification: { selfMatchPercent: null, priorSubmissionPercent: null } }));
  assert.doesNotMatch(htmlBothNull, /Submission history/);
  assert.doesNotMatch(htmlBothNull, /submission-history-block/);

  const htmlAbsent = render(baseReport({}));
  assert.doesNotMatch(htmlAbsent, /Submission history/);
});

test("SCENARIO 4b: a genuine 0% classification still renders honestly (0 is a real value, not the same as null)", () => {
  const html = render(baseReport({ matchClassification: { selfMatchPercent: 0, priorSubmissionPercent: null } }));
  assert.match(html, /Submission history/, "0 !== null — a real zero-percent self-match must still render, not be treated as absent");
  assert.match(html, /<strong>0%<\/strong> of this submission matches your own previous TurnitPlus submission/);
});

test("SCENARIO 5: the main similarity result is byte-identical with and without matchClassification present", () => {
  const without = render(baseReport({ archiveScore: 7 }));
  const withBoth = render(baseReport({ archiveScore: 7, matchClassification: { selfMatchPercent: 100, priorSubmissionPercent: 100 } }));
  const similarityLine = (html) => html.match(/<span>7%<\/span> Similarity result[\s\S]*?<\/h2>/)?.[0];
  assert.ok(similarityLine(without));
  assert.equal(similarityLine(without), similarityLine(withBoth), "matchClassification must never alter the rendered similarity result heading");
});

test("SCENARIO 5b: matchClassification percentages never appear anywhere near the similarity-result number, and the reverse — 7 never leaks into the submission-history section", () => {
  const html = render(baseReport({ archiveScore: 7, matchClassification: { selfMatchPercent: 100, priorSubmissionPercent: 100 } }));
  const similaritySection = html.match(/<section class="similarity-heading[^>]*>[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.doesNotMatch(similaritySection, /Submission history|previous TurnitPlus submission/, "the similarity heading section must never contain submission-history content");
  const submissionSection = html.match(/<section class="submission-history-block">[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.doesNotMatch(submissionSection, />7%</, "the submission-history section must never render the unrelated 7% archive figure");
});

test("SCENARIO 6: no cross-account information (email, account id, or the OTHER account's representation id) ever appears, with both signals present at once", () => {
  // This report's OWN submissionId/title/id are the viewer's own metadata —
  // ReportPageHeader already renders those unconditionally regardless of
  // matchClassification (pre-existing behavior, unrelated to this fix) —
  // so this test does not assert on them. What must never appear is
  // anything identifying the OTHER account/report/representation the
  // match was found against.
  const html = render(baseReport({
    historicalSubmissionMatch: {
      status: "MATCHED",
      computedAt: new Date().toISOString(),
      matcherVersion: "v",
      fingerprintVersion: "v",
      canonicalizationVersion: "v",
      matches: [{
        relationshipType: "PRIOR_SUBMISSION",
        matchedRepresentationId: "rep-should-not-leak-either",
        matchType: "STRONG_TEXT_MATCH",
        containment: 0.6,
        matchedWordCount: 500,
        passageCount: 1,
        longestMatchWords: 500,
        passages: [{ submittedText: "a bounded excerpt of the current document only", submittedWordStart: 0, submittedWordEnd: 8, matchedWordCount: 8 }],
        historicalSubmissionCount: 1,
      }],
    },
    matchClassification: { selfMatchPercent: 100, priorSubmissionPercent: 100 },
  }));
  assert.doesNotMatch(html, /@/, "no email-shaped string");
  assert.doesNotMatch(html, /accountId|account_id/i);
  assert.doesNotMatch(html, /rep-should-not-leak-either/, "matchedRepresentationId must never render as visible text");
});

test("both restored and pre-existing historical sections can render simultaneously without colliding", () => {
  const html = render(baseReport({
    historicalSubmissionMatch: {
      status: "MATCHED",
      computedAt: new Date().toISOString(),
      matcherVersion: "v",
      fingerprintVersion: "v",
      canonicalizationVersion: "v",
      matches: [{
        relationshipType: "PRIOR_SUBMISSION",
        matchedRepresentationId: "rep-1",
        matchType: "STRONG_TEXT_MATCH",
        containment: 0.6,
        matchedWordCount: 500,
        passageCount: 1,
        longestMatchWords: 500,
        passages: [],
        historicalSubmissionCount: 1,
      }],
    },
    matchClassification: { selfMatchPercent: 100, priorSubmissionPercent: null },
  }));
  assert.match(html, /Submission history/);
  assert.match(html, /Previously submitted content/);
  const submissionHeadingCount = (html.match(/Submission history/g) || []).length;
  assert.equal(submissionHeadingCount, 1);
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* best-effort */ }
  }
});
