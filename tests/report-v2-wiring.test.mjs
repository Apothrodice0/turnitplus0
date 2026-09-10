import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';
import { tokens } from '../lib/similarity-core.ts';
import {
  withEvidenceInterpretation,
  stripClientEvidenceInterpretation,
  CLIENT_UNTRUSTED_EVIDENCE_INTERPRETATION_KEYS,
} from '../lib/report-evidence-interpretation.ts';
import { attachEvidenceInterpretation } from '../lib/document-check-pipeline.ts';
import {
  EVIDENCE_INTERPRETATION_VERSION,
  EVIDENCE_INTERPRETATION_KINDS,
} from '../lib/evidence-interpretation/index.ts';

/**
 * REPORT V2 — WIRE EVIDENCE INTERPRETATION INTO REAL REPORTS.
 *
 * Proves the additive `evidenceInterpretation` / `reportCompletion` /
 * `extractionDiagnostic` contract is:
 *   - produced server-side on the real POST /api/reports write path and
 *     persisted inside payload_json (no migration),
 *   - recomputed server-side on the real GET /api/reports/[id] read path,
 *   - never authoritatively accepted from the client (same trust boundary as
 *     scholarly evidence),
 *   - purely additive — the authoritative unified similarity number and the
 *     authoritative matched-position union are byte-identical with and without
 *     the wiring,
 *   - a disjoint partition of the authoritative matched-position union
 *     (`positionsByKind` reconciles exactly),
 *   - dormant for POSSIBLE_SAME_WORK on historical evidence,
 *   - free of internal identifiers / hashes / filesystem paths in the ordinary
 *     (non-admin) response,
 *   - backward compatible: an old row with none of the fields still loads.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_v2_wiring.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';
// Selective Corpus shadow stays OFF for the whole suite — Phase 6 requires that
// a disabled Selective Corpus branch never makes a report PARTIAL and never
// claims a search ran.
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;

const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

let userCounter = 0;
async function signUpAccount() {
  userCounter += 1;
  const email = `report-v2-wiring-user-${userCounter}@example.test`;
  await resetAuthRateForTest('report-v2-wiring-signup-' + userCounter);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'report-v2-wiring-signup-' + userCounter },
    body: JSON.stringify(withTestIdentity({
      email, password: 'report-v2-wiring-pw-1', username: `rv2user${userCounter}`,
      deviceKey: `report-v2-wiring-device-${userCounter}`,
    })),
  });
  const res = await signupRoute.POST(req);
  assert.equal(res.status, 201, 'test setup sanity: signup must succeed');
  const cookie = extractCookie(res);
  const row = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return { userId: row.rows[0].id, deviceKey: `report-v2-wiring-device-${userCounter}`, cookie, tag: `report-v2-wiring-${userCounter}` };
}

// A submission whose token stream is exactly "word0 word1 ... word{N-1}", so a
// matched-position array maps 1:1 onto predictable word indices.
const WORD_COUNT = 160;
const DOC_TEXT = Array.from({ length: WORD_COUNT }, (_, i) => `word${i}`).join(' ');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ARCHIVE_POSITIONS = range(6, 56); // 51 contiguous words

function basePayload(id) {
  return {
    version: 11, id, submissionId: 'sub-' + id, title: 'Report V2 wiring fixture',
    author: '', assignment: '', created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount: WORD_COUNT,
    scoreBand: 'Low', matchedWordCount: 0, sources: [], repeats: [], text: DOC_TEXT,
  };
}

async function postReport(account, { id, room = 0, aiStatus = 'ready', payloadOverrides = {} }) {
  await resetRateForTest(account.tag + '-post');
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': account.tag + '-post', cookie: `tp_session_v1=${account.cookie}` },
    body: JSON.stringify({
      deviceKey: account.deviceKey, id, submissionId: 'sub-' + id,
      title: 'Report V2 wiring fixture', createdAt: new Date().toISOString(),
      wordCount: WORD_COUNT, archiveScore: 0, scoreBand: 'Low',
      aiScore: aiStatus === 'ready' ? 2 : null, aiTone: aiStatus === 'ready' ? 'low' : null, aiStatus, room,
      payload: { ...basePayload(id), ...payloadOverrides },
    }),
  });
  return reportsRoute.POST(req);
}

async function getReport(account, id) {
  await resetReadRateForTest(account.tag + '-get');
  const req = new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(account.deviceKey)}`, {
    headers: { 'x-forwarded-for': account.tag + '-get', cookie: `tp_session_v1=${account.cookie}` },
  });
  const res = await reportIdRoute.GET(req, { params: Promise.resolve({ id: String(id) }) });
  return res;
}

async function dbRow(deviceKey, id) {
  const result = await client.execute({
    sql: 'SELECT archive_score, payload_json FROM saved_reports WHERE device_key = ? AND id = ?',
    args: [deviceKey, id],
  });
  const row = result.rows[0];
  return row ? { archiveScore: Number(row.archive_score), payload: JSON.parse(String(row.payload_json)), raw: String(row.payload_json) } : null;
}

const reconciles = (ei) => {
  const total = Object.values(ei.countsByKind).reduce((a, b) => a + b, 0);
  const partition = EVIDENCE_INTERPRETATION_KINDS.reduce((n, k) => n + ei.positionsByKind[k].length, 0);
  const all = [];
  for (const k of EVIDENCE_INTERPRETATION_KINDS) all.push(...ei.positionsByKind[k]);
  const disjoint = all.length === new Set(all).size;
  return total === ei.matchedWordCount && partition === ei.matchedWordCount && disjoint;
};

// A strong (forged) historical-submission match — the strongest signal the
// data model can carry. Same-work must stay dormant against it.
const STRONG_SELF_HISTORICAL = {
  status: 'MATCHED', computedAt: 'x', matcherVersion: 'x', fingerprintVersion: 'x', canonicalizationVersion: 'x',
  matches: [{
    relationshipType: 'SELF', matchType: 'EXACT_CANONICAL_MATCH', matchedRepresentationId: 'rep-INTERNAL-SECRET',
    containment: 1, matchedWordCount: ARCHIVE_POSITIONS.length, passageCount: 1,
    longestMatchWords: ARCHIVE_POSITIONS.length, passages: [], historicalSubmissionCount: 4,
  }],
};

// ───────────────────────────────────────────────────────────────────────────
// 1 + 2 — a new report gets evidenceInterpretation AND reportCompletion
// ───────────────────────────────────────────────────────────────────────────
test('1+2: a brand-new report saved through the real POST route gets evidenceInterpretation + reportCompletion persisted', async () => {
  const account = await signUpAccount();
  const id = 'rv2-new-1';
  const res = await postReport(account, {
    id,
    payloadOverrides: {
      archiveMatchedPositions: ARCHIVE_POSITIONS,
      sources: [{ name: 'Wikipedia — “Photosynthesis”', type: 'Internet', percent: 30, matches: 2, matchedWords: 51, phrases: [], color: '#123' }],
    },
  });
  assert.equal(res.status, 200, 'first save must succeed');

  const { payload } = await dbRow(account.deviceKey, id);
  assert.ok(payload.unifiedSimilarity, 'sanity: write-time finalization persisted unifiedSimilarity');

  // (1) evidenceInterpretation
  assert.ok(payload.evidenceInterpretation, 'evidenceInterpretation must be persisted on the first save');
  assert.equal(payload.evidenceInterpretation.version, EVIDENCE_INTERPRETATION_VERSION);
  assert.equal(payload.evidenceInterpretation.matchedWordCount, payload.unifiedSimilarity.matchedPositions.length);
  assert.ok(reconciles(payload.evidenceInterpretation), 'positionsByKind reconciles exactly with the authoritative union');
  assert.equal(payload.evidenceInterpretation.countsByKind.DISTINCTIVE_EXTERNAL_MATCH, ARCHIVE_POSITIONS.length,
    'ordinary archive overlap => DISTINCTIVE_EXTERNAL_MATCH');

  // (2) reportCompletion — clean run, no branch disabled-claim
  assert.ok(payload.reportCompletion, 'reportCompletion must be persisted on the first save');
  assert.equal(payload.reportCompletion.state, 'COMPLETED', 'a clean run with UNKNOWN extraction is COMPLETED, not PARTIAL');
  assert.equal(payload.reportCompletion.signals.selectiveCorpus, null, 'Selective Corpus disabled => never claims a search ran');
  assert.equal(payload.reportCompletion.detail, null);

  // extractionDiagnostic — persisted UNKNOWN (never inferred to EXTRACTION_PARTIAL)
  assert.ok(payload.extractionDiagnostic, 'extractionDiagnostic must be persisted');
  assert.equal(payload.extractionDiagnostic.completeness, 'UNKNOWN');
});

// ───────────────────────────────────────────────────────────────────────────
// 3 — persisted report reload preserves both  (GET recomputes an equivalent)
// ───────────────────────────────────────────────────────────────────────────
test('3: reloading a persisted report through the real GET route returns evidenceInterpretation + reportCompletion', async () => {
  const account = await signUpAccount();
  const id = 'rv2-reload-1';
  await postReport(account, {
    id,
    payloadOverrides: {
      archiveMatchedPositions: ARCHIVE_POSITIONS,
      sources: [{ name: 'Some Journal', type: 'Publication', percent: 12, matches: 1, matchedWords: 51, phrases: [], color: '#0' }],
    },
  });

  const res = await getReport(account, id);
  assert.equal(res.status, 200);
  const { payload } = await res.json();
  assert.ok(payload.evidenceInterpretation, 'GET response carries evidenceInterpretation');
  assert.ok(payload.reportCompletion, 'GET response carries reportCompletion');
  assert.ok(payload.extractionDiagnostic, 'GET response carries extractionDiagnostic');
  assert.equal(payload.evidenceInterpretation.version, EVIDENCE_INTERPRETATION_VERSION);
  assert.equal(payload.evidenceInterpretation.matchedWordCount, payload.unifiedSimilarity.matchedPositions.length);
  assert.ok(reconciles(payload.evidenceInterpretation));
  assert.equal(payload.reportCompletion.state, 'COMPLETED');

  // The SSR/first-paint value (straight row read) also has them.
  const { payload: rowPayload } = await dbRow(account.deviceKey, id);
  assert.ok(rowPayload.evidenceInterpretation && rowPayload.reportCompletion,
    'the persisted row (what app/reports/[id]/page.tsx reads for SSR) carries both');
});

// ───────────────────────────────────────────────────────────────────────────
// 4 — resave preserves both
// ───────────────────────────────────────────────────────────────────────────
test('4: a resave (AI completion) keeps evidenceInterpretation + reportCompletion and does not regress them', async () => {
  const account = await signUpAccount();
  const id = 'rv2-resave-1';
  await postReport(account, {
    id, aiStatus: 'processing',
    payloadOverrides: { archiveMatchedPositions: ARCHIVE_POSITIONS },
  });
  const first = await dbRow(account.deviceKey, id);
  assert.ok(first.payload.evidenceInterpretation && first.payload.reportCompletion);

  // Resave — exactly what saveEnrichedAiResult submits: a client payload that
  // carries a stale/forged interpretation from the prior client copy.
  const res = await postReport(account, {
    id, aiStatus: 'ready',
    payloadOverrides: {
      archiveMatchedPositions: ARCHIVE_POSITIONS,
      evidenceInterpretation: { version: 'FORGED', positionsByKind: {}, countsByKind: {}, matchedWordCount: 9999, sources: [], passages: [], deferredKindsFolded: false },
      reportCompletion: { state: 'EXTRACTION_PARTIAL', headline: 'FORGED', detail: 'FORGED', reasons: [], signals: {} },
    },
  });
  assert.equal(res.status, 200);
  const after = await dbRow(account.deviceKey, id);
  assert.ok(after.payload.evidenceInterpretation && after.payload.reportCompletion, 'both survive the resave');
  assert.equal(after.payload.evidenceInterpretation.version, EVIDENCE_INTERPRETATION_VERSION, 'server version, not the forged one');
  assert.notEqual(after.payload.evidenceInterpretation.matchedWordCount, 9999, 'forged count did not survive');
  assert.equal(after.payload.reportCompletion.state, 'COMPLETED', 'forged EXTRACTION_PARTIAL did not survive');
  assert.equal(after.payload.evidenceInterpretation.matchedWordCount, after.payload.unifiedSimilarity.matchedPositions.length);
});

// ───────────────────────────────────────────────────────────────────────────
// 5 — old report without the fields loads correctly
// ───────────────────────────────────────────────────────────────────────────
test('5: a legacy row with none of the new fields still loads (POST-compatible, GET recomputes, SSR read parses)', async () => {
  const account = await signUpAccount();
  const id = 'rv2-legacy-1';
  await postReport(account, {
    id,
    payloadOverrides: {
      archiveMatchedPositions: ARCHIVE_POSITIONS,
      sources: [{ name: 'Wikipedia — “Cell”', type: 'Internet', percent: 30, matches: 2, matchedWords: 51, phrases: [], color: '#0' }],
    },
  });
  // Strip the new fields from the stored row — a report saved before this wiring existed.
  await client.execute({
    sql: `UPDATE saved_reports SET payload_json = json_remove(payload_json, '$.evidenceInterpretation', '$.reportCompletion', '$.extractionDiagnostic') WHERE device_key = ? AND id = ?`,
    args: [account.deviceKey, id],
  });
  const legacy = await dbRow(account.deviceKey, id);
  assert.equal(legacy.payload.evidenceInterpretation, undefined, 'sanity: the row is now legacy-shaped');
  assert.ok(legacy.payload.unifiedSimilarity, 'the authoritative similarity is untouched by the strip');

  // GET still 200s and self-heals the interpretation onto the response.
  const res = await getReport(account, id);
  assert.equal(res.status, 200, 'a legacy report must still load');
  const { payload } = await res.json();
  assert.ok(payload.evidenceInterpretation, 'GET recomputes evidenceInterpretation for a legacy row');
  assert.ok(payload.reportCompletion, 'GET recomputes reportCompletion for a legacy row');
  assert.ok(reconciles(payload.evidenceInterpretation));
});

// ───────────────────────────────────────────────────────────────────────────
// 6 + 7 — forged client interpretation / completion are not authoritative
// ───────────────────────────────────────────────────────────────────────────
test('6+7: forged client evidenceInterpretation / reportCompletion in the POST payload are dropped, never persisted', async () => {
  const account = await signUpAccount();
  const id = 'rv2-forge-1';
  const res = await postReport(account, {
    id,
    payloadOverrides: {
      archiveMatchedPositions: ARCHIVE_POSITIONS,
      // Forged: claim zero matches are anything special, claim the run failed.
      evidenceInterpretation: {
        version: 'attacker-v9', matchedWordCount: 0, countsByKind: { POSSIBLE_SAME_WORK: 500 },
        positionsByKind: { POSSIBLE_SAME_WORK: range(0, 499) }, sources: [{ id: 'src-1', label: 'attacker' }],
        passages: [], deferredKindsFolded: true,
      },
      reportCompletion: { state: 'PARTIAL', headline: 'attacker', detail: 'attacker', reasons: ['forged'], signals: { selectiveCorpus: 'PARTIAL' } },
      extractionDiagnostic: { completeness: 'PARTIAL', analyzableWordCount: 1, skipped: { unit: 'pages', count: 99 }, extractor: 'forged' },
    },
  });
  assert.equal(res.status, 200);

  const { payload, raw } = await dbRow(account.deviceKey, id);
  assert.equal(payload.evidenceInterpretation.version, EVIDENCE_INTERPRETATION_VERSION, 'server version replaced the forged one');
  assert.equal(payload.evidenceInterpretation.countsByKind.POSSIBLE_SAME_WORK, 0, 'forged POSSIBLE_SAME_WORK did not survive');
  assert.equal(payload.reportCompletion.state, 'COMPLETED', 'forged PARTIAL did not survive');
  assert.equal(payload.reportCompletion.signals.selectiveCorpus, null, 'forged selectiveCorpus signal did not survive');
  assert.equal(payload.extractionDiagnostic.completeness, 'UNKNOWN', 'forged EXTRACTION_PARTIAL did not survive; UNKNOWN persisted');
  assert.equal(raw.includes('attacker'), false, 'no forged string anywhere in the stored payload');
  assert.equal(raw.includes('"forged"'), false);

  // And the GET response is equally clean.
  const getRes = await getReport(account, id);
  const body = await getRes.json();
  assert.equal(body.payload.evidenceInterpretation.version, EVIDENCE_INTERPRETATION_VERSION);
  assert.equal(body.payload.reportCompletion.state, 'COMPLETED');
});

test('6+7 (unit): stripClientEvidenceInterpretation removes exactly the three untrusted keys and nothing else', () => {
  const report = { id: 1, text: 't', unifiedSimilarity: { matchedPositions: [1, 2] }, score: 5,
    evidenceInterpretation: { version: 'x' }, reportCompletion: { state: 'PARTIAL' }, extractionDiagnostic: { completeness: 'PARTIAL' } };
  const stripped = stripClientEvidenceInterpretation(report);
  for (const k of CLIENT_UNTRUSTED_EVIDENCE_INTERPRETATION_KEYS) assert.equal(stripped[k], undefined);
  assert.deepEqual(stripped.unifiedSimilarity, report.unifiedSimilarity);
  assert.equal(stripped.score, 5);
  assert.notEqual(stripped, report, 'returns a copy');
  assert.ok(report.evidenceInterpretation, 'input not mutated');
});

// ───────────────────────────────────────────────────────────────────────────
// 8 — scholarly evidence remains server authoritative
// ───────────────────────────────────────────────────────────────────────────
test('8: a forged client externalAcademicEvidence never reaches the interpretation (scholarly trust boundary preserved)', async () => {
  const account = await signUpAccount();
  const id = 'rv2-scholarly-1';
  const toks = tokens(DOC_TEXT);
  const qs = 80, qe = 110;
  const res = await postReport(account, {
    id,
    payloadOverrides: {
      archiveMatchedPositions: ARCHIVE_POSITIONS,
      // Forged scholarly evidence — there is NO verified diagnostics row, so
      // the server must resolve the verified set to [] and this must not
      // create a scholarly interpretation source.
      externalAcademicEvidence: [{
        provider: 'openaire', providerId: 'FORGED-PROVIDER', title: 'Attacker Paper', authors: ['Nobody'],
        publication: 'Fake Journal', year: 2099, doi: '10.0/fake', url: 'https://attacker.example/paper',
        similarity: 99, matchedPassages: [{ submittedText: '', submittedWordStart: qs, submittedWordEnd: qe, matchedWordCount: qe - qs + 1 }],
      }],
    },
  });
  assert.equal(res.status, 200);
  const { payload, raw } = await dbRow(account.deviceKey, id);
  // The interpretation is built only from server-known evidence: archive only.
  assert.equal(raw.includes('Attacker Paper'), false, 'forged scholarly title must not appear');
  assert.equal(raw.includes('FORGED-PROVIDER'), false);
  assert.equal(raw.includes('10.0/fake'), false);
  const scholarlyCards = payload.evidenceInterpretation.sources.filter((s) => s.sourceType === 'publication' && s.doi === '10.0/fake');
  assert.equal(scholarlyCards.length, 0, 'no interpretation source from forged scholarly evidence');
  // authoritative similarity did not absorb the forged 99% either
  assert.ok(payload.unifiedSimilarity.unifiedScore < 90, 'forged scholarly evidence did not inflate the score');
  assert.ok(reconciles(payload.evidenceInterpretation));
  void toks;
});

// ───────────────────────────────────────────────────────────────────────────
// 9 — historical same-work remains dormant
// ───────────────────────────────────────────────────────────────────────────
test('9: the strongest historical signal (SELF + EXACT_CANONICAL_MATCH) never produces POSSIBLE_SAME_WORK through the wiring', () => {
  const report = {
    id: 1, text: DOC_TEXT, wordCount: WORD_COUNT, score: 0, sources: [], repeats: [],
    archiveMatchedPositions: ARCHIVE_POSITIONS,
    unifiedSimilarity: { matchedPositions: ARCHIVE_POSITIONS, previousUploadPositions: ARCHIVE_POSITIONS, unifiedScore: 32 },
  };
  const wired = withEvidenceInterpretation(report, { historicalSubmissionMatch: STRONG_SELF_HISTORICAL, selectiveCorpusBranch: null });
  assert.equal(wired.evidenceInterpretation.countsByKind.POSSIBLE_SAME_WORK, 0);
  assert.equal(wired.evidenceInterpretation.countsByKind.DISTINCTIVE_EXTERNAL_MATCH, ARCHIVE_POSITIONS.length);
  const blob = JSON.stringify(wired.evidenceInterpretation);
  assert.equal(blob.includes('rep-INTERNAL-SECRET'), false, 'internal representation id never leaks');
  assert.equal(/SELF|PRIOR_SUBMISSION|historicalSubmissionCount/.test(blob), false);
  assert.ok(reconciles(wired.evidenceInterpretation));
});

// ───────────────────────────────────────────────────────────────────────────
// 10 — positionsByKind still reconciles exactly (mixed source set)
// ───────────────────────────────────────────────────────────────────────────
test('10: positionsByKind is a disjoint partition of the authoritative union (mixed archive + prior positions)', () => {
  const priorPos = range(120, 150);
  const union = [...new Set([...ARCHIVE_POSITIONS, ...priorPos])].sort((a, b) => a - b);
  const report = {
    id: 1, text: DOC_TEXT, wordCount: WORD_COUNT, score: 0,
    archiveMatchedPositions: ARCHIVE_POSITIONS,
    sources: [{ name: 'Ref A', type: 'Internet', percent: 32, matches: 2, matchedWords: 51, phrases: [], color: '#0' }],
    repeats: [],
    unifiedSimilarity: { matchedPositions: union, previousUploadPositions: priorPos, unifiedScore: 51 },
  };
  const wired = withEvidenceInterpretation(report, { historicalSubmissionMatch: STRONG_SELF_HISTORICAL, selectiveCorpusBranch: null });
  const ei = wired.evidenceInterpretation;
  assert.equal(ei.matchedWordCount, union.length);
  assert.ok(reconciles(ei));
  const all = [];
  for (const k of EVIDENCE_INTERPRETATION_KINDS) all.push(...ei.positionsByKind[k]);
  assert.deepEqual([...new Set(all)].sort((a, b) => a - b), union, 'every authoritative position lands in exactly one kind');
  assert.equal(ei.countsByKind.POSSIBLE_SAME_WORK, 0);
  assert.equal(ei.countsByKind.DISTINCTIVE_EXTERNAL_MATCH, union.length);
});

// ───────────────────────────────────────────────────────────────────────────
// 11 + 12 — authoritative similarity + matched positions byte-identical
// ───────────────────────────────────────────────────────────────────────────
test('11+12: withEvidenceInterpretation is purely additive — unifiedSimilarity and every non-new field are byte-identical', () => {
  const report = {
    id: 7, text: DOC_TEXT, wordCount: WORD_COUNT, score: 13, scoreBand: 'Low', sources: [], repeats: [],
    archiveMatchedPositions: ARCHIVE_POSITIONS,
    unifiedSimilarity: {
      matchedPositions: ARCHIVE_POSITIONS, previousUploadPositions: [], unifiedScore: 32, uniqueMatchedWords: 51,
      contributions: [{ sourceId: 'x', matchedWords: 51 }],
    },
  };
  const beforeUnified = JSON.stringify(report.unifiedSimilarity);
  const beforePositions = JSON.stringify(report.unifiedSimilarity.matchedPositions);
  const beforeWhole = JSON.stringify(report);

  const wired = withEvidenceInterpretation(report, { selectiveCorpusBranch: null });

  assert.equal(JSON.stringify(report), beforeWhole, 'input object not mutated');
  assert.equal(JSON.stringify(wired.unifiedSimilarity), beforeUnified, 'unifiedSimilarity byte-identical');
  assert.equal(JSON.stringify(wired.unifiedSimilarity.matchedPositions), beforePositions, 'matched positions byte-identical');
  assert.equal(wired.score, 13);
  assert.equal(wired.scoreBand, 'Low');

  // strip the 3 new keys back off -> identical to the original
  const rt = stripClientEvidenceInterpretation(wired);
  assert.equal(JSON.stringify(rt), beforeWhole, 'wiring adds ONLY the three additive keys');
});

test('11+12 (through routes): the persisted authoritative fields match a from-scratch recompute', async () => {
  const account = await signUpAccount();
  const id = 'rv2-additive-1';
  await postReport(account, {
    id,
    payloadOverrides: {
      archiveMatchedPositions: ARCHIVE_POSITIONS,
      sources: [{ name: 'Ref', type: 'Internet', percent: 32, matches: 1, matchedWords: 51, phrases: [], color: '#0' }],
    },
  });
  const { payload } = await dbRow(account.deviceKey, id);
  // Re-strip and re-wire the persisted payload: the authoritative fields must be
  // untouched, and re-wiring is idempotent.
  const rewired = withEvidenceInterpretation(stripClientEvidenceInterpretation(payload), { selectiveCorpusBranch: null });
  assert.equal(JSON.stringify(rewired.unifiedSimilarity), JSON.stringify(payload.unifiedSimilarity), 'unifiedSimilarity stable under re-wire');
  assert.deepEqual(rewired.evidenceInterpretation.positionsByKind, payload.evidenceInterpretation.positionsByKind, 'interpretation is deterministic / idempotent');
  assert.equal(payload.evidenceInterpretation.matchedWordCount, payload.unifiedSimilarity.matchedPositions.length);
});

// ───────────────────────────────────────────────────────────────────────────
// 13 — Selective Corpus flag OFF remains zero-I/O / never claims a search
// ───────────────────────────────────────────────────────────────────────────
test('13: Selective Corpus disabled => reportCompletion never PARTIAL from it, never claims the branch ran, no shard access', async () => {
  assert.equal(process.env.SELECTIVE_CORPUS_SHADOW_ENABLED, undefined, 'flag is OFF for this suite');
  const account = await signUpAccount();
  const id = 'rv2-sc-off-1';
  await postReport(account, { id, payloadOverrides: { archiveMatchedPositions: ARCHIVE_POSITIONS } });
  const { payload } = await dbRow(account.deviceKey, id);
  assert.equal(payload.reportCompletion.state, 'COMPLETED');
  assert.equal(payload.reportCompletion.signals.selectiveCorpus, null, 'no Selective Corpus branch state is claimed');
  assert.equal(/reference index/.test(payload.reportCompletion.reasons.join(' ')), false, 'no "reference index" reason when the branch is off');

  // The wiring module graph never imports the shard reader / shadow evaluator /
  // fs — proven statically: withEvidenceInterpretation only pulls in
  // lib/evidence-interpretation/*, which has no fs or selective-corpus module
  // import (see this suite's companion static check below).
  const wiringSrc = fs.readFileSync(path.join(repo, 'lib/report-evidence-interpretation.ts'), 'utf8');
  assert.equal(/selective-corpus\/(shard|shadow)|['"]fs['"]|node:fs/.test(wiringSrc), false);
});

test('13 (static): the evidence-interpretation layer imports no fs and no selective-corpus runtime module', () => {
  const dir = path.join(repo, 'lib/evidence-interpretation');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const importLines = src.split('\n').filter((l) => /^\s*import\s/.test(l) || /from\s+['"]/.test(l));
    for (const l of importLines) {
      assert.equal(/from\s+['"](node:)?fs['"]/.test(l), false, `${f}: no fs import (${l.trim()})`);
      assert.equal(/from\s+['"][^'"]*selective-corpus\/(shard-reader|shadow|artifact|postings)/.test(l), false, `${f}: no selective-corpus runtime import (${l.trim()})`);
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 14 — ordinary GET/SSR privacy remains clean
// ───────────────────────────────────────────────────────────────────────────
test('14: the ordinary (non-admin) GET response carries no internal id / hash / filesystem path in the V2 fields', async () => {
  const account = await signUpAccount();
  const id = 'rv2-privacy-1';
  await postReport(account, {
    id,
    payloadOverrides: {
      archiveMatchedPositions: ARCHIVE_POSITIONS,
      sources: [{ name: 'Wikipedia — “Mitochondrion”', type: 'Internet', percent: 30, matches: 2, matchedWords: 51, phrases: [], color: '#0' }],
      unifiedSimilarity: {
        matchedPositions: ARCHIVE_POSITIONS, previousUploadPositions: [],
        contributions: [{ matchedRepresentationId: 'rep-LEAK', sourceId: 'scb-000042' }],
      },
    },
  });
  const res = await getReport(account, id);
  assert.equal(res.status, 200);
  const { payload } = await res.json();
  const v2Blob = JSON.stringify({
    evidenceInterpretation: payload.evidenceInterpretation,
    reportCompletion: payload.reportCompletion,
    extractionDiagnostic: payload.extractionDiagnostic,
  });
  for (const bad of ['rep-LEAK', 'scb-000042', 'matchedRepresentationId', 'verifiedAcademicSearchDiagnosticsId', 'device-', 'C:\\\\', '/home/', '/Users/']) {
    assert.equal(v2Blob.includes(bad), false, `V2 fields must not contain ${bad}`);
  }
  assert.equal(/[0-9a-f]{32}/.test(v2Blob), false, 'no 32-hex digest in the V2 fields');
  assert.equal(/[A-Za-z]:\\|\\\\\\\\|\/lib\//.test(v2Blob), false, 'no filesystem path in the V2 fields');
  // opaque source ids only
  for (const s of payload.evidenceInterpretation.sources) assert.match(s.id, /^src-\d+$/);
  // non-admin viewer: contributions were stripped, and never re-leaked via V2
  assert.deepEqual(payload.unifiedSimilarity.contributions, [], 'non-admin contributions still stripped');
});

// ───────────────────────────────────────────────────────────────────────────
// 15 — download / report serialization remains compatible
// ───────────────────────────────────────────────────────────────────────────
test('15: a report carrying the V2 fields still round-trips through JSON and keeps every legacy field', async () => {
  const account = await signUpAccount();
  const id = 'rv2-serialize-1';
  await postReport(account, {
    id,
    payloadOverrides: {
      archiveMatchedPositions: ARCHIVE_POSITIONS,
      sources: [{ name: 'Ref', type: 'Internet', percent: 32, matches: 1, matchedWords: 51, phrases: [], color: '#0' }],
    },
  });
  const res = await getReport(account, id);
  const { payload } = await res.json();

  // Full JSON round-trip is stable (what the receipt/PDF/DOCX download paths do).
  const rt = JSON.parse(JSON.stringify(payload));
  assert.deepEqual(rt, payload, 'payload is JSON-stable with the V2 fields present');

  // Legacy fields the download/summary paths rely on are all still there.
  for (const k of ['version', 'id', 'submissionId', 'title', 'wordCount', 'scoreBand', 'text', 'sources', 'unifiedSimilarity']) {
    assert.ok(k in payload, `legacy field ${k} preserved`);
  }
  // Adding V2 fields did not disturb the authoritative similarity shape.
  assert.equal(typeof payload.unifiedSimilarity.unifiedScore, 'number');
  assert.ok(Array.isArray(payload.unifiedSimilarity.matchedPositions));

  // The client-side enrichment path is also a no-op-safe pure function.
  const enrichedTwice = attachEvidenceInterpretation(attachEvidenceInterpretation(payload));
  assert.equal(enrichedTwice.evidenceInterpretation.version, EVIDENCE_INTERPRETATION_VERSION);
  assert.equal(enrichedTwice.evidenceInterpretation.matchedWordCount, payload.unifiedSimilarity.matchedPositions.length);
});

// ───────────────────────────────────────────────────────────────────────────
// client enrichment (app/page.tsx + room shell) — pure, defensive
// ───────────────────────────────────────────────────────────────────────────
test('attachEvidenceInterpretation: pure, never throws, returns the report on a malformed input', () => {
  const ok = attachEvidenceInterpretation({ id: 1, text: DOC_TEXT, wordCount: WORD_COUNT, score: 0, sources: [], repeats: [], archiveMatchedPositions: ARCHIVE_POSITIONS, unifiedSimilarity: { matchedPositions: ARCHIVE_POSITIONS, previousUploadPositions: [] } });
  assert.ok(ok.evidenceInterpretation);
  // malformed / partial report -> falls back to the input, no throw
  const weird = attachEvidenceInterpretation({});
  assert.equal(typeof weird, 'object');
});
