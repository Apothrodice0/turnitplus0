import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createHmac } from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { createSession } from '../lib/auth-session.ts';
import { deleteAccountData, deleteAllReportDataForAccount, invalidateSessionsAndDeleteUser } from '../lib/account-deletion.ts';
import {
  OWNER_LINK_HMAC_KEY_ENV,
  OWNER_LINK_ACCOUNT_REF_DOMAIN,
  OWNER_LINK_EVIDENCE_FINGERPRINT_DOMAIN,
  OWNER_LINK_KEY_VERSION,
  OWNER_BOUND_SIGNAL_TYPES,
  OBSERVATION_ONLY_SIGNAL_TYPES,
  ALL_OWNER_LINK_SIGNAL_TYPES,
  OWNER_LINK_WITHDRAWAL_REASONS,
  getOwnerLinkHmacKey,
  isOwnerLinkInferenceAvailable,
  isOwnerLinkWithdrawalReason,
  assertOwnerLinkWithdrawalReason,
  ownerAccountRef,
  canonicalOwnerRefPair,
  deriveOwnerRefPair,
  ownerLinkEvidenceFingerprint,
  evidenceCanEstablishActiveLink,
  resolveLinkStatusFromEvidence,
  strongestConfidenceOf,
  sharedVerifiedPassportEvidenceConfidence,
  crossPassportActorCooccurrenceConfidence,
  boundOwnerLinkDetail,
  isOwnerBoundSignal,
  isObservationOnlySignal,
  OWNER_LINK_EVENT_TYPES,
  OWNER_LINK_EVENT_STATES,
  OWNER_LINK_EVENT_SHAPES,
  isOwnerLinkEventType,
  ownerLinkEventTypeAllowsReason,
  assertOwnerLinkEventShape,
} from '../lib/owner-link.ts';
import * as ownerLinkModule from '../lib/owner-link.ts';
import { DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR } from '../lib/device-passport-actor-ledger.ts';
import {
  readDirectOwnerLink,
  readDirectActiveOwnerLinkBetween,
  readOwnerLinkEvidence,
  readOwnerLinkEvents,
  readOwnerLinkEventsForEvidence,
  readAccountOwnerLinkGeneration,
  readOwnerRefLinkGeneration,
  bumpOwnerLinkGenerationsForPair,
  readReportSnapshotOwnerLinkGeneration,
  stampReportSnapshotOwnerLinkGeneration,
  upsertOwnerLinkEvidence,
  withdrawOwnerLinkEvidence,
  withdrawOwnerLink,
} from '../lib/owner-link-repo.ts';

/**
 * Direct owner-link FOUNDATION — SCHEMA + STORAGE ONLY. No scoring change; the
 * OWNER_LINK_SELF_ENABLED flag is not wired anywhere. These tests cover the
 * pseudonym, the canonical unordered pair, the non-transitive direct-link
 * helpers, evidence UPSERT / tombstone semantics, the generation counters, the
 * two concrete evidence-semantics rules for this phase, and the privacy
 * invariants.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_owner_link_foundation.db');
function cleanup() {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
}
cleanup();

const KEY = 'test-only-owner-link-hmac-key-not-a-real-secret';
const originalKey = process.env[OWNER_LINK_HMAC_KEY_ENV];
process.env[OWNER_LINK_HMAC_KEY_ENV] = KEY;
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const client = createClient({ url: `file:${dbFile}` });
await client.execute('PRAGMA foreign_keys = ON');
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  if (originalKey === undefined) delete process.env[OWNER_LINK_HMAC_KEY_ENV];
  else process.env[OWNER_LINK_HMAC_KEY_ENV] = originalKey;
  cleanup();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let seq = 0;
const uniq = (p) => `${p}-owner-${++seq}-zzz`;
const expectedRef = (accountId) => createHmac('sha256', KEY).update(`${OWNER_LINK_ACCOUNT_REF_DOMAIN}${accountId}`, 'utf8').digest('hex');
const fp = (signalType, ...parts) => ownerLinkEvidenceFingerprint(signalType, parts);

function withoutKey(fn) {
  const original = process.env[OWNER_LINK_HMAC_KEY_ENV];
  delete process.env[OWNER_LINK_HMAC_KEY_ENV];
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env[OWNER_LINK_HMAC_KEY_ENV];
    else process.env[OWNER_LINK_HMAC_KEY_ENV] = original;
  });
}

async function countRows(table) {
  return Number((await client.execute(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0].c);
}
async function dumpOwnerLinkTables() {
  const links = (await client.execute('SELECT * FROM account_owner_links ORDER BY id')).rows;
  const evidence = (await client.execute('SELECT * FROM account_owner_link_evidence ORDER BY id')).rows;
  const state = (await client.execute('SELECT * FROM account_owner_link_state ORDER BY account_ref, key_version')).rows;
  const events = (await client.execute('SELECT * FROM account_owner_link_events ORDER BY id')).rows;
  return JSON.stringify({ links, evidence, state, events });
}
async function ensureUser(id) {
  await client.execute({
    sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
    args: [id, `${id}@e.test`, id, 'x'],
  });
  return createSession(client, id);
}

/**
 * Establish an ACTIVE owner link the ONLY way v1 allows: a HIGH-confidence
 * owner-bound evidence row, which in practice today is ADMIN_MANUAL (see
 * evidenceCanEstablishActiveLink — a MEDIUM owner-bound row is SUPPORTING only
 * and never establishes/keeps ACTIVE). `ref` is a stable fingerprint
 * discriminator so revive / reactivation tests can re-observe the same row.
 * `opts.{createdBy,decidedBy}` default to ADMIN (an admin-manual link).
 */
async function establishOwnerLink(accountA, accountB, ref = uniq('adm'), at = Date.now(), opts = {}) {
  return upsertOwnerLinkEvidence(client, {
    accountId: accountA,
    candidateSourceAccountId: accountB,
    signalType: 'ADMIN_MANUAL',
    confidence: 'HIGH',
    evidenceFingerprint: fp('ADMIN_MANUAL', ref),
    observedAt: at,
    createdBy: opts.createdBy ?? 'ADMIN',
    decidedBy: opts.decidedBy ?? 'ADMIN',
  });
}

/** Attach one MEDIUM owner-bound SUPPORTING evidence row (cannot establish; only ever attaches to an existing link). */
async function addSupportingEvidence(accountA, accountB, signalType, ref = uniq('sup'), at = Date.now(), detail = undefined) {
  return upsertOwnerLinkEvidence(client, {
    accountId: accountA,
    candidateSourceAccountId: accountB,
    signalType,
    confidence: 'MEDIUM',
    evidenceFingerprint: fp(signalType, ref),
    observedAt: at,
    createdBy: 'SYSTEM',
    detail,
  });
}

// ===========================================================================
// 1 — deterministic HMAC owner refs
// ===========================================================================

test('1: ownerAccountRef is a deterministic, domain-separated HMAC pseudonym — never the raw id', () => {
  assert.equal(OWNER_LINK_KEY_VERSION, 1);
  const id = uniq('acct');
  const a = ownerAccountRef(id);
  const b = ownerAccountRef(id);
  assert.equal(a, b, 'same id -> same ref');
  assert.equal(a, expectedRef(id), 'ref is HMAC-SHA256(key, "TP_OWNER_LINK_V1:" + id)');
  assert.equal(a.length, 64);
  assert.notEqual(a, id);
  assert.notEqual(ownerAccountRef(uniq('acct')), a, 'different id -> different ref');
  assert.equal(ownerAccountRef(''), null);
});

// ===========================================================================
// 2 — missing key => fail closed / no owner-link inference
// ===========================================================================

test('2: with OWNER_LINK_HMAC_KEY missing, nothing is derived and nothing is written (fail closed)', async () => {
  await withoutKey(async () => {
    assert.equal(getOwnerLinkHmacKey(), null);
    assert.equal(isOwnerLinkInferenceAvailable(), false);
    assert.equal(ownerAccountRef(uniq('acct')), null);
    assert.equal(deriveOwnerRefPair(uniq('a'), uniq('b')), null);
    assert.equal(ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['x']), null);

    const linksBefore = await countRows('account_owner_links');
    const res = await upsertOwnerLinkEvidence(client, {
      accountId: uniq('a'), candidateSourceAccountId: uniq('b'),
      signalType: 'SHARED_DEVICE_PASSPORT', confidence: 'MEDIUM',
      evidenceFingerprint: 'anything', observedAt: Date.now(), createdBy: 'SYSTEM',
    });
    assert.equal(res.outcome, 'NO_INFERENCE_KEY');
    assert.equal(res.linkId, null);
    assert.equal(await countRows('account_owner_links'), linksBefore, 'no link row written without a key');
    assert.equal(await readAccountOwnerLinkGeneration(client, uniq('a')), 0, 'generation reads 0 without a key');
  });
});

// ===========================================================================
// 3 — distinct domain separator from Device Passport actor keys
// ===========================================================================

test('3: the owner-link keying namespace is distinct from the Device Passport actor-key namespace', () => {
  assert.notEqual(OWNER_LINK_ACCOUNT_REF_DOMAIN, DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR);
  assert.notEqual(OWNER_LINK_ACCOUNT_REF_DOMAIN, OWNER_LINK_EVIDENCE_FINGERPRINT_DOMAIN);
  const id = uniq('acct');
  const deviceActorKey = createHmac('sha256', KEY).update(`${DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR}:${id}`, 'utf8').digest('hex');
  assert.notEqual(ownerAccountRef(id), deviceActorKey, 'same key + same id, different namespace -> different digest');
});

// ===========================================================================
// 4 — canonical unordered A/B == B/A
// ===========================================================================

test('4: the canonical pair is unordered — deriveOwnerRefPair(A,B) === deriveOwnerRefPair(B,A)', () => {
  const A = uniq('a');
  const B = uniq('b');
  const ab = deriveOwnerRefPair(A, B);
  const ba = deriveOwnerRefPair(B, A);
  assert.deepEqual(ab, ba);
  assert.ok(ab.lo < ab.hi, 'lo is lexicographically smaller than hi');
  assert.equal(ab.keyVersion, OWNER_LINK_KEY_VERSION);
  assert.equal(canonicalOwnerRefPair(ownerAccountRef(A), ownerAccountRef(A)), null, 'a self-pair is not a link');
});

// ===========================================================================
// 5 — no raw account ids in any persisted owner-link row
// ===========================================================================

test('5: raw account ids never appear in account_owner_links / _evidence / _state; detail_json is bounded', async () => {
  const A = uniq('raw-check-a');
  const B = uniq('raw-check-b');
  await upsertOwnerLinkEvidence(client, {
    accountId: A, candidateSourceAccountId: B,
    signalType: 'ADMIN_MANUAL', confidence: 'HIGH',
    evidenceFingerprint: fp('ADMIN_MANUAL', uniq('adm')),
    observedAt: Date.now(), createdBy: 'ADMIN', decidedBy: 'ADMIN',
    detail: {
      subjectAccountId: A,
      candidateAccountId: B,
      freeNote: 'hello world secret text',
      contactEmail: 'person@example.com',
      deviceDistinctAccounts: 5,
      relationshipKind: 'PRIOR_SUBMISSION',
    },
  });

  const dump = await dumpOwnerLinkTables();
  assert.equal(dump.includes(A), false, 'account A id must never be stored');
  assert.equal(dump.includes(B), false, 'account B id must never be stored');
  assert.equal(dump.includes('person@example.com'), false, 'a raw email must never be stored');
  assert.equal(dump.includes('hello world'), false, 'free text must never be stored');

  const link = await readDirectActiveOwnerLinkBetween(client, A, B);
  const [ev] = await readOwnerLinkEvidence(client, link.id);
  const detail = JSON.parse(ev.detailJson);
  assert.deepEqual(Object.keys(detail).sort(), ['deviceDistinctAccounts', 'relationshipKind']);
  assert.equal(detail.deviceDistinctAccounts, 5);
  assert.equal(detail.relationshipKind, 'PRIOR_SUBMISSION');
  assert.match(ev.evidenceFingerprint, /^[0-9a-f]{64}$/, 'the fingerprint is an HMAC digest, not a raw value');
});

// ===========================================================================
// 6 — DIRECT link only: A-B + B-C never implies A-C
// ===========================================================================

test('6: no transitive closure — an A-B link and a B-C link do not create an A-C link', async () => {
  const A = uniq('tc-a');
  const B = uniq('tc-b');
  const C = uniq('tc-c');
  const linksBefore = await countRows('account_owner_links');

  await establishOwnerLink(A, B);
  await establishOwnerLink(B, C);
  assert.equal(await countRows('account_owner_links'), linksBefore + 2, 'exactly two direct link rows');

  assert.ok(await readDirectActiveOwnerLinkBetween(client, A, B), 'A-B is directly linked');
  assert.ok(await readDirectActiveOwnerLinkBetween(client, B, C), 'B-C is directly linked');
  assert.equal(await readDirectActiveOwnerLinkBetween(client, A, C), null, 'A-C is NOT linked (no transitive inference)');
  assert.equal(await readDirectOwnerLink(client, deriveOwnerRefPair(A, C)), null, 'no A-C row exists at all');
});

// ===========================================================================
// 7 — evidence UPSERT preserves first_observed_at, increments observation_count
// ===========================================================================

test('7: a repeat observation of the same (link, signal, fingerprint) preserves first_observed_at and increments observation_count', async () => {
  const A = uniq('up-a');
  const B = uniq('up-b');
  const fingerprint = fp('ADMIN_MANUAL', uniq('adm'));
  const t0 = 1_000_000;

  const first = await upsertOwnerLinkEvidence(client, {
    accountId: A, candidateSourceAccountId: B, signalType: 'ADMIN_MANUAL', confidence: 'HIGH',
    evidenceFingerprint: fingerprint, observedAt: t0, createdBy: 'ADMIN', decidedBy: 'ADMIN',
  });
  assert.equal(first.evidenceCreated, true);

  const second = await upsertOwnerLinkEvidence(client, {
    accountId: B, candidateSourceAccountId: A, signalType: 'ADMIN_MANUAL', confidence: 'HIGH',
    evidenceFingerprint: fingerprint, observedAt: t0 + 5_000, createdBy: 'ADMIN', decidedBy: 'ADMIN',
  });
  assert.equal(second.evidenceCreated, false, 'no second row — same triple, unordered');
  assert.equal(second.linkId, first.linkId, 'same link, regardless of A/B order');

  const rows = await readOwnerLinkEvidence(client, first.linkId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observationCount, 2);
  assert.equal(rows[0].firstObservedAt, t0, 'first_observed_at preserved');
  assert.equal(rows[0].lastObservedAt, t0 + 5_000, 'last_observed_at advanced');

  // last_observed_at never regresses on an out-of-order observation
  await upsertOwnerLinkEvidence(client, {
    accountId: A, candidateSourceAccountId: B, signalType: 'ADMIN_MANUAL', confidence: 'HIGH',
    evidenceFingerprint: fingerprint, observedAt: t0 + 1_000, createdBy: 'ADMIN', decidedBy: 'ADMIN',
  });
  const after = (await readOwnerLinkEvidence(client, first.linkId))[0];
  assert.equal(after.observationCount, 3);
  assert.equal(after.lastObservedAt, t0 + 5_000, 'last_observed_at is max(), never regressed');
});

// ===========================================================================
// 8 — withdrawal tombstones, never deletes
// ===========================================================================

test('8: withdrawing evidence or a link tombstones rows (withdrawn_at set) and never deletes them', async () => {
  const A = uniq('wd-a');
  const B = uniq('wd-b');
  const rec = await establishOwnerLink(A, B);
  const evBefore = await countRows('account_owner_link_evidence');
  const linkBefore = await countRows('account_owner_links');
  const [ev] = await readOwnerLinkEvidence(client, rec.linkId);

  const w1 = await withdrawOwnerLinkEvidence(client, { evidenceId: ev.id, reason: 'MANUAL_REVIEW', withdrawnAt: Date.now(), decidedBy: 'ADMIN' });
  assert.equal(w1.outcome, 'EVIDENCE_WITHDRAWN');
  assert.equal(await countRows('account_owner_link_evidence'), evBefore, 'evidence row count unchanged — tombstoned, not deleted');
  const [evAfter] = await readOwnerLinkEvidence(client, rec.linkId);
  assert.ok(evAfter.withdrawnAt != null, 'the evidence row now carries withdrawn_at');
  assert.equal(evAfter.observationCount, ev.observationCount, 'observation_count is never decremented');

  const link = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
  assert.equal(link.status, 'WITHDRAWN', 'with no qualifying live evidence the link is WITHDRAWN');
  assert.ok(link.withdrawnAt != null);
  assert.equal(await countRows('account_owner_links'), linkBefore, 'the link row is never deleted');

  // withdrawing the whole link is idempotent and still never deletes
  const w2 = await withdrawOwnerLink(client, { linkId: rec.linkId, reason: 'SUPERSEDED', withdrawnAt: Date.now(), decidedBy: 'ADMIN' });
  assert.equal(w2.outcome, 'ALREADY_WITHDRAWN');
  assert.equal(await countRows('account_owner_links'), linkBefore);
});

// ===========================================================================
// 9 — generation bumps BOTH endpoints
// ===========================================================================

test('9: recording a direct link bumps the link generation of BOTH endpoint accounts', async () => {
  const A = uniq('gen-a');
  const B = uniq('gen-b');
  assert.equal(await readAccountOwnerLinkGeneration(client, A), 0);
  assert.equal(await readAccountOwnerLinkGeneration(client, B), 0);

  const rec = await establishOwnerLink(A, B);
  assert.equal(rec.generationsBumped, true);

  const ga = await readAccountOwnerLinkGeneration(client, A);
  const gb = await readAccountOwnerLinkGeneration(client, B);
  assert.equal(ga, 1, 'endpoint A generation advanced 0 -> 1');
  assert.equal(gb, 1, 'endpoint B generation advanced 0 -> 1');

  // the standalone atomic helper advances both again
  await bumpOwnerLinkGenerationsForPair(client, deriveOwnerRefPair(A, B), Date.now());
  assert.equal(await readAccountOwnerLinkGeneration(client, A), 2);
  assert.equal(await readAccountOwnerLinkGeneration(client, B), 2);
});

// ===========================================================================
// 10 — generation is monotonic across a withdrawal
// ===========================================================================

test('10: withdrawal bumps the generation forward — it is never reset or decremented', async () => {
  const A = uniq('mono-a');
  const B = uniq('mono-b');
  const rec = await establishOwnerLink(A, B);
  const g1 = await readAccountOwnerLinkGeneration(client, A);
  assert.equal(g1, 1);

  await withdrawOwnerLink(client, { linkId: rec.linkId, reason: 'REVOKED', withdrawnAt: Date.now(), decidedBy: 'ADMIN' });
  const g2 = await readAccountOwnerLinkGeneration(client, A);
  const g2b = await readAccountOwnerLinkGeneration(client, B);
  assert.ok(g2 > g1, `generation advanced on withdrawal (${g1} -> ${g2})`);
  assert.equal(g2, g2b, 'both endpoints advanced together');

  // idempotent re-withdraw does not move it
  await withdrawOwnerLink(client, { linkId: rec.linkId, reason: 'REVOKED', withdrawnAt: Date.now(), decidedBy: 'ADMIN' });
  assert.equal(await readAccountOwnerLinkGeneration(client, A), g2, 'no bump on a no-op re-withdraw');
});

// ===========================================================================
// 11 — HIGH owner-bound evidence establishes an ACTIVE link
// ===========================================================================

test('11: a HIGH owner-bound evidence row (ADMIN_MANUAL) creates a direct ACTIVE link; strongest_confidence is HIGH', async () => {
  const A = uniq('sp-a');
  const B = uniq('sp-b');
  const rec = await establishOwnerLink(A, B);
  assert.equal(rec.outcome, 'EVIDENCE_RECORDED');
  assert.equal(rec.linkCreated, true);
  assert.equal(rec.linkStatus, 'ACTIVE');
  assert.equal(rec.strongestConfidence, 'HIGH');

  const link = await readDirectActiveOwnerLinkBetween(client, A, B);
  assert.ok(link);
  assert.equal(link.strongestConfidence, 'HIGH');
  assert.equal(link.decidedBy, 'ADMIN', 'the establishing actor (ADMIN_MANUAL is the only practical HIGH path in v1)');
});

// ===========================================================================
// 12 — a lone MEDIUM owner-bound signal CANNOT establish an ACTIVE link
// ===========================================================================

test('12: a single MEDIUM owner-bound row (SHARED_DEVICE_PASSPORT / CROSS_PASSPORT_ACTOR_COOCCURRENCE) does NOT create an ACTIVE link — it is supporting evidence only', async () => {
  // the helpers still report MEDIUM (the honest confidence of these signals)
  assert.equal(sharedVerifiedPassportEvidenceConfidence(), 'MEDIUM');
  assert.equal(crossPassportActorCooccurrenceConfidence(1), 'MEDIUM');
  assert.equal(crossPassportActorCooccurrenceConfidence(9), 'MEDIUM');
  assert.equal(crossPassportActorCooccurrenceConfidence(0), null);
  assert.equal(crossPassportActorCooccurrenceConfidence(Number.NaN), null);

  // ...but a lone MEDIUM row establishes nothing
  const linksBefore = await countRows('account_owner_links');
  const evBefore = await countRows('account_owner_link_evidence');
  for (const signalType of ['SHARED_DEVICE_PASSPORT', 'CROSS_PASSPORT_ACTOR_COOCCURRENCE', 'SHARED_PASSPORT_ACTOR_COOCCURRENCE', 'SHARED_CORPUS_DEVICE_PROVENANCE', 'VERIFIED_PHONE']) {
    const A = uniq(`m12-${signalType}-a`);
    const B = uniq(`m12-${signalType}-b`);
    const res = await addSupportingEvidence(A, B, signalType, uniq('r'), Date.now(), { cooccurrenceCount: 3 });
    assert.equal(res.outcome, 'NON_ESTABLISHING_NO_LINK', `${signalType} MEDIUM alone -> NON_ESTABLISHING_NO_LINK`);
    assert.equal(res.linkId, null);
    assert.equal(res.linkCreated, false);
    assert.equal(await readDirectActiveOwnerLinkBetween(client, A, B), null);
    assert.equal(await readDirectOwnerLink(client, deriveOwnerRefPair(A, B)), null, 'no link row at all');
  }
  assert.equal(await countRows('account_owner_links'), linksBefore, 'zero link rows written by any lone MEDIUM signal');
  assert.equal(await countRows('account_owner_link_evidence'), evBefore, 'zero evidence rows written either — nothing to attach to');
});

// ===========================================================================
// 12b — MULTIPLE different MEDIUM owner-bound signals still cannot establish
// ===========================================================================

test('12b: several different MEDIUM owner-bound signals for the same pair still create NO active link — count of supporting evidence is not corroboration', async () => {
  const A = uniq('m12b-a');
  const B = uniq('m12b-b');
  for (const signalType of ['SHARED_DEVICE_PASSPORT', 'CROSS_PASSPORT_ACTOR_COOCCURRENCE', 'SHARED_PASSPORT_ACTOR_COOCCURRENCE']) {
    const res = await addSupportingEvidence(A, B, signalType, uniq('r'));
    assert.equal(res.outcome, 'NON_ESTABLISHING_NO_LINK');
  }
  assert.equal(await readDirectOwnerLink(client, deriveOwnerRefPair(A, B)), null, 'still no link — v1 has no corroboration rule, and none of these is HIGH');
  assert.equal(await readDirectActiveOwnerLinkBetween(client, A, B), null);
});

// ===========================================================================
// 13 / 14 — telemetry NEVER vetoes an ESTABLISHED (HIGH) link; MEDIUM
//            supporting evidence attaches without changing status
// ===========================================================================

test('13: a high device fan-out passed alongside SUPPORTING evidence does NOT withdraw an established link', async () => {
  const A = uniq('fan-a');
  const B = uniq('fan-b');
  const rec = await establishOwnerLink(A, B); // HIGH ADMIN_MANUAL -> ACTIVE
  const attach = await addSupportingEvidence(A, B, 'SHARED_DEVICE_PASSPORT', uniq('pp'), Date.now(), {
    deviceDistinctAccounts: 250, sharedDeviceFanout: 250, deviceAnonUploads: 0,
  });
  assert.equal(attach.outcome, 'EVIDENCE_RECORDED');
  assert.equal(attach.linkStatus, 'ACTIVE', 'fan-out is telemetry only — it cannot withdraw an established link');
  const link = await readDirectActiveOwnerLinkBetween(client, A, B);
  assert.ok(link);
  const supporting = (await readOwnerLinkEvidence(client, link.id)).find((e) => e.signalType === 'SHARED_DEVICE_PASSPORT');
  assert.equal(JSON.parse(supporting.detailJson).deviceDistinctAccounts, 250, 'the fan-out count is retained as bounded telemetry on the supporting row');
  assert.equal(supporting.confidence, 'MEDIUM', 'and it is stored as MEDIUM/supporting, not promoted');
});

test('14: anonymous passport history passed alongside SUPPORTING evidence does NOT withdraw an established link', async () => {
  const A = uniq('anon-a');
  const B = uniq('anon-b');
  await establishOwnerLink(A, B);
  const attach = await addSupportingEvidence(A, B, 'SHARED_PASSPORT_ACTOR_COOCCURRENCE', uniq('pp'), Date.now(), {
    anonymousHistoryPresent: true, deviceAnonUploads: 7,
  });
  assert.equal(attach.linkStatus, 'ACTIVE', 'anonymous history is telemetry only');
  assert.ok(await readDirectActiveOwnerLinkBetween(client, A, B));
});

// ===========================================================================
// 15 — the establishment threshold: only owner-bound + HIGH establishes
// ===========================================================================

test('15: evidenceCanEstablishActiveLink — only owner-bound AND HIGH qualifies; observation-only never, LOW/MEDIUM owner-bound never', async () => {
  for (const signalType of OBSERVATION_ONLY_SIGNAL_TYPES) {
    assert.equal(isObservationOnlySignal(signalType), true);
    for (const c of ['LOW', 'MEDIUM', 'HIGH']) {
      assert.equal(evidenceCanEstablishActiveLink(signalType, c), false, `${signalType} never qualifies, even at ${c}`);
    }
  }
  for (const signalType of OWNER_BOUND_SIGNAL_TYPES) {
    assert.equal(evidenceCanEstablishActiveLink(signalType, 'LOW'), false, `${signalType} LOW does not qualify`);
    assert.equal(evidenceCanEstablishActiveLink(signalType, 'MEDIUM'), false, `${signalType} MEDIUM is SUPPORTING only`);
    assert.equal(evidenceCanEstablishActiveLink(signalType, 'HIGH'), true, `${signalType} HIGH establishes`);
  }
  // an unrecognised signal fails closed
  assert.equal(evidenceCanEstablishActiveLink('NOT_A_SIGNAL', 'HIGH'), false);

  const A = uniq('ip-a');
  const B = uniq('ip-b');
  const linksBefore = await countRows('account_owner_links');
  for (const signalType of ['IP_COOCCURRENCE', 'COARSE_LOCATION', 'TIMING']) {
    const res = await upsertOwnerLinkEvidence(client, {
      accountId: A, candidateSourceAccountId: B, signalType, confidence: 'LOW',
      evidenceFingerprint: fp(signalType, uniq('obs')), observedAt: Date.now(), createdBy: 'SYSTEM',
    });
    assert.equal(res.outcome, 'NON_ESTABLISHING_NO_LINK', `${signalType} alone records nothing`);
    assert.equal(res.linkId, null);
  }
  // LOW and MEDIUM owner-bound signals with no link are likewise non-establishing
  for (const c of ['LOW', 'MEDIUM']) {
    const res = await addSupportingEvidence(uniq(`nl-${c}-a`), uniq(`nl-${c}-b`), 'SHARED_DEVICE_PASSPORT', uniq('pp'));
    assert.equal(res.outcome, 'NON_ESTABLISHING_NO_LINK', `SHARED_DEVICE_PASSPORT (recorded MEDIUM) alone -> NON_ESTABLISHING_NO_LINK`);
  }
  assert.equal(await countRows('account_owner_links'), linksBefore, 'no link row created by any non-establishing signal');
  assert.equal(await readDirectActiveOwnerLinkBetween(client, A, B), null);
});

test('15b: an observation-only signal attaches to an already-established link without changing its status; withdrawing the sole HIGH row drops it', async () => {
  const A = uniq('att-a');
  const B = uniq('att-b');
  const rec = await establishOwnerLink(A, B);

  const attach = await upsertOwnerLinkEvidence(client, {
    accountId: A, candidateSourceAccountId: B, signalType: 'IP_COOCCURRENCE', confidence: 'LOW',
    evidenceFingerprint: fp('IP_COOCCURRENCE', uniq('obs')), observedAt: Date.now(), createdBy: 'SYSTEM',
  });
  assert.equal(attach.outcome, 'EVIDENCE_RECORDED');
  assert.equal(attach.linkId, rec.linkId);
  assert.equal(attach.linkStatus, 'ACTIVE', 'the HIGH evidence still holds the link ACTIVE');

  const evidence = await readOwnerLinkEvidence(client, rec.linkId);
  assert.equal(evidence.length, 2, 'the observation is retained on the link for audit');

  // withdraw the establishing (HIGH) evidence -> only the observation-only row lives -> link WITHDRAWN
  const establishing = evidence.find((e) => e.signalType === 'ADMIN_MANUAL');
  await withdrawOwnerLinkEvidence(client, { evidenceId: establishing.id, reason: 'MANUAL_REVIEW', withdrawnAt: Date.now(), decidedBy: 'ADMIN' });
  const link = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
  assert.equal(link.status, 'WITHDRAWN', 'an observation-only row cannot keep a link ACTIVE on its own');
  assert.equal((await readOwnerLinkEvidence(client, rec.linkId)).length, 2, 'both rows still present (one tombstoned)');
});

// ===========================================================================
// 15c — an ACTIVE link drops to WITHDRAWN when its last HIGH row is
//        withdrawn, EVEN THOUGH live MEDIUM supporting evidence remains
// ===========================================================================

test('15c: ACTIVE + (withdraw last HIGH while MEDIUM supporting evidence still lives) -> WITHDRAWN', async () => {
  const A = uniq('drop-a');
  const B = uniq('drop-b');
  const highRef = uniq('adm');
  const rec = await establishOwnerLink(A, B, highRef); // HIGH ADMIN_MANUAL
  await addSupportingEvidence(A, B, 'CROSS_PASSPORT_ACTOR_COOCCURRENCE', uniq('x'), Date.now(), { cooccurrenceCount: 2 });
  await addSupportingEvidence(A, B, 'SHARED_DEVICE_PASSPORT', uniq('pp'));
  let evs = await readOwnerLinkEvidence(client, rec.linkId);
  assert.equal(evs.filter((e) => e.withdrawnAt == null).length, 3, 'one HIGH + two MEDIUM live');
  assert.equal((await readDirectOwnerLink(client, deriveOwnerRefPair(A, B))).status, 'ACTIVE');

  const high = evs.find((e) => e.signalType === 'ADMIN_MANUAL');
  const w = await withdrawOwnerLinkEvidence(client, { evidenceId: high.id, reason: 'ADMIN_CORRECTION', withdrawnAt: Date.now(), decidedBy: 'ADMIN' });
  assert.equal(w.outcome, 'EVIDENCE_WITHDRAWN');
  assert.equal(w.linkStatus, 'WITHDRAWN');
  const link = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
  assert.equal(link.status, 'WITHDRAWN', 'no live HIGH row -> WITHDRAWN, even with two live MEDIUM rows');
  assert.equal(link.strongestConfidence, 'MEDIUM', 'strongest_confidence tracks the surviving MEDIUM rows but does NOT keep the link ACTIVE');
  evs = await readOwnerLinkEvidence(client, rec.linkId);
  assert.equal(evs.filter((e) => e.withdrawnAt == null).length, 2, 'the two MEDIUM rows are still live — they were not tombstoned, they just cannot hold ACTIVE');

  // a fresh MEDIUM supporting observation on the now-WITHDRAWN link does NOT revive it
  const stillDown = await addSupportingEvidence(A, B, 'SHARED_PASSPORT_ACTOR_COOCCURRENCE', uniq('pp2'));
  assert.equal(stillDown.outcome, 'EVIDENCE_RECORDED', 'it attaches to the existing (withdrawn) link');
  assert.equal(stillDown.linkStatus, 'WITHDRAWN', 'MEDIUM supporting evidence cannot reactivate a link');
  assert.equal((await readDirectOwnerLink(client, deriveOwnerRefPair(A, B))).status, 'WITHDRAWN');
});

// ===========================================================================
// 15d — re-observing the SAME withdrawn HIGH row reactivates the link
// ===========================================================================

test('15d: a HIGH re-observation of the withdrawn establishing row flips the link WITHDRAWN -> ACTIVE again', async () => {
  const A = uniq('re-a');
  const B = uniq('re-b');
  const highRef = uniq('adm');
  const rec = await establishOwnerLink(A, B, highRef);
  const [high] = await readOwnerLinkEvidence(client, rec.linkId);

  await withdrawOwnerLinkEvidence(client, { evidenceId: high.id, reason: 'MANUAL_REVIEW', withdrawnAt: Date.now(), decidedBy: 'ADMIN' });
  assert.equal((await readDirectOwnerLink(client, deriveOwnerRefPair(A, B))).status, 'WITHDRAWN');

  // same accounts, same signal, same fingerprint -> revives the tombstoned row
  const back = await establishOwnerLink(A, B, highRef);
  assert.equal(back.outcome, 'EVIDENCE_RECORDED');
  assert.equal(back.linkId, rec.linkId, 'same link row');
  assert.equal(back.evidenceCreated, false, 'no new evidence row — the withdrawn one was revived');
  assert.equal(back.linkStatus, 'ACTIVE');
  const link = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
  assert.equal(link.status, 'ACTIVE', 'a fresh HIGH observation reactivates the link');
  assert.equal(link.strongestConfidence, 'HIGH');

  const events = (await readOwnerLinkEvents(client, rec.linkId)).map((e) => e.eventType);
  assert.deepEqual(events, ['LINK_CREATED', 'EVIDENCE_ADDED', 'EVIDENCE_WITHDRAWN', 'LINK_WITHDRAWN', 'EVIDENCE_REACTIVATED', 'LINK_REACTIVATED']);
});

// ===========================================================================
// 16 — report deletion / account room clear never removes owner-link evidence
// ===========================================================================

test('16: report deletion, room clearing, and account deletion leave every owner-link row untouched', async () => {
  const A = uniq('del-a');
  const B = uniq('del-b');
  await ensureUser(A);
  await ensureUser(B);
  await establishOwnerLink(A, B);
  await upsertOwnerLinkEvidence(client, {
    accountId: A, candidateSourceAccountId: B, signalType: 'IP_COOCCURRENCE', confidence: 'LOW',
    evidenceFingerprint: fp('IP_COOCCURRENCE', uniq('obs')), observedAt: Date.now(), createdBy: 'SYSTEM',
  });

  // a saved report owned by A, so the deletion helpers have something to do
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [uniq('r'), uniq('dk'), 'sub', 't', new Date().toISOString(), 6, 0, 'Low', '{}', A],
  });

  const before = await dumpOwnerLinkTables();
  await deleteAllReportDataForAccount(client, A, { preserveActivelyPromotedRepresentations: true });
  await deleteAccountData(client, A);
  await invalidateSessionsAndDeleteUser(client, A);
  assert.equal((await client.execute({ sql: 'SELECT COUNT(*) AS c FROM users WHERE id = ?', args: [A] })).rows[0].c, 0, 'the account IS gone');
  assert.equal(await dumpOwnerLinkTables(), before, 'account_owner_links / _evidence / _state are byte-for-byte unchanged');
});

// ===========================================================================
// 17 — ordinary-user privacy invariants
// ===========================================================================

test('17: no scoring / matcher / candidate-discovery module and no app/ route imports the owner-link modules', () => {
  const importLines = (src) => src.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join('\n');
  const OWNER_LINK_RE = /owner-link(?:-repo)?/;

  // includes the independent same-Passport SELF scoring path (device-self-scoring-rule,
  // report-primary-similarity, device-passport-server, device-sharedness-risk) — a
  // separate, already-proven scoring mechanism that this owner-link work must not touch.
  const scoringFiles = [
    'lib/report-primary-similarity.ts',
    'lib/unified-similarity.ts',
    'lib/similarity-core.ts',
    'lib/report-types.ts',
    'lib/device-self-scoring-rule.ts',
    'lib/device-sharedness-risk.ts',
    'lib/device-shared-guard.ts',
    'lib/device-shared-guard-policy.ts',
    'lib/report-historical-match.ts',
    'lib/user-submission-matching.ts',
    'lib/device-passport-server.ts',
    'app/api/reports/route.ts',
    'app/api/reports/[id]/route.ts',
    'app/similarity-worker.ts',
  ];
  for (const rel of scoringFiles) {
    assert.doesNotMatch(importLines(fs.readFileSync(path.join(repo, rel), 'utf8')), OWNER_LINK_RE, `${rel} must not import an owner-link module`);
  }

  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, acc);
      else if (/\.(ts|tsx)$/.test(e.name)) acc.push(full);
    }
    return acc;
  };
  const appImporters = walk(path.join(repo, 'app'))
    .filter((f) => OWNER_LINK_RE.test(importLines(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(repo, f).split(path.sep).join('/'));
  assert.deepEqual(appImporters, [], `no app/ file may import an owner-link module yet: ${appImporters.join(', ')}`);

  // the owner-link modules themselves never reach into a scoring / matcher module
  for (const rel of ['lib/owner-link.ts', 'lib/owner-link-repo.ts']) {
    const imports = importLines(fs.readFileSync(path.join(repo, rel), 'utf8'));
    for (const forbidden of ['unified-similarity', 'report-primary-similarity', 'user-submission-matching', 'device-self-scoring-rule', 'report-historical-match', 'similarity-core']) {
      assert.doesNotMatch(imports, new RegExp(forbidden), `${rel} must not import ${forbidden}`);
    }
  }
});

test('17b: boundOwnerLinkDetail strips ids / emails / phones / free text and keeps only bounded counts + enum tokens', () => {
  const out = boundOwnerLinkDetail({
    accountId: 'owner-acct-alpha-0001',
    email: 'someone@example.com',
    phone: '+15551234567',
    note: 'this is free text',
    deviceDistinctAccounts: 42,
    ratio: 0.5,
    present: true,
    relationship: 'PRIOR_SUBMISSION',
    kinds: ['PRIOR_SUBMISSION', 'CORPUS_SOURCE', 'not-an-enum'],
    huge: 1e30,
  });
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed).sort(), ['deviceDistinctAccounts', 'huge', 'kinds', 'present', 'ratio', 'relationship'].sort());
  assert.equal(parsed.deviceDistinctAccounts, 42);
  assert.equal(parsed.present, true);
  assert.equal(parsed.relationship, 'PRIOR_SUBMISSION');
  assert.deepEqual(parsed.kinds, ['PRIOR_SUBMISSION', 'CORPUS_SOURCE']);
  assert.ok(parsed.huge <= 1e12, 'numbers are clamped');
  assert.equal(boundOwnerLinkDetail({ onlyBadKeys: 'lower case value', 'weird key': 1 }), null);
  assert.equal(boundOwnerLinkDetail(null), null);
  assert.equal(boundOwnerLinkDetail('nope'), null);
});

// ===========================================================================
// 18 — schema shape + generation-stamp helpers
// ===========================================================================

test('18: drizzle/0042 shape — four additive tables, unique indexes, RESTRICT FK, ordering CHECK', async () => {
  const tables = new Set((await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name)));
  for (const t of ['account_owner_links', 'account_owner_link_evidence', 'account_owner_link_events', 'account_owner_link_state']) {
    assert.ok(tables.has(t), `${t} must exist`);
  }

  // account_owner_link_events shape: columns, autoincrement PK, both RESTRICT FKs, indexes
  const evtCols = new Set((await client.execute("PRAGMA table_info('account_owner_link_events')")).rows.map((r) => String(r.name)));
  for (const c of ['id', 'link_id', 'evidence_id', 'event_type', 'previous_state', 'new_state', 'reason', 'actor', 'occurred_at']) {
    assert.ok(evtCols.has(c), `account_owner_link_events.${c}`);
  }
  const evtFks = (await client.execute("PRAGMA foreign_key_list('account_owner_link_events')")).rows;
  const linkFk = evtFks.find((r) => String(r.from) === 'link_id');
  const evidenceFk = evtFks.find((r) => String(r.from) === 'evidence_id');
  assert.equal(String(linkFk.table), 'account_owner_links');
  assert.equal(String(linkFk.on_delete).toUpperCase(), 'RESTRICT', 'events.link_id is ON DELETE RESTRICT — audit never cascades away');
  assert.equal(String(evidenceFk.table), 'account_owner_link_evidence');
  assert.equal(String(evidenceFk.on_delete).toUpperCase(), 'RESTRICT');
  const evtIdx = new Set((await client.execute("PRAGMA index_list('account_owner_link_events')")).rows.map((r) => String(r.name)));
  assert.ok(evtIdx.has('idx_account_owner_link_events_link'));
  assert.ok(evtIdx.has('idx_account_owner_link_events_evidence'));

  const linkCols = new Set((await client.execute("PRAGMA table_info('account_owner_links')")).rows.map((r) => String(r.name)));
  for (const c of ['id', 'account_ref_lo', 'account_ref_hi', 'key_version', 'status', 'strongest_confidence', 'first_linked_at', 'last_evidence_at', 'withdrawn_at', 'withdrawn_reason', 'decided_by']) {
    assert.ok(linkCols.has(c), `account_owner_links.${c}`);
  }
  const evCols = new Set((await client.execute("PRAGMA table_info('account_owner_link_evidence')")).rows.map((r) => String(r.name)));
  for (const c of ['id', 'link_id', 'confidence', 'signal_type', 'evidence_fingerprint', 'observation_count', 'first_observed_at', 'last_observed_at', 'withdrawn_at', 'withdrawn_reason', 'detail_json', 'created_by']) {
    assert.ok(evCols.has(c), `account_owner_link_evidence.${c}`);
  }
  const stateCols = (await client.execute("PRAGMA table_info('account_owner_link_state')")).rows;
  const statePk = stateCols.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
  assert.deepEqual(statePk, ['account_ref', 'key_version']);

  const snapCols = new Set((await client.execute("PRAGMA table_info('report_historical_match_snapshots')")).rows.map((r) => String(r.name)));
  assert.ok(snapCols.has('owner_link_generation'), '0042 adds report_historical_match_snapshots.owner_link_generation');

  const idx = new Set((await client.execute("PRAGMA index_list('account_owner_link_evidence')")).rows.map((r) => String(r.name)));
  assert.ok(idx.has('ux_account_owner_link_evidence_signal'));
  assert.ok(idx.has('idx_account_owner_link_evidence_link'));
  assert.ok(new Set((await client.execute("PRAGMA index_list('account_owner_links')")).rows.map((r) => String(r.name))).has('ux_account_owner_links_pair'));

  const fk = (await client.execute("PRAGMA foreign_key_list('account_owner_link_evidence')")).rows;
  assert.equal(fk.length, 1);
  assert.equal(String(fk[0].table), 'account_owner_links');
  assert.equal(String(fk[0].on_delete).toUpperCase(), 'RESTRICT');

  // CHECK (account_ref_lo < account_ref_hi) behaviourally rejects a mis-ordered pair
  await assert.rejects(
    () => client.execute({
      sql: `INSERT INTO account_owner_links (id, account_ref_lo, account_ref_hi, key_version, strongest_confidence, first_linked_at, last_evidence_at)
            VALUES ('bad', 'zzz', 'aaa', 1, 'MEDIUM', 1, 1)`,
    }),
    /CHECK constraint failed/,
  );

  // RESTRICT behaviourally blocks deleting a link that still has evidence
  const A = uniq('shape-a');
  const B = uniq('shape-b');
  const rec = await establishOwnerLink(A, B);
  await assert.rejects(
    () => client.execute({ sql: 'DELETE FROM account_owner_links WHERE id = ?', args: [rec.linkId] }),
    /FOREIGN KEY constraint failed/,
    'a link with evidence cannot be deleted (RESTRICT) — links are tombstoned, never removed',
  );
});

test('18b: owner_link_generation stamp/read helpers round-trip; snapshot rows rest at 0', async () => {
  const deviceKey = uniq('dk');
  const reportId = uniq('r');
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots (report_device_key, report_id, status) VALUES (?,?,?)`,
    args: [deviceKey, reportId, 'NO_HISTORICAL_MATCH'],
  });
  assert.equal(await readReportSnapshotOwnerLinkGeneration(client, deviceKey, reportId), 0, 'rests at 0');
  const stamp = await stampReportSnapshotOwnerLinkGeneration(client, { reportDeviceKey: deviceKey, reportId, generation: 5 });
  assert.equal(stamp.updated, true);
  assert.equal(await readReportSnapshotOwnerLinkGeneration(client, deviceKey, reportId), 5);
  assert.equal(await readReportSnapshotOwnerLinkGeneration(client, deviceKey, uniq('missing')), null, 'no snapshot -> null');
});

// ===========================================================================
// 19 — pure signal-model / status-resolution sanity
// ===========================================================================

test('19: signal vocabulary and status resolution are internally consistent', () => {
  assert.equal(OWNER_BOUND_SIGNAL_TYPES.length, 10);
  assert.equal(OBSERVATION_ONLY_SIGNAL_TYPES.length, 4);
  for (const s of OWNER_BOUND_SIGNAL_TYPES) {
    assert.equal(isOwnerBoundSignal(s), true);
    assert.equal(isObservationOnlySignal(s), false);
  }
  for (const s of ['SHARED_DEVICE_PASSPORT', 'VERIFIED_PHONE', 'OAUTH_PROVIDER_SUBJECT', 'PAYMENT_INSTRUMENT', 'ADMIN_MANUAL']) {
    assert.ok(OWNER_BOUND_SIGNAL_TYPES.includes(s));
  }
  for (const s of ['DEVICE_FINGERPRINT', 'IP_COOCCURRENCE', 'COARSE_LOCATION', 'TIMING']) {
    assert.ok(OBSERVATION_ONLY_SIGNAL_TYPES.includes(s));
  }

  assert.equal(strongestConfidenceOf(['LOW', 'MEDIUM', 'LOW']), 'MEDIUM');
  assert.equal(strongestConfidenceOf(['LOW', 'HIGH']), 'HIGH');
  assert.equal(strongestConfidenceOf([]), null);

  // a lone MEDIUM owner-bound row is SUPPORTING only — it does NOT resolve to ACTIVE
  assert.deepEqual(
    resolveLinkStatusFromEvidence([{ signalType: 'SHARED_DEVICE_PASSPORT', confidence: 'MEDIUM' }]),
    { status: 'WITHDRAWN', strongestConfidence: 'MEDIUM', qualifyingCount: 0 },
  );
  // only an owner-bound HIGH row establishes ACTIVE (the v1 threshold)
  assert.deepEqual(
    resolveLinkStatusFromEvidence([{ signalType: 'ADMIN_MANUAL', confidence: 'HIGH' }]),
    { status: 'ACTIVE', strongestConfidence: 'HIGH', qualifyingCount: 1 },
  );
  // a HIGH row alongside live MEDIUM supporting rows: ACTIVE, one qualifying
  assert.deepEqual(
    resolveLinkStatusFromEvidence([
      { signalType: 'ADMIN_MANUAL', confidence: 'HIGH' },
      { signalType: 'SHARED_DEVICE_PASSPORT', confidence: 'MEDIUM' },
      { signalType: 'CROSS_PASSPORT_ACTOR_COOCCURRENCE', confidence: 'MEDIUM' },
    ]),
    { status: 'ACTIVE', strongestConfidence: 'HIGH', qualifyingCount: 1 },
  );
  // withdraw that HIGH row and only MEDIUM remains -> WITHDRAWN, even with two live rows
  assert.deepEqual(
    resolveLinkStatusFromEvidence([
      { signalType: 'SHARED_DEVICE_PASSPORT', confidence: 'MEDIUM' },
      { signalType: 'CROSS_PASSPORT_ACTOR_COOCCURRENCE', confidence: 'MEDIUM' },
    ]),
    { status: 'WITHDRAWN', strongestConfidence: 'MEDIUM', qualifyingCount: 0 },
  );
  // an owner-bound signal at HIGH is the ONLY establishing shape — even HIGH observation-only never qualifies
  assert.deepEqual(
    resolveLinkStatusFromEvidence([{ signalType: 'IP_COOCCURRENCE', confidence: 'HIGH' }]),
    { status: 'WITHDRAWN', strongestConfidence: 'HIGH', qualifyingCount: 0 },
  );
  assert.deepEqual(
    resolveLinkStatusFromEvidence([]),
    { status: 'WITHDRAWN', strongestConfidence: null, qualifyingCount: 0 },
  );
});

// ===========================================================================
// 20 — evidence-fingerprint canonicalization regression
// ===========================================================================

test('20: ownerLinkEvidenceFingerprint canonicalization — ambiguous component arrays never collide; identical inputs stay deterministic', () => {
  const NUL = String.fromCharCode(0);

  // the canonical ambiguity from the task: a plain space-join would collapse these
  const s1 = ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['a b', 'c']);
  const s2 = ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['a', 'b c']);
  assert.match(s1, /^[0-9a-f]{64}$/);
  assert.match(s2, /^[0-9a-f]{64}$/);
  assert.notEqual(s1, s2, 'component boundaries preserved — a " " join would have collided');

  // a NUL-join (the prior implementation) would also have collided here
  assert.notEqual(
    ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['a' + NUL + 'b', 'c']),
    ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['a', 'b' + NUL + 'c']),
    'a NUL-delimited join would have collided here too',
  );

  // arity ambiguity and delimiter-injection ambiguity
  assert.notEqual(
    ownerLinkEvidenceFingerprint('OAUTH_PROVIDER_SUBJECT', ['google', 'sub-1']),
    ownerLinkEvidenceFingerprint('OAUTH_PROVIDER_SUBJECT', ['google:sub-1']),
  );
  assert.notEqual(
    ownerLinkEvidenceFingerprint('TIMING', ['1', '2', '3']),
    ownerLinkEvidenceFingerprint('TIMING', ['1', '23']),
  );
  assert.notEqual(
    ownerLinkEvidenceFingerprint('ADMIN_MANUAL', ['a","b', 'c']),
    ownerLinkEvidenceFingerprint('ADMIN_MANUAL', ['a', 'b', 'c']),
    'a quote inside a component cannot make it impersonate two components',
  );
  assert.notEqual(
    ownerLinkEvidenceFingerprint('IP_COOCCURRENCE', ['x', '']),
    ownerLinkEvidenceFingerprint('IP_COOCCURRENCE', ['', 'x']),
  );

  // deterministic: identical inputs -> identical digest; order- and signal-sensitive
  assert.equal(
    ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['p', 'q']),
    ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['p', 'q']),
  );
  assert.notEqual(
    ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['p', 'q']),
    ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['q', 'p']),
  );
  assert.notEqual(
    ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['same']),
    ownerLinkEvidenceFingerprint('CROSS_PASSPORT_ACTOR_COOCCURRENCE', ['same']),
  );

  // fail closed on a non-string component and on a missing key
  assert.equal(ownerLinkEvidenceFingerprint('TIMING', [1, 2]), null);
  assert.equal(withoutKeySync(() => ownerLinkEvidenceFingerprint('TIMING', ['x'])), null);
});

function withoutKeySync(fn) {
  const original = process.env[OWNER_LINK_HMAC_KEY_ENV];
  delete process.env[OWNER_LINK_HMAC_KEY_ENV];
  try { return fn(); } finally {
    if (original === undefined) delete process.env[OWNER_LINK_HMAC_KEY_ENV];
    else process.env[OWNER_LINK_HMAC_KEY_ENV] = original;
  }
}

// ===========================================================================
// 21 — withdrawn_reason controlled vocabulary: every allowed value works
// ===========================================================================

test('21: every OWNER_LINK_WITHDRAWAL_REASONS value is accepted by both withdraw paths and recorded; live rows carry NULL', async () => {
  assert.deepEqual(
    [...OWNER_LINK_WITHDRAWAL_REASONS].sort(),
    ['ADMIN_CORRECTION', 'MANUAL_REVIEW', 'NO_QUALIFYING_EVIDENCE', 'REVOKED', 'SUPERSEDED'],
  );

  for (const reason of OWNER_LINK_WITHDRAWAL_REASONS) {
    assert.equal(isOwnerLinkWithdrawalReason(reason), true);
    assert.equal(assertOwnerLinkWithdrawalReason(reason), reason);

    const A = uniq(`wr-${reason}-a`);
    const B = uniq(`wr-${reason}-b`);
    const rec = await establishOwnerLink(A, B);

    const liveLink = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
    assert.equal(liveLink.withdrawnReason, null, 'a live link carries no withdrawn_reason');
    assert.equal((await readOwnerLinkEvidence(client, rec.linkId))[0].withdrawnReason, null);

    const w = await withdrawOwnerLink(client, { linkId: rec.linkId, reason, withdrawnAt: Date.now(), decidedBy: 'ADMIN' });
    assert.equal(w.outcome, 'LINK_WITHDRAWN');

    const link = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
    assert.equal(link.withdrawnReason, reason, `account_owner_links.withdrawn_reason = ${reason}`);
    assert.equal((await readOwnerLinkEvidence(client, rec.linkId))[0].withdrawnReason, reason, `evidence tombstone also records ${reason}`);
  }

  // single-evidence withdrawal records the reason on the evidence tombstone even while the link stays ACTIVE
  // (a SECOND establishing HIGH row keeps the link ACTIVE after the first is withdrawn)
  const A = uniq('wr-ev-a');
  const B = uniq('wr-ev-b');
  const rec = await establishOwnerLink(A, B, uniq('adm'));
  await establishOwnerLink(A, B, uniq('adm')); // a second HIGH ADMIN_MANUAL row (distinct fingerprint)
  const evRows = await readOwnerLinkEvidence(client, rec.linkId);
  assert.equal(evRows.filter((e) => e.signalType === 'ADMIN_MANUAL').length, 2, 'two HIGH establishing rows');
  const first = evRows[0];
  await withdrawOwnerLinkEvidence(client, { evidenceId: first.id, reason: 'ADMIN_CORRECTION', withdrawnAt: Date.now(), decidedBy: 'ADMIN' });
  const firstAfter = (await readOwnerLinkEvidence(client, rec.linkId)).find((e) => e.id === first.id);
  assert.equal(firstAfter.withdrawnReason, 'ADMIN_CORRECTION');
  assert.ok(firstAfter.withdrawnAt != null);
  const link = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
  assert.equal(link.status, 'ACTIVE', 'the other qualifying (HIGH) evidence still holds the link ACTIVE');
  assert.equal(link.withdrawnReason, null, 'an ACTIVE link carries no withdrawn_reason');
});

// ===========================================================================
// 22 — arbitrary withdrawn_reason rejected at BOTH layers; no identity leak
// ===========================================================================

test('22: an arbitrary withdrawn_reason is rejected at the app layer (throws, writes nothing) and at the DB layer (CHECK on both columns)', async () => {
  const bad = [
    'user@example.com',
    'd3adbeef-0000-4000-8000-000000000000',
    'owner-acct-alpha-0001',
    'some free explanation text',
    'cleanup',          // lowercase near-miss
    'MANUAL REVIEW',    // space, not underscore
    '',
    'DROP TABLE',
  ];

  for (const r of bad) {
    assert.equal(isOwnerLinkWithdrawalReason(r), false);
    assert.throws(() => assertOwnerLinkWithdrawalReason(r), /Invalid owner-link withdrawal reason/);
  }

  const A = uniq('bad-reason-a');
  const B = uniq('bad-reason-b');
  const rec = await establishOwnerLink(A, B);
  const [ev] = await readOwnerLinkEvidence(client, rec.linkId);
  const dumpBefore = await dumpOwnerLinkTables();

  for (const r of bad) {
    await assert.rejects(
      () => withdrawOwnerLink(client, { linkId: rec.linkId, reason: r, withdrawnAt: Date.now(), decidedBy: 'ADMIN' }),
      /Invalid owner-link withdrawal reason/,
      `withdrawOwnerLink rejects ${JSON.stringify(r)} before any write`,
    );
    await assert.rejects(
      () => withdrawOwnerLinkEvidence(client, { evidenceId: ev.id, reason: r, withdrawnAt: Date.now(), decidedBy: 'ADMIN' }),
      /Invalid owner-link withdrawal reason/,
    );
  }
  assert.equal(await dumpOwnerLinkTables(), dumpBefore, 'a rejected withdrawal writes nothing — link still ACTIVE, no tombstone, no email/uuid stored');

  // DB backstop: a raw UPDATE that bypasses the app helper is still blocked by CHECK on BOTH columns
  await assert.rejects(
    () => client.execute({ sql: `UPDATE account_owner_links SET withdrawn_reason = 'attacker@evil.com' WHERE id = ?`, args: [rec.linkId] }),
    /CHECK constraint failed/,
    'account_owner_links.withdrawn_reason CHECK rejects free text',
  );
  await assert.rejects(
    () => client.execute({ sql: `UPDATE account_owner_link_evidence SET withdrawn_reason = 'attacker@evil.com' WHERE id = ?`, args: [ev.id] }),
    /CHECK constraint failed/,
    'account_owner_link_evidence.withdrawn_reason CHECK rejects free text',
  );
  // NULL is always allowed on both
  await client.execute({ sql: `UPDATE account_owner_links SET withdrawn_reason = NULL WHERE id = ?`, args: [rec.linkId] });
  await client.execute({ sql: `UPDATE account_owner_link_evidence SET withdrawn_reason = NULL WHERE id = ?`, args: [ev.id] });
});

// ===========================================================================
// 23 — signal_type is DB-CHECK-constrained, not only repo-validated
// ===========================================================================

test('23: an unknown signal_type is rejected at the DB level; every real signal type passes the CHECK', async () => {
  const A = uniq('sig-a');
  const B = uniq('sig-b');
  const rec = await establishOwnerLink(A, B);

  await assert.rejects(
    () => client.execute({
      sql: `INSERT INTO account_owner_link_evidence
              (id, link_id, confidence, signal_type, evidence_fingerprint, first_observed_at, last_observed_at)
            VALUES (?,?,?,?,?,?,?)`,
      args: [uniq('ev'), rec.linkId, 'MEDIUM', 'NOT_A_REAL_SIGNAL', 'fp', 1, 1],
    }),
    /CHECK constraint failed/,
    'the signal_type CHECK is the DB-level backstop for isKnownOwnerLinkSignal',
  );

  for (const sig of ALL_OWNER_LINK_SIGNAL_TYPES) {
    await client.execute({
      sql: `INSERT INTO account_owner_link_evidence
              (id, link_id, confidence, signal_type, evidence_fingerprint, first_observed_at, last_observed_at)
            VALUES (?,?,?,?,?,?,?)`,
      args: [uniq(`ev-${sig}`), rec.linkId, 'LOW', sig, fp(sig, uniq('x')), 1, 1],
    });
  }
  assert.equal(ALL_OWNER_LINK_SIGNAL_TYPES.length, OWNER_BOUND_SIGNAL_TYPES.length + OBSERVATION_ONLY_SIGNAL_TYPES.length);
});

// ===========================================================================
// 24 — reverse-endpoint index exists and the unique pair index is preserved
// ===========================================================================

test('24: account_owner_links has the reverse-endpoint index on account_ref_hi; the unique pair index is preserved; reverse lookup works', async () => {
  const idxNames = (await client.execute("PRAGMA index_list('account_owner_links')")).rows.map((r) => String(r.name));
  assert.ok(idxNames.includes('idx_account_owner_links_account_ref_hi'), 'reverse-endpoint index present');
  assert.ok(idxNames.includes('ux_account_owner_links_pair'), 'the unique pair index is preserved');

  const revInfo = (await client.execute("PRAGMA index_info('idx_account_owner_links_account_ref_hi')")).rows.map((r) => String(r.name));
  assert.deepEqual(revInfo, ['account_ref_hi']);
  const pairIdx = (await client.execute("PRAGMA index_list('account_owner_links')")).rows.find((r) => String(r.name) === 'ux_account_owner_links_pair');
  assert.equal(Number(pairIdx.unique), 1, 'pair index still UNIQUE');

  const A = uniq('rev-a');
  const B = uniq('rev-b');
  const rec = await establishOwnerLink(A, B);
  const pair = deriveOwnerRefPair(A, B);
  const byHi = (await client.execute({
    sql: 'SELECT id FROM account_owner_links WHERE account_ref_hi = ? AND key_version = ?',
    args: [pair.hi, pair.keyVersion],
  })).rows;
  assert.equal(byHi.length, 1, 'the link is reachable from its hi endpoint');
  assert.equal(String(byHi[0].id), rec.linkId);

  // a lo-endpoint lookup is served by the leftmost column of the unique pair index
  const byLo = (await client.execute({
    sql: 'SELECT id FROM account_owner_links WHERE account_ref_lo = ? AND key_version = ?',
    args: [pair.lo, pair.keyVersion],
  })).rows;
  assert.equal(byLo.length, 1, 'the link is also reachable from its lo endpoint');
});

// ===========================================================================
// 25 — reactivation re-attributes decided_by on the LIVE row; the withdrawal
//      history it clears is retained in the append-only event log
// ===========================================================================

test('25: a WITHDRAWN -> ACTIVE reactivation re-attributes decided_by on the live row (which necessarily clears its withdrawn_* fields); the history lives in account_owner_link_events', async () => {
  const A = uniq('react-a');
  const B = uniq('react-b');
  const admRef = uniq('react-adm');
  const t0 = 5_000_000;

  // Genesis + every reactivation here is a HIGH owner-bound establishing row
  // (ADMIN_MANUAL — the v1 establishment path). createdBy / decidedBy are driven
  // explicitly per cycle so BOTH reactivation-attribution branches
  // (params.decidedBy ?? params.createdBy) are exercised; a SYSTEM reactivating
  // actor stands in for a future HIGH-capable automatic identity producer.
  const created = await establishOwnerLink(A, B, admRef, t0, { createdBy: 'ADMIN', decidedBy: 'ADMIN' });
  assert.equal(created.linkCreated, true);
  let link = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
  assert.equal(link.decidedBy, 'ADMIN', 'an ADMIN_MANUAL genesis link is decided_by ADMIN');
  const genA0 = await readAccountOwnerLinkGeneration(client, A);

  await withdrawOwnerLink(client, { linkId: created.linkId, reason: 'MANUAL_REVIEW', withdrawnAt: t0 + 1_000, decidedBy: 'ADMIN' });
  link = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
  assert.equal(link.status, 'WITHDRAWN');
  assert.equal(link.decidedBy, 'ADMIN');
  assert.equal(link.withdrawnReason, 'MANUAL_REVIEW');
  const genAafterWithdraw = await readAccountOwnerLinkGeneration(client, A);
  assert.ok(genAafterWithdraw > genA0);

  // fresh SYSTEM-attributed observation of the SAME establishing evidence -> reactivation
  const reactivated = await establishOwnerLink(A, B, admRef, t0 + 2_000, { createdBy: 'SYSTEM', decidedBy: 'SYSTEM' });
  assert.equal(reactivated.linkId, created.linkId);
  assert.equal(reactivated.linkStatus, 'ACTIVE');
  assert.equal(reactivated.generationsBumped, true);

  link = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
  assert.equal(link.status, 'ACTIVE');
  assert.equal(link.decidedBy, 'SYSTEM', 'decided_by reflects the REACTIVATING actor, not the prior ADMIN withdrawal');
  assert.equal(link.withdrawnReason, null, 'a live link carries no withdrawn_reason');
  assert.equal(link.withdrawnAt, null);

  const evAfter = await readOwnerLinkEvidence(client, created.linkId);
  assert.equal(evAfter.length, 1, 'evidence row revived in place, not duplicated');
  assert.equal(evAfter[0].firstObservedAt, t0, 'first_observed_at preserved across the revive');
  assert.equal(evAfter[0].observationCount, 2, 'observation_count incremented across the revive, never reset');
  assert.equal(evAfter[0].withdrawnAt, null, 'the LIVE row must read as live — its own tombstone fields are gone');
  assert.equal(evAfter[0].withdrawnReason, null);
  assert.ok(await readAccountOwnerLinkGeneration(client, A) > genAafterWithdraw, 'reactivation bumps generation forward (monotonic)');

  // the withdrawal the revive erased from the live row is STILL fully answerable from the event log
  const eventsAfterFirstCycle = await readOwnerLinkEvents(client, created.linkId);
  assert.deepEqual(
    eventsAfterFirstCycle.map((e) => e.eventType),
    ['LINK_CREATED', 'EVIDENCE_ADDED', 'EVIDENCE_WITHDRAWN', 'LINK_WITHDRAWN', 'EVIDENCE_REACTIVATED', 'LINK_REACTIVATED'],
  );
  const firstWithdrawal = eventsAfterFirstCycle.find((e) => e.eventType === 'EVIDENCE_WITHDRAWN');
  assert.equal(firstWithdrawal.reason, 'MANUAL_REVIEW', 'the reason the live row no longer carries');
  assert.equal(firstWithdrawal.actor, 'ADMIN', 'who withdrew it');
  assert.equal(firstWithdrawal.occurredAt, t0 + 1_000, 'when it was withdrawn');
  assert.equal(firstWithdrawal.previousState, 'ACTIVE');
  assert.equal(firstWithdrawal.newState, 'WITHDRAWN');

  // an ADMIN-recorded reactivation attributes to ADMIN
  await withdrawOwnerLink(client, { linkId: created.linkId, reason: 'REVOKED', withdrawnAt: t0 + 3_000, decidedBy: 'ADMIN' });
  await establishOwnerLink(A, B, admRef, t0 + 4_000, { createdBy: 'ADMIN', decidedBy: 'ADMIN' });
  assert.equal((await readDirectOwnerLink(client, deriveOwnerRefPair(A, B))).decidedBy, 'ADMIN');

  // an explicit decidedBy overrides createdBy on reactivation
  await withdrawOwnerLink(client, { linkId: created.linkId, reason: 'REVOKED', withdrawnAt: t0 + 5_000, decidedBy: 'ADMIN' });
  await establishOwnerLink(A, B, admRef, t0 + 6_000, { createdBy: 'ADMIN', decidedBy: 'SYSTEM' });
  assert.equal((await readDirectOwnerLink(client, deriveOwnerRefPair(A, B))).decidedBy, 'SYSTEM');

  // a plain repeat observation on an already-ACTIVE link does NOT touch decided_by
  await establishOwnerLink(A, B, admRef, t0 + 7_000, { createdBy: 'ADMIN', decidedBy: 'ADMIN' });
  assert.equal((await readDirectOwnerLink(client, deriveOwnerRefPair(A, B))).decidedBy, 'SYSTEM', 'a repeat observation on a live link is not a reactivation');

  // full 3-cycle history is retained, in order, with per-transition reason + actor + time
  const allEvents = await readOwnerLinkEvents(client, created.linkId);
  assert.equal(allEvents.length, 14, 'genesis (2) + 3 * [EVIDENCE_WITHDRAWN, LINK_WITHDRAWN, EVIDENCE_REACTIVATED, LINK_REACTIVATED]; the t0+7000 repeat observation added nothing');
  assert.ok(allEvents.every((e, i) => i === 0 || e.id > allEvents[i - 1].id), 'event ids strictly increasing (canonical order)');

  const linkEvents = allEvents.filter((e) => e.eventType.startsWith('LINK_'));
  assert.deepEqual(
    linkEvents.map((e) => e.eventType),
    ['LINK_CREATED', 'LINK_WITHDRAWN', 'LINK_REACTIVATED', 'LINK_WITHDRAWN', 'LINK_REACTIVATED', 'LINK_WITHDRAWN', 'LINK_REACTIVATED'],
  );
  const withdrawns = linkEvents.filter((e) => e.eventType === 'LINK_WITHDRAWN');
  assert.deepEqual(withdrawns.map((e) => e.reason), ['MANUAL_REVIEW', 'REVOKED', 'REVOKED']);
  assert.deepEqual(withdrawns.map((e) => e.actor), ['ADMIN', 'ADMIN', 'ADMIN']);
  assert.deepEqual(withdrawns.map((e) => e.occurredAt), [t0 + 1_000, t0 + 3_000, t0 + 5_000]);
  const reacts = linkEvents.filter((e) => e.eventType === 'LINK_REACTIVATED');
  assert.deepEqual(reacts.map((e) => e.reason), [null, null, null], 'reactivation events never carry a reason');
  assert.deepEqual(reacts.map((e) => e.actor), ['SYSTEM', 'ADMIN', 'SYSTEM'], 'each reactivation attributed to its own actor');
  assert.deepEqual(reacts.map((e) => e.occurredAt), [t0 + 2_000, t0 + 4_000, t0 + 6_000]);

  // the evidence-scoped view is the same story from account_owner_link_events.evidence_id
  const evId = evAfter[0].id;
  const evEvents = await readOwnerLinkEventsForEvidence(client, evId);
  assert.deepEqual(
    evEvents.map((e) => e.eventType),
    ['EVIDENCE_ADDED', 'EVIDENCE_WITHDRAWN', 'EVIDENCE_REACTIVATED', 'EVIDENCE_WITHDRAWN', 'EVIDENCE_REACTIVATED', 'EVIDENCE_WITHDRAWN', 'EVIDENCE_REACTIVATED'],
  );
  assert.deepEqual(
    evEvents.filter((e) => e.eventType === 'EVIDENCE_WITHDRAWN').map((e) => e.reason),
    ['MANUAL_REVIEW', 'REVOKED', 'REVOKED'],
  );
});

// ===========================================================================
// 26 — generation is DIRECT-PAIR scoped (documents the transitive-phase gap)
// ===========================================================================

test('26: owner_link_generation is DIRECT-PAIR scoped — an A-B link plus a later B-C link never bumps A', async () => {
  const A = uniq('gscope-a');
  const B = uniq('gscope-b');
  const C = uniq('gscope-c');

  await establishOwnerLink(A, B);
  const genA1 = await readAccountOwnerLinkGeneration(client, A);
  const genB1 = await readAccountOwnerLinkGeneration(client, B);
  assert.equal(genA1, 1);
  assert.equal(genB1, 1);

  await establishOwnerLink(B, C);

  assert.equal(
    await readAccountOwnerLinkGeneration(client, A), genA1,
    "A's generation is untouched by a B-C link — a per-account owner_link_generation cannot observe a transitive change, which is exactly why a transitive owner-cluster phase MUST add cluster-level invalidation",
  );
  assert.ok(await readAccountOwnerLinkGeneration(client, B) > genB1, 'B (a real endpoint of the new link) advanced');
  assert.equal(await readAccountOwnerLinkGeneration(client, C), 1, 'C born at generation 1');
  assert.equal(await readDirectActiveOwnerLinkBetween(client, A, C), null, 'and still no transitive A-C link');
});

// ===========================================================================
// 27 — OWNER_LINK_HMAC_KEY has no online rotation path (pinned limitation)
// ===========================================================================

test('27: changing OWNER_LINK_HMAC_KEY orphans existing refs + generations (hidden, not destroyed); no rotation/keyring helper exists', async () => {
  const rotationHelpers = Object.keys(ownerLinkModule).filter((k) => /rotat|keyring|priorkey|previouskey|keyset/i.test(k));
  assert.deepEqual(rotationHelpers, [], `v1 exposes no key-rotation helper (found: ${rotationHelpers.join(', ')}) — see drizzle/0042 HMAC KEY ROTATION`);
  assert.equal(ownerAccountRef.length, 1, 'ownerAccountRef(accountId) has no keyVersion parameter — it always uses the current key');

  const A = uniq('rot-a');
  const B = uniq('rot-b');
  const rec = await establishOwnerLink(A, B);
  assert.ok(await readDirectActiveOwnerLinkBetween(client, A, B));
  assert.equal(await readAccountOwnerLinkGeneration(client, A), 1);
  const refAunderK1 = ownerAccountRef(A);
  const fpUnderK1 = ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['x']);

  const original = process.env[OWNER_LINK_HMAC_KEY_ENV];
  process.env[OWNER_LINK_HMAC_KEY_ENV] = 'a-completely-different-owner-link-hmac-key-v2';
  try {
    assert.notEqual(ownerAccountRef(A), refAunderK1, 'the account ref differs under the new key');
    assert.notEqual(ownerLinkEvidenceFingerprint('SHARED_DEVICE_PASSPORT', ['x']), fpUnderK1, 'the evidence fingerprint differs under the new key');
    assert.equal(
      await readDirectActiveOwnerLinkBetween(client, A, B), null,
      'the existing link is unmatchable under a rotated key — there is NO way to re-derive the v1 ref',
    );
    assert.equal(
      await readAccountOwnerLinkGeneration(client, A), 0,
      'the monotonic generation counter silently reads 0 under a rotated key',
    );
  } finally {
    if (original === undefined) delete process.env[OWNER_LINK_HMAC_KEY_ENV];
    else process.env[OWNER_LINK_HMAC_KEY_ENV] = original;
  }

  assert.ok(await readDirectActiveOwnerLinkBetween(client, A, B), 'restoring the original key restores visibility — rotation hides, it does not delete');
  assert.equal(await readAccountOwnerLinkGeneration(client, A), 1, 'the generation counter is intact once the original key is restored');
  assert.equal((await readOwnerLinkEvidence(client, rec.linkId)).length, 1);
});

// ===========================================================================
// 28 — drizzle/0042 CHECK vocabularies stay in lockstep with lib/owner-link.ts
// ===========================================================================

test('28: drizzle/0042 signal_type + withdrawn_reason CHECK lists match lib/owner-link.ts exactly', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, '0042_account_owner_links.sql'), 'utf8');

  const sigMatch = sql.match(/signal_type TEXT NOT NULL CHECK \(signal_type IN \(([\s\S]*?)\)\)/);
  assert.ok(sigMatch, 'signal_type CHECK present in the migration');
  const sigTokens = [...sigMatch[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    sigTokens, [...ALL_OWNER_LINK_SIGNAL_TYPES].sort(),
    'the signal_type CHECK list must equal OWNER_BOUND_SIGNAL_TYPES + OBSERVATION_ONLY_SIGNAL_TYPES exactly',
  );

  const reasonBlocks = [...sql.matchAll(/withdrawn_reason IN\s*\(([^)]*)\)/g)]
    .map((m) => [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort());
  assert.equal(reasonBlocks.length, 2, 'withdrawn_reason CHECK present on BOTH owner-link tables');
  for (const block of reasonBlocks) {
    assert.deepEqual(block, [...OWNER_LINK_WITHDRAWAL_REASONS].sort());
  }
});

// ===========================================================================
// 29 — genesis events; NO event for a plain repeat / confidence-only change
// ===========================================================================

test('29: LINK_CREATED + EVIDENCE_ADDED on genesis; a repeat observation or a same-band confidence change on already-live evidence records NO event', async () => {
  const A = uniq('evt29-a');
  const B = uniq('evt29-b');
  const admRef = uniq('evt29-adm');
  const suppRef = uniq('evt29-supp');
  const rec = await establishOwnerLink(A, B, admRef, 1_000);

  let events = await readOwnerLinkEvents(client, rec.linkId);
  assert.deepEqual(events.map((e) => e.eventType), ['LINK_CREATED', 'EVIDENCE_ADDED']);
  assert.deepEqual(events.map((e) => e.previousState), [null, null], 'genesis events have no previous_state');
  assert.deepEqual(events.map((e) => e.newState), ['ACTIVE', 'ACTIVE']);
  assert.deepEqual(events.map((e) => e.reason), [null, null], 'genesis events carry no reason');
  assert.equal(events[0].evidenceId, null, 'LINK_CREATED is link-level');
  assert.ok(events[1].evidenceId, 'EVIDENCE_ADDED points at the evidence row');

  // plain repeat observation of the SAME live establishing evidence -> no event, no generation bump
  const repeat = await establishOwnerLink(A, B, admRef, 2_000);
  assert.equal(repeat.generationsBumped, false, 'nothing material changed');
  assert.equal((await readOwnerLinkEvents(client, rec.linkId)).length, 2, 'a repeat observation of already-live evidence is not a state transition');

  // attach a LOW supporting owner-bound row (the link already exists) -> that IS a new evidence row
  await upsertOwnerLinkEvidence(client, {
    accountId: A, candidateSourceAccountId: B, signalType: 'SHARED_DEVICE_PASSPORT', confidence: 'LOW',
    evidenceFingerprint: fp('SHARED_DEVICE_PASSPORT', suppRef), observedAt: 3_000, createdBy: 'SYSTEM',
  });
  assert.deepEqual(
    (await readOwnerLinkEvents(client, rec.linkId)).map((e) => e.eventType),
    ['LINK_CREATED', 'EVIDENCE_ADDED', 'EVIDENCE_ADDED'],
    'attaching a new supporting row is one EVIDENCE_ADDED',
  );

  // same-band confidence change of that SUPPORTING row (LOW -> MEDIUM) — link stays ACTIVE
  // on the HIGH establishing row, strongest_confidence stays HIGH -> NO event
  const bump = await upsertOwnerLinkEvidence(client, {
    accountId: A, candidateSourceAccountId: B, signalType: 'SHARED_DEVICE_PASSPORT', confidence: 'MEDIUM',
    evidenceFingerprint: fp('SHARED_DEVICE_PASSPORT', suppRef), observedAt: 4_000, createdBy: 'SYSTEM',
  });
  assert.equal(bump.linkStatus, 'ACTIVE');
  assert.equal(bump.generationsBumped, false, 'the link strongest_confidence (HIGH) did not move — not a material change');
  events = await readOwnerLinkEvents(client, rec.linkId);
  assert.equal(events.length, 3, 'a confidence change on live evidence that does not cross ACTIVE/WITHDRAWN records no event');
});

// ===========================================================================
// 30 — idempotent no-op withdrawals append NOTHING
// ===========================================================================

test('30: withdrawing already-withdrawn evidence, or an already-withdrawn link, appends no event (idempotent — no state transition)', async () => {
  const A = uniq('evt30-a');
  const B = uniq('evt30-b');
  const rec = await establishOwnerLink(A, B);
  const [ev] = await readOwnerLinkEvidence(client, rec.linkId);

  await withdrawOwnerLinkEvidence(client, { evidenceId: ev.id, reason: 'MANUAL_REVIEW', withdrawnAt: 10, decidedBy: 'ADMIN' });
  const afterFirst = await dumpOwnerLinkTables();
  const eventCountAfterFirst = (await readOwnerLinkEvents(client, rec.linkId)).length;

  // repeat withdrawal of the same evidence -> ALREADY_WITHDRAWN, nothing written
  const again = await withdrawOwnerLinkEvidence(client, { evidenceId: ev.id, reason: 'REVOKED', withdrawnAt: 20, decidedBy: 'ADMIN' });
  assert.equal(again.outcome, 'ALREADY_WITHDRAWN');
  // repeat withdrawal of the (already WITHDRAWN) link -> ALREADY_WITHDRAWN, nothing written
  const linkAgain = await withdrawOwnerLink(client, { linkId: rec.linkId, reason: 'SUPERSEDED', withdrawnAt: 30, decidedBy: 'ADMIN' });
  assert.equal(linkAgain.outcome, 'ALREADY_WITHDRAWN');

  assert.equal(await dumpOwnerLinkTables(), afterFirst, 'no-op withdrawals write nothing at all — not even an event');
  assert.equal((await readOwnerLinkEvents(client, rec.linkId)).length, eventCountAfterFirst, 'no duplicate transition history for a no-op');
});

// ===========================================================================
// 31 — evidence-level vs link-level transitions
// ===========================================================================

test('31: withdrawing one of several qualifying evidence rows is EVIDENCE_WITHDRAWN only; withdrawing the last one also emits LINK_WITHDRAWN; a confidence downgrade of the sole evidence emits LINK_WITHDRAWN', async () => {
  const A = uniq('evt31-a');
  const B = uniq('evt31-b');
  // two HIGH owner-bound establishing rows for the same pair (distinct fingerprints)
  const rec = await establishOwnerLink(A, B, uniq('adm'), 100);
  await establishOwnerLink(A, B, uniq('adm'), 110);
  // plus a MEDIUM supporting row — it can never hold the link ACTIVE on its own
  await addSupportingEvidence(A, B, 'CROSS_PASSPORT_ACTOR_COOCCURRENCE', uniq('scope'), 115);
  const evs = await readOwnerLinkEvidence(client, rec.linkId);
  const highs = evs.filter((e) => e.signalType === 'ADMIN_MANUAL');
  assert.equal(highs.length, 2);

  // withdraw one HIGH -> link stays ACTIVE (the other HIGH still qualifies) -> EVIDENCE_WITHDRAWN only
  await withdrawOwnerLinkEvidence(client, { evidenceId: highs[0].id, reason: 'REVOKED', withdrawnAt: 200, decidedBy: 'ADMIN' });
  assert.equal((await readDirectOwnerLink(client, deriveOwnerRefPair(A, B))).status, 'ACTIVE');
  let events = await readOwnerLinkEvents(client, rec.linkId);
  assert.deepEqual(events.map((e) => e.eventType), ['LINK_CREATED', 'EVIDENCE_ADDED', 'EVIDENCE_ADDED', 'EVIDENCE_ADDED', 'EVIDENCE_WITHDRAWN']);
  assert.equal(events.at(-1).evidenceId, highs[0].id);

  // withdraw the last HIGH one -> link drops (the live MEDIUM row cannot hold it) -> EVIDENCE_WITHDRAWN + LINK_WITHDRAWN
  await withdrawOwnerLinkEvidence(client, { evidenceId: highs[1].id, reason: 'MANUAL_REVIEW', withdrawnAt: 300, decidedBy: 'ADMIN' });
  assert.equal((await readDirectOwnerLink(client, deriveOwnerRefPair(A, B))).status, 'WITHDRAWN', 'no live HIGH row remains — the MEDIUM supporting row does not keep it ACTIVE');
  events = await readOwnerLinkEvents(client, rec.linkId);
  assert.deepEqual(
    events.map((e) => e.eventType),
    ['LINK_CREATED', 'EVIDENCE_ADDED', 'EVIDENCE_ADDED', 'EVIDENCE_ADDED', 'EVIDENCE_WITHDRAWN', 'EVIDENCE_WITHDRAWN', 'LINK_WITHDRAWN'],
  );
  assert.equal(events.at(-1).eventType, 'LINK_WITHDRAWN');
  assert.equal(events.at(-1).reason, 'MANUAL_REVIEW');
  assert.equal(events.at(-1).evidenceId, null);

  // a confidence downgrade of the SOLE qualifying evidence withdraws the link via upsert
  const C = uniq('evt31-c');
  const D = uniq('evt31-d');
  const admCD = uniq('adm-cd');
  const recCD = await establishOwnerLink(C, D, admCD, 400);
  // re-observe the SAME establishing row at MEDIUM -> it is no longer qualifying -> link drops
  await upsertOwnerLinkEvidence(client, {
    accountId: C, candidateSourceAccountId: D, signalType: 'ADMIN_MANUAL', confidence: 'MEDIUM',
    evidenceFingerprint: fp('ADMIN_MANUAL', admCD), observedAt: 410, createdBy: 'ADMIN', decidedBy: 'ADMIN',
  });
  assert.equal((await readDirectOwnerLink(client, deriveOwnerRefPair(C, D))).status, 'WITHDRAWN');
  const cdEvents = await readOwnerLinkEvents(client, recCD.linkId);
  assert.deepEqual(cdEvents.map((e) => e.eventType), ['LINK_CREATED', 'EVIDENCE_ADDED', 'LINK_WITHDRAWN']);
  assert.equal(cdEvents.at(-1).reason, 'NO_QUALIFYING_EVIDENCE', 'the automatic downgrade reason mirrors the row write');
  assert.equal(cdEvents.at(-1).evidenceId, null, 'no fake EVIDENCE_WITHDRAWN — the evidence row was re-observed, not tombstoned');
});

// ===========================================================================
// 32 — withdrawOwnerLink event fan-out
// ===========================================================================

test('32: withdrawOwnerLink emits one EVIDENCE_WITHDRAWN per tombstoned row plus one LINK_WITHDRAWN; withdrawEvidence:false emits only LINK_WITHDRAWN', async () => {
  const A = uniq('evt32-a');
  const B = uniq('evt32-b');
  const rec = await establishOwnerLink(A, B, uniq('pp'), 1);
  await upsertOwnerLinkEvidence(client, {
    accountId: A, candidateSourceAccountId: B, signalType: 'CROSS_PASSPORT_ACTOR_COOCCURRENCE', confidence: 'MEDIUM',
    evidenceFingerprint: fp('CROSS_PASSPORT_ACTOR_COOCCURRENCE', uniq('s')), observedAt: 2, createdBy: 'SYSTEM',
  });
  await upsertOwnerLinkEvidence(client, {
    accountId: A, candidateSourceAccountId: B, signalType: 'IP_COOCCURRENCE', confidence: 'LOW',
    evidenceFingerprint: fp('IP_COOCCURRENCE', uniq('ip')), observedAt: 3, createdBy: 'SYSTEM',
  });
  const liveBefore = (await readOwnerLinkEvidence(client, rec.linkId)).filter((e) => e.withdrawnAt == null);
  assert.equal(liveBefore.length, 3);

  const w = await withdrawOwnerLink(client, { linkId: rec.linkId, reason: 'ADMIN_CORRECTION', withdrawnAt: 500, decidedBy: 'ADMIN' });
  assert.equal(w.evidenceTombstoned, 3);
  const events = await readOwnerLinkEvents(client, rec.linkId);
  const withdrawnEvidenceEvents = events.filter((e) => e.eventType === 'EVIDENCE_WITHDRAWN');
  assert.equal(withdrawnEvidenceEvents.length, 3, 'one EVIDENCE_WITHDRAWN per tombstoned row');
  assert.deepEqual(new Set(withdrawnEvidenceEvents.map((e) => e.evidenceId)), new Set(liveBefore.map((e) => e.id)));
  const linkWithdrawnEvents = events.filter((e) => e.eventType === 'LINK_WITHDRAWN');
  assert.equal(linkWithdrawnEvents.length, 1);
  assert.equal(linkWithdrawnEvents[0].reason, 'ADMIN_CORRECTION');
  assert.equal(linkWithdrawnEvents[0].actor, 'ADMIN');
  for (const e of withdrawnEvidenceEvents) assert.equal(e.reason, 'ADMIN_CORRECTION');

  // withdrawEvidence:false -> only LINK_WITHDRAWN, evidence stays live
  const C = uniq('evt32-c');
  const D = uniq('evt32-d');
  const recCD = await establishOwnerLink(C, D);
  const wNoEv = await withdrawOwnerLink(client, { linkId: recCD.linkId, reason: 'SUPERSEDED', withdrawnAt: 600, decidedBy: 'ADMIN', withdrawEvidence: false });
  assert.equal(wNoEv.evidenceTombstoned, 0);
  const cdEvents = await readOwnerLinkEvents(client, recCD.linkId);
  assert.deepEqual(cdEvents.map((e) => e.eventType), ['LINK_CREATED', 'EVIDENCE_ADDED', 'LINK_WITHDRAWN']);
  assert.equal((await readOwnerLinkEvidence(client, recCD.linkId))[0].withdrawnAt, null, 'evidence left live when withdrawEvidence:false');
});

// ===========================================================================
// 33 — the event log carries NO raw identity material
// ===========================================================================

test('33: account_owner_link_events stores only internal ids, bounded enums, one reason, one actor, one timestamp — never account/email/fingerprint/free text', async () => {
  const A = uniq('evt33-account-alpha');
  const B = uniq('evt33-account-beta');
  const rec = await establishOwnerLink(A, B, uniq('pp-secret'), 1);
  const [ev] = await readOwnerLinkEvidence(client, rec.linkId);
  await withdrawOwnerLinkEvidence(client, { evidenceId: ev.id, reason: 'MANUAL_REVIEW', withdrawnAt: 2, decidedBy: 'ADMIN' });
  await establishOwnerLink(A, B, uniq('pp-secret'), 3); // (a fresh HIGH row → new evidence, reactivates the link)

  const rows = (await client.execute('SELECT * FROM account_owner_link_events WHERE link_id = ? ORDER BY id', [rec.linkId])).rows;
  const dump = JSON.stringify(rows);
  assert.equal(dump.includes(A), false, 'no account id');
  assert.equal(dump.includes(B), false, 'no account id');
  assert.equal(dump.includes('pp-secret'), false, 'no passport ref / fingerprint input');
  assert.equal(dump.includes('@'), false, 'no email');

  const linkRow = await readDirectOwnerLink(client, deriveOwnerRefPair(A, B));
  for (const r of rows) {
    assert.equal(String(r.link_id), rec.linkId, 'link_id is the internal link uuid');
    if (r.evidence_id != null) assert.match(String(r.evidence_id), /^[0-9a-f-]{36}$/, 'evidence_id is an internal uuid');
    assert.ok(OWNER_LINK_EVENT_TYPES.includes(String(r.event_type)));
    assert.ok(r.previous_state == null || OWNER_LINK_EVENT_STATES.includes(String(r.previous_state)));
    assert.ok(OWNER_LINK_EVENT_STATES.includes(String(r.new_state)));
    assert.ok(r.reason == null || OWNER_LINK_WITHDRAWAL_REASONS.includes(String(r.reason)));
    assert.ok(['SYSTEM', 'ADMIN'].includes(String(r.actor)));
    assert.equal(typeof Number(r.occurred_at), 'number');
  }
  assert.ok(linkRow); // sanity
});

// ===========================================================================
// 34 — event-log column CHECKs + the reason-placement guard
// ===========================================================================

test('34: account_owner_link_events rejects invalid enums at the DB level; a reason on a non-withdrawal event is rejected app- and DB-side', () => {
  for (const t of OWNER_LINK_EVENT_TYPES) assert.equal(isOwnerLinkEventType(t), true);
  assert.equal(isOwnerLinkEventType('NOT_AN_EVENT'), false);
  assert.equal(ownerLinkEventTypeAllowsReason('LINK_WITHDRAWN'), true);
  assert.equal(ownerLinkEventTypeAllowsReason('EVIDENCE_WITHDRAWN'), true);
  assert.equal(ownerLinkEventTypeAllowsReason('LINK_REACTIVATED'), false);
  assert.equal(ownerLinkEventTypeAllowsReason('EVIDENCE_ADDED'), false);
});

test('34b: raw INSERTs into account_owner_link_events are CHECK-constrained on every enum column', async () => {
  const A = uniq('evt34-a');
  const B = uniq('evt34-b');
  const rec = await establishOwnerLink(A, B);

  const bad = [
    `INSERT INTO account_owner_link_events (link_id, event_type, new_state, actor, occurred_at) VALUES ('${rec.linkId}', 'NOT_AN_EVENT', 'ACTIVE', 'SYSTEM', 1)`,
    `INSERT INTO account_owner_link_events (link_id, event_type, new_state, actor, occurred_at) VALUES ('${rec.linkId}', 'LINK_CREATED', 'BOGUS', 'SYSTEM', 1)`,
    `INSERT INTO account_owner_link_events (link_id, event_type, previous_state, new_state, actor, occurred_at) VALUES ('${rec.linkId}', 'LINK_WITHDRAWN', 'NOPE', 'WITHDRAWN', 'ADMIN', 1)`,
    `INSERT INTO account_owner_link_events (link_id, event_type, new_state, reason, actor, occurred_at) VALUES ('${rec.linkId}', 'LINK_WITHDRAWN', 'WITHDRAWN', 'attacker@evil.com', 'ADMIN', 1)`,
    `INSERT INTO account_owner_link_events (link_id, event_type, new_state, actor, occurred_at) VALUES ('${rec.linkId}', 'LINK_CREATED', 'ACTIVE', 'ROOT', 1)`,
  ];
  for (const sql of bad) {
    await assert.rejects(() => client.execute(sql), /CHECK constraint failed/, sql.slice(0, 70));
  }
  // a well-formed row is accepted
  await client.execute(
    `INSERT INTO account_owner_link_events (link_id, event_type, previous_state, new_state, reason, actor, occurred_at)
     VALUES ('${rec.linkId}', 'LINK_WITHDRAWN', 'ACTIVE', 'WITHDRAWN', 'REVOKED', 'ADMIN', 999)`,
  );
  // a bad evidence_id is an FK failure, not a CHECK failure (the row is shape-valid: EVIDENCE_WITHDRAWN with a reason)
  await assert.rejects(
    () => client.execute(`INSERT INTO account_owner_link_events (link_id, evidence_id, event_type, previous_state, new_state, reason, actor, occurred_at) VALUES ('${rec.linkId}', 'no-such-evidence', 'EVIDENCE_WITHDRAWN', 'ACTIVE', 'WITHDRAWN', 'REVOKED', 'ADMIN', 1)`),
    /FOREIGN KEY constraint failed/,
  );
});

// ===========================================================================
// 35 — drizzle/0042 event CHECK vocabularies stay in lockstep with lib
// ===========================================================================

test('35: drizzle/0042 account_owner_link_events CHECK lists match lib/owner-link.ts', () => {
  const sql = fs.readFileSync(path.join(drizzleDir, '0042_account_owner_links.sql'), 'utf8');

  const typeMatch = sql.match(/event_type TEXT NOT NULL CHECK \(event_type IN \(([\s\S]*?)\)\)/);
  assert.ok(typeMatch, 'event_type CHECK present');
  const typeTokens = [...typeMatch[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(typeTokens, [...OWNER_LINK_EVENT_TYPES].sort());

  // previous_state + new_state CHECKs each list exactly OWNER_LINK_EVENT_STATES
  const stateBlocks = [...sql.matchAll(/(?:previous_state|new_state)[^\n]*IN \(([^)]*)\)/g)]
    .map((m) => [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort());
  assert.equal(stateBlocks.length, 2, 'previous_state + new_state CHECKs both present on the events table');
  for (const block of stateBlocks) assert.deepEqual(block, [...OWNER_LINK_EVENT_STATES].sort());

  // the events table's reason CHECK reuses OWNER_LINK_WITHDRAWAL_REASONS (3rd withdrawn/reason block in the file)
  const reasonBlocks = [...sql.matchAll(/\breason IN\s*\(([^)]*)\)/g)]
    .map((m) => [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort());
  assert.ok(reasonBlocks.length >= 1);
  for (const block of reasonBlocks) assert.deepEqual(block, [...OWNER_LINK_WITHDRAWAL_REASONS].sort());

  // the table-level SHAPE CHECK exists and enumerates exactly the six event
  // types (each `event_type = '...' AND evidence_id ...` disjunct appears only
  // in the shape CHECK, never in the column `event_type IN (...)` check).
  const shapeTypes = [...sql.matchAll(/event_type = '([A-Z_]+)' +AND evidence_id/g)].map((m) => m[1]).sort();
  assert.deepEqual(shapeTypes, [...OWNER_LINK_EVENT_TYPES].sort(), 'the shape CHECK enumerates exactly the six event types');

  // the app-side shape table (OWNER_LINK_EVENT_SHAPES) covers exactly the same six types
  assert.deepEqual(Object.keys(OWNER_LINK_EVENT_SHAPES).sort(), [...OWNER_LINK_EVENT_TYPES].sort());
});

// ===========================================================================
// 35b — every event_type has exactly ONE legal shape (DB shape CHECK)
// ===========================================================================

test('35b: account_owner_link_events shape CHECK rejects every impossible (event_type, evidence_id, previous_state, new_state, reason) combination at the DB layer', async () => {
  const A = uniq('shape-a');
  const B = uniq('shape-b');
  const rec = await establishOwnerLink(A, B);
  const [ev] = await readOwnerLinkEvidence(client, rec.linkId); // a real evidence id for the "link event with evidence_id" case
  const L = rec.linkId;
  const E = ev.id;

  const ins = (cols, vals) =>
    client.execute(`INSERT INTO account_owner_link_events (${cols.join(', ')}) VALUES (${vals.map((v) => (v === null ? 'NULL' : `'${v}'`)).join(', ')})`);

  // every impossible combination the reviewer enumerated (+ a few more), each must fail with CHECK
  const impossible = [
    // wrong previous_state
    ['LINK_WITHDRAWN wrong prev', ['link_id', 'event_type', 'previous_state', 'new_state', 'reason', 'actor', 'occurred_at'], [L, 'LINK_WITHDRAWN', 'WITHDRAWN', 'WITHDRAWN', 'REVOKED', 'ADMIN', 1]],
    ['LINK_REACTIVATED wrong prev', ['link_id', 'event_type', 'previous_state', 'new_state', 'actor', 'occurred_at'], [L, 'LINK_REACTIVATED', 'ACTIVE', 'ACTIVE', 'SYSTEM', 1]],
    ['LINK_CREATED wrong prev (not NULL)', ['link_id', 'event_type', 'previous_state', 'new_state', 'actor', 'occurred_at'], [L, 'LINK_CREATED', 'ACTIVE', 'ACTIVE', 'SYSTEM', 1]],
    // wrong new_state
    ['LINK_WITHDRAWN wrong new', ['link_id', 'event_type', 'previous_state', 'new_state', 'reason', 'actor', 'occurred_at'], [L, 'LINK_WITHDRAWN', 'ACTIVE', 'ACTIVE', 'REVOKED', 'ADMIN', 1]],
    ['LINK_CREATED wrong new', ['link_id', 'event_type', 'new_state', 'actor', 'occurred_at'], [L, 'LINK_CREATED', 'WITHDRAWN', 'SYSTEM', 1]],
    // missing withdrawal reason
    ['LINK_WITHDRAWN missing reason', ['link_id', 'event_type', 'previous_state', 'new_state', 'actor', 'occurred_at'], [L, 'LINK_WITHDRAWN', 'ACTIVE', 'WITHDRAWN', 'ADMIN', 1]],
    ['EVIDENCE_WITHDRAWN missing reason', ['link_id', 'evidence_id', 'event_type', 'previous_state', 'new_state', 'actor', 'occurred_at'], [L, E, 'EVIDENCE_WITHDRAWN', 'ACTIVE', 'WITHDRAWN', 'ADMIN', 1]],
    // reason present on a non-withdrawal
    ['LINK_REACTIVATED with reason', ['link_id', 'event_type', 'previous_state', 'new_state', 'reason', 'actor', 'occurred_at'], [L, 'LINK_REACTIVATED', 'WITHDRAWN', 'ACTIVE', 'REVOKED', 'ADMIN', 1]],
    ['EVIDENCE_ADDED with reason', ['link_id', 'evidence_id', 'event_type', 'new_state', 'reason', 'actor', 'occurred_at'], [L, E, 'EVIDENCE_ADDED', 'ACTIVE', 'MANUAL_REVIEW', 'SYSTEM', 1]],
    ['LINK_CREATED with reason', ['link_id', 'event_type', 'new_state', 'reason', 'actor', 'occurred_at'], [L, 'LINK_CREATED', 'ACTIVE', 'REVOKED', 'SYSTEM', 1]],
    // evidence event with NULL evidence_id
    ['EVIDENCE_ADDED null evidence_id', ['link_id', 'event_type', 'new_state', 'actor', 'occurred_at'], [L, 'EVIDENCE_ADDED', 'ACTIVE', 'SYSTEM', 1]],
    ['EVIDENCE_WITHDRAWN null evidence_id', ['link_id', 'event_type', 'previous_state', 'new_state', 'reason', 'actor', 'occurred_at'], [L, 'EVIDENCE_WITHDRAWN', 'ACTIVE', 'WITHDRAWN', 'REVOKED', 'ADMIN', 1]],
    ['EVIDENCE_REACTIVATED null evidence_id', ['link_id', 'event_type', 'previous_state', 'new_state', 'actor', 'occurred_at'], [L, 'EVIDENCE_REACTIVATED', 'WITHDRAWN', 'ACTIVE', 'SYSTEM', 1]],
    // link event with non-NULL evidence_id
    ['LINK_CREATED with evidence_id', ['link_id', 'evidence_id', 'event_type', 'new_state', 'actor', 'occurred_at'], [L, E, 'LINK_CREATED', 'ACTIVE', 'SYSTEM', 1]],
    ['LINK_WITHDRAWN with evidence_id', ['link_id', 'evidence_id', 'event_type', 'previous_state', 'new_state', 'reason', 'actor', 'occurred_at'], [L, E, 'LINK_WITHDRAWN', 'ACTIVE', 'WITHDRAWN', 'REVOKED', 'ADMIN', 1]],
    ['LINK_REACTIVATED with evidence_id', ['link_id', 'evidence_id', 'event_type', 'previous_state', 'new_state', 'actor', 'occurred_at'], [L, E, 'LINK_REACTIVATED', 'WITHDRAWN', 'ACTIVE', 'SYSTEM', 1]],
  ];
  for (const [label, cols, vals] of impossible) {
    await assert.rejects(() => ins(cols, vals), /CHECK constraint failed/, label);
  }
  assert.equal(Number((await client.execute(`SELECT COUNT(*) AS c FROM account_owner_link_events WHERE link_id = ?`, [L])).rows[0].c), 2, 'genesis events only — no impossible row slipped through');

  // every LEGAL shape is accepted (one raw INSERT per event type)
  const legal = [
    ['LINK_CREATED', ['link_id', 'event_type', 'new_state', 'actor', 'occurred_at'], [L, 'LINK_CREATED', 'ACTIVE', 'SYSTEM', 10]],
    ['LINK_WITHDRAWN', ['link_id', 'event_type', 'previous_state', 'new_state', 'reason', 'actor', 'occurred_at'], [L, 'LINK_WITHDRAWN', 'ACTIVE', 'WITHDRAWN', 'MANUAL_REVIEW', 'ADMIN', 11]],
    ['LINK_REACTIVATED', ['link_id', 'event_type', 'previous_state', 'new_state', 'actor', 'occurred_at'], [L, 'LINK_REACTIVATED', 'WITHDRAWN', 'ACTIVE', 'SYSTEM', 12]],
    ['EVIDENCE_ADDED', ['link_id', 'evidence_id', 'event_type', 'new_state', 'actor', 'occurred_at'], [L, E, 'EVIDENCE_ADDED', 'ACTIVE', 'SYSTEM', 13]],
    ['EVIDENCE_WITHDRAWN', ['link_id', 'evidence_id', 'event_type', 'previous_state', 'new_state', 'reason', 'actor', 'occurred_at'], [L, E, 'EVIDENCE_WITHDRAWN', 'ACTIVE', 'WITHDRAWN', 'REVOKED', 'ADMIN', 14]],
    ['EVIDENCE_REACTIVATED', ['link_id', 'evidence_id', 'event_type', 'previous_state', 'new_state', 'actor', 'occurred_at'], [L, E, 'EVIDENCE_REACTIVATED', 'WITHDRAWN', 'ACTIVE', 'SYSTEM', 15]],
  ];
  for (const [label, cols, vals] of legal) {
    await ins(cols, vals); // must not throw
  }
});

// ===========================================================================
// 35c — assertOwnerLinkEventShape (app-side mirror of the shape CHECK)
// ===========================================================================

test('35c: assertOwnerLinkEventShape accepts the one legal shape per event type and throws on every deviation', () => {
  const legalOf = (t) => {
    const s = OWNER_LINK_EVENT_SHAPES[t];
    return {
      eventType: t,
      evidenceId: s.scope === 'EVIDENCE' ? 'ev-uuid' : null,
      previousState: s.previousState,
      newState: s.newState,
      reason: s.reasonRequired ? 'REVOKED' : null,
    };
  };
  for (const t of OWNER_LINK_EVENT_TYPES) {
    assert.doesNotThrow(() => assertOwnerLinkEventShape(legalOf(t)), `${t} legal shape accepted`);
  }

  // scope violations
  assert.throws(() => assertOwnerLinkEventShape({ ...legalOf('LINK_CREATED'), evidenceId: 'ev' }), /requires evidence_id NULL/);
  assert.throws(() => assertOwnerLinkEventShape({ ...legalOf('EVIDENCE_ADDED'), evidenceId: null }), /requires evidence_id NOT NULL/);
  // state violations
  assert.throws(() => assertOwnerLinkEventShape({ ...legalOf('LINK_WITHDRAWN'), previousState: 'WITHDRAWN' }), /requires previous_state ACTIVE/);
  assert.throws(() => assertOwnerLinkEventShape({ ...legalOf('LINK_REACTIVATED'), previousState: 'ACTIVE' }), /requires previous_state WITHDRAWN/);
  assert.throws(() => assertOwnerLinkEventShape({ ...legalOf('LINK_CREATED'), previousState: 'ACTIVE' }), /requires previous_state NULL/);
  assert.throws(() => assertOwnerLinkEventShape({ ...legalOf('EVIDENCE_WITHDRAWN'), newState: 'ACTIVE' }), /requires new_state WITHDRAWN/);
  assert.throws(() => assertOwnerLinkEventShape({ ...legalOf('LINK_REACTIVATED'), newState: 'WITHDRAWN' }), /requires new_state ACTIVE/);
  // reason presence violations
  assert.throws(() => assertOwnerLinkEventShape({ ...legalOf('EVIDENCE_WITHDRAWN'), reason: null }), /requires reason NOT NULL/);
  assert.throws(() => assertOwnerLinkEventShape({ ...legalOf('LINK_REACTIVATED'), reason: 'REVOKED' }), /requires reason NULL/);
  assert.throws(() => assertOwnerLinkEventShape({ ...legalOf('EVIDENCE_ADDED'), reason: 'MANUAL_REVIEW' }), /requires reason NULL/);
  // unknown type
  assert.throws(() => assertOwnerLinkEventShape({ eventType: 'NOPE', evidenceId: null, previousState: null, newState: 'ACTIVE', reason: null }), /Unknown owner-link event type/);

  // ownerLinkEventTypeAllowsReason is exactly "reason required"
  for (const t of OWNER_LINK_EVENT_TYPES) {
    assert.equal(ownerLinkEventTypeAllowsReason(t), OWNER_LINK_EVENT_SHAPES[t].reasonRequired);
  }
});

// ===========================================================================
// 36 — deletion / cleanup never erases the transition history
// ===========================================================================

test('36: report deletion, room clearing, and account deletion leave account_owner_link_events byte-identical — the full withdrawal history survives', async () => {
  const A = uniq('evt36-a');
  const B = uniq('evt36-b');
  await ensureUser(A);
  await ensureUser(B);
  const passportRef = uniq('evt36-pp');
  const rec = await establishOwnerLink(A, B, passportRef, 1_000);
  // one full withdraw + reactivate cycle so there is real history to lose
  await withdrawOwnerLink(client, { linkId: rec.linkId, reason: 'MANUAL_REVIEW', withdrawnAt: 1_100, decidedBy: 'ADMIN' });
  await establishOwnerLink(A, B, passportRef, 1_200);

  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [uniq('r'), uniq('dk'), 'sub', 't', new Date().toISOString(), 6, 0, 'Low', '{}', A],
  });

  const eventsBefore = await readOwnerLinkEvents(client, rec.linkId);
  assert.deepEqual(
    eventsBefore.map((e) => e.eventType),
    ['LINK_CREATED', 'EVIDENCE_ADDED', 'EVIDENCE_WITHDRAWN', 'LINK_WITHDRAWN', 'EVIDENCE_REACTIVATED', 'LINK_REACTIVATED'],
  );
  const rawBefore = JSON.stringify((await client.execute('SELECT * FROM account_owner_link_events ORDER BY id')).rows);

  await deleteAllReportDataForAccount(client, A, { preserveActivelyPromotedRepresentations: true });
  await deleteAccountData(client, A);
  await invalidateSessionsAndDeleteUser(client, A);

  assert.equal(
    (await client.execute({ sql: 'SELECT COUNT(*) AS c FROM users WHERE id = ?', args: [A] })).rows[0].c, 0,
    'the account IS gone',
  );
  assert.equal(
    JSON.stringify((await client.execute('SELECT * FROM account_owner_link_events ORDER BY id')).rows), rawBefore,
    'account_owner_link_events is byte-for-byte unchanged by every cleanup path',
  );
  assert.deepEqual((await readOwnerLinkEvents(client, rec.linkId)).map((e) => e.eventType), eventsBefore.map((e) => e.eventType));
});

console.log('owner-link foundation: pseudonyms, canonical pairs, direct-only links, evidence UPSERT/tombstone, generations, telemetry non-veto, privacy, fingerprint canonicalization, withdrawn_reason vocab, signal_type CHECK, reverse index, reactivation attribution, HMAC-rotation limitation, append-only state-transition event log (genesis / withdraw / reactivate / idempotency / multi-cycle / deletion-survival / no-identity-leak / per-event-type shape invariant app+DB / actor-class-not-identity) — verified');
