import type { Client } from "@libsql/client";
import {
  evaluateConservativeSharedGuard,
  type ConservativeSharedGuardFacts,
  type ConservativeSharedGuardReason,
} from "./device-shared-guard-policy";
import {
  DEVICE_ACTOR_KEY_VERSION,
  isDurableActorTrackingAvailable,
  resolveActorObservation,
} from "./device-passport-actor-ledger";

/**
 * Device Passport — refined CONSERVATIVE_COMBINED (Policy D) SHARED-DEVICE
 * SCORING GUARD, the DB-fact-resolution + decision layer consumed by the
 * Device Passport SELF scoring path (lib/report-primary-similarity.ts's
 * resolveEffectiveDeviceSelfRepresentationIds), gated on
 * DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED.
 *
 * TELEMETRY ONLY: when the guard is enabled it computes the refined Policy D
 * verdict over the four bounded durable fan-out facts below and hands it back
 * for the ADMIN similarity decision trace. It DOES NOT veto scoring — a
 * representation that lib/device-self-scoring-rule.ts's classifyDeviceSelfMatch
 * accepted stays an effective Device Passport SELF regardless of this verdict.
 * (An earlier revision had a `passed: false` verdict remove the representation
 * from the effective-SELF set; that veto was removed — shared-device fan-out is
 * now measured, not scored.)
 *
 * FACT SOURCES — the shared-device fan-out / pair-safety facts are now derived
 * from the DURABLE, APPEND-ONLY device_passport_actor_usage ledger (drizzle/0041),
 * NOT from saved_reports. saved_reports fan-out shrinks (report / account
 * deletion, room clearing, claimAnonymousReports, retention sweep, corpus
 * revocation); the actor ledger never does. This module NEVER reads
 * historical_match_shadow_evaluations, device-provenance-shadow measurement, the
 * shared-device admin measurement, developer routes, or any telemetry table,
 * and imports NONE of lib/device-provenance-shadow.ts /
 * lib/device-sharedness-measurement.ts / lib/developer-repo.ts:
 *
 *   HARD PRECONDITIONS (any failing => passed:false, a conservative telemetry verdict):
 *     - the report's OWN verified upload Passport must carry
 *       actor_usage_tracking_version >= 1: only such a Passport's ledger is a
 *       COMPLETE record of who has used it. A version-0 (legacy) Passport is
 *       history-incomplete and BLOCKS even if backfilled / re-observed ledger
 *       rows exist. This is a DISTINCT, expected outcome
 *       (reason: BLOCKED_INCOMPLETE_ACTOR_HISTORY,
 *       durableActorHistoryComplete: false) — never conflated with a
 *       DB/HMAC/membership failure. Read first, so the boolean is known even
 *       when the key is unavailable.
 *     - the dedicated actor HMAC key must be available
 *       (isDurableActorTrackingAvailable) — no key means no verifiable
 *       pseudonym, so no provable pair (reason: BLOCKED_INSUFFICIENT_EVIDENCE).
 *     - BOTH the report's own account (target) and every cross-account backing
 *       source must be POSITIVELY PRESENT as a pseudonymous actor row on the
 *       report's own Passport in the ledger, at actor_key_version
 *       DEVICE_ACTOR_KEY_VERSION. A missing membership row is not "safe" — it is
 *       unproven, so it blocks (reason: BLOCKED_INSUFFICIENT_EVIDENCE).
 *
 *   durableActorHistoryComplete (a BOOLEAN, never the version number, carried on
 *   every result): true = version >= 1; false = the Passport exists but its
 *   history is incomplete; null = not evaluated (guard off / no candidate /
 *   same-account short-circuit / source discovery failed / the version read
 *   itself threw).
 *
 *   1. deviceDistinctAccounts
 *        COUNT of distinct pseudonymous actor keys (is_anonymous = 0,
 *        actor_key_version = DEVICE_ACTOR_KEY_VERSION) in
 *        device_passport_actor_usage for the report's own Passport.
 *   2. deviceAnonUploads
 *        1 iff the anonymous-sentinel actor row (is_anonymous = 1, same key
 *        version) exists for that Passport, else 0 — the anonymous-use veto is
 *        DURABLE anonymous actor evidence, not a live anonymous saved_reports
 *        count.
 *   3. unorderedDeviceAccountPairCount
 *        the distinct cross-account source accounts of the SAME-DEVICE admission
 *        backings (corpus_admission_decision_device_provenance, drizzle/0039) of
 *        the effective-SELF representation(s), each paired with the report's own
 *        account. Under Branch A/B's own "exactly 2 distinct accounts" ceiling
 *        there is at most one such pair; a second forces deviceDistinctAccounts
 *        >= 3 (both source actors must be present in the ledger) and the ceiling
 *        fails first.
 *   4. pairOtherVerifiedPassportCount
 *        distinct Passports OTHER than the report's own on which BOTH the target
 *        actor key and the source actor key appear as pseudonymous ledger rows
 *        (durable actor-ledger co-occurrence, same key version).
 *
 * IDENTITY HANDLING: account ids, actor keys, the Passport id, and admission
 * source_ref strings are read into server-local memory ONLY to run the SELECT
 * joins, derive pseudonyms, and count. NONE is ever returned — every field of
 * DeviceSelfSharedGuardResult is a bounded count, boolean, or short enum.
 *
 * FAIL CLOSED: any lookup / query / parse / HMAC error, or any required fact
 * that cannot be resolved, yields passed:false (a conservative telemetry
 * verdict). This function never throws. Because the verdict is telemetry only,
 * a failure no longer changes the score — the Device Passport SELF downgrade is
 * still kept.
 *
 * SAME-ACCOUNT RULE: a candidate whose only same-device backing source is the
 * report's OWN account is NOT a shared-device case — the guard does not act on
 * it (NOT_APPLIED, passed:true), so same-account SELF behaviour is completely
 * unchanged whether the guard flag is on or off. This check runs BEFORE the
 * durable-tracking preconditions, so a same-account SELF is never blocked for
 * being on a legacy Passport.
 */

/** Canonical prefix of a report-upload admission source_ref — kept as a local literal so this module imports nothing heavier. */
const SOURCE_REF_ACCOUNT_PREFIX = "report-upload:account=";
const SOURCE_REF_DEVICE_DELIM = ":device=";

/** Defensive ceiling on how many effective-SELF representation ids the guard will resolve backings for — mirrors lib/report-primary-similarity.ts's MAX_DEVICE_SELF_REPRESENTATIONS. */
const MAX_GUARD_REPRESENTATIONS = 25;

export type DeviceSelfSharedGuardResult = {
  /** DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED state at evaluation. */
  enabled: boolean;
  /** The refined Policy D verdict (ADMIN TELEMETRY): true => the durable fan-out facts satisfy a Policy D branch; false => a conservative / blocked verdict. Does NOT change scoring — an accepted Device Passport SELF is kept regardless. */
  passed: boolean;
  reason: ConservativeSharedGuardReason;
  /**
   * The report's own verified Passport's durable actor-usage completeness — a
   * BOOLEAN only, NEVER the version number:
   *   true  => actor_usage_tracking_version >= 1 (tracked since birth).
   *   false => the Passport exists but its actor history is incomplete (version 0).
   *   null  => not evaluated / unavailable (guard did not run, same-account
   *            short-circuit, source discovery failed, or the version read itself
   *            threw before it could be determined).
   * No Passport id, account id, or actor key is ever carried alongside it.
   */
  durableActorHistoryComplete: boolean | null;
  deviceDistinctAccounts: number | null;
  deviceAnonUploads: number | null;
  unorderedDeviceAccountPairCount: number | null;
  pairOtherVerifiedPassportCount: number | null;
};

/** Guard result for "the guard did not run" — flag off, or no SELF candidate to guard. */
export function guardNotApplied(enabled: boolean): DeviceSelfSharedGuardResult {
  return {
    enabled,
    passed: true,
    reason: "NOT_APPLIED",
    durableActorHistoryComplete: null,
    deviceDistinctAccounts: null,
    deviceAnonUploads: null,
    unorderedDeviceAccountPairCount: null,
    pairOtherVerifiedPassportCount: null,
  };
}

/**
 * BLOCKED_INSUFFICIENT_EVIDENCE — reserved for DB/query failures, missing
 * HMAC/key derivation, missing durable target/source membership, and
 * malformed/unavailable evidence. NOT the normal legacy-version-0 case (that is
 * BLOCKED_INCOMPLETE_ACTOR_HISTORY). `durableActorHistoryComplete` is carried
 * through so a failure AFTER the version was successfully read still reports it.
 */
function blockedInsufficient(
  enabled: boolean,
  facts?: Partial<Pick<DeviceSelfSharedGuardResult, "deviceDistinctAccounts" | "deviceAnonUploads">>,
  durableActorHistoryComplete: boolean | null = null,
): DeviceSelfSharedGuardResult {
  return {
    enabled,
    passed: false,
    reason: "BLOCKED_INSUFFICIENT_EVIDENCE",
    durableActorHistoryComplete,
    deviceDistinctAccounts: facts?.deviceDistinctAccounts ?? null,
    deviceAnonUploads: facts?.deviceAnonUploads ?? null,
    unorderedDeviceAccountPairCount: null,
    pairOtherVerifiedPassportCount: null,
  };
}

/**
 * BLOCKED_INCOMPLETE_ACTOR_HISTORY — the guard is enabled, a Device Passport
 * SELF candidate exists, and the report's own verified Passport carries
 * actor_usage_tracking_version < 1. This is the normal legacy-Passport block:
 * we cannot prove who has used this browser, so the SELF downgrade stays off.
 */
function blockedIncompleteActorHistory(enabled: boolean): DeviceSelfSharedGuardResult {
  return {
    enabled,
    passed: false,
    reason: "BLOCKED_INCOMPLETE_ACTOR_HISTORY",
    durableActorHistoryComplete: false,
    deviceDistinctAccounts: null,
    deviceAnonUploads: null,
    unorderedDeviceAccountPairCount: null,
    pairOtherVerifiedPassportCount: null,
  };
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0) || 0;
}

/** Extract the account id from a canonical report-upload source_ref, or null. Pure string work — no wildcard, no injection surface (mirrors lib/device-sharedness-measurement.ts). */
function accountIdFromSourceRef(sourceRef: string | null | undefined): string | null {
  if (typeof sourceRef !== "string") return null;
  if (!sourceRef.startsWith(SOURCE_REF_ACCOUNT_PREFIX)) return null;
  const delimAt = sourceRef.indexOf(SOURCE_REF_DEVICE_DELIM, SOURCE_REF_ACCOUNT_PREFIX.length);
  if (delimAt <= SOURCE_REF_ACCOUNT_PREFIX.length) return null;
  return sourceRef.slice(SOURCE_REF_ACCOUNT_PREFIX.length, delimAt);
}

/** (1)(2) durable fan-out facts for one verified Passport, from device_passport_actor_usage. SELECT-only. */
async function loadPassportActorLedgerFacts(
  client: Client,
  passportId: string,
): Promise<{ deviceDistinctAccounts: number; deviceAnonUploads: number }> {
  const row = (
    await client.execute({
      sql: `SELECT
              SUM(CASE WHEN is_anonymous = 0 THEN 1 ELSE 0 END) AS distinct_accounts,
              MAX(CASE WHEN is_anonymous = 1 THEN 1 ELSE 0 END) AS anon_present
            FROM device_passport_actor_usage
            WHERE device_passport_id = ? AND actor_key_version = ?`,
      args: [passportId, DEVICE_ACTOR_KEY_VERSION],
    })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  return {
    deviceDistinctAccounts: num(row?.distinct_accounts),
    deviceAnonUploads: num(row?.anon_present) > 0 ? 1 : 0,
  };
}

/** The report's own Passport's durable actor-usage completeness marker. Missing row or NULL => 0. SELECT-only. */
async function readActorUsageTrackingVersion(client: Client, passportId: string): Promise<number> {
  const row = (
    await client.execute({
      sql: "SELECT actor_usage_tracking_version FROM device_passports WHERE id = ?",
      args: [passportId],
    })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  const raw = row?.actor_usage_tracking_version;
  return raw == null ? 0 : num(raw);
}

/** Whether one pseudonymous actor key has a ledger row on one Passport (same key version). SELECT-only. */
async function actorPresentOnPassport(client: Client, passportId: string, actorKey: string): Promise<boolean> {
  const row = (
    await client.execute({
      sql: `SELECT 1 AS present FROM device_passport_actor_usage
            WHERE device_passport_id = ? AND actor_key_version = ? AND actor_key = ? AND is_anonymous = 0
            LIMIT 1`,
      args: [passportId, DEVICE_ACTOR_KEY_VERSION, actorKey],
    })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  return row?.present != null;
}

/** (4) distinct Passports OTHER than `excludePassportId` on which BOTH actor keys have a pseudonymous ledger row. SELECT-only. */
async function pairOtherPassportActorCoOccurrence(
  client: Client,
  actorKeyA: string,
  actorKeyB: string,
  excludePassportId: string,
): Promise<number> {
  const row = (
    await client.execute({
      sql: `SELECT COUNT(*) AS n FROM (
              SELECT device_passport_id
              FROM device_passport_actor_usage
              WHERE device_passport_id <> ?
                AND actor_key_version = ?
                AND is_anonymous = 0
                AND actor_key IN (?, ?)
              GROUP BY device_passport_id
              HAVING COUNT(DISTINCT actor_key) >= 2
            )`,
      args: [excludePassportId, DEVICE_ACTOR_KEY_VERSION, actorKeyA, actorKeyB],
    })
  ).rows[0] as unknown as Record<string, unknown> | undefined;
  return num(row?.n);
}

/**
 * (3) source accounts of the SAME-DEVICE admission backings of the effective-SELF
 * representation(s). One query for all representation ids. Mirrors
 * lib/submission-provenance.ts's own admission-backing join shape
 * (status='indexed' AND accepted representation not revoked) restricted to
 * backings whose device provenance is the report's own Passport. SELECT-only.
 */
async function sameDeviceBackingSourceAccounts(
  client: Client,
  representationIds: string[],
  passportId: string,
): Promise<{ accounts: Set<string>; unresolved: boolean; backingCount: number }> {
  const ids = representationIds.slice(0, MAX_GUARD_REPRESENTATIONS);
  if (ids.length === 0) return { accounts: new Set(), unresolved: false, backingCount: 0 };
  const placeholders = ids.map(() => "?").join(", ");
  const rows = (
    await client.execute({
      sql: `SELECT d.source_ref AS source_ref
            FROM corpus_admission_promotions p
            JOIN corpus_admission_accepted_representations ar ON ar.id = p.accepted_representation_id
            JOIN corpus_admission_decisions d ON d.id = ar.decision_id
            JOIN corpus_admission_decision_device_provenance cadp ON cadp.decision_id = d.id
            WHERE p.representation_id IN (${placeholders})
              AND p.status = 'indexed'
              AND ar.revoked_at IS NULL
              AND cadp.device_passport_id = ?`,
      args: [...ids, passportId],
    })
  ).rows as unknown as { source_ref: string | null }[];
  const accounts = new Set<string>();
  let unresolved = false;
  for (const r of rows) {
    const acc = accountIdFromSourceRef(r.source_ref);
    if (acc) accounts.add(acc);
    else unresolved = true;
  }
  return { accounts, unresolved, backingCount: rows.length };
}

export type EvaluateDeviceSelfSharedGuardParams = {
  /** DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED — resolved by the caller (lib/device-passport-server.ts). */
  enabled: boolean;
  /** The report's OWN immutable verified upload Device Passport id — server-internal, never returned. */
  verifiedDevicePassportId: string;
  /** The report's own account, or null for an anonymous report. Server-internal, never returned. */
  reportAccountId: string | null;
  /** matchedRepresentationId values the pure classifier already accepted as effective Device Passport SELF. */
  effectiveSelfRepresentationIds: string[];
};

/**
 * Evaluate the refined Policy D shared-device guard for one report's already-
 * classified effective Device Passport SELF representation(s), for ADMIN
 * TELEMETRY. Best-effort — never throws. Any failure => passed:false (a
 * conservative verdict); the caller keeps the SELF downgrade either way.
 */
export async function evaluateDeviceSelfSharedGuard(
  client: Client,
  params: EvaluateDeviceSelfSharedGuardParams,
): Promise<DeviceSelfSharedGuardResult> {
  const { enabled } = params;
  if (params.effectiveSelfRepresentationIds.length === 0) return guardNotApplied(enabled);

  // Determined once the current Passport's actor_usage_tracking_version is read
  // (step below). Kept in this scope so a later failure — or the catch — still
  // reports it. null until then / if the read itself throws.
  let durableActorHistoryComplete: boolean | null = null;

  try {
    // Identify the backing source accounts FIRST — from durable admission
    // provenance, never saved_reports. The SAME-ACCOUNT short-circuit below
    // must run before any durable-tracking precondition so a genuine
    // same-account SELF is never blocked for being on a legacy Passport.
    const { accounts: sourceAccounts, unresolved } = await sameDeviceBackingSourceAccounts(
      client,
      params.effectiveSelfRepresentationIds,
      params.verifiedDevicePassportId,
    );

    const reportAccountId = params.reportAccountId;
    const crossAccountSources = new Set<string>();
    let sameAccountSourcePresent = false;
    for (const acc of sourceAccounts) {
      if (reportAccountId !== null && acc === reportAccountId) sameAccountSourcePresent = true;
      else crossAccountSources.add(acc);
    }

    // A same-device backing whose source_ref could not be parsed is never the
    // report's own upload (that always uses the canonical format) — treat it as
    // an unprovable cross-account case and FAIL CLOSED.
    if (unresolved) return blockedInsufficient(enabled);

    if (crossAccountSources.size === 0) {
      // Only the report's own account backs this representation same-device —
      // an ordinary same-account SELF. The guard does not act (SAME-ACCOUNT rule) —
      // and it never even evaluates durable actor history for it.
      if (sameAccountSourcePresent) {
        return {
          enabled,
          passed: true,
          reason: "NOT_APPLIED",
          durableActorHistoryComplete: null,
          deviceDistinctAccounts: null,
          deviceAnonUploads: null,
          unorderedDeviceAccountPairCount: 0,
          pairOtherVerifiedPassportCount: null,
        };
      }
      // No resolvable source account at all — cannot prove the pair is safe.
      return blockedInsufficient(enabled);
    }

    // ---- genuine cross-account shared-device candidate: durable gates apply ----

    // The report's own Passport must be durably actor-tracked since birth
    // (actor_usage_tracking_version >= 1). A version-0 Passport is
    // history-incomplete and BLOCKS even if backfilled ledger rows exist — this
    // is a DISTINCT, expected outcome (BLOCKED_INCOMPLETE_ACTOR_HISTORY), never
    // conflated with a DB/HMAC/membership failure. Read BEFORE the HMAC check so
    // the completeness boolean is known regardless of key availability.
    const trackingVersion = await readActorUsageTrackingVersion(client, params.verifiedDevicePassportId);
    durableActorHistoryComplete = trackingVersion >= 1;
    if (!durableActorHistoryComplete) return blockedIncompleteActorHistory(enabled);

    // The dedicated actor HMAC key must be available — without it there is no
    // verifiable pseudonym, so no provable pair. FAIL CLOSED (insufficient
    // evidence — the actor history IS complete, the key just cannot be derived).
    if (!isDurableActorTrackingAvailable()) {
      return blockedInsufficient(enabled, undefined, durableActorHistoryComplete);
    }

    // (1)(2) durable fan-out facts, from device_passport_actor_usage.
    const { deviceDistinctAccounts, deviceAnonUploads } = await loadPassportActorLedgerFacts(
      client,
      params.verifiedDevicePassportId,
    );

    // (5) BOTH target and every source actor must be positively present on the
    // report's own Passport ledger, as a pseudonymous row at this key version.
    const targetObs = resolveActorObservation(reportAccountId);
    if (!targetObs || targetObs.isAnonymous) {
      // no key (HMAC failure) or an anonymous report — cannot pin a target actor.
      return blockedInsufficient(enabled, { deviceDistinctAccounts, deviceAnonUploads }, durableActorHistoryComplete);
    }
    if (!(await actorPresentOnPassport(client, params.verifiedDevicePassportId, targetObs.actorKey))) {
      return blockedInsufficient(enabled, { deviceDistinctAccounts, deviceAnonUploads }, durableActorHistoryComplete);
    }

    const sourceActorKeys: string[] = [];
    for (const src of crossAccountSources) {
      const srcObs = resolveActorObservation(src);
      if (!srcObs || srcObs.isAnonymous) {
        return blockedInsufficient(enabled, { deviceDistinctAccounts, deviceAnonUploads }, durableActorHistoryComplete);
      }
      if (!(await actorPresentOnPassport(client, params.verifiedDevicePassportId, srcObs.actorKey))) {
        return blockedInsufficient(enabled, { deviceDistinctAccounts, deviceAnonUploads }, durableActorHistoryComplete);
      }
      sourceActorKeys.push(srcObs.actorKey);
    }

    // (3) candidate-derived unordered {target, source} pair count.
    const unorderedDeviceAccountPairCount = crossAccountSources.size;

    // (4) durable actor-ledger co-occurrence on OTHER Passports — the minimum
    // over each source (a pair is corroborated only as strongly as its weakest
    // source, matching the pre-repoint behaviour).
    let minOther = Number.POSITIVE_INFINITY;
    for (const srcKey of sourceActorKeys) {
      const n = await pairOtherPassportActorCoOccurrence(
        client,
        targetObs.actorKey,
        srcKey,
        params.verifiedDevicePassportId,
      );
      if (n < minOther) minOther = n;
    }
    const pairOtherVerifiedPassportCount = Number.isFinite(minOther) ? minOther : null;

    const facts: ConservativeSharedGuardFacts = {
      deviceDistinctAccounts,
      deviceAnonUploads,
      unorderedDeviceAccountPairCount,
      pairOtherVerifiedPassportCount,
    };
    const decision = evaluateConservativeSharedGuard(facts);

    return {
      enabled,
      passed: decision.passed,
      reason: decision.reason,
      durableActorHistoryComplete,
      deviceDistinctAccounts,
      deviceAnonUploads,
      unorderedDeviceAccountPairCount,
      pairOtherVerifiedPassportCount,
    };
  } catch (err) {
    console.error(
      "evaluateDeviceSelfSharedGuard failed (non-fatal — FAIL CLOSED, the Device Passport SELF downgrade is blocked and the match stays counted):",
      err instanceof Error ? err.message : String(err),
    );
    return blockedInsufficient(enabled, undefined, durableActorHistoryComplete);
  }
}
