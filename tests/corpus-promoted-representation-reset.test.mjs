import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import * as resetRoomsRoute from '../app/api/developer/reset-rooms/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';
import { canonicalSha256 } from '../lib/document-identity.ts';
import { buildReportAdmissionSourceRef } from '../lib/corpus-admission-source-ref.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';
import { runCorpusAdmissionPromotionSweep } from '../lib/corpus-admission-promotion.ts';
import { matchAgainstUserSubmissionCorpus } from '../lib/user-submission-matching.ts';
import { matureCorpusBackings } from './helpers/corpus-maturity.mjs';
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

/**
 * BLOCKING REVIEW proof: "Clear my rooms" must NOT destroy an ACCEPTed +
 * PROMOTED corpus representation, and a different-account document must STILL
 * MATCH against it after the reset.
 *
 * Follows one concrete accepted+promoted submission end to end:
 *   saved_report -> document_identity -> corpus_submission_references
 *   -> corpus_document_representations / corpus_document_shingles
 *   -> corpus_admission_decisions / _content_store / _accepted_representations
 *   -> corpus_admission_promotions ('indexed')
 *   -> matchAgainstUserSubmissionCorpus participation
 *
 * Two promoted scenarios:
 *   PURE  — promoted, and the developer's report never had a
 *           corpus_submission_references row (the real production path;
 *           recordSubmissionReference has no production caller).
 *   CASEB — promoted AND the developer's own identity is the LAST
 *           corpus_submission_references row for that representation (the
 *           dangerous defense-in-depth case the reset-path guard exists for:
 *           without it, deleteReportDocumentData would try to remove the
 *           still-promoted representation once that last reference cascades).
 * PRIVACY — a plain, non-promoted representation the developer indexed:
 *           MUST still be deleted (the guard must not over-broaden).
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_corpus_promoted_representation_reset.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const ADMIN_EMAIL = 'dev-promoted@reset.test';
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ADMIN_EMAIL = ADMIN_EMAIL;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = 'true';

const db = createClient({ url: `file:${dbFile}` });
await db.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(db, drizzleDir);
const openConnection = () => createClient({ url: `file:${dbFile}` });

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const PASSWORD = 'promoted-reset-pw-1';
const DEVICE = 'device-promoted-reset-a';

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  const match = setCookie && setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, deviceKey) {
  const ip = 'promoted-signup-' + email;
  await resetAuthRateForTest(ip);
  const res = await signupRoute.POST(new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(withTestIdentity({ email, password: PASSWORD, username: email.split('@')[0].replace(/[^a-z0-9]/gi, ''), deviceKey })),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  return extractCookie(res);
}

let roomSeq = 0;
async function postReport(cookie, text) {
  const ip = 'promoted-post';
  await resetRateForTest(ip);
  const reportId = `promoted-report-${roomSeq}-${randomUUID()}`;
  const room = roomSeq++;
  const res = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({
      deviceKey: DEVICE, id: reportId, submissionId: 'sub-' + reportId, title: reportId + '.pdf',
      createdAt: new Date().toISOString(), wordCount: 60, archiveScore: 3, scoreBand: 'Low',
      aiScore: null, aiTone: null, room,
      payload: {
        version: 11, id: Date.now(), submissionId: 'sub-' + reportId, title: reportId + '.pdf', author: '',
        assignment: '', created: new Date().toISOString(), score: 3, archiveScore: 3, text,
        wordCount: 60, characterCount: 900, pageCount: 1, fileSize: '1 KB', databaseSize: 230,
        corpusVersion: 'test', scoreBand: 'Low',
      },
    }),
  }));
  assert.equal(res.status, 200, `postReport ${reportId} (${res.status})`);
  return { reportId, room };
}

async function callReset(cookie, body) {
  const ip = 'promoted-reset-call';
  await resetRateForTest(ip);
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  return resetRoomsRoute.POST(new Request('http://localhost/api/developer/reset-rooms', {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
}

async function one(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows[0];
}
async function count(sql, args = []) {
  return Number((await one(sql, args)).c);
}
async function identityIdFor(reportId) {
  const r = await one('SELECT document_identity_id FROM saved_reports WHERE device_key = ? AND id = ?', [DEVICE, reportId]);
  return r?.document_identity_id ? String(r.document_identity_id) : null;
}
async function corpusGeneration() {
  const r = await one('SELECT COALESCE(MAX(generation), 0) AS c FROM corpus_match_generation');
  return Number(r.c);
}

/** Seed an ACCEPT decision (+ content, + accepted fingerprint, + succeeded job) for one of A's real reports, then promote it via the real sweep. */
async function acceptAndPromoteReport(accountId, reportId, text) {
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey: DEVICE, reportId });
  const hash = canonicalSha256(text);
  const decisionId = randomUUID();
  await db.execute({
    sql: `INSERT INTO corpus_admission_decisions
            (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, canonical_sha256, dry_run)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [decisionId, sourceRef, 'policy-test-v1', 'ACCEPT', '[]', 1, '[]', hash, 0],
  });
  await db.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, retention_basis)
          VALUES (?,?,?,?,'per-user-consent')`,
    args: [randomUUID(), decisionId, hash, text],
  });
  const acceptedRepId = randomUUID();
  await db.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version)
          VALUES (?,?,?,?, 'fp-test-v1')`,
    args: [acceptedRepId, decisionId, hash, 60],
  });
  await db.execute({
    sql: `INSERT INTO corpus_admission_report_jobs (id, source_ref, account_id, device_key, report_id, status, decision_id, attempt_count)
          VALUES (?,?,?,?,?, 'succeeded', ?, 1)`,
    args: [randomUUID(), sourceRef, accountId, DEVICE, reportId, decisionId],
  });

  const sweep = await runCorpusAdmissionPromotionSweep(db, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome?.outcome, 'indexed', `promotion sweep must index decision for ${reportId}`);
  return { sourceRef, decisionId, acceptedRepId, hash, representationId: outcome.representationId };
}

async function matchAnon(text) {
  // Phase A safe-by-default maturity: this suite is about promotion/reset
  // visibility, not the 7-day activation clock — age the just-promoted backings.
  await matureCorpusBackings(db);
  return matchAgainstUserSubmissionCorpus(db, { accountId: null, canonicalText: text });
}

// Deliberately unrelated topics — matchAgainstUserSubmissionCorpus runs a
// global shingle search across the shared DB, so shared-prefix fixtures
// would cross-contaminate.
const TEXT_PURE =
  'Hydrologists reconstructing centuries of streamflow from tree-ring chronologies across a semi-arid basin found that ' +
  'the recent multi-decade drought was the most severe in the entire reconstructed record, exceeding any prior dry ' +
  'interval by a wide margin in both duration and cumulative deficit.';
const TEXT_CASEB =
  'Astronomers analyzing a decade of radial-velocity measurements around a nearby red-dwarf star resolved a compact ' +
  'system of three small planets, two of them within the conservative habitable zone, whose mutual gravitational ' +
  'interactions produce transit-timing variations large enough to constrain their masses precisely.';
const TEXT_PRIVACY =
  'Archaeologists excavating a waterlogged Bronze Age settlement recovered an unusually complete assemblage of wooden ' +
  'tools and textiles preserved by anaerobic peat, including a loom fragment whose construction predates other known ' +
  'examples from the region by roughly four centuries.';

// --- Fixtures -----------------------------------------------------------

const cookieA = await signup(ADMIN_EMAIL, DEVICE);
await grantTestAdmin(dbFile, ADMIN_EMAIL);
const idA = String((await one('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL])).id);
assert.equal((await one('SELECT role FROM users WHERE id = ?', [idA])).role, 'admin');

const reportPure = await postReport(cookieA, TEXT_PURE);
const reportCaseB = await postReport(cookieA, TEXT_CASEB);
const reportPrivacy = await postReport(cookieA, TEXT_PRIVACY);

const idPure = await identityIdFor(reportPure.reportId);
const idCaseB = await identityIdFor(reportCaseB.reportId);
const idPrivacy = await identityIdFor(reportPrivacy.reportId);
assert.ok(idPure && idCaseB && idPrivacy, 'sanity: all three reports captured a document_identity_id');

const pure = await acceptAndPromoteReport(idA, reportPure.reportId, TEXT_PURE);
const caseB = await acceptAndPromoteReport(idA, reportCaseB.reportId, TEXT_CASEB);

// CASEB only: make the developer's own identity the LAST submission reference
// for the (already-promoted) representation.
const indexed = await indexDocumentSubmissionIntoCorpus(db, { documentIdentityId: idCaseB, rawText: TEXT_CASEB });
assert.equal(indexed.representationId, caseB.representationId, 'CASEB: the reference must attach to the SAME promoted representation');
assert.equal(
  await count('SELECT COUNT(*) AS c FROM corpus_submission_references WHERE representation_id = ?', [caseB.representationId]),
  1,
  'CASEB: developer A is the sole submission reference for the promoted representation',
);

// PRIVACY: a plain, non-promoted corpus representation the developer indexed.
const privacyIndexed = await indexDocumentSubmissionIntoCorpus(db, { documentIdentityId: idPrivacy, rawText: TEXT_PRIVACY });
const privacyRepId = privacyIndexed.representationId;
assert.equal(
  await count('SELECT COUNT(*) AS c FROM corpus_admission_promotions WHERE representation_id = ?', [privacyRepId]),
  0,
  'PRIVACY representation is NOT promoted',
);

// --- BEFORE-RESET state ----------------------------------------------

const before = {
  generation: await corpusGeneration(),
  pureShingles: await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [pure.representationId]),
  caseBShingles: await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [caseB.representationId]),
  privacyShingles: await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [privacyRepId]),
};

test('BEFORE: both promoted representations exist with shingles, decisions, content, fingerprints and an indexed promotion', async () => {
  for (const [label, p] of [['PURE', pure], ['CASEB', caseB]]) {
    assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE id = ? AND decision = ?', [p.decisionId, 'ACCEPT']), 1, `${label} accepted decision`);
    assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_content_store WHERE decision_id = ?', [p.decisionId]), 1, `${label} accepted content`);
    assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_accepted_representations WHERE decision_id = ?', [p.decisionId]), 1, `${label} accepted fingerprint`);
    assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_document_representations WHERE id = ?', [p.representationId]), 1, `${label} promoted representation`);
    assert.ok((await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [p.representationId])) > 0, `${label} promoted shingles`);
    assert.equal((await one('SELECT status FROM corpus_admission_promotions WHERE decision_id = ?', [p.decisionId])).status, 'indexed', `${label} promotion indexed`);
  }
});

test('BEFORE: a different-account document matches against each promoted representation', async () => {
  const pureMatch = await matchAnon(TEXT_PURE);
  assert.equal(pureMatch.status, 'MATCHED', 'PURE matches before reset');
  assert.equal(pureMatch.matches[0].relationshipType, 'TURNITPLUS_CORPUS_SOURCE');

  const caseBMatch = await matchAnon(TEXT_CASEB);
  assert.equal(caseBMatch.status, 'MATCHED', 'CASEB matches before reset');
  assert.equal(caseBMatch.matches.length, 1);
});

// --- RESET -----------------------------------------------------------

test('RESET: developer clears their own rooms (3 reports)', async () => {
  const res = await callReset(cookieA, { dryRun: false });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reportsDeleted, 3);
});

// --- AFTER-RESET state ----------------------------------------------

test('AFTER: the developer\'s own report/room/identity state is gone', async () => {
  assert.equal(await count('SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ?', [idA]), 0, 'saved reports gone');
  assert.equal(
    (await one('SELECT COUNT(*) AS c FROM saved_reports WHERE user_id = ? AND room_number IS NOT NULL', [idA])).c,
    0,
    'no room slot still occupied',
  );
  assert.equal(await count('SELECT COUNT(*) AS c FROM document_identities WHERE account_id = ?', [idA]), 0, 'document identities gone');
  assert.equal(await count('SELECT COUNT(*) AS c FROM report_historical_match_snapshots WHERE report_device_key = ?', [DEVICE]), 0, 'historical-match snapshots gone');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_report_jobs WHERE source_ref IN (?, ?)', [pure.sourceRef, caseB.sourceRef]), 0, 'admission job rows gone');
});

test('AFTER: accepted decision / content / fingerprint survive for BOTH promoted submissions', async () => {
  for (const [label, p] of [['PURE', pure], ['CASEB', caseB]]) {
    assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE id = ? AND decision = ?', [p.decisionId, 'ACCEPT']), 1, `${label} accepted decision survives`);
    assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_content_store WHERE decision_id = ?', [p.decisionId]), 1, `${label} accepted content survives`);
    assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_admission_accepted_representations WHERE decision_id = ?', [p.decisionId]), 1, `${label} accepted fingerprint survives`);
  }
});

test('AFTER: the promoted corpus_document_representations + corpus_document_shingles survive unchanged', async () => {
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_document_representations WHERE id = ?', [pure.representationId]), 1, 'PURE representation survives');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_document_representations WHERE id = ?', [caseB.representationId]), 1, 'CASEB representation survives (defense-in-depth guard)');
  assert.equal(
    await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [pure.representationId]),
    before.pureShingles,
    'PURE shingles unchanged',
  );
  assert.equal(
    await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [caseB.representationId]),
    before.caseBShingles,
    'CASEB shingles unchanged',
  );
});

test('AFTER: the indexed promotion rows are intact and still point at the same representations', async () => {
  for (const [label, p] of [['PURE', pure], ['CASEB', caseB]]) {
    const row = await one('SELECT status, representation_id FROM corpus_admission_promotions WHERE decision_id = ?', [p.decisionId]);
    assert.equal(row.status, 'indexed', `${label} promotion still indexed`);
    assert.equal(String(row.representation_id), p.representationId, `${label} promotion still points at its representation`);
  }
});

test('AFTER: corpus generation/index participation remains valid', async () => {
  assert.ok(await corpusGeneration() >= before.generation, 'corpus_match_generation is not corrupted / rolled back');
});

test('AFTER: a DIFFERENT-account document STILL MATCHES against both promoted representations', async () => {
  const pureMatch = await matchAnon(TEXT_PURE);
  assert.equal(pureMatch.status, 'MATCHED', 'PURE still matches after reset');
  assert.equal(pureMatch.matches[0].relationshipType, 'TURNITPLUS_CORPUS_SOURCE', 'PURE match is carried by the promoted representation');

  const caseBMatch = await matchAnon(TEXT_CASEB);
  assert.equal(caseBMatch.status, 'MATCHED', 'CASEB still matches after reset');
  assert.equal(
    caseBMatch.matches[0].relationshipType,
    'TURNITPLUS_CORPUS_SOURCE',
    'CASEB match now rests purely on the promotion — the developer\'s own submission reference is gone, yet matching survives',
  );
});

test('AFTER: the guard did NOT over-broaden — a plain non-promoted representation the developer indexed IS removed', async () => {
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_document_representations WHERE id = ?', [privacyRepId]), 0, 'PRIVACY representation deleted (last reference gone, not promoted)');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?', [privacyRepId]), 0, 'PRIVACY shingles deleted');
  assert.equal(await count('SELECT COUNT(*) AS c FROM corpus_submission_references WHERE representation_id = ?', [privacyRepId]), 0, 'PRIVACY submission reference deleted');
});
