import type { Client } from "@libsql/client";
import { E8I_CLEANUP_TARGETS, E8I_FORBIDDEN_IDENTITY_IDS, E8I_LEGITIMATE_CLUSTER, type CleanupTarget } from "./e8i-cleanup-targets";

/**
 * Phase E8I: read-only verification + dry-run planning for the targeted
 * production cleanup. This module never reads process.env or a credential
 * itself — it only ever receives an already-constructed Client from its
 * caller (see tools/e8i-cleanup.ts), the same discipline
 * lib/e8-tables-migration-runner.ts already established for this repo's
 * other production-touching tool. Every exported function here issues
 * SELECT statements only; the one function anywhere in the E8I toolset that
 * writes lives in the separate lib/e8i-cleanup-apply.ts, deliberately kept
 * out of this file so a structural test can prove this module contains no
 * write statement at all (see tests/e8i-cleanup.test.mjs).
 *
 * verifyTarget() re-derives every fact about a target from a live query and
 * compares it against the pinned expectations in lib/e8i-cleanup-targets.ts
 * — it never trusts the allowlist's own field values as ground truth, only
 * as "what we expect to still be true." Any mismatch is a refusal, not a
 * warning.
 */

export type CheckResult = { code: string; ok: boolean; message: string };

export type TargetVerification = {
  cluster: number;
  target: CleanupTarget;
  checks: CheckResult[];
  ok: boolean;
};

type DocumentIdentityRow = {
  id: string;
  account_id: string | null;
  title: string | null;
  canonical_sha256: string;
  raw_sha256: string;
  created_at: string;
};

async function fetchIdentity(client: Client, id: string): Promise<DocumentIdentityRow | null> {
  const result = await client.execute({
    sql: "SELECT id, account_id, title, canonical_sha256, raw_sha256, created_at FROM document_identities WHERE id = ?",
    args: [id],
  });
  return (result.rows[0] as unknown as DocumentIdentityRow | undefined) ?? null;
}

type SavedReportRow = { id: string; device_key: string; saved_at: string; updated_at: string };

/**
 * The same nearest-timestamp resolution the E8H/E8I audit itself used
 * (tools/e8i-cleanup-plan.ts): a saved_reports row is not directly linked
 * to document_identities (no schema change — see lib/report-historical-match.ts's
 * own comment on this), so "which saved_reports row produced this identity"
 * is resolved by account+title, picking whichever row's updated_at is
 * closest to the identity's created_at. Returns null if no saved_reports
 * row exists for this account+title at all.
 */
async function resolveNearestSavedReportsRow(
  client: Client,
  accountId: string,
  title: string,
  identityCreatedAt: string,
): Promise<{ row: SavedReportRow; distMs: number } | null> {
  const result = await client.execute({
    sql: `SELECT id, device_key, saved_at, updated_at FROM saved_reports WHERE user_id = ? AND title = ?`,
    args: [accountId, title],
  });
  const rows = result.rows as unknown as SavedReportRow[];
  if (rows.length === 0) return null;
  let best: SavedReportRow | null = null;
  let bestDist = Infinity;
  const targetMs = Date.parse(identityCreatedAt + "Z");
  for (const row of rows) {
    const dist = Math.abs(targetMs - Date.parse(row.updated_at + "Z"));
    if (dist < bestDist) {
      bestDist = dist;
      best = row;
    }
  }
  return best ? { row: best, distMs: bestDist } : null;
}

function check(code: string, ok: boolean, message: string): CheckResult {
  return { code, ok, message };
}

/**
 * Runs every precondition for one target and returns them all (not
 * short-circuited) so a caller — the dry-run report or a test — can see
 * exactly which check(s) failed, not just the first one. `ok` is the AND of
 * every check.
 */
export async function verifyTarget(client: Client, target: CleanupTarget): Promise<TargetVerification> {
  const checks: CheckResult[] = [];

  // Structural: the allowlist itself must never name a forbidden (legitimate
  // repeat submission) identity — checked first, before any query, so a
  // corrupted allowlist entry can never proceed on the strength of the DB
  // "happening" to still verify it.
  const notForbidden = !E8I_FORBIDDEN_IDENTITY_IDS.has(target.deleteIdentityId) && !E8I_FORBIDDEN_IDENTITY_IDS.has(target.keepIdentityId);
  checks.push(check("NOT_FORBIDDEN", notForbidden, notForbidden
    ? "neither identity is in the legitimate-repeat forbidden list"
    : "REFUSED: this target names an identity from the legitimate repeat-submission cluster"));
  if (!notForbidden) return { cluster: target.cluster, target, checks, ok: false };

  const deleteIdentity = await fetchIdentity(client, target.deleteIdentityId);
  checks.push(check("DELETE_IDENTITY_EXISTS", deleteIdentity !== null, deleteIdentity ? "delete-target identity exists" : "REFUSED: delete-target document_identities row no longer exists"));

  const keepIdentity = await fetchIdentity(client, target.keepIdentityId);
  checks.push(check("KEEP_IDENTITY_EXISTS", keepIdentity !== null, keepIdentity ? "kept identity exists" : "REFUSED: kept document_identities row no longer exists"));

  if (!deleteIdentity || !keepIdentity) {
    return { cluster: target.cluster, target, checks, ok: false };
  }

  checks.push(check(
    "DELETE_ACCOUNT_MATCH",
    deleteIdentity.account_id === target.accountId,
    deleteIdentity.account_id === target.accountId ? "delete-target belongs to the expected account" : `REFUSED: delete-target account_id is ${deleteIdentity.account_id}, expected ${target.accountId}`,
  ));
  checks.push(check(
    "KEEP_ACCOUNT_MATCH",
    keepIdentity.account_id === target.accountId,
    keepIdentity.account_id === target.accountId ? "kept identity belongs to the expected account" : `REFUSED: kept identity account_id is ${keepIdentity.account_id}, expected ${target.accountId}`,
  ));

  const canonicalMatch = deleteIdentity.canonical_sha256 === target.canonicalSha256 && keepIdentity.canonical_sha256 === target.canonicalSha256;
  checks.push(check("CANONICAL_HASH_MATCH", canonicalMatch, canonicalMatch ? "both identities' canonical_sha256 match the pinned expectation and each other" : "REFUSED: canonical_sha256 does not match the pinned allowlist value — content or rows have changed since review"));

  const rawMatch = deleteIdentity.raw_sha256 === target.rawSha256;
  checks.push(check("RAW_HASH_MATCH", rawMatch, rawMatch ? "delete-target raw_sha256 matches the pinned expectation" : "REFUSED: delete-target raw_sha256 does not match the pinned allowlist value"));

  const keepMs = Date.parse(keepIdentity.created_at + "Z");
  const deleteMs = Date.parse(deleteIdentity.created_at + "Z");
  const deltaSeconds = (deleteMs - keepMs) / 1000;
  const ageOk = deltaSeconds >= 0 && deltaSeconds <= target.maxDeltaSeconds;
  checks.push(check(
    "AGE_ORDERING",
    ageOk,
    ageOk
      ? `delete-target is the younger identity (delta ${deltaSeconds}s, within the expected 0-${target.maxDeltaSeconds}s window)`
      : `REFUSED: expected the delete-target to be created at or after the kept identity, within ${target.maxDeltaSeconds}s (got delta ${deltaSeconds}s)`,
  ));

  const pinnedTimestampsMatch = keepIdentity.created_at === target.keepCreatedAt && deleteIdentity.created_at === target.deleteCreatedAt;
  checks.push(check(
    "PINNED_TIMESTAMPS_MATCH",
    pinnedTimestampsMatch,
    pinnedTimestampsMatch ? "created_at values match the pinned, reviewed allowlist exactly" : "REFUSED: created_at values have drifted from the pinned, reviewed allowlist",
  ));

  const referenceResult = await client.execute({
    sql: "SELECT id, representation_id FROM corpus_submission_references WHERE document_identity_id = ?",
    args: [target.deleteIdentityId],
  });
  const referenceRows = referenceResult.rows as unknown as { id: number; representation_id: string }[];
  const referenceOk = referenceRows.length === 1
    && Number(referenceRows[0].id) === target.deleteSubmissionReferenceId
    && referenceRows[0].representation_id === target.representationId;
  checks.push(check(
    "REFERENCE_EXISTS_AND_MATCHES",
    referenceOk,
    referenceOk
      ? "exactly one corpus_submission_references row exists for the delete-target, matching the expected reference id and representation"
      : `REFUSED: expected exactly one corpus_submission_references row (id=${target.deleteSubmissionReferenceId}, representation_id=${target.representationId}) for the delete-target, found ${JSON.stringify(referenceRows)}`,
  ));

  const keepReferenceResult = await client.execute({
    sql: "SELECT representation_id FROM corpus_submission_references WHERE document_identity_id = ?",
    args: [target.keepIdentityId],
  });
  const keepReferenceRows = keepReferenceResult.rows as unknown as { representation_id: string }[];
  const keepReferenceOk = keepReferenceRows.length === 1 && keepReferenceRows[0].representation_id === target.representationId;
  checks.push(check(
    "REPRESENTATION_MATCH",
    keepReferenceOk,
    keepReferenceOk ? "kept identity's own submission reference points at the same expected representation" : "REFUSED: kept identity's submission reference does not point at the expected representation",
  ));

  const deleteReportResolution = await resolveNearestSavedReportsRow(client, target.accountId, target.title, deleteIdentity.created_at);
  const keepReportResolution = await resolveNearestSavedReportsRow(client, target.accountId, target.title, keepIdentity.created_at);
  const reportMappingOk = Boolean(
    deleteReportResolution
    && keepReportResolution
    && deleteReportResolution.row.id === target.expectedReportId
    && keepReportResolution.row.id === target.expectedReportId
    && deleteReportResolution.row.device_key === target.expectedDeviceKey,
  );
  checks.push(check(
    "REPORT_MAPPING_MATCHES",
    reportMappingOk,
    reportMappingOk
      ? `both identities resolve to the expected single saved_reports row ${target.expectedReportId}`
      : `REFUSED: identities no longer resolve to the expected saved_reports row ${target.expectedReportId} (got delete->${deleteReportResolution?.row.id ?? "none"}, keep->${keepReportResolution?.row.id ?? "none"})`,
  ));

  const savedReportResult = await client.execute({
    sql: "SELECT id, device_key FROM saved_reports WHERE id = ? AND device_key = ?",
    args: [target.expectedReportId, target.expectedDeviceKey],
  });
  const savedReportExists = savedReportResult.rows.length === 1;
  checks.push(check(
    "SAVED_REPORT_STILL_EXISTS",
    savedReportExists,
    savedReportExists ? "the mapped saved_reports row still exists" : "REFUSED: the mapped saved_reports row no longer exists",
  ));

  return { cluster: target.cluster, target, checks, ok: checks.every((c) => c.ok) };
}

export type LegitimateClusterCheck = { ok: boolean; details: string };

/** Confirms (read-only) that the legitimate repeat-submission cluster still resolves to two distinct saved_reports rows and neither of its identities appears in the deletion allowlist. Informational for the dry-run report — this cluster is never targeted by id. */
export async function verifyLegitimateClusterUntouched(client: Client): Promise<LegitimateClusterCheck> {
  const [idA, idB] = E8I_LEGITIMATE_CLUSTER.identityIds;
  const identityA = await fetchIdentity(client, idA);
  const identityB = await fetchIdentity(client, idB);
  if (!identityA || !identityB) {
    return { ok: false, details: "one or both legitimate-cluster identities are missing — cannot confirm untouched" };
  }
  const resolutionA = await resolveNearestSavedReportsRow(client, E8I_LEGITIMATE_CLUSTER.accountId, E8I_LEGITIMATE_CLUSTER.title, identityA.created_at);
  const resolutionB = await resolveNearestSavedReportsRow(client, E8I_LEGITIMATE_CLUSTER.accountId, E8I_LEGITIMATE_CLUSTER.title, identityB.created_at);
  const distinctSavedReports = Boolean(resolutionA && resolutionB && resolutionA.row.id !== resolutionB.row.id);
  const notInAllowlist = !E8I_CLEANUP_TARGETS.some((t) => t.deleteIdentityId === idA || t.deleteIdentityId === idB || t.keepIdentityId === idA || t.keepIdentityId === idB);
  const ok = distinctSavedReports && notInAllowlist;
  return {
    ok,
    details: ok
      ? `confirmed: two distinct saved_reports rows (${resolutionA?.row.id}, ${resolutionB?.row.id}), neither identity present in the cleanup allowlist`
      : `NOT CONFIRMED: distinctSavedReports=${distinctSavedReports} notInAllowlist=${notInAllowlist}`,
  };
}

export type ClusterPlanEntry = {
  cluster: number;
  title: string;
  verification: TargetVerification;
  reason: "DUPLICATE_SAVE_ARTIFACT";
  plannedActions: Array<"DELETE_REFERENCE" | "DELETE_IDENTITY">;
};

export type E8ICleanupPlan = {
  generatedAt: string;
  entries: ClusterPlanEntry[];
  allVerified: boolean;
  legitimateCluster: LegitimateClusterCheck;
  summary: {
    referencesToDelete: number;
    identitiesToDelete: number;
    representationsToDelete: number;
    snapshotsToInvalidateLater: number;
  };
};

/** The dry-run entry point. Issues only SELECT statements (via verifyTarget/verifyLegitimateClusterUntouched above) — see tests/e8i-cleanup.test.mjs's structural zero-writes test. */
export async function planE8ICleanup(client: Client, targets: readonly CleanupTarget[] = E8I_CLEANUP_TARGETS): Promise<E8ICleanupPlan> {
  const entries: ClusterPlanEntry[] = [];
  for (const target of targets) {
    const verification = await verifyTarget(client, target);
    entries.push({
      cluster: target.cluster,
      title: target.title,
      verification,
      reason: "DUPLICATE_SAVE_ARTIFACT",
      plannedActions: verification.ok ? ["DELETE_REFERENCE", "DELETE_IDENTITY"] : [],
    });
  }
  const legitimateCluster = await verifyLegitimateClusterUntouched(client);
  const allVerified = entries.every((e) => e.verification.ok);
  const verifiedCount = entries.filter((e) => e.verification.ok).length;
  return {
    generatedAt: new Date().toISOString(),
    entries,
    allVerified,
    legitimateCluster,
    summary: {
      referencesToDelete: verifiedCount,
      identitiesToDelete: verifiedCount,
      representationsToDelete: 0,
      snapshotsToInvalidateLater: verifiedCount,
    },
  };
}

/** Shows the first 4 and last 4 characters only — enough to visually cross-reference against a full id held elsewhere, never enough to reconstruct it. */
export function maskId(value: string | number): string {
  const s = String(value);
  if (s.length <= 10) return "*".repeat(Math.max(s.length, 4));
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Renders the human-readable dry-run report this phase's own task description asks for. Masks account/identity/reference ids; report id and representation id are shown in full (never account-identifying on their own). */
export function renderDryRunReport(plan: E8ICleanupPlan): string {
  const lines: string[] = [];
  lines.push(`=== E8I DRY-RUN CLEANUP PLAN (generated ${plan.generatedAt}) ===`);
  lines.push("");
  for (const entry of plan.entries) {
    const t = entry.verification.target;
    lines.push(`--- Cluster ${entry.cluster}: "${entry.title}" ---`);
    lines.push(`  report ID: ${t.expectedReportId}`);
    lines.push(`  masked account ID: ${maskId(t.accountId)}`);
    lines.push(`  masked younger (delete) identity ID: ${maskId(t.deleteIdentityId)}`);
    lines.push(`  masked kept identity ID: ${maskId(t.keepIdentityId)}`);
    lines.push(`  masked reference ID: ${maskId(t.deleteSubmissionReferenceId)}`);
    lines.push(`  representation ID: ${t.representationId}`);
    lines.push(`  timestamp delta: ${((Date.parse(t.deleteCreatedAt + "Z") - Date.parse(t.keepCreatedAt + "Z")) / 1000)}s`);
    lines.push(`  reason: ${entry.reason}`);
    lines.push(`  verification: ${entry.verification.ok ? "PASSED" : "FAILED"}`);
    for (const c of entry.verification.checks) {
      lines.push(`    [${c.ok ? "ok" : "FAIL"}] ${c.code}: ${c.message}`);
    }
    lines.push(`  planned action: ${entry.plannedActions.length > 0 ? entry.plannedActions.join(" + ") : "(none — verification failed, no action planned)"}`);
    lines.push("");
  }
  lines.push(`--- Legitimate repeat submission: "${E8I_LEGITIMATE_CLUSTER.title}" ---`);
  lines.push(`  status: ${plan.legitimateCluster.ok ? "CONFIRMED UNTOUCHED" : "COULD NOT CONFIRM"}`);
  lines.push(`  ${plan.legitimateCluster.details}`);
  lines.push("");
  lines.push("=== SUMMARY ===");
  lines.push(`${plan.summary.referencesToDelete} corpus_submission_references would be deleted`);
  lines.push(`${plan.summary.identitiesToDelete} document_identities would be deleted`);
  lines.push(`${plan.summary.representationsToDelete} corpus_document_representations would be deleted`);
  lines.push(`${plan.summary.snapshotsToInvalidateLater} report_historical_match_snapshots would need invalidation LATER (not in this run)`);
  lines.push(`all targets verified: ${plan.allVerified ? "YES" : "NO — see FAILED checks above, nothing would be deleted for any target that failed"}`);
  return lines.join("\n");
}
