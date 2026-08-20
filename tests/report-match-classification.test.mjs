import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest } from "../lib/rate-limit.js";
import { classifyReportMatches } from "../lib/report-classification.ts";

// Phase D: connects the existing SELF/PRIOR_SUBMISSION classification
// (lib/document-family.ts, lib/document-relationship.ts — Phases B/C) to the
// saved-report result via lib/report-classification.ts. These are the 8
// required regression scenarios, exercised end-to-end through the real
// POST /api/reports (save) and GET /api/reports/[id] (read + enrich) routes
// — not just the classification function in isolation — so this also proves
// the wiring itself, not only the underlying logic (already unit-tested in
// tests/document-family.test.mjs and tests/document-relationship.test.mjs).

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_report_match_classification.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);

// Every pair below was verified empirically (pairwise shingle containment
// checked across the full set, in a throwaway scratch script) before being
// written here: only T2_BASE/T2_REVISED (containment 0.833) and
// T4_BASE/T4_REVISED (containment 0.882) share any content; every other
// pair shares zero shingles, so no two tests in this file can accidentally
// influence each other's family resolution.
const TEXT = {
  T1: "Anthropologists documenting traditional weaving techniques among artisan communities recorded detailed variations in loom construction across three neighboring valleys. Interviews with senior weavers revealed knowledge transmission patterns spanning multiple generations within extended family workshops. These findings contribute to a broader archive of endangered craft methodologies facing gradual decline.",
  T2_BASE: "Nutritional scientists evaluating dietary intervention programs among adolescent populations measured statistically significant improvements in micronutrient status after six months. Participants receiving fortified supplements alongside educational counseling showed markedly better adherence than those receiving supplements alone. Program coordinators recommended extending the counseling component to future intervention designs.",
  T2_REVISED: "Nutritional scientists evaluating dietary intervention programs among adolescent populations measured statistically significant improvements in micronutrient status after eight months. Participants receiving fortified supplements alongside educational counseling showed markedly better adherence than those receiving supplements alone. Program coordinators recommended extending the counseling component to future prevention designs.",
  T3: "Geologists surveying fault displacement along an active rift valley measured cumulative offset patterns using differential satellite positioning across multiple survey campaigns. Comparative analysis against historical seismic records suggested a recurrence interval shorter than previously estimated for major rupture events. These findings have direct implications for regional infrastructure seismic design standards.",
  T4_BASE: "Behavioral economists studying consumer response to default enrollment options in retirement savings plans observed substantially higher participation rates under automatic enrollment compared to opt-in designs. Follow-up surveys indicated that most participants remained at the default contribution rate rather than actively adjusting it. Policy analysts cited these findings when evaluating proposed pension reform legislation.",
  T4_REVISED: "Behavioral economists studying consumer response to default enrollment options in retirement savings plans observed substantially higher participation rates under automatic enrollment compared to opt-in designs. Follow-up surveys indicated that most participants remained at the default contribution level rather than actively adjusting it. Policy analysts cited these findings when evaluating proposed pension reform proposals.",
  T5: "Meteorologists analyzing convective storm development over coastal plains identified a recurring afternoon pattern linked to sea-breeze boundary interactions. High-resolution radar composites captured rapid cell formation along these convergence zones during summer months. Forecasters incorporated the pattern into updated short-range severe weather guidance products.",
  T6: "Textile engineers testing moisture-wicking fabric blends under simulated athletic conditions measured evaporation rates across several synthetic fiber compositions. Laboratory trials combined controlled humidity chambers with continuous weight-loss measurement to quantify performance differences. Manufacturing partners used the results to prioritize fiber blends for the next product line.",
  T7: "Ethnomusicologists cataloguing regional folk instrument construction documented distinct tuning conventions passed down within isolated mountain communities. Recorded interviews with instrument makers captured construction techniques rarely described in existing written sources. The resulting archive preserves practical knowledge at risk of being lost within a generation.",
  T8: "Hydrologists modeling groundwater recharge rates across a semi-arid basin incorporated decades of well-monitoring data alongside updated precipitation records. Simulation results indicated recharge rates lower than earlier regional estimates had assumed. Water management authorities used the revised figures to reassess long-term extraction permits.",
};

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

let counter = 0;
function nextId() {
  counter += 1;
  return `classify-report-${counter}`;
}

async function signup(email, deviceKey) {
  await resetAuthRateForTest(`classify-signup-${email}`);
  const req = new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `classify-signup-${email}` },
    body: JSON.stringify({ email, password: "classification-password-1", username: email.split("@")[0], deviceKey }),
  });
  const res = await signupRoute.POST(req);
  // Privacy hardening: grants cross-account corpus-reuse consent immediately
  // so this file's existing scenarios (written before consent-gating
  // existed) continue to exercise the real indexDocumentSubmissionIntoCorpus
  // path via the live route, unchanged — see
  // tests/report-privacy-consent.test.mjs for the dedicated consent on/off
  // behavior this gate itself needs.
  await setupClient.execute({ sql: "UPDATE users SET corpus_reuse_consented_at = CURRENT_TIMESTAMP WHERE email = ?", args: [email] });
  return { res, cookie: extractCookie(res) };
}

// Builds a realistic saved-report payload, including fake archive/verified-
// source fields (score, archiveScore, sources) so tests 6-8 can prove those
// fields survive read-time enrichment completely unchanged.
function buildPayload({ id, title, text, archiveScore = 0, sources = [] }) {
  return {
    version: 11,
    id,
    submissionId: `sub-${id}`,
    title,
    author: "Guest submission",
    assignment: "Personal similarity check",
    created: new Date().toISOString(),
    score: archiveScore,
    archiveScore,
    wordCount: text.split(" ").length,
    characterCount: text.length,
    pageCount: 1,
    fileSize: "1.0 KB",
    databaseSize: 230,
    corpusVersion: "archive-v4-230-test",
    scoreBand: archiveScore >= 16 ? "High" : archiveScore >= 6 ? "Moderate" : "Low",
    riskStatus: "Lower",
    riskTarget: 0.5,
    riskCutoff: 16,
    riskCalibration: { auc: 0.9, precision: 0.8, recall: 0.7, sampleSize: 100 },
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
    sources,
    repeats: [],
    text,
  };
}

async function postReport({ deviceKey, id, title, text, cookie, archiveScore, sources }) {
  const rateKey = `classify-post-${id}`;
  await resetRateForTest(rateKey);
  const payload = buildPayload({ id, title, text, archiveScore, sources });
  const headers = { "content-type": "application/json", "x-forwarded-for": rateKey };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  const req = new Request("http://localhost/api/reports", {
    method: "POST",
    headers,
    body: JSON.stringify({
      deviceKey,
      id,
      submissionId: payload.submissionId,
      title,
      createdAt: payload.created,
      wordCount: payload.wordCount,
      archiveScore: payload.archiveScore,
      scoreBand: payload.scoreBand,
      aiScore: null,
      aiTone: null,
      payload,
    }),
  });
  const res = await reportsRoute.POST(req);
  assert.equal(res.status, 200, `save must succeed for ${id}`);
  return payload;
}

async function getReport({ deviceKey, id, cookie }) {
  const rateKey = `classify-get-${id}`;
  await resetRateForTest(rateKey);
  const headers = { "x-forwarded-for": rateKey };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { headers });
  const res = await reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200, `fetch must succeed for ${id}`);
  const body = await res.json();
  return body.payload;
}

// --- TEST 1: same account reupload (exact) -----------------------------------

test("TEST 1 — same account reupload: second submission classifies SELF, no PRIOR_SUBMISSION, verified similarity untouched", async () => {
  const email = "classify-test1@example.com";
  const { cookie } = await signup(email, "classify-device-1");

  await postReport({ deviceKey: "classify-device-1", id: nextId(), title: "essay.pdf", text: TEXT.T1, cookie });
  const second = await postReport({ deviceKey: "classify-device-1", id: nextId(), title: "essay-copy.pdf", text: TEXT.T1, cookie });

  const enriched = await getReport({ deviceKey: "classify-device-1", id: second.id, cookie });
  assert.ok(enriched.matchClassification, "matchClassification must be present");
  assert.equal(enriched.matchClassification.selfMatchPercent, 100, "an exact reupload by the same account must classify SELF at 100%");
  assert.equal(enriched.matchClassification.priorSubmissionPercent, null, "no PRIOR_SUBMISSION result must appear");
  assert.equal(enriched.score, second.score, "verified similarity (score) must be completely unchanged by classification");
  assert.equal(enriched.archiveScore, second.archiveScore);
});

// --- TEST 2: same account revision -------------------------------------------

test("TEST 2 — same account revision: same family, classified SELF, does not increase verified similarity", async () => {
  const email = "classify-test2@example.com";
  const { cookie } = await signup(email, "classify-device-2");

  await postReport({ deviceKey: "classify-device-2", id: nextId(), title: "draft.pdf", text: TEXT.T2_BASE, cookie });
  const revised = await postReport({ deviceKey: "classify-device-2", id: nextId(), title: "final.pdf", text: TEXT.T2_REVISED, cookie });

  const enriched = await getReport({ deviceKey: "classify-device-2", id: revised.id, cookie });
  assert.ok(enriched.matchClassification.selfMatchPercent > 0, "a strong revision by the same account must classify SELF with a positive overlap");
  assert.equal(enriched.matchClassification.priorSubmissionPercent, null);
  assert.equal(enriched.score, revised.score, "verified similarity must not increase because of the SELF match");
});

// --- TEST 3: cross-account identical -----------------------------------------

test("TEST 3 — cross-account identical: Account B's result is PRIOR_SUBMISSION, no Account A identity exposed", async () => {
  const ownerEmail = "classify-test3-owner@example.com";
  const strangerEmail = "classify-test3-stranger@example.com";
  const { cookie: ownerCookie } = await signup(ownerEmail, "classify-device-3-owner");
  const { cookie: strangerCookie } = await signup(strangerEmail, "classify-device-3-stranger");

  await postReport({ deviceKey: "classify-device-3-owner", id: nextId(), title: "paper.pdf", text: TEXT.T3, cookie: ownerCookie });
  const strangerReport = await postReport({ deviceKey: "classify-device-3-stranger", id: nextId(), title: "paper-copy.pdf", text: TEXT.T3, cookie: strangerCookie });

  const enriched = await getReport({ deviceKey: "classify-device-3-stranger", id: strangerReport.id, cookie: strangerCookie });
  assert.equal(enriched.matchClassification.priorSubmissionPercent, 100, "an identical document from a different account must classify PRIOR_SUBMISSION at 100%");
  assert.equal(enriched.matchClassification.selfMatchPercent, null, "no SELF result must appear for a different account");
  assert.equal(enriched.score, strangerReport.score, "verified similarity must not increase because of the PRIOR_SUBMISSION match");

  // Security: the response must not contain the owning account's id, email, or username anywhere.
  const serialized = JSON.stringify(enriched);
  const ownerUserRow = await setupClient.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [ownerEmail] });
  assert.ok(!serialized.includes(ownerUserRow.rows[0].id), "owner's account id must never appear in the response");
  assert.ok(!serialized.includes(ownerEmail), "owner's email must never appear in the response");
});

// --- TEST 4: cross-account revision ------------------------------------------

test("TEST 4 — cross-account revision: PRIOR_SUBMISSION, separate reporting, zero contribution to verified similarity", async () => {
  const ownerEmail = "classify-test4-owner@example.com";
  const strangerEmail = "classify-test4-stranger@example.com";
  const { cookie: ownerCookie } = await signup(ownerEmail, "classify-device-4-owner");
  const { cookie: strangerCookie } = await signup(strangerEmail, "classify-device-4-stranger");

  await postReport({ deviceKey: "classify-device-4-owner", id: nextId(), title: "original.pdf", text: TEXT.T4_BASE, cookie: ownerCookie });
  const strangerReport = await postReport({ deviceKey: "classify-device-4-stranger", id: nextId(), title: "revised.pdf", text: TEXT.T4_REVISED, cookie: strangerCookie });

  const enriched = await getReport({ deviceKey: "classify-device-4-stranger", id: strangerReport.id, cookie: strangerCookie });
  assert.ok(enriched.matchClassification.priorSubmissionPercent > 0, "a strong revision by a different account must classify PRIOR_SUBMISSION with a positive overlap");
  assert.equal(enriched.matchClassification.selfMatchPercent, null);
  assert.equal(enriched.score, strangerReport.score, "verified similarity must not increase because of the PRIOR_SUBMISSION match");
});

// --- TEST 5: unrelated document -----------------------------------------------

test("TEST 5 — unrelated document: no SELF, no PRIOR_SUBMISSION, existing similarity behavior unchanged", async () => {
  const email = "classify-test5@example.com";
  const { cookie } = await signup(email, "classify-device-5");

  const report = await postReport({ deviceKey: "classify-device-5", id: nextId(), title: "unrelated.pdf", text: TEXT.T5, cookie, archiveScore: 12, sources: [{ name: "Some Archive Source", type: "Publication", percent: 12, matches: 2, phrases: ["some phrase"], color: "#d7263d" }] });

  const enriched = await getReport({ deviceKey: "classify-device-5", id: report.id, cookie });
  assert.equal(enriched.matchClassification, undefined, "an unrelated document must carry no classification field at all, not an object with null fields");
  assert.equal(enriched.score, 12, "the existing archive similarity score must be completely unaffected");
  assert.deepEqual(enriched.sources, report.sources, "existing archive sources must be completely unaffected");
});

// --- TEST 6: existing verified/archive match continues to work unchanged ----

test("TEST 6 — a document matching the existing archive continues to produce the same verified similarity result; the classification layer does not break the archive matcher", async () => {
  const email = "classify-test6@example.com";
  const { cookie } = await signup(email, "classify-device-6");

  const archiveSources = [
    { name: "Archive Document A", type: "Publication", percent: 22, matches: 3, matchedWords: 140, phrases: ["a distinctive matched phrase", "another matched phrase here"], color: "#d7263d" },
  ];
  const report = await postReport({ deviceKey: "classify-device-6", id: nextId(), title: "archive-match.pdf", text: TEXT.T6, cookie, archiveScore: 22, sources: archiveSources });

  const enriched = await getReport({ deviceKey: "classify-device-6", id: report.id, cookie });
  // No family relationships exist for this document at all (it is not
  // related to anything else saved in this suite), so classification must
  // be entirely absent (undefined, not an object with null fields — see
  // lib/report-classification.ts's comment on why that distinction matters
  // for byte-for-byte round-tripping) — but every archive-derived field must
  // be byte-for-byte identical to what was saved.
  assert.equal(enriched.matchClassification, undefined);
  assert.equal(enriched.score, 22);
  assert.equal(enriched.archiveScore, 22);
  assert.equal(enriched.scoreBand, "High");
  assert.deepEqual(enriched.sources, archiveSources);
  assert.deepEqual(enriched.features, report.features);
  assert.deepEqual(enriched.riskCalibration, report.riskCalibration);
});

// --- TEST 7: SELF + VERIFIED_SOURCE mixed -------------------------------------

test("TEST 7 — SELF and an existing archive match both present: SELF is excluded from nothing it was never part of, the archive match remains in the main calculation, and the two are not mixed", async () => {
  const email = "classify-test7@example.com";
  const { cookie } = await signup(email, "classify-device-7");

  const archiveSources = [
    { name: "Archive Document B", type: "Publication", percent: 9, matches: 1, matchedWords: 40, phrases: ["a separate archive phrase"], color: "#d7263d" },
  ];

  await postReport({ deviceKey: "classify-device-7", id: nextId(), title: "history-a.pdf", text: TEXT.T7, cookie });
  const second = await postReport({
    deviceKey: "classify-device-7",
    id: nextId(),
    title: "history-b.pdf",
    text: TEXT.T7,
    cookie,
    archiveScore: 9,
    sources: archiveSources,
  });

  const enriched = await getReport({ deviceKey: "classify-device-7", id: second.id, cookie });
  assert.equal(enriched.matchClassification.selfMatchPercent, 100, "SELF must still be detected alongside an unrelated archive match");
  assert.equal(enriched.matchClassification.priorSubmissionPercent, null);
  // The archive/verified-source result must remain exactly as saved — SELF
  // must never be added into, subtracted from, or otherwise mixed with it.
  assert.equal(enriched.score, 9, "the archive-derived score must remain in the main calculation, untouched by the SELF classification");
  assert.deepEqual(enriched.sources, archiveSources, "archive sources must not be altered or merged with SELF data");
});

// --- TEST 8: PRIOR_SUBMISSION + VERIFIED_SOURCE mixed -------------------------

test("TEST 8 — PRIOR_SUBMISSION and an existing archive match both present: PRIOR_SUBMISSION is reported separately and the archive match remains in the main calculation", async () => {
  const ownerEmail = "classify-test8-owner@example.com";
  const strangerEmail = "classify-test8-stranger@example.com";
  const { cookie: ownerCookie } = await signup(ownerEmail, "classify-device-8-owner");
  const { cookie: strangerCookie } = await signup(strangerEmail, "classify-device-8-stranger");

  const archiveSources = [
    { name: "Archive Document C", type: "Publication", percent: 14, matches: 2, matchedWords: 70, phrases: ["yet another archive phrase"], color: "#d7263d" },
  ];

  await postReport({ deviceKey: "classify-device-8-owner", id: nextId(), title: "shared-a.pdf", text: TEXT.T8, cookie: ownerCookie });
  const strangerReport = await postReport({
    deviceKey: "classify-device-8-stranger",
    id: nextId(),
    title: "shared-b.pdf",
    text: TEXT.T8,
    cookie: strangerCookie,
    archiveScore: 14,
    sources: archiveSources,
  });

  const enriched = await getReport({ deviceKey: "classify-device-8-stranger", id: strangerReport.id, cookie: strangerCookie });
  assert.equal(enriched.matchClassification.priorSubmissionPercent, 100);
  assert.equal(enriched.matchClassification.selfMatchPercent, null);
  assert.equal(enriched.score, 14, "the archive-derived score must remain in the main calculation, untouched by the PRIOR_SUBMISSION classification");
  assert.deepEqual(enriched.sources, archiveSources);
});

// --- Additional direct unit coverage of lib/report-classification.ts --------

test("classifyReportMatches returns undefined (not an object with null fields) for text with no matching document identity at all", async () => {
  const result = await classifyReportMatches(setupClient, { rawText: "Text that was never submitted through any route in this test file.", accountId: "nonexistent-account" });
  assert.equal(result, undefined);
});

test("classifyReportMatches never throws for an anonymous (null) account with no history, and returns undefined", async () => {
  const result = await classifyReportMatches(setupClient, { rawText: TEXT.T5, accountId: null });
  assert.equal(result, undefined);
});

test.after(() => {
  setupClient.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
