import path from 'path';
import { createClient } from '@libsql/client';

/**
 * Connection for the saved_reports/users/sessions tables. Requires
 * TURSO_DATABASE_URL/TURSO_AUTH_TOKEN in production, same as the ingest
 * pipeline. Falls back to a local libsql file for `next dev`/tests when
 * TURSO_DATABASE_URL is unset — no local write is attempted against a
 * remote target without an auth token.
 *
 * Enables PRAGMA foreign_keys explicitly: libSQL connections don't reliably
 * default it on the way better-sqlite3's ingest path already does (see
 * lib/ingest.ts), and without it the ON DELETE CASCADE/SET NULL foreign keys
 * on sessions/saved_reports.user_id would silently not fire.
 *
 * Deliberately does NOT set PRAGMA busy_timeout: measured directly (this
 * codebase's own concurrent-write race — see app/api/reports/route.ts's
 * insertReportWithRoomCheck), it added no real protection against
 * SQLITE_BUSY on this local-file libSQL driver (a losing concurrent write
 * transaction still failed immediately, busy_timeout set or not — only
 * retrying with a fresh connection actually recovers it) while measurably
 * slowing down every sequential connection open under real test load
 * (roughly 4x on tests/upload-limit.test.mjs, ~4s -> ~17s). The real fix for
 * that race lives entirely in insertReportWithRoomCheck's own retry loop.
 */
export async function getReportsDbClient() {
  const url = process.env.TURSO_DATABASE_URL ?? `file:${path.join(process.cwd(), 'data', 'reports-dev.db')}`;
  const isLocalFile = url.startsWith('file:');
  const authToken = isLocalFile ? undefined : process.env.TURSO_AUTH_TOKEN;
  if (!isLocalFile && !authToken) {
    throw new Error('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points at a remote database.');
  }
  const client = createClient({ url, authToken });
  await client.execute('PRAGMA foreign_keys = ON');
  return client;
}
