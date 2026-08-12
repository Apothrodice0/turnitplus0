import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import { findReportRowForDeviceKey, findReportRowForUser } from '../lib/reports-repo.ts';

// Real functional coverage (not source-text wiring) for the query logic
// shared between GET /api/reports/[id] and the new /reports/[id] page's
// server-side session lookup — the first genuinely new server-side logic
// introduced for the saved-report detail page.

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_reports_repo.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, drizzleDir);

await client.execute({
  sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
  args: ['repo-user-1', 'repo-test-1@example.com', 'repouser1', 'hash'],
});
await client.execute({
  sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
  args: ['repo-user-2', 'repo-test-2@example.com', 'repouser2', 'hash'],
});

async function insertReport({ id, deviceKey, userId = null, updatedAt, payload }) {
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey, `sub-${id}`, `${id}.pdf`, new Date().toISOString(), 10, 1, 'Low', JSON.stringify(payload), userId, updatedAt],
  });
}

test('findReportRowForUser returns undefined when nothing matches', async () => {
  const row = await findReportRowForUser(client, 'missing-id', 'repo-user-1');
  assert.equal(row, undefined);
});

test('findReportRowForUser scopes strictly to the given user_id', async () => {
  await insertReport({ id: 'report-a', deviceKey: 'device-a', userId: 'repo-user-1', updatedAt: '2026-01-01T00:00:00.000Z', payload: { marker: 'A' } });

  const owner = await findReportRowForUser(client, 'report-a', 'repo-user-1');
  assert.ok(owner);
  assert.deepEqual(JSON.parse(owner.payload_json), { marker: 'A' });

  const otherUser = await findReportRowForUser(client, 'report-a', 'repo-user-2');
  assert.equal(otherUser, undefined, 'a report must never resolve for a user_id that does not own it');
});

test('findReportRowForUser resolves a same-id collision across two of one account\'s devices via ORDER BY updated_at DESC', async () => {
  // id alone is only unique per (device_key, id) at the schema level (the
  // composite PK) — two devices on the same account can produce identical
  // client-generated ids. The route comment calls out resolving this
  // deterministically rather than returning an arbitrary row.
  await insertReport({ id: 'collide-1', deviceKey: 'device-x', userId: 'repo-user-1', updatedAt: '2026-01-01T00:00:00.000Z', payload: { marker: 'older' } });
  await insertReport({ id: 'collide-1', deviceKey: 'device-y', userId: 'repo-user-1', updatedAt: '2026-01-02T00:00:00.000Z', payload: { marker: 'newer' } });

  const row = await findReportRowForUser(client, 'collide-1', 'repo-user-1');
  assert.deepEqual(JSON.parse(row.payload_json), { marker: 'newer' }, 'must deterministically pick the most recently updated row, not an arbitrary one');
});

test('findReportRowForDeviceKey finds an anonymous, unclaimed report', async () => {
  await insertReport({ id: 'anon-report', deviceKey: 'anon-device', updatedAt: '2026-01-01T00:00:00.000Z', payload: { marker: 'anon' } });

  const row = await findReportRowForDeviceKey(client, 'anon-report', 'anon-device');
  assert.ok(row);
  assert.deepEqual(JSON.parse(row.payload_json), { marker: 'anon' });
});

test('findReportRowForDeviceKey scopes strictly to the given device_key', async () => {
  const wrongDevice = await findReportRowForDeviceKey(client, 'anon-report', 'someone-elses-device');
  assert.equal(wrongDevice, undefined);
});

test('findReportRowForDeviceKey never returns a report once claimed by an account, even from the original saving device', async () => {
  // report-a was inserted above with user_id already set — mirrors what
  // claimAnonymousReports does on login/signup. The device_key path must
  // treat it as gone, by design (see lib/auth-session.ts).
  const row = await findReportRowForDeviceKey(client, 'report-a', 'device-a');
  assert.equal(row, undefined, 'a claimed report must be invisible via its raw device_key');
});

test.after(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
