/**
 * ASJP matching service wire protocol v2 (Phase 7 remediation, review findings A1 / A2) — shared by the report client
 * (lib/asjp-report-evidence.ts) and the service (services/asjp-matching/server.ts). Server-only (node:crypto).
 *
 * REQUEST  every /attest and /match request carries x-asjp-timestamp (13-digit ms), x-asjp-nonce (32 hex, single use)
 *          and x-asjp-signature = HMAC-SHA256(key, "asjp-v2-request\n<METHOD>\n<path>\n<host>\n<ts>\n<nonce>\n<sha256(raw body bytes)>").
 *          The HOST is the one the client called and the service received (Host header), so a signed request relayed
 *          to another hostname never verifies.
 * RESPONSE every answer to a verified request carries x-asjp-response-signature = HMAC-SHA256(key,
 *          "asjp-v2-response\n<request nonce>\n<host>\n<sha256(request body)>\n<HTTP status>\n<sha256(raw response bytes)>"),
 *          so an answer is bound to THIS request (nonce), THIS manuscript (request body digest) and THIS hostname, and a
 *          recorded or forged answer never verifies.
 * ATTEST   before a manuscript or the bearer token is sent, the client asks POST /attest (signed, no bearer, no
 *          manuscript) and requires a valid response signature: an endpoint that does not hold the key — an expired
 *          quick-tunnel hostname now held by someone else — never receives the manuscript or the bearer token.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ASJP_PROTOCOL_VERSION = "asjp-v2";
/** Minimum length of every service credential (bearer token, admin token, request-signing key). */
export const ASJP_CREDENTIAL_MIN_LENGTH = 32;
/** An answer larger than this is refused unread (the persisted record itself is capped at 256 KB). */
export const ASJP_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/**
 * Why a credential is too weak to use, or null. Required: >= 32 characters, no whitespace, and at least 12 distinct
 * characters (a hex / base64 value from a CSPRNG has ~16 / ~40; a repeated or dictionary-like value does not).
 */
export function asjpCredentialProblem(value: string | null | undefined): string | null {
  const v = value ?? "";
  if (v.length < ASJP_CREDENTIAL_MIN_LENGTH) return "TOO_SHORT";
  if (/\s/.test(v)) return "WHITESPACE";
  if (new Set(v).size < 12) return "LOW_ENTROPY";
  return null;
}

/** http(s) to 127.0.0.1 / ::1 / localhost only — the one place plain http is allowed (local tests, the PC itself). */
export function isLoopbackUrl(url: string): boolean {
  try { const u = new URL(url); return ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname); } catch { return false; }
}

export function asjpRequestMac(key: string, r: { method: string; path: string; host: string; ts: string; nonce: string; bodySha256: string }): string {
  return createHmac("sha256", key).update(`asjp-v2-request\n${r.method.toUpperCase()}\n${r.path}\n${r.host.toLowerCase()}\n${r.ts}\n${r.nonce}\n${r.bodySha256}`).digest("hex");
}
export function asjpResponseMac(key: string, r: { nonce: string; host: string; requestBodySha256: string; status: number; responseBodySha256: string }): string {
  return createHmac("sha256", key).update(`asjp-v2-response\n${r.nonce}\n${r.host.toLowerCase()}\n${r.requestBodySha256}\n${r.status}\n${r.responseBodySha256}`).digest("hex");
}
export function macEquals(expectedHex: string, givenHex: unknown): boolean {
  if (typeof givenHex !== "string" || !/^[0-9a-f]{64}$/.test(givenHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(givenHex, "hex"));
}
