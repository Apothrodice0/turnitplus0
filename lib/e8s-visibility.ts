/**
 * Phase E8S Step 6.1: default-off environment gate for the E8S reuse-context
 * routes (app/api/reuse-context/*), deliberately mirroring
 * lib/e8p-visibility.ts's own E8P_VISIBILITY_ALLOWLIST pattern exactly —
 * same re-parse-every-call discipline, same Set-based exact membership,
 * same "unset/empty means nobody" default. E8S_REUSE_CONTEXT_ALLOWLIST
 * unset or empty means the allowlist is empty, which means
 * isE8sReuseContextAllowlisted() returns false for every account — this is
 * simultaneously the default-OFF behavior and the rollback switch:
 * clearing this one environment variable turns every E8S route off for
 * everyone, with no code change, no database change, no redeploy needed
 * for the change to take effect (nothing here is cached at module scope).
 *
 * This is an ADDITIONAL gate layered on top of, never a replacement for,
 * each route's own existing session-authorization checks (getSessionUser,
 * ownership validation via lib/reuse-context-declarations.ts's own
 * server-side checks) — see each route's own header comment. A
 * non-allowlisted, authenticated caller must never be able to distinguish
 * "not allowlisted" from "this match pair/declaration doesn't exist" — see
 * each route's identical generic 404 response for both.
 */

function parseAllowlist(): Set<string> {
  const raw = process.env.E8S_REUSE_CONTEXT_ALLOWLIST;
  if (!raw) return new Set();
  return new Set(
    raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0),
  );
}

/** Re-parses the environment on every call (no module-level caching) so an env var change takes effect on the next request without a redeploy. */
export function isE8sReuseContextAllowlisted(accountId: string | null): boolean {
  if (accountId === null) return false;
  return parseAllowlist().has(accountId);
}
