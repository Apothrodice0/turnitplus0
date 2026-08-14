import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import {
  E8I_CLEANUP_TARGETS,
  E8I_FORBIDDEN_IDENTITY_IDS,
  E8I_LEGITIMATE_CLUSTER,
} from '../lib/e8i-cleanup-targets.ts';
import {
  verifyTarget,
  verifyLegitimateClusterUntouched,
  planE8ICleanup,
  renderDryRunReport,
  maskId,
} from '../lib/e8i-cleanup-runner.ts';
import {
  applyVerifiedDeletion,
  applyAllVerifiedDeletions,
} from '../lib/e8i-cleanup-apply.ts';
import { computeDryRun } from '../tools/e8i-cleanup.ts';

/**
 * Phase E8I: tests for the targeted production cleanup toolset. Everything
 * here runs against local, disposable SQLite files created and destroyed
 * within this file — nothing here ever touches a real Turso database,
 * production or otherwise (see this phase's own task description: "Use a
 * disposable local database for destructive simulation tests. Do NOT use
 * production for tests."). Fixtures intentionally reuse the exact ids from
 * lib/e8i-cleanup-targets.ts's pinned, production-derived allowlist — those
 * ids are not secrets (the credential that would let anyone act on them is
 * in .env.production.local, never here) — so tests exercise the real
 * allowlist the tool ships with, not a look-alike substitute.
 */

const repo = path.resolve('.');

function freshDbPath(name) {
  return path.join(repo, `test_e8i_cleanup_${name}.db`);
}

function cleanupDbFile(dbFile) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
}

const ALL_TEST_NAMES = [
  'a-happy', 'b-legit', 'c-precondition', 'd-mismatch', 'e-report-mapping',
  'f-account', 'g-age', 'h-missing-ref', 'i-representation', 'j-family',
  'k-readonly', 'm-masking', 'apply-refusal',
];
test.after(() => {
  for (const name of ALL_TEST_NAMES) cleanupDbFile(freshDbPath(name));
});

async function freshMigratedClient(name) {
  const dbFile = freshDbPath(name);
  cleanupDbFile(dbFile);
  const client = createClient({ url: `file:${dbFile}` });
  await applyMigrationsLibsql(client, path.join(repo, 'drizzle'));
  await client.execute('PRAGMA foreign_keys = ON');
  return client;
}

async function insertUser(client, id, email) {
  await client.execute({
    sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
    args: [id, email, email.split('@')[0], 'not-a-real-hash'],
  });
}

async function insertRepresentation(client, id) {
  await client.execute({
    sql: `INSERT INTO corpus_document_representations
          (id, canonical_sha256, canonical_text, word_count, canonicalization_version)
          VALUES (?,?,?,?,?)`,
    args: [id, `canonical-hash-for-${id}`, 'placeholder canonical text for testing', 100, 'canonical-text-v1'],
  });
}

async function insertIdentity(client, { id, accountId, title, canonicalSha256, rawSha256, createdAt }) {
  await client.execute({
    sql: `INSERT INTO document_identities (id, account_id, title, author, raw_sha256, canonical_sha256, created_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [id, accountId, title, null, rawSha256, canonicalSha256, createdAt],
  });
}

async function insertReference(client, { id, representationId, documentIdentityId, linkType }) {
  await client.execute({
    sql: `INSERT INTO corpus_submission_references (id, representation_id, document_identity_id, link_type, created_at)
          VALUES (?,?,?,?,?)`,
    args: [id, representationId, documentIdentityId, linkType, '2026-08-14 00:00:00'],
  });
}

async function insertSavedReport(client, { id, deviceKey, title, userId, wordCount, savedAt, updatedAt }) {
  await client.execute({
    sql: `INSERT INTO saved_reports
          (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, saved_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey, `sub-${id}`, title, savedAt, wordCount, 0, 'Low', '{}', userId, savedAt, updatedAt],
  });
}

/**
 * Seeds a local database that reproduces, row-for-row, exactly what the
 * real E8I_CLEANUP_TARGETS + E8I_LEGITIMATE_CLUSTER describe: the 4
 * duplicate-save artifact clusters (including cluster 3's real family-table
 * anomaly — see lib/e8i-cleanup-targets.ts's own header comment on why the
 * younger identity there ended up as the family SEED) plus the 1 legitimate
 * repeat-submission cluster, complete with the "noisy" extra saved_reports
 * row that made the naive title-only match wrong during the original audit.
 */
async function buildFullFixture(name) {
  const client = await freshMigratedClient(name);

  const accountA = E8I_CLEANUP_TARGETS[0].accountId;
  const accountB = E8I_CLEANUP_TARGETS[3].accountId;
  await insertUser(client, accountA, E8I_CLEANUP_TARGETS[0].accountEmailForDisplay);
  await insertUser(client, accountB, E8I_CLEANUP_TARGETS[3].accountEmailForDisplay);

  const representationIds = [...new Set(E8I_CLEANUP_TARGETS.map((t) => t.representationId).concat(E8I_LEGITIMATE_CLUSTER.representationId))];
  for (const repId of representationIds) await insertRepresentation(client, repId);

  for (const t of E8I_CLEANUP_TARGETS) {
    await insertIdentity(client, { id: t.keepIdentityId, accountId: t.accountId, title: t.title, canonicalSha256: t.canonicalSha256, rawSha256: t.rawSha256, createdAt: t.keepCreatedAt });
    await insertIdentity(client, { id: t.deleteIdentityId, accountId: t.accountId, title: t.title, canonicalSha256: t.canonicalSha256, rawSha256: t.rawSha256, createdAt: t.deleteCreatedAt });
  }
  const [legitA, legitB] = E8I_LEGITIMATE_CLUSTER.identityIds;
  await insertIdentity(client, { id: legitA, accountId: E8I_LEGITIMATE_CLUSTER.accountId, title: E8I_LEGITIMATE_CLUSTER.title, canonicalSha256: 'legit-canonical-hash', rawSha256: 'legit-raw-hash', createdAt: '2026-08-14 04:08:26' });
  await insertIdentity(client, { id: legitB, accountId: E8I_LEGITIMATE_CLUSTER.accountId, title: E8I_LEGITIMATE_CLUSTER.title, canonicalSha256: 'legit-canonical-hash', rawSha256: 'legit-raw-hash', createdAt: '2026-08-14 04:13:45' });

  // Real reference ids from the production audit — deliberately includes
  // cluster 3's inversion (delete-target's reference id, 5, is LOWER than
  // the kept identity's reference id, 6) as a live regression guard against
  // ever using reference-id ordering as an "age" signal.
  const refs = [
    [1, E8I_CLEANUP_TARGETS[3].representationId, E8I_CLEANUP_TARGETS[3].keepIdentityId, 'NEW_CONTENT_REPRESENTATION'],
    [2, E8I_CLEANUP_TARGETS[3].representationId, E8I_CLEANUP_TARGETS[3].deleteIdentityId, 'EXACT_CANONICAL_DUPLICATE'],
    [3, E8I_CLEANUP_TARGETS[0].representationId, E8I_CLEANUP_TARGETS[0].keepIdentityId, 'EXACT_CANONICAL_DUPLICATE'],
    [4, E8I_CLEANUP_TARGETS[0].representationId, E8I_CLEANUP_TARGETS[0].deleteIdentityId, 'EXACT_CANONICAL_DUPLICATE'],
    [5, E8I_CLEANUP_TARGETS[2].representationId, E8I_CLEANUP_TARGETS[2].deleteIdentityId, 'EXACT_CANONICAL_DUPLICATE'],
    [6, E8I_CLEANUP_TARGETS[2].representationId, E8I_CLEANUP_TARGETS[2].keepIdentityId, 'NEW_CONTENT_REPRESENTATION'],
    [7, E8I_CLEANUP_TARGETS[1].representationId, E8I_CLEANUP_TARGETS[1].keepIdentityId, 'NEW_CONTENT_REPRESENTATION'],
    [8, E8I_CLEANUP_TARGETS[1].representationId, E8I_CLEANUP_TARGETS[1].deleteIdentityId, 'EXACT_CANONICAL_DUPLICATE'],
    [9, E8I_LEGITIMATE_CLUSTER.representationId, legitA, 'NEW_CONTENT_REPRESENTATION'],
    [11, E8I_LEGITIMATE_CLUSTER.representationId, legitB, 'EXACT_CANONICAL_DUPLICATE'],
  ];
  for (const [id, representationId, documentIdentityId, linkType] of refs) {
    await insertReference(client, { id, representationId, documentIdentityId, linkType });
  }

  for (const t of E8I_CLEANUP_TARGETS) {
    await insertSavedReport(client, {
      id: t.expectedReportId,
      deviceKey: t.expectedDeviceKey,
      title: t.title,
      userId: t.accountId,
      wordCount: 1000,
      savedAt: t.keepCreatedAt,
      updatedAt: t.deleteCreatedAt,
    });
  }
  // The real "noisy" extra saved_reports row for cluster 1's title, from a
  // genuinely separate earlier upload — proves nearest-timestamp matching
  // (not "only match for this title") is what verification actually uses.
  await insertSavedReport(client, {
    id: '1786674609937',
    deviceKey: E8I_CLEANUP_TARGETS[0].expectedDeviceKey,
    title: E8I_CLEANUP_TARGETS[0].title,
    userId: E8I_CLEANUP_TARGETS[0].accountId,
    wordCount: 1815,
    savedAt: '2026-08-14 02:30:21',
    updatedAt: '2026-08-14 02:30:21',
  });

  await insertSavedReport(client, { id: E8I_LEGITIMATE_CLUSTER.savedReportsIds[0], deviceKey: '75fca6f2-0c78-4074-931f-2b1062dcdaf2', title: E8I_LEGITIMATE_CLUSTER.title, userId: E8I_LEGITIMATE_CLUSTER.accountId, wordCount: 1463, savedAt: '2026-08-14 04:08:26', updatedAt: '2026-08-14 04:08:27' });
  await insertSavedReport(client, { id: E8I_LEGITIMATE_CLUSTER.savedReportsIds[1], deviceKey: '75fca6f2-0c78-4074-931f-2b1062dcdaf2', title: E8I_LEGITIMATE_CLUSTER.title, userId: E8I_LEGITIMATE_CLUSTER.accountId, wordCount: 1463, savedAt: '2026-08-14 04:13:45', updatedAt: '2026-08-14 04:13:46' });

  // Cluster 3's real document_family_members anomaly: the younger
  // (delete-target) identity is the family SEED; the kept identity's own
  // membership row points at it via matched_against_identity_id. This is
  // exactly what test J checks gets cleaned up correctly (SET NULL, not a
  // cascade delete of the kept row).
  const t3 = E8I_CLEANUP_TARGETS[2];
  await client.execute({ sql: 'INSERT INTO document_families (id) VALUES (?)', args: ['test-family-c3'] });
  await client.execute({
    sql: `INSERT INTO document_family_members (family_id, document_identity_id, match_type, matched_against_identity_id, evidence_score)
          VALUES (?,?,?,?,?)`,
    args: ['test-family-c3', t3.deleteIdentityId, 'SEED', null, null],
  });
  await client.execute({
    sql: `INSERT INTO document_family_members (family_id, document_identity_id, match_type, matched_against_identity_id, evidence_score)
          VALUES (?,?,?,?,?)`,
    args: ['test-family-c3', t3.keepIdentityId, 'EXACT_CANONICAL_MATCH', t3.deleteIdentityId, 1],
  });

  return client;
}

// --- A: exact four-target allowlist -----------------------------------------

test('A: E8I_CLEANUP_TARGETS is an explicit allowlist of exactly the 4 confirmed duplicate-save-artifact clusters', () => {
  assert.equal(E8I_CLEANUP_TARGETS.length, 4);
  assert.deepEqual(E8I_CLEANUP_TARGETS.map((t) => t.cluster), [1, 2, 3, 4]);
  assert.deepEqual(E8I_CLEANUP_TARGETS.map((t) => t.title), [
    'gamorrine.docx',
    'economy in algeria.docx',
    'IT Governance and Food Traceability in Emerging Economies A COBIT 2019 Maturity Assessment of the Benamor Group, Algeria.docx',
    'gamorrine.docx',
  ]);
  for (const t of E8I_CLEANUP_TARGETS) {
    assert.match(t.keepIdentityId, /^[0-9a-f-]{36}$/, 'keepIdentityId must be a well-formed uuid');
    assert.match(t.deleteIdentityId, /^[0-9a-f-]{36}$/, 'deleteIdentityId must be a well-formed uuid');
    assert.notEqual(t.keepIdentityId, t.deleteIdentityId);
    assert.ok(Number.isInteger(t.deleteSubmissionReferenceId));
  }
  // gamorrine.docx is intentionally two separate clusters (one per account) — never collapse to one.
  assert.notEqual(E8I_CLEANUP_TARGETS[0].accountId, E8I_CLEANUP_TARGETS[3].accountId);
});

// --- B: legitimate-repeat exclusion ------------------------------------------

test('B: the legitimate repeat-submission cluster is structurally absent from the allowlist and matches E8I_FORBIDDEN_IDENTITY_IDS', () => {
  const [legitA, legitB] = E8I_LEGITIMATE_CLUSTER.identityIds;
  assert.deepEqual([...E8I_FORBIDDEN_IDENTITY_IDS].sort(), [legitA, legitB].sort());
  for (const t of E8I_CLEANUP_TARGETS) {
    assert.notEqual(t.keepIdentityId, legitA);
    assert.notEqual(t.keepIdentityId, legitB);
    assert.notEqual(t.deleteIdentityId, legitA);
    assert.notEqual(t.deleteIdentityId, legitB);
  }
});

test('B (runtime): planE8ICleanup confirms the legitimate cluster resolves to two distinct saved_reports rows and is untouched', async () => {
  const client = await buildFullFixture('b-legit');
  const result = await verifyLegitimateClusterUntouched(client);
  assert.equal(result.ok, true, result.details);
  client.close();
});

// --- C: target precondition verification (happy path) -----------------------

test('C: all 4 targets pass every verification check against a database that exactly matches the pinned allowlist', async () => {
  const client = await buildFullFixture('c-precondition');
  const plan = await planE8ICleanup(client);
  assert.equal(plan.allVerified, true, JSON.stringify(plan.entries.filter((e) => !e.verification.ok), null, 2));
  for (const entry of plan.entries) {
    assert.ok(entry.verification.checks.every((c) => c.ok), `cluster ${entry.cluster} had a failing check: ${JSON.stringify(entry.verification.checks.filter((c) => !c.ok))}`);
    assert.deepEqual(entry.plannedActions, ['DELETE_REFERENCE', 'DELETE_IDENTITY']);
  }
  assert.deepEqual(plan.summary, { referencesToDelete: 4, identitiesToDelete: 4, representationsToDelete: 0, snapshotsToInvalidateLater: 4 });
  client.close();
});

// --- D: mismatch -> refusal ---------------------------------------------------

test('D: a canonical_sha256 mismatch on the delete-target refuses that cluster only, others remain verified', async () => {
  const client = await buildFullFixture('d-mismatch');
  const t = E8I_CLEANUP_TARGETS[0];
  await client.execute({ sql: 'UPDATE document_identities SET canonical_sha256 = ? WHERE id = ?', args: ['tampered-hash', t.deleteIdentityId] });

  const plan = await planE8ICleanup(client);
  const entry1 = plan.entries.find((e) => e.cluster === 1);
  assert.equal(entry1.verification.ok, false);
  assert.ok(entry1.verification.checks.find((c) => c.code === 'CANONICAL_HASH_MATCH' && !c.ok));
  assert.deepEqual(entry1.plannedActions, []);
  assert.equal(plan.allVerified, false);

  for (const cluster of [2, 3, 4]) {
    const entry = plan.entries.find((e) => e.cluster === cluster);
    assert.equal(entry.verification.ok, true, `cluster ${cluster} should be unaffected by cluster 1's tampering`);
  }
  client.close();
});

// --- E: wrong report mapping -> refusal --------------------------------------

test('E: retitling the mapped saved_reports row breaks the report-mapping resolution and refuses', async () => {
  const client = await buildFullFixture('e-report-mapping');
  const t = E8I_CLEANUP_TARGETS[1];
  await client.execute({ sql: 'UPDATE saved_reports SET title = ? WHERE id = ?', args: ['a completely different title.docx', t.expectedReportId] });

  const verification = await verifyTarget(client, t);
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.find((c) => c.code === 'REPORT_MAPPING_MATCHES' && !c.ok));
  client.close();
});

// --- F: wrong account -> refusal ---------------------------------------------

test('F: a delete-target that has drifted to a different account refuses', async () => {
  const client = await buildFullFixture('f-account');
  const t = E8I_CLEANUP_TARGETS[0];
  const otherAccount = E8I_CLEANUP_TARGETS[3].accountId;
  await client.execute({ sql: 'UPDATE document_identities SET account_id = ? WHERE id = ?', args: [otherAccount, t.deleteIdentityId] });

  const verification = await verifyTarget(client, t);
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.find((c) => c.code === 'DELETE_ACCOUNT_MATCH' && !c.ok));
  client.close();
});

// --- G: wrong age ordering -> refusal -----------------------------------------

test('G: a delete-target created BEFORE the kept identity refuses on age ordering', async () => {
  const client = await freshMigratedClient('g-age');
  await insertUser(client, 'user-g', 'user-g@example.test');
  await insertRepresentation(client, 'rep-g');
  await insertIdentity(client, { id: 'keep-g', accountId: 'user-g', title: 'age-test.docx', canonicalSha256: 'hash-g', rawSha256: 'hash-g', createdAt: '2026-08-14 03:49:19' });
  // Deliberately created BEFORE "keep-g" — an inverted, invalid scenario.
  await insertIdentity(client, { id: 'delete-g', accountId: 'user-g', title: 'age-test.docx', canonicalSha256: 'hash-g', rawSha256: 'hash-g', createdAt: '2026-08-14 03:49:10' });
  await insertReference(client, { id: 100, representationId: 'rep-g', documentIdentityId: 'keep-g', linkType: 'NEW_CONTENT_REPRESENTATION' });
  await insertReference(client, { id: 101, representationId: 'rep-g', documentIdentityId: 'delete-g', linkType: 'EXACT_CANONICAL_DUPLICATE' });
  await insertSavedReport(client, { id: 'report-g', deviceKey: 'device-g', title: 'age-test.docx', userId: 'user-g', wordCount: 10, savedAt: '2026-08-14 03:49:10', updatedAt: '2026-08-14 03:49:19' });

  const target = {
    cluster: 99, title: 'age-test.docx', accountId: 'user-g', accountEmailForDisplay: 'user-g@example.test',
    representationId: 'rep-g', canonicalSha256: 'hash-g', rawSha256: 'hash-g',
    keepIdentityId: 'keep-g', keepCreatedAt: '2026-08-14 03:49:19',
    deleteIdentityId: 'delete-g', deleteCreatedAt: '2026-08-14 03:49:10',
    deleteSubmissionReferenceId: 101, expectedReportId: 'report-g', expectedDeviceKey: 'device-g', maxDeltaSeconds: 2,
  };
  const verification = await verifyTarget(client, target);
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.find((c) => c.code === 'AGE_ORDERING' && !c.ok));
  client.close();
});

// --- H: missing reference -> refusal ------------------------------------------

test('H: a missing corpus_submission_references row for the delete-target refuses', async () => {
  const client = await buildFullFixture('h-missing-ref');
  const t = E8I_CLEANUP_TARGETS[2];
  await client.execute({ sql: 'DELETE FROM corpus_submission_references WHERE id = ?', args: [t.deleteSubmissionReferenceId] });

  const verification = await verifyTarget(client, t);
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.find((c) => c.code === 'REFERENCE_EXISTS_AND_MATCHES' && !c.ok));
  client.close();
});

// --- I: no representation deletion --------------------------------------------

test('I: applying all 4 verified deletions never removes a corpus_document_representations row', async () => {
  const client = await buildFullFixture('i-representation');
  const before = await client.execute('SELECT id FROM corpus_document_representations ORDER BY id');
  const beforeIds = before.rows.map((r) => r.id).sort();

  const outcomes = await applyAllVerifiedDeletions(client);
  assert.ok(outcomes.every((o) => o.status === 'applied'), JSON.stringify(outcomes));

  const after = await client.execute('SELECT id FROM corpus_document_representations ORDER BY id');
  const afterIds = after.rows.map((r) => r.id).sort();
  assert.deepEqual(afterIds, beforeIds, 'representation rows must be byte-for-byte unchanged');
  client.close();
});

// --- J: cluster-3 family pointer behavior -------------------------------------

test('J: deleting cluster 3\'s younger (SEED) identity cascades its own family-membership row but only SET NULLs the kept identity\'s matched_against pointer', async () => {
  const client = await buildFullFixture('j-family');
  const t3 = E8I_CLEANUP_TARGETS[2];

  const before = await client.execute({ sql: 'SELECT document_identity_id, matched_against_identity_id FROM document_family_members WHERE family_id = ? ORDER BY document_identity_id', args: ['test-family-c3'] });
  assert.equal(before.rows.length, 2, 'sanity: both family members exist before deletion');

  const outcome = await applyVerifiedDeletion(client, t3);
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome));

  const after = await client.execute({ sql: 'SELECT document_identity_id, matched_against_identity_id FROM document_family_members WHERE family_id = ?', args: ['test-family-c3'] });
  assert.equal(after.rows.length, 1, 'the deleted (SEED) identity\'s own family-membership row must be gone (cascade)');
  assert.equal(after.rows[0].document_identity_id, t3.keepIdentityId, 'the kept identity\'s membership row must remain');
  assert.equal(after.rows[0].matched_against_identity_id, null, 'its matched_against_identity_id must be SET NULL, not left dangling');

  const shingleCheck = await client.execute({ sql: 'SELECT COUNT(*) AS n FROM document_identities WHERE id = ?', args: [t3.deleteIdentityId] });
  assert.equal(Number(shingleCheck.rows[0].n), 0, 'the deleted identity row itself must be gone');
  const keepStillThere = await client.execute({ sql: 'SELECT COUNT(*) AS n FROM document_identities WHERE id = ?', args: [t3.keepIdentityId] });
  assert.equal(Number(keepStillThere.rows[0].n), 1, 'the kept identity must be untouched');

  client.close();
});

// --- K: dry-run performs zero writes ------------------------------------------

test('K (structural): lib/e8i-cleanup-runner.ts contains no write-statement keywords anywhere in its source', () => {
  const source = fs.readFileSync(path.join(repo, 'lib/e8i-cleanup-runner.ts'), 'utf8');
  assert.doesNotMatch(source, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(source, /\bUPDATE\s+\w+\s+SET\b/i);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(source, /\bDROP\s+(TABLE|INDEX)\b/i);
  assert.doesNotMatch(source, /\bALTER\s+TABLE\b/i);
});

test('K (behavioral): planE8ICleanup issues only SELECT/PRAGMA statements against a real seeded database — proven with a read-only-guard client', async () => {
  const client = await buildFullFixture('k-readonly');
  const guarded = {
    execute: async (stmt) => {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql;
      assert.match(sql.trim(), /^(SELECT|PRAGMA)\b/i, `dry-run path issued a non-read statement: ${sql}`);
      return client.execute(stmt);
    },
  };
  const plan = await planE8ICleanup(guarded);
  assert.equal(plan.allVerified, true);
  client.close();
});

// --- L: production requires confirmation --------------------------------------

test('L: computeDryRun requires BOTH --execute and the exact confirm string for env=production; env=local only needs --execute', () => {
  assert.equal(computeDryRun('production', {}), true, 'no flags at all must stay dry-run');
  assert.equal(computeDryRun('production', { execute: true }), true, '--execute alone (no confirm) must stay dry-run');
  assert.equal(computeDryRun('production', { execute: true, confirm: 'WRONG-STRING' }), true, 'a wrong confirm string must stay dry-run');
  assert.equal(computeDryRun('production', { execute: true, confirm: 'E8I-CLEANUP-PRODUCTION' }), false, 'the exact confirm string plus --execute is required to leave dry-run');
  assert.equal(computeDryRun('production', { confirm: 'E8I-CLEANUP-PRODUCTION' }), true, 'confirm string without --execute must stay dry-run');
  assert.equal(computeDryRun('local', {}), true);
  assert.equal(computeDryRun('local', { execute: true }), false, 'local mode only needs --execute, no confirm string required');
});

// --- M: masked output / no credential logging ----------------------------------

test('M (structural): tools/e8i-cleanup.ts never logs a raw token/url, only the derived hostnameLabel', () => {
  const source = fs.readFileSync(path.join(repo, 'tools/e8i-cleanup.ts'), 'utf8');
  const consoleCalls = source.split(/\r?\n/).filter((l) => /console\.(log|error)/.test(l));
  for (const line of consoleCalls) {
    assert.doesNotMatch(line, /\bauthToken\b/, `must never log authToken directly: "${line.trim()}"`);
    if (/\burl\b/.test(line)) {
      assert.match(line, /hostnameLabel\(url\)/, `"url" must only ever be logged via hostnameLabel(): "${line.trim()}"`);
    }
  }
});

test('M (functional): the dry-run report masks account/identity/reference ids but leaves report id and representation id in full', async () => {
  const client = await buildFullFixture('m-masking');
  const plan = await planE8ICleanup(client);
  const report = renderDryRunReport(plan);

  for (const t of E8I_CLEANUP_TARGETS) {
    assert.doesNotMatch(report, new RegExp(t.accountId), `full account id ${t.accountId} must never appear unmasked`);
    assert.doesNotMatch(report, new RegExp(t.deleteIdentityId), `full delete-identity id must never appear unmasked`);
    assert.doesNotMatch(report, new RegExp(t.keepIdentityId), `full keep-identity id must never appear unmasked`);
    assert.match(report, new RegExp(maskId(t.accountId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(report, new RegExp(t.expectedReportId), 'report id is shown in full, by design');
    assert.match(report, new RegExp(t.representationId), 'representation id is shown in full, by design');
  }
  client.close();
});

// --- apply-time re-verification refuses a target that changed after planning ---

test('apply-time re-verification: applyVerifiedDeletion refuses (writes nothing) if the target changed after the plan was computed', async () => {
  const client = await buildFullFixture('apply-refusal');
  const t = E8I_CLEANUP_TARGETS[1];

  const planBefore = await planE8ICleanup(client);
  assert.ok(planBefore.entries.find((e) => e.cluster === 2).verification.ok);

  // The database changes AFTER the plan was computed but BEFORE apply runs.
  await client.execute({ sql: 'DELETE FROM saved_reports WHERE id = ?', args: [t.expectedReportId] });

  const outcome = await applyVerifiedDeletion(client, t);
  assert.equal(outcome.status, 'refused');
  assert.ok(outcome.verification.checks.find((c) => c.code === 'SAVED_REPORT_STILL_EXISTS' && !c.ok));

  const stillThere = await client.execute({ sql: 'SELECT COUNT(*) AS n FROM document_identities WHERE id = ?', args: [t.deleteIdentityId] });
  assert.equal(Number(stillThere.rows[0].n), 1, 'refused apply must not have deleted the identity');
  client.close();
});
