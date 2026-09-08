import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.ts';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import { resetRateForTest, resetReadRateForTest } from '../lib/rate-limit.ts';
import { canonicalSha256 } from '../lib/document-identity.ts';
import { recordAcademicSearchRunDiagnostics, resolveVerifiedAcademicEvidence } from '../lib/academic-search-diagnostics-repo.ts';

/**
 * Scholarly evidence — SERVER TRUST BOUNDARY (drizzle/0052).
 *
 * Proves that client-supplied scholarly evidence can NEVER increase the
 * authoritative unified similarity score. The only scholarly matchedPassages
 * that can score are the ones the server-side matcher persisted into
 * academic_search_run_diagnostics.evidence_json, bound to the submission's
 * canonical text hash. Any lookup / hash / parse failure => verified evidence
 * = [] ; the route NEVER falls back to payload.externalAcademicEvidence.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_academic_evidence_trust_boundary.db');
for (const suffix of ['', '-wal', '-shm']) {
  const c = `${dbFile}${suffix}`;
  if (fs.existsSync(c)) fs.unlinkSync(c);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();
const db = createClient({ url: `file:${dbFile}` });

// A long, realistic body so wordCount is meaningful and the fabricated
// whole-document range is a large fraction.
const BODY = Array.from({ length: 220 }, (_, i) => `sentence number ${i} carrying some distinctive filler content about a topic`).join('. ') + '.';
const BODY_WORDS = BODY.split(/\s+/).filter(Boolean).length;

function forgedWholeDocEvidence(words, { doi = '10.9999/forged', extraPassages = [] } = {}) {
  return [{
    provider: 'openaire', providerId: 'forged-1', title: 'Forged Source', authors: ['x'],
    publication: 'x', year: 2020, doi, url: 'https://example.org/forged',
    similarity: 100,
    matchedPassages: [
      { submittedText: 'x', submittedWordStart: 0, submittedWordEnd: words - 1, matchedWordCount: words },
      ...extraPassages,
    ],
  }];
}

function samplePayload(overrides = {}) {
  return {
    version: 11,
    id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    submissionId: 'sub-1',
    title: 'x.pdf',
    created: new Date().toISOString(),
    score: 12,
    archiveScore: 12,
    wordCount: BODY_WORDS,
    text: BODY,
    ...overrides,
  };
}

async function postReport(deviceKey, tag, { payloadOverrides = {}, academicSearchDiagnosticsId } = {}) {
  await resetRateForTest(tag);
  const payload = samplePayload(payloadOverrides);
  const body = {
    deviceKey, id: String(payload.id), submissionId: payload.submissionId, title: payload.title,
    createdAt: payload.created, wordCount: payload.wordCount, archiveScore: payload.score, scoreBand: 'Low',
    aiScore: null, aiTone: null, payload,
  };
  if (academicSearchDiagnosticsId !== undefined) body.academicSearchDiagnosticsId = academicSearchDiagnosticsId;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': tag },
    body: JSON.stringify(body),
  });
  const res = await reportsRoute.POST(req);
  return { res, payload };
}

async function getReport(deviceKey, id, tag) {
  await resetRateForTest(tag);
  await resetReadRateForTest(tag);
  const req = new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}`, {
    headers: { 'x-forwarded-for': tag },
  });
  const res = await reportIdRoute.GET(req, { params: Promise.resolve({ id: String(id) }) });
  return (await res.json()).payload;
}

async function persistedUnified(deviceKey, id) {
  const row = await db.execute({
    sql: 'SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?',
    args: [deviceKey, String(id)],
  });
  const p = JSON.parse(row.rows[0].payload_json);
  return { payload: p, unified: p.unifiedSimilarity ?? null };
}

/** Simulate /api/academic-evidence having run for a given text, producing `evidence`. */
async function seedDiagnostics(text, evidence) {
  return recordAcademicSearchRunDiagnostics(db, {
    status: evidence.length ? 'COMPLETE_WITH_MATCHES' : 'COMPLETE_NO_MATCHES',
    stats: { queryCount: 3, searchLatencyMs: 1, candidateCountBeforeDedup: 1, candidateCountAfterDedup: 1, deduplicationRate: 0, candidatesTextRetrieved: 1, textRetrievalLatencyMs: 1, comparisonLatencyMs: 1, totalLatencyMs: 3, providerErrors: [], searchAttempts: 3 },
    queries: null, candidates: null, retrievalDiagnostics: null,
    evidence,
    submissionCanonicalSha256: canonicalSha256(text),
  });
}

// ---------------------------------------------------------------------------

test('1. forged whole-document passages, NO diagnostics id -> contributes 0', async () => {
  const dkForged = 'tb-forged-no-id';
  const dkClean = 'tb-clean-baseline';
  await postReport(dkForged, 'tb1a', { payloadOverrides: { externalAcademicEvidence: forgedWholeDocEvidence(BODY_WORDS) } });
  await postReport(dkClean, 'tb1b', {});

  const forged = await persistedUnified(dkForged, (await db.execute("SELECT id FROM saved_reports WHERE device_key='tb-forged-no-id'")).rows[0].id);
  const clean = await persistedUnified(dkClean, (await db.execute("SELECT id FROM saved_reports WHERE device_key='tb-clean-baseline'")).rows[0].id);

  assert.equal(forged.unified.unifiedScore, clean.unified.unifiedScore, 'forged academic evidence must not change unifiedScore');
  assert.equal(forged.unified.liveAcademicOnlyWords, 0, 'no scholarly words may be counted');
  assert.deepEqual(forged.payload.externalAcademicEvidence, [], 'persisted evidence is the server-verified set ([])');
  assert.equal('verifiedAcademicSearchDiagnosticsId' in forged.payload, false, 'no verified id when nothing verified');
});

test('2. wrong-text diagnostics replay -> contributes 0', async () => {
  // A real diagnostics row with real evidence, but for DIFFERENT text.
  const otherText = 'a completely different document body with unrelated content ' + 'x '.repeat(120);
  const realEvidence = [{
    provider: 'europe-pmc', providerId: 'PMCReal', title: 'Real', authors: null, publication: null, year: 2019,
    doi: '10.1/real', url: 'https://europepmc.org/article/PMC/PMCReal',
    matchedPassages: [{ submittedText: 'x', submittedWordStart: 5, submittedWordEnd: 40, matchedWordCount: 36 }],
    similarity: 42,
  }];
  const id = await seedDiagnostics(otherText, realEvidence);

  const dk = 'tb-wrong-text-replay';
  await postReport(dk, 'tb2', {
    academicSearchDiagnosticsId: Number(id),
    payloadOverrides: { externalAcademicEvidence: realEvidence },
  });
  const rid = (await db.execute("SELECT id FROM saved_reports WHERE device_key='tb-wrong-text-replay'")).rows[0].id;
  const { payload, unified } = await persistedUnified(dk, rid);

  assert.equal(unified.liveAcademicOnlyWords, 0, 'hash mismatch => 0 scholarly words');
  assert.deepEqual(payload.externalAcademicEvidence, [], 'a mismatched diagnostics row yields []');
});

test('3. valid diagnostics + client adds EXTRA forged ranges -> only the verified passage scores', async () => {
  const verified = [{
    provider: 'openaire', providerId: 'ExtOK', title: 'OK', authors: null, publication: null, year: 2018,
    doi: '10.2/ok', url: 'https://example.org/ok',
    matchedPassages: [{ submittedText: 'x', submittedWordStart: 10, submittedWordEnd: 19, matchedWordCount: 10 }],
    similarity: 30,
  }];
  const id = await seedDiagnostics(BODY, verified);

  const dk = 'tb-extra-forged';
  // client sends the same source but with the verified passage PLUS a forged whole-doc passage
  const clientEvidence = [{
    ...verified[0],
    matchedPassages: [
      ...verified[0].matchedPassages,
      { submittedText: 'x', submittedWordStart: 0, submittedWordEnd: BODY_WORDS - 1, matchedWordCount: BODY_WORDS },
    ],
  }];
  await postReport(dk, 'tb3', { academicSearchDiagnosticsId: Number(id), payloadOverrides: { externalAcademicEvidence: clientEvidence } });
  const rid = (await db.execute("SELECT id FROM saved_reports WHERE device_key='tb-extra-forged'")).rows[0].id;
  const { payload, unified } = await persistedUnified(dk, rid);

  assert.ok(unified.liveAcademicOnlyWords <= 10, `only the verified 10-word passage may score (got ${unified.liveAcademicOnlyWords})`);
  assert.ok(unified.liveAcademicOnlyWords >= 1, 'the verified passage DOES score');
  assert.equal(payload.externalAcademicEvidence.length, 1);
  assert.equal(payload.externalAcademicEvidence[0].matchedPassages.length, 1, 'persisted evidence carries only the server-verified passage');
  assert.equal(payload.verifiedAcademicSearchDiagnosticsId, Number(id));
});

test('4. GET recompute removes legacy unverified evidence', async () => {
  // Directly plant a "pre-fix" report row: persisted payload has fabricated
  // externalAcademicEvidence and a persisted unifiedSimilarity, no verified id.
  const dk = 'tb-legacy';
  const rid = `legacy-${Date.now()}`;
  const legacyPayload = samplePayload({
    id: rid,
    externalAcademicEvidence: forgedWholeDocEvidence(BODY_WORDS),
    unifiedSimilarity: { version: 'unified-similarity-v1', wordCount: BODY_WORDS, unifiedScore: 99, uniqueMatchedWords: BODY_WORDS, archiveOnlyWords: 0, liveAcademicOnlyWords: BODY_WORDS, previousUploadOnlyWords: 0, overlapWords: 0, selfExcludedWords: 0, unknownExcludedWords: 0, deviceSelfExcludedWords: 0, contributions: [], matchedPositions: [], previousUploadPositions: [] },
    unifiedSimilarityGeneration: 0,
    corpusSourceMatchingEnabledAtComputation: false,
  });
  await db.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, ai_status, payload_json, user_id, room_number, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [rid, dk, 'sub', 'x.pdf', legacyPayload.created, BODY_WORDS, 12, 'Low', null, null, null, JSON.stringify(legacyPayload), null, null],
  });

  const body = await getReport(dk, rid, 'tb4');
  assert.deepEqual(body.externalAcademicEvidence, [], 'GET drops the unverified evidence from the response');
  assert.ok(body.unifiedSimilarity.liveAcademicOnlyWords === 0, 'recomputed score has 0 scholarly words');
  assert.ok(body.unifiedSimilarity.unifiedScore < 99, 'the inflated legacy score is corrected downward on recompute');

  const { unified } = await persistedUnified(dk, rid);
  assert.equal(unified.liveAcademicOnlyWords, 0, 'the corrected score is persisted');
});

test('5. deferred diagnostics->report link failure does NOT remove valid verified evidence', async () => {
  const verified = [{
    provider: 'openaire', providerId: 'ExtLink', title: 'Link', authors: null, publication: null, year: 2021,
    doi: '10.3/link', url: 'https://example.org/link',
    matchedPassages: [{ submittedText: 'x', submittedWordStart: 30, submittedWordEnd: 55, matchedWordCount: 26 }],
    similarity: 55,
  }];
  const id = await seedDiagnostics(BODY, verified);

  const dk = 'tb-link-independent';
  await postReport(dk, 'tb5', { academicSearchDiagnosticsId: Number(id), payloadOverrides: { externalAcademicEvidence: verified } });
  const rid = (await db.execute("SELECT id FROM saved_reports WHERE device_key='tb-link-independent'")).rows[0].id;

  // The row's report-link columns are still NULL (deferred callback may not have
  // run / may have failed). Force them to stay NULL and confirm GET still verifies.
  await db.execute({ sql: 'UPDATE academic_search_run_diagnostics SET report_device_key = NULL, report_id = NULL WHERE id = ?', args: [Number(id)] });

  const body = await getReport(dk, rid, 'tb5b');
  assert.ok(body.unifiedSimilarity.liveAcademicOnlyWords >= 1, 'verified evidence still scores with NO report link');
  assert.equal(body.externalAcademicEvidence.length, 1);
});

test('6. client-supplied similarity / provider metadata cannot score on their own', async () => {
  const dk = 'tb-metadata-only';
  const metadataOnly = [{
    provider: 'openaire', providerId: 'MetaOnly', title: 'Meta', authors: ['a'], publication: 'J', year: 2022,
    doi: '10.4/meta', url: 'https://example.org/meta',
    similarity: 100,
    matchedPassages: [], // no passages at all — pure metadata + a similarity number
  }];
  await postReport(dk, 'tb6', { payloadOverrides: { externalAcademicEvidence: metadataOnly } });
  const rid = (await db.execute("SELECT id FROM saved_reports WHERE device_key='tb-metadata-only'")).rows[0].id;
  const { unified, payload } = await persistedUnified(dk, rid);
  assert.equal(unified.liveAcademicOnlyWords, 0);
  assert.deepEqual(payload.externalAcademicEvidence, []);
});

test('7. structural: authoritative scoring paths never pass payload.externalAcademicEvidence into resolvePrimarySimilaritySummary', () => {
  const files = [
    'app/api/reports/route.ts',
    'app/api/reports/[id]/route.ts',
    'lib/report-primary-similarity.ts',
  ];
  const forbidden = [
    /externalAcademicEvidence:\s*reportPayload\.externalAcademicEvidence/,
    /externalAcademicEvidence:\s*payload\.externalAcademicEvidence/,
    /authoritativeExternalAcademicEvidence:\s*reportPayload\.externalAcademicEvidence/,
    /authoritativeExternalAcademicEvidence:\s*payload\.externalAcademicEvidence/,
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(repo, rel), 'utf8');
    for (const re of forbidden) {
      assert.doesNotMatch(src, re, `${rel} must not feed a client/persisted externalAcademicEvidence into scoring — use resolveVerifiedAcademicEvidence`);
    }
    assert.match(src, /resolveVerifiedAcademicEvidence/, `${rel} must resolve scholarly evidence via resolveVerifiedAcademicEvidence`);
  }
});

test('8. resolveVerifiedAcademicEvidence unit: every failure mode -> [] , never a throw', async () => {
  const good = canonicalSha256(BODY);
  assert.deepEqual((await resolveVerifiedAcademicEvidence(db, { diagnosticsId: null, submissionCanonicalSha256: good })), { evidence: [], verifiedDiagnosticsId: null });
  assert.deepEqual((await resolveVerifiedAcademicEvidence(db, { diagnosticsId: 999999, submissionCanonicalSha256: good })), { evidence: [], verifiedDiagnosticsId: null });
  assert.deepEqual((await resolveVerifiedAcademicEvidence(db, { diagnosticsId: 1, submissionCanonicalSha256: 'not-a-hash' })), { evidence: [], verifiedDiagnosticsId: null });

  const id = await seedDiagnostics(BODY, [{
    provider: 'openaire', providerId: 'U', title: 'U', authors: null, publication: null, year: 2020, doi: '10.5/u', url: 'https://x/u',
    matchedPassages: [{ submittedText: 'x', submittedWordStart: 1, submittedWordEnd: 3, matchedWordCount: 3 }], similarity: 10,
  }]);
  const ok = await resolveVerifiedAcademicEvidence(db, { diagnosticsId: Number(id), submissionCanonicalSha256: good });
  assert.equal(ok.evidence.length, 1);
  assert.equal(ok.verifiedDiagnosticsId, Number(id));

  // corrupt the stored JSON -> []
  await db.execute({ sql: 'UPDATE academic_search_run_diagnostics SET evidence_json = ? WHERE id = ?', args: ['{not json', Number(id)] });
  assert.deepEqual((await resolveVerifiedAcademicEvidence(db, { diagnosticsId: Number(id), submissionCanonicalSha256: good })), { evidence: [], verifiedDiagnosticsId: null });
});

test('9. verifiedAcademicSearchDiagnosticsId: persisted in payload_json, NEVER in a report response, and a resave that never echoes it still keeps the verified evidence', async () => {
  const verified = [{
    provider: 'europe-pmc', providerId: 'PMCkeep', title: 'Keep', authors: null, publication: null, year: 2020,
    doi: '10.7/keep', url: 'https://europepmc.org/article/PMC/PMCkeep',
    matchedPassages: [{ submittedText: 'x', submittedWordStart: 12, submittedWordEnd: 33, matchedWordCount: 22 }],
    similarity: 44,
  }];
  const diagId = Number(await seedDiagnostics(BODY, verified));

  const dk = 'tb-handle-strip';
  const { res: postRes, payload } = await postReport(dk, 'tb9a', {
    academicSearchDiagnosticsId: diagId,
    payloadOverrides: { externalAcademicEvidence: verified },
  });
  assert.equal(postRes.status, 200);
  const rid = String(payload.id);

  // (a) persisted in payload_json
  const p0 = (await persistedUnified(dk, rid)).payload;
  assert.equal(p0.verifiedAcademicSearchDiagnosticsId, diagId, 'handle IS persisted in payload_json');
  assert.equal(p0.externalAcademicEvidence.length, 1);
  const liveWords0 = (await persistedUnified(dk, rid)).unified.liveAcademicOnlyWords;
  assert.ok(liveWords0 >= 1, 'verified evidence scored on first save');

  // (b) never in the GET response
  const getBody = await getReport(dk, rid, 'tb9b');
  assert.equal('verifiedAcademicSearchDiagnosticsId' in getBody, false, 'GET response must NOT carry the internal handle');
  assert.equal(getBody.externalAcademicEvidence.length, 1, 'but the verified evidence itself is still there');
  assert.ok(getBody.unifiedSimilarity.liveAcademicOnlyWords >= 1, 'and it still scores on GET recompute');

  // (c) a resave built from the GET response (no handle, no body academicSearchDiagnosticsId)
  //     — mirrors saveEnrichedAiResult's {...report, ...aiResult} — must not lose the evidence
  assert.equal('verifiedAcademicSearchDiagnosticsId' in getBody, false); // precondition: client genuinely has no handle
  const resavePayload = { ...getBody, aiAnalysis: { summary: 'x' }, aiScore: 10 };
  await resetRateForTest('tb9c');
  const resaveReq = new Request('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': 'tb9c' },
    body: JSON.stringify({
      deviceKey: dk, id: rid, submissionId: payload.submissionId, title: payload.title,
      createdAt: payload.created, wordCount: payload.wordCount, archiveScore: payload.score, scoreBand: 'Low',
      aiScore: 10, aiTone: null, aiStatus: 'ready', payload: resavePayload,
      // deliberately NO academicSearchDiagnosticsId
    }),
  });
  const resaveRes = await reportsRoute.POST(resaveReq);
  assert.equal(resaveRes.status, 200);

  const p1 = (await persistedUnified(dk, rid));
  assert.equal(p1.payload.verifiedAcademicSearchDiagnosticsId, diagId, 'resave re-derived the handle server-side from the existing row');
  assert.equal(p1.payload.externalAcademicEvidence.length, 1, 'verified evidence survived the resave');
  assert.equal(p1.payload.externalAcademicEvidence[0].providerId, 'PMCkeep');
  assert.ok(p1.unified.liveAcademicOnlyWords >= 1, 'verified evidence still scores after the resave');

  // (d) still no handle in the response after the resave
  const getBody2 = await getReport(dk, rid, 'tb9d');
  assert.equal('verifiedAcademicSearchDiagnosticsId' in getBody2, false);
  assert.equal(getBody2.externalAcademicEvidence.length, 1);
});

test('10. structural: every ordinary-user report-response path strips verifiedAcademicSearchDiagnosticsId', () => {
  const files = ['app/api/reports/[id]/route.ts', 'app/reports/[id]/page.tsx'];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(repo, rel), 'utf8');
    assert.match(src, /delete\s+payload\.verifiedAcademicSearchDiagnosticsId/, `${rel} must delete the internal handle from the outbound payload`);
  }
  // the POST route must re-derive the handle server-side (json_extract on the existing row)
  const postSrc = fs.readFileSync(path.join(repo, 'app/api/reports/route.ts'), 'utf8');
  assert.match(postSrc, /json_extract\(payload_json,\s*'\$\.verifiedAcademicSearchDiagnosticsId'\)/, 'POST must read the persisted handle from the existing row for a resave');
  assert.match(postSrc, /persistedVerifiedAcademicDiagnosticsId/, 'POST lookup-handle precedence must include the server-persisted id');
});
