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
import { OverviewReport, UnifiedSimilaritySection } from "../components/report/similarity-report-papers.tsx";
import { findRoomOccupant } from "../lib/reports-repo.ts";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";

/**
 * Release-hardening audit finding UI-02: historicalSubmissionMatch (a
 * corpus-match's relationshipType, matchedRepresentationId, matcher/
 * fingerprint/canonicalization versions, and raw passage excerpts) was
 * attached to app/api/reports/[id]/route.ts's GET response for EVERY
 * viewer of their own report, unconditionally — the same class of internal
 * diagnostic information matchClassification was already correctly
 * restricted to admin sessions for (see tests/report-self-prior-
 * submission-visibility.test.mjs, UI-01, the direct template for this
 * file's Part 3). Fixed the identical way: gated server-side on the
 * AUTHENTICATED session's own `role === 'admin'` column, omitted entirely
 * (never assigned onto `payload`) for anyone else — see that route's own
 * comment.
 *
 * This file also covers the corollary the older UI-01 fix did not need to:
 * components/report/similarity-report-papers.tsx's UnifiedSimilaritySection
 * names the exact same "previous TurnitPlus submission"/"corpus reference
 * source" concepts in its own per-source-type breakdown paragraph and
 * SELF/UNKNOWN exclusion note, even though it reads report.unifiedSimilarity
 * (which stays present and correctly scored for EVERY viewer — the
 * aggregate result itself is never gated) rather than
 * historicalSubmissionMatch directly. That breakdown/exclusion wording is
 * now also admin-only, gated on historicalSubmissionMatch's own (now
 * admin-only) presence on the report — see that component's own comment.
 */

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_report_historical_match_visibility.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
process.env.ADMIN_EMAIL = "hmvis-admin@example.com";

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);
const openConnection = () => createClient({ url: `file:${dbFile}` });

test.after(() => {
  client.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  delete process.env.ADMIN_EMAIL;
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
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
      id, null, `hmvis-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 200, "English", 0.95, hash, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}

/** Promotes a real, admin-accepted corpus source — no account/submission reference of its own, matching lib/user-submission-matching.ts's TURNITPLUS_CORPUS_SOURCE convention. */
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
}

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

/** ADMIN_EMAIL-driven promotion (lib/admin-role.ts's maybePromoteToAdmin) — the real production mechanism, not a raw DB write, so this file also proves the fix is reachable through the actual account-creation path. */
async function signup(email, deviceKey, tag) {
  await resetAuthRateForTest(tag);
  const req = new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag },
    body: JSON.stringify({ email, password: "hmvis-password-1", username: tag.replace(/[^a-z0-9]/gi, ""), deviceKey }),
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

async function getReport(id, { cookie, tag, extraQuery = "", extraHeaders = {} }) {
  await resetReadRateForTest(tag);
  const headers = { "x-forwarded-for": tag, cookie: `tp_session_v1=${cookie}`, ...extraHeaders };
  const url = `http://localhost/api/reports/${id}${extraQuery ? `?${extraQuery}` : ""}`;
  const req = new Request(url, { headers });
  const res = await reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
  const body = await res.json();
  return { res, body };
}

const CORPUS_TEXT =
  "Paleoclimatologists reconstructing sea-surface temperature records from coral core samples identified a centuries-long warming trend preceding the onset of a regional monsoon shift, " +
  "with isotopic banding patterns providing an annually resolved chronology that closely tracked independent ice-core proxies from the same latitude band across the full sampled interval.";
const CORPUS_WORD_COUNT = 60;

await promoteDocumentIntoCorpus(CORPUS_TEXT);

const admin = await signup("hmvis-admin@example.com", "hmvis-admin-device", "hmvis-admin-signup");
const ordinary = await signup("hmvis-ordinary@example.com", "hmvis-ordinary-device", "hmvis-ordinary-signup");

await postReport({ deviceKey: "hmvis-admin-device", cookie: admin.cookie, id: "hmvis-admin-report", title: "admin-corpus-match.pdf", text: CORPUS_TEXT, wordCount: CORPUS_WORD_COUNT, room: 0, tag: "hmvis-admin-post" });
await postReport({ deviceKey: "hmvis-ordinary-device", cookie: ordinary.cookie, id: "hmvis-ordinary-report", title: "ordinary-corpus-match.pdf", text: CORPUS_TEXT, wordCount: CORPUS_WORD_COUNT, room: 0, tag: "hmvis-ordinary-post" });

// --- Part 1: real end-to-end route tests, real sessions, a real corpus match ---

test("REQUIREMENT (admin visibility): an admin session receives full historicalSubmissionMatch details for its own real corpus-source match", async () => {
  const { res, body } = await getReport("hmvis-admin-report", { cookie: admin.cookie, tag: "hmvis-get-admin" });
  assert.equal(res.status, 200);
  assert.ok(body.payload.historicalSubmissionMatch, "an admin viewing their own report must receive historicalSubmissionMatch");
  assert.equal(body.payload.historicalSubmissionMatch.status, "MATCHED");
  assert.equal(body.payload.historicalSubmissionMatch.matches.length, 1);
  assert.equal(body.payload.historicalSubmissionMatch.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
  assert.ok(body.payload.historicalSubmissionMatch.matches[0].matchedRepresentationId, "the admin view includes the internal representation id — this is the diagnostic detail the gate exists to restrict, not to delete");
});

test("REQUIREMENT (ordinary-user omission from raw JSON): an ordinary authenticated report owner never receives historicalSubmissionMatch — omitted entirely, not null", async () => {
  const { res, body } = await getReport("hmvis-ordinary-report", { cookie: ordinary.cookie, tag: "hmvis-get-ordinary" });
  assert.equal(res.status, 200);
  assert.equal(body.payload.historicalSubmissionMatch, undefined, "the field must not exist on the response at all, not merely be null");
  const rawJson = JSON.stringify(body);
  assert.doesNotMatch(rawJson, /historicalSubmissionMatch/, "the key itself must never appear in the serialized JSON response");
  assert.doesNotMatch(rawJson, /matchedRepresentationId|relationshipType|TURNITPLUS_CORPUS_SOURCE/, "no diagnostic sub-field may leak anywhere in the response, even nested");
});

test("REQUIREMENT (role-spoof resistance): client-controlled inputs cannot enable the admin view", async () => {
  // The GET route has no request field for role at all — this proves the
  // negative directly: neither a spoofed query parameter nor a spoofed
  // header claiming admin-ness has any effect on an ordinary account's own
  // session, which is derived only from the session token -> users.role
  // column (lib/auth-session.ts's getSessionUser), never from anything the
  // client sends.
  const { res, body } = await getReport("hmvis-ordinary-report", {
    cookie: ordinary.cookie, tag: "hmvis-get-spoof",
    extraQuery: "role=admin&admin=true&isAdmin=1",
    extraHeaders: { "x-role": "admin", "x-admin": "true", "x-user-role": "admin" },
  });
  assert.equal(res.status, 200);
  assert.equal(body.payload.historicalSubmissionMatch, undefined, "spoofed query params/headers must have zero effect — only the authenticated session's own role column decides this");
});

test("REQUIREMENT (unchanged aggregate score): unifiedSimilarity.unifiedScore is identical for admin and ordinary viewers of their own equally-matching reports — the gate only concerns the diagnostic breakdown, never the score", async () => {
  const adminView = await getReport("hmvis-admin-report", { cookie: admin.cookie, tag: "hmvis-get-admin-score" });
  const ordinaryView = await getReport("hmvis-ordinary-report", { cookie: ordinary.cookie, tag: "hmvis-get-ordinary-score" });
  assert.equal(adminView.body.payload.unifiedSimilarity.unifiedScore, 100, "test setup sanity: the promoted corpus source must genuinely match");
  assert.equal(ordinaryView.body.payload.unifiedSimilarity.unifiedScore, 100, "REQUIRED: the ordinary viewer's own aggregate score must be exactly as high");
  assert.equal(ordinaryView.body.payload.archiveScore, 0, "archive_score itself must be untouched by this gate");
  assert.ok(ordinaryView.body.payload.unifiedSimilarity, "REQUIRED: unifiedSimilarity itself must still be preserved and present for the ordinary viewer");
});

test("REQUIREMENT (no representation-id leak via unifiedSimilarity itself): an ordinary viewer's unifiedSimilarity.contributions is stripped to an empty array, never carrying the internal representation id or relationship label that historicalSubmissionMatch.matches[] itself carries for an admin", async () => {
  const adminView = await getReport("hmvis-admin-report", { cookie: admin.cookie, tag: "hmvis-get-admin-contrib" });
  const ordinaryView = await getReport("hmvis-ordinary-report", { cookie: ordinary.cookie, tag: "hmvis-get-ordinary-contrib" });

  assert.ok(adminView.body.payload.unifiedSimilarity.contributions.length > 0, "test setup sanity: the admin's own real match must produce at least one contribution entry");
  assert.equal(adminView.body.payload.unifiedSimilarity.contributions[0].sourceId, adminView.body.payload.historicalSubmissionMatch.matches[0].matchedRepresentationId, "sanity: contributions[].sourceId is genuinely the same internal id historicalSubmissionMatch already carries for an admin");

  assert.deepEqual(ordinaryView.body.payload.unifiedSimilarity.contributions, [], "REQUIRED: an ordinary viewer's contributions array must be empty — it is not rendered by any production UI and carries the same internal id historicalSubmissionMatch is gated to protect");
  const ordinaryRawJson = JSON.stringify(ordinaryView.body);
  assert.doesNotMatch(ordinaryRawJson, /sourceId|TURNITPLUS_CORPUS_SOURCE|previous_upload/, "no contribution-shaped diagnostic content may leak anywhere in the ordinary viewer's response");
  assert.equal(ordinaryView.body.payload.unifiedSimilarity.unifiedScore, 100, "stripping contributions must never affect the aggregate score sitting right next to it");
});

test("REQUIREMENT (room card unaffected, immediate and consistent): findRoomOccupant shows the same real 100% the admin's own GET response shows — it never read historicalSubmissionMatch to begin with", async () => {
  const ordinaryUserRow = await client.execute({ sql: "SELECT id FROM users WHERE email = ?", args: ["hmvis-ordinary@example.com"] });
  const ordinaryUserId = ordinaryUserRow.rows[0].id;
  const occupant = await findRoomOccupant(client, ordinaryUserId, 0);
  assert.equal(occupant.status, "ready");
  assert.equal(occupant.report.primaryScore, 100, "the room card must show the real, immediate combined score");
  assert.equal(occupant.report.isUnified, true);
  assert.equal(occupant.report.similarityStatus, "resolved");
  const serialized = JSON.stringify(occupant.report);
  assert.doesNotMatch(serialized, /historicalSubmissionMatch|matchedRepresentationId|relationshipType/, "the room summary must never carry historical-match diagnostic fields — it was already a plain json_extract read, structurally incapable of leaking them");
});

test("REQUIREMENT (no identity leakage, admin view included): neither account's email nor raw account id ever appears in either viewer's response — the admin's own extra diagnostic detail still never identifies the OTHER side of a match", async () => {
  const adminView = await getReport("hmvis-admin-report", { cookie: admin.cookie, tag: "hmvis-get-admin-identity" });
  const ordinaryView = await getReport("hmvis-ordinary-report", { cookie: ordinary.cookie, tag: "hmvis-get-ordinary-identity" });
  for (const view of [adminView, ordinaryView]) {
    const serialized = JSON.stringify(view.body);
    assert.doesNotMatch(serialized, /@/, "no email-shaped string may ever appear in a report response");
    assert.doesNotMatch(serialized, /hmvis-admin@example\.com|hmvis-ordinary@example\.com/);
  }
});

// --- Part 2: component-level render coverage, real React SSR -----------------
// Uses synthetic fixtures (not the live payloads above) so each scenario is
// isolated and deterministic — matching tests/report-self-prior-submission-
// visibility.test.mjs's own Part 2 convention.

function baseReport(overrides = {}) {
  return {
    version: 11,
    id: 1,
    submissionId: "sub-hmvis-1",
    title: "hmvis-fixture.pdf",
    author: "",
    assignment: "",
    created: new Date().toISOString(),
    score: 0,
    archiveScore: 0,
    wordCount: 10000,
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
    matchedWordCount: 30,
    sources: [],
    repeats: [],
    text: "fixture text not used by OverviewReport directly",
    ...overrides,
  };
}

function unified(overrides = {}) {
  return {
    version: "unified-similarity-v1",
    wordCount: 10000,
    unifiedScore: 100,
    uniqueMatchedWords: 9895,
    archiveOnlyWords: 30,
    liveAcademicOnlyWords: 0,
    previousUploadOnlyWords: 9865,
    overlapWords: 0,
    selfExcludedWords: 0,
    unknownExcludedWords: 0,
    contributions: [],
    ...overrides,
  };
}

const CORPUS_SOURCE_MATCH = {
  status: "MATCHED",
  computedAt: new Date().toISOString(),
  matcherVersion: "user-submission-match-v1",
  fingerprintVersion: "corpus-shingle-v1",
  canonicalizationVersion: "canonical-text-v1",
  matches: [
    {
      relationshipType: "TURNITPLUS_CORPUS_SOURCE",
      matchedRepresentationId: "rep-hmvis-should-not-leak",
      matchType: "EXACT_CANONICAL_MATCH",
      containment: 1,
      matchedWordCount: 9865,
      passageCount: 1,
      longestMatchWords: 9865,
      passages: [{ submittedText: "a bounded excerpt of the current document only", submittedWordStart: 0, submittedWordEnd: 9864, matchedWordCount: 9865 }],
      historicalSubmissionCount: 0,
    },
  ],
};

function render(report) {
  return renderToStaticMarkup(React.createElement(OverviewReport, { report }));
}

test("RENDER (admin visibility): with historicalSubmissionMatch present, OverviewReport shows the full breakdown and the historical-match section", () => {
  // Task A correction: viewerIsAdmin is the explicit authorization signal —
  // historicalSubmissionMatch's own presence no longer doubles as one (see
  // tests below proving the two are independent).
  const html = render(baseReport({ viewerIsAdmin: true, historicalSubmissionMatch: CORPUS_SOURCE_MATCH, unifiedSimilarity: unified() }));
  assert.match(html, /<span>100%<\/span> TurnitPlus Similarity/, "the aggregate score must render");
  assert.match(html, /9,865 words? from an eligible previous TurnitPlus submission/, "the admin-visible breakdown must name the source type");
  assert.match(html, /Previously submitted content/);
  assert.match(html, /matches a TurnitPlus corpus reference source/);
});

test("RENDER (ordinary-user omission from HTML): with historicalSubmissionMatch absent — exactly what the server now sends an ordinary viewer — the breakdown wording, exclusion note, and historical-match section all disappear, while the aggregate score is untouched", () => {
  const html = render(baseReport({ unifiedSimilarity: unified() }));
  assert.match(html, /<span>100%<\/span> TurnitPlus Similarity/, "REQUIRED: the aggregate score must still render immediately — omitting historicalSubmissionMatch must never affect unifiedSimilarity's own score");
  assert.doesNotMatch(html, /previous TurnitPlus submission/i, "must never reveal the 'previous submission' concept to a non-admin");
  assert.doesNotMatch(html, /corpus reference source/i, "must never reveal the 'corpus reference' concept to a non-admin");
  assert.doesNotMatch(html, /Previously submitted content/);
  assert.doesNotMatch(html, /historical-match-block/, "the section must be structurally absent, not merely visually hidden");
  assert.doesNotMatch(html, /rep-hmvis-should-not-leak/, "no internal representation id may appear when this field is absent");
});

test("RENDER: the SELF/UNKNOWN exclusion note is also admin-only — present when authorized, absent otherwise, even though the excluded-word counts themselves live on unifiedSimilarity", () => {
  const withMatch = render(baseReport({
    viewerIsAdmin: true,
    historicalSubmissionMatch: CORPUS_SOURCE_MATCH,
    unifiedSimilarity: unified({ selfExcludedWords: 40, previousUploadOnlyWords: 0 }),
  }));
  assert.match(withMatch, /came from your own earlier TurnitPlus submission and were excluded/);

  const withoutMatch = render(baseReport({
    unifiedSimilarity: unified({ selfExcludedWords: 40, previousUploadOnlyWords: 0 }),
  }));
  assert.doesNotMatch(withoutMatch, /came from your own earlier TurnitPlus submission/, "the exclusion note must not render for a non-admin even though selfExcludedWords is a real, nonzero unifiedSimilarity field");
});

test("RENDER: a non-admin still sees generic matched-word evidence — the headline's total matched-word count and the UnifiedSimilaritySection's own explanation both still render, but with fully generic wording that names no specific source type", () => {
  const html = render(baseReport({ unifiedSimilarity: unified() }));
  assert.match(html, /TurnitPlus found [\d,]+ matched words across identified sources/, "the generic total-matched-word sentence must still render");
  assert.match(html, /Combines matches identified across every reference source TurnitPlus checks into one result\./, "a non-admin gets a fully generic explanation — no archive/academic/previous-submission source types named");
  assert.doesNotMatch(html, /eligible previous TurnitPlus submissions? into one result/, "the detailed, source-naming version of this sentence must not render for a non-admin");
});

test("RENDER: archive-only and live-academic breakdown items are ALSO withheld from a non-admin, not selectively kept — avoids a partial breakdown that could itself imply a hidden category", () => {
  const html = render(baseReport({
    unifiedSimilarity: unified({ archiveOnlyWords: 30, liveAcademicOnlyWords: 20, previousUploadOnlyWords: 0, uniqueMatchedWords: 50 }),
  }));
  assert.doesNotMatch(html, /TurnitPlus&#x27;s own reference material/, "even the non-sensitive archive-only breakdown item must not render alone once historicalSubmissionMatch is absent — an all-or-nothing gate on the whole breakdown line");
  assert.doesNotMatch(html, /verified external academic sources\b.*word/i);
});

test("RENDER: UnifiedSimilaritySection rendered directly (not just via OverviewReport) shows the same admin/non-admin split", () => {
  const withMatch = renderToStaticMarkup(React.createElement(UnifiedSimilaritySection, { report: baseReport({ viewerIsAdmin: true, historicalSubmissionMatch: CORPUS_SOURCE_MATCH, unifiedSimilarity: unified() }) }));
  assert.match(withMatch, /eligible previous TurnitPlus submission/);

  const withoutMatch = renderToStaticMarkup(React.createElement(UnifiedSimilaritySection, { report: baseReport({ unifiedSimilarity: unified() }) }));
  assert.doesNotMatch(withoutMatch, /eligible previous TurnitPlus submission/);
  assert.match(withoutMatch, /<span>100%<\/span> TurnitPlus Similarity/, "the section itself still renders its own aggregate headline unconditionally");
});

test("AUTHORIZATION (Task A correction): an ordinary user (viewerIsAdmin false/absent) with a real historicalSubmissionMatch present still does not receive the detailed source-breakdown UI", () => {
  // historicalSubmissionMatch itself is only ever attached server-side for
  // an admin session (see app/api/reports/[id]/route.ts's own gate) — but
  // the RENDER layer must not use its mere presence as a second, implicit
  // authorization check. This fixture simulates a hypothetical/legacy
  // payload shape where the two have drifted apart, proving the render
  // layer genuinely reads viewerIsAdmin and nothing else.
  const html = render(baseReport({ historicalSubmissionMatch: CORPUS_SOURCE_MATCH, unifiedSimilarity: unified() }));
  assert.doesNotMatch(html, /eligible previous TurnitPlus submission/, "REQUIRED: detailed breakdown wording must not leak just because historicalSubmissionMatch is present");
  assert.doesNotMatch(html, /TurnitPlus&#x27;s own reference material/);
  assert.match(html, /<span>100%<\/span> TurnitPlus Similarity/, "the aggregate score is unaffected");
});

test("AUTHORIZATION (Task A correction): an authorized admin (viewerIsAdmin true) WITHOUT any historicalSubmissionMatch still receives the detailed source-breakdown UI — authorization does not depend on a match existing", () => {
  const html = render(baseReport({ viewerIsAdmin: true, unifiedSimilarity: unified({ archiveOnlyWords: 50, previousUploadOnlyWords: 0, liveAcademicOnlyWords: 0, uniqueMatchedWords: 50 }) }));
  assert.match(html, /TurnitPlus&#x27;s own reference material/, "REQUIRED: an authorized admin sees the detailed breakdown even for a report with no historical match at all");
});

test("AUTHORIZATION (Task A correction): changing historicalSubmissionMatch presence, with viewerIsAdmin held constant, never changes whether the detailed breakdown renders", () => {
  const adminNoMatch = render(baseReport({ viewerIsAdmin: true, unifiedSimilarity: unified({ archiveOnlyWords: 50, previousUploadOnlyWords: 0, liveAcademicOnlyWords: 0, uniqueMatchedWords: 50 }) }));
  const adminWithMatch = render(baseReport({ viewerIsAdmin: true, historicalSubmissionMatch: CORPUS_SOURCE_MATCH, unifiedSimilarity: unified({ archiveOnlyWords: 50, previousUploadOnlyWords: 0, liveAcademicOnlyWords: 0, uniqueMatchedWords: 50 }) }));
  assert.match(adminNoMatch, /TurnitPlus&#x27;s own reference material/, "authorized admin, no match: breakdown still renders");
  assert.match(adminWithMatch, /TurnitPlus&#x27;s own reference material/, "authorized admin, with match: breakdown still renders identically");

  const ordinaryNoMatch = render(baseReport({ unifiedSimilarity: unified({ archiveOnlyWords: 50, previousUploadOnlyWords: 0, liveAcademicOnlyWords: 0, uniqueMatchedWords: 50 }) }));
  const ordinaryWithMatch = render(baseReport({ historicalSubmissionMatch: CORPUS_SOURCE_MATCH, unifiedSimilarity: unified({ archiveOnlyWords: 50, previousUploadOnlyWords: 0, liveAcademicOnlyWords: 0, uniqueMatchedWords: 50 }) }));
  assert.doesNotMatch(ordinaryNoMatch, /TurnitPlus&#x27;s own reference material/, "ordinary, no match: breakdown absent");
  assert.doesNotMatch(ordinaryWithMatch, /TurnitPlus&#x27;s own reference material/, "ordinary, with match: breakdown STILL absent — historicalSubmissionMatch presence alone never grants authorization");
});
