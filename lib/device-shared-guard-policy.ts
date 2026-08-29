/**
 * Device Passport — refined CONSERVATIVE_COMBINED (Policy D) SHARED-DEVICE
 * SCORING GUARD. This is the ONE canonical, pure definition of the refined
 * Policy D, shared VERBATIM by:
 *
 *   - lib/device-sharedness-risk.ts's simulateSharedDevicePolicies — the
 *     ADMIN measurement / A-B-C-D simulation (SIMULATION ONLY, never scoring),
 *     and
 *   - lib/device-shared-guard.ts — the PRODUCTION Device Passport SELF scoring
 *     guard, gated on DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED
 *     (lib/device-passport-server.ts's isDevicePassportConservativeSharedGuardEnabled).
 *
 * Extracted so the simulated Policy-D column an admin sees and the scored
 * guard decision are computed by the SAME code and can never drift. The two
 * consumers GATHER the four bounded facts differently — measurement recovers
 * them from the device-provenance shadow telemetry, scoring derives them live
 * from durable provenance — but the DECISION over those facts lives only here.
 *
 * PURE: no database, no environment reads, no I/O, never throws. It consumes
 * four already-computed bounded facts (counts, each `number | null`) and
 * returns a bounded decision (booleans + one short enum). It carries NO
 * passport id, account id, email, device identifier, IP, source_ref, public
 * key, or any secret.
 *
 * FAIL CLOSED: any fact a branch needs that is null/unknown makes that branch
 * false — "we could not prove the pair is safe" must never read as "safe".
 */

/**
 * Policy D Branch A threshold: the (target, source) account pair must have been
 * observed together on at least this many verified Passports OTHER than the
 * candidate's own before a corroborated-pair downgrade is allowed. Stated as
 * "≥1 other Passport" (not "≥2 total") so it does not depend on whether the
 * pair also happens to co-occur on the candidate's own Passport.
 */
export const BRANCH_A_OTHER_PASSPORT_MIN = 1;

export type ConservativeSharedGuardFacts = {
  /**
   * Distinct non-null account ids ever seen uploading a report under the
   * candidate report's verified upload Passport (COUNT(DISTINCT user_id),
   * which excludes anonymous uploads). null when it could not be computed.
   */
  deviceDistinctAccounts: number | null;
  /** Reports uploaded under that Passport with no account (anonymous). null when it could not be computed. */
  deviceAnonUploads: number | null;
  /**
   * Distinct UNORDERED {target account, source account} candidate pairs derived
   * for THIS report's Device Passport SELF evaluation — A→B and B→A collapse to
   * one. null when no source account could be resolved.
   */
  unorderedDeviceAccountPairCount: number | null;
  /**
   * For the candidate's (target, source) pair: how many verified Passports
   * OTHER than the candidate's own that pair has been observed together on.
   * null when no source account could be resolved.
   */
  pairOtherVerifiedPassportCount: number | null;
};

/**
 * Why the guard kept or blocked the Device Passport SELF downgrade. Bounded
 * enum — no identity.
 *
 *   PAIR_OTHER_PASSPORT           kept — Branch A: exactly 2 accounts, 0 anon,
 *                                 and the pair recurs on ≥1 other verified Passport.
 *   LOW_RISK_SINGLE_PAIR          kept — Branch B: exactly 2 accounts, 0 anon,
 *                                 exactly one candidate account-pair on the Passport.
 *   BLOCKED_ACCOUNT_FANOUT        blocked — the Passport carries ≥3 distinct accounts.
 *   BLOCKED_ANONYMOUS_USE         blocked — the Passport carries ≥1 anonymous upload.
 *   BLOCKED_MULTIPLE_PAIRS        blocked — ≥2 distinct candidate account-pairs and no
 *                                 cross-Passport corroboration (Branch A did not qualify).
 *   BLOCKED_INCOMPLETE_ACTOR_HISTORY blocked — the report's own verified Passport
 *                                 exists but its durable actor-usage history is
 *                                 not proven complete (actor_usage_tracking_version
 *                                 < 1). Produced by lib/device-shared-guard.ts
 *                                 BEFORE this pure decision runs — the pure policy
 *                                 itself never returns it.
 *   BLOCKED_INSUFFICIENT_EVIDENCE blocked — a required fact was null/unknown, or a
 *                                 degenerate account count, or a DB/query/HMAC
 *                                 failure, or missing durable membership, or the
 *                                 pair could not be shown safe by either branch.
 *   NOT_APPLIED                   the guard did not act (flag off, no SELF candidate,
 *                                 or a same-account-only candidate — see the
 *                                 SAME-ACCOUNT rule).
 */
export type ConservativeSharedGuardReason =
  | "PAIR_OTHER_PASSPORT"
  | "LOW_RISK_SINGLE_PAIR"
  | "BLOCKED_ACCOUNT_FANOUT"
  | "BLOCKED_ANONYMOUS_USE"
  | "BLOCKED_MULTIPLE_PAIRS"
  | "BLOCKED_INCOMPLETE_ACTOR_HISTORY"
  | "BLOCKED_INSUFFICIENT_EVIDENCE"
  | "NOT_APPLIED";

export type ConservativeSharedGuardDecision = {
  /** true => KEEP the Device Passport SELF downgrade; false => block it (the corpus/prior-submission match stays counted). */
  passed: boolean;
  branchA: boolean;
  branchB: boolean;
  reason: ConservativeSharedGuardReason;
};

/**
 * The refined Policy D decision. Both branches share a strict fan-out ceiling
 * on the CURRENT Passport — EXACTLY two distinct accounts AND zero anonymous
 * uploads — so a corroborated pair can NEVER override a 3+ account or
 * anonymous-use Passport. Each `===` test fails closed on null.
 *
 *   Branch A — cross-device corroboration: the (target, source) pair was
 *              observed together on ≥1 OTHER verified Passport.
 *   Branch B — lone shared browser: exactly one candidate account-pair sits on
 *              the Passport.
 *
 * `passed` is Branch A OR Branch B. This function does NOT gate on
 * "the current same-device rule already fired" — that precondition is the
 * caller's (scoring only ever calls this for a representation the pure
 * classifyDeviceSelfMatch already accepted; simulation ANDs it with the
 * recorded wouldDowngrade).
 */
export function evaluateConservativeSharedGuard(
  facts: ConservativeSharedGuardFacts,
): ConservativeSharedGuardDecision {
  const {
    deviceDistinctAccounts,
    deviceAnonUploads,
    unorderedDeviceAccountPairCount,
    pairOtherVerifiedPassportCount,
  } = facts;

  const twoAccountsNoAnon = deviceDistinctAccounts === 2 && deviceAnonUploads === 0;

  const branchA =
    twoAccountsNoAnon &&
    pairOtherVerifiedPassportCount !== null &&
    pairOtherVerifiedPassportCount >= BRANCH_A_OTHER_PASSPORT_MIN;

  const branchB = twoAccountsNoAnon && unorderedDeviceAccountPairCount === 1;

  const passed = branchA || branchB;

  let reason: ConservativeSharedGuardReason;
  if (branchA) {
    reason = "PAIR_OTHER_PASSPORT";
  } else if (branchB) {
    reason = "LOW_RISK_SINGLE_PAIR";
  } else if (deviceDistinctAccounts === null || deviceAnonUploads === null) {
    reason = "BLOCKED_INSUFFICIENT_EVIDENCE";
  } else if (deviceDistinctAccounts >= 3) {
    reason = "BLOCKED_ACCOUNT_FANOUT";
  } else if (deviceDistinctAccounts !== 2) {
    // 0 or 1 distinct accounts — degenerate for a cross-account SELF candidate.
    reason = "BLOCKED_INSUFFICIENT_EVIDENCE";
  } else if (deviceAnonUploads > 0) {
    reason = "BLOCKED_ANONYMOUS_USE";
  } else if (unorderedDeviceAccountPairCount !== null && unorderedDeviceAccountPairCount >= 2) {
    reason = "BLOCKED_MULTIPLE_PAIRS";
  } else {
    // exactly 2 accounts, 0 anon, but neither branch could prove the pair safe
    // (pair facts null, or exactly-1-pair with 0 other-Passport corroboration
    // — which is Branch B territory and would already have passed, so this is
    // the null/unknown pair-fact case).
    reason = "BLOCKED_INSUFFICIENT_EVIDENCE";
  }

  return { passed, branchA, branchB, reason };
}
