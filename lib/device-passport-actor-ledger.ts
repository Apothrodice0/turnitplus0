import { createHmac } from "node:crypto";
import type { Transaction } from "@libsql/client";

/**
 * Device Passport — durable ACTOR USAGE LEDGER, FOUNDATION ONLY.
 *
 * This module owns exactly two things:
 *   1. the ACTOR KEY: a stable keyed pseudonym for whoever uploaded under a
 *      verified device passport — HMAC-SHA256(dedicated server key,
 *      domain-separated account id) for an authenticated account, a fixed
 *      internal sentinel for anonymous use. NEVER a raw account id.
 *   2. the append-only UPSERT into device_passport_actor_usage (drizzle/0041).
 *
 * NOTHING here — and nothing that consumes what this writes — touches the
 * similarity matcher, computeUnifiedSimilarity, resolveEffectiveDeviceSelf-
 * RepresentationIds, the same-device SELF rule, or the refined
 * CONSERVATIVE_COMBINED (Policy D) shared-device guard. No scoring path reads
 * device_passport_actor_usage yet. This is storage plumbing only.
 *
 * COMPLETENESS SEMANTICS (device_passports.actor_usage_tracking_version):
 *   0  historical actor usage for this passport is NOT proven complete —
 *      deleted historical accounts and past anonymous use are unreconstructable.
 *   1  this passport has been durably actor-tracked since its creation.
 * A passport is NEVER promoted 0 -> 1 after the fact. Only a genuinely NEW
 * passport, registered while durable actor tracking is available (the actor
 * HMAC key is present — isDurableActorTrackingAvailable() below), may be born
 * at version 1. If the key is unavailable, registration still succeeds but the
 * new passport stays version 0, and therefore can never later be treated as
 * complete evidence. We do not silently claim completeness.
 *
 * PRIVACY: the raw account id is never stored, never logged. actor_key,
 * tracking version, passport id, and ledger rows are server-internal — no
 * ordinary API surfaces any of them (see tests/device-passport-actor-ledger*).
 */

/** The dedicated actor-key HMAC secret's env var. No default, no real secret shipped. */
export const DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV = "DEVICE_PASSPORT_ACTOR_HMAC_KEY";

/**
 * Domain separator mixed into the HMAC input so the actor key can never be
 * mistaken for, or collide with, an HMAC of the same account id computed for
 * any other purpose. Bump the trailing version (and DEVICE_ACTOR_KEY_VERSION)
 * only on a real keying-scheme change.
 */
export const DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR = "TURNITPLUS_DEVICE_ACTOR_V1";

/** Which keying generation produced an actor_key. Stored per row so the scheme can rotate without rewriting history. */
export const DEVICE_ACTOR_KEY_VERSION = 1;

/**
 * The fixed internal pseudonym for anonymous use. Not an HMAC of anything —
 * anonymous uploads carry no account identifier at all, so there is nothing to
 * key. Distinct by construction from any real actor_key (which is 64 lowercase
 * hex chars).
 */
export const ANONYMOUS_ACTOR_KEY = "__anonymous__";

export type ActorObservation = {
  actorKeyVersion: number;
  /** A keyed pseudonym or ANONYMOUS_ACTOR_KEY — never a raw account id. */
  actorKey: string;
  isAnonymous: boolean;
};

/**
 * The dedicated actor HMAC key, or null when unset / blank. Read fresh on
 * every call (no caching) so tests can toggle it — the same convention
 * lib/device-passport-server.ts's flag readers follow.
 */
export function getDeviceActorHmacKey(): string | null {
  const raw = process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether this process can DURABLY record actor usage from a passport's birth.
 * The ONLY input to whether a brand-new passport may be registered at
 * actor_usage_tracking_version = 1. False (key missing) must never fail
 * registration — it just means the new passport stays version 0.
 */
export function isDurableActorTrackingAvailable(): boolean {
  return getDeviceActorHmacKey() !== null;
}

/**
 * The stable keyed pseudonym for the actor behind one upload.
 *   accountId === null  -> the fixed anonymous sentinel (no key required).
 *   accountId is a string + HMAC key available -> HMAC-SHA256 hex pseudonym.
 *   accountId is a string + HMAC key UNAVAILABLE -> null. The caller must then
 *     NOT persist a completeness claim: for a version-1 passport this means
 *     failing the write rather than saving a report with missing usage
 *     evidence (see app/api/reports/route.ts's insertReportWithRoomCheck).
 */
export function resolveActorObservation(accountId: string | null): ActorObservation | null {
  if (accountId === null) {
    return { actorKeyVersion: DEVICE_ACTOR_KEY_VERSION, actorKey: ANONYMOUS_ACTOR_KEY, isAnonymous: true };
  }
  const key = getDeviceActorHmacKey();
  if (!key) return null;
  const actorKey = createHmac("sha256", key)
    .update(`${DEVICE_ACTOR_KEY_DOMAIN_SEPARATOR}:${accountId}`, "utf8")
    .digest("hex");
  return { actorKeyVersion: DEVICE_ACTOR_KEY_VERSION, actorKey, isAnonymous: false };
}

/**
 * Reads one passport's completeness marker. Kept here (rather than inlined at
 * the call site) so the "version >= 1 means atomic" contract has one home.
 * Pass a live transaction to read it INSIDE the first-save transaction.
 */
export async function readActorUsageTrackingVersion(
  exec: Pick<Transaction, "execute">,
  devicePassportId: string,
): Promise<number> {
  const result = await exec.execute({
    sql: "SELECT actor_usage_tracking_version FROM device_passports WHERE id = ?",
    args: [devicePassportId],
  });
  const raw = result.rows[0]?.actor_usage_tracking_version as number | bigint | null | undefined;
  return raw == null ? 0 : Number(raw);
}

/**
 * Append-only UPSERT of one actor-usage observation into
 * device_passport_actor_usage (drizzle/0041).
 *
 *   new triple    -> inserted, observation_count = 1, both timestamps = observedAt.
 *   repeat triple -> first_observed_at PRESERVED, last_observed_at advanced
 *                    (never regressed — max()), observation_count incremented.
 *
 * NEVER deletes a row, NEVER decrements a count. Accepts either a Client or a
 * live Transaction (Pick<Transaction, "execute"> is the common shape — a
 * Client satisfies it) so the same statement runs inside the first-save
 * transaction for a version-1 passport and as a standalone best-effort write
 * for a legacy passport.
 */
export async function recordDevicePassportActorUsage(
  exec: Pick<Transaction, "execute">,
  params: { devicePassportId: string; observation: ActorObservation; observedAt: number },
): Promise<void> {
  const { devicePassportId, observation, observedAt } = params;
  await exec.execute({
    sql: `INSERT INTO device_passport_actor_usage
            (device_passport_id, actor_key_version, actor_key, is_anonymous, first_observed_at, last_observed_at, observation_count)
          VALUES (?,?,?,?,?,?,1)
          ON CONFLICT (device_passport_id, actor_key_version, actor_key) DO UPDATE SET
            last_observed_at = max(device_passport_actor_usage.last_observed_at, excluded.last_observed_at),
            observation_count = device_passport_actor_usage.observation_count + 1`,
    args: [
      devicePassportId,
      observation.actorKeyVersion,
      observation.actorKey,
      observation.isAnonymous ? 1 : 0,
      observedAt,
      observedAt,
    ],
  });
}
