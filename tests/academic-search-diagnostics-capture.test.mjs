import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as academicEvidenceRoute from '../app/api/academic-evidence/route.ts';
import { resetRateForTest } from '../lib/rate-limit.js';
import {
  recordAcademicSearchRunDiagnostics,
  findAcademicSearchRunDiagnosticsByDocumentIdentityId,
  findAcademicSearchRunDiagnosticsByReport,
  findRecentAcademicSearchRunDiagnostics,
} from '../lib/academic-search-diagnostics-repo.ts';
import { getReportDeepDiveForDeveloper, searchArticleHistory } from '../lib/developer-repo.ts';

// Verifies the developer-diagnostics capture path:
//  - app/api/academic-evidence/route.ts persists runAcademicSearch's own
//    per-run stats/queries/candidates/retrieval outcome (previously computed
//    and discarded — see lib/academic-evidence-integration.ts's own header
//    comment) SERVER-SIDE, and returns only a bare row id to the client —
//    never the diagnostic content itself, since that route has no auth
//    requirement and is reachable by any caller (see that route's own header
//    comment on why this matters: it must never become a normal-API
//    information leak).
//  - app/api/reports/route.ts links that id to the actual report/document
//    identity, in the same deferred callback that already captures identity.
//  - Never touches saved_reports.payload_json.

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_academic_search_diagnostics_capture.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);
setupClient.close();

function sampleDiagnostics(overrides = {}) {
  return {
    status: 'COMPLETE_WITH_MATCHES',
    stats: {
      queryCount: 12,
      searchLatencyMs: 340,
      candidateCountBeforeDedup: 9,
      candidateCountAfterDedup: 5,
      deduplicationRate: 0.44,
      candidatesTextRetrieved: 3,
      textRetrievalLatencyMs: 210,
      comparisonLatencyMs: 15,
      totalLatencyMs: 580,
      providerErrors: [{ providerId: 'europe-pmc', kind: 'TIMEOUT', message: 'timed out' }],
      searchAttempts: 24,
    },
    queries: [{ queryText: 'a distinctive sentence', rank: 0, sourcePassage: 'a distinctive sentence', queryType: 'sentence' }],
    candidates: [{ candidateKey: 'doi:10.1234/abc', doi: '10.1234/abc', url: 'https://example.org/abc', title: 'A Real Paper', authors: ['A. Author'], publication: 'Journal', year: 2024, textAvailable: true, abstract: null, contributors: [], rank: 0 }],
    retrievalDiagnostics: [{ candidateKey: 'doi:10.1234/abc', rank: 0, doi: '10.1234/abc', url: 'https://example.org/abc', title: 'A Real Paper', retrievalSource: 'provider', retrievalProviderId: 'openaire', retrievalLatencyMs: 120, retrievedTextLength: 4200, comparisonSimilarity: 62, includedAsEvidence: true }],
    ...overrides,
  };
}

/** Simulates what app/api/academic-evidence/route.ts does server-side: record an unlinked diagnostics row and return its id — exactly the only thing that route ever sends to a client. */
async function recordUnlinkedDiagnostics(overrides = {}) {
  const client = createClient({ url: `file:${dbFile}` });
  const diagnostics = sampleDiagnostics(overrides);
  const id = await recordAcademicSearchRunDiagnostics(client, diagnostics);
  client.close();
  return id;
}

function samplePayload(overrides = {}) {
  return {
    version: 11,
    id: Date.now(),
    submissionId: '1234567890',
    title: 'diagnostics-sample.pdf',
    created: new Date().toISOString(),
    score: 12,
    wordCount: 500,
    text: 'sample extracted text for diagnostics capture',
    ...overrides,
  };
}

async function postReport(deviceKey, { id, payloadOverrides = {}, academicSearchDiagnosticsId } = {}) {
  await resetRateForTest('diag-capture-test-client');
  const payload = samplePayload({ id: id ?? Date.now(), ...payloadOverrides });
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'diag-capture-test-client' },
    body: JSON.stringify({
      deviceKey,
      id: String(payload.id),
      submissionId: payload.submissionId,
      title: payload.title,
      createdAt: payload.created,
      wordCount: payload.wordCount,
      archiveScore: payload.score,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      payload,
      academicSearchDiagnosticsId: academicSearchDiagnosticsId ?? null,
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, payload };
}

// 0. /api/academic-evidence never includes the raw diagnostic bundle in its
// HTTP response — structurally (source text) and functionally (a real
// request, using the short-text early-return path so no network call is
// made). This is the actual privacy boundary: that route has no auth
// requirement and is reachable by any caller.
{
  const source = fs.readFileSync(path.join(repo, 'app/api/academic-evidence/route.ts'), 'utf8');
  const responseLines = source.split(/\r?\n/).filter((l) => /NextResponse\(JSON\.stringify\(\{[^}]*(evidence|status)/.test(l));
  assert.ok(responseLines.length >= 2, 'expected to find both response-construction lines');
  for (const line of responseLines) {
    for (const forbidden of ['stats', 'candidates', 'queries', 'retrievalDiagnostics']) {
      assert.doesNotMatch(line, new RegExp(`\\b${forbidden}\\b`), `response body construction must never include "${forbidden}": "${line.trim()}"`);
    }
  }

  await resetRateForTest('diag-privacy-short-text');
  const req = new Request('http://localhost/api/academic-evidence', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'diag-privacy-short-text' },
    body: JSON.stringify({ text: 'too short' }),
  });
  const res = await academicEvidenceRoute.POST(req);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['academicSearchDiagnosticsId', 'evidence', 'status'], '/api/academic-evidence must never return anything beyond evidence/status/academicSearchDiagnosticsId to any caller');
  console.log('/api/academic-evidence never exposes the raw diagnostic bundle to a caller');
}

// 1. Linking an already-recorded diagnostics id to a save wires it to both
// the captured document identity and the (deviceKey, id) pair, and never
// leaks into saved_reports.payload_json.
{
  const deviceKey = 'device-diag-1';
  const diagnosticsId = await recordUnlinkedDiagnostics();
  const { res, payload } = await postReport(deviceKey, { academicSearchDiagnosticsId: diagnosticsId });
  assert.equal(res.status, 200);

  const client = createClient({ url: `file:${dbFile}` });
  const reportRow = await client.execute({ sql: 'SELECT payload_json, document_identity_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, String(payload.id)] });
  const savedPayload = JSON.parse(reportRow.rows[0].payload_json);
  assert.equal(savedPayload.academicSearchDiagnosticsId, undefined, 'diagnostics linkage must never be written into saved_reports.payload_json');
  const documentIdentityId = reportRow.rows[0].document_identity_id;
  assert.ok(documentIdentityId, 'document identity capture must have run (deferred block runs inline in tests — see lib/run-after-response.ts)');

  const byIdentity = await findAcademicSearchRunDiagnosticsByDocumentIdentityId(client, documentIdentityId);
  assert.equal(byIdentity.length, 1, 'exactly one diagnostics row must be linked to this document identity');
  assert.equal(byIdentity[0].id, diagnosticsId, 'the linked row must be the one recorded by the (simulated) academic-evidence check, not a new insert');
  assert.equal(byIdentity[0].status, 'COMPLETE_WITH_MATCHES');
  assert.equal(byIdentity[0].totalLatencyMs, 580);
  assert.deepEqual(byIdentity[0].stats.providerErrors, [{ providerId: 'europe-pmc', kind: 'TIMEOUT', message: 'timed out' }]);
  assert.equal(byIdentity[0].queries.length, 1);
  assert.equal(byIdentity[0].candidates.length, 1);
  assert.equal(byIdentity[0].retrievalDiagnostics[0].comparisonSimilarity, 62);

  const byReport = await findAcademicSearchRunDiagnosticsByReport(client, deviceKey, String(payload.id));
  assert.ok(byReport, 'the report-keyed lookup path must also resolve the same run');
  assert.equal(byReport.id, diagnosticsId);

  client.close();
  console.log('academic-search diagnostics linked correctly and kept out of payload_json');
}

// 2. A save with no diagnostics id (undefined/null, the common case for an
// older client or a run where /api/academic-evidence never produced one)
// links nothing and never errors.
{
  const deviceKey = 'device-diag-2';
  const { res, payload } = await postReport(deviceKey, {});
  assert.equal(res.status, 200);

  const client = createClient({ url: `file:${dbFile}` });
  const reportRow = await client.execute({ sql: 'SELECT document_identity_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, String(payload.id)] });
  const documentIdentityId = reportRow.rows[0].document_identity_id;
  const byIdentity = await findAcademicSearchRunDiagnosticsByDocumentIdentityId(client, documentIdentityId);
  assert.equal(byIdentity.length, 0, 'no diagnostics row should be linked when no id was sent');
  client.close();
  console.log('omitting the diagnostics id links nothing and does not error');
}

// 3. A bogus/forged diagnostics id (does not correspond to any real
// unlinked row) is safely ignored, not a request error.
{
  const deviceKey = 'device-diag-3';
  const { res } = await postReport(deviceKey, { academicSearchDiagnosticsId: 999999999 });
  assert.equal(res.status, 200, 'a nonexistent diagnostics id must never fail the save itself');
  console.log('a bogus diagnostics id is safely ignored');
}

// 4. Resaving the SAME (deviceKey, id) a second time (the real product's own
// two-saves-per-report pattern — see app/api/reports/route.ts's own comment)
// must not re-link or duplicate anything, matching isFirstSaveOfThisReport
// gating already applied to document identity capture.
{
  const deviceKey = 'device-diag-4';
  const id = Date.now();
  const firstDiagnosticsId = await recordUnlinkedDiagnostics();
  const secondDiagnosticsId = await recordUnlinkedDiagnostics({ status: 'FAILED' });
  await postReport(deviceKey, { id, academicSearchDiagnosticsId: firstDiagnosticsId });
  await postReport(deviceKey, { id, academicSearchDiagnosticsId: secondDiagnosticsId });

  const client = createClient({ url: `file:${dbFile}` });
  const reportRow = await client.execute({ sql: 'SELECT document_identity_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, String(id)] });
  const documentIdentityId = reportRow.rows[0].document_identity_id;
  const byIdentity = await findAcademicSearchRunDiagnosticsByDocumentIdentityId(client, documentIdentityId);
  assert.equal(byIdentity.length, 1, 'a resave of the same report must not link a second diagnostics row');
  assert.equal(byIdentity[0].id, firstDiagnosticsId, 'the linked row must be from the FIRST save, never replaced by the resave');
  client.close();
  console.log('resaving the same report does not duplicate or replace its linked diagnostics row');
}

// 5. The developer deep-dive bundle surfaces the captured run alongside the report and its identity.
{
  const deviceKey = 'device-diag-5';
  const diagnosticsId = await recordUnlinkedDiagnostics();
  const { payload } = await postReport(deviceKey, { academicSearchDiagnosticsId: diagnosticsId });

  const client = createClient({ url: `file:${dbFile}` });
  const deepDive = await getReportDeepDiveForDeveloper(client, deviceKey, String(payload.id));
  assert.ok(deepDive.report, 'the deep-dive bundle must resolve the report');
  assert.equal(deepDive.academicSearchRuns.length, 1);
  assert.equal(deepDive.academicSearchRuns[0].stats.queryCount, 12);
  assert.ok(deepDive.documentIdentity, 'the deep-dive bundle must resolve the document identity');

  const recent = await findRecentAcademicSearchRunDiagnostics(client, 50);
  assert.ok(recent.some((run) => run.id === deepDive.academicSearchRuns[0].id), 'the recent-runs feed must include this run');
  client.close();
  console.log('developer deep-dive bundle surfaces the captured academic-search run');
}

// 6. Article History / Lookup finds a report/identity by a DOI that only
// ever appeared as a ranked candidate (never cleared minEvidenceSimilarity,
// so it was never written into externalAcademicEvidence/payload_json) —
// this is the whole point of scanning candidates_json separately from
// payload_json (see searchArticleHistory's own comment).
{
  const deviceKey = 'device-diag-6';
  const doi = '10.5555/candidate-only-doi';
  const diagnosticsId = await recordUnlinkedDiagnostics({
    candidates: [{ candidateKey: `doi:${doi}`, doi, url: 'https://example.org/candidate-only', title: 'Candidate That Never Became Evidence', authors: [], publication: null, year: null, textAvailable: false, abstract: null, contributors: [], rank: 0 }],
  });
  const { payload } = await postReport(deviceKey, { academicSearchDiagnosticsId: diagnosticsId });

  const client = createClient({ url: `file:${dbFile}` });
  const byDoi = await searchArticleHistory(client, doi);
  assert.equal(byDoi.reports.length, 1, 'a DOI present only in candidates_json must still surface the report it came from');
  assert.equal(byDoi.reports[0].id, String(payload.id));
  assert.ok(byDoi.documentIdentities.length >= 1, 'the associated document identity must also be surfaced');
  client.close();
  console.log('lookup finds a report by a candidate-only DOI, not just evidence that cleared the similarity floor');
}

for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  try { fs.unlinkSync(candidate); } catch (e) { /* ignore */ }
}
console.log('All academic-search diagnostics capture tests passed');
