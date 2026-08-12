type RateEntry = { tokens: number; lastRefill: number };

const BUCKETS = new Map<string, RateEntry>();
// Allow 10 requests per minute per client IP by default
const MAX_TOKENS = 10;
const REFILL_INTERVAL_MS = 60_000; // 1 minute

export function checkRate(clientId: string) {
  const now = Date.now();
  const entry = BUCKETS.get(clientId) ?? { tokens: MAX_TOKENS, lastRefill: now };
  // Refill proportionally
  const elapsed = Math.max(0, now - entry.lastRefill);
  const refill = (elapsed / REFILL_INTERVAL_MS) * MAX_TOKENS;
  entry.tokens = Math.min(MAX_TOKENS, entry.tokens + refill);
  entry.lastRefill = now;

  if (entry.tokens >= 1) {
    entry.tokens -= 1;
    BUCKETS.set(clientId, entry);
    return { allowed: true };
  }

  // compute wait seconds until at least one token
  const tokensNeeded = 1 - entry.tokens;
  const waitMs = Math.ceil((tokensNeeded / MAX_TOKENS) * REFILL_INTERVAL_MS);
  BUCKETS.set(clientId, entry);
  return { allowed: false, retryAfter: Math.ceil(waitMs / 1000) };
}

export function resetRateForTest(clientId: string) {
  BUCKETS.delete(clientId);
}

// Stricter, separate bucket for auth endpoints (signup/login), which are a
// more attractive brute-force/enumeration target than the general API.
const AUTH_BUCKETS = new Map<string, RateEntry>();
const AUTH_MAX_TOKENS = 5;

export function checkAuthRate(clientId: string) {
  const now = Date.now();
  const entry = AUTH_BUCKETS.get(clientId) ?? { tokens: AUTH_MAX_TOKENS, lastRefill: now };
  const elapsed = Math.max(0, now - entry.lastRefill);
  const refill = (elapsed / REFILL_INTERVAL_MS) * AUTH_MAX_TOKENS;
  entry.tokens = Math.min(AUTH_MAX_TOKENS, entry.tokens + refill);
  entry.lastRefill = now;

  if (entry.tokens >= 1) {
    entry.tokens -= 1;
    AUTH_BUCKETS.set(clientId, entry);
    return { allowed: true };
  }

  const tokensNeeded = 1 - entry.tokens;
  const waitMs = Math.ceil((tokensNeeded / AUTH_MAX_TOKENS) * REFILL_INTERVAL_MS);
  AUTH_BUCKETS.set(clientId, entry);
  return { allowed: false, retryAfter: Math.ceil(waitMs / 1000) };
}

export function resetAuthRateForTest(clientId: string) {
  AUTH_BUCKETS.delete(clientId);
}
