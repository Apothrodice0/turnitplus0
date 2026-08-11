import path from 'path';
import { createClient } from '@libsql/client';

/**
 * Connection for the saved_reports table (Phase 1 persistent reports).
 * Requires TURSO_DATABASE_URL/TURSO_AUTH_TOKEN in production, same as the
 * ingest pipeline. Falls back to a local libsql file for `next dev`/tests
 * when TURSO_DATABASE_URL is unset — no local write is attempted against a
 * remote target without an auth token.
 */
export function getReportsDbClient() {
  const url = process.env.TURSO_DATABASE_URL ?? `file:${path.join(process.cwd(), 'data', 'reports-dev.db')}`;
  const isLocalFile = url.startsWith('file:');
  const authToken = isLocalFile ? undefined : process.env.TURSO_AUTH_TOKEN;
  if (!isLocalFile && !authToken) {
    throw new Error('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points at a remote database.');
  }
  return createClient({ url, authToken });
}
