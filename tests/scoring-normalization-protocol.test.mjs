import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";

import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetPollRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";
import { completeAiAnalysis } from "./helpers/complete-ai-analysis.mjs";
import { atServerTime } from "./helpers/report-clock.mjs";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";
import { makeUnitRecord } from "./helpers/imported-similarity-evidence-fixtures.mjs";
import { buildImportedSimilarityEvidencePackageFile } from "../lib/imported-similarity-evidence/package.ts";
import {
  resetImportedSimilarityEvidencePackageCacheForTest,
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest,
} from "../lib/imported-similarity-evidence/index.ts";
import {
  currentScoringNormalizationVersion,
  reportScoringNormalizationVersion,
  tokenSpans,
  tokensForScoringNormalization,
} from "../lib/similarity-core.ts";
import { createDocumentIdentity, canonicalSha256 } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import {
  getOrComputeHistoricalMatchSnapshot,
  snapshotMatcherVersion,
  snapshotScoringNormalizationVersion,
} from "../lib/report-historical-match.ts";
import {
  persistRefreshedSimilarity,
  persistSelectiveCorpusAuthoritativeFinalization,
  resolvePersistedSimilarityDisplay,
  resolvePrimarySimilaritySummary,
  selfHealUnifiedSimilarity,
} from "../lib/report-primary-similarity.ts";
import { finalizeSelectiveCorpusAuthoritativeReport } from "../lib/selective-corpus-authoritative.ts";
import { scheduleReportShadowEvaluations } from "../lib/report-shadow-evaluations.ts";
import { recordAcademicSearchRunDiagnostics, resolveVerifiedAcademicEvidence } from "../lib/academic-search-diagnostics-repo.ts";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import { findHighlightRanges } from "../components/report/similarity-report-papers.tsx";
import { decodeReportFromPersistence } from "../lib/report-persistence.ts";

/**
 * RELEASE GATE — the scoring-normalization PROTOCOL, on the real routes.
 *
 * A report's persisted stamp means exactly "these persisted positions were
 * computed under this contract". The positions come from several places —
 * the browser (archive positions, word count), the server at check time
 * (scholarly evidence), the server at save time (prior submissions, imported
 * evidence, the union, the interpretation) and the server later (self-heal,
 * the Selective Corpus finalizer). This file drives the real save / read
 * routes with requests shaped exactly as each generation of browser bundle
 * sends them and proves, for every path, that:
 *
 *   - every persisted position of a report is in ONE position space;
 *   - the stamp names that space, and only the server writes it;
 *   - nothing that happens after creation moves a report to another contract.
 *
 * It names every contract explicitly, so it holds whichever contract the
 * build under test computes NEW checks under: run on the build that defaults
 * to v1 it is "…against a Phase A server"; on the build that defaults to v2,
 * "…against a Phase B server".
 *
 * ("Phase A" / "Phase B" here are the two rollout steps of scoring
 * normalization v2 — dual-contract support with v1 active, then v2 active —
 * and the browser bundles each step ships. They are unrelated to the corpus
 * maturity work other files call "Phase A".)
 */

const cp = (n) => String.fromCodePoint(n);
const MARKS = [cp(0x200b), cp(0x00ad), cp(0x2060), cp(0x200f)];

/** Puts one invisible format character inside each of the first `count` words of length >= 5. */
function markInsideWords(text, count) {
  let used = 0;
  return text.split(" ").map((word) => {
    if (used >= count || word.replace(/[^\p{L}]/gu, "").length < 5) return word;
    const mark = MARKS[used % MARKS.length];
    used += 1;
    return `${word.slice(0, 2)}${mark}${word.slice(2)}`;
  }).join(" ");
}

// One manuscript; every block is reached by a different authority.
//   INTRO    novel, 30 in-word marks — shifts every later v1 position by 30.
//   PASSAGE  a quoted, attributed copy with 5 in-word marks. Its last two words are the BROWSER's archive positions;
//            its first 14 (clean) words are an imported-evidence anchor that only v2 can read.
//   SCHOLAR  the server's check-time scholarly evidence (a diagnostics row).
//   PRIOR    another account's earlier submission (the prior-submission snapshot).
//   OUTRO    its first 14 words are an imported-evidence anchor both contracts read.
const INTRO = markInsideWords(
  "Beekeepers monitoring orchard pollination throughout springtime noticed hives positioned beside hedgerows produced noticeably heavier honey yields compared against colonies standing beside plowed fields during several consecutive seasons, although weather records remained incomplete throughout the surveyed district and several keepers disputed the published figures afterwards.",
  30,
);
const PASSAGE_WORDS = "glaciologists drilling through the icefield recovered a continuous core whose volcanic ash layers aligned precisely with documented eruptions allowing researchers to calibrate annual accumulation rates across four centuries";
const PASSAGE = markInsideWords(PASSAGE_WORDS, 5);
const GAP_ONE = "Meanwhile unrelated village committees debated repainting the harbour railings before the midsummer regatta.";
const SCHOLAR = "Horologists restoring an eighteenth century marine chronometer discovered that its brass escapement had been filed by hand to compensate for thermal expansion";
const GAP_TWO = "Elsewhere a travelling puppeteer mended torn curtains while apprentices rehearsed quietly behind the wagon.";
const PRIOR = "Cartographers surveying the northern estuary recorded shifting sandbanks each spring and redrew navigation charts so that grain barges could reach the upstream granaries without grounding, a practice the provincial treasury funded reluctantly after three costly wrecks blocked the channel for an entire harvest season and merchants petitioned the governor.";
const GAP_THREE = "Nobody at the lighthouse remembered who first planted the crooked apple tree.";
const OUTRO = "Ferry operators subsequently rescheduled timetables because tidal currents intensified unexpectedly during autumn storms along the northern channel.";
const MANUSCRIPT = `${INTRO} According to Smith (2019), “${PASSAGE}” ${GAP_ONE} ${SCHOLAR}. ${GAP_TWO} ${PRIOR} ${GAP_THREE} ${OUTRO}`;
/** The same manuscript with every invisible character removed: both contracts read it identically. */
const PLAIN_MANUSCRIPT = MANUSCRIPT.replace(new RegExp(`[${MARKS.join("")}]`, "gu"), "");

const PASSAGE_ANCHOR_WORDS = PASSAGE_WORDS.split(" ").slice(0, 14);
const PASSAGE_ANCHOR_RAW = PASSAGE.split(" ").slice(0, 14).join(" ");
const PASSAGE_TAIL_RAW = PASSAGE.split(" ").slice(-2).join(" ");
const OUTRO_ANCHOR_WORDS = tokensForScoringNormalization(OUTRO, 1).slice(0, 14);
const OUTRO_ANCHOR_RAW = OUTRO.split(" ").slice(0, 14).join(" ");

/** A block's word range in `version`'s word sequence, from the text before it and the block itself — never from the code under test. */
function blockRange(text, block, version) {
  const tok = (value) => tokensForScoringNormalization(value, version);
  const at = text.indexOf(block);
  assert.ok(at >= 0, "fixture sanity: the block is in the text");
  const start = tok(text.slice(0, at)).length;
  const count = tok(block).length;
  assert.equal(tok(text).length, start + count + tok(text.slice(at + block.length)).length, "fixture sanity: the block tokenizes independently of its surroundings");
  return { start, end: start + count - 1, count };
}
const span = (r) => Array.from({ length: r.count }, (_, index) => r.start + index);
const wordCountOf = (text, version) => tokensForScoringNormalization(text, version).length;

test("FIXTURE: the two contracts read the marked manuscript as different word sequences, and the plain one identically", () => {
  assert.equal(wordCountOf(MANUSCRIPT, 1), wordCountOf(MANUSCRIPT, 2) + 35, "35 in-word marks: 35 more v1 words");
  assert.equal(blockRange(MANUSCRIPT, PRIOR, 1).start, blockRange(MANUSCRIPT, PRIOR, 2).start + 35);
  assert.equal(blockRange(MANUSCRIPT, PRIOR, 1).count, blockRange(MANUSCRIPT, PRIOR, 2).count);
  assert.deepEqual(tokensForScoringNormalization(PLAIN_MANUSCRIPT, 1), tokensForScoringNormalization(PLAIN_MANUSCRIPT, 2));
  assert.deepEqual(tokensForScoringNormalization(PLAIN_MANUSCRIPT, 2), tokensForScoringNormalization(MANUSCRIPT, 2), "v2 reads the marked manuscript as the plain one");
  assert.equal(OUTRO_ANCHOR_WORDS.length, 14);
});

// ── database, corpus and imported-evidence package ────────────────────────
const dbFile = path.join(path.resolve("."), "test_scoring_normalization_protocol.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
const dbClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(dbClient, path.join(path.resolve("."), "drizzle"));

// The earlier submission of ANOTHER account that every report below overlaps (the PRIOR block).
await dbClient.execute({
  sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["snp-prior-source", "snp-prior-source@example.test", "snppriorsource", "not-a-real-hash"],
});
const priorIdentity = await createDocumentIdentity(dbClient, { accountId: "snp-prior-source", title: "Earlier submission", author: null, rawText: PRIOR });
await indexDocumentSubmissionIntoCorpus(dbClient, { documentIdentityId: priorIdentity.id, rawText: PRIOR });
await matureCorpusBackings(dbClient);

function writeTempPackage() {
  const dir = mkdtempSync(path.join(tmpdir(), "scoring-normalization-protocol-"));
  const units = [
    makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: OUTRO_ANCHOR_WORDS.join(" "), scoreMaskRelativePositions: OUTRO_ANCHOR_WORDS.map((_, index) => index) }),
    makeUnitRecord({ evidenceUnitId: "PU0002", anchorNormalizedText: PASSAGE_ANCHOR_WORDS.join(" "), scoreMaskRelativePositions: PASSAGE_ANCHOR_WORDS.map((_, index) => index) }),
  ];
  const evidenceSets = [{
    evidenceSetId: "ES-TEST00000001", provenanceType: "TURNITIN_REPORT_IMPORT",
    reportSha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", reportedSimilarityPercent: 49,
    normalizationVersion: units[0].normalizationVersion, manuscriptIdentitySha256: null, createdAt: "2026-09-19T00:00:00.000Z",
    unitCount: units.length, totalScoreMaskWords: units.reduce((total, unit) => total + unit.scoreMaskWordCount, 0),
  }];
  const filePath = path.join(dir, "package.json");
  fs.writeFileSync(filePath, JSON.stringify(buildImportedSimilarityEvidencePackageFile(evidenceSets, units)));
  return filePath;
}
const packagePath = writeTempPackage();
test.before(() => {
  process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH = packagePath;
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
});
test.after(() => {
  dbClient.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  delete process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH;
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

// ── accounts and requests ─────────────────────────────────────────────────
const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let uc = 0;
async function account({ admin = false } = {}) {
  uc += 1;
  await resetAuthRateForTest(`snp-signup-${uc}`);
  const email = `snp-${uc}@example.test`;
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `snp-signup-${uc}` },
    body: JSON.stringify(withTestIdentity({ email, password: "snp-pw-123456", username: `snpu${uc}`, deviceKey: `snp-dev-${uc}` })),
  }));
  assert.equal(res.status, 201);
  if (admin) await dbClient.execute({ sql: "UPDATE users SET role = 'admin' WHERE email = ?", args: [email] });
  const user = await dbClient.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] });
  return { deviceKey: `snp-dev-${uc}`, cookie: cookieOf(res), tag: `snp-${uc}`, userId: String(user.rows[0].id), nextRoom: 0 };
}

/**
 * What /api/academic-evidence does for a check computed under `version`: it runs the scholarly matcher under that
 * contract and records the evidence in a row bound to it. The row here holds the SCHOLAR block at the positions
 * that contract gives it. (The route itself is exercised further down.)
 */
async function scholarlyDiagnosticsRow(text, version) {
  const r = blockRange(text, SCHOLAR, version);
  return recordAcademicSearchRunDiagnostics(dbClient, {
    status: "COMPLETE_WITH_MATCHES",
    stats: { queryCount: 1, searchLatencyMs: 1, candidateCountBeforeDedup: 1, candidateCountAfterDedup: 1, deduplicationRate: 0, candidatesTextRetrieved: 1, textRetrievalLatencyMs: 1, comparisonLatencyMs: 1, totalLatencyMs: 3, providerErrors: [], searchAttempts: 1 },
    queries: null, candidates: null, retrievalDiagnostics: null,
    evidence: [{
      provider: "fixture", providerId: "fixture:horology", title: "Marine chronometers", authors: null, publication: null, year: 2001, doi: null, url: "https://example.test/horology",
      matchedPassages: [{ submittedText: tokensForScoringNormalization(SCHOLAR, version).join(" "), submittedWordStart: r.start, submittedWordEnd: r.end, matchedWordCount: r.count }],
      similarity: 12,
    }],
    submissionCanonicalSha256: canonicalSha256(text),
    scoringNormalizationVersion: version,
  });
}

/**
 * The three generations of browser bundle. Each computes its check under ONE contract (its worker's), and tells
 * the server about it only as far as its code knows how.
 */
const BROWSERS = {
  "pre-Phase-A": { computes: 1, declares: false, recordsOnReport: false },
  "Phase-A": { computes: 1, declares: true, recordsOnReport: false },
  "Phase-B": { computes: 2, declares: true, recordsOnReport: true },
};

/**
 * When every fixture report of this run is created: the moment the file starts. A room holds its report for 24 hours
 * from that time (lib/report-rooms.ts isWithinActiveCycle), and the room tile is read below, so a fixed calendar date
 * here would make the room read "empty" once the date is a day old. One value for the whole run keeps the reports of
 * different browsers comparable.
 */
const FIXTURE_CREATED_AT = new Date().toISOString();

/** The report object a browser of `kind` holds after checking `text`: its worker's word count and archive positions (the last two words of the copied passage). */
function browserReport(kind, id, text = MANUSCRIPT, overrides = {}) {
  const browser = BROWSERS[kind];
  const passage = blockRange(text, text === MANUSCRIPT ? PASSAGE : PASSAGE_WORDS, browser.computes);
  return {
    version: 11, id, submissionId: `sub-${id}`, title: "protocol fixture", author: "", assignment: "",
    created: FIXTURE_CREATED_AT, score: 0, archiveScore: 0,
    wordCount: wordCountOf(text, browser.computes), scoreBand: "Low",
    matchedWordCount: 2, archiveMatchedPositions: [passage.end - 1, passage.end], sources: [], repeats: [], text,
    aiAnalysis: completeAiAnalysis(),
    ...(browser.recordsOnReport ? { scoringNormalizationVersion: 2 } : {}),
    ...overrides,
  };
}

async function post(acc, id, payload, extra = {}) {
  await resetRateForTest(`${acc.tag}-post`);
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${acc.tag}-post`, cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: `sub-${id}`, title: "protocol fixture", createdAt: FIXTURE_CREATED_AT,
      wordCount: payload?.wordCount ?? 0, archiveScore: 0, scoreBand: "Low", aiScore: 2, aiTone: "low", aiStatus: "ready",
      payload, ...extra,
    }),
  }));
}

/** A browser of `kind` checks `text` and saves it for the first time: the scholarly call, then POST /api/reports — both shaped as that bundle sends them. */
async function firstSave(acc, kind, id, text = MANUSCRIPT, { payloadOverrides = {}, bodyOverrides = {}, diagnosticsVersion } = {}) {
  const browser = BROWSERS[kind];
  const academicSearchDiagnosticsId = await scholarlyDiagnosticsRow(text, diagnosticsVersion ?? browser.computes);
  const room = acc.nextRoom;
  acc.nextRoom += 1;
  const res = await post(acc, id, browserReport(kind, id, text, payloadOverrides), {
    room,
    academicSearchDiagnosticsId,
    ...(browser.declares ? { scoringNormalization: browser.computes } : {}),
    ...bodyOverrides,
  });
  return { res, academicSearchDiagnosticsId };
}

async function rawRow(acc, id) {
  const r = await dbClient.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] });
  return r.rows[0] ? JSON.parse(String(r.rows[0].payload_json)) : null;
}
async function rawRowText(acc, id) {
  const r = await dbClient.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, id] });
  return r.rows[0] ? String(r.rows[0].payload_json) : null;
}
async function snapshotRow(acc, id) {
  const r = await dbClient.execute({
    sql: "SELECT status, matcher_version, result_json, computed_at FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [acc.deviceKey, id],
  });
  const row = r.rows[0];
  return row ? { status: String(row.status), matcherVersion: String(row.matcher_version), computedAt: String(row.computed_at), matches: row.result_json ? JSON.parse(String(row.result_json)) : [] } : null;
}
async function get(acc, id) {
  await resetReadRateForTest(`${acc.tag}-get`);
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(acc.deviceKey)}`, {
      headers: { "x-forwarded-for": `${acc.tag}-get`, cookie: `tp_session_v1=${acc.cookie}` },
    }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(res.status, 200);
  return (await res.json()).payload;
}

// ── what a saved report must hold ─────────────────────────────────────────
/** Every position a saved report of `text` holds in `version`'s space, by authority. */
function expectedPositions(text, version, { scholarly = true } = {}) {
  const marked = text === MANUSCRIPT;
  const passage = blockRange(text, marked ? PASSAGE : PASSAGE_WORDS, version);
  const outro = blockRange(text, OUTRO, version);
  // The passage anchor is 14 clean words: v2 reads the marked passage as those words; v1 only when there are no marks.
  const passageAnchorReadable = version === 2 || !marked;
  const byAuthority = {
    browserArchive: [passage.end - 1, passage.end],
    serverScholarly: scholarly ? span(blockRange(text, SCHOLAR, version)) : [],
    serverPriorSubmission: span(blockRange(text, PRIOR, version)),
    serverImported: [
      ...Array.from({ length: 14 }, (_, index) => outro.start + index),
      ...(passageAnchorReadable ? Array.from({ length: 14 }, (_, index) => passage.start + index) : []),
    ],
  };
  const all = [...new Set(Object.values(byAuthority).flat())].sort((a, b) => a - b);
  return { byAuthority, all };
}
/** The raw characters those positions must light up — found by searching the text, never through the tokenizer. */
function expectedHighlightedCharacters(text, version, { scholarly = true } = {}) {
  const marked = text === MANUSCRIPT;
  // (a highlight runs from its first word to its last: the PRIOR block's closing full stop is not part of it)
  const blocks = [marked ? PASSAGE_TAIL_RAW : PASSAGE_WORDS.split(" ").slice(-2).join(" "), PRIOR.replace(/\.$/, ""), OUTRO_ANCHOR_RAW];
  if (scholarly) blocks.push(SCHOLAR);
  if (version === 2 || !marked) blocks.push(marked ? PASSAGE_ANCHOR_RAW : PASSAGE_ANCHOR_WORDS.join(" "));
  const covered = new Set();
  for (const block of blocks) {
    const at = text.indexOf(block);
    assert.ok(at >= 0);
    for (let index = at; index < at + block.length; index += 1) covered.add(index);
  }
  return covered;
}
function highlightedCharacters(ranges) {
  const covered = new Set();
  for (const [start, end] of ranges) for (let index = start; index < end; index += 1) covered.add(index);
  return covered;
}
const sortedNumbers = (set) => [...set].sort((a, b) => a - b);

/** Asserts that EVERYTHING persisted for this report is in `version`'s position space, names it truthfully, and renders on the right characters. */
async function assertSavedInContract(acc, id, version, label, { text = MANUSCRIPT, scholarly = true } = {}) {
  const saved = await rawRow(acc, id);
  assert.ok(saved, `${label}: the report was saved`);
  const decoded = decodeReportFromPersistence(saved);
  const expected = expectedPositions(text, version, { scholarly });

  // the stamp
  assert.equal("scoringNormalizationVersion" in saved, version === 2, `${label}: the stamp is ${version === 2 ? "present" : "absent"}`);
  if (version === 2) assert.equal(saved.scoringNormalizationVersion, 2, label);
  assert.equal(reportScoringNormalizationVersion(decoded), version, label);

  // browser-relayed
  assert.equal(decoded.wordCount, wordCountOf(text, version), `${label}: wordCount`);
  assert.deepEqual(decoded.archiveMatchedPositions, expected.byAuthority.browserArchive, `${label}: archive positions`);

  // server, check time: scholarly evidence
  const scholarlyPositions = (decoded.externalAcademicEvidence ?? []).flatMap((e) => e.matchedPassages.flatMap((p) => span({ start: p.submittedWordStart, count: p.submittedWordEnd - p.submittedWordStart + 1 })));
  assert.deepEqual(scholarlyPositions, expected.byAuthority.serverScholarly, `${label}: scholarly positions`);
  assert.equal(typeof saved.verifiedAcademicSearchDiagnosticsId === "number", scholarly, `${label}: verified diagnostics id`);

  // server, save time: the prior-submission snapshot — computed under, and tagged with, the report's contract
  const snapshot = await snapshotRow(acc, id);
  assert.ok(snapshot, `${label}: a snapshot row exists`);
  assert.equal(snapshot.matcherVersion, snapshotMatcherVersion(version), `${label}: snapshot tag`);
  assert.equal(snapshotScoringNormalizationVersion(snapshot.matcherVersion), version, label);
  assert.equal(snapshot.status, "MATCHED", label);
  const priorPositions = snapshot.matches.flatMap((m) => m.passages.flatMap((p) => span({ start: p.submittedWordStart, count: p.submittedWordEnd - p.submittedWordStart + 1 })));
  assert.deepEqual([...new Set(priorPositions)].sort((a, b) => a - b), expected.byAuthority.serverPriorSubmission, `${label}: prior-submission positions`);
  for (const match of snapshot.matches) {
    for (const passage of match.passages) {
      assert.equal(passage.submittedText, tokensForScoringNormalization(text, version).slice(passage.submittedWordStart, passage.submittedWordEnd + 1).join(" "), `${label}: a stored passage's own words are the words at its positions`);
    }
  }

  // the union of all of them
  assert.ok(decoded.unifiedSimilarity, `${label}: unified similarity`);
  assert.deepEqual(decoded.unifiedSimilarity.matchedPositions, expected.all, `${label}: every persisted position is a v${version} position`);
  assert.ok(decoded.unifiedSimilarity.matchedPositions.every((position) => position < decoded.wordCount), `${label}: no position past the word count`);
  assert.equal(decoded.unifiedSimilarity.unifiedScore, Math.round((expected.all.length / decoded.wordCount) * 100), `${label}: score`);

  // the read side: the persisted result is current FOR THE REPORT'S OWN CONTRACT (and would not be for the other)
  const displayInputs = {
    reportDeviceKey: acc.deviceKey, reportId: id, archiveScore: 0, unifiedScore: decoded.unifiedSimilarity.unifiedScore, hasUnifiedSimilarity: true,
    corpusSourceMatchingEnabledAtComputation: decoded.corpusSourceMatchingEnabledAtComputation, unifiedSimilarityFailed: false, hasPositionEvidence: true,
  };
  assert.deepEqual(
    await resolvePersistedSimilarityDisplay(dbClient, { ...displayInputs, scoringNormalizationVersion: saved.scoringNormalizationVersion }),
    { status: "resolved", primaryScore: decoded.unifiedSimilarity.unifiedScore, isUnified: true },
    `${label}: display`,
  );
  assert.deepEqual(await resolvePersistedSimilarityDisplay(dbClient, { ...displayInputs, scoringNormalizationVersion: version === 2 ? undefined : 2 }), { status: "stale" }, `${label}: display under the other contract`);

  // …rendered: Report V2 and the shared highlighter light up exactly the copied characters
  const wanted = sortedNumbers(expectedHighlightedCharacters(text, version, { scholarly }));
  const vm = buildReportV2ViewModel(decoded);
  assert.deepEqual(sortedNumbers(highlightedCharacters(vm.passages.map((p) => [p.charStart, p.charEnd]))), wanted, `${label}: Report V2 highlights`);
  // (every kind of range it draws: the scholarly block is drawn as "academic", the rest as "v2-evidence")
  const shared = findHighlightRanges(decoded);
  assert.deepEqual(sortedNumbers(highlightedCharacters(shared.map((r) => [r.start, r.end]))), wanted, `${label}: shared highlighter`);
  // …and interpreted: the two words the browser reported sit inside the attributed quotation
  const quoted = decoded.evidenceInterpretation.passages.filter((p) => p.wordEnd <= blockRange(text, text === MANUSCRIPT ? PASSAGE : PASSAGE_WORDS, version).end);
  assert.ok(quoted.length >= 1, label);
  for (const passage of quoted) assert.equal(passage.interpretation.kind, "ATTRIBUTED_QUOTATION", `${label}: quotation read through the report's contract`);
  return { saved, decoded, snapshot };
}

// ══ the deploy-skew matrix ════════════════════════════════════════════════
// Each browser generation against this build's server. On the build that
// defaults to v1 these are matrix cases 1, 2 and 6; on the build that
// defaults to v2 they are cases 3, 4 and 5.
test("SKEW — a pre-Phase-A browser (computes v1, declares nothing): the report is v1, unstamped, every position in v1 space", async () => {
  const acc = await account();
  const { res } = await firstSave(acc, "pre-Phase-A", "snp-skew-pre-a");
  assert.equal(res.status, 200);
  await assertSavedInContract(acc, "snp-skew-pre-a", 1, "pre-Phase-A browser");
});

test("SKEW — a Phase-A browser (computes v1, declares 1): the report is v1, unstamped — and identical to what the pre-Phase-A browser saved", async () => {
  // The two saved reports are compared whole below, creation time included — which is the server's clock at each
  // report's first save, not anything the request says. Both are therefore created at one instant of it.
  const createdAt = new Date().toISOString();
  const acc = await account();
  const { res } = await atServerTime(createdAt, () => firstSave(acc, "Phase-A", "snp-skew-a"));
  assert.equal(res.status, 200);
  const { saved } = await assertSavedInContract(acc, "snp-skew-a", 1, "Phase-A browser");

  // The declaration of 1 changes nothing: the same check from a bundle that cannot declare persists the same report.
  const other = await account();
  assert.equal((await atServerTime(createdAt, () => firstSave(other, "pre-Phase-A", "snp-skew-a"))).res.status, 200);
  const undeclared = await rawRow(other, "snp-skew-a");
  const comparable = ({ verifiedAcademicSearchDiagnosticsId: _id, ...rest }) => rest;
  assert.deepEqual(comparable(saved), comparable(undeclared));
});

test("SKEW — a Phase-B browser (computes v2, declares 2): the server computes its own parts natively under v2 and stamps 2 — truthfully, on either build", async () => {
  const acc = await account();
  const { res } = await firstSave(acc, "Phase-B", "snp-skew-b");
  assert.equal(res.status, 200);
  const { saved } = await assertSavedInContract(acc, "snp-skew-b", 2, "Phase-B browser");
  // v2 is the only contract that reads the obfuscated passage: its anchor is credited here and was not for the v1 reports above.
  const passage = blockRange(MANUSCRIPT, PASSAGE, 2);
  assert.ok(decodeReportFromPersistence(saved).unifiedSimilarity.matchedPositions.includes(passage.start));
  // The stamp reaches the client, so a later resave built from a GET declares it.
  assert.equal((await get(acc, "snp-skew-b")).scoringNormalizationVersion, 2);
  // The room tile (the lightweight summary read) resolves the v2 report's own result — no "updating", no recompute.
  await resetPollRateForTest(`${acc.tag}-room`);
  const before = await rawRowText(acc, "snp-skew-b");
  const room = await reportsRoute.GET(new Request("http://localhost/api/reports?room=0", { headers: { "x-forwarded-for": `${acc.tag}-room`, cookie: `tp_session_v1=${acc.cookie}` } }));
  assert.equal(room.status, 200);
  const tile = await room.json();
  assert.equal(tile.status, "ready");
  assert.equal(tile.report.similarityStatus, "resolved");
  assert.equal(tile.report.primaryScore, decodeReportFromPersistence(saved).unifiedSimilarity.unifiedScore);
  assert.equal(tile.report.isUnified, true);
  assert.equal(await rawRowText(acc, "snp-skew-b"), before, "the room read wrote nothing");
});

test("SKEW — the same manuscript checked by a v1 browser and by a v2 browser: two reports, each wholly in its own space, both rendering on the same characters wherever both contracts can read", async () => {
  const acc = await account();
  assert.equal((await firstSave(acc, "Phase-A", "snp-both-v1")).res.status, 200);
  const before = await rawRowText(acc, "snp-both-v1");
  assert.equal((await firstSave(acc, "Phase-B", "snp-both-v2")).res.status, 200);
  await assertSavedInContract(acc, "snp-both-v2", 2, "the v2 report");
  assert.equal(await rawRowText(acc, "snp-both-v1"), before, "a new check under another contract is a new report: the earlier one is untouched");
  await assertSavedInContract(acc, "snp-both-v1", 1, "the earlier v1 report");
});

test("SKEW — text both contracts read identically: every position is the same index under either stamp, so the stamp cannot mislead; an undeclared save stays unstamped", async () => {
  const acc = await account();
  assert.equal((await firstSave(acc, "pre-Phase-A", "snp-plain-pre", PLAIN_MANUSCRIPT)).res.status, 200);
  assert.equal((await firstSave(acc, "Phase-A", "snp-plain-a", PLAIN_MANUSCRIPT)).res.status, 200);
  assert.equal((await firstSave(acc, "Phase-B", "snp-plain-b", PLAIN_MANUSCRIPT)).res.status, 200);
  const pre = (await assertSavedInContract(acc, "snp-plain-pre", 1, "plain, undeclared", { text: PLAIN_MANUSCRIPT })).decoded;
  const a = (await assertSavedInContract(acc, "snp-plain-a", 1, "plain, declared 1", { text: PLAIN_MANUSCRIPT })).decoded;
  const b = (await assertSavedInContract(acc, "snp-plain-b", 2, "plain, declared 2", { text: PLAIN_MANUSCRIPT })).decoded;
  for (const report of [a, b]) {
    assert.deepEqual(report.unifiedSimilarity, pre.unifiedSimilarity);
    assert.deepEqual(report.evidenceInterpretation, pre.evidenceInterpretation);
    assert.deepEqual(report.archiveMatchedPositions, pre.archiveMatchedPositions);
    assert.equal(report.wordCount, pre.wordCount);
  }
});

// ══ a declaration is a claim, not the stamp ═══════════════════════════════
test("FORGED / STALE — a declaration the positions contradict is refused whole: nothing is saved, so nothing can be mis-stamped", async () => {
  const acc = await account();
  const cases = [
    ["declares 2, but the word count and positions are a v1 worker's", "Phase-A", { scoringNormalization: 2 }, {}],
    ["declares 1, but the word count and positions are a v2 worker's", "Phase-B", { scoringNormalization: 1 }, {}],
    ["declares nothing (reads as v1), but the positions are a v2 worker's", "Phase-B", { scoringNormalization: undefined }, {}],
    ["declares 2 with a word count that is neither contract's", "Phase-B", {}, { wordCount: wordCountOf(MANUSCRIPT, 2) + 7 }],
  ];
  for (const [label, kind, bodyOverrides, payloadOverrides] of cases) {
    const id = `snp-forged-${cases.findIndex((entry) => entry[0] === label)}`;
    const { res } = await firstSave(acc, kind, id, MANUSCRIPT, { bodyOverrides, payloadOverrides });
    assert.equal(res.status, 422, label);
    assert.deepEqual(await res.json(), { error: "This report could not be saved. Please run the check again.", code: "SCORING_NORMALIZATION_MISMATCH" }, label);
    assert.equal(await rawRow(acc, id), null, `${label}: no report row`);
    assert.equal(await snapshotRow(acc, id), null, `${label}: no snapshot row`);
    acc.nextRoom -= 1; // the refused save claimed no room
  }
});

test("FORGED / STALE — anything that is not exactly 1 or 2 is a malformed request, not a guess", async () => {
  const acc = await account();
  for (const value of [0, 3, "2", "1", true, {}, [2]]) {
    const { res } = await firstSave(acc, "Phase-A", "snp-malformed", MANUSCRIPT, { bodyOverrides: { scoringNormalization: value } });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.deepEqual(await res.json(), { error: "scoringNormalization must be 1 or 2" });
    assert.equal(await rawRow(acc, "snp-malformed"), null);
    acc.nextRoom -= 1;
  }
});

test("FORGED / STALE — the payload's own field is never the stamp: a v1 check carrying `scoringNormalizationVersion: 2` is saved unstamped, and a v2 check that lost the field is still stamped", async () => {
  const acc = await account();
  // A bundle that cannot declare, re-sending a v1 report object that picked the field up somewhere.
  for (const value of [2, 1, "2", 3, true, null]) {
    const id = `snp-payload-field-${String(value)}`;
    const { res } = await firstSave(acc, "pre-Phase-A", id, MANUSCRIPT, { payloadOverrides: { scoringNormalizationVersion: value } });
    assert.equal(res.status, 200, String(value));
    await assertSavedInContract(acc, id, 1, `payload field ${JSON.stringify(value)}, v1 positions`);
  }
  // The declaration (checked) decides; the in-payload field is not needed for it.
  const { res } = await firstSave(acc, "Phase-B", "snp-payload-field-missing", MANUSCRIPT, { payloadOverrides: { scoringNormalizationVersion: undefined } });
  assert.equal(res.status, 200);
  await assertSavedInContract(acc, "snp-payload-field-missing", 2, "declared 2, no in-payload field");
});

test("FORGED / STALE — scholarly evidence is scored only on a report of the contract the server computed it under", async () => {
  const acc = await account();
  // A v2 report offered the row of a v1 scholarly run (and the reverse): the evidence is not scored at all.
  const v2 = await firstSave(acc, "Phase-B", "snp-scholar-v2-with-v1-row", MANUSCRIPT, { diagnosticsVersion: 1 });
  assert.equal(v2.res.status, 200);
  await assertSavedInContract(acc, "snp-scholar-v2-with-v1-row", 2, "v2 report, v1 scholarly row", { scholarly: false });
  const v1 = await firstSave(acc, "Phase-A", "snp-scholar-v1-with-v2-row", MANUSCRIPT, { diagnosticsVersion: 2 });
  assert.equal(v1.res.status, 200);
  await assertSavedInContract(acc, "snp-scholar-v1-with-v2-row", 1, "v1 report, v2 scholarly row", { scholarly: false });

  // The resolver itself: the row verifies for its own contract and for no other — including a caller that never
  // names one (a build older than the binding, which only ever asks for the plain hash).
  const hash = canonicalSha256(MANUSCRIPT);
  const forV1 = (await resolveVerifiedAcademicEvidence(dbClient, { diagnosticsId: v2.academicSearchDiagnosticsId, submissionCanonicalSha256: hash, scoringNormalizationVersion: 1 })).evidence;
  const forV2 = (await resolveVerifiedAcademicEvidence(dbClient, { diagnosticsId: v2.academicSearchDiagnosticsId, submissionCanonicalSha256: hash, scoringNormalizationVersion: 2 })).evidence;
  assert.equal(forV1.length, 1);
  assert.equal(forV2.length, 0);
  const v2Row = v1.academicSearchDiagnosticsId;
  assert.equal((await resolveVerifiedAcademicEvidence(dbClient, { diagnosticsId: v2Row, submissionCanonicalSha256: hash, scoringNormalizationVersion: 2 })).evidence.length, 1);
  assert.equal((await resolveVerifiedAcademicEvidence(dbClient, { diagnosticsId: v2Row, submissionCanonicalSha256: hash, scoringNormalizationVersion: 1 })).evidence.length, 0);
  assert.equal((await resolveVerifiedAcademicEvidence(dbClient, { diagnosticsId: v2Row, submissionCanonicalSha256: hash })).evidence.length, 0, "no contract named: v1");
});

// ══ after creation, a report's contract never moves ═══════════════════════
for (const [kind, version] of [["Phase-A", 1], ["Phase-B", 2]]) {
  const other = version === 1 ? 2 : 1;
  const otherKind = version === 1 ? "Phase-B" : "Phase-A";

  test(`LIFECYCLE, v${version} report — a historical GET mutates nothing`, async () => {
    const acc = await account();
    const id = `snp-get-v${version}`;
    assert.equal((await firstSave(acc, kind, id)).res.status, 200);
    const before = await rawRowText(acc, id);
    const snapshotBefore = await snapshotRow(acc, id);
    for (let read = 0; read < 3; read += 1) {
      const fetched = await get(acc, id);
      assert.equal(reportScoringNormalizationVersion(fetched), version);
      assert.equal("scoringNormalizationVersion" in fetched, version === 2);
    }
    assert.equal(await rawRowText(acc, id), before, "the row is byte-identical after three reads");
    assert.deepEqual(await snapshotRow(acc, id), snapshotBefore, "…and so is its snapshot");
  });

  test(`LIFECYCLE, v${version} report — AI-only, status and from-GET resaves keep the contract, whatever the resaving bundle declares`, async () => {
    const acc = await account();
    const id = `snp-resave-v${version}`;
    assert.equal((await firstSave(acc, kind, id)).res.status, 200);
    const first = await assertSavedInContract(acc, id, version, "first save");

    // The automatic AI-enrichment resave ({...report, ...aiResult}) — from the same bundle, from a bundle that cannot
    // declare, and from one that declares the OTHER contract (a stale or newer tab finishing the AI pass).
    const aiResave = { ...browserReport(kind, id), aiScore: 2, aiAnalysis: { ...completeAiAnalysis(), score: 2 } };
    for (const declaration of [{ scoringNormalization: version }, {}, { scoringNormalization: other }]) {
      assert.equal((await post(acc, id, aiResave, declaration)).status, 200, JSON.stringify(declaration));
      const after = await assertSavedInContract(acc, id, version, `AI resave declaring ${JSON.stringify(declaration)}`);
      assert.deepEqual(after.decoded.unifiedSimilarity.matchedPositions, first.decoded.unifiedSimilarity.matchedPositions);
      assert.equal(after.decoded.aiAnalysis.score, 2, "the AI result did land");
    }

    // A resave built from a GET (the client no longer holds its own copy) — the payload carries the server's stamp
    // for a v2 report and nothing for a v1 one; either way the bundle may not be able to declare.
    const fetched = await get(acc, id);
    assert.equal((await post(acc, id, { ...fetched, aiAnalysis: completeAiAnalysis() })).status, 200);
    await assertSavedInContract(acc, id, version, "resave from GET, undeclared");

    // A metadata / status resave (a re-sent first save: 'processing', no AI result) against the ready row.
    const { aiAnalysis: _ai, ...withoutAi } = browserReport(kind, id);
    assert.equal((await post(acc, id, withoutAi, { aiStatus: "processing", aiScore: null, aiTone: null, title: "renamed" })).status, 200);
    await assertSavedInContract(acc, id, version, "status resave");

    // The payload's own field, forged either way, is ignored on a resave too.
    assert.equal((await post(acc, id, { ...browserReport(kind, id), scoringNormalizationVersion: other === 2 ? 2 : undefined })).status, 200);
    await assertSavedInContract(acc, id, version, "resave with the in-payload field changed");
  });

  test(`LIFECYCLE, v${version} report — a resave carrying the OTHER contract's positions is refused, and the stored report is left exactly as it was`, async () => {
    const acc = await account();
    const id = `snp-resave-other-v${version}`;
    assert.equal((await firstSave(acc, kind, id)).res.status, 200);
    const before = await rawRowText(acc, id);
    const snapshotBefore = await snapshotRow(acc, id);
    // The same report id re-submitted with positions recomputed by a browser of the other generation — declared honestly or not.
    for (const declaration of [{ scoringNormalization: other }, { scoringNormalization: version }, {}]) {
      const res = await post(acc, id, browserReport(otherKind, id), declaration);
      assert.equal(res.status, 422, JSON.stringify(declaration));
      assert.equal((await res.json()).code, "SCORING_NORMALIZATION_MISMATCH");
      assert.equal(await rawRowText(acc, id), before, "no mixed position space: the row is untouched");
      assert.deepEqual(await snapshotRow(acc, id), snapshotBefore);
    }
    await assertSavedInContract(acc, id, version, "after the refused resaves");
  });

  test(`LIFECYCLE, v${version} report — a PARTIAL recomputation (self-heal: only the server-resolved part) is computed under the report's own contract and never re-stamps`, async () => {
    const acc = await account();
    const id = `snp-selfheal-v${version}`;
    assert.equal((await firstSave(acc, kind, id)).res.status, 200);
    const first = await assertSavedInContract(acc, id, version, "first save");

    // Drop everything the server resolved, so the self-heal really recomputes it: the snapshot row and the union.
    await dbClient.execute({ sql: "DELETE FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [acc.deviceKey, id] });
    await dbClient.execute({
      sql: "UPDATE saved_reports SET payload_json = json_remove(payload_json, '$.unifiedSimilarity', '$.unifiedSimilarityGeneration') WHERE device_key = ? AND id = ?",
      args: [acc.deviceKey, id],
    });
    const healed = await selfHealUnifiedSimilarity(dbClient, { reportDeviceKey: acc.deviceKey, reportId: id, accountId: acc.userId });
    assert.equal(healed.attempted, true);
    assert.equal(healed.outcome, "resolved");
    assert.deepEqual(healed.unifiedSimilarity.matchedPositions, expectedPositions(MANUSCRIPT, version).all, "recomputed in the report's own space");
    const after = await assertSavedInContract(acc, id, version, "after self-heal");
    assert.deepEqual(after.decoded.unifiedSimilarity.matchedPositions, first.decoded.unifiedSimilarity.matchedPositions);
    assert.deepEqual(after.decoded.archiveMatchedPositions, first.decoded.archiveMatchedPositions, "the browser's positions were not touched");
    assert.equal(after.decoded.wordCount, first.decoded.wordCount);
  });

  test(`LIFECYCLE, v${version} report — a similarity write-back computed under one contract cannot land on a row stamped with the other`, async () => {
    const acc = await account();
    const id = `snp-cas-v${version}`;
    assert.equal((await firstSave(acc, kind, id)).res.status, 200);
    const setStamp = (value) => dbClient.execute({
      sql: value === 2
        ? "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.scoringNormalizationVersion', 2) WHERE device_key = ? AND id = ?"
        : "UPDATE saved_reports SET payload_json = json_remove(payload_json, '$.scoringNormalizationVersion') WHERE device_key = ? AND id = ?",
      args: [acc.deviceKey, id],
    });

    // A self-heal that read the row as v{version}, computed under it, and then finds the row carrying the other stamp
    // at write time (it cannot happen through any route — this is the guard itself): the write matches no row.
    await dbClient.execute({
      sql: "UPDATE saved_reports SET payload_json = json_remove(payload_json, '$.unifiedSimilarity', '$.unifiedSimilarityGeneration') WHERE device_key = ? AND id = ?",
      args: [acc.deviceKey, id],
    });
    const healed = await selfHealUnifiedSimilarity(dbClient, {
      reportDeviceKey: acc.deviceKey, reportId: id, accountId: acc.userId,
      testOnlyBeforePersist: async () => { await setStamp(other); },
    });
    assert.equal(healed.attempted, true);
    assert.equal(healed.presentationResolved, false);
    const tampered = await rawRow(acc, id);
    assert.equal("unifiedSimilarity" in tampered, false, `positions computed under v${version} were NOT written onto a row stamped v${other}`);
    await setStamp(version);

    // The two write functions directly.
    const resolution = await resolvePrimarySimilaritySummary(dbClient, {
      reportDeviceKey: acc.deviceKey, reportId: id, accountId: acc.userId, rawText: MANUSCRIPT,
      wordCount: wordCountOf(MANUSCRIPT, version), archiveMatchedPositions: browserReport(kind, id).archiveMatchedPositions,
      externalAcademicEvidence: [], archiveScore: 0, scoringNormalizationVersion: version,
    });
    assert.equal(resolution.scoringNormalizationVersion, version);
    const wrong = await persistRefreshedSimilarity(dbClient, { reportDeviceKey: acc.deviceKey, reportId: id }, { ...resolution, scoringNormalizationVersion: other });
    assert.equal(wrong.rowsAffected, 0);
    assert.equal("unifiedSimilarity" in (await rawRow(acc, id)), false);
    const right = await persistRefreshedSimilarity(dbClient, { reportDeviceKey: acc.deviceKey, reportId: id }, resolution);
    assert.equal(right.rowsAffected, 1);
    assert.equal(reportScoringNormalizationVersion(await rawRow(acc, id)), version, "a write-back never changes the stamp");

    // The Selective Corpus authoritative finalization write: same guard, on top of its own pending-status CAS.
    await dbClient.execute({
      sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.selectiveCorpusAuthoritativeStatus', 'pending') WHERE device_key = ? AND id = ?",
      args: [acc.deviceKey, id],
    });
    const finalization = { unifiedSimilarity: resolution.unifiedSimilarity, corpusSourceMatchingEnabled: true, corpusGeneration: resolution.corpusGeneration, terminalStatus: "completed" };
    const refused = await persistSelectiveCorpusAuthoritativeFinalization(dbClient, { reportDeviceKey: acc.deviceKey, reportId: id }, { ...finalization, scoringNormalizationVersion: other });
    assert.deepEqual(refused, { written: false, rowsAffected: 0 });
    assert.equal((await rawRow(acc, id)).selectiveCorpusAuthoritativeStatus, "pending");

    // The finalizer: Selective Corpus evidence computed under the other contract is not unioned in, and is not traded
    // for a zero-evidence "incomplete" either — the report stays pending for a run under its own contract.
    const selective = blockRange(MANUSCRIPT, GAP_THREE, version);
    const shadowResult = { state: "COMPLETED", evaluatorVersion: "fixture", verifiedEvidence: [{ sourceLabel: "S1", matchedPassages: [{ submittedWordStart: selective.start, submittedWordEnd: selective.end, matchedWordCount: selective.count }] }] };
    const beforeFinalizer = await rawRowText(acc, id);
    const mismatched = await finalizeSelectiveCorpusAuthoritativeReport(dbClient, {
      reportDeviceKey: acc.deviceKey, reportId: id, accountId: acc.userId, shadowResult, shadowScoringNormalizationVersion: other,
    });
    assert.deepEqual(mismatched, { outcome: "scoring-normalization-mismatch" });
    assert.equal(await rawRowText(acc, id), beforeFinalizer, "nothing written");
    const finalized = await finalizeSelectiveCorpusAuthoritativeReport(dbClient, {
      reportDeviceKey: acc.deviceKey, reportId: id, accountId: acc.userId, shadowResult, shadowScoringNormalizationVersion: version,
    });
    assert.deepEqual(finalized, { outcome: "finalized", status: "completed" });
    const final = decodeReportFromPersistence(await rawRow(acc, id));
    assert.equal(reportScoringNormalizationVersion(final), version, "the finalizer never re-stamps");
    assert.deepEqual(
      final.unifiedSimilarity.matchedPositions,
      [...new Set([...expectedPositions(MANUSCRIPT, version).all, ...span(selective)])].sort((a, b) => a - b),
      "resolved under the report's own contract (scholarly row, prior submission, imported evidence), with the Selective Corpus evidence of that same contract",
    );
  });

  test(`LIFECYCLE, v${version} report — the deferred evaluations run under the report's contract, not the build's`, async () => {
    const seen = [];
    await scheduleReportShadowEvaluations({
      reportDeviceKey: "snp-shadow-device", reportId: `snp-shadow-v${version}`, accountId: null, rawText: MANUSCRIPT,
      scoringNormalizationVersion: version,
      productionResult: { status: "UNAVAILABLE", computedAt: "2026-10-01T00:00:00.000Z", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x" },
      authoritativeUnifiedSimilarity: null, effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 0,
      authoritativeArchiveMatchedPositions: null, authoritativeExternalAcademicEvidence: null,
      includeSelectiveCorpus: false,
      openConnection: () => { seen.push(currentScoringNormalizationVersion()); return createClient({ url: `file:${dbFile}` }); },
    });
    assert.deepEqual(seen, [version]);
  });
}

// ══ the admin snapshot ════════════════════════════════════════════════════
for (const [kind, version] of [["Phase-A", 1], ["Phase-B", 2]]) {
  const other = version === 1 ? 2 : 1;

  test(`ADMIN SNAPSHOT, v${version} report with in-word invisible characters — the snapshot an admin is shown is in the report's own position space, and one from the other space is never shown`, async () => {
    const admin = await account({ admin: true });
    const id = `snp-admin-v${version}`;
    assert.equal((await firstSave(admin, kind, id)).res.status, 200);
    await assertSavedInContract(admin, id, version, "admin's report");

    // What the admin's GET attaches.
    const shown = (await get(admin, id)).historicalSubmissionMatch;
    assert.ok(shown, "the persisted snapshot is attached for an admin");
    assert.equal(shown.status, "MATCHED");
    assert.equal(shown.matcherVersion, snapshotMatcherVersion(version));
    const prior = blockRange(MANUSCRIPT, PRIOR, version);
    const spans = tokenSpans(MANUSCRIPT, version);
    for (const match of shown.matches) {
      for (const passage of match.passages) {
        assert.ok(passage.submittedWordStart >= prior.start && passage.submittedWordEnd <= prior.end, "inside the copied block, in the report's own space");
        // Rendered against the report's text under the report's contract, it is the copied block's characters.
        const shownText = MANUSCRIPT.slice(spans[passage.submittedWordStart].start, spans[passage.submittedWordEnd].end);
        assert.ok(PRIOR.includes(shownText), `the snapshot passage lights up copied text, not a neighbour: ${JSON.stringify(shownText.slice(0, 60))}`);
      }
    }
    assert.deepEqual(
      [...new Set(shown.matches.flatMap((m) => m.passages.flatMap((p) => span({ start: p.submittedWordStart, count: p.submittedWordEnd - p.submittedWordStart + 1 }))))].sort((a, b) => a - b),
      span(prior),
    );
    // A non-admin owner is never handed it.
    const owner = await account();
    assert.equal((await firstSave(owner, kind, id)).res.status, 200);
    assert.equal("historicalSubmissionMatch" in (await get(owner, id)), false);

    // Now the row holds a snapshot computed under the OTHER contract (as if something had computed this report's
    // snapshot under the build's own contract rather than the report's). Its positions are 35 words off in this
    // report's space — the admin's GET must not show it.
    const foreign = await getOrComputeHistoricalMatchSnapshot(dbClient, {
      reportDeviceKey: admin.deviceKey, reportId: id, accountId: admin.userId, rawText: MANUSCRIPT, scoringNormalizationVersion: other,
    });
    assert.equal(foreign.status, "MATCHED");
    assert.equal((await snapshotRow(admin, id)).matcherVersion, snapshotMatcherVersion(other));
    const otherPrior = blockRange(MANUSCRIPT, PRIOR, other);
    assert.equal(foreign.matches[0].passages[0].submittedWordStart, otherPrior.start, "it really is in the other space");
    assert.notEqual(otherPrior.start, prior.start);
    const reportBefore = await rawRowText(admin, id);
    const after = await get(admin, id);
    assert.equal("historicalSubmissionMatch" in after, false, `a v${other}-space snapshot is not shown on a v${version} report`);
    assert.equal(await rawRowText(admin, id), reportBefore, "the GET still wrote nothing");
    assert.equal((await snapshotRow(admin, id)).matcherVersion, snapshotMatcherVersion(other), "…and did not recompute the snapshot either");

    // The display resolver sees the same row as not current for this report (never as a reusable result)…
    const saved = decodeReportFromPersistence(await rawRow(admin, id));
    const display = await resolvePersistedSimilarityDisplay(dbClient, {
      reportDeviceKey: admin.deviceKey, reportId: id, archiveScore: 0, unifiedScore: saved.unifiedSimilarity.unifiedScore, hasUnifiedSimilarity: true,
      corpusSourceMatchingEnabledAtComputation: saved.corpusSourceMatchingEnabledAtComputation, unifiedSimilarityFailed: false, hasPositionEvidence: true,
      scoringNormalizationVersion: saved.scoringNormalizationVersion,
    });
    assert.equal(display.status, "stale");
    // …and the next write-capable resolution replaces it under the report's own contract.
    assert.equal((await post(admin, id, browserReport(kind, id))).status, 200);
    await assertSavedInContract(admin, id, version, "after the next save");
    assert.ok((await get(admin, id)).historicalSubmissionMatch, "shown again, in the report's own space");
  });
}
