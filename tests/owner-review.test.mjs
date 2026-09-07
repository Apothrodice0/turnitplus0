import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import {
  DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV,
  DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR,
} from '../lib/device-passport-actor-ledger.ts';
import {
  OWNER_LINK_HMAC_KEY_ENV,
  ownerLinkEvidenceFingerprint,
} from '../lib/owner-link.ts';
import { upsertOwnerLinkEvidence, withdrawOwnerLink } from '../lib/owner-link-repo.ts';
import { deleteAllReportDataForAccount } from '../lib/account-deletion.ts';
import { claimAnonymousReports } from '../lib/auth-session.ts';
import { reviewOwnerEvidence, OWNER_REVIEW_MAX_EVENTS } from '../lib/owner-review.ts';

/**
 * Read-only pair-level owner-evidence reviewer (lib/owner-review.ts). Covers:
 * no shared passport; one shared passport (supporting, never owner); two joint
 * v1 passports (cross-Passport supporting); the household fan-out=2 shape stays
 * SUPPORTING_ONLY; a v0 passport does NOT count as complete cross-Passport
 * evidence; anonymous activity surfaces only as a boolean; drizzle/0042 absent
 * and key-unavailable graceful degradation; an ACTIVE HIGH link is
 * distinguished from MEDIUM supporting evidence; a withdrawn link; the 20-event
 * bound; and that the pair-level co-occurrence query agrees with the
 * device-shared-guard's own report-relative semantics. Every fixture is
 * synthetic; the module never writes.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');

const ACTOR_KEY = 'test-only-actor-hmac-key-owner-review';
const OWNER_KEY = 'test-only-owner-link-hmac-key-owner-review';
const originalActorKey = process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
const originalOwnerKey = process.env[OWNER_LINK_HMAC_KEY_ENV];
process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = ACTOR_KEY;
process.env[OWNER_LINK_HMAC_KEY_ENV] = OWNER_KEY;

test.after(() => {
  if (originalActorKey === undefined) delete process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  else process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = originalActorKey;
  if (originalOwnerKey === undefined) delete process.env[OWNER_LINK_HMAC_KEY_ENV];
  else process.env[OWNER_LINK_HMAC_KEY_ENV] = originalOwnerKey;
});

// ---------------------------------------------------------------------------
// migration + fixture helpers
// ---------------------------------------------------------------------------

const migrationFiles = fs.readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort();
async function applyMigrations(client, { upTo } = {}) {
  for (const file of migrationFiles) {
    if (upTo && !(file < upTo)) continue;
    await client.executeMultiple(fs.readFileSync(path.join(drizzleDir, file), 'utf8'));
  }
}

let dbSeq = 0;
async function freshDb({ upTo } = {}) {
  dbSeq += 1;
  const dbFile = path.join(repo, `test_owner_review_${dbSeq}.db`);
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute('PRAGMA foreign_keys = ON');
  await applyMigrations(client, { upTo });
  test.after(() => {
    client.close();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
  });
  return client;
}

let idSeq = 0;
const uniq = (p) => `${p}-${++idSeq}`;
const actorKeyFor = (accountId) =>
  createHmac('sha256', ACTOR_KEY).update(`${DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR}:${accountId}`, 'utf8').digest('hex');

async function ensureUser(client, id, email) {
  await client.execute({
    sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
    args: [id, email ?? `${id}@e.test`, id, 'x'],
  });
}
async function seedPassport(client, id, { v = 1, revoked = false } = {}) {
  await client.execute({
    sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, revoked_at, provenance_generation, actor_usage_tracking_version)
          VALUES (?,?,?,?,?,0,?) ON CONFLICT(id) DO NOTHING`,
    args: [id, Buffer.from(`spki-${id}`), 'ECDSA-P256-SHA256', Date.now(), revoked ? Date.now() : null, v],
  });
}
async function seedActorRow(client, passportId, actorKey, { anon = false, obs = 1 } = {}) {
  await client.execute({
    sql: `INSERT INTO device_passport_actor_usage
            (device_passport_id, actor_key_version, actor_key, is_anonymous, first_observed_at, last_observed_at, observation_count)
          VALUES (?,1,?,?,?,?,?)
          ON CONFLICT (device_passport_id, actor_key_version, actor_key) DO NOTHING`,
    args: [passportId, actorKey, anon ? 1 : 0, Date.now(), Date.now(), obs],
  });
}
async function seedReport(client, { accountId, passportId, deviceKey }) {
  const id = uniq('rpt');
  await client.execute({
    sql: `INSERT INTO saved_reports
            (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey ?? uniq('dk'), uniq('sub'), 't', new Date().toISOString(), 5, 0, 'Low', '{}', accountId ?? null, passportId ?? null],
  });
  return id;
}

/**
 * Seed a passport BOTH accounts uploaded under (a shared verified passport)
 * and put both authenticated actor rows on its ledger.
 */
async function seedJointPassport(client, passportId, accountA, accountB, { v = 1, revoked = false } = {}) {
  await seedPassport(client, passportId, { v, revoked });
  await seedReport(client, { accountId: accountA, passportId });
  await seedReport(client, { accountId: accountB, passportId });
  await seedActorRow(client, passportId, actorKeyFor(accountA));
  await seedActorRow(client, passportId, actorKeyFor(accountB));
}

async function revokePassport(client, passportId) {
  await client.execute({ sql: 'UPDATE device_passports SET revoked_at = ? WHERE id = ?', args: [Date.now(), passportId] });
}

async function pair(client, prefix = 'acc') {
  const a = uniq(`${prefix}-a`);
  const b = uniq(`${prefix}-b`);
  await ensureUser(client, a, `${a}@e.test`);
  await ensureUser(client, b, `${b}@e.test`);
  return { a, b, emailA: `${a}@e.test`, emailB: `${b}@e.test` };
}

// ===========================================================================
// evidence scenarios
// ===========================================================================

test('1: no shared passport -> assessment NONE, tier NONE, no owner relationship', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const pa = uniq('pp');
  const pb = uniq('pp');
  await seedPassport(client, pa, { v: 1 });
  await seedPassport(client, pb, { v: 1 });
  await seedReport(client, { accountId: a, passportId: pa });
  await seedReport(client, { accountId: b, passportId: pb }); // different device — nothing shared
  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  assert.equal(res.kind, 'found');
  assert.equal(res.result.supportingEvidence.sharedVerifiedPassportCount, 0);
  assert.equal(res.result.supportingEvidence.historicalJointV1ActorPassportCount, 0);
  assert.equal(res.result.supportingEvidence.activeJointV1ActorPassportCount, 0);
  assert.equal(res.result.supportingEvidence.crossPassportSupportingEvidence, false);
  assert.equal(res.result.supportingEvidence.assessment, 'NONE');
  assert.equal(res.result.supportingEvidence.supportBasis, 'NONE');
  assert.equal(res.result.ownerRelationship.state, 'NONE');
  assert.equal(res.result.ownerRelationship.establishedOwnerRelationship, false);
  assert.equal(res.result.interpretation.tier, 'NONE');
});

test('2: one shared passport only -> SUPPORTING_ONLY, never owner, cross-passport evidence false', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  assert.equal(res.kind, 'found');
  const s = res.result.supportingEvidence;
  assert.equal(s.sharedVerifiedPassportCount, 1);
  assert.equal(s.completeTrackedPassportCount, 1);
  assert.equal(s.incompletePassportCount, 0);
  assert.equal(s.historicalJointV1ActorPassportCount, 1);
  assert.equal(s.activeJointV1ActorPassportCount, 1);
  assert.equal(s.revokedJointV1ActorPassportCount, 0);
  assert.equal(s.crossPassportSupportingEvidence, false, 'one joint passport is not cross-passport evidence');
  assert.equal(s.assessment, 'SUPPORTING_ONLY');
  assert.equal(s.supportBasis, 'ACTIVE_DURABLE_LEDGER');
  assert.equal(res.result.ownerRelationship.establishedOwnerRelationship, false);
  assert.equal(res.result.interpretation.tier, 'SUPPORTING');
});

test('3: two fresh v1 joint actor passports -> crossPassportSupportingEvidence true, still SUPPORTING only', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  const s = res.result.supportingEvidence;
  assert.equal(s.sharedVerifiedPassportCount, 2);
  assert.equal(s.completeTrackedPassportCount, 2);
  assert.equal(s.historicalJointV1ActorPassportCount, 2);
  assert.equal(s.activeJointV1ActorPassportCount, 2);
  assert.equal(s.crossPassportSupportingEvidence, true);
  assert.equal(s.assessment, 'SUPPORTING_ONLY');
  assert.equal(s.supportBasis, 'ACTIVE_DURABLE_LEDGER');
  assert.equal(res.result.interpretation.tier, 'SUPPORTING', 'MEDIUM machine evidence is never ESTABLISHED');
  assert.equal(res.result.ownerRelationship.establishedOwnerRelationship, false);
});

test('4: household shape (fan-out = 2 on each joint passport) stays SUPPORTING_ONLY', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const p1 = uniq('pp');
  const p2 = uniq('pp');
  await seedJointPassport(client, p1, a, b, { v: 1 });
  await seedJointPassport(client, p2, a, b, { v: 1 });
  // exactly the two accounts on each device — nobody else
  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  const s = res.result.supportingEvidence;
  assert.equal(s.maxHistoricalAuthenticatedActors, 2, 'two related people, two accounts, two devices — identical to one owner');
  assert.equal(s.maxCurrentReportAccountCount, 2, 'current saved_reports telemetry agrees while the reports exist');
  assert.equal(s.crossPassportSupportingEvidence, true);
  assert.equal(s.assessment, 'SUPPORTING_ONLY');
  assert.equal(s.supportBasis, 'ACTIVE_DURABLE_LEDGER');
  assert.equal(res.result.interpretation.tier, 'SUPPORTING');
  assert.equal(res.result.establishingEvidence.hasEstablishingEvidence, false);
});

test('5: a v0 passport is never durable evidence; a revoked v1 passport is HISTORICAL but not ACTIVE', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 }); // one real joint v1, non-revoked
  await seedJointPassport(client, uniq('pp'), a, b, { v: 0 }); // history-incomplete — never durable
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1, revoked: true }); // v1, revoked -> historical, not active
  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  const s = res.result.supportingEvidence;
  assert.equal(s.sharedVerifiedPassportCount, 3);
  assert.equal(s.completeTrackedPassportCount, 1, 'only the non-revoked v1 counts as complete');
  assert.equal(s.incompletePassportCount, 2, 'the v0 and the revoked v1 are both incomplete/ineligible');
  // the v0 passport is NOT durable evidence at all; the revoked v1 IS historical evidence
  assert.equal(s.historicalJointV1ActorPassportCount, 2, 'the real v1 + the revoked v1 — the v0 is excluded');
  assert.equal(s.activeJointV1ActorPassportCount, 1, 'only the non-revoked v1');
  assert.equal(s.revokedJointV1ActorPassportCount, 1, 'the revoked v1 is not forgotten');
  assert.equal(s.crossPassportSupportingEvidence, false, '1 ACTIVE joint passport is not >= 2');
  assert.equal(s.supportBasis, 'ACTIVE_DURABLE_LEDGER', 'there is still an active non-revoked joint passport');
});

test('6: anonymous activity surfaces only as a boolean, never as identity', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const p = uniq('pp');
  await seedJointPassport(client, p, a, b, { v: 1 });
  await seedReport(client, { accountId: null, passportId: p }); // an anonymous upload under the same device
  await seedActorRow(client, p, '__anonymous__', { anon: true });
  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  assert.equal(res.result.supportingEvidence.anonymousEverSeen, true);
  const dump = JSON.stringify(res.result);
  assert.equal(dump.includes('__anonymous__'), false, 'the anonymous actor sentinel is never echoed');
  assert.match(JSON.stringify(res.result.supportingEvidence.anonymousEverSeen), /true/);
});

test('7: drizzle/0042 absent -> state SCHEMA_ABSENT, no throw, supporting evidence still computed', async () => {
  const client = await freshDb({ upTo: '0042' }); // 0000..0041 only
  const tbl = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='account_owner_links'");
  assert.equal(tbl.rows.length, 0, 'fixture really is pre-0042');
  const { a, b, emailA, emailB } = await pair(client);
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  assert.equal(res.kind, 'found');
  assert.equal(res.result.ownerRelationship.state, 'SCHEMA_ABSENT');
  assert.equal(res.result.supportingEvidence.crossPassportSupportingEvidence, true, 'device-passport evidence works without 0042');
  assert.deepEqual(res.result.ownerRelationship.evidence, []);
  assert.deepEqual(res.result.ownerRelationship.events, []);
  assert.deepEqual(res.result.ownerRelationship.generations, { a: 0, b: 0 });
  assert.equal(res.result.interpretation.tier, 'SUPPORTING');
});

test('8: drizzle/0042 present but OWNER_LINK_HMAC_KEY unavailable -> state KEY_UNAVAILABLE, supporting evidence still reviewable', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  const saved = process.env[OWNER_LINK_HMAC_KEY_ENV];
  delete process.env[OWNER_LINK_HMAC_KEY_ENV];
  try {
    const res = await reviewOwnerEvidence(client, { emailA, emailB });
    assert.equal(res.result.ownerRelationship.state, 'KEY_UNAVAILABLE');
    assert.equal(res.result.supportingEvidence.sharedVerifiedPassportCount, 1);
    assert.equal(res.result.supportingEvidence.assessment, 'SUPPORTING_ONLY');
    assert.deepEqual(res.result.ownerRelationship.evidence, []);
  } finally {
    process.env[OWNER_LINK_HMAC_KEY_ENV] = saved;
  }
});

test('9: an ACTIVE HIGH (ADMIN_MANUAL) link is distinguished from MEDIUM supporting evidence', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 }); // MEDIUM supporting evidence present too
  await upsertOwnerLinkEvidence(client, {
    accountId: a, candidateSourceAccountId: b,
    signalType: 'ADMIN_MANUAL', confidence: 'HIGH',
    evidenceFingerprint: ownerLinkEvidenceFingerprint('ADMIN_MANUAL', ['v1']),
    observedAt: Date.now(), createdBy: 'ADMIN', decidedBy: 'ADMIN',
  });
  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  assert.equal(res.result.ownerRelationship.state, 'ACTIVE');
  assert.equal(res.result.ownerRelationship.strongestConfidence, 'HIGH');
  assert.equal(res.result.ownerRelationship.decidedBy, 'ADMIN');
  assert.equal(res.result.establishingEvidence.liveHighEvidenceRows, 1);
  assert.equal(res.result.establishingEvidence.hasEstablishingEvidence, true);
  assert.equal(res.result.ownerRelationship.establishedOwnerRelationship, true);
  assert.equal(res.result.interpretation.tier, 'ESTABLISHED');
  // the MEDIUM supporting evidence is STILL reported separately and NOT conflated
  assert.equal(res.result.supportingEvidence.assessment, 'SUPPORTING_ONLY');
  assert.equal(res.result.supportingEvidence.sharedVerifiedPassportCount, 1);
  // the established link's own evidence row is HIGH ADMIN_MANUAL, live
  assert.deepEqual(res.result.ownerRelationship.evidence, [
    { signalType: 'ADMIN_MANUAL', confidence: 'HIGH', live: true, observationCount: 1 },
  ]);
  assert.ok(res.result.ownerRelationship.generations.a >= 1);
  assert.ok(res.result.ownerRelationship.generations.b >= 1);
});

test('10: a withdrawn link is reported as WITHDRAWN, not established, with the controlled reason', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const rec = await upsertOwnerLinkEvidence(client, {
    accountId: a, candidateSourceAccountId: b,
    signalType: 'ADMIN_MANUAL', confidence: 'HIGH',
    evidenceFingerprint: ownerLinkEvidenceFingerprint('ADMIN_MANUAL', ['v1']),
    observedAt: Date.now(), createdBy: 'ADMIN', decidedBy: 'ADMIN',
  });
  await withdrawOwnerLink(client, { linkId: rec.linkId, reason: 'ADMIN_CORRECTION', withdrawnAt: Date.now(), decidedBy: 'ADMIN' });
  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  assert.equal(res.result.ownerRelationship.state, 'WITHDRAWN');
  assert.equal(res.result.ownerRelationship.establishedOwnerRelationship, false);
  assert.equal(res.result.ownerRelationship.withdrawnReason, 'ADMIN_CORRECTION');
  assert.equal(res.result.establishingEvidence.liveHighEvidenceRows, 0, 'the HIGH row is tombstoned');
  assert.equal(res.result.interpretation.tier, 'WITHDRAWN');
  // the tombstoned evidence row is still visible, marked not-live
  assert.equal(res.result.ownerRelationship.evidence.length, 1);
  assert.equal(res.result.ownerRelationship.evidence[0].live, false);
});

test('11: the event history is bounded AT THE DB QUERY to the most recent 20 — exactly the latest 20, chronological, older rows excluded', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const fp = ownerLinkEvidenceFingerprint('ADMIN_MANUAL', ['v1']);
  const rec = await upsertOwnerLinkEvidence(client, {
    accountId: a, candidateSourceAccountId: b, signalType: 'ADMIN_MANUAL', confidence: 'HIGH',
    evidenceFingerprint: fp, observedAt: 1_000, createdBy: 'ADMIN', decidedBy: 'ADMIN',
  });
  // many withdraw/reactivate cycles -> well over 20 events, with strictly increasing occurred_at
  let t = 2_000;
  for (let i = 0; i < 15; i += 1) {
    await withdrawOwnerLink(client, { linkId: rec.linkId, reason: 'MANUAL_REVIEW', withdrawnAt: t, decidedBy: 'ADMIN' });
    t += 1_000;
    await upsertOwnerLinkEvidence(client, {
      accountId: a, candidateSourceAccountId: b, signalType: 'ADMIN_MANUAL', confidence: 'HIGH',
      evidenceFingerprint: fp, observedAt: t, createdBy: 'ADMIN', decidedBy: 'ADMIN',
    });
    t += 1_000;
  }
  const allRows = (await client.execute('SELECT id, occurred_at FROM account_owner_link_events ORDER BY id')).rows;
  assert.ok(allRows.length > OWNER_REVIEW_MAX_EVENTS, `sanity: ${allRows.length} events seeded`);
  const expectedLatest = allRows.slice(-OWNER_REVIEW_MAX_EVENTS).map((r) => Number(r.occurred_at));

  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  const events = res.result.ownerRelationship.events;
  assert.equal(events.length, OWNER_REVIEW_MAX_EVENTS, 'exactly 20');
  assert.deepEqual(events.map((e) => e.occurredAt), expectedLatest, 'exactly the latest 20, chronological (oldest-first)');
  // the very first event (LINK_CREATED at occurred_at 1000) is an older row and is excluded
  assert.equal(events.some((e) => e.occurredAt === 1_000), false, 'the oldest LINK_CREATED is excluded');
  // deterministic ordering: occurredAt strictly ascending
  for (let i = 1; i < events.length; i += 1) assert.ok(events[i].occurredAt >= events[i - 1].occurredAt);
});

test('12: same account -> same_account; unknown email -> not_found (no other data leaked)', async () => {
  const client = await freshDb();
  const { a, emailA } = await pair(client);
  void a;
  assert.equal((await reviewOwnerEvidence(client, { emailA, emailB: emailA })).kind, 'same_account');
  const nf = await reviewOwnerEvidence(client, { emailA, emailB: 'nobody-here@e.test' });
  assert.equal(nf.kind, 'not_found');
  assert.deepEqual(Object.keys(nf), ['kind'], 'not_found carries nothing else');
});

test('13: the pair-level co-occurrence query agrees with device-shared-guard\'s report-relative semantics', async () => {
  const client = await freshDb();
  const { a, b } = await pair(client);
  const kA = actorKeyFor(a);
  const kB = actorKeyFor(b);
  // 3 passports where both actors co-occur, 1 where only A appears, 1 where only B
  const joint = [uniq('pp'), uniq('pp'), uniq('pp')];
  for (const p of joint) { await seedPassport(client, p, { v: 1 }); await seedActorRow(client, p, kA); await seedActorRow(client, p, kB); }
  const onlyA = uniq('pp'); await seedPassport(client, onlyA, { v: 1 }); await seedActorRow(client, onlyA, kA);
  const onlyB = uniq('pp'); await seedPassport(client, onlyB, { v: 1 }); await seedActorRow(client, onlyB, kB);

  // the guard's OWN SQL (lib/device-shared-guard.ts pairOtherPassportActorCoOccurrence), inline as the oracle
  const guardOther = async (excludePassportId) => Number((await client.execute({
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT device_passport_id FROM device_passport_actor_usage
            WHERE device_passport_id <> ? AND actor_key_version = 1 AND is_anonymous = 0 AND actor_key IN (?, ?)
            GROUP BY device_passport_id HAVING COUNT(DISTINCT actor_key) >= 2)`,
    args: [excludePassportId, kA, kB],
  })).rows[0].n);

  // the reviewer's pair-level count (no exclusion) — via a review call, then cross-check the invariant
  const res = await reviewOwnerEvidence(client, { emailA: `${a}@e.test`, emailB: `${b}@e.test` });
  // all 3 joint passports are v1 & non-revoked, so historical == active == the full pair-level count here
  const pairLevel = res.result.supportingEvidence.historicalJointV1ActorPassportCount;
  assert.equal(res.result.supportingEvidence.activeJointV1ActorPassportCount, pairLevel);
  assert.equal(pairLevel, 3);

  // INVARIANT: for any passport P that is itself a joint passport, the guard's
  // "other passports" count excluding P is exactly pairLevel - 1.
  for (const p of joint) assert.equal(await guardOther(p), pairLevel - 1, `exclude joint ${p}`);
  // for a passport that is NOT joint, excluding it changes nothing.
  for (const p of [onlyA, onlyB]) assert.equal(await guardOther(p), pairLevel, `exclude non-joint ${p}`);
});

test('14: the result contains no raw identity / provenance values', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const p1 = uniq('pp');
  await seedJointPassport(client, p1, a, b, { v: 1 });
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  const rec = await upsertOwnerLinkEvidence(client, {
    accountId: a, candidateSourceAccountId: b, signalType: 'ADMIN_MANUAL', confidence: 'HIGH',
    evidenceFingerprint: ownerLinkEvidenceFingerprint('ADMIN_MANUAL', ['v1']),
    observedAt: Date.now(), createdBy: 'ADMIN', decidedBy: 'ADMIN',
  });
  const res = await reviewOwnerEvidence(client, { emailA, emailB });
  const dump = JSON.stringify(res.result);
  for (const forbidden of [a, b, emailA, emailB, p1, rec.linkId, actorKeyFor(a), actorKeyFor(b), '@e.test']) {
    assert.equal(dump.includes(forbidden), false, `must not contain ${forbidden.slice(0, 12)}…`);
  }
  // no UUID-shaped strings (link/evidence ids) at all
  assert.doesNotMatch(dump, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  // no 64-hex (actor key / fingerprint / passport id) values
  assert.doesNotMatch(dump, /"[0-9a-f]{64}"/i);
});

// ===========================================================================
// lifecycle regression — DURABLE ledger evidence must not shrink when mutable
// saved_reports state changes (deletion / anonymous-report claim)
// ===========================================================================

/** Snapshot the durable-vs-current supporting fields for a pair. */
async function supporting(client, emailA, emailB) {
  return (await reviewOwnerEvidence(client, { emailA, emailB })).result.supportingEvidence;
}

test('15: deleting every report for the pair does NOT shrink the durable ledger evidence', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  await ensureUser(client, a); await ensureUser(client, b); // (idempotent)
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  // add a third account to one of the joint devices so max fan-out is 3
  const c = uniq('acc-c');
  await ensureUser(client, c);
  const firstPassport = String((await client.execute('SELECT device_passport_id FROM device_passport_actor_usage LIMIT 1')).rows[0].device_passport_id);
  await seedActorRow(client, firstPassport, actorKeyFor(c));
  await seedReport(client, { accountId: c, passportId: firstPassport });

  const before = await supporting(client, emailA, emailB);
  // DURABLE (ledger) — the load-bearing facts
  assert.equal(before.historicalJointV1ActorPassportCount, 2);
  assert.equal(before.activeJointV1ActorPassportCount, 2);
  assert.equal(before.revokedJointV1ActorPassportCount, 0);
  assert.equal(before.crossPassportSupportingEvidence, true);
  assert.equal(before.maxHistoricalAuthenticatedActors, 3);
  assert.equal(before.anonymousEverSeen, false);
  assert.equal(before.assessment, 'SUPPORTING_ONLY');
  assert.equal(before.supportBasis, 'ACTIVE_DURABLE_LEDGER');
  // CURRENT report telemetry — exact starting values (2 shared v1 passports, one carrying a, b, c)
  assert.equal(before.sharedVerifiedPassportCount, 2);
  assert.equal(before.completeTrackedPassportCount, 2);
  assert.equal(before.incompletePassportCount, 0);
  assert.equal(before.maxCurrentReportAccountCount, 3, 'a, b, c all have a report on the first passport');
  assert.equal(before.maxCurrentSubmissionCount, 3);

  // delete ALL report data for a, b AND c (the existing account-scoped helper)
  await deleteAllReportDataForAccount(client, a, { preserveActivelyPromotedRepresentations: true });
  await deleteAllReportDataForAccount(client, b, { preserveActivelyPromotedRepresentations: true });
  await deleteAllReportDataForAccount(client, c, { preserveActivelyPromotedRepresentations: true });
  assert.equal(Number((await client.execute('SELECT COUNT(*) c FROM saved_reports')).rows[0].c), 0, 'all reports gone');
  assert.ok(Number((await client.execute('SELECT COUNT(*) c FROM device_passport_actor_usage')).rows[0].c) >= 5, 'ledger rows intact');

  const after = await supporting(client, emailA, emailB);
  // DURABLE fields — byte-identical
  assert.equal(after.historicalJointV1ActorPassportCount, before.historicalJointV1ActorPassportCount, 'historical count unchanged');
  assert.equal(after.activeJointV1ActorPassportCount, before.activeJointV1ActorPassportCount, 'active count unchanged');
  assert.equal(after.revokedJointV1ActorPassportCount, before.revokedJointV1ActorPassportCount);
  assert.equal(after.crossPassportSupportingEvidence, true, 'still cross-passport supporting evidence');
  assert.equal(after.maxHistoricalAuthenticatedActors, before.maxHistoricalAuthenticatedActors, 'durable fan-out unchanged (still 3)');
  assert.equal(after.anonymousEverSeen, before.anonymousEverSeen);
  assert.equal(after.assessment, 'SUPPORTING_ONLY', 'the review did not become "safer" because reports were deleted');
  assert.equal(after.supportBasis, 'ACTIVE_DURABLE_LEDGER');
  // ALL FIVE current-report fields — deleting a's and b's reports empties the shared set, so every one goes to 0
  assert.equal(after.sharedVerifiedPassportCount, 0);
  assert.equal(after.completeTrackedPassportCount, 0);
  assert.equal(after.incompletePassportCount, 0);
  assert.equal(after.maxCurrentReportAccountCount, 0);
  assert.equal(after.maxCurrentSubmissionCount, 0);
});

test('16: claiming an anonymous report does NOT flip anonymousEverSeen back to false', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const p = uniq('pp');
  await seedJointPassport(client, p, a, b, { v: 1 });
  // an anonymous upload under the same device: a ledger anon row + an anonymous saved_report with a known device_key
  await seedActorRow(client, p, '__anonymous__', { anon: true });
  const anonDeviceKey = uniq('anon-dk');
  await seedReport(client, { accountId: null, passportId: p, deviceKey: anonDeviceKey });

  assert.equal((await supporting(client, emailA, emailB)).anonymousEverSeen, true);

  // a later account claims that device's anonymous reports (the real login/signup side effect)
  const claimer = uniq('acc-claim');
  await ensureUser(client, claimer);
  await claimAnonymousReports(client, claimer, anonDeviceKey);
  assert.equal(Number((await client.execute('SELECT COUNT(*) c FROM saved_reports WHERE user_id IS NULL')).rows[0].c), 0, 'no anonymous saved_reports remain');

  const after = await supporting(client, emailA, emailB);
  assert.equal(after.anonymousEverSeen, true, 'the durable ledger anon row is untouched by the claim');
});

test('17: durable evidence is computed from the ledger alone — no saved_reports required', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const kA = actorKeyFor(a);
  const kB = actorKeyFor(b);
  // two v1 passports with A+B ledger rows and NOT A SINGLE saved_reports row anywhere
  for (const _ of [0, 1]) {
    const p = uniq('pp');
    await seedPassport(client, p, { v: 1 });
    await seedActorRow(client, p, kA);
    await seedActorRow(client, p, kB);
  }
  assert.equal(Number((await client.execute('SELECT COUNT(*) c FROM saved_reports')).rows[0].c), 0);
  const s = await supporting(client, emailA, emailB);
  assert.equal(s.sharedVerifiedPassportCount, 0, 'no current shared-passport signal at all');
  assert.equal(s.historicalJointV1ActorPassportCount, 2, 'the durable ledger still shows the pair on two v1 devices');
  assert.equal(s.activeJointV1ActorPassportCount, 2);
  assert.equal(s.crossPassportSupportingEvidence, true);
  assert.equal(s.maxHistoricalAuthenticatedActors, 2);
  assert.equal(s.assessment, 'SUPPORTING_ONLY');
  assert.equal(s.supportBasis, 'ACTIVE_DURABLE_LEDGER');
});

test('18: with DEVICE_PASSPORT_ACTOR_HMAC_KEY unavailable, durable fields degrade to 0/false — actor membership is never fabricated', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  const saved = process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  delete process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  try {
    const s = await supporting(client, emailA, emailB);
    assert.equal(s.actorLedgerEvidenceAvailable, false);
    assert.equal(s.historicalJointV1ActorPassportCount, 0, 'not fabricated');
    assert.equal(s.activeJointV1ActorPassportCount, 0);
    assert.equal(s.revokedJointV1ActorPassportCount, 0);
    assert.equal(s.crossPassportSupportingEvidence, false);
    assert.equal(s.maxHistoricalAuthenticatedActors, 0);
    assert.equal(s.anonymousEverSeen, false);
    // the current shared-passport signal still shows through so the admin is not blind
    assert.equal(s.sharedVerifiedPassportCount, 2);
    assert.equal(s.assessment, 'SUPPORTING_ONLY');
    assert.equal(s.supportBasis, 'CURRENT_SHARED_PASSPORT_FALLBACK', 'no durable ledger evidence available; only the mutable current signal');
  } finally {
    process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = saved;
  }
});

// ===========================================================================
// revocation lifecycle — HISTORICAL evidence must survive Passport revocation;
// only the CURRENT-eligibility (active) view excludes revoked passports
// ===========================================================================

test('19: A+B on two non-revoked v1 passports -> historical 2, active 2, cross-passport support true', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  const s = await supporting(client, emailA, emailB);
  assert.equal(s.historicalJointV1ActorPassportCount, 2);
  assert.equal(s.activeJointV1ActorPassportCount, 2);
  assert.equal(s.revokedJointV1ActorPassportCount, 0);
  assert.equal(s.crossPassportSupportingEvidence, true);
  assert.equal(s.supportBasis, 'ACTIVE_DURABLE_LEDGER');
});

test('20: [standalone fixture] revoking ONE of two joint passports -> historical stays 2, active becomes 1, revoked becomes 1; historical fan-out (3) / anon still visible', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const p1 = uniq('pp');
  const p2 = uniq('pp');
  await seedJointPassport(client, p1, a, b, { v: 1 });
  await seedJointPassport(client, p2, a, b, { v: 1 });
  // a third account + an anonymous row on p1, so there is historical fan-out / anon to lose
  const c = uniq('acc-c'); await ensureUser(client, c);
  await seedActorRow(client, p1, actorKeyFor(c));
  await seedActorRow(client, p1, '__anonymous__', { anon: true });

  const before = await supporting(client, emailA, emailB);
  assert.equal(before.historicalJointV1ActorPassportCount, 2);
  assert.equal(before.activeJointV1ActorPassportCount, 2);
  assert.equal(before.maxHistoricalAuthenticatedActors, 3);
  assert.equal(before.anonymousEverSeen, true);
  assert.equal(before.crossPassportSupportingEvidence, true);

  await revokePassport(client, p1); // the one carrying the 3rd account + the anon row

  const after = await supporting(client, emailA, emailB);
  assert.equal(after.historicalJointV1ActorPassportCount, 2, 'historical fact preserved — A/B were observed on p1');
  assert.equal(after.activeJointV1ActorPassportCount, 1, 'p1 is no longer valid for a current decision');
  assert.equal(after.revokedJointV1ActorPassportCount, 1);
  assert.equal(after.maxHistoricalAuthenticatedActors, 3, 'the historical household fan-out is NOT erased by revocation');
  assert.equal(after.anonymousEverSeen, true, 'the historical anonymous observation is NOT erased by revocation');
  assert.equal(after.crossPassportSupportingEvidence, false, 'current cross-passport support drops: activeJointV1ActorPassportCount (1) < 2');
  assert.equal(after.supportBasis, 'ACTIVE_DURABLE_LEDGER', 'p2 is still an active non-revoked joint passport');
});

test('21: [standalone fixture — only A+B, no 3rd actor] revoking BOTH joint passports -> historical stays 2, active 0, revoked 2; nothing disappears; no implied current verified support', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  // Deliberately ONLY A and B on each passport (max historical fan-out is 2 here
  // by construction — this is NOT a continuation of test 20's 3-actor fixture).
  const p1 = uniq('pp');
  const p2 = uniq('pp');
  await seedJointPassport(client, p1, a, b, { v: 1 });
  await seedJointPassport(client, p2, a, b, { v: 1 });
  await seedActorRow(client, p1, '__anonymous__', { anon: true });

  await revokePassport(client, p1);
  await revokePassport(client, p2);

  const s = await supporting(client, emailA, emailB);
  assert.equal(s.historicalJointV1ActorPassportCount, 2, 'the durable history is intact');
  assert.equal(s.activeJointV1ActorPassportCount, 0);
  assert.equal(s.revokedJointV1ActorPassportCount, 2);
  assert.equal(s.maxHistoricalAuthenticatedActors, 2, 'this fixture only ever had A and B on each passport');
  assert.equal(s.anonymousEverSeen, true, 'still visible');
  assert.equal(s.crossPassportSupportingEvidence, false, 'no CURRENT verified support is implied');
  assert.equal(s.supportBasis, 'HISTORICAL_ONLY_REVOKED', 'the pair IS on the durable ledger together, but every such passport is revoked');
  assert.equal(s.assessment, 'SUPPORTING_ONLY', 'historical evidence is not called nonexistent');
  // and the reviewer never calls this "same owner" / establishes a link
  const full = (await reviewOwnerEvidence(client, { emailA, emailB })).result;
  assert.equal(full.ownerRelationship.establishedOwnerRelationship, false);
  assert.equal(full.interpretation.tier, 'SUPPORTING');
});

test('21b: [3-actor fixture] the historical maximum survives revoking EVERY joint passport, one after another', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const p1 = uniq('pp');
  const p2 = uniq('pp');
  await seedJointPassport(client, p1, a, b, { v: 1 });
  await seedJointPassport(client, p2, a, b, { v: 1 });
  // p1 additionally carries a THIRD authenticated account and an anonymous row.
  const c = uniq('acc-c'); await ensureUser(client, c);
  await seedActorRow(client, p1, actorKeyFor(c));
  await seedActorRow(client, p1, '__anonymous__', { anon: true });

  const before = await supporting(client, emailA, emailB);
  assert.equal(before.historicalJointV1ActorPassportCount, 2);
  assert.equal(before.maxHistoricalAuthenticatedActors, 3);
  assert.equal(before.anonymousEverSeen, true);
  assert.equal(before.activeJointV1ActorPassportCount, 2);
  assert.equal(before.revokedJointV1ActorPassportCount, 0);
  assert.equal(before.crossPassportSupportingEvidence, true);

  // revoke ONE (the 3-actor / anon one)
  await revokePassport(client, p1);
  const mid = await supporting(client, emailA, emailB);
  assert.equal(mid.historicalJointV1ActorPassportCount, 2, 'historical count unchanged');
  assert.equal(mid.maxHistoricalAuthenticatedActors, 3, 'historical max actors unchanged (still 3)');
  assert.equal(mid.anonymousEverSeen, true, 'historical anon unchanged');
  assert.equal(mid.activeJointV1ActorPassportCount, 1);
  assert.equal(mid.revokedJointV1ActorPassportCount, 1);

  // revoke the SECOND — now every joint passport is revoked
  await revokePassport(client, p2);
  const after = await supporting(client, emailA, emailB);
  assert.equal(after.historicalJointV1ActorPassportCount, 2, 'historical count STILL 2 after revoking the last passport');
  assert.equal(after.maxHistoricalAuthenticatedActors, 3, 'historical max actors STILL 3 — revoking another passport must never reduce it');
  assert.equal(after.anonymousEverSeen, true, 'historical anonymous history STILL visible');
  assert.equal(after.activeJointV1ActorPassportCount, 0);
  assert.equal(after.revokedJointV1ActorPassportCount, 2);
  assert.equal(after.crossPassportSupportingEvidence, false);
  assert.equal(after.supportBasis, 'HISTORICAL_ONLY_REVOKED');
  assert.equal(after.assessment, 'SUPPORTING_ONLY');
});

test('22: report deletion AFTER revocation still does not change the historical ledger metrics; every current-report field is asserted', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const p1 = uniq('pp');
  const p2 = uniq('pp');
  await seedJointPassport(client, p1, a, b, { v: 1 });
  await seedJointPassport(client, p2, a, b, { v: 1 });
  await revokePassport(client, p1);

  const before = await supporting(client, emailA, emailB);
  // exact starting current-report values: p1 revoked (incomplete), p2 active (complete), 2 accounts / 2 reports each
  assert.equal(before.sharedVerifiedPassportCount, 2);
  assert.equal(before.completeTrackedPassportCount, 1, 'p2 (non-revoked v1)');
  assert.equal(before.incompletePassportCount, 1, 'p1 (revoked v1)');
  assert.equal(before.maxCurrentReportAccountCount, 2);
  assert.equal(before.maxCurrentSubmissionCount, 2);

  await deleteAllReportDataForAccount(client, a, { preserveActivelyPromotedRepresentations: true });
  await deleteAllReportDataForAccount(client, b, { preserveActivelyPromotedRepresentations: true });
  assert.equal(Number((await client.execute('SELECT COUNT(*) c FROM saved_reports')).rows[0].c), 0);
  const after = await supporting(client, emailA, emailB);

  // DURABLE ledger fields — byte-identical
  assert.equal(after.historicalJointV1ActorPassportCount, before.historicalJointV1ActorPassportCount);
  assert.equal(after.activeJointV1ActorPassportCount, before.activeJointV1ActorPassportCount);
  assert.equal(after.revokedJointV1ActorPassportCount, before.revokedJointV1ActorPassportCount);
  assert.equal(after.maxHistoricalAuthenticatedActors, before.maxHistoricalAuthenticatedActors);
  assert.equal(after.anonymousEverSeen, before.anonymousEverSeen);
  assert.equal(after.assessment, before.assessment);
  assert.equal(after.supportBasis, before.supportBasis);
  // ALL FIVE current-report fields — deleting a's and b's reports empties the shared set, so every one goes to 0
  assert.equal(after.sharedVerifiedPassportCount, 0);
  assert.equal(after.completeTrackedPassportCount, 0);
  assert.equal(after.incompletePassportCount, 0);
  assert.equal(after.maxCurrentReportAccountCount, 0);
  assert.equal(after.maxCurrentSubmissionCount, 0);
});

test('23: actor-HMAC key unavailable + revoked passports -> still fails closed, never fabricates historical membership', async () => {
  const client = await freshDb();
  const { a, b, emailA, emailB } = await pair(client);
  const p1 = uniq('pp');
  await seedJointPassport(client, p1, a, b, { v: 1 });
  await seedJointPassport(client, uniq('pp'), a, b, { v: 1 });
  await revokePassport(client, p1);
  const saved = process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  delete process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  try {
    const s = await supporting(client, emailA, emailB);
    assert.equal(s.actorLedgerEvidenceAvailable, false);
    assert.equal(s.historicalJointV1ActorPassportCount, 0, 'no historical membership fabricated');
    assert.equal(s.activeJointV1ActorPassportCount, 0);
    assert.equal(s.revokedJointV1ActorPassportCount, 0);
    assert.equal(s.anonymousEverSeen, false);
    assert.equal(s.maxHistoricalAuthenticatedActors, 0);
  } finally {
    process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = saved;
  }
});
