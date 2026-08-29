import type { Client } from "@libsql/client";
import { DEVICE_PROVENANCE_SHADOW_POLICY_VERSION } from "./device-provenance-shadow";
import {
  classifyDeviceSharednessRisk,
  simulateSharedDevicePolicies,
  SHARED_DEVICE_POLICY_NAMES,
  SHARED_DEVICE_RISK_CATEGORIES,
  type DeviceSharednessFacts,
  type SharedDeviceRiskCategory,
  type SharedDevicePolicyName,
} from "./device-sharedness-risk";

/**
 * ADMIN-ONLY read-time measurement of SHARED-DEVICE FALSE-SELF RISK for the
 * CURRENT same-device SELF downgrade candidates.
 *
 * A browser / profile can be shared by multiple real people. The Preview-gated
 * rule (lib/device-self-scoring-rule.ts) treats "different account + same
 * verified Passport + exact canonical document + no independent backing" as an
 * EFFECTIVE SELF. This module measures, for every current such candidate
 * (as recorded by lib/device-provenance-shadow.ts's telemetry), how shared its
 * Passport looks, and simulates four hypothetical shared-device guard policies
 * against it — so the risk can be quantified before any Production rollout.
 *
 * MEASUREMENT ONLY — this module:
 *   - issues SELECT statements exclusively. It NEVER runs INSERT / UPDATE /
 *     DELETE / DDL against any table (see this module's own structural test,
 *     tests/device-sharedness-measurement.test.mjs).
 *   - never imports or calls anything on the similarity-scoring or
 *     relationship-classification path (lib/unified-similarity.ts,
 *     lib/report-primary-similarity.ts, lib/user-submission-matching.ts,
 *     lib/report-historical-match.ts, lib/device-self-scoring-rule.ts, …). It
 *     re-uses the shadow telemetry's OWN recorded `wouldDowngrade` value as
 *     "Policy A" — it never recomputes the same-device classification, so the
 *     simulation can never diverge from the observed telemetry for Policy A.
 *   - performs NO authorization check of its own — every caller MUST gate on
 *     lib/auth-session.ts's getAdminSessionUser()/getAdminSessionUserByToken()
 *     first, exactly like lib/developer-repo.ts and
 *     lib/device-provenance-shadow-measurement.ts.
 *
 * IDENTITY HANDLING: account ids, Passport ids, the report device_key, and
 * admission source_ref strings are read into server-local memory ONLY to run
 * the SELECT joins and to (a) group candidates into UNORDERED {account, account}
 * pairs (A→B and B→A are one pair) and (b) count how many distinct verified
 * Passports a given pair has been seen on, with and without the candidate's own
 * Passport. NONE of them is ever returned, logged, or persisted.
 * EVERY field of the returned summary is a bounded count, enum, or boolean —
 * the ONLY per-row identifier surfaced is `reportId` (not an account identity,
 * not a device-passport identifier, and — unlike device_key — not usable to
 * correlate reports across a browser). See the module's structural / canary
 * privacy test.
 *
 * WHAT THE SCHEMA CANNOT PROVE CLEANLY (reported, never invented):
 *   - The shadow row does not store WHICH matched representation triggered the
 *     downgrade — only bounded aggregates. Candidate representations are
 *     recovered by joining report_historical_match_snapshots.result_json and
 *     re-applying the coarse pre-filter (counted relationship + exact canonical
 *     match) then checking for a live same-device admission backing. If that
 *     snapshot was recomputed/pruned after the shadow row was written, this
 *     recovery can under-count; such candidates are surfaced as
 *     `representationDrift` and their pair-level facts are reported as null
 *     (which fails policies B/C/D CLOSED — they block the downgrade).
 *   - Source account is only recoverable when the same-device admission
 *     backing's source_ref is the canonical `report-upload:account=…:device=…`
 *     format. Bulk-import / non-report source_refs carry no account; those are
 *     counted as `sourceAccountUnresolved`, never guessed.
 *   - "Pair observed together on a Passport" is defined as "both accounts have
 *     a saved_reports row under that Passport". A contributing report that was
 *     later deleted (its admission backing survives) undercounts the pair's
 *     shared-Passport total.
 *   - deviceDistinctAccounts is a LIVE recount here; the value the rule saw
 *     when the shadow ran (evidence.deviceDistinctAccounts) is echoed
 *     separately as `deviceDistinctAccountsAtShadow` so drift is visible.
 *   - The telemetry only contains reports viewed/finalized after the Phase 4
 *     wiring while DEVICE_PASSPORT_ENABLED was on — it is a census of OBSERVED
 *     candidates, not of all historical same-device exact matches.
 */

const POLICY = DEVICE_PROVENANCE_SHADOW_POLICY_VERSION;

/** Canonical prefix of buildReportAdmissionSourceRef output — `report-upload:account=` (22 chars). Kept as a literal here (this module must not import the heavier admission modules); the length is asserted in the structural test. */
const SOURCE_REF_ACCOUNT_PREFIX = "report-upload:account=";
const SOURCE_REF_DEVICE_DELIM = ":device=";

/** Relationships whose matched words production counts toward similarity — the only ones the same-device SELF rule can ever downgrade (mirrors lib/device-self-scoring-rule.ts's productionCountsRelationship, kept as a local literal set so this module imports nothing on the scoring path). */
const COUNTED_RELATIONSHIPS = new Set(["PRIOR_SUBMISSION", "TURNITPLUS_CORPUS_SOURCE"]);

export const DEFAULT_SHARED_DEVICE_RECENT_LIMIT = 25;
export const MAX_SHARED_DEVICE_RECENT_LIMIT = 100;
/** Defensive ceiling on how many candidates are fully analysed in one call — mirrors lib/report-primary-similarity.ts's MAX_DEVICE_SELF_REPRESENTATIONS discipline. */
export const MAX_SHARED_DEVICE_CANDIDATES = 500;

export type SharedDeviceRiskRecentRow = {
  reportId: string;
  /** production_relationship column on the shadow row — the current production relationship. */
  productionRelationship: string | null;
  /** proposed_relationship column on the shadow row — the proposed SELF (or null). */
  proposedRelationship: string | null;
  exactCanonical: boolean | null;
  sameVerifiedDevice: boolean | null;
  independentBackingCount: number | null;
  deviceDistinctAccounts: number | null;
  deviceSubmissionCount: number | null;
  deviceAnonUploads: number | null;
  deviceDistinctAccountsAtShadow: number | null;
  unorderedDeviceAccountPairCount: number | null;
  candidateSourceAccountCount: number;
  pairSharedPassportCount: number | null;
  pairOtherVerifiedPassportCount: number | null;
  sourceAccountUnresolved: boolean;
  targetAnonymous: boolean;
  representationDrift: boolean;
  policyA: boolean;
  policyB: boolean;
  policyC: boolean;
  policyD: boolean;
  riskCategory: SharedDeviceRiskCategory;
  riskRationale: string;
  computedAt: string;
};

export type SharedDeviceRiskMeasurement = {
  policyVersion: string;
  generatedAt: string;
  totals: {
    /** current Policy-A candidates found in the telemetry. */
    wouldDowngradeCandidates: number;
    /** fully analysed this call (== wouldDowngradeCandidates unless the cap was hit). */
    candidatesEvaluated: number;
    /** skipped because MAX_SHARED_DEVICE_CANDIDATES was reached. */
    candidatesCapped: number;
    /** shadow row exists but its saved_reports row does not. */
    candidatesMissingReportRow: number;
    /** saved_reports row exists but verified_device_passport_id is null (anomaly — a Policy-A candidate should always have one). */
    candidatesMissingPassport: number;
    /** no report_historical_match_snapshots row to recover matched representations from. */
    candidatesMissingSnapshot: number;
    /** snapshot had no counted+exact representation with a live same-device backing (telemetry/snapshot drift). */
    candidatesRepresentationDrift: number;
    /** ≥1 downgraded representation's same-device backing had an unparseable source_ref. */
    candidatesSourceAccountUnresolved: number;
    /** the candidate report itself was uploaded anonymously (no target account → no pair). */
    candidatesTargetAnonymous: number;
  };
  /** candidates bucketed by their Passport's LIVE distinct-account count. */
  deviceAccountCountBuckets: { one: number; two: number; threePlus: number; unknown: number };
  /** candidates whose Passport has ≥1 anonymous upload. */
  candidatesOnDevicesWithAnonUploads: number;
  /** candidates whose (target, source) pair shares exactly 1 verified Passport. */
  pairSharesExactlyOnePassport: number;
  /** candidates whose (target, source) pair shares ≥2 verified Passports. */
  pairSharesTwoOrMorePassports: number;
  /** candidates for which no pair shared-Passport count could be computed. */
  pairSharedPassportUnknown: number;
  /** distinct verified Passports carrying ≥1 evaluated candidate. */
  distinctCandidateDevices: number;
  /** Passports carrying exactly 1 distinct UNORDERED candidate account-pair. */
  devicesWithExactlyOnePair: number;
  /** Passports carrying ≥2 distinct UNORDERED candidate account-pairs (Case 4). */
  devicesWithMultiplePairs: number;
  /** Passports carrying candidates but with 0 resolvable pairs. */
  devicesWithNoResolvablePair: number;
  /** risk category → candidate count. */
  riskCategoryDistribution: Record<SharedDeviceRiskCategory, number>;
  /** each hypothetical policy → how many current Policy-A candidates it keeps as SELF vs blocks. */
  policyImpact: Record<SharedDevicePolicyName, { kept: number; blocked: number }>;
  recentCandidatesLimit: number;
  recentCandidates: SharedDeviceRiskRecentRow[];
};

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0) || 0;
}
function evBool(ev: Record<string, unknown>, key: string): boolean | null {
  const v = ev[key];
  return typeof v === "boolean" ? v : null;
}
function evNum(ev: Record<string, unknown>, key: string): number | null {
  const v = ev[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Extract the account id from a canonical report-upload source_ref, or null. Pure string work — no wildcard, no injection surface. */
function accountIdFromSourceRef(sourceRef: string | null | undefined): string | null {
  if (typeof sourceRef !== "string") return null;
  if (!sourceRef.startsWith(SOURCE_REF_ACCOUNT_PREFIX)) return null;
  const delimAt = sourceRef.indexOf(SOURCE_REF_DEVICE_DELIM, SOURCE_REF_ACCOUNT_PREFIX.length);
  if (delimAt <= SOURCE_REF_ACCOUNT_PREFIX.length) return null;
  return sourceRef.slice(SOURCE_REF_ACCOUNT_PREFIX.length, delimAt);
}

type ShadowCandidateRow = {
  report_device_key: string;
  report_id: string;
  production_relationship: string | null;
  proposed_relationship: string | null;
  computed_at: string;
  proposed_evidence: string | null;
};

type PassportSharedness = {
  deviceDistinctAccounts: number;
  deviceSubmissionCount: number;
  deviceAnonUploads: number;
};

async function loadPassportSharedness(client: Client, passportId: string): Promise<PassportSharedness> {
  const row = (
    await client.execute({
      sql: `SELECT
              COUNT(*) AS submissions,
              COUNT(DISTINCT user_id) AS distinct_accounts,
              SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) AS anon
            FROM saved_reports
            WHERE verified_device_passport_id = ?`,
      args: [passportId],
    })
  ).rows[0] as unknown as Record<string, unknown>;
  return {
    deviceSubmissionCount: num(row?.submissions),
    deviceDistinctAccounts: num(row?.distinct_accounts),
    deviceAnonUploads: num(row?.anon),
  };
}

/**
 * Distinct verified Passports on which BOTH accounts have a saved_reports row.
 * When `excludePassportId` is given, that Passport is not counted — the result
 * is then "OTHER verified Passports the pair co-occurs on" (Policy D Branch A).
 */
async function pairSharedPassportCount(
  client: Client,
  accountA: string,
  accountB: string,
  excludePassportId?: string | null,
): Promise<number> {
  const exclude = excludePassportId ?? null;
  const row = (
    await client.execute({
      sql: `SELECT COUNT(*) AS n FROM (
              SELECT verified_device_passport_id
              FROM saved_reports
              WHERE verified_device_passport_id IS NOT NULL
                AND (? IS NULL OR verified_device_passport_id <> ?)
                AND user_id IN (?, ?)
              GROUP BY verified_device_passport_id
              HAVING COUNT(DISTINCT user_id) >= 2
            )`,
      args: [exclude, exclude, accountA, accountB],
    })
  ).rows[0] as unknown as Record<string, unknown>;
  return num(row?.n);
}

/**
 * Source account ids for the same-device admission backings of one matched
 * representation on one Passport. Also reports whether any such backing had an
 * unparseable source_ref. Mirrors lib/submission-provenance.ts's own
 * admission-backing join shape (status='indexed' AND accepted representation
 * not revoked).
 */
async function sameDeviceSourceAccounts(
  client: Client,
  representationId: string,
  passportId: string,
): Promise<{ accounts: Set<string>; unresolved: boolean }> {
  const rows = (
    await client.execute({
      sql: `SELECT d.source_ref AS source_ref
            FROM corpus_admission_promotions p
            JOIN corpus_admission_accepted_representations ar ON ar.id = p.accepted_representation_id
            JOIN corpus_admission_decisions d ON d.id = ar.decision_id
            JOIN corpus_admission_decision_device_provenance cadp ON cadp.decision_id = d.id
            WHERE p.representation_id = ?
              AND p.status = 'indexed'
              AND ar.revoked_at IS NULL
              AND cadp.device_passport_id = ?`,
      args: [representationId, passportId],
    })
  ).rows as unknown as { source_ref: string | null }[];
  const accounts = new Set<string>();
  let unresolved = false;
  for (const r of rows) {
    const acc = accountIdFromSourceRef(r.source_ref);
    if (acc) accounts.add(acc);
    else unresolved = true;
  }
  return { accounts, unresolved };
}

type MatchEntry = { matchedRepresentationId?: unknown; relationshipType?: unknown; matchType?: unknown };

/** Counted + exact-canonical matched representation ids from a snapshot result_json. */
function countedExactRepresentationIds(resultJson: string | null | undefined): string[] {
  if (!resultJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(resultJson));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of parsed as MatchEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.matchedRepresentationId === "string" ? raw.matchedRepresentationId : null;
    if (!id || seen.has(id)) continue;
    if (typeof raw.relationshipType !== "string" || !COUNTED_RELATIONSHIPS.has(raw.relationshipType)) continue;
    if (raw.matchType !== "EXACT_CANONICAL_MATCH") continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

type EvaluatedCandidate = {
  row: ShadowCandidateRow;
  evidence: Record<string, unknown>;
  passportId: string | null;
  targetAccountId: string | null;
  missingReportRow: boolean;
  missingSnapshot: boolean;
  representationDrift: boolean;
  sourceAccountUnresolved: boolean;
  sharedness: PassportSharedness | null;
  /** distinct UNORDERED {account, account} pairs for THIS candidate, as sorted `${lo}::${hi}` keys — A→B and B→A collapse to one. */
  pairKeys: Set<string>;
  sourceAccountIds: Set<string>;
  /** least-corroborated pair's shared-Passport count INCLUDING this candidate's own Passport. */
  pairSharedPassportCount: number | null;
  /** the same pair, EXCLUDING this candidate's own Passport (Policy D Branch A). */
  pairOtherVerifiedPassportCount: number | null;
};

export async function summarizeSharedDeviceRiskMeasurement(
  client: Client,
  opts?: { recentLimit?: number },
): Promise<SharedDeviceRiskMeasurement> {
  const recentLimit = Math.min(
    MAX_SHARED_DEVICE_RECENT_LIMIT,
    Math.max(
      1,
      Math.floor(opts?.recentLimit ?? DEFAULT_SHARED_DEVICE_RECENT_LIMIT) || DEFAULT_SHARED_DEVICE_RECENT_LIMIT,
    ),
  );

  // (1) every current Policy-A candidate: a device-provenance-shadow-v1 row
  // whose OWN recorded wouldDowngrade is true. Ordered newest-first so a cap
  // keeps the most recent.
  const candidateRows = (
    await client.execute({
      sql: `SELECT report_device_key, report_id, production_relationship, proposed_relationship,
                   computed_at, proposed_evidence
            FROM historical_match_shadow_evaluations
            WHERE policy_version = ?
              AND json_valid(proposed_evidence)
              AND json_extract(proposed_evidence, '$.wouldDowngrade') IN (1, 'true')
            ORDER BY computed_at DESC, id DESC`,
      args: [POLICY],
    })
  ).rows as unknown as ShadowCandidateRow[];

  const wouldDowngradeCandidates = candidateRows.length;
  const toEvaluate = candidateRows.slice(0, MAX_SHARED_DEVICE_CANDIDATES);
  const candidatesCapped = wouldDowngradeCandidates - toEvaluate.length;

  // caches — the same Passport / account-pair recurs across candidates.
  const sharednessCache = new Map<string, PassportSharedness>();
  const pairPassportCache = new Map<string, number>();
  const pairOtherPassportCache = new Map<string, number>();

  const evaluated: EvaluatedCandidate[] = [];

  for (const row of toEvaluate) {
    let evidence: Record<string, unknown> = {};
    try {
      const parsed = row.proposed_evidence ? JSON.parse(String(row.proposed_evidence)) : {};
      if (parsed && typeof parsed === "object") evidence = parsed as Record<string, unknown>;
    } catch {
      evidence = {};
    }

    // (2) the report's immutable verified upload Passport + owner account.
    const reportRow = (
      await client.execute({
        sql: `SELECT user_id, verified_device_passport_id
              FROM saved_reports WHERE device_key = ? AND id = ?`,
        args: [row.report_device_key, row.report_id],
      })
    ).rows[0] as unknown as { user_id: string | null; verified_device_passport_id: string | null } | undefined;

    const ec: EvaluatedCandidate = {
      row,
      evidence,
      passportId: reportRow?.verified_device_passport_id ?? null,
      targetAccountId: reportRow?.user_id ?? null,
      missingReportRow: !reportRow,
      missingSnapshot: false,
      representationDrift: false,
      sourceAccountUnresolved: false,
      sharedness: null,
      pairKeys: new Set<string>(),
      sourceAccountIds: new Set<string>(),
      pairSharedPassportCount: null,
      pairOtherVerifiedPassportCount: null,
    };

    if (ec.passportId) {
      // (1)(2)(3) live Passport sharedness.
      let s = sharednessCache.get(ec.passportId);
      if (!s) {
        s = await loadPassportSharedness(client, ec.passportId);
        sharednessCache.set(ec.passportId, s);
      }
      ec.sharedness = s;

      // (7)(8) recover the downgraded representations from the snapshot.
      const snapRow = (
        await client.execute({
          sql: `SELECT result_json FROM report_historical_match_snapshots
                WHERE report_device_key = ? AND report_id = ?`,
          args: [row.report_device_key, row.report_id],
        })
      ).rows[0] as unknown as { result_json: string | null } | undefined;

      if (!snapRow) {
        ec.missingSnapshot = true;
      } else {
        const repIds = countedExactRepresentationIds(snapRow.result_json);
        let anyLiveSameDeviceBacking = false;
        for (const repId of repIds) {
          const { accounts, unresolved } = await sameDeviceSourceAccounts(client, repId, ec.passportId);
          if (accounts.size > 0 || unresolved) anyLiveSameDeviceBacking = true;
          if (unresolved) ec.sourceAccountUnresolved = true;
          for (const acc of accounts) {
            if (ec.targetAccountId && acc !== ec.targetAccountId) {
              ec.sourceAccountIds.add(acc);
              const [lo, hi] =
                ec.targetAccountId < acc ? [ec.targetAccountId, acc] : [acc, ec.targetAccountId];
              ec.pairKeys.add(`${lo}::${hi}`);
            }
          }
        }
        if (!anyLiveSameDeviceBacking) ec.representationDrift = true;
      }

      // (5)(6) shared-Passport count for the candidate's least-corroborated
      // pair — both INCLUDING (Policy C) and EXCLUDING (Policy D Branch A) this
      // candidate's own Passport. The pair with the fewest total shared
      // Passports is the least-corroborated one; its "other" count is reported
      // alongside so the two figures always describe the same pair.
      if (ec.targetAccountId && ec.sourceAccountIds.size > 0) {
        let minShared = Infinity;
        let otherForMin: number | null = null;
        for (const src of ec.sourceAccountIds) {
          const [lo, hi] = ec.targetAccountId < src ? [ec.targetAccountId, src] : [src, ec.targetAccountId];
          const key = `${lo}::${hi}`;
          let n = pairPassportCache.get(key);
          if (n === undefined) {
            n = await pairSharedPassportCount(client, lo, hi);
            pairPassportCache.set(key, n);
          }
          const otherKey = ec.passportId ? `${key}::~${ec.passportId}` : key;
          let other = pairOtherPassportCache.get(otherKey);
          if (other === undefined) {
            other = await pairSharedPassportCount(client, lo, hi, ec.passportId);
            pairOtherPassportCache.set(otherKey, other);
          }
          if (n < minShared) {
            minShared = n;
            otherForMin = other;
          }
        }
        ec.pairSharedPassportCount = Number.isFinite(minShared) ? minShared : null;
        ec.pairOtherVerifiedPassportCount = otherForMin;
      }
    }

    evaluated.push(ec);
  }

  // (8) distinct UNORDERED candidate account-pairs per Passport — needs every
  // candidate on the Passport, so it is computed after the loop.
  const pairsByPassport = new Map<string, Set<string>>();
  const candidatesByPassport = new Map<string, number>();
  for (const ec of evaluated) {
    if (!ec.passportId) continue;
    candidatesByPassport.set(ec.passportId, (candidatesByPassport.get(ec.passportId) ?? 0) + 1);
    let set = pairsByPassport.get(ec.passportId);
    if (!set) {
      set = new Set<string>();
      pairsByPassport.set(ec.passportId, set);
    }
    for (const pk of ec.pairKeys) set.add(pk);
  }

  // ---- aggregate ----------------------------------------------------------
  const totals = {
    wouldDowngradeCandidates,
    candidatesEvaluated: evaluated.length,
    candidatesCapped,
    candidatesMissingReportRow: 0,
    candidatesMissingPassport: 0,
    candidatesMissingSnapshot: 0,
    candidatesRepresentationDrift: 0,
    candidatesSourceAccountUnresolved: 0,
    candidatesTargetAnonymous: 0,
  };
  const deviceAccountCountBuckets = { one: 0, two: 0, threePlus: 0, unknown: 0 };
  let candidatesOnDevicesWithAnonUploads = 0;
  let pairSharesExactlyOnePassport = 0;
  let pairSharesTwoOrMorePassports = 0;
  let pairSharedPassportUnknown = 0;
  const riskCategoryDistribution = Object.fromEntries(
    SHARED_DEVICE_RISK_CATEGORIES.map((c) => [c, 0]),
  ) as Record<SharedDeviceRiskCategory, number>;
  const policyImpact = Object.fromEntries(
    SHARED_DEVICE_POLICY_NAMES.map((p) => [p, { kept: 0, blocked: 0 }]),
  ) as Record<SharedDevicePolicyName, { kept: number; blocked: number }>;

  const recent: SharedDeviceRiskRecentRow[] = [];

  for (const ec of evaluated) {
    if (ec.missingReportRow) totals.candidatesMissingReportRow += 1;
    if (!ec.missingReportRow && !ec.passportId) totals.candidatesMissingPassport += 1;
    if (ec.missingSnapshot) totals.candidatesMissingSnapshot += 1;
    if (ec.representationDrift) totals.candidatesRepresentationDrift += 1;
    if (ec.sourceAccountUnresolved) totals.candidatesSourceAccountUnresolved += 1;

    const targetAnonymous = !ec.missingReportRow && ec.targetAccountId === null;
    if (targetAnonymous) totals.candidatesTargetAnonymous += 1;

    const unorderedPairCount = ec.passportId ? (pairsByPassport.get(ec.passportId)?.size ?? 0) : null;

    const facts: DeviceSharednessFacts = {
      deviceDistinctAccounts: ec.sharedness?.deviceDistinctAccounts ?? null,
      deviceSubmissionCount: ec.sharedness?.deviceSubmissionCount ?? null,
      deviceAnonUploads: ec.sharedness?.deviceAnonUploads ?? null,
      // a candidate with no resolvable pair contributes no pair to its
      // Passport's count; expose null (unknown) rather than 0 in that case so
      // the classifier does not read "0 pairs" as "not shared".
      unorderedDeviceAccountPairCount:
        unorderedPairCount === null ? null : unorderedPairCount === 0 ? null : unorderedPairCount,
      pairSharedPassportCount: ec.pairSharedPassportCount,
      pairOtherVerifiedPassportCount: ec.pairOtherVerifiedPassportCount,
      candidateSourceAccountCount: ec.sourceAccountIds.size,
      sourceAccountUnresolved: ec.sourceAccountUnresolved,
      targetAnonymous,
    };

    const assessment = classifyDeviceSharednessRisk(facts);
    riskCategoryDistribution[assessment.category] += 1;

    const sim = simulateSharedDevicePolicies({
      currentRuleWouldDowngrade: true, // by construction: these are the wouldDowngrade rows
      deviceDistinctAccounts: facts.deviceDistinctAccounts,
      deviceAnonUploads: facts.deviceAnonUploads,
      unorderedDeviceAccountPairCount: facts.unorderedDeviceAccountPairCount,
      pairSharedPassportCount: facts.pairSharedPassportCount,
      pairOtherVerifiedPassportCount: facts.pairOtherVerifiedPassportCount,
    });
    for (const p of SHARED_DEVICE_POLICY_NAMES) {
      if (sim[p]) policyImpact[p].kept += 1;
      else policyImpact[p].blocked += 1;
    }

    // account-count buckets
    const dda = facts.deviceDistinctAccounts;
    if (dda === null) deviceAccountCountBuckets.unknown += 1;
    else if (dda <= 1) deviceAccountCountBuckets.one += 1;
    else if (dda === 2) deviceAccountCountBuckets.two += 1;
    else deviceAccountCountBuckets.threePlus += 1;

    if (facts.deviceAnonUploads !== null && facts.deviceAnonUploads > 0) candidatesOnDevicesWithAnonUploads += 1;

    if (facts.pairSharedPassportCount === null) pairSharedPassportUnknown += 1;
    else if (facts.pairSharedPassportCount >= 2) pairSharesTwoOrMorePassports += 1;
    else pairSharesExactlyOnePassport += 1; // 0 or 1 shared passports -> "exactly one" bucket (the pair's own passport)

    recent.push({
      reportId: ec.row.report_id,
      productionRelationship: ec.row.production_relationship === null ? null : String(ec.row.production_relationship),
      proposedRelationship: ec.row.proposed_relationship === null ? null : String(ec.row.proposed_relationship),
      exactCanonical: evBool(ec.evidence, "candidateExactCanonicalMatch"),
      sameVerifiedDevice: evBool(ec.evidence, "candidateSameVerifiedDeviceBacking"),
      independentBackingCount: evNum(ec.evidence, "candidateIndependentBackingCount"),
      deviceDistinctAccounts: facts.deviceDistinctAccounts,
      deviceSubmissionCount: facts.deviceSubmissionCount,
      deviceAnonUploads: facts.deviceAnonUploads,
      deviceDistinctAccountsAtShadow: evNum(ec.evidence, "deviceDistinctAccounts"),
      unorderedDeviceAccountPairCount: facts.unorderedDeviceAccountPairCount,
      candidateSourceAccountCount: facts.candidateSourceAccountCount,
      pairSharedPassportCount: facts.pairSharedPassportCount,
      pairOtherVerifiedPassportCount: facts.pairOtherVerifiedPassportCount,
      sourceAccountUnresolved: ec.sourceAccountUnresolved,
      targetAnonymous,
      representationDrift: ec.representationDrift,
      policyA: sim.CURRENT_PREVIEW,
      policyB: sim.TWO_ACCOUNT_MAX,
      policyC: sim.MULTI_PASSPORT_PAIR,
      policyD: sim.CONSERVATIVE_COMBINED,
      riskCategory: assessment.category,
      riskRationale: assessment.rationale,
      computedAt: String(ec.row.computed_at),
    });
  }

  let devicesWithExactlyOnePair = 0;
  let devicesWithMultiplePairs = 0;
  let devicesWithNoResolvablePair = 0;
  for (const [, pairs] of pairsByPassport) {
    if (pairs.size === 0) devicesWithNoResolvablePair += 1;
    else if (pairs.size === 1) devicesWithExactlyOnePair += 1;
    else devicesWithMultiplePairs += 1;
  }

  return {
    policyVersion: POLICY,
    generatedAt: new Date().toISOString(),
    totals,
    deviceAccountCountBuckets,
    candidatesOnDevicesWithAnonUploads,
    pairSharesExactlyOnePassport,
    pairSharesTwoOrMorePassports,
    pairSharedPassportUnknown,
    distinctCandidateDevices: pairsByPassport.size,
    devicesWithExactlyOnePair,
    devicesWithMultiplePairs,
    devicesWithNoResolvablePair,
    riskCategoryDistribution,
    policyImpact,
    recentCandidatesLimit: recentLimit,
    recentCandidates: recent.slice(0, recentLimit),
  };
}
