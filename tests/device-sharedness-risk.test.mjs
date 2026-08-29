import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDeviceSharednessRisk,
  simulateSharedDevicePolicies,
  HIGH_FANOUT_ACCOUNT_THRESHOLD,
  CORROBORATED_PAIR_PASSPORT_THRESHOLD,
  BRANCH_A_OTHER_PASSPORT_MIN,
  SHARED_DEVICE_POLICY_NAMES,
  SHARED_DEVICE_RISK_CATEGORIES,
} from "../lib/device-sharedness-risk.ts";

/**
 * Pure shared-device false-SELF RISK classifier (lib/device-sharedness-risk.ts).
 * Deterministic, no DB, no env. These are MEASUREMENT LABELS, never scoring
 * decisions.
 */

const baseFacts = {
  deviceDistinctAccounts: 2,
  deviceSubmissionCount: 3,
  deviceAnonUploads: 0,
  unorderedDeviceAccountPairCount: 1,
  pairSharedPassportCount: 1,
  pairOtherVerifiedPassportCount: 0,
  candidateSourceAccountCount: 1,
  sourceAccountUnresolved: false,
  targetAnonymous: false,
};

test("1. deterministic — identical facts always give an identical assessment", () => {
  const a = classifyDeviceSharednessRisk({ ...baseFacts });
  const b = classifyDeviceSharednessRisk({ ...baseFacts });
  assert.deepEqual(a, b);
  const simInput = {
    currentRuleWouldDowngrade: true,
    deviceDistinctAccounts: 2,
    deviceAnonUploads: 0,
    unorderedDeviceAccountPairCount: 1,
    pairSharedPassportCount: 1,
    pairOtherVerifiedPassportCount: 0,
  };
  assert.deepEqual(simulateSharedDevicePolicies({ ...simInput }), simulateSharedDevicePolicies({ ...simInput }));
  // every declared category / policy name is a real string enum
  assert.ok(SHARED_DEVICE_RISK_CATEGORIES.includes(a.category));
  assert.equal(SHARED_DEVICE_POLICY_NAMES.length, 4);
  assert.equal(BRANCH_A_OTHER_PASSPORT_MIN, 1);
});

test("2. one-account device -> PERSONAL_LIKELY (no anon, no cross-account fan-out)", () => {
  const r = classifyDeviceSharednessRisk({
    ...baseFacts,
    deviceDistinctAccounts: 1,
    deviceAnonUploads: 0,
    unorderedDeviceAccountPairCount: null,
    pairSharedPassportCount: null,
    pairOtherVerifiedPassportCount: null,
    candidateSourceAccountCount: 0,
  });
  assert.equal(r.category, "PERSONAL_LIKELY");
});

test("3. two-account device, single clean pair -> SHARED_LOW_EVIDENCE (Case 1 — single shared Passport evidence, not 'same human')", () => {
  const r = classifyDeviceSharednessRisk({ ...baseFacts });
  assert.equal(r.category, "SHARED_LOW_EVIDENCE");
  assert.match(r.rationale, /single shared Passport cannot distinguish/i);
});

test("4. 3+ accounts on one Passport -> SHARED_HIGH_FANOUT (Case 2)", () => {
  const r = classifyDeviceSharednessRisk({
    ...baseFacts,
    deviceDistinctAccounts: HIGH_FANOUT_ACCOUNT_THRESHOLD,
    unorderedDeviceAccountPairCount: 1,
  });
  assert.equal(r.category, "SHARED_HIGH_FANOUT");
  const r4 = classifyDeviceSharednessRisk({ ...baseFacts, deviceDistinctAccounts: 6 });
  assert.equal(r4.category, "SHARED_HIGH_FANOUT");
});

test("5. anonymous-use device — 2 accounts + anon uploads -> SHARED_MULTI_ACCOUNT; 1 account + anon -> SHARED_LOW_EVIDENCE", () => {
  const twoPlusAnon = classifyDeviceSharednessRisk({ ...baseFacts, deviceDistinctAccounts: 2, deviceAnonUploads: 4 });
  assert.equal(twoPlusAnon.category, "SHARED_MULTI_ACCOUNT");
  const onePlusAnon = classifyDeviceSharednessRisk({
    ...baseFacts,
    deviceDistinctAccounts: 1,
    deviceAnonUploads: 2,
    unorderedDeviceAccountPairCount: null,
    pairSharedPassportCount: null,
    pairOtherVerifiedPassportCount: null,
  });
  assert.equal(onePlusAnon.category, "SHARED_LOW_EVIDENCE");
});

test("6. exactly one account pair on one Passport -> SHARED_LOW_EVIDENCE (unorderedDeviceAccountPairCount === 1)", () => {
  const r = classifyDeviceSharednessRisk({ ...baseFacts, unorderedDeviceAccountPairCount: 1, pairSharedPassportCount: 1 });
  assert.equal(r.category, "SHARED_LOW_EVIDENCE");
});

test("7. one account pair sharing 2+ Passports -> PAIR_MULTI_PASSPORT (Case 3 — stronger than one shared browser)", () => {
  const r = classifyDeviceSharednessRisk({
    ...baseFacts,
    pairSharedPassportCount: CORROBORATED_PAIR_PASSPORT_THRESHOLD,
  });
  assert.equal(r.category, "PAIR_MULTI_PASSPORT");
  // takes precedence even over high fan-out
  const r2 = classifyDeviceSharednessRisk({
    ...baseFacts,
    deviceDistinctAccounts: 5,
    unorderedDeviceAccountPairCount: 3,
    pairSharedPassportCount: 3,
  });
  assert.equal(r2.category, "PAIR_MULTI_PASSPORT");
});

test("8. multiple different UNORDERED account pairs on one Passport -> SHARED_HIGH_FANOUT (Case 4)", () => {
  const r = classifyDeviceSharednessRisk({
    ...baseFacts,
    deviceDistinctAccounts: 2,
    unorderedDeviceAccountPairCount: 2,
    pairSharedPassportCount: 1,
  });
  assert.equal(r.category, "SHARED_HIGH_FANOUT");
  assert.match(r.rationale, /distinct unordered candidate account-pairs/i);
});

test("9. CURRENT_PREVIEW (A) simulation is exactly the recorded wouldDowngrade — never recomputed", () => {
  assert.equal(
    simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: true,
      deviceDistinctAccounts: null,
      deviceAnonUploads: null,
      unorderedDeviceAccountPairCount: null,
      pairSharedPassportCount: null,
      pairOtherVerifiedPassportCount: null,
    }).CURRENT_PREVIEW,
    true,
  );
  assert.equal(
    simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: false,
      deviceDistinctAccounts: 2,
      deviceAnonUploads: 0,
      unorderedDeviceAccountPairCount: 1,
      pairSharedPassportCount: 5,
      pairOtherVerifiedPassportCount: 4,
    }).CURRENT_PREVIEW,
    false,
  );
});

test("10. TWO_ACCOUNT_MAX (B) — A AND <=2 distinct accounts; 3+ accounts blocks; null accounts fails closed", () => {
  const keep = simulateSharedDevicePolicies({
    currentRuleWouldDowngrade: true,
    deviceDistinctAccounts: 2,
    deviceAnonUploads: 0,
    unorderedDeviceAccountPairCount: 1,
    pairSharedPassportCount: 1,
    pairOtherVerifiedPassportCount: 0,
  });
  assert.equal(keep.TWO_ACCOUNT_MAX, true);
  const block = simulateSharedDevicePolicies({
    currentRuleWouldDowngrade: true,
    deviceDistinctAccounts: 3,
    deviceAnonUploads: 0,
    unorderedDeviceAccountPairCount: 1,
    pairSharedPassportCount: 1,
    pairOtherVerifiedPassportCount: 0,
  });
  assert.equal(block.TWO_ACCOUNT_MAX, false);
  const unknown = simulateSharedDevicePolicies({
    currentRuleWouldDowngrade: true,
    deviceDistinctAccounts: null,
    deviceAnonUploads: null,
    unorderedDeviceAccountPairCount: null,
    pairSharedPassportCount: null,
    pairOtherVerifiedPassportCount: null,
  });
  assert.equal(unknown.TWO_ACCOUNT_MAX, false, "null fact fails the policy closed (blocks the downgrade)");
});

test("11. MULTI_PASSPORT_PAIR (C) — A AND pair shares >=2 Passports (own included); 1 blocks; null fails closed", () => {
  assert.equal(
    simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: true,
      deviceDistinctAccounts: 2,
      deviceAnonUploads: 0,
      unorderedDeviceAccountPairCount: 1,
      pairSharedPassportCount: 2,
      pairOtherVerifiedPassportCount: 1,
    }).MULTI_PASSPORT_PAIR,
    true,
  );
  assert.equal(
    simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: true,
      deviceDistinctAccounts: 2,
      deviceAnonUploads: 0,
      unorderedDeviceAccountPairCount: 1,
      pairSharedPassportCount: 1,
      pairOtherVerifiedPassportCount: 0,
    }).MULTI_PASSPORT_PAIR,
    false,
  );
  assert.equal(
    simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: true,
      deviceDistinctAccounts: 2,
      deviceAnonUploads: 0,
      unorderedDeviceAccountPairCount: 1,
      pairSharedPassportCount: null,
      pairOtherVerifiedPassportCount: null,
    }).MULTI_PASSPORT_PAIR,
    false,
  );
});

test("12. CONSERVATIVE_COMBINED (D) — exactly 2 accounts + 0 anon + (>=1 OTHER Passport OR exactly 1 unordered pair)", () => {
  const sim = (o) =>
    simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: true,
      deviceDistinctAccounts: 2,
      deviceAnonUploads: 0,
      unorderedDeviceAccountPairCount: 1,
      pairSharedPassportCount: 1,
      pairOtherVerifiedPassportCount: 0,
      ...o,
    }).CONSERVATIVE_COMBINED;

  // Branch B — lone shared browser: exactly 1 unordered pair, no corroboration needed
  assert.equal(sim({ unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 0 }), true);

  // Branch A — cross-device corroboration: >=1 OTHER Passport, even when Branch B cannot fire
  assert.equal(sim({ unorderedDeviceAccountPairCount: 3, pairOtherVerifiedPassportCount: 1 }), true);

  // neither branch: >1 unordered pair AND 0 other Passports -> blocked
  assert.equal(sim({ unorderedDeviceAccountPairCount: 3, pairOtherVerifiedPassportCount: 0 }), false);

  // fan-out ceiling: 3+ accounts blocks BOTH branches (a corroborated pair does NOT override it)
  assert.equal(sim({ deviceDistinctAccounts: 3, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 9 }), false);

  // fan-out ceiling: any anonymous upload blocks BOTH branches
  assert.equal(sim({ deviceAnonUploads: 2, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 9 }), false);

  // null facts fail closed
  assert.equal(sim({ deviceDistinctAccounts: null }), false);
  assert.equal(sim({ deviceAnonUploads: null }), false);
  assert.equal(sim({ unorderedDeviceAccountPairCount: null, pairOtherVerifiedPassportCount: null }), false);

  // A is false -> every policy is false regardless
  assert.deepEqual(
    simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: false,
      deviceDistinctAccounts: 2,
      deviceAnonUploads: 0,
      unorderedDeviceAccountPairCount: 1,
      pairSharedPassportCount: 9,
      pairOtherVerifiedPassportCount: 9,
    }),
    {
      CURRENT_PREVIEW: false,
      TWO_ACCOUNT_MAX: false,
      MULTI_PASSPORT_PAIR: false,
      CONSERVATIVE_COMBINED: false,
    },
  );
});

test("13. independent backing is out of scope for this pure module — the caller only ever passes wouldDowngrade rows (blocked candidates never reach it)", () => {
  // Documents the contract: this module never sees independentBackingCount.
  // A blocked-by-independent-backing candidate has currentRuleWouldDowngrade
  // === false upstream, so simulate returns all-false.
  const r = simulateSharedDevicePolicies({
    currentRuleWouldDowngrade: false,
    deviceDistinctAccounts: 2,
    deviceAnonUploads: 0,
    unorderedDeviceAccountPairCount: 1,
    pairSharedPassportCount: 1,
    pairOtherVerifiedPassportCount: 0,
  });
  assert.equal(Object.values(r).some(Boolean), false);
});

test("14. malformed / incomplete facts -> UNKNOWN, never a throw", () => {
  const r = classifyDeviceSharednessRisk({
    deviceDistinctAccounts: null,
    deviceSubmissionCount: null,
    deviceAnonUploads: null,
    unorderedDeviceAccountPairCount: null,
    pairSharedPassportCount: null,
    pairOtherVerifiedPassportCount: null,
    candidateSourceAccountCount: 0,
    sourceAccountUnresolved: true,
    targetAnonymous: true,
  });
  assert.equal(r.category, "UNKNOWN");
  assert.equal(r.signals.effectiveActorCount, null);
});

test("15. empty / degenerate — zero everything still classifies deterministically (PERSONAL_LIKELY)", () => {
  const r = classifyDeviceSharednessRisk({
    deviceDistinctAccounts: 0,
    deviceSubmissionCount: 0,
    deviceAnonUploads: 0,
    unorderedDeviceAccountPairCount: null,
    pairSharedPassportCount: null,
    pairOtherVerifiedPassportCount: null,
    candidateSourceAccountCount: 0,
    sourceAccountUnresolved: false,
    targetAnonymous: false,
  });
  assert.equal(r.category, "PERSONAL_LIKELY");
});

test("16. D Branch A passes with exactly 2 accounts, no anon, and >=1 OTHER verified Passport", () => {
  assert.equal(
    simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: true,
      deviceDistinctAccounts: 2,
      deviceAnonUploads: 0,
      unorderedDeviceAccountPairCount: 4, // Branch B cannot fire (!= 1)
      pairSharedPassportCount: 2,
      pairOtherVerifiedPassportCount: 1, // Branch A fires
    }).CONSERVATIVE_COMBINED,
    true,
  );
});

test("17. D Branch A blocks at 3 accounts even with a strongly corroborated pair", () => {
  assert.equal(
    simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: true,
      deviceDistinctAccounts: 3,
      deviceAnonUploads: 0,
      unorderedDeviceAccountPairCount: 1,
      pairSharedPassportCount: 9,
      pairOtherVerifiedPassportCount: 9,
    }).CONSERVATIVE_COMBINED,
    false,
  );
});

test("18. D Branch A blocks when the current Passport has anonymous uploads", () => {
  assert.equal(
    simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: true,
      deviceDistinctAccounts: 2,
      deviceAnonUploads: 3,
      unorderedDeviceAccountPairCount: 1,
      pairSharedPassportCount: 9,
      pairOtherVerifiedPassportCount: 9,
    }).CONSERVATIVE_COMBINED,
    false,
  );
});

test("19. D Branch B requires EXACTLY 2 accounts — 1 or 3 blocks", () => {
  const base = {
    currentRuleWouldDowngrade: true,
    deviceAnonUploads: 0,
    unorderedDeviceAccountPairCount: 1,
    pairSharedPassportCount: 1,
    pairOtherVerifiedPassportCount: 0,
  };
  assert.equal(simulateSharedDevicePolicies({ ...base, deviceDistinctAccounts: 2 }).CONSERVATIVE_COMBINED, true);
  assert.equal(simulateSharedDevicePolicies({ ...base, deviceDistinctAccounts: 1 }).CONSERVATIVE_COMBINED, false);
  assert.equal(simulateSharedDevicePolicies({ ...base, deviceDistinctAccounts: 3 }).CONSERVATIVE_COMBINED, false);
});

test("20. D — any required null/unknown fact fails the policy closed", () => {
  const ok = {
    currentRuleWouldDowngrade: true,
    deviceDistinctAccounts: 2,
    deviceAnonUploads: 0,
    unorderedDeviceAccountPairCount: 1,
    pairSharedPassportCount: 1,
    pairOtherVerifiedPassportCount: 1,
  };
  assert.equal(simulateSharedDevicePolicies(ok).CONSERVATIVE_COMBINED, true);
  assert.equal(simulateSharedDevicePolicies({ ...ok, deviceDistinctAccounts: null }).CONSERVATIVE_COMBINED, false);
  assert.equal(simulateSharedDevicePolicies({ ...ok, deviceAnonUploads: null }).CONSERVATIVE_COMBINED, false);
  assert.equal(
    simulateSharedDevicePolicies({ ...ok, unorderedDeviceAccountPairCount: null, pairOtherVerifiedPassportCount: null })
      .CONSERVATIVE_COMBINED,
    false,
  );
});

console.log("device-sharedness-risk: deterministic + all category cases + refined Policy-D (Branch A/B) simulations + null-safety passed");
