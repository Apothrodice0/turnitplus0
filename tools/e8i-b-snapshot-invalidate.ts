import path from "node:path";
import { createClient } from "@libsql/client";
import { loadEnvFile, hostnameLabel, parseArgs } from "./apply-e8-tables-migration";
import { E8I_B_SNAPSHOT_TARGETS } from "../lib/e8i-b-snapshot-targets";
import { planSnapshotInvalidation, renderSnapshotDryRunReport } from "../lib/e8i-b-snapshot-runner";
import { applyAllVerifiedSnapshotInvalidations } from "../lib/e8i-b-snapshot-apply";
import { verifyLegitimateClusterUntouched } from "../lib/e8i-cleanup-runner";

/**
 * Phase E8I-B: invalidates the 4 stale report_historical_match_snapshots
 * rows left over from E8I's now-completed identity/reference cleanup — a
 * cached MATCHED snapshot never self-corrects from new corpus content (see
 * lib/report-historical-match.ts), so these 4 rows need an explicit delete
 * before their reports will recompute against the corrected corpus.
 *
 * Same safety pattern as tools/e8i-cleanup.ts and
 * tools/apply-e8-tables-migration.ts: dry-run by default, production write
 * requires --execute plus the exact --confirm string, only a hostname label
 * is ever logged. This file is the only place in the E8I-B toolset that
 * reads process.env or a credential.
 *
 * Usage:
 *   node --import tsx tools/e8i-b-snapshot-invalidate.ts --env=local --db-file=./some.db [--execute]
 *   node --import tsx tools/e8i-b-snapshot-invalidate.ts --env=production
 *     (always dry-run: prints verification + plan, deletes nothing)
 *   node --import tsx tools/e8i-b-snapshot-invalidate.ts --env=production --execute --confirm=E8I-SNAPSHOT-INVALIDATE-PRODUCTION
 *     (the only invocation that can write; runs post-cleanup verification afterward)
 */

type EnvName = "local" | "production";

export function computeDryRun(env: EnvName, flags: { execute?: boolean | string; confirm?: boolean | string }): boolean {
  const wantsExecute = flags.execute === true;
  const confirmedProduction = env === "production" && flags.confirm === "E8I-SNAPSHOT-INVALIDATE-PRODUCTION";
  return env === "production" ? !(wantsExecute && confirmedProduction) : !wantsExecute;
}

export async function runPostCleanupVerification(client: import("@libsql/client").Client, before: {
  snapshotKeys: Set<string>;
  representationCount: number;
  referenceCount: number;
}) {
  console.log("\n=== POST-CLEANUP VERIFICATION ===");
  let allOk = true;

  // 1. all four snapshot rows are gone
  let allGone = true;
  for (const t of E8I_B_SNAPSHOT_TARGETS) {
    const r = await client.execute({
      sql: "SELECT 1 FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
      args: [t.deviceKey, t.reportId],
    });
    if (r.rows.length !== 0) allGone = false;
  }
  console.log(`1. all four snapshot rows gone: ${allGone ? "PASS" : "FAIL"}`);
  allOk = allOk && allGone;

  // 2. no other snapshot rows were deleted
  const afterResult = await client.execute("SELECT report_device_key, report_id FROM report_historical_match_snapshots");
  const afterKeys = new Set((afterResult.rows as unknown as { report_device_key: string; report_id: string }[]).map((r) => `${r.report_device_key}::${r.report_id}`));
  const expectedRemovedKeys = new Set(E8I_B_SNAPSHOT_TARGETS.map((t) => `${t.deviceKey}::${t.reportId}`));
  let onlyExpectedRemoved = true;
  for (const key of before.snapshotKeys) {
    const wasRemoved = !afterKeys.has(key);
    const shouldHaveBeenRemoved = expectedRemovedKeys.has(key);
    if (wasRemoved !== shouldHaveBeenRemoved) onlyExpectedRemoved = false;
  }
  // Nothing new should have appeared either.
  for (const key of afterKeys) {
    if (!before.snapshotKeys.has(key)) onlyExpectedRemoved = false;
  }
  console.log(`2. no unrelated snapshot rows changed (before=${before.snapshotKeys.size}, after=${afterKeys.size}, removed=${before.snapshotKeys.size - afterKeys.size}): ${onlyExpectedRemoved ? "PASS" : "FAIL"}`);
  allOk = allOk && onlyExpectedRemoved;

  // 3. corpus representation/reference counts are sane (unchanged)
  const repCount = await client.execute("SELECT COUNT(*) AS n FROM corpus_document_representations");
  const refCount = await client.execute("SELECT COUNT(*) AS n FROM corpus_submission_references");
  const repOk = Number(repCount.rows[0].n) === before.representationCount;
  const refOk = Number(refCount.rows[0].n) === before.referenceCount;
  console.log(`3. corpus_document_representations unchanged (${before.representationCount} -> ${repCount.rows[0].n}): ${repOk ? "PASS" : "FAIL"}`);
  console.log(`   corpus_submission_references unchanged (${before.referenceCount} -> ${refCount.rows[0].n}): ${refOk ? "PASS" : "FAIL"}`);
  allOk = allOk && repOk && refOk;

  // 4. legitimate repeat submission remains intact
  const legit = await verifyLegitimateClusterUntouched(client);
  console.log(`4. legitimate repeat submission intact: ${legit.ok ? "PASS" : "FAIL"} — ${legit.details}`);
  allOk = allOk && legit.ok;

  // 5. the four reports can now recompute (no stale snapshot blocking it)
  console.log(`5. the four reports can now recompute (no cached snapshot remains): ${allGone ? "PASS" : "FAIL"}`);

  console.log(`\nPOST-CLEANUP VERIFICATION: ${allOk ? "ALL CHECKS PASSED" : "AT LEAST ONE CHECK FAILED — investigate before proceeding further"}`);
  return allOk;
}

async function main() {
  const repoRoot = process.cwd();
  const flags = parseArgs(process.argv.slice(2));

  const env = flags.env as EnvName | undefined;
  if (!env || !["local", "production"].includes(env)) {
    console.log("Usage: --env=local|production [--db-file=<path>] [--execute] [--confirm=E8I-SNAPSHOT-INVALIDATE-PRODUCTION]");
    process.exitCode = 1;
    return;
  }

  let url: string;
  let authToken: string | undefined;
  if (env === "local") {
    const dbFile = (flags["db-file"] as string) ?? "e8i-b-snapshot-local.db";
    url = `file:${dbFile}`;
  } else {
    url = loadEnvFile(repoRoot, ".env.production.local", "PROD_TURSO_DATABASE_URL");
    authToken = loadEnvFile(repoRoot, ".env.production.local", "PROD_TURSO_TOKEN");
  }

  const dryRun = computeDryRun(env, flags as { execute?: boolean | string; confirm?: boolean | string });

  console.log(`environment: ${env}`);
  if (env !== "local") console.log(`target hostname label: ${hostnameLabel(url)} (not the full URL, never the token)`);
  console.log(`mode: ${dryRun ? "DRY RUN (nothing will be executed)" : "EXECUTE"}`);
  if (env === "production" && flags.execute === true && flags.confirm !== "E8I-SNAPSHOT-INVALIDATE-PRODUCTION") {
    console.log("--execute was passed for --env=production without --confirm=E8I-SNAPSHOT-INVALIDATE-PRODUCTION — forcing dry-run.");
  }
  console.log(`allowlisted targets: ${E8I_B_SNAPSHOT_TARGETS.length}`);
  console.log("");

  const client = createClient({ url, authToken });
  try {
    const plan = await planSnapshotInvalidation(client);
    console.log(renderSnapshotDryRunReport(plan));

    if (dryRun) {
      console.log("\nDRY RUN — zero writes were issued. No production rows were modified.");
      return;
    }

    if (!plan.allVerified) {
      console.log("\nREFUSING to execute: not every target passed verification at plan time. Zero writes issued.");
      process.exitCode = 1;
      return;
    }

    const beforeSnapshots = await client.execute("SELECT report_device_key, report_id FROM report_historical_match_snapshots");
    const before = {
      snapshotKeys: new Set((beforeSnapshots.rows as unknown as { report_device_key: string; report_id: string }[]).map((r) => `${r.report_device_key}::${r.report_id}`)),
      representationCount: Number((await client.execute("SELECT COUNT(*) AS n FROM corpus_document_representations")).rows[0].n),
      referenceCount: Number((await client.execute("SELECT COUNT(*) AS n FROM corpus_submission_references")).rows[0].n),
    };

    console.log("\n=== EXECUTING VERIFIED SNAPSHOT INVALIDATIONS ===");
    const outcomes = await applyAllVerifiedSnapshotInvalidations(client);
    for (const outcome of outcomes) {
      if (outcome.status === "deleted") {
        console.log(`cluster ${outcome.cluster}: DELETED snapshot for report ${outcome.reportId}`);
      } else {
        console.log(`cluster ${outcome.cluster}: REFUSED at execute time (re-verification failed) — zero writes for this target`);
      }
    }

    const postOk = await runPostCleanupVerification(client, before);
    if (!postOk) process.exitCode = 1;
  } finally {
    client.close();
  }
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isDirectExecution) {
  main().catch((err) => {
    console.error("e8i-b-snapshot-invalidate failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
