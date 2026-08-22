import { createClient } from "@libsql/client";
import { getReportsDbClient } from "./reports-db";

/**
 * Durable, distributed rate limiting (production audit fix). Replaces the
 * previous in-memory Map-based token buckets, which provided no real
 * protection on Vercel serverless: each concurrent or cold-started instance
 * has its own empty Map, so the limit effectively never triggered in
 * production (verified empirically — 12+ rapid requests against a 10/min
 * route never returned 429). State now lives in the same Turso database
 * every other route already uses (see lib/reports-db.ts) — one shared
 * `rate_limit_buckets` table, namespaced bucket keys ("general:<id>" for
 * checkRate, "auth:<id>" for checkAuthRate) so the two limiters never share
 * a bucket for the same client, matching the old two-separate-Maps
 * behavior exactly. See drizzle/0024_rate_limit_buckets.sql for the schema.
 *
 * checkRate/checkAuthRate's call sites, return shape ({allowed:true} |
 * {allowed:false, retryAfter}), and both limits (10/min general, 5/min
 * auth) are unchanged — the only externally-visible difference is that
 * both functions are now async (a durable check requires a network round
 * trip; there is no way to make cross-instance state durable without one).
 *
 * Rate-limit architecture (production bug fix): checkRate ("general") is
 * now scoped specifically to strict/abuse-sensitive traffic — uploads,
 * account mutations, destructive operations — never to ordinary
 * authenticated browsing. It used to also gate every room/report page
 * load and My Reports' own supporting reads (session check, upload-quota
 * display, the room index), so a completely normal browsing session
 * (open My Reports, click into a few rooms, go back, open another) could
 * exhaust the SAME 10-token budget an upload or a destructive action
 * depends on — a real user doing nothing abusive would see "you've made a
 * lot of requests" from simply clicking around. checkReadRate exists
 * specifically for that traffic: a much more generous, separate bucket for
 * read-only, session-scoped navigation (see its own comment below for the
 * exact routes). checkPollRate (see its own comment) remains its own third,
 * separate bucket for the room page's AI-status polling specifically.
 * These three buckets are never shared, by construction (three distinct
 * bucket-key namespaces) — draining any one has no effect on the others.
 *
 * Atomicity: the entire refill-then-maybe-consume decision happens in ONE
 * SQL statement (an INSERT ... ON CONFLICT DO UPDATE), so two concurrent
 * requests for the same bucket_key can never both observe "1 token left"
 * and both consume it — SQLite/libSQL serializes writes to the same row,
 * so the second statement always sees the first's already-decremented
 * state. See checkBucket()'s own comment for why the SQL looks the way it
 * does (in particular, why `last_allowed` is a real stored column instead
 * of a RETURNING-computed expression).
 */

const GENERAL_MAX_TOKENS = 10;
const GENERAL_INTERVAL_MS = 60_000;
const AUTH_MAX_TOKENS = 5;
const AUTH_INTERVAL_MS = 60_000;

// This app has no background-job/cron infrastructure (see
// lib/run-after-response.ts's own header comment), so bounded cleanup is
// piggybacked on normal traffic instead of a scheduled job: a small,
// low-probability chance per check to delete a bounded batch of buckets
// nobody has touched in a long time. 24h is many multiples of either
// refill interval, so a "stale" bucket is unambiguously cold, not just
// between requests; a client that returns later simply starts a fresh
// full bucket, functionally identical to the row never having been
// evicted. LIMIT bounds each individual cleanup's cost regardless of how
// large the table has grown, so this can never turn into an unbounded
// table-scan/delete under heavy accumulated staleness.
const CLEANUP_PROBABILITY = 0.02;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_LIMIT = 200;

// Repeated three times inside checkBucket()'s single UPSERT statement (see
// that function's own comment for why) — defined once here, alongside the
// exact argument order it needs, so the three call sites can never drift
// out of sync with each other.
const REFILLED_TOKENS_EXPR =
  "MIN(?, rate_limit_buckets.tokens + (CAST(? AS REAL) - rate_limit_buckets.last_refill) * ? / ?)";
function refilledTokensArgs(maxTokens: number, now: number, intervalMs: number): number[] {
  return [maxTokens, now, maxTokens, intervalMs];
}

export type RateCheckResult = { allowed: true } | { allowed: false; retryAfter: number };

/**
 * Resolves the same shared Turso database every other route already uses
 * (see lib/reports-db.ts) — in production this is always the case, since
 * TURSO_DATABASE_URL is one deployment-wide variable read identically by
 * lib/ingest.ts and lib/reports-db.ts. The only exception is
 * RATE_LIMIT_TEST_DB_URL, a narrow test-only escape hatch: tests/api-ingest.
 * test.mjs deliberately unsets TURSO_DATABASE_URL to exercise /api/ingest's
 * own separate local-file fallback (lib/ingest.ts's better-sqlite3 path),
 * and that must not be affected by wherever the rate limiter itself
 * persists state. No real caller — production or any other test file —
 * ever sets this; they all share getReportsDbClient()'s own resolution.
 */
async function getRateLimitDbClient() {
  const override = process.env.RATE_LIMIT_TEST_DB_URL;
  if (override) {
    const client = createClient({ url: override });
    await client.execute("PRAGMA foreign_keys = ON");
    return client;
  }
  return getReportsDbClient();
}

async function maybeCleanupStaleBuckets(client: Awaited<ReturnType<typeof getReportsDbClient>>): Promise<void> {
  if (Math.random() >= CLEANUP_PROBABILITY) return;
  try {
    await client.execute({
      sql: `DELETE FROM rate_limit_buckets WHERE bucket_key IN (
              SELECT bucket_key FROM rate_limit_buckets WHERE last_refill < ? LIMIT ?
            )`,
      args: [Date.now() - STALE_AFTER_MS, CLEANUP_BATCH_LIMIT],
    });
  } catch (err) {
    // Best-effort only — a failed cleanup must never affect the rate-limit
    // decision it happened to ride along with.
    console.error("rate-limit cleanup failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

/**
 * The shared core behind checkRate/checkAuthRate. `bucketKey` is already
 * namespaced by the caller (e.g. "general:1.2.3.4").
 *
 * Single atomic statement: an UPSERT that always (a) creates a fresh, full
 * bucket on first-ever use, or (b) refills the existing bucket proportional
 * to elapsed time (clamped to maxTokens), then conditionally consumes one
 * token if the refilled amount is >= 1 — the exact arithmetic the old
 * in-memory version used, just expressed in SQL instead of JS so it can run
 * atomically against a shared row instead of a private in-process Map.
 *
 * `last_allowed` is a real, persisted column (not something re-derived
 * after the fact) because the final `tokens` value alone is genuinely
 * ambiguous between the two branches: an allowed check can leave tokens
 * anywhere in [0, maxTokens-1], and a rejected check leaves tokens anywhere
 * in [0, 1) — those ranges overlap, so "tokens < 1" cannot reliably tell you
 * which branch fired. Writing the CASE result to its own column inside the
 * same SET clause (evaluated against the pre-update row, like every other
 * expression in a SET clause) and then RETURNING that column sidesteps the
 * ambiguity entirely — RETURNING a plain column always reflects exactly
 * what was just written to it.
 */
async function checkBucket(
  bucketKey: string,
  maxTokens: number,
  intervalMs: number,
): Promise<RateCheckResult> {
  const client = await getRateLimitDbClient();
  try {
    const now = Date.now();
    const sql = `
      INSERT INTO rate_limit_buckets (bucket_key, tokens, last_refill, last_allowed)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(bucket_key) DO UPDATE SET
        last_allowed = CASE WHEN ${REFILLED_TOKENS_EXPR} >= 1.0 THEN 1 ELSE 0 END,
        tokens = ${REFILLED_TOKENS_EXPR} - CASE WHEN ${REFILLED_TOKENS_EXPR} >= 1.0 THEN 1.0 ELSE 0.0 END,
        last_refill = ?
      RETURNING tokens, last_allowed
    `;
    const args = [
      bucketKey, maxTokens - 1, now, // VALUES (fresh bucket: starts full, minus the token this check consumes)
      ...refilledTokensArgs(maxTokens, now, intervalMs), // last_allowed CASE
      ...refilledTokensArgs(maxTokens, now, intervalMs), // tokens main term
      ...refilledTokensArgs(maxTokens, now, intervalMs), // tokens CASE subtraction
      now, // last_refill = ?
    ];

    const result = await client.execute({ sql, args });
    const row = result.rows[0] as unknown as { tokens: number; last_allowed: number | bigint };

    await maybeCleanupStaleBuckets(client);

    if (Number(row.last_allowed) === 1) {
      return { allowed: true };
    }

    // Rejected: the SET clause's subtraction term was 0 in this branch, so
    // the returned `tokens` equals the refilled (pre-consumption) amount —
    // exactly the value the old in-memory version's retryAfter formula
    // already used.
    const tokensNeeded = 1 - Number(row.tokens);
    const waitMs = Math.ceil((tokensNeeded / maxTokens) * intervalMs);
    return { allowed: false, retryAfter: Math.ceil(waitMs / 1000) };
  } finally {
    client.close();
  }
}

async function resetBucketForTest(bucketKey: string): Promise<void> {
  const client = await getRateLimitDbClient();
  try {
    await client.execute({ sql: "DELETE FROM rate_limit_buckets WHERE bucket_key = ?", args: [bucketKey] });
  } finally {
    client.close();
  }
}

export async function checkRate(clientId: string): Promise<RateCheckResult> {
  return checkBucket(`general:${clientId}`, GENERAL_MAX_TOKENS, GENERAL_INTERVAL_MS);
}

export async function resetRateForTest(clientId: string): Promise<void> {
  await resetBucketForTest(`general:${clientId}`);
}

// Stricter, separate bucket for auth endpoints (signup/login), which are a
// more attractive brute-force/enumeration target than the general API.
export async function checkAuthRate(clientId: string): Promise<RateCheckResult> {
  return checkBucket(`auth:${clientId}`, AUTH_MAX_TOKENS, AUTH_INTERVAL_MS);
}

export async function resetAuthRateForTest(clientId: string): Promise<void> {
  await resetBucketForTest(`auth:${clientId}`);
}

// Separate, more generous bucket specifically for read-only room/report
// STATUS polling (app/reports/rooms/[room]/room-page-shell.tsx's own
// 3-second interval while a check is "processing" — production bug fix).
// Sharing the general bucket meant a normal poll window (up to
// MAX_POLL_ATTEMPTS requests) could exhaust the SAME budget "Open full
// report" and every other ordinary browsing/upload/auth action on this
// account also draws from, blocking unrelated requests purely as a side
// effect of watching one room finish. 30/min comfortably covers a full poll
// window with real headroom, while still bounding a runaway/misbehaving
// client — this is not "no rate limit," just one sized for its own traffic
// pattern instead of sharing a budget meant for something else.
const POLL_MAX_TOKENS = 30;
const POLL_INTERVAL_MS = 60_000;

export async function checkPollRate(clientId: string): Promise<RateCheckResult> {
  return checkBucket(`poll:${clientId}`, POLL_MAX_TOKENS, POLL_INTERVAL_MS);
}

export async function resetPollRateForTest(clientId: string): Promise<void> {
  await resetBucketForTest(`poll:${clientId}`);
}

// Separate, generous bucket for ordinary authenticated read/navigation
// traffic — the room index, a single room's contents, a full report page
// load, session/account checks, upload-quota display (production bug fix).
// These are not polling (see checkPollRate above) and not abuse-sensitive
// writes (see checkRate/checkAuthRate) — they're what a normal user
// generates just by clicking around: My Reports -> a room -> back -> a
// different room -> back -> another room. Sharing the general bucket meant
// that ordinary sequence alone (session check + upload-quota + room index +
// one page-load token per room click) could exhaust the SAME 10-token/min
// budget an upload or a destructive action depends on, producing a false
// "you've made a lot of requests" for a user who did nothing abusive. 60/min
// comfortably covers realistic browsing with real headroom, while still
// bounding a genuinely runaway client — sized for read/navigation traffic's
// own pattern, not borrowed from a budget meant for writes.
const READ_MAX_TOKENS = 60;
const READ_INTERVAL_MS = 60_000;

export async function checkReadRate(clientId: string): Promise<RateCheckResult> {
  return checkBucket(`read:${clientId}`, READ_MAX_TOKENS, READ_INTERVAL_MS);
}

export async function resetReadRateForTest(clientId: string): Promise<void> {
  await resetBucketForTest(`read:${clientId}`);
}

// Dedicated bucket for /api/admin/corpus/* (the corpus-admission admin
// dashboard) — every route there is already admin-gated (getAdminSessionUser,
// 404 for anyone else), so this is not abuse-prevention for the general
// public the way checkAuthRate is; it bounds a compromised/misbehaving admin
// session or a runaway dashboard client, sized generously enough that real
// review work (browsing pages, opening several detail views, occasionally
// deactivating/reactivating or revealing a preview) never trips it. Kept as
// its own bucket rather than sharing checkReadRate/checkRate — those are
// sized and reasoned about for ordinary-user traffic patterns, a
// semantically different population from admin oversight traffic.
const ADMIN_MAX_TOKENS = 30;
const ADMIN_INTERVAL_MS = 60_000;

export async function checkAdminRate(clientId: string): Promise<RateCheckResult> {
  return checkBucket(`admin:${clientId}`, ADMIN_MAX_TOKENS, ADMIN_INTERVAL_MS);
}

export async function resetAdminRateForTest(clientId: string): Promise<void> {
  await resetBucketForTest(`admin:${clientId}`);
}
