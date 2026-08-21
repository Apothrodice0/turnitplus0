import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import {
  SESSION_COOKIE_NAME,
  createSession,
  getSessionUser,
  getSessionUserByToken,
} from '../lib/auth-session.ts';

// getSessionUserByToken was split out of getSessionUser so the new
// /reports/[id] Server Component (which reads cookies via next/headers, not
// a Request object) can resolve a session without fabricating a fake
// Request. This verifies the split is behavior-preserving: same lookup
// logic, same expiry handling, and getSessionUser (still used by every
// existing Request-based route handler) produces identical results.

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_auth_session_token.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, drizzleDir);

await client.execute({
  sql: 'INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)',
  args: ['token-user-1', 'token-test@example.com', 'tokenuser', 'hash'],
});

test('getSessionUserByToken returns null for a null token, without querying the database', async () => {
  const user = await getSessionUserByToken(null, client);
  assert.equal(user, null);
});

test('getSessionUserByToken returns null for a garbage/unknown token', async () => {
  const user = await getSessionUserByToken('this-token-was-never-issued', client);
  assert.equal(user, null);
});

test('getSessionUserByToken resolves a real session to its user', async () => {
  const token = await createSession(client, 'token-user-1');
  const user = await getSessionUserByToken(token, client);
  assert.deepEqual(user, { id: 'token-user-1', username: 'tokenuser', email: 'token-test@example.com', corpusReuseConsented: false, role: 'user' });
});

test('getSessionUserByToken rejects and deletes an expired session', async () => {
  const expiredToken = 'expired-raw-token-value';
  const tokenHash = createHash('sha256').update(expiredToken, 'utf8').digest('hex');
  await client.execute({
    sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    args: [tokenHash, 'token-user-1', Date.now() - 10_000, Date.now() - 1_000],
  });

  const user = await getSessionUserByToken(expiredToken, client);
  assert.equal(user, null);

  const remaining = await client.execute({ sql: 'SELECT 1 FROM sessions WHERE token_hash = ?', args: [tokenHash] });
  assert.equal(remaining.rows.length, 0, 'an expired session row must be deleted on lookup, not just ignored');
});

test('getSessionUser (Request-based) produces identical output to getSessionUserByToken for the same cookie', async () => {
  const token = await createSession(client, 'token-user-1');

  const byToken = await getSessionUserByToken(token, client);
  const request = new Request('http://localhost/', { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });
  const byRequest = await getSessionUser(request, client);

  assert.deepEqual(byRequest, byToken);
});

test('getSessionUser returns null when no cookie header is present', async () => {
  const request = new Request('http://localhost/');
  const user = await getSessionUser(request, client);
  assert.equal(user, null);
});

test.after(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
