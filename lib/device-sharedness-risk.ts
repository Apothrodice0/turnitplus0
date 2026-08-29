/**
 * Device Passport — SHARED-DEVICE FALSE-SELF RISK, the ONE pure classifier.
 *
 * A browser/profile can be shared by more than one real person. The
 * Preview-gated same-device SELF rule (lib/device-self-scoring-rule.ts) turns
 * "different account + same verified Passport + exact canonical document + no
 * independent backing" into an EFFECTIVE SELF for scoring. Before that rule is
 * ever considered for Production, we must MEASURE how often those downgrade
 * candidates sit on a Passport that looks genuinely shared between distinct
 * humans rather than one person with two accounts.
 *
 * This module is that measurement's decision core. It is:
 *
 *   PURE — no database, no environment reads, no I/O, never throws. It
 *   consumes already-computed bounded facts (counts / booleans) that
 *   lib/device-sharedness-measurement.ts gathers with SELECT-only queries,
 *   and returns bounded labels.
 *
 *   NOT A SCORING DECISION — every category and every policy result here is a
 *   MEASUREMENT LABEL. Nothing in this module is wired into
 *   computeUnifiedSimilarity, resolvePrimarySimilaritySummary, relationship
 *   resolution, or the DEVICE_PASSPORT_SELF_ENABLED path. "Same browser /
 *   profile ≠ automatically same human" — these labels quantify that risk,
 *   they do not act on it.
 *
 *   IDENTITY-FREE — it carries no Passport id, account id, email, IP, device
 *   key, or source_ref. Only bounded integers, booleans, and short enums.
 *
 * The four hypothetical policies (A/B/C/D) are SIMULATIONS. simulateSharedDevicePolicies
 * reports, for a single current Policy-A candidate, whether each hypothetical
 * shared-device guard would STILL treat it as an effective SELF ("kept") or
 * would block that downgrade ("blocked"). Any fact a policy needs that is
 * unknown (null) fails that policy CLOSED — i.e. the policy blocks the
 * downgrade — because "we could not prove the pair is safe" must never read as
 * "safe".
 */

export type SharedDeviceRiskCategory =
  /** No cross-account / anonymous fan-out visible on the Passport (≤1 distinct actor). A real cross-account SELF candidate should essentially never land here; kept for completeness / non-candidate Passports. */
  | "PERSONAL_LIKELY"
  /** Exactly two distinct actors, one candidate account-pair, no anonymous uploads, pair NOT corroborated on any other Passport. Case 1 — "single shared Passport evidence"; a lone shared browser cannot distinguish "one person, two accounts" from "two people, one browser". */
  | "SHARED_LOW_EVIDENCE"
  /** Two accounts PLUS anonymous uploads on the Passport — a third actor's worth of use, but the account fan-out itself is not yet high. */
  | "SHARED_MULTI_ACCOUNT"
  /** Case 2 (≥3 distinct accounts on the Passport) OR Case 4 (≥2 distinct candidate account-pairs on the Passport). Strong shared-device signal. */
  | "SHARED_HIGH_FANOUT"
  /** Case 3 — the candidate's (target, source) account pair has been observed together on ≥2 cryptographically DISTINCT verified Passports. Much stronger evidence the two accounts are genuinely one operator than a single shared browser profile. */
  | "PAIR_MULTI_PASSPORT"
  /** A required fact was missing or malformed — never guessed. */
  | "UNKNOWN";

/** Case 2 threshold: this many distinct (non-anonymous) accounts on one verified Passport is treated as high shared-device fan-out. */
export const HIGH_FANOUT_ACCOUNT_THRESHOLD = 3;

/** Policy C / D threshold: a (target, source) account pair seen together on at least this many distinct verified Passports is treated as a corroborated pair. */
export const CORROBORATED_PAIR_PASSPORT_THRESHOLD = 2;

export type DeviceSharednessFacts = {
  /**
   * Distinct non-null account ids ever seen uploading a report under this
   * candidate's verified upload Passport (a live recount —
   * COUNT(DISTINCT user_id), which excludes anonymous uploads). null when the
   * Passport could not be resolved.
   */
  deviceDistinctAccounts: number | null;
  /** Total reports ever uploaded under this Passport (lifetime). null when unresolved. */
  deviceSubmissionCount: number | null;
  /** Reports uploaded under this Passport with no account (anonymous). null when unresolved. */
  deviceAnonUploads: number | null;
  /**
   * Distinct (target account, source account) pairs represented by ALL
   * current device-SELF candidates that sit on this same Passport. 1 = a
   * single pair (Case 1 / Case 3 shape); ≥2 = several unrelated pairs on one
   * browser (Case 4). null when it could not be computed.
   */
  deviceAccountPairCount: number | null;
  /**
   * For THIS candidate's least-corroborated (target, source) pair: how many
   * distinct verified Passports has that pair been observed together on.
   * null when no source account could be resolved for the candidate.
   */
  pairSharedPassportCount: number | null;
  /** Number of distinct source accounts resolved for this candidate's downgraded representation(s). 0 ⇒ pair analysis was not possible. */
  candidateSourceAccountCount: number;
  /** true when at least one downgraded representation had a same-device backing whose source account could not be resolved (non-canonical source_ref). */
  sourceAccountUnresolved: boolean;
  /** true when the candidate report itself was uploaded with no account (anonymous target). */
  targetAnonymous: boolean;
};

export type SharedDeviceRiskAssessment = {
  category: SharedDeviceRiskCategory;
  /** Short, human-readable why — for the admin dashboard only. Contains no identity. */
  rationale: string;
  /** The bounded signals that drove the category, echoed back for the dashboard row. */
  signals: {
    effectiveActorCount: number | null;
    highFanoutAccounts: boolean;
    multiplePairsOnDevice: boolean;
    anonUploadsPresent: boolean;
    pairCorroborated: boolean;
  };
};

function effectiveActorCount(facts: DeviceSharednessFacts): number | null {
  if (facts.deviceDistinctAccounts === null) return null;
  const anon = facts.deviceAnonUploads !== null && facts.deviceAnonUploads > 0 ? 1 : 0;
  return facts.deviceDistinctAccounts + anon;
}

/**
 * The single risk label for one current same-device SELF candidate. Ordering
 * is strict precedence, highest-risk-or-most-specific first.
 */
export function classifyDeviceSharednessRisk(facts: DeviceSharednessFacts): SharedDeviceRiskAssessment {
  const actors = effectiveActorCount(facts);
  const anonPresent = facts.deviceAnonUploads !== null && facts.deviceAnonUploads > 0;
  const highFanoutAccounts =
    facts.deviceDistinctAccounts !== null && facts.deviceDistinctAccounts >= HIGH_FANOUT_ACCOUNT_THRESHOLD;
  const multiplePairsOnDevice =
    facts.deviceAccountPairCount !== null && facts.deviceAccountPairCount >= 2;
  const pairCorroborated =
    facts.pairSharedPassportCount !== null &&
    facts.pairSharedPassportCount >= CORROBORATED_PAIR_PASSPORT_THRESHOLD;

  const signals = {
    effectiveActorCount: actors,
    highFanoutAccounts,
    multiplePairsOnDevice,
    anonUploadsPresent: anonPresent,
    pairCorroborated,
  };

  // UNKNOWN — the Passport itself could not be measured. Nothing else is trustworthy.
  if (facts.deviceDistinctAccounts === null) {
    return {
      category: "UNKNOWN",
      rationale: "Verified upload Passport could not be resolved for this candidate — no sharedness facts available.",
      signals,
    };
  }

  // PAIR_MULTI_PASSPORT — the pair is corroborated across cryptographically
  // distinct Passports. Evaluated before the fan-out buckets because it is a
  // qualitatively different (and stronger) piece of evidence about the pair.
  if (pairCorroborated) {
    return {
      category: "PAIR_MULTI_PASSPORT",
      rationale: `The (target, source) account pair has been observed together on ${facts.pairSharedPassportCount} distinct verified Passports — stronger evidence of a single operator than one shared browser profile.`,
      signals,
    };
  }

  // SHARED_HIGH_FANOUT — Case 2 (≥3 accounts) or Case 4 (≥2 candidate pairs on the device).
  if (highFanoutAccounts || multiplePairsOnDevice) {
    const parts: string[] = [];
    if (highFanoutAccounts) parts.push(`${facts.deviceDistinctAccounts} distinct accounts on the Passport`);
    if (multiplePairsOnDevice) parts.push(`${facts.deviceAccountPairCount} distinct candidate account-pairs on the Passport`);
    return {
      category: "SHARED_HIGH_FANOUT",
      rationale: `High shared-device fan-out: ${parts.join("; ")}.`,
      signals,
    };
  }

  // SHARED_MULTI_ACCOUNT — two accounts and also anonymous use (a third actor's worth), fan-out not yet high.
  if (facts.deviceDistinctAccounts === 2 && anonPresent) {
    return {
      category: "SHARED_MULTI_ACCOUNT",
      rationale: `Two accounts plus ${facts.deviceAnonUploads} anonymous upload(s) on the Passport.`,
      signals,
    };
  }

  // SHARED_LOW_EVIDENCE — exactly two effective actors, single pair. Case 1 / our proven Preview test.
  if (actors !== null && actors === 2) {
    return {
      category: "SHARED_LOW_EVIDENCE",
      rationale:
        "Two distinct actors on a single shared Passport, one account-pair, pair not seen on any other Passport — consistent with either one person using two accounts or two people sharing a browser; a single shared Passport cannot distinguish them.",
      signals,
    };
  }

  // SHARED_LOW_EVIDENCE — ≤1 account but anonymous use present (mild sharing signal).
  if (facts.deviceDistinctAccounts <= 1 && anonPresent) {
    return {
      category: "SHARED_LOW_EVIDENCE",
      rationale: `${facts.deviceDistinctAccounts} account plus ${facts.deviceAnonUploads} anonymous upload(s) on the Passport.`,
      signals,
    };
  }

  // PERSONAL_LIKELY — no cross-account or anonymous fan-out visible.
  return {
    category: "PERSONAL_LIKELY",
    rationale: `Only ${facts.deviceDistinctAccounts} distinct account and no anonymous uploads on the Passport — no shared-device signal.`,
    signals,
  };
}

export type SharedDevicePolicyInputs = {
  /**
   * The shadow-telemetry row's OWN recorded wouldDowngrade for this report
   * (lib/device-provenance-shadow.ts). Policy A is exactly this value —
   * reproduced, never recomputed — so Policy A can never drift from the
   * existing telemetry.
   */
  currentRuleWouldDowngrade: boolean;
  deviceDistinctAccounts: number | null;
  deviceAnonUploads: number | null;
  /** Distinct candidate account-pairs on this candidate's Passport (see DeviceSharednessFacts.deviceAccountPairCount). */
  deviceAccountPairCount: number | null;
  /** Shared-Passport count for this candidate's least-corroborated (target, source) pair (see DeviceSharednessFacts.pairSharedPassportCount). */
  pairSharedPassportCount: number | null;
};

export type SharedDevicePolicyName =
  | "CURRENT_PREVIEW"
  | "TWO_ACCOUNT_MAX"
  | "MULTI_PASSPORT_PAIR"
  | "CONSERVATIVE_COMBINED";

/** For each hypothetical policy: true = the candidate is STILL an effective SELF ("kept"); false = the policy blocks the downgrade ("blocked"). */
export type SharedDevicePolicySimulation = Record<SharedDevicePolicyName, boolean>;

/**
 * Simulate the four hypothetical shared-device guard policies for ONE current
 * Policy-A candidate. SIMULATION ONLY — not wired into scoring.
 *
 *   A CURRENT_PREVIEW      — today's rule, unchanged.
 *   B TWO_ACCOUNT_MAX      — A AND the Passport has ≤2 distinct accounts.
 *   C MULTI_PASSPORT_PAIR  — A AND the (target, source) pair shares ≥2 verified Passports.
 *   D CONSERVATIVE_COMBINED— A AND ( pair shares ≥2 Passports
 *                                    OR ( ≤2 distinct accounts
 *                                         AND 0 anonymous uploads
 *                                         AND exactly 1 candidate account-pair on the device ) ).
 *
 * Every extra condition fails CLOSED on a null fact (policy blocks the downgrade).
 */
export function simulateSharedDevicePolicies(inputs: SharedDevicePolicyInputs): SharedDevicePolicySimulation {
  const a = inputs.currentRuleWouldDowngrade === true;

  const twoAccountMax =
    a && inputs.deviceDistinctAccounts !== null && inputs.deviceDistinctAccounts <= 2;

  const pairCorroborated =
    inputs.pairSharedPassportCount !== null &&
    inputs.pairSharedPassportCount >= CORROBORATED_PAIR_PASSPORT_THRESHOLD;
  const multiPassportPair = a && pairCorroborated;

  const conservativeSinglePair =
    inputs.deviceDistinctAccounts !== null &&
    inputs.deviceDistinctAccounts <= 2 &&
    inputs.deviceAnonUploads === 0 &&
    inputs.deviceAccountPairCount !== null &&
    inputs.deviceAccountPairCount === 1;
  const conservativeCombined = a && (pairCorroborated || conservativeSinglePair);

  return {
    CURRENT_PREVIEW: a,
    TWO_ACCOUNT_MAX: twoAccountMax,
    MULTI_PASSPORT_PAIR: multiPassportPair,
    CONSERVATIVE_COMBINED: conservativeCombined,
  };
}

export const SHARED_DEVICE_POLICY_NAMES: readonly SharedDevicePolicyName[] = [
  "CURRENT_PREVIEW",
  "TWO_ACCOUNT_MAX",
  "MULTI_PASSPORT_PAIR",
  "CONSERVATIVE_COMBINED",
];

export const SHARED_DEVICE_RISK_CATEGORIES: readonly SharedDeviceRiskCategory[] = [
  "PERSONAL_LIKELY",
  "SHARED_LOW_EVIDENCE",
  "SHARED_MULTI_ACCOUNT",
  "SHARED_HIGH_FANOUT",
  "PAIR_MULTI_PASSPORT",
  "UNKNOWN",
];
