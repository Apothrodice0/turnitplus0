import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";

/**
 * Phase E8E-D.1: an isolated runner whose only job is applying migrations
 * 0012-0022 (the still-unapplied Phase A-E8 tables) to a database that is
 * otherwise already at the pre-0012 baseline. Deliberately separate from
 * lib/ingest.ts's applyMigrationsLibsql(), which replays every migration
 * file in drizzleDir from 0000 onward with no applied-state tracking —
 * correct only against an empty/fresh database (every existing test in
 * this repo uses it exactly that way). Running that function against a
 * non-empty database would replay drizzle/0007_document_chunks_cascade.sql,
 * which contains a real `DROP TABLE document_chunks` as part of a
 * rebuild-for-CASCADE pattern — destructive against a table that already
 * holds real rows. This module never reads or executes 0000-0011, and
 * never imports applyMigrationsLibsql.
 *
 * This module has no knowledge of "production" as a concept — it only ever
 * receives an already-constructed Client and an environmentLabel string
 * from its caller (see tools/apply-e8-tables-migration.ts), and never
 * reads process.env or a credential itself. That keeps this file naturally
 * incapable of logging a secret, regardless of what database the caller
 * happens to have connected it to.
 */

export const TARGET_MIGRATIONS = [
  "0012_document_identities.sql",
  "0013_document_families.sql",
  "0014_provenance.sql",
  "0015_provenance_evidence.sql",
  "0016_provenance_verification_decisions.sql",
  "0017_discovery_attempts.sql",
  "0018_source_retrievals.sql",
  "0019_user_submission_corpus.sql",
  "0020_report_historical_match_snapshots.sql",
  "0021_historical_match_shadow_evaluations.sql",
  "0022_reuse_context_declarations.sql",
] as const;

export type TargetMigrationFile = (typeof TARGET_MIGRATIONS)[number];

/**
 * Every table each target migration creates, extracted directly from the
 * migration SQL (`CREATE TABLE IF NOT EXISTS <name>`) — used for the
 * per-migration already-applied / partially-applied / not-yet-applied
 * checks below. Not derived at runtime from the file content, so a
 * mismatch between this list and the actual file is itself a signal
 * something changed — see EXPECTED_MIGRATION_SHA256 for the guard against
 * that specifically.
 */
export const EXPECTED_TABLES_BY_MIGRATION: Record<TargetMigrationFile, string[]> = {
  "0012_document_identities.sql": ["document_identities"],
  "0013_document_families.sql": ["document_identity_shingles", "document_families", "document_family_members"],
  "0014_provenance.sql": ["provenance_sources", "provenance_events"],
  "0015_provenance_evidence.sql": ["provenance_evidence"],
  "0016_provenance_verification_decisions.sql": ["provenance_verification_decisions"],
  "0017_discovery_attempts.sql": ["discovery_attempts"],
  "0018_source_retrievals.sql": ["source_retrievals"],
  "0019_user_submission_corpus.sql": ["corpus_document_representations", "corpus_submission_references", "corpus_document_shingles"],
  "0020_report_historical_match_snapshots.sql": ["report_historical_match_snapshots"],
  "0021_historical_match_shadow_evaluations.sql": ["historical_match_shadow_evaluations"],
  "0022_reuse_context_declarations.sql": ["reuse_context_declarations"],
};

export const ALL_TARGET_TABLES: string[] = TARGET_MIGRATIONS.flatMap((m) => EXPECTED_TABLES_BY_MIGRATION[m]);

/**
 * The tables this runner requires to already exist before it does anything
 * — the pre-0012 baseline confirmed in Phase E8E-C/E8E-D. sqlite_sequence
 * is SQLite-internal (auto-created the first time an AUTOINCREMENT column
 * is used) and deliberately excluded — its presence/absence is not a
 * meaningful signal about migration state.
 */
export const EXPECTED_LEGACY_TABLES = [
  "analysis_runs", "chunk_fingerprints", "contributions", "document_chunks",
  "documents", "index_versions", "match_segments", "matches",
  "saved_reports", "sessions", "users",
];

/**
 * SHA-256 of each target migration file's exact content, pinned at the time
 * this runner was written and reviewed (computed directly from the files
 * currently in drizzle/). A mismatch at runtime means the file on disk was
 * edited after review — this runner refuses rather than trusting it blindly.
 * This is a tamper/drift guard, not a substitute for re-reading the files
 * before actually pointing this at production.
 */
export const EXPECTED_MIGRATION_SHA256: Record<TargetMigrationFile, string> = {
  "0012_document_identities.sql": "af7808eba21e5b025293d7d14af2693d2bf9e17e2a3d58dabae2e0c58ef88dd7",
  "0013_document_families.sql": "018ca4baf77fc15d422b112d5171d6b4b89a4785b2aa94ca91948316f2ab40b4",
  "0014_provenance.sql": "26b704780e8fe95d6d5780f3893bf0c091d1ed19ad2091a7ab65671bcaf1114c",
  "0015_provenance_evidence.sql": "3cc4722197d9aade421c519da7ec7589ccc4e63f0bdf1831b1adc84f86c6b73e",
  "0016_provenance_verification_decisions.sql": "402f7d1060170ea098ff82104fa2855c977dfd12ae5555ff11f470d4bd66d84e",
  "0017_discovery_attempts.sql": "2ea220a9c603b5b623f3cba8e708c4e52d1807bacec386b9484d263e83a7f470",
  "0018_source_retrievals.sql": "fb322f0a25fb692cfe512c333c85d0f238b11173033937941213cb578d077890",
  "0019_user_submission_corpus.sql": "99bc22489bddc0b16fb359ce84e0d56c4c1ed768fd5f89dc9d946efbf5aa6c8e",
  "0020_report_historical_match_snapshots.sql": "f915027d70eb1a8ffdd267abfa802eef8eddd8c2568eb1d97881df94df506d2e",
  "0021_historical_match_shadow_evaluations.sql": "757a34bf6ca225a20ac0db9f5673d3f4e51556781b11d184e434bd55b4ab668f",
  "0022_reuse_context_declarations.sql": "80f2d9391a0bd9b89cde22218abcc1438f2c7810d09324bc6dc99e1bbdc03fde",
};

const DESTRUCTIVE_PATTERN = /\b(DROP\s+TABLE|DROP\s+INDEX|ALTER\s+TABLE\s+\S+\s+DROP|DELETE\s+FROM|TRUNCATE)\b/gi;

/** Strips `--` line comments only — none of these 9 files use block comments — so a comment mentioning a keyword by name can't be mistaken for a real statement. */
export function stripSqlLineComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

/** Returns every destructive-statement keyword phrase found, or an empty array. Used both at review time and re-checked by checkPreflight() on every single run — see this file's own header comment on why this can never be assumed true from a prior review alone. */
export function scanForDestructiveStatements(sql: string): string[] {
  const stripped = stripSqlLineComments(sql);
  const matches = stripped.match(DESTRUCTIVE_PATTERN);
  return matches ? [...new Set(matches.map((m) => m.replace(/\s+/g, " ").trim().toUpperCase()))] : [];
}

/** Splits one migration file into individual statements for client.migrate()/client.batch(), which take an array of statements rather than one multi-statement string. Safe for these 9 files specifically (verified: no embedded semicolons in string literals, no drizzle-kit `--> statement-breakpoint` markers) — not a general-purpose SQL parser. */
export function splitStatements(sql: string): string[] {
  return stripSqlLineComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export type PreflightFailure = {
  ok: false;
  code:
    | "MISSING_LEGACY_TABLE"
    | "HASH_MISMATCH"
    | "ENVIRONMENT_LABEL_MISMATCH"
    | "DESTRUCTIVE_STATEMENT_DETECTED";
  message: string;
  details?: unknown;
};
export type PreflightResult = { ok: true } | PreflightFailure;

/**
 * Preconditions A, E, F, and (re-confirmed every run) 8 from this phase's
 * own task description. Precondition B/C/D (target-table existence state)
 * is checked per-migration inside runTargetMigrations() below, since it
 * needs to distinguish "not yet applied" from "already applied" from
 * "partially applied" per file, not just once globally.
 */
export async function checkPreflight(
  client: Client,
  drizzleDir: string,
  options: {
    environmentLabel: string;
    expectedEnvironmentLabel: string;
    /** Defaults to the real, reviewed EXPECTED_MIGRATION_SHA256 — tests may override this to exercise a deliberately-crafted temp migration directory without weakening the real safety check for any real caller, which never passes this. */
    migrationShaManifest?: Record<TargetMigrationFile, string>;
  },
): Promise<PreflightResult> {
  const shaManifest = options.migrationShaManifest ?? EXPECTED_MIGRATION_SHA256;
  if (options.environmentLabel !== options.expectedEnvironmentLabel) {
    return {
      ok: false,
      code: "ENVIRONMENT_LABEL_MISMATCH",
      message: `refusing to run: expected environmentLabel "${options.expectedEnvironmentLabel}", caller passed "${options.environmentLabel}"`,
    };
  }

  const existing = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const existingNames = new Set(existing.rows.map((r) => String(r.name)));
  const missingLegacy = EXPECTED_LEGACY_TABLES.filter((t) => !existingNames.has(t));
  if (missingLegacy.length > 0) {
    return {
      ok: false,
      code: "MISSING_LEGACY_TABLE",
      message: `expected pre-0012 legacy tables are missing — this does not look like the expected database: ${missingLegacy.join(", ")}`,
      details: { missingLegacy },
    };
  }

  for (const file of TARGET_MIGRATIONS) {
    const content = fs.readFileSync(path.join(drizzleDir, file), "utf8");
    const actualHash = sha256(content);
    if (actualHash !== shaManifest[file]) {
      return {
        ok: false,
        code: "HASH_MISMATCH",
        message: `${file} on disk does not match the reviewed/pinned content — refusing to execute an unreviewed file`,
        details: { file, expectedSha256: shaManifest[file], actualSha256: actualHash },
      };
    }
    const destructive = scanForDestructiveStatements(content);
    if (destructive.length > 0) {
      return {
        ok: false,
        code: "DESTRUCTIVE_STATEMENT_DETECTED",
        message: `${file} contains statement(s) this runner refuses to execute: ${destructive.join(", ")}`,
        details: { file, destructive },
      };
    }
  }

  return { ok: true };
}

export type TableSetState = "none" | "all" | "partial";

export async function tableSetState(client: Client, tables: string[]): Promise<TableSetState> {
  const existing = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const existingNames = new Set(existing.rows.map((r) => String(r.name)));
  const present = tables.filter((t) => existingNames.has(t));
  if (present.length === 0) return "none";
  if (present.length === tables.length) return "all";
  return "partial";
}

export type MigrationStepResult = {
  file: TargetMigrationFile;
  status: "applied" | "already-applied" | "would-apply";
  durationMs: number;
};

export type RunResult =
  | { status: "success"; steps: MigrationStepResult[] }
  | { status: "already-fully-applied"; steps: MigrationStepResult[] }
  | { status: "refused"; reason: PreflightFailure }
  | { status: "failed"; steps: MigrationStepResult[]; failedMigration: TargetMigrationFile; error: string };

/**
 * Applies TARGET_MIGRATIONS in order using client.migrate() — per libsql's
 * own contract, each file's statements run inside one transaction (with
 * foreign_keys off/on around it), so a single file can never partially
 * apply. There is NO cross-file transaction: if migration N fails, files
 * before it remain committed and files after it are never attempted — this
 * is reported honestly via the "failed" result's `steps` (what already
 * succeeded) and `failedMigration`, not papered over as all-or-nothing.
 * Stops immediately on the first failure; never continues past it.
 *
 * dryRun reports what WOULD happen (per-file already-applied/would-apply)
 * without executing anything — this is what backs the "production command
 * preview" this phase's own task description asks for, so the preview can
 * be produced and tested without ever setting dryRun: false against a real
 * target.
 */
export async function runTargetMigrations(
  client: Client,
  drizzleDir: string,
  options: {
    environmentLabel: string;
    expectedEnvironmentLabel: string;
    dryRun?: boolean;
    migrationShaManifest?: Record<TargetMigrationFile, string>;
  },
): Promise<RunResult> {
  const preflight = await checkPreflight(client, drizzleDir, options);
  if (!preflight.ok) return { status: "refused", reason: preflight };

  const steps: MigrationStepResult[] = [];
  let allAlreadyApplied = true;

  for (const file of TARGET_MIGRATIONS) {
    const tables = EXPECTED_TABLES_BY_MIGRATION[file];
    const state = await tableSetState(client, tables);

    if (state === "partial") {
      return {
        status: "failed",
        steps,
        failedMigration: file,
        error: `${file} appears partially applied — some but not all of its tables exist (${tables.join(", ")}). Refusing to guess; this needs manual inspection, not an automatic continuation.`,
      };
    }

    if (state === "all") {
      steps.push({ file, status: "already-applied", durationMs: 0 });
      continue;
    }

    allAlreadyApplied = false;

    if (options.dryRun) {
      steps.push({ file, status: "would-apply", durationMs: 0 });
      continue;
    }

    const startedAt = Date.now();
    const sql = fs.readFileSync(path.join(drizzleDir, file), "utf8");
    const statements = splitStatements(sql);
    try {
      await client.migrate(statements);
    } catch (err) {
      return {
        status: "failed",
        steps,
        failedMigration: file,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    steps.push({ file, status: "applied", durationMs: Date.now() - startedAt });
  }

  if (options.dryRun) return { status: "success", steps };
  return { status: allAlreadyApplied ? "already-fully-applied" : "success", steps };
}
