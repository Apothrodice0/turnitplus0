import type { Client } from "@libsql/client";
import type { AsjpSixwordRecord } from "./report-asjp-sixword-evidence";

/**
 * Storage of the INFORMATIONAL six-word overlap record of a saved report (developer-only experiment).
 *
 * Deliberately NOT inside saved_reports.payload_json: the record lives in its own table, written only by the explicit
 * developer action, so it can never make a report save fail, never count against the report's size ceiling, never be
 * re-validated or dropped by a resave, and never reach any score. The saved report row is never written here.
 *
 * SCHEMA — one definition, the formal Preview-only migration `asjp-sixword-0001` (migrations-preview/…sql, applied by
 * scripts/asjp-sixword/migrate-preview-sixword.mjs, never part of drizzle/ so the Production migration set is
 * unchanged). The app does NOT create schema at run time: a write first checks the exact migrated schema
 * (sixwordSchemaProblem) and refuses (SixwordStorageNotMigrated) otherwise. Run-time self-provisioning exists only for
 * local experiments behind ASJP_SIXWORD_SELF_PROVISION=true (never set in a deployment; the preflight refuses it).
 * A trigger removes a report's record whenever its saved_reports row is deleted, on every deletion path (single
 * report, room, account deletion), without touching those routes.
 */
export const ASJP_SIXWORD_TABLE = "asjp_sixword_overlap_records";
export const ASJP_SIXWORD_TRIGGER = `trg_${ASJP_SIXWORD_TABLE}_report_deleted`;
export const ASJP_SIXWORD_MIGRATION_ID = "asjp-sixword-0001";
export const ASJP_SIXWORD_MIGRATION_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${ASJP_SIXWORD_TABLE} (
    device_key TEXT NOT NULL,
    report_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (device_key, report_id)
  )`,
  `CREATE TRIGGER IF NOT EXISTS ${ASJP_SIXWORD_TRIGGER} AFTER DELETE ON saved_reports
   BEGIN DELETE FROM ${ASJP_SIXWORD_TABLE} WHERE device_key = OLD.device_key AND report_id = OLD.id; END`,
];
/** The exact column layout the migration creates: name, type, NOT NULL, primary-key position. */
const EXPECTED_COLUMNS: ReadonlyArray<[string, string, number, number]> = [
  ["device_key", "TEXT", 1, 1], ["report_id", "TEXT", 1, 2], ["record_json", "TEXT", 1, 0], ["status", "TEXT", 1, 0], ["created_at", "TEXT", 1, 0], ["updated_at", "TEXT", 1, 0],
];

export class SixwordStorageNotMigrated extends Error { constructor(readonly problem: string) { super(problem); } }

/** Why the database does not hold exactly the migrated schema, or null. Read-only. */
export async function sixwordSchemaProblem(client: Client): Promise<string | null> {
  const objects = (await client.execute({ sql: "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN (?, ?)", args: [ASJP_SIXWORD_TABLE, ASJP_SIXWORD_TRIGGER] })).rows as unknown as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const table = objects.find((o) => o.type === "table" && o.name === ASJP_SIXWORD_TABLE);
  const trigger = objects.find((o) => o.type === "trigger" && o.name === ASJP_SIXWORD_TRIGGER);
  if (!table) return "TABLE_MISSING";
  if (!trigger) return "TRIGGER_MISSING";
  if (trigger.tbl_name !== "saved_reports" || !/AFTER\s+DELETE\s+ON\s+saved_reports/i.test(trigger.sql) || !/DELETE\s+FROM\s+asjp_sixword_overlap_records\s+WHERE\s+device_key\s*=\s*OLD\.device_key\s+AND\s+report_id\s*=\s*OLD\.id/i.test(trigger.sql)) return "TRIGGER_DIFFERS";
  const columns = (await client.execute(`PRAGMA table_info(${ASJP_SIXWORD_TABLE})`)).rows as unknown as Array<{ name: string; type: string; notnull: number; pk: number }>;
  const got = columns.map((c) => [String(c.name), String(c.type).toUpperCase(), Number(c.notnull), Number(c.pk)].join(":")).sort();
  const want = EXPECTED_COLUMNS.map((c) => c.join(":")).sort();
  if (got.length !== want.length || got.some((g, k) => g !== want[k])) return "COLUMNS_DIFFER";
  return null;
}

/** Applies the migration statements (idempotent). Used by the migration script and by local self-provisioning only. */
export async function applySixwordMigration(client: Client): Promise<void> {
  for (const sql of ASJP_SIXWORD_MIGRATION_SQL) await client.execute(sql);
}

async function requireStorage(client: Client, env: Record<string, string | undefined>): Promise<void> {
  const problem = await sixwordSchemaProblem(client);
  if (!problem) return;
  if (problem === "TABLE_MISSING" && env.ASJP_SIXWORD_SELF_PROVISION === "true" && env.VERCEL_ENV === undefined) { await applySixwordMigration(client); return; }
  throw new SixwordStorageNotMigrated(problem);
}

/** Inserts or replaces the report's record (the developer re-runs or retracts; the newest action wins). */
export async function writeSixwordRecord(client: Client, key: { deviceKey: string; reportId: string }, record: AsjpSixwordRecord, env: Record<string, string | undefined> = process.env): Promise<void> {
  await requireStorage(client, env);
  await client.execute({
    sql: `INSERT INTO ${ASJP_SIXWORD_TABLE} (device_key, report_id, record_json, status) VALUES (?, ?, ?, ?)
          ON CONFLICT(device_key, report_id) DO UPDATE SET record_json = excluded.record_json, status = excluded.status, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    args: [key.deviceKey, key.reportId, JSON.stringify(record), record.status],
  });
}

/** The stored (still unverified) record value, or null. A missing table means no record. */
export async function readSixwordRecord(client: Client, key: { deviceKey: string; reportId: string }): Promise<unknown | null> {
  try {
    const r = await client.execute({ sql: `SELECT record_json FROM ${ASJP_SIXWORD_TABLE} WHERE device_key = ? AND report_id = ?`, args: [key.deviceKey, key.reportId] });
    const raw = (r.rows[0] as unknown as { record_json?: string } | undefined)?.record_json;
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    if (/no such table/i.test(String((error as Error)?.message))) return null;
    throw error;
  }
}

/**
 * Review L1: the ONLY supported way to remove this experiment's storage (the migration's rollback). The trigger is
 * dropped FIRST: a trigger left behind on saved_reports after its table is gone would make every report / account
 * deletion fail. A future rebuild of saved_reports drops the trigger; then sixwordSchemaProblem reports
 * TRIGGER_MISSING and writes are refused until the migration is re-applied (a record whose report no longer exists is
 * never shown — reads always require the report and its owner).
 */
export async function dropSixwordStorage(client: Client): Promise<void> {
  await client.execute(`DROP TRIGGER IF EXISTS ${ASJP_SIXWORD_TRIGGER}`);
  await client.execute(`DROP TABLE IF EXISTS ${ASJP_SIXWORD_TABLE}`);
}
