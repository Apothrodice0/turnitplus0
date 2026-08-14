import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { runTargetMigrations, TARGET_MIGRATIONS, type RunResult } from "../lib/e8-tables-migration-runner";

/**
 * Phase E8E-D.1: the only file in this tool that ever touches a real
 * credential. lib/e8-tables-migration-runner.ts never reads process.env or
 * a .env file itself — it only receives an already-constructed Client — so
 * every place a secret could leak is contained to the small amount of code
 * below. No value read via loadEnvFile() is ever passed to console.log,
 * console.error, or included in a thrown Error's message.
 *
 * Usage (documented here, not executed by anything — see the production
 * command preview in this phase's own final report):
 *   node --import tsx tools/apply-e8-tables-migration.ts --env=local --db-file=./some.db --execute
 *   node --import tsx tools/apply-e8-tables-migration.ts --env=dev --execute
 *   node --import tsx tools/apply-e8-tables-migration.ts --env=production --execute --confirm=APPLY-TO-PRODUCTION
 *
 * Without --execute, this always runs in dry-run mode (reports what WOULD
 * happen, touches nothing) — this is the default, not an opt-in, precisely
 * so a bare invocation can never apply anything by accident. --env=production
 * additionally requires the exact --confirm=APPLY-TO-PRODUCTION flag before
 * --execute is honored at all; without it, production runs are silently
 * forced back into dry-run regardless of --execute.
 */

type EnvName = "local" | "dev" | "production";

export function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (match) flags[match[1]] = match[2] ?? true;
  }
  return flags;
}

export function loadEnvFile(repoRoot: string, filename: string, name: string): string {
  const filePath = path.join(repoRoot, filename);
  const text = fs.readFileSync(filePath, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`${name} not found in ${filename}`); // never include file contents in the error
  return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
}

/** Non-secret display only: the routing hostname, never the auth token. */
export function hostnameLabel(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "(unparseable url)";
  }
}

async function main() {
  const repoRoot = path.resolve(".");
  const drizzleDir = path.join(repoRoot, "drizzle");
  const flags = parseArgs(process.argv.slice(2));

  const env = flags.env as EnvName | undefined;
  if (!env || !["local", "dev", "production"].includes(env)) {
    console.log('Usage: --env=local|dev|production [--db-file=<path>] [--execute] [--confirm=APPLY-TO-PRODUCTION]');
    process.exitCode = 1;
    return;
  }

  let url: string;
  let authToken: string | undefined;
  let expectedEnvironmentLabel = env;

  if (env === "local") {
    const dbFile = (flags["db-file"] as string) ?? path.join(repoRoot, "e8-tables-migration-local.db");
    url = `file:${dbFile}`;
  } else if (env === "dev") {
    url = loadEnvFile(repoRoot, ".env.local", "DEV_TURSO_DATABASE_URL");
    authToken = loadEnvFile(repoRoot, ".env.local", "DEV_TURSO_AUTH_TOKEN");
  } else {
    url = loadEnvFile(repoRoot, ".env.production.local", "PROD_TURSO_DATABASE_URL");
    authToken = loadEnvFile(repoRoot, ".env.production.local", "PROD_TURSO_TOKEN");
  }

  const wantsExecute = flags.execute === true;
  const confirmedProduction = env === "production" && flags.confirm === "APPLY-TO-PRODUCTION";
  const dryRun = env === "production" ? !(wantsExecute && confirmedProduction) : !wantsExecute;

  console.log(`environment: ${env}`);
  if (env !== "local") console.log(`target hostname label: ${hostnameLabel(url)} (not the full URL, never the token)`);
  console.log(`mode: ${dryRun ? "DRY RUN (nothing will be executed)" : "EXECUTE"}`);
  if (env === "production" && wantsExecute && !confirmedProduction) {
    console.log('--execute was passed for --env=production without --confirm=APPLY-TO-PRODUCTION — forcing dry-run.');
  }
  console.log(`target migration allowlist (${TARGET_MIGRATIONS.length}): ${TARGET_MIGRATIONS.join(", ")}`);

  const client = createClient({ url, authToken });
  let result: RunResult;
  try {
    result = await runTargetMigrations(client, drizzleDir, {
      environmentLabel: env,
      expectedEnvironmentLabel,
      dryRun,
    });
  } finally {
    client.close();
  }

  console.log(`\nresult: ${result.status}`);
  if (result.status === "refused") {
    console.log(`refused: [${result.reason.code}] ${result.reason.message}`);
    process.exitCode = 1;
    return;
  }
  if (result.status === "failed") {
    console.log(`failed at: ${result.failedMigration}`);
    console.log(`error: ${result.error}`);
    console.log(`migrations that already succeeded before the failure: ${result.steps.filter((s) => s.status === "applied").map((s) => s.file).join(", ") || "(none)"}`);
    process.exitCode = 1;
    return;
  }
  for (const step of result.steps) {
    console.log(` - ${step.file}: ${step.status}${step.durationMs ? ` (${step.durationMs}ms)` : ""}`);
  }
}

// Only run when executed directly (`node --import tsx tools/apply-e8-tables-migration.ts ...`)
// — importing this module for its exported helpers (parseArgs, loadEnvFile,
// hostnameLabel; see tests/e8-tables-migration-runner.test.mjs) must never
// have the side effect of parsing the importing process's own argv and
// setting its exit code.
const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isDirectExecution) {
  main().catch((err) => {
    // err.message may legitimately be a libsql connection error; it is never
    // constructed from a raw credential value anywhere in this file (see
    // loadEnvFile's own comment), so this is safe to print as-is.
    console.error("apply-e8-tables-migration failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
