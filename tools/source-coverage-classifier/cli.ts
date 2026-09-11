import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifySourceCoverageCase } from "./classify";
import { ALL_FIXTURE_CASES } from "./fixtures";

/**
 * Offline demo harness — runs ONLY the deterministic local/synthetic
 * fixtures in fixtures.ts (no real dataset of any kind, no network) and
 * writes one JSON summary under D:\TurnitPlusTemp, per the project's
 * storage rule. Invoke with:
 *   node --import tsx tools/source-coverage-classifier/cli.ts
 */

const OUTPUT_DIR = "D:\\TurnitPlusTemp\\source-coverage-classifier";

export function assertWithinAllowedDrive(path: string): void {
  if (!/^[Dd]:[\\/]/.test(path)) {
    throw new Error(`[source-coverage-classifier] refusing to write outside D: (got "${path}") — see the project's storage rule (no C: working data).`);
  }
}

function main(): void {
  assertWithinAllowedDrive(OUTPUT_DIR);
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const records = ALL_FIXTURE_CASES.map((c) => classifySourceCoverageCase(c));

  const countsByOutcome: Record<string, number> = {};
  for (const record of records) countsByOutcome[record.outcome] = (countsByOutcome[record.outcome] ?? 0) + 1;

  const recoveredCaseCount = records.filter((r) => r.outcome === "VERIFIED_RECOVERED").length;
  const totalVerifiedMatchedWordCount = records.reduce((sum, r) => sum + (r.verifiedMatchedWordCount ?? 0), 0);
  const nullVerifiedWordCountCount = records.filter((r) => r.verifiedMatchedWordCount === null).length;

  const summary = {
    generatedAt: new Date().toISOString(),
    fixtureSource: "deterministic local/synthetic fixtures only (tools/source-coverage-classifier/fixtures.ts) — no real dataset of any kind, no network",
    caseCount: records.length,
    countsByOutcome,
    recoveredCaseCount,
    totalVerifiedMatchedWordCount,
    nullVerifiedWordCountCount,
    records,
  };

  const outputPath = join(OUTPUT_DIR, `run-${Date.now()}.json`);
  assertWithinAllowedDrive(outputPath);
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    outputPath,
    caseCount: summary.caseCount,
    countsByOutcome: summary.countsByOutcome,
    recoveredCaseCount: summary.recoveredCaseCount,
    totalVerifiedMatchedWordCount: summary.totalVerifiedMatchedWordCount,
    nullVerifiedWordCountCount: summary.nullVerifiedWordCountCount,
  }, null, 2));
}

// Run only when invoked directly (`node --import tsx tools/source-coverage-classifier/cli.ts`),
// never as a side effect of another module importing this file (e.g. tests
// importing assertWithinAllowedDrive).
const isDirectInvocation = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectInvocation) main();
