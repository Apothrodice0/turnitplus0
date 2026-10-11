import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest, resetPollRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";
import { completeAiAnalysis } from "./helpers/complete-ai-analysis.mjs";
import { tokens } from "../lib/similarity-core.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { decodeReportFromPersistence } from "../lib/report-persistence.ts";
import { recordAcademicSearchRunDiagnostics, resolveUnverifiedPublicationNotice } from "../lib/academic-search-diagnostics-repo.ts";
import {
  buildManuscriptIdentityIndex,
  decidePublicationIdentity,
  evaluateUnverifiedPublications,
  publicationIdentitySignals,
  sanitizeUnverifiedPublicationNotice,
  UNVERIFIED_PUBLICATION_NOTICE_VERSION,
} from "../lib/academic-search/unverified-publication.ts";
import {
  CLIENT_UNTRUSTED_EVIDENCE_INTERPRETATION_KEYS,
  withEvidenceInterpretation,
} from "../lib/report-evidence-interpretation.ts";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import { ReportV2PrintOverview, ReportV2View, ReportV2Workspace } from "../components/report/report-v2/report-v2-view.tsx";

/**
 * FIX C — "Possible related publication — not verified".
 *
 * The academic search can identify the published version of a manuscript and
 * still fail to download its text (U13: the publisher answered 403 to the
 * server), so the comparator never runs and the report silently shows only the
 * other channels. This notice lists such a publication — only under a strict
 * identity gate, only from the server-owned search row, with ZERO similarity
 * credit. These tests pin the gate against the adversarial cases (generic
 * titles, same-topic/same-author/same-journal articles, contradictions,
 * inconsistent records), the record-level rules (diagnostics v1 only, not
 * evaluated, not already verified), the route wiring (server-only, stripped
 * from clients, survives GET), score/highlight/card invariance, the website
 * and PDF rendering, privacy, and its coexistence with user-supplied reference
 * files (no double counting).
 *
 * ALL TEXT IS SYNTHETIC: deterministic pseudo-words (no manuscript content from
 * any real submission), structured like the U13 case (a retitled manuscript
 * whose published abstract is partly reused).
 */

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SYL = ["ba", "ke", "di", "lo", "mu", "ra", "se", "ti", "vo", "zu", "pe", "na", "go", "fi", "ha", "jo"];
const VOCAB = Array.from({ length: 360 }, (_, i) => SYL[i % 16] + SYL[(i >> 4) % 16] + SYL[(i * 7 + 3) % 16] + "n");
function prose(seed, words) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < words; i += 1) out.push(VOCAB[Math.floor(r() * VOCAB.length)] + ((i + 1) % 14 === 0 ? "." : ""));
  return out.join(" ");
}
const words = (s) => s.split(/\s+/).filter(Boolean);

const ABS_M = prose(1, 150);
const BODY = prose(2, 1600);
const TITLE_M = "Digital Change and Workforce Outcomes in Algerian Retail Banking";
const TOPIC_SENTENCE = "This study examines digital transformation as a socio-economic challenge for employees of the commercial bank and their job performance.";
function manuscript({ frontDoi = null } = {}) {
  return [
    TITLE_M,
    "A. Researcher, B. Researcher",
    "Faculty of Economics, Example University",
    ...(frontDoi ? [`DOI: ${frontDoi}`] : []),
    `Abstract: ${ABS_M}`,
    "Keywords: digital transformation; job performance; banking",
    "1. Introduction",
    TOPIC_SENTENCE,
    BODY,
  ].join("\n");
}
const MANUSCRIPT = manuscript();

const U13_DOI = "10.61093/sec.9(3).48-63.2025";
const U13_TITLE = "Digital Transformation as a Socio-Economic Challenge: The Impact on the Commercial Bank Employees’ Job Performance";
// The published abstract: a 70-word stretch of the manuscript's abstract reused verbatim, the rest rewritten.
const U13_ABSTRACT = `${words(ABS_M).slice(20, 90).join(" ")} ${prose(3, 90)}`;

function cand(key, rank, { doi, title, venue = "SocioEconomic Challenges", year = 2025, abstract = null, authors = null }) {
  return { candidateKey: key, doi, url: doi ? `https://doi.org/${doi}` : null, title, authors, publication: venue, year, textAvailable: false, abstract, contributors: [], rank };
}
const HOP = { requestedHost: "doi.org", outcome: "REDIRECT", statusCode: 302 };
function failedEntry(c, { category = "HTTP_403_FORBIDDEN", status = 403, doi = c.doi, title = c.title } = {}) {
  return {
    candidateKey: c.candidateKey, rank: c.rank, doi, url: c.url, title,
    retrievalSource: "unavailable", retrievalProviderId: null, httpRetrievalStatus: "HTTP_ERROR", retrievalLatencyMs: 90,
    retrievedTextLength: null, comparisonSimilarity: null, includedAsEvidence: false,
    diagnosticsVersion: 1, textRetrieved: false, candidateEvaluated: false,
    providerTextAttempts: [], providerTextAttemptCount: 0, httpFallbackAttempted: true,
    attemptedHost: "doi.org", finalHost: "publisher.example", httpStatusCode: status, errorCategory: category,
    failureStage: "RESPONSE_STATUS", redirectCount: 1, citationPdfFollowed: false, hops: [HOP], networkErrorCode: null, safetyFailure: null,
  };
}
function evaluatedEntry(c, similarity, included) {
  return {
    candidateKey: c.candidateKey, rank: c.rank, doi: c.doi, url: c.url, title: c.title,
    retrievalSource: "http-fallback", retrievalProviderId: null, httpRetrievalStatus: "SUCCESS", retrievalLatencyMs: 800,
    retrievedTextLength: 50000, comparisonSimilarity: similarity, includedAsEvidence: included,
    diagnosticsVersion: 1, textRetrieved: true, candidateEvaluated: true,
    providerTextAttempts: [], providerTextAttemptCount: 0, httpFallbackAttempted: true,
    attemptedHost: "doi.org", finalHost: "repository.example", httpStatusCode: 200, errorCategory: null,
    failureStage: null, redirectCount: 1, citationPdfFollowed: false, hops: [HOP], networkErrorCode: null, safetyFailure: null,
  };
}
function legacyEntry(c) {
  // a pre-diagnostics-v1 row: retrieval failed, but nothing says "found, not evaluated"
  return {
    candidateKey: c.candidateKey, rank: c.rank, doi: c.doi, url: c.url, title: c.title,
    retrievalSource: "unavailable", retrievalProviderId: null, httpRetrievalStatus: "HTTP_ERROR", retrievalLatencyMs: 90,
    retrievedTextLength: null, comparisonSimilarity: null, includedAsEvidence: false,
  };
}

const U13 = cand("doi:u13", 1, { doi: U13_DOI, title: U13_TITLE, abstract: U13_ABSTRACT, authors: ["H. Author", "F. Author"] });
const U03_LIKE = cand("doi:u03", 1, { doi: "10.11594/ijssr.05.02.37", title: TITLE_M, venue: "Indonesian Journal of Social Science Research", year: 2024, abstract: ABS_M });
const SAME_TOPIC = cand("doi:topic", 2, {
  doi: "10.34140/bjbv8n2-011",
  title: "Digital Transformation and Job Performance among Commercial Bank Employees in Morocco",
  venue: "Brazilian Journal of Business", abstract: prose(4, 150),
});
const SAME_TOPIC_SHARED_SENTENCE = cand("doi:topic2", 3, {
  doi: "10.35156/1433-012-001-013",
  title: "The Role of Digital Learning in Improving the Job Performance of Bank Employees",
  venue: "Journal of Economic Studies", abstract: `${TOPIC_SENTENCE} ${prose(5, 140)}`,
});
const SAME_AUTHOR = cand("doi:author", 3, {
  doi: "10.1111/other.2023.5",
  title: "Corporate Governance Mechanisms and Earnings Quality in Listed Algerian Firms",
  venue: "Accounting Review Example", year: 2023, abstract: prose(6, 150), authors: ["A. Researcher", "B. Researcher"],
});
const SAME_JOURNAL = cand("doi:journal", 4, {
  doi: "10.61093/sec.9(3).1-12.2025",
  title: "Household Energy Poverty and Regional Inequality across Emerging Economies",
  abstract: prose(7, 150),
});
const VERIFIED = cand("doi:verified", 0, { doi: "10.2222/verified.2022.3", title: "A Verified Prior Study on Branch Network Efficiency in Banking", venue: "Banking Journal", year: 2022, abstract: prose(8, 120) });
const VERIFIED_EVIDENCE = [{
  provider: "openaire", providerId: "verified-1", title: VERIFIED.title, authors: null, publication: VERIFIED.publication, year: 2022,
  doi: VERIFIED.doi, url: "https://repository.example/verified",
  matchedPassages: [{ submittedText: "x", submittedWordStart: 500, submittedWordEnd: 539, matchedWordCount: 40 }],
  similarity: 30,
}];

const evaluate = (text, candidates, retrieval, evidence = []) =>
  evaluateUnverifiedPublications(text, { candidates, retrievalDiagnostics: retrieval, verifiedEvidence: evidence });
const reasonOf = (ev, key) => ev.outcomes.find((o) => o.candidateKey === key)?.reason;

// ---------------------------------------------------------------------------
// Route harness (DB set up before any test() is registered)
// ---------------------------------------------------------------------------
const dbFile = path.join(path.resolve("."), "test_unverified_publication_notice.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
const db = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(db, path.join(path.resolve("."), "drizzle"));
test.after(() => {
  db.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore (Windows EBUSY) */ } }
});

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let accounts = 0;
async function account() {
  accounts += 1;
  const tag = `upn-${accounts}`;
  await resetAuthRateForTest(`${tag}-signup`);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${tag}-signup` },
    body: JSON.stringify(withTestIdentity({ email: `${tag}@example.test`, password: "upn-pw-123456", username: `upnu${accounts}`, deviceKey: `upn-dev-${accounts}` })),
  }));
  assert.equal(res.status, 201);
  return { deviceKey: `upn-dev-${accounts}`, cookie: cookieOf(res), tag };
}
const RWC = tokens(MANUSCRIPT).length;
const ARCHIVE_POSITIONS = Array.from({ length: 60 }, (_, i) => 300 + i);
async function post(acc, id, { diagnosticsId, text = MANUSCRIPT, payloadExtra = {}, extra = {} } = {}) {
  await resetRateForTest(`${acc.tag}-post`);
  const created = "2026-10-11T00:00:00.000Z";
  const body = {
    deviceKey: acc.deviceKey, id, submissionId: `sub-${id}`, title: "upn fixture.docx", createdAt: created,
    wordCount: RWC, archiveScore: 1, scoreBand: "Low", aiScore: 2, aiTone: "low", aiStatus: "ready", room: 0,
    payload: {
      version: 11, id, submissionId: `sub-${id}`, title: "upn fixture.docx", author: "", assignment: "", created,
      score: 1, archiveScore: 1, wordCount: RWC, scoreBand: "Low", matchedWordCount: ARCHIVE_POSITIONS.length,
      archiveMatchedPositions: ARCHIVE_POSITIONS, sources: [], repeats: [], text,
      academicEvidenceStatus: "COMPLETE_WITH_MATCHES", aiAnalysis: completeAiAnalysis(),
      ...payloadExtra,
    },
    ...extra,
  };
  if (diagnosticsId !== undefined) body.academicSearchDiagnosticsId = Number(diagnosticsId);
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${acc.tag}-post`, cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify(body),
  }));
}
async function readRow(acc, id) {
  const r = await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] });
  return r.rows[0] ? decodeReportFromPersistence(JSON.parse(String(r.rows[0].payload_json))) : null;
}
async function get(acc, id) {
  await resetReadRateForTest(`${acc.tag}-get`);
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}`, { headers: { "x-forwarded-for": `${acc.tag}-get`, cookie: `tp_session_v1=${acc.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  const body = await res.json();
  return body.payload ?? body;
}
async function roomOccupant(acc) {
  await resetPollRateForTest(`${acc.tag}-room`);
  const res = await reportsRoute.GET(new Request("http://localhost/api/reports?room=0", { headers: { "x-forwarded-for": `${acc.tag}-room`, cookie: `tp_session_v1=${acc.cookie}` } }));
  return res.json();
}
function seed(candidates, retrievalDiagnostics, evidence, text = MANUSCRIPT) {
  return recordAcademicSearchRunDiagnostics(db, {
    status: evidence.length ? "COMPLETE_WITH_MATCHES" : "COMPLETE_NO_MATCHES",
    stats: { queryCount: 24, searchLatencyMs: 1, candidateCountBeforeDedup: candidates.length, candidateCountAfterDedup: candidates.length, deduplicationRate: 0, candidatesTextRetrieved: 1, textRetrievalLatencyMs: 1, comparisonLatencyMs: 1, totalLatencyMs: 3, providerErrors: [], searchAttempts: 24 },
    queries: null, candidates, retrievalDiagnostics, evidence,
    submissionCanonicalSha256: canonicalSha256(text),
  });
}

// ===========================================================================
// 1. U13-like confirmed same publication, HTTP 403
// ===========================================================================
test("1: a retitled manuscript whose published version failed with HTTP 403 gets a notice (ABSTRACT_REUSE), metadata from the stored record", () => {
  const ev = evaluate(MANUSCRIPT, [U13], [failedEntry(U13)]);
  const o = ev.outcomes[0];
  assert.equal(o.reason, "ELIGIBLE");
  assert.equal(o.basis, "ABSTRACT_REUSE");
  assert.equal(o.signals.titleExactInFrontMatter, false, "the manuscript was retitled");
  assert.ok(o.signals.abstractCoverage >= 0.3 && o.signals.abstractLongestRun >= 20);
  assert.deepEqual(ev.notice, {
    version: UNVERIFIED_PUBLICATION_NOTICE_VERSION,
    publications: [{ doi: U13_DOI, title: U13_TITLE, venue: "SocioEconomic Challenges", year: 2025 }],
  });
});

test("1b: an identical-title manuscript (U03-like) qualifies on EXACT_TITLE; a DOI printed on the title page qualifies on DOI_IN_FRONT_MATTER", () => {
  assert.equal(evaluate(MANUSCRIPT, [U03_LIKE], [failedEntry(U03_LIKE, { category: "HTTP_4XX_OTHER", status: 410 })]).outcomes[0].basis, "EXACT_TITLE");
  const own = cand("doi:own", 0, { doi: "10.7777/own.2025.9", title: TITLE_M, abstract: null });
  const ev = evaluate(manuscript({ frontDoi: "10.7777/own.2025.9" }), [own], [failedEntry(own, { category: "TIMEOUT", status: null })]);
  assert.equal(ev.outcomes[0].basis, "DOI_IN_FRONT_MATTER");
});

// ===========================================================================
// 2. Generic title / 3. same-topic, same-author, same-journal
// ===========================================================================
test("2: a failed candidate with a generic or short title never qualifies, even with the abstract fully present", () => {
  const generic = cand("doi:intro", 1, { doi: "10.1234/intro", title: "Introduction", abstract: ABS_M });
  const short = cand("doi:short", 2, { doi: "10.1234/short", title: "Digital Banking", abstract: ABS_M });
  const ev = evaluate(MANUSCRIPT, [generic, short], [failedEntry(generic), failedEntry(short)]);
  assert.equal(ev.notice, null);
  assert.equal(reasonOf(ev, "doi:intro"), "TITLE_TOO_GENERIC");
  assert.equal(reasonOf(ev, "doi:short"), "TITLE_TOO_GENERIC");
});

test("3: same-topic articles (shared vocabulary, even a shared sentence), a same-author article and a same-journal article are all rejected", () => {
  const all = [SAME_TOPIC, SAME_TOPIC_SHARED_SENTENCE, SAME_AUTHOR, SAME_JOURNAL];
  const ev = evaluate(MANUSCRIPT, all, all.map((c) => failedEntry(c)));
  assert.equal(ev.notice, null);
  for (const c of all) assert.equal(reasonOf(ev, c.candidateKey), "INSUFFICIENT_IDENTITY_EVIDENCE", c.title);
  const topic = publicationIdentitySignals(SAME_TOPIC, buildManuscriptIdentityIndex(MANUSCRIPT));
  assert.ok(topic.titleVocabularyCoverage >= 0.8, "the topic vocabulary alone is high — and still not enough");
});

// ===========================================================================
// 4. Strong abstract overlap, conflicting identity / 5. record mismatch
// ===========================================================================
test("4: strong abstract overlap is rejected when the identity conflicts (a different DOI on the title page; an exact title whose abstract is absent)", () => {
  const fullAbstract = cand("doi:conflict", 1, { doi: U13_DOI, title: U13_TITLE, abstract: ABS_M });
  const ev1 = evaluate(manuscript({ frontDoi: "10.5555/journal.2024.17" }), [fullAbstract], [failedEntry(fullAbstract)]);
  assert.equal(ev1.notice, null);
  assert.equal(ev1.outcomes[0].reason, "CONTRADICTION_FOREIGN_DOI");
  const sameTitleOtherText = cand("doi:title", 1, { doi: "10.4444/title.2024.1", title: TITLE_M, abstract: prose(9, 150) });
  const ev2 = evaluate(MANUSCRIPT, [sameTitleOtherText], [failedEntry(sameTitleOtherText)]);
  assert.equal(ev2.notice, null);
  assert.equal(ev2.outcomes[0].reason, "CONTRADICTION_TITLE_WITHOUT_ABSTRACT");
});

test("5: a DOI or title mismatch between the retrieval entry and the stored candidate, or incomplete metadata, never qualifies", () => {
  for (const entry of [failedEntry(U13, { doi: "10.9999/other" }), failedEntry(U13, { title: "Another Title Entirely For This Entry" })]) {
    assert.equal(evaluate(MANUSCRIPT, [U13], [entry]).outcomes[0].reason, "RECORD_INCONSISTENT");
  }
  for (const broken of [{ ...U13, doi: null }, { ...U13, publication: null }, { ...U13, year: null }, { ...U13, year: 1066 }]) {
    const entry = failedEntry(U13, { doi: broken.doi });
    assert.equal(evaluate(MANUSCRIPT, [broken], [entry]).outcomes[0].reason, "METADATA_INCOMPLETE");
  }
  const missing = evaluate(MANUSCRIPT, [], [failedEntry(U13)]);
  assert.equal(missing.outcomes[0].reason, "CANDIDATE_NOT_IN_RECORD");
});

// ===========================================================================
// 6. Multiple failed candidates
// ===========================================================================
test("6: several failed candidates — only the identity-confirmed ones are listed, de-duplicated by DOI, at most 3, in rank order", () => {
  const all = [U13, SAME_TOPIC, SAME_TOPIC_SHARED_SENTENCE, SAME_JOURNAL];
  const one = evaluate(MANUSCRIPT, all, all.map((c) => failedEntry(c)));
  assert.deepEqual(one.notice.publications.map((p) => p.doi), [U13_DOI]);

  const dup = { ...U13, candidateKey: "doi:u13-dup", rank: 2 };
  const twoDistinct = evaluate(MANUSCRIPT, [U13, dup, U03_LIKE], [failedEntry(U13), failedEntry(dup), failedEntry({ ...U03_LIKE, rank: 3 })]);
  assert.deepEqual(twoDistinct.notice.publications.map((p) => p.doi), [U13_DOI, U03_LIKE.doi]);
  assert.equal(reasonOf(twoDistinct, "doi:u13-dup"), "DUPLICATE_PUBLICATION");

  const many = [0, 1, 2, 3].map((i) => ({ ...U03_LIKE, candidateKey: `doi:m${i}`, rank: i, doi: `10.1234/many.${i}` }));
  const capped = evaluate(MANUSCRIPT, many, many.map((c) => failedEntry(c)));
  assert.equal(capped.notice.publications.length, 3);
  assert.equal(reasonOf(capped, "doi:m3"), "LIST_FULL");
});

// ===========================================================================
// 7. Alongside a verified match / 8. evaluated publication
// ===========================================================================
test("7: a failed candidate alongside a verified match is listed; a failed entry for an already-verified DOI is not", () => {
  const ev = evaluate(MANUSCRIPT, [VERIFIED, U13], [evaluatedEntry(VERIFIED, 30, true), failedEntry(U13)], VERIFIED_EVIDENCE);
  assert.deepEqual(ev.notice.publications.map((p) => p.doi), [U13_DOI]);
  assert.equal(reasonOf(ev, "doi:verified"), "TEXT_EVALUATED");
  const again = evaluate(MANUSCRIPT, [U13], [failedEntry(U13)], [{ ...VERIFIED_EVIDENCE[0], doi: U13_DOI }]);
  assert.equal(again.notice, null);
  assert.equal(again.outcomes[0].reason, "ALREADY_VERIFIED");
});

test("8: a publication whose text WAS retrieved and evaluated gets no notice, whatever its identity or similarity", () => {
  for (const [sim, included] of [[0, false], [12, false], [88, true]]) {
    const ev = evaluate(MANUSCRIPT, [U13], [evaluatedEntry(U13, sim, included)]);
    assert.equal(ev.notice, null);
    assert.equal(ev.outcomes[0].reason, "TEXT_EVALUATED");
  }
  const unsafe = evaluate(MANUSCRIPT, [U13], [{ ...failedEntry(U13, { category: "UNSAFE_REDIRECT_TARGET", status: null }), safetyFailure: "PRIVATE_ADDRESS" }]);
  assert.equal(unsafe.outcomes[0].reason, "SAFETY_REFUSAL");
});

// ===========================================================================
// 9. Legacy
// ===========================================================================
test("9: a search row recorded before diagnostics v1 never yields a notice, even for a confirmed identity", () => {
  const ev = evaluate(MANUSCRIPT, [U13, U03_LIKE], [legacyEntry(U13), legacyEntry(U03_LIKE)]);
  assert.equal(ev.notice, null);
  assert.deepEqual(ev.outcomes.map((o) => o.reason), ["LEGACY_DIAGNOSTICS", "LEGACY_DIAGNOSTICS"]);
  assert.equal(evaluate(MANUSCRIPT, null, null).notice, null);
  assert.equal(evaluate("", [U13], [failedEntry(U13)]).notice, null);
});

test("9b: a malformed or foreign persisted notice is ignored on read (legacy and damaged values render as before)", () => {
  for (const bad of [undefined, null, 3, "x", {}, { version: 2, publications: [] }, { version: 1, publications: [] },
    { version: 1, publications: [{ doi: "not-a-doi", title: "t", venue: "v", year: 2020 }] },
    { version: 1, publications: [{ doi: U13_DOI, title: "", venue: "v", year: 2020 }] }]) {
    assert.equal(sanitizeUnverifiedPublicationNotice(bad), null, JSON.stringify(bad));
  }
});

// ===========================================================================
// Route-level: 1/7/11/12/13 + "Report ready" + legacy
// ===========================================================================
test("route: the notice is computed server-side; score, matched words, highlights, cards and the room status are identical to a run without it", async () => {
  const withFailed = await seed([VERIFIED, U13, SAME_TOPIC], [evaluatedEntry(VERIFIED, 30, true), failedEntry(U13), failedEntry(SAME_TOPIC)], VERIFIED_EVIDENCE);
  const baseline = await seed([VERIFIED], [evaluatedEntry(VERIFIED, 30, true)], VERIFIED_EVIDENCE);
  const a = await account();
  const b = await account();
  assert.equal((await post(a, "upn-a", { diagnosticsId: withFailed })).status, 200);
  assert.equal((await post(b, "upn-b", { diagnosticsId: baseline })).status, 200);
  const A = await readRow(a, "upn-a");
  const B = await readRow(b, "upn-b");

  // 1 + 7 — the notice
  assert.deepEqual(A.unverifiedPublicationNotice, { version: 1, publications: [{ doi: U13_DOI, title: U13_TITLE, venue: "SocioEconomic Challenges", year: 2025 }] });
  assert.equal(B.unverifiedPublicationNotice, undefined);
  assert.equal(A.reportCompletion.state, "SOURCE_UNAVAILABLE");
  assert.equal(A.reportCompletion.signals.unverifiedCandidateCount, 1);
  assert.equal(B.reportCompletion.state, "COMPLETED");

  // 12 — zero credit: every number, position and passage is byte-identical
  assert.ok(A.unifiedSimilarity.archiveOnlyWords > 0 && A.unifiedSimilarity.liveAcademicOnlyWords > 0, "fixture exercises archive + academic credit");
  assert.deepEqual(A.unifiedSimilarity, B.unifiedSimilarity);
  assert.deepEqual(A.externalAcademicEvidence, B.externalAcademicEvidence);
  assert.deepEqual(A.archiveMatchedPositions, B.archiveMatchedPositions);
  assert.deepEqual(A.evidenceInterpretation.passages, B.evidenceInterpretation.passages);
  assert.deepEqual(A.evidenceInterpretation.positionsByKind, B.evidenceInterpretation.positionsByKind);
  assert.equal(A.evidenceInterpretation.matchedWordCount, B.evidenceInterpretation.matchedWordCount);

  // 13 — source cards untouched; the publication is not a card or an evidence entry
  assert.deepEqual(A.evidenceInterpretation.sources, B.evidenceInterpretation.sources);
  assert.ok(!JSON.stringify(A.evidenceInterpretation).includes(U13_TITLE), "never a source card");
  const vmA = buildReportV2ViewModel(A);
  const vmB = buildReportV2ViewModel(B);
  assert.equal(vmA.summary.matchingEvidenceEntries, vmB.summary.matchingEvidenceEntries);
  assert.equal(vmA.summary.verifiedSimilarityPercent, vmB.summary.verifiedSimilarityPercent);
  assert.equal(vmA.summary.matchedWordCount, vmB.summary.matchedWordCount);
  assert.deepEqual(vmA.passages, vmB.passages, "highlight geometry identical");

  // "Report ready" — the room lifecycle does not depend on the notice
  const occA = await roomOccupant(a);
  const occB = await roomOccupant(b);
  assert.equal(occA.status, "ready");
  assert.equal(occA.status, occB.status);

  // the notice survives GET exactly as persisted
  const got = await get(a, "upn-a");
  assert.deepEqual(got.unverifiedPublicationNotice, A.unverifiedPublicationNotice);
  assert.equal(got.reportCompletion.state, "SOURCE_UNAVAILABLE");
});

test("11: privacy — the notice carries only public bibliographic fields; no host, status code or diagnostic reaches any client response", async () => {
  const id = await seed([U13], [failedEntry(U13)], []);
  const acc = await account();
  assert.equal((await post(acc, "upn-priv", { diagnosticsId: id })).status, 200);
  const row = await readRow(acc, "upn-priv");
  for (const p of row.unverifiedPublicationNotice.publications) assert.deepEqual(Object.keys(p).sort(), ["doi", "title", "venue", "year"]);
  const got = await get(acc, "upn-priv");
  const occ = await roomOccupant(acc);
  for (const body of [JSON.stringify(got), JSON.stringify(occ)]) {
    for (const secret of ["publisher.example", "HTTP_403", "httpStatusCode", "errorCategory", "finalHost", "attemptedHost", "retrievalDiagnostics", "verifiedAcademicSearchDiagnosticsId"]) {
      assert.ok(!body.includes(secret), `client response leaks ${secret}`);
    }
  }
  const vm = buildReportV2ViewModel(got);
  assert.equal(vm.unverifiedPublications.publications[0].doiUrl, `https://doi.org/${encodeURI(U13_DOI)}`, "the only link is the DOI resolver");
  assert.ok(CLIENT_UNTRUSTED_EVIDENCE_INTERPRETATION_KEYS.includes("unverifiedPublicationNotice"));
});

test("11b: a client-forged notice is stripped — with no qualifying row nothing is persisted; with one, only the server's value is", async () => {
  const forged = { version: 1, publications: [{ doi: "10.6666/forged.1", title: "Forged Publication Title For The Client Test", venue: "Forged Venue", year: 2020 }] };
  const acc1 = await account();
  assert.equal((await post(acc1, "upn-forged-none", { payloadExtra: { unverifiedPublicationNotice: forged } })).status, 200);
  const none = await readRow(acc1, "upn-forged-none");
  assert.equal(none.unverifiedPublicationNotice, undefined);
  assert.equal(none.reportCompletion.state, "COMPLETED");

  const id = await seed([U13], [failedEntry(U13)], []);
  const acc2 = await account();
  assert.equal((await post(acc2, "upn-forged-row", { diagnosticsId: id, payloadExtra: { unverifiedPublicationNotice: forged } })).status, 200);
  assert.deepEqual((await readRow(acc2, "upn-forged-row")).unverifiedPublicationNotice.publications.map((p) => p.doi), [U13_DOI]);

  // the stripping also holds for the pure wiring the client uses for its own pre-save view
  const local = withEvidenceInterpretation({ id: 1, text: MANUSCRIPT, wordCount: RWC, archiveMatchedPositions: [], sources: [], unverifiedPublicationNotice: forged });
  assert.equal(local.unverifiedPublicationNotice, undefined);
  assert.equal(local.reportCompletion.state, "COMPLETED");
});

test("route: a row whose diagnostics are bound to different text, or recorded before diagnostics v1, yields no notice (no rewrite, no warning)", async () => {
  const otherText = `${MANUSCRIPT} plus an appended paragraph that changes the canonical text`;
  const wrongText = await seed([U13], [failedEntry(U13)], [], otherText);
  const acc1 = await account();
  await post(acc1, "upn-wrong-text", { diagnosticsId: wrongText });
  assert.equal((await readRow(acc1, "upn-wrong-text")).unverifiedPublicationNotice, undefined);
  assert.equal(await resolveUnverifiedPublicationNotice(db, { diagnosticsId: Number(wrongText), submissionCanonicalSha256: canonicalSha256(MANUSCRIPT), manuscriptText: MANUSCRIPT }), null);

  const legacy = await seed([U13], [legacyEntry(U13)], []);
  const acc2 = await account();
  await post(acc2, "upn-legacy-row", { diagnosticsId: legacy });
  const row = await readRow(acc2, "upn-legacy-row");
  assert.equal(row.unverifiedPublicationNotice, undefined);
  assert.equal(row.reportCompletion.state, "COMPLETED");
});

test("9c: a saved report that predates the notice is served and rendered unchanged (no field, no warning, nothing written back)", async () => {
  const acc = await account();
  const id = "upn-legacy-saved";
  await post(acc, id, {});
  const before = await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] });
  const got = await get(acc, id);
  assert.equal(got.unverifiedPublicationNotice, undefined);
  assert.equal(buildReportV2ViewModel(got).unverifiedPublications, null);
  const html = renderToStaticMarkup(React.createElement(ReportV2Workspace, { report: got }));
  assert.ok(!html.includes("not verified"));
  const after = await db.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] });
  assert.equal(String(after.rows[0].payload_json), String(before.rows[0].payload_json), "GET writes nothing back");
});

// ===========================================================================
// 10. Website / PDF consistency
// ===========================================================================
test("10: the website (workspace + first screen) and the printed PDF overview show the same notice, separate from the source list", async () => {
  const id = await seed([VERIFIED, U13], [evaluatedEntry(VERIFIED, 30, true), failedEntry(U13)], VERIFIED_EVIDENCE);
  const acc = await account();
  await post(acc, "upn-render", { diagnosticsId: id });
  const report = await get(acc, "upn-render");
  const vm = buildReportV2ViewModel(report);
  const notice = vm.unverifiedPublications;
  assert.equal(notice.heading, "Possible related publication — not verified");
  assert.equal(notice.body, "A potentially related published article was identified, but its text could not be retrieved for comparison. This publication is not included in your similarity score.");

  const surfaces = {
    workspace: renderToStaticMarkup(React.createElement(ReportV2Workspace, { report })),
    firstScreen: renderToStaticMarkup(React.createElement(ReportV2View, { report })),
    pdfOverview: renderToStaticMarkup(React.createElement(ReportV2PrintOverview, { report })),
  };
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  for (const [name, html] of Object.entries(surfaces)) {
    for (const s of [notice.heading, notice.body, U13_TITLE, "SocioEconomic Challenges", "2025", `doi:${U13_DOI}`]) {
      assert.ok(html.includes(esc(s)), `${name} shows ${s}`);
    }
    assert.ok(html.includes(`href="${esc(notice.publications[0].doiUrl)}"`), `${name} links the DOI resolver`);
    for (const forbidden of [/plagiari/i, /stolen/i, /confirmed match/i, /HTTP[ _]?403|403 Forbidden/i, /publisher\.example/, /forbidden/i]) {
      assert.doesNotMatch(html, forbidden, `${name} must not say ${forbidden}`);
    }
  }
  // the notice is outside the Sources list (never a card / evidence entry)
  const ws = surfaces.workspace;
  const sourcesStart = ws.indexOf('class="rv2ws-sources"');
  assert.ok(ws.indexOf(esc(U13_TITLE)) < sourcesStart, "rendered before, not inside, the source list");
  assert.ok(!ws.slice(sourcesStart).includes(esc(U13_TITLE)));
  assert.match(surfaces.pdfOverview, /Needs attention/);
  assert.match(surfaces.workspace, /Needs attention/);
});

test("10b: two listed publications use the plural copy on every surface", () => {
  const notice = { version: 1, publications: [
    { doi: U13_DOI, title: U13_TITLE, venue: "SocioEconomic Challenges", year: 2025 },
    { doi: "10.11594/ijssr.05.02.37", title: TITLE_M, venue: "Indonesian Journal of Social Science Research", year: 2024 },
  ] };
  const report = withEvidenceInterpretation({ id: 9, title: "plural fixture.docx", submissionId: "sub-plural", created: "2026-10-11T00:00:00.000Z", text: MANUSCRIPT, wordCount: RWC, archiveMatchedPositions: [], sources: [], score: 0, archiveScore: 0 }, { unverifiedPublicationNotice: notice });
  assert.equal(report.reportCompletion.signals.unverifiedCandidateCount, 2);
  const vm = buildReportV2ViewModel(report);
  assert.equal(vm.unverifiedPublications.heading, "Possible related publications — not verified");
  assert.match(vm.unverifiedPublications.body, /^Potentially related published articles were identified, but their text could not be retrieved for comparison\. These publications are not included in your similarity score\.$/);
  const pdf = renderToStaticMarkup(React.createElement(ReportV2PrintOverview, { report }));
  assert.ok(pdf.includes("Possible related publications — not verified") && pdf.includes("Indonesian Journal of Social Science Research"));
});

// ===========================================================================
// 14. Reference files + provenance / 15. no repeated counting
// ===========================================================================
const PUBLISHED_COPY = `${words(BODY).slice(100, 700).join(" ")} ${prose(10, 300)}`;
const refInput = (fileName, fileType, extractedText) => ({ fileName, fileType, extractedText, extraction: { completeness: "COMPLETE", analyzableWordCount: words(extractedText).length, skipped: null, extractor: "x" } });

test("14: a supplied reference file is compared through its own channel with filename-only provenance; the academic notice stays an unverified notice", async () => {
  const id = await seed([U13], [failedEntry(U13)], []);
  const acc = await account();
  const res = await post(acc, "upn-ref", { diagnosticsId: id, extra: { userSuppliedReferences: [refInput("C:\\Users\\someone\\Downloads\\published-article.pdf", "pdf", PUBLISHED_COPY)] } });
  assert.equal(res.status, 200);
  const row = await readRow(acc, "upn-ref");
  const ref = row.userSuppliedReferenceEvidence[0];
  assert.equal(ref.admitted, true);
  assert.equal(ref.safeLabel, "published-article.pdf", "basename only — no directory");
  assert.equal(ref.fileType, "pdf");
  assert.ok(ref.matchedWords >= 500);
  assert.deepEqual(Object.keys(ref).sort(), ["admissionReason", "admitted", "analyzableWordCount", "contributionPercent", "extractionStatus", "fileType", "key", "matchedWords", "safeLabel", "verifiedPassages"], "no DOI / URL / hash / storage id is recorded for a reference file");
  assert.ok(row.unifiedSimilarity.userSuppliedReferenceOnlyWords > 0, "the reference file changes the similarity result");
  assert.deepEqual(row.unverifiedPublicationNotice.publications.map((p) => p.doi), [U13_DOI], "a reference file is never linked to the DOI");
  const card = row.evidenceInterpretation.sources.find((s) => s.sourceType === "user-supplied-reference");
  assert.ok(card && card.label.includes("published-article.pdf"));
  assert.ok(!JSON.stringify(await get(acc, "upn-ref")).includes("Downloads"), "no client path reaches a response");
});

test("15: no word is counted twice — reference, archive and academic channels union once, and the notice adds nothing", async () => {
  const id = await seed([VERIFIED, U13], [evaluatedEntry(VERIFIED, 30, true), failedEntry(U13)], VERIFIED_EVIDENCE);
  const acc = await account();
  // the reference text also covers the archive (300..359) and academic (500..539) spans
  await post(acc, "upn-union", { diagnosticsId: id, extra: { userSuppliedReferences: [refInput("published-article.pdf", "pdf", PUBLISHED_COPY)] } });
  const row = await readRow(acc, "upn-union");
  const u = row.unifiedSimilarity;
  assert.equal(new Set(u.matchedPositions).size, u.matchedPositions.length, "matchedPositions has no duplicate");
  assert.equal(u.uniqueMatchedWords, u.matchedPositions.length);
  const archive = new Set(ARCHIVE_POSITIONS);
  const academic = new Set(Array.from({ length: 40 }, (_, i) => 500 + i));
  // every verified reference position (userSuppliedReferencePositions holds only the reference-ONLY ones)
  const reference = new Set(row.userSuppliedReferenceEvidence[0].verifiedPassages.flatMap((p) => Array.from({ length: p.submittedWordEnd - p.submittedWordStart + 1 }, (_, i) => p.submittedWordStart + i)));
  assert.deepEqual(u.userSuppliedReferencePositions, [...reference].filter((p) => !archive.has(p) && !academic.has(p)).sort((x, y) => x - y), "overlapping words are not re-credited to the reference channel");
  const union = new Set([...archive, ...academic, ...reference]);
  assert.equal(u.uniqueMatchedWords, union.size, "the score counts the union exactly once");
  assert.ok([...archive].some((p) => reference.has(p)) && [...academic].some((p) => reference.has(p)), "fixture really overlaps the channels");
  assert.equal(u.archiveOnlyWords + u.liveAcademicOnlyWords + u.userSuppliedReferenceOnlyWords + u.overlapWords + u.previousUploadOnlyWords + u.selectiveCorpusOnlyWords + u.importedSimilarityEvidenceOnlyWords, u.uniqueMatchedWords, "channel-only + overlap partitions the union");

  const without = await account();
  await post(without, "upn-union-base", { diagnosticsId: await seed([VERIFIED], [evaluatedEntry(VERIFIED, 30, true)], VERIFIED_EVIDENCE), extra: { userSuppliedReferences: [refInput("published-article.pdf", "pdf", PUBLISHED_COPY)] } });
  assert.deepEqual((await readRow(without, "upn-union-base")).unifiedSimilarity, u, "with or without the notice, the same union");
});

// ===========================================================================
// Identity gate unit: the decision needs two agreeing signals
// ===========================================================================
test("gate: a single matching field is never enough (title alone, DOI alone, abstract alone without title vocabulary)", () => {
  const base = { titleContentTokens: 8, titleExactInFrontMatter: false, titleRunFractionInFrontMatter: 0, titleVocabularyCoverage: 0, abstractTokens: 150, abstractCoverage: 0, abstractLongestRun: 0, doiInFrontMatter: false, foreignDoiInFrontMatter: false };
  assert.equal(decidePublicationIdentity({ ...base, titleExactInFrontMatter: true, titleRunFractionInFrontMatter: 1, abstractCoverage: null }).strong, false, "exact title, no abstract");
  assert.equal(decidePublicationIdentity({ ...base, doiInFrontMatter: true, titleRunFractionInFrontMatter: 0.5 }).strong, false, "DOI without the title");
  assert.equal(decidePublicationIdentity({ ...base, abstractCoverage: 0.9, abstractLongestRun: 120, titleVocabularyCoverage: 0.2 }).strong, false, "abstract reuse without the title's vocabulary");
  assert.equal(decidePublicationIdentity({ ...base, abstractCoverage: 0.29, abstractLongestRun: 120, titleVocabularyCoverage: 1 }).strong, false, "below the reuse floor");
  assert.equal(decidePublicationIdentity({ ...base, abstractCoverage: 0.6, abstractLongestRun: 19, titleVocabularyCoverage: 1 }).strong, false, "scattered reuse, no long run");
  assert.equal(decidePublicationIdentity({ ...base, abstractCoverage: 0.3, abstractLongestRun: 20, titleVocabularyCoverage: 0.6 }).strong, true, "the calibrated floor itself passes");
});
