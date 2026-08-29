import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { resetRateForTest, resetReadRateForTest, resetAuthRateForTest } from '../lib/rate-limit.ts';
import {
  summarizeDeviceProvenanceShadowMeasurement,
  DEFAULT_RECENT_CANDIDATE_LIMIT,
  MAX_RECENT_CANDIDATE_LIMIT,
} from '../lib/device-provenance-shadow-measurement.ts';
import { DEVICE_PROVENANCE_SHADOW_POLICY_VERSION } from '../lib/device-provenance-shadow.ts';
import { PROPOSED_ACCEPTANCE_POLICY_VERSION } from '../lib/e8o-historical-match-policy.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as loginRoute from '../app/api/auth/login/route.ts';
import * as deviceShadowRoute from '../app/api/developer/device-provenance-shadow/route.ts';

/**
 * Admin-only Device Passport shadow measurement summary
 * (lib/device-provenance-shadow-measurement.ts + the
 * app/api/developer/device-provenance-shadow route).
 *
 * Covers: admin-only access, non-admin/no-session invisibility, no
 * identity/provenance secrets in the output, aggregation correctness against
 * a hand-computed fixture, empty-table behaviour, malformed proposed_evidence
 * handled safely, and score-invariance (read-only, no scoring imports/writes).
 */

const repoRoot = path.resolve('.');
const drizzleDir = path.join(repoRoot, 'drizzle');
const dbFile = path.join(repoRoot, 'test_device_provenance_shadow_measurement.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ADMIN_EMAIL = 'dpsm-admin@example.com';

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.ADMIN_EMAIL;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;

async function seedShadow({
  policyVersion = DEVICE_PROVENANCE_SHADOW_POLICY_VERSION,
  reportDeviceKey = uniq('dk'),
  reportId = uniq('r'),
  productionStatus = 'MATCHED',
  productionRelationship = null,
  proposedStatus = 'MATCHED',
  proposedRelationship = null,
  agreement = 'AGREE',
  proposedEvidence = '{}',
  status = 'OK',
  computedAt = null,
} = {}) {
  await client.execute({
    sql: `INSERT INTO historical_match_shadow_evaluations
      (report_device_key, report_id, production_status, production_relationship, proposed_status,
       proposed_relationship, proposed_evidence, agreement, candidate_count, passage_level_evaluated_count,
       freq_index_document_count, submitted_word_count, e8m_runtime_ms, v2_runtime_ms, total_runtime_ms,
       policy_version, correspondence_version, distinctiveness_version, status, error_message,
       computed_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,0,0,0,0,NULL,NULL,1,?,?,?,?,NULL,
              COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
    args: [
      reportDeviceKey, reportId, productionStatus, productionRelationship, proposedStatus,
      proposedRelationship, proposedEvidence, agreement,
      policyVersion, 'n/a-production-matchtype-passthrough', 'n/a', status,
      computedAt,
    ],
  });
  return { reportDeviceKey, reportId };
}

const ev = (o) => JSON.stringify(o);

/**
 * Fixture: 6 device-provenance-shadow-v1 rows (A–F) plus one e8o-policy-v1
 * row (G) that must be ignored. All metrics below are hand-computed from this.
 */
async function seedFixture() {
  // A — a genuine downgrade candidate
  await seedShadow({
    reportId: 'FX-A', productionStatus: 'MATCHED', productionRelationship: 'TURNITPLUS_CORPUS_SOURCE',
    proposedRelationship: 'SELF', agreement: 'DISAGREE_DEVICE_SELF', status: 'OK', computedAt: '2026-08-29 01:00:01',
    proposedEvidence: ev({
      reason: 'SAME_DEVICE_EXACT_DOCUMENT', wouldDowngrade: true, hasReportPassport: true, matchesEvaluated: 1,
      deviceSelfCandidateCount: 1, exactSameDeviceMatchCount: 1, independentBlockedCandidateCount: 0,
      candidateExactCanonicalMatch: true, candidateSameVerifiedDeviceBacking: true, candidateIndependentBackingCount: 0,
      candidateReason: 'SAME_DEVICE_EXACT_DOCUMENT',
      deviceDistinctAccounts: 2, deviceSubmissionCount: 3, deviceSharedAcrossAccounts: true,
    }),
  });
  // B — exact same-device but blocked by independent backing
  await seedShadow({
    reportId: 'FX-B', productionStatus: 'MATCHED', productionRelationship: 'PRIOR_SUBMISSION',
    proposedRelationship: null, agreement: 'AGREE', status: 'OK', computedAt: '2026-08-29 01:00:02',
    proposedEvidence: ev({
      reason: 'NO_DEVICE_DOWNGRADE', wouldDowngrade: false, hasReportPassport: true, matchesEvaluated: 1,
      deviceSelfCandidateCount: 0, exactSameDeviceMatchCount: 1, independentBlockedCandidateCount: 1,
      candidateExactCanonicalMatch: true, candidateSameVerifiedDeviceBacking: true, candidateIndependentBackingCount: 2,
      candidateReason: 'INDEPENDENT_BACKING_BLOCKED',
      deviceDistinctAccounts: 3, deviceSubmissionCount: 7, deviceSharedAcrossAccounts: true,
    }),
  });
  // C — exact same-device but relationship not score-counted
  await seedShadow({
    reportId: 'FX-C', productionStatus: 'MATCHED', productionRelationship: 'SELF',
    proposedRelationship: null, agreement: 'AGREE', status: 'OK', computedAt: '2026-08-29 01:00:03',
    proposedEvidence: ev({
      reason: 'NO_DEVICE_DOWNGRADE', wouldDowngrade: false, hasReportPassport: true, matchesEvaluated: 1,
      deviceSelfCandidateCount: 0, exactSameDeviceMatchCount: 1, independentBlockedCandidateCount: 0,
      candidateExactCanonicalMatch: true, candidateSameVerifiedDeviceBacking: true, candidateIndependentBackingCount: 0,
      candidateReason: 'SAME_DEVICE_EXACT_NOT_COUNTED',
      deviceDistinctAccounts: 1, deviceSubmissionCount: 1, deviceSharedAcrossAccounts: false,
    }),
  });
  // D — NO_HISTORICAL_MATCH, passport present but nothing to evaluate
  await seedShadow({
    reportId: 'FX-D', productionStatus: 'NO_HISTORICAL_MATCH', productionRelationship: null,
    proposedRelationship: null, agreement: 'AGREE', status: 'OK', computedAt: '2026-08-29 01:00:04',
    proposedEvidence: ev({
      reason: 'NO_MATCH_TO_EVALUATE', wouldDowngrade: false, hasReportPassport: true, matchesEvaluated: 0,
      deviceSelfCandidateCount: 0, exactSameDeviceMatchCount: 0, independentBlockedCandidateCount: 0,
      candidateExactCanonicalMatch: false, candidateSameVerifiedDeviceBacking: false, candidateIndependentBackingCount: 0,
      deviceDistinctAccounts: 2, deviceSubmissionCount: 2, deviceSharedAcrossAccounts: true,
    }),
  });
  // E — a FAILED row ({error:true} is valid JSON, all json_extract -> NULL)
  await seedShadow({
    reportId: 'FX-E', productionStatus: 'MATCHED', productionRelationship: null,
    proposedRelationship: null, agreement: 'AGREE', status: 'FAILED', computedAt: '2026-08-29 01:00:05',
    proposedEvidence: ev({ error: true }),
  });
  // F — malformed proposed_evidence (not valid JSON)
  await seedShadow({
    reportId: 'FX-F', productionStatus: 'MATCHED', productionRelationship: 'PRIOR_SUBMISSION',
    proposedRelationship: null, agreement: 'AGREE', status: 'OK', computedAt: '2026-08-29 01:00:06',
    proposedEvidence: 'not-valid-json{{',
  });
  // G — a DIFFERENT policy row that must be ignored entirely
  await seedShadow({
    policyVersion: PROPOSED_ACCEPTANCE_POLICY_VERSION, reportId: 'FX-G',
    productionStatus: 'MATCHED', productionRelationship: 'TURNITPLUS_CORPUS_SOURCE',
    proposedStatus: 'HISTORICAL_FULL_MATCH', agreement: 'AGREE', status: 'OK', computedAt: '2026-08-29 01:00:07',
    proposedEvidence: ev({ wouldDowngrade: true, deviceSharedAcrossAccounts: true, deviceDistinctAccounts: 9 }),
  });
}

// ---------------------------------------------------------------------------
// STRUCTURAL — score invariance / no scoring imports or writes
// ---------------------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function importLines(src) {
  return src.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join('\n');
}
const MODULE_SRC = fs.readFileSync(path.join(repoRoot, 'lib/device-provenance-shadow-measurement.ts'), 'utf8');
const ROUTE_SRC = fs.readFileSync(path.join(repoRoot, 'app/api/developer/device-provenance-shadow/route.ts'), 'utf8');

test('structural: the measurement module issues no write statement and imports no scoring/relationship path', () => {
  const code = stripComments(MODULE_SRC);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i, 'no INSERT');
  assert.doesNotMatch(code, /\bUPDATE\s+\w+\s+SET\b/i, 'no UPDATE');
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i, 'no DELETE');
  assert.doesNotMatch(code, /\bcreate\s+table\b/i, 'no DDL');
  assert.doesNotMatch(
    importLines(MODULE_SRC),
    /unified-similarity|report-primary-similarity|user-submission-matching|report-historical-match|similarity-worker|similarity-core|receipt-pdf|report-classification/,
    'no scoring/matching module import',
  );
  assert.doesNotMatch(code, /\.unifiedScore\s*=|\.score\s*=|\.archiveScore\s*=|\.aiScore\s*=/, 'assigns no score field');
  assert.match(code, /historical_match_shadow_evaluations/, 'reads the shadow-telemetry table');
});

test('structural: the route is admin-gated and 404s (never 401/403) for a non-admin', () => {
  assert.match(ROUTE_SRC, /getAdminSessionUser/);
  assert.match(ROUTE_SRC, /status:\s*404/);
  assert.doesNotMatch(ROUTE_SRC, /status:\s*40[13]/, 'must never return 401/403');
});

test('structural: the persisted-field allowlist never surfaces an identity/secret key name', () => {
  const code = stripComments(MODULE_SRC);
  for (const forbidden of [/passport/i, /\bemail\b/i, /account_id/i, /\bip\b\s*[:=]/i, /source_ref/i, /canonical_sha/i, /filename/i, /\braw_?text\b/i]) {
    assert.doesNotMatch(code, forbidden, `measurement module must not reference ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// EMPTY TABLE
// ---------------------------------------------------------------------------

test('empty table: every metric is zero / empty, recent is [], no throw', async () => {
  const summary = await summarizeDeviceProvenanceShadowMeasurement(client);
  assert.equal(summary.policyVersion, DEVICE_PROVENANCE_SHADOW_POLICY_VERSION);
  assert.equal(summary.totals.evaluations, 0);
  assert.equal(summary.totals.ok, 0);
  assert.equal(summary.totals.failed, 0);
  assert.equal(summary.totals.unparseableEvidence, 0);
  assert.equal(summary.totals.matched, 0);
  assert.equal(summary.totals.noHistoricalMatch, 0);
  assert.equal(summary.wouldDowngradeCount, 0);
  assert.equal(summary.sameDeviceExactDocumentCount, 0);
  assert.equal(summary.candidateIndependentBackingPositiveCount, 0);
  assert.equal(summary.sharedDeviceEvaluationCount, 0);
  assert.equal(summary.blockedByIndependentBackingCount, 0);
  assert.deepEqual(summary.deviceDistinctAccountsDistribution, { one: 0, two: 0, threePlus: 0, unknown: 0 });
  assert.deepEqual(summary.deviceSubmissionCountDistribution, { one: 0, two: 0, threeToFive: 0, sixPlus: 0, unknown: 0 });
  assert.deepEqual(summary.productionRelationshipDistribution, {});
  assert.deepEqual(summary.proposedRelationshipDistribution, {});
  assert.deepEqual(summary.agreementDistribution, {});
  assert.deepEqual(summary.exactSameDeviceNotDowngraded, { total: 0, byReason: {}, byCandidateReason: {} });
  assert.deepEqual(summary.recentCandidates, []);
  assert.equal(summary.recentCandidatesLimit, DEFAULT_RECENT_CANDIDATE_LIMIT);
});

// ---------------------------------------------------------------------------
// AGGREGATION CORRECTNESS + MALFORMED HANDLING + POLICY ISOLATION
// ---------------------------------------------------------------------------

test('aggregation correctness against the hand-computed A–F fixture (e8o row G ignored)', async () => {
  await seedFixture();
  const s = await summarizeDeviceProvenanceShadowMeasurement(client, { recentLimit: 50 });

  // policy isolation — the e8o-policy-v1 row G is not counted anywhere
  assert.equal(s.totals.evaluations, 6, 'exactly the 6 device-provenance-shadow-v1 rows');

  // totals
  assert.equal(s.totals.ok, 5);
  assert.equal(s.totals.failed, 1);
  assert.equal(s.totals.unparseableEvidence, 1, 'only F is invalid JSON — E {error:true} is valid');
  assert.equal(s.totals.matched, 5);
  assert.equal(s.totals.noHistoricalMatch, 1);

  // scalar evidence metrics
  assert.equal(s.wouldDowngradeCount, 1, 'only A');
  assert.equal(s.sameDeviceExactDocumentCount, 1, 'only A reason=SAME_DEVICE_EXACT_DOCUMENT');
  assert.equal(s.candidateIndependentBackingPositiveCount, 1, 'only B (candidateIndependentBackingCount=2)');
  assert.equal(s.sharedDeviceEvaluationCount, 3, 'A, B, D');
  assert.equal(s.blockedByIndependentBackingCount, 1, 'only B (independentBlockedCandidateCount=1)');

  // distributions (7) / (8)
  assert.deepEqual(s.deviceDistinctAccountsDistribution, { one: 1, two: 2, threePlus: 1, unknown: 1 });
  assert.deepEqual(s.deviceSubmissionCountDistribution, { one: 1, two: 1, threeToFive: 1, sixPlus: 1, unknown: 1 });

  // (9) production relationship — all 6 rows, column
  assert.deepEqual(s.productionRelationshipDistribution, {
    TURNITPLUS_CORPUS_SOURCE: 1, PRIOR_SUBMISSION: 2, SELF: 1, '(none)': 2,
  });
  // (10) proposed relationship
  assert.deepEqual(s.proposedRelationshipDistribution, { SELF: 1, '(none)': 5 });
  // (11) agreement
  assert.deepEqual(s.agreementDistribution, { AGREE: 5, DISAGREE_DEVICE_SELF: 1 });

  // (13) exact same-device matches that did NOT downgrade, grouped by reason
  assert.equal(s.exactSameDeviceNotDowngraded.total, 2, 'B and C (A excluded: it DID downgrade)');
  assert.deepEqual(s.exactSameDeviceNotDowngraded.byReason, { NO_DEVICE_DOWNGRADE: 2 });
  assert.deepEqual(s.exactSameDeviceNotDowngraded.byCandidateReason, {
    INDEPENDENT_BACKING_BLOCKED: 1, SAME_DEVICE_EXACT_NOT_COUNTED: 1,
  });

  // recent-candidates table
  assert.equal(s.recentCandidates.length, 6);
  const byId = Object.fromEntries(s.recentCandidates.map((r) => [r.reportId, r]));
  assert.equal(byId['FX-A'].wouldDowngrade, true);
  assert.equal(byId['FX-A'].reason, 'SAME_DEVICE_EXACT_DOCUMENT');
  assert.equal(byId['FX-A'].exactCanonical, true);
  assert.equal(byId['FX-A'].sameVerifiedDevice, true);
  assert.equal(byId['FX-A'].independentBackingCount, 0);
  assert.equal(byId['FX-A'].sharedDeviceAccountCount, 2);
  assert.equal(byId['FX-A'].sharedDeviceSubmissionCount, 3);
  assert.equal(byId['FX-A'].productionRelationship, 'TURNITPLUS_CORPUS_SOURCE');
  assert.equal(byId['FX-A'].proposedRelationship, 'SELF');
  assert.equal(byId['FX-A'].status, 'OK');

  // malformed row F — every evidence-derived field is null, row still present & safe
  assert.equal(byId['FX-F'].wouldDowngrade, null);
  assert.equal(byId['FX-F'].reason, null);
  assert.equal(byId['FX-F'].exactCanonical, null);
  assert.equal(byId['FX-F'].sameVerifiedDevice, null);
  assert.equal(byId['FX-F'].independentBackingCount, null);
  assert.equal(byId['FX-F'].sharedDeviceAccountCount, null);
  assert.equal(byId['FX-F'].productionRelationship, 'PRIOR_SUBMISSION');
  assert.equal(byId['FX-F'].status, 'OK');

  // FAILED row E — {error:true} parses, but no bounded fields
  assert.equal(byId['FX-E'].status, 'FAILED');
  assert.equal(byId['FX-E'].wouldDowngrade, null);
  assert.equal(byId['FX-E'].reason, null);

  // ordering: newest computed_at first
  assert.equal(s.recentCandidates[0].reportId, 'FX-F');
  assert.equal(s.recentCandidates[s.recentCandidates.length - 1].reportId, 'FX-A');

  // recentLimit is bounded
  const capped = await summarizeDeviceProvenanceShadowMeasurement(client, { recentLimit: 999 });
  assert.ok(capped.recentCandidatesLimit <= MAX_RECENT_CANDIDATE_LIMIT);
  const limited = await summarizeDeviceProvenanceShadowMeasurement(client, { recentLimit: 2 });
  assert.equal(limited.recentCandidates.length, 2);
  assert.equal(limited.recentCandidatesLimit, 2);
});

// ---------------------------------------------------------------------------
// PRIVACY — no identity/provenance secret in the summary output
// ---------------------------------------------------------------------------

test('privacy: canary identity fields injected into proposed_evidence never appear in the summary', async () => {
  const CANARIES = {
    email: 'leak-canary@secret.test',
    passportId: 'leak-passport-canary-xyz',
    accountId: 'leak-account-canary-xyz',
    source_ref: 'report-upload:account=leak:device=leak',
    ip: '10.11.12.13',
    filename: 'leaked-secret-file.pdf',
    canonical_sha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef01',
    text: 'this is leaked raw document text that must never surface',
  };
  await seedShadow({
    reportId: 'CANARY-1', productionStatus: 'MATCHED', productionRelationship: 'TURNITPLUS_CORPUS_SOURCE',
    proposedRelationship: 'SELF', agreement: 'DISAGREE_DEVICE_SELF', status: 'OK',
    proposedEvidence: ev({
      reason: 'SAME_DEVICE_EXACT_DOCUMENT', wouldDowngrade: true, hasReportPassport: true,
      exactSameDeviceMatchCount: 1, deviceSelfCandidateCount: 1, candidateExactCanonicalMatch: true,
      candidateSameVerifiedDeviceBacking: true, candidateIndependentBackingCount: 0,
      deviceDistinctAccounts: 2, deviceSubmissionCount: 4, deviceSharedAcrossAccounts: true,
      ...CANARIES,
    }),
  });

  const s = await summarizeDeviceProvenanceShadowMeasurement(client, { recentLimit: 100 });
  const serialized = JSON.stringify(s);
  for (const value of Object.values(CANARIES)) {
    assert.equal(serialized.includes(value), false, `summary leaked a canary: ${value.slice(0, 24)}`);
  }
  // it also must not carry the raw proposed_evidence blob or key names through
  assert.doesNotMatch(serialized, /proposed_evidence|"email"|"passportId"|"source_ref"|"canonical_sha256"/);
  // the canary row itself IS represented (by report id only) so admins can find it
  assert.ok(s.recentCandidates.some((r) => r.reportId === 'CANARY-1'));
});

// ---------------------------------------------------------------------------
// SCORE INVARIANCE — running the summary mutates nothing
// ---------------------------------------------------------------------------

test('score invariance: running the summary does not change any row in any table it can see', async () => {
  const snap = async () => {
    const t = await client.execute('SELECT * FROM historical_match_shadow_evaluations ORDER BY id');
    const r = await client.execute('SELECT * FROM saved_reports ORDER BY device_key, id');
    const h = await client.execute('SELECT * FROM report_historical_match_snapshots ORDER BY id');
    return JSON.stringify({ t: t.rows, r: r.rows, h: h.rows });
  };
  const before = await snap();
  await summarizeDeviceProvenanceShadowMeasurement(client, { recentLimit: 100 });
  await summarizeDeviceProvenanceShadowMeasurement(client);
  const after = await snap();
  assert.equal(after, before, 'no table content changed');
});

// ---------------------------------------------------------------------------
// ADMIN-ONLY ACCESS via the real route
// ---------------------------------------------------------------------------

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const m = setCookie.match(/tp_session_v1=([^;]*)/);
  return m ? m[1] : null;
}
async function signup(email, deviceKey, tag) {
  await resetAuthRateForTest(tag);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': tag },
    body: JSON.stringify({ email, password: 'dpsm-password-1', username: tag.replace(/[^a-z0-9]/gi, ''), deviceKey }),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  return extractCookie(res);
}
async function login(email, deviceKey, tag) {
  await resetAuthRateForTest(tag);
  const res = await loginRoute.POST(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': tag },
    body: JSON.stringify({ email, password: 'dpsm-password-1', deviceKey }),
  }));
  assert.equal(res.status, 200);
  return extractCookie(res);
}
async function callRoute(cookie, tag, qs = '') {
  await resetReadRateForTest(tag);
  await resetRateForTest(tag);
  const headers = { 'x-forwarded-for': tag };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  return deviceShadowRoute.GET(new Request(`http://localhost/api/developer/device-provenance-shadow${qs}`, { headers }));
}

test('admin-only access: no session -> 404, non-admin -> 404 (no body), admin -> 200 with the measurement', async () => {
  const adminCookie = await signup('dpsm-admin@example.com', 'dpsm-admin-dev', 'dpsm-admin-1');
  const plainCookie = await signup('dpsm-ordinary@example.com', 'dpsm-ordinary-dev', 'dpsm-ordinary-1');

  const noSession = await callRoute(null, 'dpsm-nosess');
  assert.equal(noSession.status, 404, 'no session must be a plain 404, not 401/403');
  assert.equal((await noSession.text()).length, 0, 'no body for a non-admin');

  const nonAdmin = await callRoute(plainCookie, 'dpsm-nonadmin');
  assert.equal(nonAdmin.status, 404, 'a signed-in non-admin is indistinguishable from no session');
  assert.equal((await nonAdmin.text()).length, 0);

  const adminRes = await callRoute(adminCookie, 'dpsm-admin-get');
  assert.equal(adminRes.status, 200);
  const body = await adminRes.json();
  assert.equal(body.policyVersion, DEVICE_PROVENANCE_SHADOW_POLICY_VERSION);
  assert.equal(typeof body.totals.evaluations, 'number');
  assert.ok(Array.isArray(body.recentCandidates));
  // the admin response still leaks no identity/secret
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /leak-canary@secret\.test|leak-passport-canary|leak-account-canary|proposed_evidence/);

  // recentLimit query param is honoured & bounded
  const limitedRes = await callRoute(adminCookie, 'dpsm-admin-limit', '?recentLimit=1');
  const limitedBody = await limitedRes.json();
  assert.ok(limitedBody.recentCandidates.length <= 1);
});

test('a re-login non-admin still cannot reach the route after admin data exists', async () => {
  const plainCookie = await login('dpsm-ordinary@example.com', 'dpsm-ordinary-dev', 'dpsm-ord-relogin');
  const res = await callRoute(plainCookie, 'dpsm-ord-recheck');
  assert.equal(res.status, 404);
});

console.log('device-provenance-shadow-measurement: structural + empty + aggregation + malformed + privacy + score-invariance + admin-only access passed');
