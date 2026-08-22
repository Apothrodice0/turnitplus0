import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';
import { canonicalSha256 } from '../lib/document-identity.ts';

/**
 * Privacy hardening (production audit fix, item 1): proves DELETE
 * /api/reports/[id] now removes a report's OWN document_identities /
 * document_identity_shingles / document_family_members / corpus_submission_
 * references / corpus_document_representations rows — not just the
 * saved_reports row and its historical-match snapshot (the pre-fix
 * behavior, still covered by tests/api-reports.test.mjs, unaffected here).
 * Real route calls only, no mocking, matching this repo's existing test
 * convention.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_report_deletion_privacy.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);

test.after(() => {
  setupClient.close();
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

let counter = 0;
function nextId() {
  counter += 1;
  return `deletion-report-${counter}`;
}

async function signup(email, deviceKey) {
  await resetAuthRateForTest('deletion-signup-' + email);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'deletion-signup-' + email },
    body: JSON.stringify({ email, password: 'deletion-password-1', username: email.split('@')[0], deviceKey }),
  });
  const res = await signupRoute.POST(req);
  // Consent is granted immediately so these tests can exercise the FULL
  // deletion cascade (identity + corpus rows), not just the identity-only
  // path — see tests/report-privacy-consent.test.mjs for the gate itself.
  await setupClient.execute({ sql: 'UPDATE users SET corpus_reuse_consented_at = CURRENT_TIMESTAMP WHERE email = ?', args: [email] });
  return { res, cookie: extractCookie(res) };
}

// Room/slot architecture: required for an authenticated first save (see
// app/api/reports/route.ts); ignored for anonymous requests and resaves. A
// fresh, auto-incrementing default so a scenario posting more than one
// genuinely new report for the same account never collides with itself —
// this file's scenarios are about report/corpus deletion, not room
// occupancy.
let roomCounter = 0;
function nextRoom() {
  const room = roomCounter % 10;
  roomCounter += 1;
  return room;
}

async function postReport(deviceKey, { cookie, id, title = 'deletion.pdf', text, room = nextRoom() } = {}) {
  await resetRateForTest('deletion-post');
  const reportId = id ?? nextId();
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': 'deletion-post' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceKey,
      id: reportId,
      submissionId: 'sub-' + reportId,
      title,
      createdAt: new Date().toISOString(),
      wordCount: 100,
      archiveScore: 5,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      room,
      payload: { version: 11, id: Date.now(), submissionId: 'sub-' + reportId, title, author: '', assignment: '', created: new Date().toISOString(), score: 5, archiveScore: 5, text, wordCount: 100, characterCount: 500, pageCount: 1, fileSize: '1 KB', databaseSize: 230, corpusVersion: 'test', scoreBand: 'Low' },
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, id: reportId };
}

async function deleteReport(id, { deviceKey, cookie } = {}) {
  await resetRateForTest('deletion-delete');
  const headers = { 'x-forwarded-for': 'deletion-delete' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { method: 'DELETE', headers });
  return reportIdRoute.DELETE(req, { params: Promise.resolve({ id }) });
}

async function documentIdentityIdForReport(deviceKey, id) {
  const result = await setupClient.execute({ sql: 'SELECT document_identity_id FROM saved_reports WHERE device_key = ? AND id = ?', args: [deviceKey, id] });
  return result.rows[0]?.document_identity_id ? String(result.rows[0].document_identity_id) : null;
}

async function rowExists(table, column, value) {
  const result = await setupClient.execute({ sql: `SELECT 1 FROM ${table} WHERE ${column} = ?`, args: [value] });
  return result.rows.length > 0;
}

async function countRows(table, column, value) {
  const result = await setupClient.execute({ sql: `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${column} = ?`, args: [value] });
  return Number(result.rows[0].cnt);
}

async function representationForText(text) {
  const hash = canonicalSha256(text);
  const result = await setupClient.execute({ sql: 'SELECT id FROM corpus_document_representations WHERE canonical_sha256 = ?', args: [hash] });
  return result.rows[0] ? String(result.rows[0].id) : null;
}

// --- The link itself is actually recorded -----------------------------------

test('LINK: saving a report records saved_reports.document_identity_id, for both signed-in and anonymous saves', async () => {
  const { cookie } = await signup('deletion-link-a@example.test', 'deletion-device-link-a');
  const { id: signedInId } = await postReport('deletion-device-link-a', { cookie, text: 'Cartographers digitizing a nineteenth-century coastal survey georeferenced each hand-drawn sounding against a modern bathymetric chart.' });
  const signedInIdentity = await documentIdentityIdForReport('deletion-device-link-a', signedInId);
  assert.ok(signedInIdentity, 'a signed-in report must have its document_identity_id set');

  const { id: anonId } = await postReport('deletion-device-link-anon', { text: 'Anonymous submission text used only to verify the identity link is captured regardless of account state.' });
  const anonIdentity = await documentIdentityIdForReport('deletion-device-link-anon', anonId);
  assert.ok(anonIdentity, 'an anonymous report must also have its document_identity_id set — identity capture happens for both');
});

// --- FULL CASCADE: identity, shingles, family, corpus all removed ----------

test('CASCADE: deleting a report removes its document_identities, document_identity_shingles, and (as the sole reference) its corpus_document_representations/corpus_submission_references rows', async () => {
  const text = 'Hydrologists instrumenting an ephemeral desert wash with pressure transducers captured the full stage hydrograph of three separate flash-flood events across one monsoon season.';
  const { cookie } = await signup('deletion-cascade-a@example.test', 'deletion-device-cascade-a');
  const { id: reportId } = await postReport('deletion-device-cascade-a', { cookie, text });

  const identityId = await documentIdentityIdForReport('deletion-device-cascade-a', reportId);
  assert.ok(identityId, 'sanity: identity must exist before deletion');
  assert.ok(await rowExists('document_identities', 'id', identityId), 'sanity: identity row present before delete');
  assert.ok(await countRows('document_identity_shingles', 'document_identity_id', identityId) > 0, 'sanity: shingles present before delete');
  const representationId = await representationForText(text);
  assert.ok(representationId, 'sanity: representation present before delete (consent was granted)');

  const del = await deleteReport(reportId, { cookie });
  assert.equal(del.status, 200);

  assert.equal(await rowExists('document_identities', 'id', identityId), false, 'document_identities row must be gone after delete');
  assert.equal(await countRows('document_identity_shingles', 'document_identity_id', identityId), 0, 'document_identity_shingles rows must be gone (FK cascade)');
  assert.equal(await countRows('document_family_members', 'document_identity_id', identityId), 0, 'document_family_members rows must be gone (FK cascade)');
  assert.equal(await countRows('corpus_submission_references', 'document_identity_id', identityId), 0, 'corpus_submission_references row must be gone (FK cascade)');
  assert.equal(await rowExists('corpus_document_representations', 'id', representationId), false, 'the representation must be deleted — this was its ONLY remaining reference');

  const saved = await setupClient.execute({ sql: 'SELECT 1 FROM saved_reports WHERE device_key = ? AND id = ?', args: ['deletion-device-cascade-a', reportId] });
  assert.equal(saved.rows.length, 0, 'the saved_reports row itself must still be deleted, exactly as before this fix');
});

// --- SHARED TEXT: representation survives while another live reference exists ---

test('SHARED: deleting one of two reports sharing identical (consented) text preserves the representation for the still-live report, then removes it once the last reference is also deleted', async () => {
  const text = 'Paleontologists CT-scanning an articulated theropod forelimb fossil identified previously undescribed pneumatic foramina consistent with an extensive postcranial air-sac system.';

  const { cookie: cookieA } = await signup('deletion-shared-a@example.test', 'deletion-device-shared-a');
  const { cookie: cookieB } = await signup('deletion-shared-b@example.test', 'deletion-device-shared-b');

  const { id: reportA } = await postReport('deletion-device-shared-a', { cookie: cookieA, text });
  const { id: reportB } = await postReport('deletion-device-shared-b', { cookie: cookieB, text, title: 'deletion-shared-b.pdf' });

  const representationId = await representationForText(text);
  assert.ok(representationId, 'sanity: one shared representation must exist');
  assert.equal(await countRows('corpus_submission_references', 'representation_id', representationId), 2, 'sanity: two references (A and B) must point at the shared representation');

  const identityA = await documentIdentityIdForReport('deletion-device-shared-a', reportA);

  // Delete A's report: A's identity/reference must go, but the SHARED text
  // must survive because B's live report still legitimately needs it.
  const delA = await deleteReport(reportA, { cookie: cookieA });
  assert.equal(delA.status, 200);
  assert.equal(await rowExists('document_identities', 'id', identityA), false, "A's identity must be gone");
  assert.ok(await rowExists('corpus_document_representations', 'id', representationId), "the shared representation must SURVIVE — B's report still references it");
  assert.equal(await countRows('corpus_submission_references', 'representation_id', representationId), 1, 'exactly one reference (B\'s) must remain');

  // B's report must be completely unaffected — same text still readable.
  const bGet = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${reportB}`, { headers: { cookie: `tp_session_v1=${cookieB}` } }),
    { params: Promise.resolve({ id: reportB }) },
  );
  assert.equal(bGet.status, 200, "B's report must still be fully readable after A's deletion");

  // Now delete B's report too — this WAS the last remaining reference, so
  // the representation (and its canonical_text) must finally be removed.
  const identityB = await documentIdentityIdForReport('deletion-device-shared-b', reportB);
  const delB = await deleteReport(reportB, { cookie: cookieB });
  assert.equal(delB.status, 200);
  assert.equal(await rowExists('document_identities', 'id', identityB), false, "B's identity must be gone");
  assert.equal(await rowExists('corpus_document_representations', 'id', representationId), false, 'the representation must now be deleted — its last reference is gone');
});

// --- NO-CONSENT case: identity-only cleanup, nothing corpus-side to remove --

test('NO-CONSENT: deleting a report from a non-consenting account cleans up its identity/shingle rows; there is no corpus data to remove', async () => {
  const text = 'Textile conservators analyzing degraded silk fibers from a museum garment used micro-Raman spectroscopy to identify the original dye source without further sampling.';
  const { cookie } = await signup('deletion-noconsent-a@example.test', 'deletion-device-noconsent-a');
  // Deliberately revoke the consent this file's signup() helper grants by default.
  await setupClient.execute({ sql: "UPDATE users SET corpus_reuse_consented_at = NULL WHERE email = 'deletion-noconsent-a@example.test'" });

  const { id: reportId } = await postReport('deletion-device-noconsent-a', { cookie, text });
  const identityId = await documentIdentityIdForReport('deletion-device-noconsent-a', reportId);
  assert.ok(identityId, 'identity is still captured regardless of consent');
  assert.equal(await representationForText(text), null, 'no corpus representation should exist without consent');

  const del = await deleteReport(reportId, { cookie });
  assert.equal(del.status, 200);
  assert.equal(await rowExists('document_identities', 'id', identityId), false, 'identity row must still be cleaned up even though it was never corpus-indexed');
});

// --- LEGACY: a report saved before this migration (no link) deletes safely --

test('LEGACY: a report with no document_identity_id (simulating pre-migration data) deletes its own row cleanly, without touching any other identity', async () => {
  const { cookie } = await signup('deletion-legacy-a@example.test', 'deletion-device-legacy-a');
  const legacyId = nextId();
  // Insert directly, bypassing the route, to simulate a row saved before
  // saved_reports.document_identity_id existed — NULL, never backfilled.
  await setupClient.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [legacyId, 'deletion-device-legacy-a', 'sub-legacy', 'legacy.pdf', new Date().toISOString(), 10, 0, 'Low', JSON.stringify({ text: 'legacy text' })],
  });

  const del = await deleteReport(legacyId, { deviceKey: 'deletion-device-legacy-a' });
  assert.equal(del.status, 200, 'a legacy report with no identity link must still delete successfully');
  const saved = await setupClient.execute({ sql: 'SELECT 1 FROM saved_reports WHERE device_key = ? AND id = ?', args: ['deletion-device-legacy-a', legacyId] });
  assert.equal(saved.rows.length, 0);
});

// --- AUTHORIZATION: cannot trigger cleanup of another account's data -------

test('AUTH: deleting a nonexistent/not-owned report id never touches another account\'s identity or corpus data', async () => {
  const text = 'Mycologists surveying post-fire fungal succession in a burned conifer stand documented a distinct pyrophilous community dominated by pinicola-associated genera.';
  const { cookie: cookieA } = await signup('deletion-auth-a@example.test', 'deletion-device-auth-a');
  const { cookie: cookieB } = await signup('deletion-auth-b@example.test', 'deletion-device-auth-b');

  const { id: reportA } = await postReport('deletion-device-auth-a', { cookie: cookieA, text });
  const identityA = await documentIdentityIdForReport('deletion-device-auth-a', reportA);
  assert.ok(identityA);

  // B attempts to delete A's report id under B's own session — the
  // ownership-scoped SQL (id + user_id) must find no row, so nothing happens.
  const del = await deleteReport(reportA, { cookie: cookieB });
  assert.equal(del.status, 200, 'delete is idempotent-looking even for a non-owned id (matches this route\'s existing, unchanged behavior)');

  assert.ok(await rowExists('document_identities', 'id', identityA), "A's identity must be completely untouched by B's attempt");
  const saved = await setupClient.execute({ sql: 'SELECT 1 FROM saved_reports WHERE device_key = ? AND id = ?', args: ['deletion-device-auth-a', reportA] });
  assert.equal(saved.rows.length, 1, "A's report itself must still exist — B never owned it");
});
