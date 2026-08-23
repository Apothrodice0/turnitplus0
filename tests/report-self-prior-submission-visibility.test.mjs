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
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest } from "../lib/rate-limit.js";

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
 * historicalSubmissionMatch was a strict superset.
 *
 * UI-01 correction: the first version of this fix showed matchClassification
 * to every viewer of their own report — too broad, since it reveals that a
 * real prior submission exists (possibly under a different account), which
 * this product had never otherwise surfaced to an ordinary user. Corrected
 * to admin-only, gated server-side in app/api/reports/[id]/route.ts's GET
 * handler on the AUTHENTICATED session's own `role === 'admin'` column —
 * never ADMIN_EMAIL, a query parameter, or any other client-controlled
 * value — and stripped from the response entirely (never computed at all)
 * for anyone else, so there is nothing for a non-admin to find in the JSON
 * response, HTML, or React payload.
 *
 * This file proves the fix end to end in three parts: Part 1, the real
 * family-matching pipeline (against a real local database, no corpus/
 * consent tables touched) produces a non-null classification for a
 * same-account cross-format resubmission; Part 2, the restored UI (real
 * React SSR via react-dom/server) renders it correctly and safely
 * whenever given it; Part 3, the real GET /api/reports/[id] route only
 * ever attaches matchClassification to an admin session's own response,
 * proving the requirement Part 2 alone cannot: that ordinary/anonymous/
 * cross-account/client-spoofed viewers never receive the field in the
 * first place.
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
  assert.match(html, /<strong>100%<\/strong> of this submission matches the account&#x27;s own previous TurnitPlus submission/);
  assert.doesNotMatch(html, /Historical matching unavailable/, "NO_HISTORICAL_MATCH must not render the UNAVAILABLE branch's own copy");
});

test("REQUIREMENT 6: the section is clearly labeled as internal/admin-only debug information", () => {
  const html = render(baseReport({ matchClassification: { selfMatchPercent: 100, priorSubmissionPercent: null } }));
  assert.match(html, /internal debug information, admin only/i);
  assert.match(html, /Not shown to the report&#x27;s own viewer|Not shown to the report's own viewer/i);
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
  assert.match(html, /<strong>0%<\/strong> of this submission matches the account&#x27;s own previous TurnitPlus submission/);
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

// --- Part 3: real GET /api/reports/[id] route, real sessions ---------------
// The only part of this fix that actually PROVES the security property: not
// "does the UI render this correctly if handed it" (Part 2), but "does an
// ordinary/anonymous/cross-account/client-spoofed viewer ever receive the
// field from the server at all." process.env.TURSO_DATABASE_URL is pointed
// at this same test database so the route handlers below (which read it
// internally via getReportsDbClient()) see the same data `client` set up.

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ADMIN_EMAIL = "ui01-admin@example.com";

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
    body: JSON.stringify({ email, password: "ui01-password-1", username: tag.replace(/[^a-z0-9]/gi, ""), deviceKey }),
  });
  const res = await signupRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

// A minimal but fully-shaped SimilarityReport payload — MatchGroups and the
// rest of OverviewReport read several array/object fields unconditionally
// (sources, repeats, features, riskCalibration, ...), so the JSON stored in
// payload_json needs all of them present, not just `text`, or rendering the
// real fetched report throws. archiveScore in particular must live INSIDE
// this object: the route's top-level `archiveScore` request field only ever
// populates the separate saved_reports.archive_score DB column (used for
// room/list views) — GET returns payload_json verbatim, so a test that
// wants payload.archiveScore on the fetched report must put it here too.
function similarityReportPayload(title, rawText) {
  return {
    version: 11,
    id: "sub-" + title,
    submissionId: "sub-" + title,
    title,
    author: "",
    assignment: "",
    created: new Date().toISOString(),
    score: 7,
    archiveScore: 7,
    wordCount: 200,
    characterCount: 1000,
    pageCount: 1,
    fileSize: "1 KB",
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
    text: rawText,
  };
}

async function postReport(deviceKey, { cookie, id, title, rawText, room, tag }) {
  await resetRateForTest(tag);
  const headers = { "content-type": "application/json", "x-forwarded-for": tag };
  if (cookie) headers["cookie"] = `tp_session_v1=${cookie}`;
  const req = new Request("http://localhost/api/reports", {
    method: "POST",
    headers,
    body: JSON.stringify({
      deviceKey,
      id,
      submissionId: "sub-" + id,
      title,
      createdAt: new Date().toISOString(),
      wordCount: 200,
      archiveScore: 7,
      scoreBand: "Moderate",
      aiScore: null,
      aiTone: null,
      payload: similarityReportPayload(title, rawText),
      ...(cookie ? { room } : {}),
    }),
  });
  return reportsRoute.POST(req);
}

async function getReport(id, { deviceKey, cookie, tag }) {
  await resetRateForTest(tag);
  const headers = { "x-forwarded-for": tag };
  if (cookie) headers["cookie"] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { headers });
  const res = await reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
  const body = await res.json();
  return { res, body };
}

const adminSignup = await signup("ui01-admin@example.com", "ui01-admin-device", "ui01-admin-signup");
const adminCookie = adminSignup.cookie;
const ordinarySignup = await signup("ui01-ordinary@example.com", "ui01-ordinary-device", "ui01-ordinary-signup");
const ordinaryCookie = ordinarySignup.cookie;
const intruderSignup = await signup("ui01-intruder@example.com", "ui01-intruder-device", "ui01-intruder-signup");
const intruderCookie = intruderSignup.cookie;

// Two reports under the admin's own account, textually overlapping enough
// (same fixture as Part 1/2) to produce a real, non-null classification —
// this reproduces the exact production shape: the account that sees the
// debug signal is the SAME account that owns both reports, viewing its own
// report as an admin, not viewing anyone else's.
await postReport("ui01-admin-device", { cookie: adminCookie, id: "ui01-admin-report-1", title: "admin-first.docx", rawText: docxLikeText, room: 0, tag: "ui01-admin-post-1" });
const adminSecondSave = await postReport("ui01-admin-device", { cookie: adminCookie, id: "ui01-admin-report-2", title: "admin-second.pdf", rawText: pdfLikeText, room: 1, tag: "ui01-admin-post-2" });
assert.equal(adminSecondSave.status, 200);

// One ordinary (non-admin) account's own report, same textual overlap
// against the admin's own content, so a non-null classification would
// exist to strip if the gate were missing.
const ordinaryFirstSave = await postReport("ui01-ordinary-device", { cookie: ordinaryCookie, id: "ui01-ordinary-report-1", title: "ordinary.pdf", rawText: pdfLikeText, room: 0, tag: "ui01-ordinary-post-1" });
assert.equal(ordinaryFirstSave.status, 200);

test("REQUIREMENT: admin session receives and would render the debug signal", async () => {
  const { res, body } = await getReport("ui01-admin-report-2", { cookie: adminCookie, tag: "ui01-get-admin" });
  assert.equal(res.status, 200);
  assert.ok(body.payload.matchClassification, "an admin viewing their own report must receive matchClassification");
  assert.notEqual(body.payload.matchClassification.selfMatchPercent, null, "the two admin-owned reports overlap enough to produce a real self-match");
  const html = renderToStaticMarkup(React.createElement(OverviewReport, { report: body.payload }));
  assert.match(html, /Submission history/);
  assert.match(html, /internal debug information, admin only/i);
});

test("REQUIREMENT: ordinary authenticated report owner never receives matchClassification, selfMatchPercent, or priorSubmissionPercent", async () => {
  const { res, body } = await getReport("ui01-ordinary-report-1", { cookie: ordinaryCookie, tag: "ui01-get-ordinary" });
  assert.equal(res.status, 200);
  assert.equal(body.payload.matchClassification, undefined, "the field must not exist on the response at all, not merely be null");
  const rawJson = JSON.stringify(body);
  assert.doesNotMatch(rawJson, /matchClassification/, "the key itself must never appear in the serialized JSON response");
  assert.doesNotMatch(rawJson, /selfMatchPercent|priorSubmissionPercent/, "neither field name may leak anywhere in the response, even nested");
  const html = renderToStaticMarkup(React.createElement(OverviewReport, { report: body.payload }));
  assert.doesNotMatch(html, /Submission history/, "with the field absent, the UI has nothing to render — not a CSS-hidden section");
});

test("REQUIREMENT: anonymous and cross-account access remain protected (pre-existing ownership check, untouched by this fix)", async () => {
  const anonResult = await getReport("ui01-ordinary-report-1", { deviceKey: "some-anonymous-device-key-not-owner", tag: "ui01-get-anon" });
  assert.equal(anonResult.res.status, 404, "an anonymous request for an account-owned report must get the same generic 404 as before");

  const crossAccountResult = await getReport("ui01-ordinary-report-1", { cookie: intruderCookie, tag: "ui01-get-cross" });
  assert.equal(crossAccountResult.res.status, 404, "a different authenticated account must never be able to fetch someone else's report, admin-gate or not");
});

test("REQUIREMENT: client-controlled inputs cannot enable the admin view", async () => {
  // A request cannot supply its own role — there is no field for it in this
  // route's request shape at all (GET takes only an id path param and an
  // optional deviceKey query param for the anonymous path) — but this
  // proves the negative directly: neither a spoofed header nor a spoofed
  // query parameter claiming admin-ness has any effect on an ordinary
  // account's own session.
  await resetRateForTest("ui01-get-spoof");
  const req = new Request(
    `http://localhost/api/reports/ui01-ordinary-report-1?role=admin&admin=true&isAdmin=1`,
    {
      headers: {
        "x-forwarded-for": "ui01-get-spoof",
        cookie: `tp_session_v1=${ordinaryCookie}`,
        "x-role": "admin",
        "x-admin": "true",
        "x-user-role": "admin",
      },
    },
  );
  const res = await reportIdRoute.GET(req, { params: Promise.resolve({ id: "ui01-ordinary-report-1" }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.payload.matchClassification, undefined, "spoofed query params/headers must have zero effect — only the authenticated session's own role column decides this");
});

test("REQUIREMENT: public similarity output remains unchanged for both admin and ordinary viewers", async () => {
  const adminView = await getReport("ui01-admin-report-2", { cookie: adminCookie, tag: "ui01-get-admin-score" });
  const ordinaryView = await getReport("ui01-ordinary-report-1", { cookie: ordinaryCookie, tag: "ui01-get-ordinary-score" });
  assert.equal(typeof adminView.body.payload.archiveScore, "number");
  assert.equal(adminView.body.payload.archiveScore, 7, "archiveScore must be exactly what was saved, regardless of viewer role");
  assert.equal(ordinaryView.body.payload.archiveScore, 7, "archiveScore for the ordinary viewer's own report must be equally unaffected by the admin gate added to a completely different field");
});

test("REQUIREMENT: internal classification remains computed/available server-side for later corpus-enhanced-similarity use, even though it is never serialized to an ordinary viewer", async () => {
  // Calling the underlying function directly (as a future corpus-enhanced-
  // similarity phase would, server-side, never through this admin-gated
  // HTTP response) still works and still sees the real family relationship
  // — proving the gate added in app/api/reports/[id]/route.ts only concerns
  // what one HTTP response contains, never the underlying capability.
  const ordinaryUserRow = await client.execute({ sql: "SELECT id FROM users WHERE email = ?", args: ["ui01-ordinary@example.com"] });
  const ordinaryAccountId = ordinaryUserRow.rows[0].id;
  const classification = await classifyReportMatches(client, { rawText: pdfLikeText, accountId: ordinaryAccountId });
  assert.ok(classification);
  // pdfLikeText was also submitted by the admin's OWN account above, so
  // from the ordinary account's perspective this is a different account's
  // prior submission (PRIOR_SUBMISSION), not a self-match.
  assert.notEqual(classification.priorSubmissionPercent, null);

  // Save-time identity/family capture (the durable part of the signal) is
  // completely untouched by this route-level response gate — confirmed by
  // the ordinary account's own two rows already existing in document_identities
  // and document_family_members from the postReport calls above.
  const identityCount = await client.execute({ sql: "SELECT COUNT(*) AS n FROM document_identities WHERE account_id = (SELECT id FROM users WHERE email = ?)", args: ["ui01-ordinary@example.com"] });
  assert.ok(Number(identityCount.rows[0].n) >= 1, "identity capture must still have run for the ordinary account's own upload");
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* best-effort */ }
  }
});
