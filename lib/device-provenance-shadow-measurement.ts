import type { Client } from "@libsql/client";
import { DEVICE_PROVENANCE_SHADOW_POLICY_VERSION } from "./device-provenance-shadow";

/**
 * ADMIN-ONLY read-time measurement summary for the Device Passport
 * prior-submission shadow (lib/device-provenance-shadow.ts, policy_version
 * "device-provenance-shadow-v1"). Gives admins a compact aggregate view of
 * how the proposed same-device SELF rule WOULD behave, so it can be
 * measured against real data before any phase wires a score effect.
 *
 * MEASUREMENT ONLY — this module:
 *   - reads exclusively from historical_match_shadow_evaluations (the
 *     existing shadow-telemetry table, drizzle/0021); it issues only SELECT
 *     statements and never INSERT/UPDATE/DELETE.
 *   - never imports or calls anything on the similarity-scoring or
 *     relationship-classification path (lib/unified-similarity.ts,
 *     lib/report-primary-similarity.ts, lib/user-submission-matching.ts,
 *     lib/report-historical-match.ts, …) — see this module's own structural
 *     test (tests/device-provenance-shadow-measurement.test.mjs).
 *   - performs NO authorization check of its own — every caller MUST gate on
 *     lib/auth-session.ts's getAdminSessionUser()/getAdminSessionUserByToken()
 *     first, exactly like lib/developer-repo.ts.
 *
 * PRIVACY: every value returned is a bounded count, enum, boolean, or
 * timestamp. No passport id, account id, email, IP, filename, document hash,
 * or document/passage text is read or returned. The only per-row identifiers
 * are report_id + report_device_key — the same composite key
 * lib/developer-repo.ts's listRecentReportsForDeveloper already exposes to
 * admins so a row can be opened in the report deep-dive; neither is an
 * account identity or a device-passport identifier. Malformed
 * proposed_evidence is counted separately (unparseableEvidence) and excluded
 * from every evidence-derived metric via a json_valid() guard, never
 * silently folded in.
 */

const POLICY = DEVICE_PROVENANCE_SHADOW_POLICY_VERSION;

export const DEFAULT_RECENT_CANDIDATE_LIMIT = 25;
export const MAX_RECENT_CANDIDATE_LIMIT = 100;

export type DeviceProvenanceShadowMeasurement = {
  policyVersion: string;
  generatedAt: string;
  totals: {
    evaluations: number;
    ok: number;
    failed: number;
    /** rows whose proposed_evidence was not valid JSON — excluded from every evidence-derived metric below. */
    unparseableEvidence: number;
    matched: number;
    noHistoricalMatch: number;
  };
  /** (3) proposed rule would reclassify >=1 counted historical match as SELF. */
  wouldDowngradeCount: number;
  /** (4) evidence.reason === "SAME_DEVICE_EXACT_DOCUMENT". */
  sameDeviceExactDocumentCount: number;
  /** (5) strongest candidate had >=1 independent backing. */
  candidateIndependentBackingPositiveCount: number;
  /** (6) the report's verified upload passport is shared across >1 account. */
  sharedDeviceEvaluationCount: number;
  /** (12) >=1 counted+exact+same-device match was blocked from a SELF proposal specifically by an independent backing. */
  blockedByIndependentBackingCount: number;
  /** (7) */
  deviceDistinctAccountsDistribution: { one: number; two: number; threePlus: number; unknown: number };
  /** (8) */
  deviceSubmissionCountDistribution: { one: number; two: number; threeToFive: number; sixPlus: number; unknown: number };
  /** (9) production_relationship column across every evaluation. */
  productionRelationshipDistribution: Record<string, number>;
  /** (10) proposed_relationship column ("SELF" or none). */
  proposedRelationshipDistribution: Record<string, number>;
  /** (11) agreement column ("AGREE" / "DISAGREE_DEVICE_SELF"). */
  agreementDistribution: Record<string, number>;
  /** (13) evaluations with >=1 exact same-device match that did NOT produce a downgrade, grouped by reason. */
  exactSameDeviceNotDowngraded: {
    total: number;
    byReason: Record<string, number>;
    byCandidateReason: Record<string, number>;
  };
  recentCandidatesLimit: number;
  recentCandidates: DeviceProvenanceShadowRecentRow[];
};

export type DeviceProvenanceShadowRecentRow = {
  reportId: string;
  reportDeviceKey: string;
  productionRelationship: string | null;
  proposedRelationship: string | null;
  wouldDowngrade: boolean | null;
  reason: string | null;
  exactCanonical: boolean | null;
  sameVerifiedDevice: boolean | null;
  independentBackingCount: number | null;
  sharedDeviceAccountCount: number | null;
  sharedDeviceSubmissionCount: number | null;
  status: "OK" | "FAILED";
  agreement: string;
  computedAt: string;
  createdAt: string;
};

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0) || 0;
}

function toDistribution(rows: readonly Record<string, unknown>[], keyCol = "k", countCol = "n"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row[keyCol] ?? "(none)")] = num(row[countCol]);
  return out;
}

/** Bounded evidence field access — every value here is a primitive count/enum/boolean, never text/identity. */
function evidenceBool(evidence: Record<string, unknown>, key: string): boolean | null {
  const v = evidence[key];
  return typeof v === "boolean" ? v : null;
}
function evidenceNum(evidence: Record<string, unknown>, key: string): number | null {
  const v = evidence[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function evidenceStr(evidence: Record<string, unknown>, key: string): string | null {
  const v = evidence[key];
  return typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null;
}

export async function summarizeDeviceProvenanceShadowMeasurement(
  client: Client,
  opts?: { recentLimit?: number },
): Promise<DeviceProvenanceShadowMeasurement> {
  const recentLimit = Math.min(
    MAX_RECENT_CANDIDATE_LIMIT,
    Math.max(1, Math.floor(opts?.recentLimit ?? DEFAULT_RECENT_CANDIDATE_LIMIT) || DEFAULT_RECENT_CANDIDATE_LIMIT),
  );

  // (1)(2) + valid-evidence count — column-only, safe on any row.
  const totalsRow = (await client.execute({
    sql: `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'OK' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN production_status = 'MATCHED' THEN 1 ELSE 0 END) AS matched,
            SUM(CASE WHEN production_status = 'NO_HISTORICAL_MATCH' THEN 1 ELSE 0 END) AS no_hist,
            SUM(CASE WHEN json_valid(proposed_evidence) THEN 1 ELSE 0 END) AS valid_ev
          FROM historical_match_shadow_evaluations
          WHERE policy_version = ?`,
    args: [POLICY],
  })).rows[0] as unknown as Record<string, unknown>;

  const total = num(totalsRow.total);
  const validEvidence = num(totalsRow.valid_ev);

  // (3)(4)(5)(6)(12) — evidence-derived scalar counts, only over rows whose
  // proposed_evidence is valid JSON (json_valid guard). json_extract of an
  // absent key (e.g. the {error:true} FAILED marker) returns NULL, so
  // COALESCE(...,0) and IS-NULL handling keep those from inflating a count.
  const evRow = (await client.execute({
    sql: `SELECT
            SUM(CASE WHEN json_extract(proposed_evidence, '$.wouldDowngrade') IN (1, 'true') THEN 1 ELSE 0 END) AS would_downgrade,
            SUM(CASE WHEN json_extract(proposed_evidence, '$.reason') = 'SAME_DEVICE_EXACT_DOCUMENT' THEN 1 ELSE 0 END) AS same_device_exact,
            SUM(CASE WHEN COALESCE(CAST(json_extract(proposed_evidence, '$.candidateIndependentBackingCount') AS INTEGER), 0) > 0 THEN 1 ELSE 0 END) AS cand_indep_positive,
            SUM(CASE WHEN json_extract(proposed_evidence, '$.deviceSharedAcrossAccounts') IN (1, 'true') THEN 1 ELSE 0 END) AS shared_device,
            SUM(CASE WHEN COALESCE(CAST(json_extract(proposed_evidence, '$.independentBlockedCandidateCount') AS INTEGER), 0) > 0 THEN 1 ELSE 0 END) AS blocked_indep
          FROM historical_match_shadow_evaluations
          WHERE policy_version = ? AND json_valid(proposed_evidence)`,
    args: [POLICY],
  })).rows[0] as unknown as Record<string, unknown>;

  // (7) deviceDistinctAccounts buckets.
  const distAcctRow = (await client.execute({
    sql: `SELECT
            SUM(CASE WHEN CAST(json_extract(proposed_evidence, '$.deviceDistinctAccounts') AS INTEGER) = 1 THEN 1 ELSE 0 END) AS one,
            SUM(CASE WHEN CAST(json_extract(proposed_evidence, '$.deviceDistinctAccounts') AS INTEGER) = 2 THEN 1 ELSE 0 END) AS two,
            SUM(CASE WHEN CAST(json_extract(proposed_evidence, '$.deviceDistinctAccounts') AS INTEGER) >= 3 THEN 1 ELSE 0 END) AS three_plus,
            SUM(CASE WHEN json_extract(proposed_evidence, '$.deviceDistinctAccounts') IS NULL THEN 1 ELSE 0 END) AS unknown
          FROM historical_match_shadow_evaluations
          WHERE policy_version = ? AND json_valid(proposed_evidence)`,
    args: [POLICY],
  })).rows[0] as unknown as Record<string, unknown>;

  // (8) deviceSubmissionCount buckets.
  const distSubRow = (await client.execute({
    sql: `SELECT
            SUM(CASE WHEN CAST(json_extract(proposed_evidence, '$.deviceSubmissionCount') AS INTEGER) = 1 THEN 1 ELSE 0 END) AS one,
            SUM(CASE WHEN CAST(json_extract(proposed_evidence, '$.deviceSubmissionCount') AS INTEGER) = 2 THEN 1 ELSE 0 END) AS two,
            SUM(CASE WHEN CAST(json_extract(proposed_evidence, '$.deviceSubmissionCount') AS INTEGER) BETWEEN 3 AND 5 THEN 1 ELSE 0 END) AS three_to_five,
            SUM(CASE WHEN CAST(json_extract(proposed_evidence, '$.deviceSubmissionCount') AS INTEGER) >= 6 THEN 1 ELSE 0 END) AS six_plus,
            SUM(CASE WHEN json_extract(proposed_evidence, '$.deviceSubmissionCount') IS NULL THEN 1 ELSE 0 END) AS unknown
          FROM historical_match_shadow_evaluations
          WHERE policy_version = ? AND json_valid(proposed_evidence)`,
    args: [POLICY],
  })).rows[0] as unknown as Record<string, unknown>;

  // (9)(10)(11) distributions — column-only GROUP BYs, safe on any row.
  const prodRelRows = (await client.execute({
    sql: `SELECT COALESCE(production_relationship, '(none)') AS k, COUNT(*) AS n
          FROM historical_match_shadow_evaluations WHERE policy_version = ? GROUP BY k ORDER BY n DESC`,
    args: [POLICY],
  })).rows as unknown as Record<string, unknown>[];
  const propRelRows = (await client.execute({
    sql: `SELECT COALESCE(proposed_relationship, '(none)') AS k, COUNT(*) AS n
          FROM historical_match_shadow_evaluations WHERE policy_version = ? GROUP BY k ORDER BY n DESC`,
    args: [POLICY],
  })).rows as unknown as Record<string, unknown>[];
  const agreementRows = (await client.execute({
    sql: `SELECT agreement AS k, COUNT(*) AS n
          FROM historical_match_shadow_evaluations WHERE policy_version = ? GROUP BY k ORDER BY n DESC`,
    args: [POLICY],
  })).rows as unknown as Record<string, unknown>[];

  // (13) exact same-device matches that did NOT downgrade, grouped by reason.
  const notDowngradedRows = (await client.execute({
    sql: `SELECT
            COALESCE(json_extract(proposed_evidence, '$.reason'), '(none)') AS reason,
            COALESCE(json_extract(proposed_evidence, '$.candidateReason'), '(none)') AS candidate_reason,
            COUNT(*) AS n
          FROM historical_match_shadow_evaluations
          WHERE policy_version = ? AND json_valid(proposed_evidence)
            AND COALESCE(CAST(json_extract(proposed_evidence, '$.exactSameDeviceMatchCount') AS INTEGER), 0) > 0
            AND (json_extract(proposed_evidence, '$.wouldDowngrade') IS NULL
                 OR json_extract(proposed_evidence, '$.wouldDowngrade') NOT IN (1, 'true'))
          GROUP BY reason, candidate_reason`,
    args: [POLICY],
  })).rows as unknown as Record<string, unknown>[];

  const byReason: Record<string, number> = {};
  const byCandidateReason: Record<string, number> = {};
  let notDowngradedTotal = 0;
  for (const row of notDowngradedRows) {
    const n = num(row.n);
    notDowngradedTotal += n;
    const r = String(row.reason ?? "(none)");
    const cr = String(row.candidate_reason ?? "(none)");
    byReason[r] = (byReason[r] ?? 0) + n;
    byCandidateReason[cr] = (byCandidateReason[cr] ?? 0) + n;
  }

  // bounded recent-candidates table.
  const recentRows = (await client.execute({
    sql: `SELECT report_id, report_device_key, production_relationship, proposed_relationship,
                 agreement, status, computed_at, created_at, proposed_evidence
          FROM historical_match_shadow_evaluations
          WHERE policy_version = ?
          ORDER BY computed_at DESC, id DESC
          LIMIT ?`,
    args: [POLICY, recentLimit],
  })).rows as unknown as Record<string, unknown>[];

  const recentCandidates: DeviceProvenanceShadowRecentRow[] = recentRows.map((row) => {
    let evidence: Record<string, unknown> = {};
    try {
      const parsed = row.proposed_evidence ? JSON.parse(String(row.proposed_evidence)) : {};
      if (parsed && typeof parsed === "object") evidence = parsed as Record<string, unknown>;
    } catch {
      evidence = {};
    }
    return {
      reportId: String(row.report_id),
      reportDeviceKey: String(row.report_device_key),
      productionRelationship: row.production_relationship === null ? null : String(row.production_relationship),
      proposedRelationship: row.proposed_relationship === null ? null : String(row.proposed_relationship),
      wouldDowngrade: evidenceBool(evidence, "wouldDowngrade"),
      reason: evidenceStr(evidence, "reason"),
      exactCanonical: evidenceBool(evidence, "candidateExactCanonicalMatch"),
      sameVerifiedDevice: evidenceBool(evidence, "candidateSameVerifiedDeviceBacking"),
      independentBackingCount: evidenceNum(evidence, "candidateIndependentBackingCount"),
      sharedDeviceAccountCount: evidenceNum(evidence, "deviceDistinctAccounts"),
      sharedDeviceSubmissionCount: evidenceNum(evidence, "deviceSubmissionCount"),
      status: String(row.status) === "FAILED" ? "FAILED" : "OK",
      agreement: String(row.agreement),
      computedAt: String(row.computed_at),
      createdAt: String(row.created_at),
    };
  });

  return {
    policyVersion: POLICY,
    generatedAt: new Date().toISOString(),
    totals: {
      evaluations: total,
      ok: num(totalsRow.ok),
      failed: num(totalsRow.failed),
      unparseableEvidence: Math.max(0, total - validEvidence),
      matched: num(totalsRow.matched),
      noHistoricalMatch: num(totalsRow.no_hist),
    },
    wouldDowngradeCount: num(evRow?.would_downgrade),
    sameDeviceExactDocumentCount: num(evRow?.same_device_exact),
    candidateIndependentBackingPositiveCount: num(evRow?.cand_indep_positive),
    sharedDeviceEvaluationCount: num(evRow?.shared_device),
    blockedByIndependentBackingCount: num(evRow?.blocked_indep),
    deviceDistinctAccountsDistribution: {
      one: num(distAcctRow?.one),
      two: num(distAcctRow?.two),
      threePlus: num(distAcctRow?.three_plus),
      unknown: num(distAcctRow?.unknown),
    },
    deviceSubmissionCountDistribution: {
      one: num(distSubRow?.one),
      two: num(distSubRow?.two),
      threeToFive: num(distSubRow?.three_to_five),
      sixPlus: num(distSubRow?.six_plus),
      unknown: num(distSubRow?.unknown),
    },
    productionRelationshipDistribution: toDistribution(prodRelRows),
    proposedRelationshipDistribution: toDistribution(propRelRows),
    agreementDistribution: toDistribution(agreementRows),
    exactSameDeviceNotDowngraded: {
      total: notDowngradedTotal,
      byReason,
      byCandidateReason,
    },
    recentCandidatesLimit: recentLimit,
    recentCandidates,
  };
}
