import path from "node:path";
import { createClient } from "@libsql/client";
import { loadEnvFile, hostnameLabel, parseArgs } from "./apply-e8-tables-migration";
import { E8I_CLEANUP_TARGETS } from "../lib/e8i-cleanup-targets";
import { planE8ICleanup, renderDryRunReport } from "../lib/e8i-cleanup-runner";
import { applyAllVerifiedDeletions } from "../lib/e8i-cleanup-apply";

/**
 * Phase E8I: targeted production cleanup CLI for the 4 confirmed legacy
 * pre-E8F DUPLICATE_SAVE_ARTIFACT clusters (see lib/e8i-cleanup-targets.ts's
 * own header for the full rationale). Reuses this repo's existing
 * production-tool safety pattern (tools/apply-e8-tables-migration.ts):
 * dry-run is the default and cannot be skipped by accident, and a
 * production write additionally requires an exact confirmation string.
 *
 * This file — not lib/e8i-cleanup-runner.ts, not lib/e8i-cleanup-apply.ts —
 * is the only place in the whole E8I toolset that ever reads process.env or
 * a credential. Only a hostname label is ever logged; the url/token
 * themselves never reach console.log/console.error.
 *
 * Usage:
 *   node --import tsx tools/e8i-cleanup.ts --env=local --db-file=./some.db [--execute]
 *   node --import tsx tools/e8i-cleanup.ts --env=production
 *     (always dry-run: prints the verification + plan, deletes nothing)
 *   node --import tsx tools/e8i-cleanup.ts --env=production --execute --confirm=E8I-CLEANUP-PRODUCTION
 *     (the only invocation that can write — still refuses if any of the 4
 *     targets fails verification at the moment it runs)
 *
 * This phase's own task description is explicit: dry-run only, no
 * production writes, no snapshot invalidation, no E8J. This file's default
 * behavior already matches that; nothing about running it plainly (no
 * --execute) can violate it.
 */

type EnvName = "local" | "production";

/**
 * The confirmation gate itself, pulled out as a pure function so it can be
 * tested directly (see tests/e8i-cleanup.test.mjs's "L" tests) without
 * exercising the whole CLI. Mirrors tools/apply-e8-tables-migration.ts's
 * inline dryRun computation: production requires BOTH --execute and the
 * exact confirm string; --env=local only ever needs --execute (there is no
 * credential to protect there — the caller already chose a local db file).
 */
export function computeDryRun(env: EnvName, flags: { execute?: boolean | string; confirm?: boolean | string }): boolean {
  const wantsExecute = flags.execute === true;
  const confirmedProduction = env === "production" && flags.confirm === "E8I-CLEANUP-PRODUCTION";
  return env === "production" ? !(wantsExecute && confirmedProduction) : !wantsExecute;
}

async function main() {
  const repoRoot = process.cwd();
  const flags = parseArgs(process.argv.slice(2));

  const env = flags.env as EnvName | undefined;
  if (!env || !["local", "production"].includes(env)) {
    console.log("Usage: --env=local|production [--db-file=<path>] [--execute] [--confirm=E8I-CLEANUP-PRODUCTION]");
    process.exitCode = 1;
    return;
  }

  let url: string;
  let authToken: string | undefined;

  if (env === "local") {
    const dbFile = (flags["db-file"] as string) ?? "e8i-cleanup-local.db";
    url = `file:${dbFile}`;
  } else {
    url = loadEnvFile(repoRoot, ".env.production.local", "PROD_TURSO_DATABASE_URL");
    authToken = loadEnvFile(repoRoot, ".env.production.local", "PROD_TURSO_TOKEN");
  }

  const dryRun = computeDryRun(env, flags as { execute?: boolean | string; confirm?: boolean | string });

  console.log(`environment: ${env}`);
  if (env !== "local") console.log(`target hostname label: ${hostnameLabel(url)} (not the full URL, never the token)`);
  console.log(`mode: ${dryRun ? "DRY RUN (nothing will be executed)" : "EXECUTE"}`);
  if (env === "production" && flags.execute === true && flags.confirm !== "E8I-CLEANUP-PRODUCTION") {
    console.log("--execute was passed for --env=production without --confirm=E8I-CLEANUP-PRODUCTION — forcing dry-run.");
  }
  console.log(`allowlisted targets: ${E8I_CLEANUP_TARGETS.length}`);
  console.log("");

  const client = createClient({ url, authToken });
  try {
    await client.execute("PRAGMA foreign_keys = ON");

    const plan = await planE8ICleanup(client);
    console.log(renderDryRunReport(plan));

    if (dryRun) {
      console.log("\nDRY RUN — zero writes were issued. No production rows were modified.");
      return;
    }

    if (!plan.allVerified) {
      console.log("\nREFUSING to execute: not every target passed verification at plan time. Zero writes issued.");
      process.exitCode = 1;
      return;
    }

    console.log("\n=== EXECUTING VERIFIED DELETIONS ===");
    const outcomes = await applyAllVerifiedDeletions(client);
    for (const outcome of outcomes) {
      if (outcome.status === "applied") {
        console.log(`cluster ${outcome.cluster}: DELETED reference ${outcome.deletedReferenceId} and identity ${outcome.deletedIdentityId}`);
      } else {
        console.log(`cluster ${outcome.cluster}: REFUSED at execute time (re-verification failed) — zero writes for this target`);
      }
    }
    console.log("\nNOTE: report_historical_match_snapshots rows for the 4 affected reports are NOT invalidated by this run.");
    console.log("That is a deliberately separate step — see this phase's own task description.");
  } finally {
    client.close();
  }
}

// Only run when executed directly — importing this module for its exported
// helpers (computeDryRun; see tests/e8i-cleanup.test.mjs) must never have
// the side effect of parsing the importing process's own argv and setting
// its exit code. Same guard tools/apply-e8-tables-migration.ts already uses.
const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isDirectExecution) {
  main().catch((err) => {
    console.error("e8i-cleanup failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
