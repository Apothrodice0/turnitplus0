import { createHmac, timingSafeEqual } from "node:crypto";
import { hashToken } from "./auth-session";

/**
 * Session-bound, non-authority action selectors for the ordinary-user
 * reuse-context flow.
 *
 * The ordinary report response never carries a raw reuse_context_declarations
 * primary key, a document_identity_id, or a matched_representation_id (see
 * lib/reuse-context-report-binding.ts). Instead, each active declaration the
 * viewer may act on is tagged with an `actionRef`: an opaque value the
 * client echoes back on POST /api/reuse-context/{withdraw,confirm,reject},
 * which the route recomputes over its own server-side candidate list to
 * recover the real declaration id.
 *
 *   actionRef = HMAC-SHA256(
 *     key  = hashToken(rawSessionToken)          // == sessions.token_hash
 *     data = "turnitplus:reuse-context-action:v1|" + declarationId
 *   )                                            // lowercase hex, full 256-bit output
 *
 * Properties:
 *   - session-bound: the key is the current session's token hash, so a ref
 *     minted for one session never matches under another (logout / re-login
 *     rotates the token → rotates every ref → stale refs fail closed);
 *   - not precomputable without the session cookie (deriving the key needs
 *     the raw token; SHA-256 preimage resistance);
 *   - no reversible declaration id (HMAC one-way; key-recovery resistant);
 *   - NOT authority — it is only a selector. confirmReuseContext /
 *     revokeReuseContext still independently re-resolve the acting account's
 *     authority (declarer / confirmer / validated original submitter) fresh
 *     on every call. A forged or replayed ref that happens to match a row
 *     the caller is not entitled to act on is rejected there.
 *
 * Reuses the exact pattern app/api/device-passport/challenge/route.ts
 * already uses to bind an ephemeral artifact to the issuing browser session
 * (hashToken(rawSessionCookie), server-side, never in a response or log).
 * No new secret, no new env var, no schema change.
 *
 * The raw session token and its hash are handled only at the route edge and
 * inside this module — they are never returned in a response body and never
 * logged.
 */

const DOMAIN = "turnitplus:reuse-context-action:v1|";

/** Exact 64-lowercase-hex, nothing else. */
export function isWellFormedActionRef(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * The session-bound ref for one declaration id.
 *
 * `sessionKey` must be hashToken(rawSessionToken) — i.e. the value stored in
 * sessions.token_hash. Callers derive it once per request from
 * parseCookie(...) + hashToken(...) and pass it in; this module never reads
 * cookies itself.
 */
export function deriveReuseContextActionRef(sessionKey: string, declarationId: number | bigint): string {
  return createHmac("sha256", sessionKey).update(`${DOMAIN}${String(declarationId)}`, "utf8").digest("hex");
}

/**
 * Constant-time-ish match of a submitted ref against every candidate
 * declaration id, recomputing each candidate's ref under `sessionKey`.
 *
 * Returns the matched declaration id, or null when nothing matches (the
 * route then returns a generic 404). The loop never early-returns, so the
 * response time does not reveal which candidate matched — only how many
 * candidates exist, which the client already knows from its own report
 * response. A malformed submittedRef returns null without any comparison.
 */
export function matchReuseContextActionRef(
  sessionKey: string,
  submittedRef: string,
  candidateIds: Array<number | bigint>,
): number | bigint | null {
  if (!isWellFormedActionRef(submittedRef)) return null;
  const submitted = Buffer.from(submittedRef, "hex");
  let matched: number | bigint | null = null;
  for (const id of candidateIds) {
    const expected = Buffer.from(deriveReuseContextActionRef(sessionKey, id), "hex");
    // Both buffers are always 32 bytes here, so timingSafeEqual never throws.
    if (timingSafeEqual(submitted, expected)) matched = id;
  }
  return matched;
}

/**
 * The session key for a request, or null when there is no usable session.
 *
 * Mirrors app/api/device-passport/challenge/route.ts: a valid session user
 * AND a present raw cookie are both required before any ref is derived.
 * When this returns null the caller must not derive or accept an actionRef
 * (the report builder omits reuseContext; the mutation routes return 401).
 */
export function reuseContextSessionKey(rawSessionToken: string | null, hasValidSession: boolean): string | null {
  if (!hasValidSession || !rawSessionToken) return null;
  return hashToken(rawSessionToken);
}
