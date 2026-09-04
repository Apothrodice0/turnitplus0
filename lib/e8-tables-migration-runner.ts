import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";

/**
 * Phase E8E-D.1: an isolated runner whose job is applying every pending
 * migration beyond the pre-0012 baseline (originally 0012-0024 — the Phase
 * A-E8 tables, the privacy/data-lifecycle hardening columns 0023 adds, and
 * the durable rate-limiting table 0024 adds; extended to include 0025-0026
 * — the developer/admin role column and academic-search diagnostics table
 * — and further extended to include 0027 (the room/slot ownership column
 * that replaces the old id%10 visual grouping) and 0028 (the genuine
 * AI-lifecycle status column that distinguishes a permanently failed check
 * from one still in flight — production audit fix) — and, for the corpus-
 * admission release, extended once more through 0029-0036 (the admission-
 * decision/content-store tables, the accepted-representations dedup table
 * and its revocation follow-through, the report-integration and promotion
 * job tables, the admin audit log, and the partial-snapshot/global-
 * generation cache-invalidation columns) — and, for the Device Passport
 * schema foundation, extended once more through 0037-0040 (0037's
 * admin-dashboard sweep-status singleton, which shipped as a file + a
 * db/schema.ts declaration in a501f38 without being folded in here at the
 * time, is included now so this allowlist stays contiguous; 0038's
 * device_passports / device_passport_challenges tables; 0039's per-backing
 * corpus_admission_decision_device_provenance table plus the two
 * verified_device_passport_id columns; 0040's per-passport-generation
 * snapshot staleness column) — and, for the direct-owner-link foundation,
 * corpus-maturity gate, account-identity foundation, email-verification
 * foundation, and developer corpus-maturity exemption that followed,
 * extended once more through 0041-0047 (0041's device-passport actor-usage
 * ledger table plus its device_passports.actor_usage_tracking_version
 * column; 0042's four-table direct owner-link foundation plus its
 * report_historical_match_snapshots.owner_link_generation column — schema
 * only, unwired from scoring; 0043's two corpus-maturity range indexes,
 * the first target migration with neither a new table nor a new column —
 * tracked via the new EXPECTED_INDEXES_BY_MIGRATION / indexSetState()
 * mechanism added specifically for this case, see those declarations'
 * own comments; 0044's corpus-duplicate-suppression shadow-measurement
 * table, whose AFTER DELETE cleanup trigger required both a trigger-aware
 * splitStatements() and a narrowly-scoped destructive-statement exception —
 * see APPROVED_DESTRUCTIVE_STATEMENTS' own comment; 0045's two-table
 * account-identity foundation; 0046's email_verification_challenges table
 * plus users.email_verified_at; and 0047's developer_corpus_maturity_exemptions
 * table) — as a deliberate, reviewed decision, not an
 * automatic side effect of adding those migration files; see this file's own
 * EXPECTED_MIGRATION_SHA256 for how future extensions are meant to be
 * reviewed the same way, and .gitattributes (drizzle/*.sql text eol=lf) for
 * why those pinned hashes are stable on a Windows checkout) to a
 * database that is otherwise already at the pre-0012 baseline. Deliberately
 * separate from lib/ingest.ts's applyMigrationsLibsql(), which replays every
 * migration file in drizzleDir from 0000 onward with no applied-state
 * tracking — correct only against an empty/fresh database (every existing
 * test in this repo uses it exactly that way). Running that function
 * against a non-empty database would replay
 * drizzle/0007_document_chunks_cascade.sql, which contains a real
 * `DROP TABLE document_chunks` as part of a rebuild-for-CASCADE pattern —
 * destructive against a table that already holds real rows. This module
 * never reads or executes 0000-0011, and never imports applyMigrationsLibsql.
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
  "0023_privacy_consent_and_report_identity_link.sql",
  "0024_rate_limit_buckets.sql",
  "0025_users_role.sql",
  "0026_academic_search_run_diagnostics.sql",
  "0027_saved_reports_room_number.sql",
  "0028_saved_reports_ai_status.sql",
  "0029_corpus_admission_decisions.sql",
  "0030_corpus_admission_accepted_representations.sql",
  "0031_corpus_admission_report_jobs.sql",
  "0032_corpus_admission_accepted_representations_revocation.sql",
  "0033_corpus_admission_admin_audit_log.sql",
  "0034_corpus_admission_promotions.sql",
  "0035_report_historical_match_snapshots_partial.sql",
  "0036_corpus_match_generation.sql",
  "0037_corpus_admission_sweep_runs.sql",
  "0038_device_passports.sql",
  "0039_device_passport_provenance.sql",
  "0040_report_historical_match_snapshots_device_generation.sql",
  "0041_device_passport_actor_usage.sql",
  "0042_account_owner_links.sql",
  "0043_corpus_maturity_indexes.sql",
  "0044_corpus_duplicate_suppression_shadow_evaluations.sql",
  "0045_account_identity.sql",
  "0046_email_verification_challenges.sql",
  "0047_developer_corpus_maturity_exemptions.sql",
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
  // 0023 creates no new tables — it only adds columns to the already-
  // existing saved_reports/users tables (see EXPECTED_COLUMNS_BY_MIGRATION
  // below, which is what runTargetMigrations() actually checks applied-state
  // against for this file instead).
  "0023_privacy_consent_and_report_identity_link.sql": [],
  // Unlike 0023, 0024 creates a genuinely new table (durable rate limiting
  // — see drizzle/0024_rate_limit_buckets.sql), so it uses the same plain
  // table-existence tracking as every migration before 0023, not
  // EXPECTED_COLUMNS_BY_MIGRATION.
  "0024_rate_limit_buckets.sql": ["rate_limit_buckets"],
  // Like 0023, 0025 creates no new tables — it only adds a column to the
  // already-existing users table (see EXPECTED_COLUMNS_BY_MIGRATION below).
  "0025_users_role.sql": [],
  // Like 0024, 0026 creates a genuinely new table (developer-diagnostics
  // capture — see drizzle/0026_academic_search_run_diagnostics.sql), tracked
  // via plain table-existence, not EXPECTED_COLUMNS_BY_MIGRATION.
  "0026_academic_search_run_diagnostics.sql": ["academic_search_run_diagnostics"],
  // Like 0023/0025, 0027 creates no new tables — it only adds a column
  // (plus a backfill UPDATE and an index) to the already-existing
  // saved_reports table (see EXPECTED_COLUMNS_BY_MIGRATION below).
  "0027_saved_reports_room_number.sql": [],
  // Like 0023/0025/0027, 0028 creates no new tables — it only adds one
  // column (saved_reports.ai_status) to the already-existing saved_reports
  // table (see EXPECTED_COLUMNS_BY_MIGRATION below).
  "0028_saved_reports_ai_status.sql": [],
  "0029_corpus_admission_decisions.sql": ["corpus_admission_decisions", "corpus_admission_content_store"],
  "0030_corpus_admission_accepted_representations.sql": ["corpus_admission_accepted_representations", "corpus_admission_accepted_shingles"],
  "0031_corpus_admission_report_jobs.sql": ["corpus_admission_report_jobs"],
  // Like 0023/0025/0027/0028, 0032 creates no new tables — it drops and
  // recreates one index (see APPROVED_DESTRUCTIVE_STATEMENTS below) and adds
  // one column (revoked_at) to the already-existing
  // corpus_admission_accepted_representations table (see
  // EXPECTED_COLUMNS_BY_MIGRATION below).
  "0032_corpus_admission_accepted_representations_revocation.sql": [],
  "0033_corpus_admission_admin_audit_log.sql": ["corpus_admission_admin_audit_log"],
  "0034_corpus_admission_promotions.sql": ["corpus_admission_promotions"],
  // Like 0023/0025/0027/0028/0032, 0035 creates no new tables — it only adds
  // one column (is_partial) to the already-existing
  // report_historical_match_snapshots table (see
  // EXPECTED_COLUMNS_BY_MIGRATION below).
  "0035_report_historical_match_snapshots_partial.sql": [],
  // 0036 is a hybrid: it creates one genuinely new table
  // (corpus_match_generation) AND adds a column (corpus_generation) to the
  // already-existing report_historical_match_snapshots table, both inside
  // the same file. Tracked here via plain table-existence rather than
  // EXPECTED_COLUMNS_BY_MIGRATION, which is sound only because
  // runTargetMigrations() applies every statement in a target migration
  // file as one client.migrate() transaction (see this file's own header
  // comment) — corpus_match_generation cannot exist without
  // report_historical_match_snapshots.corpus_generation also existing, so
  // checking the table alone correctly implies the column too.
  "0036_corpus_match_generation.sql": ["corpus_match_generation"],
  "0037_corpus_admission_sweep_runs.sql": ["corpus_admission_sweep_runs"],
  "0038_device_passports.sql": ["device_passports", "device_passport_challenges"],
  // 0039 is a hybrid like 0036: it creates one genuinely new table
  // (corpus_admission_decision_device_provenance) AND adds two columns
  // (saved_reports.verified_device_passport_id,
  // corpus_admission_report_jobs.verified_device_passport_id) in the same
  // client.migrate() transaction — so table existence correctly implies the
  // columns too, and runTargetMigrations() tracks applied-state by the table
  // alone. The columns are ALSO declared in EXPECTED_COLUMNS_BY_MIGRATION
  // below for documentation and test coverage, never as a second gate.
  "0039_device_passport_provenance.sql": ["corpus_admission_decision_device_provenance"],
  // 0040 creates no new table — one column on the already-existing
  // report_historical_match_snapshots, tracked via EXPECTED_COLUMNS_BY_MIGRATION
  // exactly like 0035.
  "0040_report_historical_match_snapshots_device_generation.sql": [],
  // 0041 is a hybrid like 0036/0039: it creates one genuinely new table
  // (device_passport_actor_usage) AND adds one column
  // (device_passports.actor_usage_tracking_version) in the same
  // client.migrate() transaction — table existence correctly implies the
  // column too, so runTargetMigrations() tracks applied-state by the table
  // alone. The column is ALSO declared in EXPECTED_COLUMNS_BY_MIGRATION below
  // for documentation and test coverage, never as a second gate.
  "0041_device_passport_actor_usage.sql": ["device_passport_actor_usage"],
  // 0042 is a hybrid like 0041: it creates four genuinely new tables
  // (account_owner_links, account_owner_link_evidence,
  // account_owner_link_events, account_owner_link_state) AND adds one column
  // (report_historical_match_snapshots.owner_link_generation) in the same
  // client.migrate() transaction — table existence correctly implies the
  // column too. The column is ALSO declared in EXPECTED_COLUMNS_BY_MIGRATION
  // below for documentation and test coverage, never as a second gate.
  "0042_account_owner_links.sql": [
    "account_owner_links",
    "account_owner_link_evidence",
    "account_owner_link_events",
    "account_owner_link_state",
  ],
  // 0043 creates no new table and adds no new column — it only adds two
  // range indexes on already-existing tables (corpus_submission_references,
  // corpus_admission_decisions). Unlike every column-only migration above,
  // there is nothing here for tableSetState() or columnSetState() to observe
  // (columnSetState() would vacuously report "all" forever on an empty list,
  // silently never applying this migration — see EXPECTED_INDEXES_BY_MIGRATION
  // and indexSetState() below, added specifically for this case).
  "0043_corpus_maturity_indexes.sql": [],
  // 0044 creates one genuinely new table
  // (corpus_duplicate_suppression_shadow_evaluations) plus one unique index
  // and one AFTER DELETE cleanup trigger on it, all in the same
  // client.migrate() transaction — table existence implies the index and
  // trigger too. See splitStatements()'s own comment for why this file needs
  // trigger-aware statement splitting, and APPROVED_DESTRUCTIVE_STATEMENTS'
  // own comment for the narrow destructive-statement exception its trigger
  // body requires.
  "0044_corpus_duplicate_suppression_shadow_evaluations.sql": ["corpus_duplicate_suppression_shadow_evaluations"],
  // 0045 creates two genuinely new tables (account_identity_profiles,
  // account_identity_fingerprints) and alters no existing table at all —
  // plain table-existence tracking, like every non-hybrid table-creating
  // migration above.
  "0045_account_identity.sql": ["account_identity_profiles", "account_identity_fingerprints"],
  // 0046 is a hybrid like 0041/0042: it creates one genuinely new table
  // (email_verification_challenges) AND adds one column
  // (users.email_verified_at) in the same client.migrate() transaction —
  // table existence correctly implies the column too. The column is ALSO
  // declared in EXPECTED_COLUMNS_BY_MIGRATION below for documentation and
  // test coverage, never as a second gate.
  "0046_email_verification_challenges.sql": ["email_verification_challenges"],
  // 0047 creates one genuinely new table
  // (developer_corpus_maturity_exemptions) and alters no existing table —
  // plain table-existence tracking.
  "0047_developer_corpus_maturity_exemptions.sql": ["developer_corpus_maturity_exemptions"],
};

export const ALL_TARGET_TABLES: string[] = TARGET_MIGRATIONS.flatMap((m) => EXPECTED_TABLES_BY_MIGRATION[m]);

export type ExpectedColumn = { table: string; column: string };

/**
 * The column-adding counterpart to EXPECTED_TABLES_BY_MIGRATION, for a
 * target migration (0023 is the first) that alters already-existing tables
 * instead of creating new ones — tableSetState()'s table-existence check has
 * nothing to observe for a migration with zero new tables, so
 * runTargetMigrations() below checks columnSetState() instead whenever a
 * file's EXPECTED_TABLES_BY_MIGRATION entry is empty. Every migration not
 * listed here creates only new tables and is unaffected by this map's
 * existence.
 */
export const EXPECTED_COLUMNS_BY_MIGRATION: Partial<Record<TargetMigrationFile, ExpectedColumn[]>> = {
  "0023_privacy_consent_and_report_identity_link.sql": [
    { table: "saved_reports", column: "document_identity_id" },
    { table: "users", column: "corpus_reuse_consented_at" },
  ],
  "0025_users_role.sql": [
    { table: "users", column: "role" },
  ],
  "0027_saved_reports_room_number.sql": [
    { table: "saved_reports", column: "room_number" },
  ],
  "0028_saved_reports_ai_status.sql": [
    { table: "saved_reports", column: "ai_status" },
  ],
  "0032_corpus_admission_accepted_representations_revocation.sql": [
    { table: "corpus_admission_accepted_representations", column: "revoked_at" },
  ],
  "0035_report_historical_match_snapshots_partial.sql": [
    { table: "report_historical_match_snapshots", column: "is_partial" },
  ],
  // 0039's two additive columns — declared for documentation and test
  // coverage. runTargetMigrations() gates 0039's applied-state on its new
  // table (EXPECTED_TABLES_BY_MIGRATION), not on this list, since all three
  // land in the same client.migrate() transaction — see that entry's comment.
  "0039_device_passport_provenance.sql": [
    { table: "saved_reports", column: "verified_device_passport_id" },
    { table: "corpus_admission_report_jobs", column: "verified_device_passport_id" },
  ],
  "0040_report_historical_match_snapshots_device_generation.sql": [
    { table: "report_historical_match_snapshots", column: "device_provenance_generation" },
  ],
  // 0041's additive column — declared for documentation and test coverage.
  // runTargetMigrations() gates 0041's applied-state on its new table
  // (EXPECTED_TABLES_BY_MIGRATION), not on this list, since both land in the
  // same client.migrate() transaction — see that entry's comment.
  "0041_device_passport_actor_usage.sql": [
    { table: "device_passports", column: "actor_usage_tracking_version" },
  ],
  // 0042's additive column — declared for documentation and test coverage.
  // runTargetMigrations() gates 0042's applied-state on its four new tables
  // (EXPECTED_TABLES_BY_MIGRATION), not on this list, since all five land in
  // the same client.migrate() transaction — see that entry's comment.
  "0042_account_owner_links.sql": [
    { table: "report_historical_match_snapshots", column: "owner_link_generation" },
  ],
  // 0046's additive column — declared for documentation and test coverage.
  // runTargetMigrations() gates 0046's applied-state on its new table
  // (EXPECTED_TABLES_BY_MIGRATION), not on this list, since both land in the
  // same client.migrate() transaction — see that entry's comment.
  "0046_email_verification_challenges.sql": [
    { table: "users", column: "email_verified_at" },
  ],
};

/**
 * indexSetState()'s companion declaration — for a migration that adds
 * indexes on already-existing tables and creates neither a new table nor a
 * new column (0043 is the first and, as of this writing, only such case).
 * Every migration not listed here either creates a new table (whose
 * indexes are implied by table existence, per EXPECTED_TABLES_BY_MIGRATION's
 * own comment) or adds a column, and is unaffected by this map's existence.
 */
export const EXPECTED_INDEXES_BY_MIGRATION: Partial<Record<TargetMigrationFile, string[]>> = {
  "0043_corpus_maturity_indexes.sql": [
    "idx_corpus_submission_references_created_at",
    "idx_corpus_admission_decisions_created_at",
  ],
};

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
  // ALL entries computed from the LF bytes git actually stores for these
  // files (verified: sha256(git show HEAD:drizzle/<file>) == the value here
  // for every committed migration; drizzle/*.sql content is byte-identical
  // to HEAD — see git hash-object). .gitattributes pins `drizzle/*.sql text
  // eol=lf` so a Windows checkout with core.autocrlf=true no longer produces
  // CRLF working-tree copies whose fs.readFileSync bytes would mismatch.
  //
  // HISTORICAL CORRECTION (Device Passport schema-foundation pass): the
  // 0012-0020 and 0029 entries below were previously pinned to CRLF-byte
  // hashes — computed on a Windows checkout before .gitattributes existed —
  // so this whole check (and every test depending on checkPreflight) failed
  // on any LF-normalized checkout. Re-pinned to the LF hashes here. No
  // migration SQL content changed; only these hash constants did.
  "0012_document_identities.sql": "01fc8958a14690e6556ed649d1c49358af2b5510d680cd4f3fda8f5a20177275",
  "0013_document_families.sql": "76c36cfdc02912d835c92a02a8bb6be77dc3ae2c15be1581efa65f9e4e1dd767",
  "0014_provenance.sql": "73dfcfc59fb5d95970a45d9865d03fdfa78ef758870f2bfb71398fbc5367dc2c",
  "0015_provenance_evidence.sql": "598763e97f0f7e59081705c893db5aa87d9847b330f8f6f14127c636330e6690",
  "0016_provenance_verification_decisions.sql": "ad70c507528b2710ced2f19b1c6ede6f398b783fed40371662d3ebc7f871a270",
  "0017_discovery_attempts.sql": "7c8f90737698467f20f3b80f1871cc0d32c9b451e65ec938201a9387b626e37d",
  "0018_source_retrievals.sql": "fa32030af1ed654155a6ae712127e9b64715014652d732fd09e0ec0ad2315102",
  "0019_user_submission_corpus.sql": "d174ae6b3d6dc364263786756f7e76ff033721410b13e34b210373ce06656b08",
  "0020_report_historical_match_snapshots.sql": "e437f1abf942caeac51b1b231f78177aea18bf4c8cb6a2653750ccbf6faa584e",
  "0021_historical_match_shadow_evaluations.sql": "757a34bf6ca225a20ac0db9f5673d3f4e51556781b11d184e434bd55b4ab668f",
  "0022_reuse_context_declarations.sql": "80f2d9391a0bd9b89cde22218abcc1438f2c7810d09324bc6dc99e1bbdc03fde",
  "0023_privacy_consent_and_report_identity_link.sql": "ac9fbfb9bfe0e341a6bc9c07ca3fb2db7f38bf382c4e974be65e637466f6d970",
  "0024_rate_limit_buckets.sql": "ab2338f23d689340dcb21d18a6eb75785f20e977082af5957f317617937a34da",
  "0025_users_role.sql": "77856c89d05da4973ef95a52d31062a10f3b3b53fc176965fecc024f6004da94",
  "0026_academic_search_run_diagnostics.sql": "f0ebebb4cd0a9b2e4f36560dc9990fb439a1bc4d8146842a932870934838269b",
  "0027_saved_reports_room_number.sql": "14caa98beb8b566372af7f6b21b24f9cb9d4a7c3db84396b4cd59b360947910d",
  "0028_saved_reports_ai_status.sql": "4b9f5c2bb57a156be7ff8273763b2d516fbde0d87b9e9298e12578fdc0a23d21",
  "0029_corpus_admission_decisions.sql": "236d389a2086299b3e7bf87be1b5008fe22173181750ba61272ebc5c5227bcc8",
  "0030_corpus_admission_accepted_representations.sql": "837743eb56367b46f56fbc23f690e192ce134f3af123ad53f1bb6fa3ed6ad65f",
  "0031_corpus_admission_report_jobs.sql": "558cda4a1497544b5eb5fc44eb48ac649fd379155495710f583a9b5d6dae98a8",
  "0032_corpus_admission_accepted_representations_revocation.sql": "75d30525f8931a8154155aac85d745225f4ea326f7a4b878a65bf8f60f04f9c3",
  "0033_corpus_admission_admin_audit_log.sql": "1e8c3be63c04ecf0759c075378258abbe1ae170308c3c597987fc736a531d4b2",
  "0034_corpus_admission_promotions.sql": "db367f756e6ed366d8794440107dda19fb1c8c10dd477888633b167efd580f5f",
  "0035_report_historical_match_snapshots_partial.sql": "242384eaafaec10cdd2a2735ad4e7863e850da7cbedec57670aec7c8ba33c8e8",
  "0036_corpus_match_generation.sql": "15bb6904337f2502640cc04d5ed88b9e0f3616042852779fd681439c83667b38",
  // Device Passport schema foundation (0037-0040) — LF hashes, pinned fresh.
  "0037_corpus_admission_sweep_runs.sql": "121e04e18e73b17f09f27c8c628dbc08d6d6246789a2ae389ad422342bb2829c",
  "0038_device_passports.sql": "fdd4da86a41f65003f1ece2fb51098d2edec8ba51fa7c9e8b88d2d99c2f558f6",
  "0039_device_passport_provenance.sql": "3805b0b844422ebfce331b8bd20e8fbd57f9a7f5c4c0c9a6da19909dc6e536f0",
  "0040_report_historical_match_snapshots_device_generation.sql": "b5ef400aa4f09bda487cbc31de9be595715c700fbee3ec27d9c3074301a843cf",
  // Direct owner-link foundation / corpus-maturity gate / account-identity
  // foundation / email-verification foundation / developer corpus-maturity
  // exemption (0041-0047) — LF hashes, pinned fresh, computed directly from
  // the files currently in drizzle/ (see this file's own header comment).
  "0041_device_passport_actor_usage.sql": "085c97eeb22ca0a10ab5aa2f1c6ad040c4824f91b9da3fa2280a7015f190d124",
  "0042_account_owner_links.sql": "81289df3bdbe184b6109f85f00c1e8a6636f72abe88391e1e245ce4e434bde9d",
  "0043_corpus_maturity_indexes.sql": "03d11620b5244802b832a08c683c4e8884e07f34089607f318a2d3fe182caf61",
  "0044_corpus_duplicate_suppression_shadow_evaluations.sql": "6a62eaee1a845a74d5ba1b66784b00c79bd784ea5c5ea27061babf2fc75bc8a7",
  "0045_account_identity.sql": "52ea1a2bd50ec37a82bd14a0e6f35739f4e51aaa97cff448fff07fd82c8485ee",
  "0046_email_verification_challenges.sql": "4b37fe8d1029eeff3b7ea983b0cc200d54e9a98f3708e28ac1e4c7f14c269a42",
  "0047_developer_corpus_maturity_exemptions.sql": "7da32d06a251058bd03bc83b46381b849ad92b5a104703ee3543cb049533b1e5",
};

const DESTRUCTIVE_PATTERN = /\b(DROP\s+TABLE|DROP\s+INDEX|ALTER\s+TABLE\s+\S+\s+DROP|DELETE\s+FROM|TRUNCATE)\b/gi;

/** Strips `--` line comments only — none of these 36 files use block comments — so a comment mentioning a keyword by name can't be mistaken for a real statement. */
export function stripSqlLineComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

/**
 * Splits one migration file into individual statements for
 * client.migrate()/client.batch(), which take an array of statements rather
 * than one multi-statement string. Safe for these 36 files specifically
 * (verified: no embedded semicolons in string literals outside a trigger
 * body, no drizzle-kit `--> statement-breakpoint` markers) — not a
 * general-purpose SQL parser.
 *
 * Trigger-aware since the 0041-0047 extension: exactly one target migration
 * (0044_corpus_duplicate_suppression_shadow_evaluations.sql) contains a
 * `CREATE TRIGGER ... BEGIN ... END;` block, whose BEGIN/END body has its own
 * internal statement-terminating semicolon(s). Naive `;`-splitting would
 * shred that block into an invalid, incomplete fragment (missing its own
 * END) plus a dangling `END` — exactly what this migration's own header
 * comment warns about. The dedicated triggerPattern below matches the whole
 * `CREATE TRIGGER ... END;` block (non-greedy, so it stops at the trigger's
 * OWN terminating `END;`, not a later one) as ONE atomic statement, with only
 * its own trailing statement-terminator `;` removed (the body's internal
 * `;` is preserved, since it is part of the trigger's own valid syntax, not
 * a statement separator this function should act on). Everything before and
 * after each matched trigger block is still split normally on `;`. For every
 * other file (no `CREATE TRIGGER` at all), the loop below never matches
 * anything and this degrades to exactly the prior plain `;`-split behavior —
 * verified unchanged by this file's own tests.
 */
export function splitStatements(sql: string): string[] {
  const stripped = stripSqlLineComments(sql);
  const statements: string[] = [];
  const triggerPattern = /CREATE\s+TRIGGER\b[\s\S]*?\bEND\s*;/gi;
  const plainSplit = (text: string) => text.split(";").map((s) => s.trim()).filter((s) => s.length > 0);

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = triggerPattern.exec(stripped)) !== null) {
    statements.push(...plainSplit(stripped.slice(lastIndex, match.index)));
    statements.push(match[0].replace(/;\s*$/, "").trim());
    lastIndex = triggerPattern.lastIndex;
  }
  statements.push(...plainSplit(stripped.slice(lastIndex)));

  return statements;
}

/**
 * Returns every individual destructive STATEMENT found (not just the bare
 * keyword phrase — the full statement, whitespace-collapsed and trimmed,
 * case preserved exactly as written), one entry per matching statement in
 * `sql`. Operates statement-by-statement via splitStatements() rather than
 * scanning the raw text as one blob, so a single file containing one
 * destructive statement and nine safe ones is reported as exactly one
 * finding, not conflated. Case is deliberately preserved (not
 * uppercased) — see APPROVED_DESTRUCTIVE_STATEMENTS below, which compares
 * against this exact output and needs the comparison to be meaningful
 * against the reviewed text, not a case-blind match. Used both at review
 * time and re-checked by checkPreflight() on every single run — see this
 * file's own header comment on why this can never be assumed true from a
 * prior review alone. This function reports every destructive statement it
 * finds, with no exceptions — checkPreflight() below is the only place an
 * approved exception is ever applied, and only for the one file/statement
 * pair APPROVED_DESTRUCTIVE_STATEMENTS lists.
 */
export function scanForDestructiveStatements(sql: string): string[] {
  const flagged: string[] = [];
  for (const statement of splitStatements(sql)) {
    if (statement.match(DESTRUCTIVE_PATTERN)) {
      flagged.push(statement.replace(/\s+/g, " ").trim());
    }
  }
  return flagged;
}

/**
 * A closed, per-file allowlist of individually reviewed destructive
 * statements — the ONLY exception this runner's destructive-statement
 * refusal ever grants, and it is narrow by construction: an entry
 * exempts one exact statement TEXT in one exact FILE, nothing broader.
 * A destructive statement matching this allowlist's text but appearing in
 * a DIFFERENT file is still refused (the key is the filename). Any OTHER
 * destructive statement in the SAME file — even one differing from the
 * approved text by a single character, e.g. a different index name or a
 * missing "IF EXISTS" — is also still refused (checkPreflight() below
 * filters scanForDestructiveStatements()'s findings against this list by
 * exact string equality, not by keyword or prefix). This is a statement-
 * identity allowlist, not a per-file "destructive scanning off" switch.
 *
 * 0032_corpus_admission_accepted_representations_revocation.sql's DROP
 * INDEX is reviewed-safe: it drops a plain UNIQUE index and the very next
 * statement in the same file (applied inside the same client.migrate()
 * transaction — see this file's own header comment on runTargetMigrations)
 * recreates equivalent uniqueness as a partial index
 * (WHERE revoked_at IS NULL). No table, row, or column is ever destroyed by
 * this statement — only a soon-replaced index definition, atomically.
 */
export const APPROVED_DESTRUCTIVE_STATEMENTS: Partial<Record<TargetMigrationFile, string[]>> = {
  "0032_corpus_admission_accepted_representations_revocation.sql": [
    "DROP INDEX IF EXISTS ux_corpus_admission_accepted_representations_canonical_sha256",
  ],
  // 0044_corpus_duplicate_suppression_shadow_evaluations.sql's DELETE FROM is
  // reviewed-safe: it lives entirely inside an AFTER DELETE ... FOR EACH ROW
  // BEGIN ... END trigger body, not a top-level statement this runner would
  // ever execute directly against migration-time data. The trigger only ever
  // FIRES later, at ordinary application runtime, when a real DELETE removes
  // a row from `saved_reports` — and even then it deletes exactly the
  // trigger-owning migration's OWN shadow-measurement rows for that
  // (device_key, id) pair (corpus_duplicate_suppression_shadow_evaluations,
  // matched on report_device_key/report_id), never saved_reports itself or
  // any other table. This is the same atomic-cascade-cleanup shape
  // report_historical_match_snapshots / historical_match_shadow_evaluations
  // already rely on (see drizzle/0044's own header comment) — no table, row,
  // or column this runner creates is ever destroyed by applying this file.
  //
  // The allowlisted text below is the FULL, exact, syntactically complete
  // CREATE TRIGGER statement — including its own closing END — as produced
  // by splitStatements()'s trigger-aware parsing (see that function's own
  // comment on why naive `;`-splitting would otherwise shred this block into
  // an invalid fragment). Matching is exact-string equality against that
  // parsed output, not a keyword or prefix: a different trigger name, a
  // different guarded table, or a missing/altered END is a DIFFERENT string
  // and is still refused, exactly like 0032's own exception.
  "0044_corpus_duplicate_suppression_shadow_evaluations.sql": [
    "CREATE TRIGGER IF NOT EXISTS trg_corpus_duplicate_suppression_shadow_cleanup_on_report_delete AFTER DELETE ON saved_reports FOR EACH ROW BEGIN DELETE FROM corpus_duplicate_suppression_shadow_evaluations WHERE report_device_key = OLD.device_key AND report_id = OLD.id; END",
  ],
};

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
    const approved = new Set(APPROVED_DESTRUCTIVE_STATEMENTS[file] ?? []);
    const unapproved = destructive.filter((statement) => !approved.has(statement));
    if (unapproved.length > 0) {
      return {
        ok: false,
        code: "DESTRUCTIVE_STATEMENT_DETECTED",
        message: `${file} contains statement(s) this runner refuses to execute: ${unapproved.join(", ")}`,
        details: { file, destructive: unapproved },
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

/**
 * tableSetState()'s counterpart for a migration that adds columns to
 * already-existing tables instead of creating new ones (see
 * EXPECTED_COLUMNS_BY_MIGRATION's own comment) — same none/all/partial
 * semantics, checked via PRAGMA table_info() per table instead of
 * sqlite_master table existence. An empty `columns` list (a migration with
 * neither new tables nor new columns — not a real case today, but a
 * degenerate input this should still answer sensibly for) is vacuously
 * "all": there is nothing left for such a migration to apply.
 */
export async function columnSetState(client: Client, columns: ExpectedColumn[]): Promise<TableSetState> {
  if (columns.length === 0) return "all";
  let present = 0;
  for (const { table, column } of columns) {
    const info = await client.execute(`PRAGMA table_info('${table}')`);
    if (info.rows.some((r) => String(r.name) === column)) present += 1;
  }
  if (present === 0) return "none";
  if (present === columns.length) return "all";
  return "partial";
}

/**
 * tableSetState()/columnSetState()'s counterpart for a migration that adds
 * indexes on already-existing tables and creates neither a new table nor a
 * new column (0043 is the first such case — see EXPECTED_INDEXES_BY_MIGRATION's
 * own comment) — same none/all/partial semantics, checked via a single
 * sqlite_master query (mirroring tableSetState()'s style) rather than
 * PRAGMA table_info() per table. An empty `indexes` list is vacuously "all",
 * matching columnSetState()'s own defensive handling of the degenerate case —
 * in practice runTargetMigrations() only ever calls this with a non-empty
 * list, since an empty EXPECTED_INDEXES_BY_MIGRATION entry is simply absent
 * from the map.
 */
export async function indexSetState(client: Client, indexes: string[]): Promise<TableSetState> {
  if (indexes.length === 0) return "all";
  const existing = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
  const existingNames = new Set(existing.rows.map((r) => String(r.name)));
  const present = indexes.filter((i) => existingNames.has(i));
  if (present.length === 0) return "none";
  if (present.length === indexes.length) return "all";
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
    const columns = EXPECTED_COLUMNS_BY_MIGRATION[file];
    const indexes = EXPECTED_INDEXES_BY_MIGRATION[file];
    // A migration with new tables is checked by table existence; one with
    // indexes only (0043) is checked by index existence instead — see
    // indexSetState()'s own comment; anything else (0023) is checked by
    // column existence — see columnSetState()'s own comment.
    const state = tables.length > 0
      ? await tableSetState(client, tables)
      : (indexes && indexes.length > 0)
        ? await indexSetState(client, indexes)
        : await columnSetState(client, columns ?? []);

    if (state === "partial") {
      const what = tables.length > 0
        ? `some but not all of its tables exist (${tables.join(", ")})`
        : (indexes && indexes.length > 0)
          ? `some but not all of its indexes exist (${indexes.join(", ")})`
          : `some but not all of its columns exist (${(columns ?? []).map((c) => `${c.table}.${c.column}`).join(", ")})`;
      return {
        status: "failed",
        steps,
        failedMigration: file,
        error: `${file} appears partially applied — ${what}. Refusing to guess; this needs manual inspection, not an automatic continuation.`,
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
