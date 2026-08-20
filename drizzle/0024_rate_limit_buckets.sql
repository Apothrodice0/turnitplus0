-- Durable, distributed rate limiting (production audit fix): replaces
-- lib/rate-limit.ts's in-memory Map-based token buckets, which provide no
-- real protection on Vercel serverless (each concurrent/cold-started
-- instance has its own empty Map — verified empirically: 12+ rapid
-- requests against a 10/min-limited route never returned 429 in
-- production). One shared table backs both checkRate (general routes) and
-- checkAuthRate (login/signup) — bucket_key is namespaced ("general:<id>"
-- vs "auth:<id>") so the two limiters never share a bucket for the same
-- client, matching today's two-separate-Maps behavior exactly.
--
-- tokens/last_refill hold the same token-bucket state the in-memory
-- version did (current token count, and the timestamp refill is computed
-- from) — tokens is REAL because refill is proportional/fractional, not
-- integer, exactly like the current entry.tokens arithmetic.
--
-- last_allowed is bookkeeping only: lib/rate-limit.ts's single atomic
-- UPSERT statement needs to report back "was this specific check allowed
-- or not" without a second round trip, and the final `tokens` value alone
-- is ambiguous between the allowed and rejected branches (both can end in
-- the same sub-1 range) — see that file's own header comment for the full
-- explanation. Not used for anything else.
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY NOT NULL,
  tokens REAL NOT NULL,
  last_refill INTEGER NOT NULL,
  last_allowed INTEGER NOT NULL
);

-- Supports the opportunistic stale-row cleanup in lib/rate-limit.ts (a
-- bounded, low-probability DELETE of buckets untouched for a long time —
-- this app has no background-job/cron infrastructure, see
-- lib/run-after-response.ts's own header comment, so cleanup is piggybacked
-- on normal traffic instead of a scheduled job) — without this index that
-- DELETE's WHERE last_refill < ? would be a full table scan.
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_last_refill ON rate_limit_buckets(last_refill);
