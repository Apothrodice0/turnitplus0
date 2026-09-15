import path from 'path';
import { createClient } from '@libsql/client';

/**
 * Release-hardening audit finding (DB transport-timeout audit): @libsql/client's
 * public execute()/batch()/transaction() surface exposes no per-query
 * AbortSignal at all — the only supported cancellation injection point is a
 * custom `fetch` supplied at createClient() construction time (config.fetch,
 * verified against the installed @libsql/client@0.17.4 + @libsql/hrana-client
 * source: `this.#fetch = customFetch ?? globalThis.fetch`, called as either
 * `fetch(request)` — a single Request object, hrana's own per-query shape —
 * or the standard `fetch(input, init)`). With no fetch supplied (today's
 * default, unchanged for every caller that omits requestTimeoutMs below), a
 * stalled HTTP request to Turso is bounded only by Node's own built-in
 * global fetch/undici defaults — unproven for this exact runtime, but
 * structurally the same class of risk the closed Selective Corpus Blob
 * storage adapter's get()/head() work addressed for its own SDK.
 *
 * The timeout is `AbortSignal.timeout(timeoutMs)`, one fresh instance per
 * underlying fetch call — deliberately NOT a manually-disarmed timer. A
 * manual timer that gets cancelled the moment `baseFetch()` itself resolves
 * only bounds the time until then (i.e. until response headers arrive);
 * hrana-client's real per-query path (node_modules/@libsql/hrana-client's
 * HttpStream#flush) consumes the response body — `resp.json()`/
 * `resp.arrayBuffer()`/`resp.text()` — in a SEPARATE, LATER `.then()`
 * callback, after that fetch promise has already settled. Cancelling the
 * timer at that point disarms it before body consumption ever starts,
 * leaving a stalled body unbounded. `AbortSignal.timeout()`'s signal is
 * never cancelled here, so it stays capable of firing for as long as
 * anything still references it — including through body consumption.
 * `AbortSignal.any([...])` composes it with a caller-supplied signal (if the
 * Request/init already carries one — none of @libsql/client's own call
 * sites do today, but a future version or a different caller might), so
 * neither can silently suppress the other. Unlike the closed Selective
 * Corpus Blob storage adapter's head() case, this is safe: @libsql/client /
 * @libsql/hrana-client has no retry loop that treats a "TimeoutError"-named
 * abort differently from any other rejection, so there is no risk of a
 * TimeoutError being misread as retryable and retried in a loop. Both
 * `AbortSignal.timeout` and `AbortSignal.any` have been stable Node.js
 * globals since v20.3.0 (Node 22, this project's pinned runtime — see
 * package.json's "engines" — includes them unmodified).
 */
export function createTimeoutFetch(timeoutMs: number, baseFetch: typeof fetch = fetch): typeof fetch {
  return async function timeoutFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const existingSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = existingSignal ? AbortSignal.any([existingSignal, timeoutSignal]) : timeoutSignal;
    // hrana-client's real per-query call shape is `fetch(request)` — a
    // single Request object, no separate init. Request's own copy
    // constructor (`new Request(existingRequest, overrides)`) is the only
    // way to attach our composed signal to it without losing its method/
    // headers/body; the (input, init) branch below covers every other
    // caller shape (including this module's own tests).
    if (input instanceof Request && init === undefined) {
      return await baseFetch(new Request(input, { signal }));
    }
    return await baseFetch(input, { ...init, signal });
  };
}

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
 *
 * `requestTimeoutMs` — opt-in only, default behavior (option omitted)
 * unchanged from before this audit finding: no fetch option is passed to
 * createClient(), exactly as every existing caller already gets. Passing it
 * supplies `createTimeoutFetch(requestTimeoutMs)` as createClient()'s own
 * `fetch`, bounding every underlying HTTP request this ONE client instance
 * makes (including this function's own PRAGMA statement) — never a global
 * default, never env-configurable, never applied to a caller that doesn't
 * explicitly ask for it.
 */
export async function getReportsDbClient(options?: { requestTimeoutMs?: number }) {
  const url = process.env.TURSO_DATABASE_URL ?? `file:${path.join(process.cwd(), 'data', 'reports-dev.db')}`;
  const isLocalFile = url.startsWith('file:');
  const authToken = isLocalFile ? undefined : process.env.TURSO_AUTH_TOKEN;
  if (!isLocalFile && !authToken) {
    throw new Error('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points at a remote database.');
  }
  const client =
    options?.requestTimeoutMs !== undefined
      ? createClient({ url, authToken, fetch: createTimeoutFetch(options.requestTimeoutMs) })
      : createClient({ url, authToken });
  await client.execute('PRAGMA foreign_keys = ON');
  return client;
}
