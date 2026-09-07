import { createHash, createPublicKey, randomBytes, randomUUID, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { Client } from "@libsql/client";

/**
 * Device Passport — Phase 2 server crypto. Registration, challenge issuance,
 * ECDSA P-256 / SHA-256 signature verification, and the per-passport
 * provenance-generation bump. NOTHING here touches the similarity matcher,
 * summarizeSubmissionOwnership / summarizeSubmissionProvenance,
 * relationshipType, computeUnifiedSimilarity, maxDF, candidate eligibility,
 * or SELF logic — this module only captures cryptographically verified
 * upload-time device provenance.
 *
 * The private key never leaves the browser and is never stored server-side
 * in any form: device_passports holds ONLY the raw DER SubjectPublicKeyInfo,
 * kept solely to verify signatures. device_passport_challenges stores ONLY
 * sha256(nonce) — the raw nonce is returned to the client exactly once.
 *
 * Feature-flagged: isDevicePassportEnabled() reads
 * process.env.DEVICE_PASSPORT_ENABLED fresh on every call (no caching, so
 * tests can toggle it) — unset/false by default. While off, the register
 * and challenge routes are inert (see their own handlers) and
 * POST /api/reports never calls verifyDevicePassportAttestation, so no
 * passport provenance is ever written and upload behaviour is byte-identical
 * to today.
 */

export function isDevicePassportEnabled(): boolean {
  return process.env.DEVICE_PASSPORT_ENABLED === "true";
}

/**
 * Preview-gated same-device SELF SCORING rule (separate, narrower flag than
 * isDevicePassportEnabled above). While off — the production default,
 * unset/anything-but-"true" — lib/report-primary-similarity.ts issues NOT ONE
 * extra query and the unified similarity result is byte-identical to today.
 * While on, a production-counted historical source backed ONLY by the
 * report's own verified upload passport, with zero independent backing, and an
 * exact canonical document match, is treated as an EFFECTIVE SELF for the
 * unified similarity score only (see lib/device-self-scoring-rule.ts's
 * classifyDeviceSelfMatch). Read fresh on every call so tests can toggle it;
 * turning it on never changes what a challenge verification accepts, and can
 * only ever LOWER a score (exclude a source), never raise one.
 */
export function isDevicePassportSelfScoringEnabled(): boolean {
  return process.env.DEVICE_PASSPORT_SELF_ENABLED === "true";
}

/**
 * Preview-gated refined CONSERVATIVE_COMBINED (Policy D) SHARED-DEVICE fan-out
 * TELEMETRY — an OPTIONAL admin-measurement layer LAYERED ON TOP of the
 * same-device SELF rule above. Independent of isDevicePassportSelfScoringEnabled:
 * this flag does nothing at all unless DEVICE_PASSPORT_SELF_ENABLED is also "true".
 *
 *   SELF flag OFF                 -> baseline scoring, unchanged, regardless of this flag.
 *   SELF flag ON  + guard OFF     -> base Device Passport SELF behaviour; no shared-device
 *                                    fan-out verdict is computed.
 *   SELF flag ON  + guard ON      -> the refined Policy D verdict over the durable
 *                                    shared-device fan-out facts (lib/device-shared-guard.ts
 *                                    / lib/device-shared-guard-policy.ts) is computed and
 *                                    surfaced to the ADMIN decision trace as TELEMETRY. It
 *                                    does NOT change the score — an accepted same-device
 *                                    SELF downgrade is kept regardless of the verdict.
 *
 * Read fresh on every call (no caching) so tests can toggle it. Exact string
 * "true" only; unset / anything else = OFF (the production default). Turning it
 * on is score-neutral (it only adds admin telemetry) and never changes what a
 * challenge verification accepts.
 */
export function isDevicePassportConservativeSharedGuardEnabled(): boolean {
  return process.env.DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED === "true";
}

export const DEVICE_PASSPORT_ALGORITHM = "ECDSA-P256-SHA256";
/** The ONE canonical signed-message version prefix. Bump only on a real format change. */
export const DEVICE_PASSPORT_SIGNED_MESSAGE_VERSION = "TP_DEVICE_PASSPORT_V1";
/** Challenge lifetime — 120 seconds (task spec). */
export const DEVICE_PASSPORT_CHALLENGE_TTL_MS = 120_000;

// Strict input bounds. A P-256 SPKI DER is 91 bytes (~124 base64 chars); a
// P-256 IEEE-P1363 signature is exactly 64 bytes (~88 base64 chars); the
// nonce is exactly 32 bytes. The base64 ceilings sit well above those with
// margin, and every decoder below additionally re-checks the decoded byte
// length exactly.
export const MAX_SPKI_BASE64_LENGTH = 500;
export const MAX_SPKI_DER_BYTES = 300;
export const MAX_SIGNATURE_BASE64_LENGTH = 200;
export const MAX_NONCE_BASE64_LENGTH = 64;
export const MAX_CHALLENGE_ID_LENGTH = 80;
export const MAX_REPORT_ID_LENGTH = 200;

const P256_SIGNATURE_BYTES = 64;
const NONCE_BYTES = 32;

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

// Base64 encode/decode done via an explicit alphabet lookup rather than
// Buffer.prototype.toString('base64') / Buffer.from(str, 'base64')'s typed
// overloads: this project includes @cloudflare/workers-types (Vite/Workers
// build path) alongside @types/node, and workers-types' `declare const
// Buffer: any` breaks the encoding-aware overloads of those two methods
// specifically — see lib/auth-crypto.ts's own bytesToHex/hexToBytes comment
// for the identical workaround. Plain iteration works identically on Buffer
// instances (Buffer is a Uint8Array).
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i += 1) B64_LOOKUP[B64_ALPHABET[i]] = i;

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes canonical (RFC 4648) base64 or returns null — strict: the input
 * must match the base64 alphabet exactly, be a multiple of 4 in length, and
 * round-trip byte-identically (so non-canonical padding or trailing junk is
 * rejected). maxLength is checked first so an oversized blob is refused
 * without decoding it.
 */
function decodeStrictBase64(value: unknown, maxLength: number): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  if (value.length % 4 !== 0 || !STRICT_BASE64_RE.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < value.length; i += 4) {
    const c0 = B64_LOOKUP[value[i]];
    const c1 = B64_LOOKUP[value[i + 1]];
    const c2 = value[i + 2] === "=" ? 0 : B64_LOOKUP[value[i + 2]];
    const c3 = value[i + 3] === "=" ? 0 : B64_LOOKUP[value[i + 3]];
    if (c0 === undefined || c1 === undefined) return null;
    if (value[i + 2] !== "=" && c2 === undefined) return null;
    if (value[i + 3] !== "=" && c3 === undefined) return null;
    if (o < out.length) out[o++] = (c0 << 2) | (c1 >> 4);
    if (o < out.length) out[o++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (o < out.length) out[o++] = ((c2 & 0x03) << 6) | c3;
  }
  if (bytesToBase64(out) !== value) return null;
  return out;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ============================================================================
// SPKI validation + passport id derivation
// ============================================================================

export type ParsedDevicePassportKey = { spkiDer: Uint8Array; publicKey: KeyObject };

/**
 * Validates a base64-encoded DER SubjectPublicKeyInfo and confirms it is an
 * EC key on the NIST P-256 (prime256v1) curve. Returns null for anything
 * else — invalid base64, wrong size, non-DER, non-EC, wrong curve — never
 * throws.
 */
export function parseAndValidateSpki(publicKeySpkiBase64: unknown): ParsedDevicePassportKey | null {
  const spkiDer = decodeStrictBase64(publicKeySpkiBase64, MAX_SPKI_BASE64_LENGTH);
  if (!spkiDer || spkiDer.length < 40 || spkiDer.length > MAX_SPKI_DER_BYTES) return null;
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: Buffer.from(spkiDer), format: "der", type: "spki" });
  } catch {
    return null;
  }
  if (publicKey.asymmetricKeyType !== "ec") return null;
  const curve = publicKey.asymmetricKeyDetails?.namedCurve;
  if (curve !== "prime256v1" && curve !== "P-256") return null;
  return { spkiDer, publicKey };
}

/** device_passports.id = lowercase SHA-256 hex of the raw SPKI DER bytes. Deterministic ⇒ registration is idempotent. */
export function derivePassportId(spkiDer: Uint8Array): string {
  return sha256Hex(spkiDer);
}

// ============================================================================
// Signed-message contract (the ONE canonical byte format)
// ============================================================================

/**
 * TP_DEVICE_PASSPORT_V1
 * <nonce, base64>
 * <challengeId>
 * <method>            e.g. "POST"
 * <path>              e.g. "/api/reports"
 * <sha256(exact report payload text), lowercase hex>
 * <reportId>
 *
 * UTF-8 encoded, single "\n" (0x0A) between fields, no trailing newline. The
 * browser signs exactly these bytes with ECDSA P-256 / SHA-256 (IEEE-P1363
 * output); the server reconstructs them byte-for-byte from the ACTUAL
 * request. The session token hash is deliberately NOT part of this message —
 * session/account binding is enforced separately, server-side, against the
 * challenge row.
 */
export function buildDevicePassportSignedMessage(params: {
  nonceBase64: string;
  challengeId: string;
  method: string;
  path: string;
  payloadTextSha256Hex: string;
  reportId: string;
}): Buffer {
  return Buffer.from(
    [
      DEVICE_PASSPORT_SIGNED_MESSAGE_VERSION,
      params.nonceBase64,
      params.challengeId,
      params.method,
      params.path,
      params.payloadTextSha256Hex,
      params.reportId,
    ].join("\n"),
    "utf8",
  );
}

// ============================================================================
// Challenge issuance
// ============================================================================

export type DevicePassportSessionContext = {
  /** The current session's account id, or null for an anonymous request. */
  accountId: string | null;
  /** hashToken(rawSessionCookie) (lib/auth-session.ts) when there is a valid session, else null. */
  sessionTokenHash: string | null;
};

/**
 * Issues one single-use challenge bound SERVER-SIDE to the current
 * session/account context. Stores only sha256(nonce); returns the raw nonce
 * (base64) and challenge id exactly once.
 */
export async function createDevicePassportChallenge(
  client: Pick<Client, "execute">,
  session: DevicePassportSessionContext,
): Promise<{ challengeId: string; nonce: string }> {
  const challengeId = randomUUID();
  const nonceBytes = randomBytes(NONCE_BYTES);
  const now = Date.now();
  await client.execute({
    sql: `INSERT INTO device_passport_challenges
            (id, nonce_hash, account_id, session_token_hash, issued_at, expires_at, consumed_at)
          VALUES (?,?,?,?,?,?,NULL)`,
    args: [
      challengeId,
      sha256Hex(nonceBytes),
      session.accountId,
      session.sessionTokenHash,
      now,
      now + DEVICE_PASSPORT_CHALLENGE_TTL_MS,
    ],
  });
  return { challengeId, nonce: bytesToBase64(nonceBytes) };
}

// ============================================================================
// Attestation verification (POST /api/reports)
// ============================================================================

export type DevicePassportAttestationInput = {
  /** From the request body's devicePassport object. Untrusted. */
  challengeId: unknown;
  nonce: unknown;
  publicKeySpki: unknown;
  signature: unknown;
  /** Reconstructed from the ACTUAL request, not the client. */
  method: string;
  path: string;
  payloadText: string;
  reportId: string;
  /** The CURRENT request's server-resolved session context. */
  currentAccountId: string | null;
  currentSessionTokenHash: string | null;
};

type ChallengeRow = {
  id: string;
  nonce_hash: string;
  account_id: string | null;
  session_token_hash: string | null;
  issued_at: number | bigint;
  expires_at: number | bigint;
  consumed_at: number | bigint | null;
};

/**
 * The full verification pipeline. Returns the verified passport id on
 * complete success, or null on ANY failure — never throws for a
 * verification failure (a caught internal error also returns null). Ordering
 * (task spec): every cheap structural + context check runs BEFORE the
 * challenge is consumed; the atomic single-use consume is the last gate, so
 * two concurrent requests replaying one challenge+signature can never both
 * win (only one UPDATE affects the row).
 *
 * On full success, records device_passports.last_seen_at = now (valid use),
 * best-effort.
 */
export async function verifyDevicePassportAttestation(
  client: Pick<Client, "execute">,
  input: DevicePassportAttestationInput,
): Promise<string | null> {
  try {
    // --- 1. structural / format --------------------------------------------
    if (!isNonEmptyString(input.challengeId) || input.challengeId.length > MAX_CHALLENGE_ID_LENGTH) return null;
    if (!isNonEmptyString(input.reportId) || input.reportId.length > MAX_REPORT_ID_LENGTH) return null;
    const nonceBuf = decodeStrictBase64(input.nonce, MAX_NONCE_BASE64_LENGTH);
    if (!nonceBuf || nonceBuf.length !== NONCE_BYTES) return null;
    const parsed = parseAndValidateSpki(input.publicKeySpki);
    if (!parsed) return null;
    const signatureBuf = decodeStrictBase64(input.signature, MAX_SIGNATURE_BASE64_LENGTH);
    if (!signatureBuf || signatureBuf.length !== P256_SIGNATURE_BYTES) return null;

    // --- 2. locate challenge ----------------------------------------------
    const challengeResult = await client.execute({
      sql: "SELECT id, nonce_hash, account_id, session_token_hash, issued_at, expires_at, consumed_at FROM device_passport_challenges WHERE id = ?",
      args: [input.challengeId],
    });
    const challenge = challengeResult.rows[0] as unknown as ChallengeRow | undefined;
    if (!challenge) return null;

    // --- 3. nonce matches the stored hash --------------------------------
    if (sha256Hex(nonceBuf) !== String(challenge.nonce_hash)) return null;

    // --- 4. not expired --------------------------------------------------
    if (Number(challenge.expires_at) <= Date.now()) return null;

    // --- 5. not already consumed (cheap early check; the atomic UPDATE
    //        below is the authoritative one) ----------------------------
    if (challenge.consumed_at != null) return null;

    // --- 6. session / account binding (server-side, both directions) ----
    const boundAccountId = challenge.account_id == null ? null : String(challenge.account_id);
    const boundTokenHash = challenge.session_token_hash == null ? null : String(challenge.session_token_hash);
    if (boundAccountId !== (input.currentAccountId ?? null)) return null;
    if (boundTokenHash !== (input.currentSessionTokenHash ?? null)) return null;

    // --- 7. passport must exist and not be revoked ---------------------
    const passportId = derivePassportId(parsed.spkiDer);
    const passportResult = await client.execute({
      sql: "SELECT id, revoked_at FROM device_passports WHERE id = ?",
      args: [passportId],
    });
    const passport = passportResult.rows[0] as unknown as { id: string; revoked_at: number | bigint | null } | undefined;
    if (!passport || passport.revoked_at != null) return null;

    // --- 8. reconstruct the signed message from the ACTUAL request ----
    const message = buildDevicePassportSignedMessage({
      nonceBase64: bytesToBase64(nonceBuf),
      challengeId: input.challengeId,
      method: input.method,
      path: input.path,
      payloadTextSha256Hex: sha256Hex(input.payloadText),
      reportId: input.reportId,
    });

    // --- 9. verify the ECDSA P-256 / SHA-256 signature (IEEE-P1363) ---
    let signatureOk = false;
    try {
      signatureOk = cryptoVerify("sha256", message, { key: parsed.publicKey, dsaEncoding: "ieee-p1363" }, signatureBuf);
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) return null;

    // --- 10. atomic single-use consume (the replay gate) -------------
    const consumeResult = await client.execute({
      sql: "UPDATE device_passport_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
      args: [Date.now(), input.challengeId],
    });
    if (Number(consumeResult.rowsAffected) !== 1) return null;

    // --- 11. record valid use --------------------------------------
    try {
      await client.execute({
        sql: "UPDATE device_passports SET last_seen_at = ? WHERE id = ?",
        args: [Date.now(), passportId],
      });
    } catch {
      // non-fatal — the passport is already verified for this request.
    }

    return passportId;
  } catch {
    return null;
  }
}

// ============================================================================
// Per-passport provenance generation
// ============================================================================

/**
 * Bumps ONE passport's provenance_generation by 1. Never a global counter —
 * passport D2's changes must never invalidate a report tied to D1. Called
 * when a passport gains a materially relevant new distinct account
 * association (see maybeBumpDevicePassportProvenanceGeneration) and, in a
 * later phase, on admin revocation.
 */
export async function bumpDevicePassportProvenanceGeneration(
  client: Pick<Client, "execute">,
  passportId: string,
): Promise<void> {
  await client.execute({
    sql: "UPDATE device_passports SET provenance_generation = provenance_generation + 1 WHERE id = ?",
    args: [passportId],
  });
}

/**
 * Bumps the passport's provenance_generation ONLY when the just-inserted
 * verified report introduces a NEW (passport, account) association — i.e.
 * there is no OTHER saved_reports row already tying this passport to this
 * exact account (or to "anonymous", when accountId is null). A repeat report
 * from the same account on the same passport does NOT bump; the FIRST
 * anonymous report from a passport DOES (a new (passport, NULL) association).
 *
 * Idempotent-ish: if called twice for the same freshly-inserted report, the
 * second call finds the row it is about to exclude is the only one and, if
 * the first call already bumped, still sees "no OTHER row" and would bump
 * again — so callers invoke it exactly once per first-save. An extra bump is
 * only a harmless extra recompute later, never wrong.
 */
export async function maybeBumpDevicePassportProvenanceGeneration(
  client: Pick<Client, "execute">,
  params: { passportId: string; accountId: string | null; deviceKey: string; reportId: string },
): Promise<{ bumped: boolean }> {
  const existing = await client.execute({
    sql: `SELECT 1 FROM saved_reports
          WHERE verified_device_passport_id = ?
            AND NOT (device_key = ? AND id = ?)
            AND ((? IS NULL AND user_id IS NULL) OR user_id = ?)
          LIMIT 1`,
    args: [params.passportId, params.deviceKey, params.reportId, params.accountId, params.accountId],
  });
  if (existing.rows.length > 0) return { bumped: false };
  await bumpDevicePassportProvenanceGeneration(client, params.passportId);
  return { bumped: true };
}

// ============================================================================
// Bounded cleanup (traffic-piggybacked — this app has no cron; mirrors
// lib/rate-limit.ts's maybeCleanupStaleBuckets)
// ============================================================================

const CHALLENGE_CLEANUP_PROBABILITY = 0.05;
const CHALLENGE_CLEANUP_BATCH_LIMIT = 200;

/**
 * Low-probability, bounded deletion of already-expired challenge rows. Never
 * touches device_passports (device_passport_challenges has no foreign key to
 * it, and only expired rows are eligible). Best-effort: a failure here never
 * affects the request it rode along with.
 */
export async function maybeCleanupExpiredDevicePassportChallenges(client: Pick<Client, "execute">): Promise<void> {
  if (Math.random() >= CHALLENGE_CLEANUP_PROBABILITY) return;
  try {
    await client.execute({
      sql: `DELETE FROM device_passport_challenges WHERE id IN (
              SELECT id FROM device_passport_challenges WHERE expires_at < ? LIMIT ?
            )`,
      args: [Date.now(), CHALLENGE_CLEANUP_BATCH_LIMIT],
    });
  } catch (err) {
    console.error("device passport challenge cleanup failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}
