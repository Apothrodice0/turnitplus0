// Phase 6.5 real-world validation matrix — NOT part of the shipped app,
// NOT a committed test file. Drives the REAL report generation/API path
// (POST /api/reports, GET /api/reports/[id], POST /api/academic-evidence,
// POST /api/auth/signup) exactly as tests/*.test.mjs already do, combined
// with the REAL archive matcher (scripts/validation/real-archive-analyze.mjs,
// running against the real shipped 230-document packed index) and REAL live
// calls to OpenAIRE + Europe PMC (lib/academic-evidence-integration.ts) for
// text that is genuinely, verifiably matchable (real open-access abstracts
// fetched live from Europe PMC — see fixtures.mjs). Produces
// scripts/validation/phase6-5-results.json for the final report.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../../lib/ingest.ts";
import * as reportsRoute from "../../app/api/reports/route.ts";
import * as reportIdRoute from "../../app/api/reports/[id]/route.ts";
import * as signupRoute from "../../app/api/auth/signup/route.ts";
import * as academicEvidenceRoute from "../../app/api/academic-evidence/route.ts";
import { resetRateForTest, resetAuthRateForTest } from "../../lib/rate-limit.ts";
import { tokens } from "../../lib/similarity-core.ts";
import { getExternalAcademicEvidence } from "../../lib/academic-evidence-integration.ts";
import { realArchiveAnalyze, REAL_ARCHIVE_META } from "./real-archive-analyze.mjs";
import {
  REFERENCE_TEXT, SMALL_EXCERPT, MEDIUM_EXCERPT, LARGE_EXCERPT, paddedSubmission,
  KERNZA_ABSTRACT, KERNZA_DOI, KERNZA_PMCID, CLATHRIN_ABSTRACT, CLATHRIN_DOI, CLATHRIN_PMCID,
  ORIGINAL_TEXT,
} from "./fixtures.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "phase6_5_validation.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

const results = [];
let counter = 0;
function nextId() { counter += 1; return `p65-report-${counter}-${Date.now()}`; }

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, deviceKey) {
  resetAuthRateForTest("p65-signup-" + email);
  const req = new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "p65-signup-" + email },
    body: JSON.stringify({ email, password: "p65-password-1", username: email.split("@")[0], deviceKey }),
  });
  const res = await signupRoute.POST(req);
  assert.equal(res.status, 201, `signup must succeed for ${email}`);
  return { cookie: extractCookie(res) };
}

async function fetchLiveEvidence(text, tag) {
  resetRateForTest("p65-live-" + tag);
  const req = new Request("http://localhost/api/academic-evidence", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "p65-live-" + tag },
    body: JSON.stringify({ text }),
  });
  const start = Date.now();
  const res = await academicEvidenceRoute.POST(req);
  const elapsedMs = Date.now() - start;
  const body = await res.json();
  return { evidence: body.evidence ?? [], stats: body.stats ?? null, elapsedMs, status: res.status };
}

async function postReport(deviceKey, { cookie, id, title, text, score = 0, archiveScore = 0, archiveMatchedPositions, externalAcademicEvidence, wordCountOverride } = {}) {
  resetRateForTest("p65-post-" + deviceKey);
  const reportId = id ?? nextId();
  const headers = { "content-type": "application/json", "x-forwarded-for": "p65-post-" + deviceKey };
  if (cookie) headers["cookie"] = `tp_session_v1=${cookie}`;
  const wordCount = wordCountOverride ?? tokens(text).length;
  const payload = {
    version: 11, id: Date.now() + Math.floor(Math.random() * 1_000_000), submissionId: "sub-" + reportId, title,
    author: "", assignment: "", created: new Date().toISOString(), score, archiveScore, text, wordCount,
    characterCount: text.length, pageCount: 1, fileSize: "1 KB", databaseSize: 230, corpusVersion: "test", scoreBand: "Low",
    ...(archiveMatchedPositions !== undefined ? { archiveMatchedPositions } : {}),
    ...(externalAcademicEvidence !== undefined ? { externalAcademicEvidence } : {}),
  };
  const req = new Request("http://localhost/api/reports", {
    method: "POST",
    headers,
    body: JSON.stringify({
      deviceKey, id: reportId, submissionId: payload.submissionId, title, createdAt: payload.created,
      wordCount, archiveScore, scoreBand: "Low", aiScore: null, aiTone: null, payload,
    }),
  });
  const res = await reportsRoute.POST(req);
  assert.equal(res.status, 200, `save must succeed for report ${reportId}`);
  return { id: reportId, payload };
}

async function getReport(id, { deviceKey, cookie } = {}) {
  resetRateForTest("p65-get-" + (deviceKey ?? cookie ?? "x"));
  const headers = { "x-forwarded-for": "p65-get-" + (deviceKey ?? cookie ?? "x") };
  if (cookie) headers["cookie"] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { headers });
  const res = await reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200, `GET must succeed for report ${id}`);
  const body = await res.json();
  return body.payload;
}

function record(caseId, description, entry) {
  results.push({ caseId, description, ...entry });
  console.log(`\n=== ${caseId}: ${description} ===`);
  console.log(JSON.stringify(entry, null, 2));
}

// ---------------------------------------------------------------------------
// CASE A — ORIGINAL: real archive matcher (real 230-doc index) + real live
// search, both against genuinely original, never-published text.
// ---------------------------------------------------------------------------
{
  const archiveResult = realArchiveAnalyze(ORIGINAL_TEXT);
  const live = await fetchLiveEvidence(ORIGINAL_TEXT, "case-a");
  const deviceKey = "p65-device-a";
  const { id } = await postReport(deviceKey, {
    title: "case-a-original.txt", text: ORIGINAL_TEXT, score: archiveResult.score, archiveScore: archiveResult.score,
    archiveMatchedPositions: archiveResult.archiveMatchedPositions, externalAcademicEvidence: live.evidence.length > 0 ? live.evidence : undefined,
  });
  const report = await getReport(id, { deviceKey });
  record("A", "ORIGINAL — no meaningful source overlap", {
    realArchiveMatchedWordCount: archiveResult.matchedWordCount,
    realArchiveScore: archiveResult.score,
    realLiveEvidenceCount: live.evidence.length,
    realLiveStats: live.stats,
    wordCount: report.wordCount,
    oldScore: report.score,
    unifiedSimilarity: report.unifiedSimilarity,
  });
}

// ---------------------------------------------------------------------------
// CASES B-E — EXACT SMALL/MEDIUM/LARGE/FULL: real prior-submission matcher
// (lib/user-submission-matching.ts) against increasing verbatim-copied
// coverage of the SAME original reference document. Substituted for the
// archive population because the real archive's underlying source text is
// deliberately not included in this downloadable checkout (see README) —
// disclosed explicitly in the final report. The merge/scoring mechanism
// computeUnifiedSimilarity applies is identical regardless of which source
// population produced the positions (already proven by
// tests/unified-similarity.test.mjs's own archive-only case), so this
// substitution validates the genuinely untested part: real matcher output
// flowing through the real API into unifiedSimilarity, at growing scale.
// ---------------------------------------------------------------------------
{
  const { cookie: cookieP } = await signup("p65-source-p@example.test", "p65-device-p");
  await postReport("p65-device-p", { cookie: cookieP, title: "reference-source.txt", text: REFERENCE_TEXT, archiveMatchedPositions: [] });

  const excerptCases = [
    ["B", "EXACT SMALL — small exact copied passage", SMALL_EXCERPT, "small"],
    ["C", "EXACT MEDIUM — medium copied passage", MEDIUM_EXCERPT, "medium"],
    ["D", "EXACT LARGE — large copied portion", LARGE_EXCERPT, "large"],
  ];
  for (const [caseId, description, excerpt, label] of excerptCases) {
    const email = `p65-excerpt-${label}@example.test`;
    const deviceKey = `p65-device-${label}`;
    const { cookie } = await signup(email, deviceKey);
    const text = paddedSubmission(excerpt, label.toUpperCase());
    const archiveResult = realArchiveAnalyze(text);
    const { id } = await postReport(deviceKey, {
      cookie, title: `${label}-excerpt.txt`, text, score: archiveResult.score, archiveScore: archiveResult.score,
      archiveMatchedPositions: archiveResult.archiveMatchedPositions,
    });
    const report = await getReport(id, { cookie });
    record(caseId, description, {
      excerptWordCount: excerpt.split(/\s+/).filter(Boolean).length,
      wordCount: report.wordCount,
      realArchiveMatchedWordCount: archiveResult.matchedWordCount,
      historicalSubmissionMatch: report.historicalSubmissionMatch,
      oldScore: report.score,
      unifiedSimilarity: report.unifiedSimilarity,
    });
  }

  // E — EXACT FULL: verbatim resubmission of the entire reference document
  // by a different account.
  const { cookie: cookieE } = await signup("p65-excerpt-full@example.test", "p65-device-full");
  const archiveResultE = realArchiveAnalyze(REFERENCE_TEXT);
  const { id: idE } = await postReport("p65-device-full", {
    cookie: cookieE, title: "full-copy.txt", text: REFERENCE_TEXT, score: archiveResultE.score, archiveScore: archiveResultE.score,
    archiveMatchedPositions: archiveResultE.archiveMatchedPositions,
  });
  const reportE = await getReport(idE, { cookie: cookieE });
  record("E", "EXACT FULL — essentially complete source reuse", {
    wordCount: reportE.wordCount,
    historicalSubmissionMatch: reportE.historicalSubmissionMatch,
    oldScore: reportE.score,
    unifiedSimilarity: reportE.unifiedSimilarity,
  });
}

// ---------------------------------------------------------------------------
// CASE F — MULTI-SOURCE, DIFFERENT PASSAGES: a real prior-submission match
// (against account P's reference text, from case B-E's setup) at one span,
// plus REAL live academic evidence (fresh Clathrin abstract call) at a
// disjoint span, within the SAME submitted document.
// ---------------------------------------------------------------------------
{
  const { cookie } = await signup("p65-multi-source-f@example.test", "p65-device-f");
  const text = LARGE_EXCERPT + " " + CLATHRIN_ABSTRACT;
  // IMPORTANT DISCOVERED FINDING (see final report): two independently-
  // confirmed-real live sources concatenated into one document (verified
  // directly: LARGE_EXCERPT + CLATHRIN_ABSTRACT, and separately
  // KERNZA_ABSTRACT + CLATHRIN_ABSTRACT alone) both produced ZERO live
  // evidence, even though each source is independently, reliably
  // discoverable alone (case H). Root cause, confirmed by reading
  // lib/academic-search/cache.ts's AcademicSearchBudget: search-query
  // consumption and text-retrieval consumption share ONE 40-unit
  // per-report budget (lib/academic-evidence-integration.ts's
  // PER_REPORT_BUDGET) with no reserved allocation for retrieval. A
  // longer/multi-topic document generates more distinct queries (here:
  // queryCount 23 vs ~16-17 for either topic alone), which can exhaust the
  // shared budget during the search phase and starve the retrieval phase
  // before it can fetch/confirm candidates the search phase DID find
  // (candidatesTextRetrieved fell to 3-4 here, down from the usual 5).
  // This is reported as a discovered issue, not fixed — out of scope for
  // this validation round. To still validate the actual MERGE mechanism
  // (which this case is really about) with real, not fabricated, data,
  // the live portion below reuses the real Clathrin evidence object
  // already captured in case H (same disclosed-construction technique as
  // case M), attached at a genuinely disjoint submitted position from the
  // real, freshly-computed prior-submission match above it.
  const archiveResult = realArchiveAnalyze(text);
  const liveEvidenceCheck = await fetchLiveEvidence(text, "case-f");
  const clathrinStandalone = await fetchLiveEvidence(CLATHRIN_ABSTRACT, "case-f-standalone-clathrin");
  const realClathrinEntry = clathrinStandalone.evidence.find((e) => e.doi === CLATHRIN_DOI);
  const largeExcerptWordCount = LARGE_EXCERPT.split(/\s+/).filter(Boolean).length;
  const remappedEvidence = realClathrinEntry
    ? [{
      ...realClathrinEntry,
      matchedPassages: realClathrinEntry.matchedPassages.map((p) => ({
        ...p,
        submittedWordStart: p.submittedWordStart + largeExcerptWordCount + 1,
        submittedWordEnd: p.submittedWordEnd + largeExcerptWordCount + 1,
      })),
    }]
    : [];
  const { id } = await postReport("p65-device-f", {
    cookie, title: "multi-source-f.txt", text, score: archiveResult.score, archiveScore: archiveResult.score,
    archiveMatchedPositions: archiveResult.archiveMatchedPositions,
    externalAcademicEvidence: remappedEvidence.length > 0 ? remappedEvidence : undefined,
  });
  const report = await getReport(id, { cookie });
  record("F", "MULTI-SOURCE — two genuinely different sources, different submitted positions", {
    wordCount: report.wordCount,
    inSituLiveEvidenceCount: liveEvidenceCheck.evidence.length,
    inSituLiveStats: liveEvidenceCheck.stats,
    note: "live evidence for this case reuses the real Clathrin evidence object captured standalone (case H's own source) and remapped to this document's own disjoint word positions — see the budget-exhaustion finding in the comment above",
    historicalSubmissionMatch: report.historicalSubmissionMatch,
    oldScore: report.score,
    unifiedSimilarity: report.unifiedSimilarity,
  });
}

// ---------------------------------------------------------------------------
// CASE G — SAME-PASSAGE MULTI-SOURCE: a real prior-submission match AND real
// live academic evidence BOTH covering (nearly) the same submitted passage —
// substituted for archive+live for the same reason as B-E (see that block's
// comment); this proves the dedup mechanism with two genuinely different,
// both-real evidence sources on overlapping real positions.
// ---------------------------------------------------------------------------
{
  const { cookie: cookieOwner } = await signup("p65-same-passage-owner@example.test", "p65-device-g-owner");
  await postReport("p65-device-g-owner", { cookie: cookieOwner, title: "kernza-first.txt", text: KERNZA_ABSTRACT, archiveMatchedPositions: [] });

  const { cookie: cookieG } = await signup("p65-same-passage-g@example.test", "p65-device-g");
  const live = await fetchLiveEvidence(KERNZA_ABSTRACT, "case-g");
  const archiveResult = realArchiveAnalyze(KERNZA_ABSTRACT);
  const { id } = await postReport("p65-device-g", {
    cookie: cookieG, title: "kernza-second.txt", text: KERNZA_ABSTRACT, score: archiveResult.score, archiveScore: archiveResult.score,
    archiveMatchedPositions: archiveResult.archiveMatchedPositions,
    externalAcademicEvidence: live.evidence.length > 0 ? live.evidence : undefined,
  });
  const report = await getReport(id, { cookie: cookieG });
  record("G", "SAME-PASSAGE MULTI-SOURCE — real prior-submission + real live evidence on (nearly) the same passage", {
    wordCount: report.wordCount,
    realLiveEvidenceCount: live.evidence.length,
    liveMatchedPassages: live.evidence.flatMap((e) => e.matchedPassages),
    historicalSubmissionMatch: report.historicalSubmissionMatch,
    oldScore: report.score,
    unifiedSimilarity: report.unifiedSimilarity,
  });
}

// ---------------------------------------------------------------------------
// CASE H — LIVE-ONLY: no archive match, no prior submission, real live
// evidence only (fresh real Europe PMC discovery of the Clathrin abstract,
// submitted here for the first time by any account).
// ---------------------------------------------------------------------------
{
  const deviceKey = "p65-device-h";
  const live = await fetchLiveEvidence(CLATHRIN_ABSTRACT, "case-h");
  const archiveResult = realArchiveAnalyze(CLATHRIN_ABSTRACT);
  const { id } = await postReport(deviceKey, {
    title: "clathrin-live-only.txt", text: CLATHRIN_ABSTRACT, score: archiveResult.score, archiveScore: archiveResult.score,
    archiveMatchedPositions: archiveResult.archiveMatchedPositions,
    externalAcademicEvidence: live.evidence.length > 0 ? live.evidence : undefined,
  });
  const report = await getReport(id, { deviceKey });
  record("H", "LIVE-ONLY — archive misses source, live academic search finds it", {
    wordCount: report.wordCount,
    realLiveEvidenceCount: live.evidence.length,
    realLiveEvidence: live.evidence.map((e) => ({ provider: e.provider, doi: e.doi, similarity: e.similarity, matchedPassages: e.matchedPassages })),
    realArchiveMatchedWordCount: archiveResult.matchedWordCount,
    historicalSubmissionMatch: report.historicalSubmissionMatch,
    oldScore: report.score,
    unifiedSimilarity: report.unifiedSimilarity,
  });
}

// ---------------------------------------------------------------------------
// CASE I — ARCHIVE-ONLY (substituted): see B-E's comment on the disclosed
// archive-source-text limitation. This case demonstrates the structural
// "exactly one source populated" behavior using a real prior-submission-only
// match at MEDIUM scale (a fresh account/pair, independent of case C).
// ---------------------------------------------------------------------------
{
  const { cookie: cookieOwner } = await signup("p65-archive-only-owner@example.test", "p65-device-i-owner");
  await postReport("p65-device-i-owner", { cookie: cookieOwner, title: "reference-source-i.txt", text: REFERENCE_TEXT, archiveMatchedPositions: [] });

  const { cookie } = await signup("p65-archive-only-i@example.test", "p65-device-i");
  const text = paddedSubmission(MEDIUM_EXCERPT, "I");
  const archiveResult = realArchiveAnalyze(text);
  const { id } = await postReport("p65-device-i", {
    cookie, title: "single-source-only-i.txt", text, score: archiveResult.score, archiveScore: archiveResult.score,
    archiveMatchedPositions: archiveResult.archiveMatchedPositions,
  });
  const report = await getReport(id, { cookie });
  record("I", "ARCHIVE-ONLY (substituted with prior-submission-only — see disclosed limitation)", {
    wordCount: report.wordCount,
    realArchiveMatchedWordCount: archiveResult.matchedWordCount,
    historicalSubmissionMatch: report.historicalSubmissionMatch,
    oldScore: report.score,
    unifiedSimilarity: report.unifiedSimilarity,
  });
}

// ---------------------------------------------------------------------------
// CASE J — SELF: same account re-submits its own earlier content.
// ---------------------------------------------------------------------------
{
  const { cookie } = await signup("p65-self-j@example.test", "p65-device-j");
  const text = "Phase 6.5 validation SELF case: " + REFERENCE_TEXT;
  await postReport("p65-device-j", { cookie, title: "self-first.txt", text, archiveMatchedPositions: [] });
  const { id: secondId } = await postReport("p65-device-j", { cookie, title: "self-second.txt", text, archiveMatchedPositions: [] });
  const report = await getReport(secondId, { cookie });
  record("J", "SELF — same user's previous submission", {
    wordCount: report.wordCount,
    historicalSubmissionMatch: report.historicalSubmissionMatch,
    oldScore: report.score,
    unifiedSimilarity: report.unifiedSimilarity,
  });
}

// ---------------------------------------------------------------------------
// CASE K — UNKNOWN: an anonymous device submits content an authenticated
// account previously uploaded.
// ---------------------------------------------------------------------------
{
  const { cookie: cookieOwner } = await signup("p65-unknown-owner@example.test", "p65-device-k-owner");
  const text = "Phase 6.5 validation UNKNOWN case: " + REFERENCE_TEXT;
  await postReport("p65-device-k-owner", { cookie: cookieOwner, title: "unknown-owner.txt", text, archiveMatchedPositions: [] });

  const anonDeviceKey = "p65-device-k-anon";
  const { id } = await postReport(anonDeviceKey, { title: "unknown-anon.txt", text, archiveMatchedPositions: [] });
  const report = await getReport(id, { deviceKey: anonDeviceKey });
  record("K", "UNKNOWN — unknown historical relationship (anonymous viewer)", {
    wordCount: report.wordCount,
    historicalSubmissionMatch: report.historicalSubmissionMatch,
    oldScore: report.score,
    unifiedSimilarity: report.unifiedSimilarity,
  });
}

// ---------------------------------------------------------------------------
// CASE L — PRIOR_SUBMISSION: satisfied by cases B-E/G/I above (a different
// account's eligible earlier upload contributes normally) — pointer only,
// no separate report generation needed.
// ---------------------------------------------------------------------------
record("L", "PRIOR_SUBMISSION — see cases B, C, D, E, G, I above (all real PRIOR_SUBMISSION matches that contribute > 0)", { seeAlso: ["B", "C", "D", "E", "G", "I"] });

// ---------------------------------------------------------------------------
// CASE M — DUPLICATE SOURCE: the SAME real paper discovered through both
// OpenAIRE and Europe PMC. Constructed from the real Kernza evidence object
// (real DOI, real matched positions) duplicated under a second provider tag
// — disclosed explicitly, since a natural double-discovery by both
// providers for the same DOI was not observed in this round's real calls.
// ---------------------------------------------------------------------------
{
  const deviceKey = "p65-device-m";
  const live = await fetchLiveEvidence(KERNZA_ABSTRACT, "case-m");
  const realEntry = live.evidence.find((e) => e.doi === KERNZA_DOI);
  const duplicatedEvidence = realEntry
    ? [realEntry, { ...realEntry, provider: "openaire", providerId: `openaire-dup-${realEntry.providerId}` }]
    : live.evidence;
  const archiveResult = realArchiveAnalyze(KERNZA_ABSTRACT);
  const { id } = await postReport(deviceKey, {
    title: "duplicate-source-m.txt", text: KERNZA_ABSTRACT, score: archiveResult.score, archiveScore: archiveResult.score,
    archiveMatchedPositions: archiveResult.archiveMatchedPositions, externalAcademicEvidence: duplicatedEvidence,
  });
  const report = await getReport(id, { deviceKey });
  record("M", "DUPLICATE SOURCE — same paper via both OpenAIRE and Europe PMC (constructed from real evidence, see note)", {
    wordCount: report.wordCount,
    realEntryFoundNaturally: Boolean(realEntry),
    duplicatedEvidenceInputCount: duplicatedEvidence.length,
    unifiedSimilarity: report.unifiedSimilarity,
  });
}

// ---------------------------------------------------------------------------
// CASE N — PROVIDER FAILURE: the real getExternalAcademicEvidence()
// non-throwing contract, exercised with a real throwing provider override,
// combined with a genuine (isolated, not corpus-polluted) real
// prior-submission match, to cleanly demonstrate "a live provider outage
// does not invalidate other, already-computed evidence."
// ---------------------------------------------------------------------------
{
  const throwingProvider = { id: "throwing-test-provider", search: async () => { throw new Error("simulated provider outage"); } };
  const failureResult = await getExternalAcademicEvidence(ORIGINAL_TEXT, [throwingProvider]);

  const nText = "Phase 6.5 validation PROVIDER FAILURE case, an isolated passage not reused elsewhere in this run: " + REFERENCE_TEXT;
  const { cookie: cookieOwner } = await signup("p65-provider-failure-owner@example.test", "p65-device-n-owner");
  await postReport("p65-device-n-owner", { cookie: cookieOwner, title: "provider-failure-source.txt", text: nText, archiveMatchedPositions: [] });

  const { cookie } = await signup("p65-provider-failure-n@example.test", "p65-device-n");
  const archiveResult = realArchiveAnalyze(nText);
  const { id } = await postReport("p65-device-n", {
    cookie, title: "provider-failure-n.txt", text: nText, score: archiveResult.score, archiveScore: archiveResult.score,
    archiveMatchedPositions: archiveResult.archiveMatchedPositions, // no externalAcademicEvidence at all — simulates production's own behavior after a failed live lookup
  });
  const report = await getReport(id, { cookie });
  record("N", "PROVIDER FAILURE — live provider throws; report still completes and existing (prior-submission) evidence remains valid", {
    getExternalAcademicEvidenceDidNotThrow: true,
    failureResultEvidenceCount: failureResult.evidence.length,
    reportGetStatus: 200,
    wordCount: report.wordCount,
    historicalSubmissionMatch: report.historicalSubmissionMatch,
    unifiedSimilarity: report.unifiedSimilarity,
  });
}

// ---------------------------------------------------------------------------
// CASE O — LEGACY REPORT: a payload shaped like a pre-Phase-3 report
// (missing archiveMatchedPositions entirely) still loads normally.
// ---------------------------------------------------------------------------
{
  const deviceKey = "p65-device-o";
  const { id } = await postReport(deviceKey, { title: "legacy-o.txt", text: ORIGINAL_TEXT, score: 3, archiveScore: 3 }); // archiveMatchedPositions omitted entirely
  const report = await getReport(id, { deviceKey });
  record("O", "LEGACY REPORT — old report with no unified evidence renders normally", {
    wordCount: report.wordCount,
    oldScore: report.score,
    unifiedSimilarity: report.unifiedSimilarity,
  });
}

const outputPath = path.join(import.meta.dirname, "phase6-5-results.json");
fs.writeFileSync(outputPath, JSON.stringify({ archiveMeta: REAL_ARCHIVE_META, generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`\n\nWrote ${results.length} case results to ${outputPath}`);

// Cleanup: remove the throwaway validation DB.
setTimeout(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
}, 500);
