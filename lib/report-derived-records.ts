import type { Client, Transaction } from "@libsql/client";

/**
 * The records a saved report leaves behind outside saved_reports, keyed by (report_device_key, report_id) with no foreign
 * key to cascade from. academic_search_run_diagnostics holds the search queries built from the manuscript's own sentences
 * and the candidate sources they returned; the shadow evaluations hold proposed evidence. They are the customer's document
 * data, so they go with the report.
 */
export const REPORT_DERIVED_TABLES = [
  "academic_search_run_diagnostics",
  "historical_match_shadow_evaluations",
  "corpus_duplicate_suppression_shadow_evaluations",
  "pmc_coverage_shadow_evaluations",
] as const;

const CHUNK = 200;

export async function deleteReportDerivedRecords(client: Pick<Client, "execute"> | Pick<Transaction, "execute">, reports: readonly { device_key: string; id: string }[]): Promise<void> {
  for (let i = 0; i < reports.length; i += CHUNK) {
    const chunk = reports.slice(i, i + CHUNK);
    const pairs = chunk.map(() => "(?,?)").join(",");
    for (const table of REPORT_DERIVED_TABLES) {
      await client.execute({ sql: `DELETE FROM ${table} WHERE (report_device_key, report_id) IN (VALUES ${pairs})`, args: chunk.flatMap((r) => [r.device_key, r.id]) });
    }
  }
}
