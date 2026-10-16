import type { Client } from "@libsql/client";
import type { AsjpSixwordRecord } from "./report-asjp-sixword-evidence";

/**
 * Storage of the INFORMATIONAL six-word overlap record of a saved report (developer-only experiment).
 *
 * Deliberately NOT inside saved_reports.payload_json: the record lives in its own table, written only by the explicit
 * developer action, so it can never make a report save fail, never count against the report's size ceiling, never be
 * re-validated or dropped by a resave, and never reach any score. The saved report row is never written here.
 *
 * Self-provisioning (CREATE … IF NOT EXISTS), like lib/ingest.ts's contributions table: no numbered migration is
 * needed for the local / isolated-Preview experiment. A proper migration is required before any Production step.
 * A trigger removes a report's record whenever its saved_reports row is deleted, on every deletion path (single
 * report, room, account deletion), without touching those routes.
 */
export const ASJP_SIXWORD_TABLE = "asjp_sixword_overlap_records";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${ASJP_SIXWORD_TABLE} (
    device_key TEXT NOT NULL,
    report_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (device_key, report_id)
  )`,
  `CREATE TRIGGER IF NOT EXISTS trg_${ASJP_SIXWORD_TABLE}_report_deleted AFTER DELETE ON saved_reports
   BEGIN DELETE FROM ${ASJP_SIXWORD_TABLE} WHERE device_key = OLD.device_key AND report_id = OLD.id; END`,
];

export async function ensureSixwordTable(client: Client): Promise<void> {
  for (const sql of SCHEMA) await client.execute(sql);
}

/** Inserts or replaces the report's record (the developer re-runs or retracts; the newest action wins). */
export async function writeSixwordRecord(client: Client, key: { deviceKey: string; reportId: string }, record: AsjpSixwordRecord): Promise<void> {
  await ensureSixwordTable(client);
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
