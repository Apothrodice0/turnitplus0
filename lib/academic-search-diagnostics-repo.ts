import type { Client } from "@libsql/client";
import type {
  AcademicSearchCandidate,
  AcademicSearchQuery,
  AcademicSearchRetrievalDiagnostic,
  AcademicSearchRunStats,
  AcademicSearchStatus,
} from "./academic-search/types";

/**
 * Repository for academic_search_run_diagnostics (see db/schema.ts's own
 * header comment on that table). Read only by app/api/developer/* — never
 * imported by the live report/scoring path, matching this codebase's
 * existing convention of keeping feature modules unaware of report-facing
 * or admin-facing bridges (see lib/report-classification.ts's own comment
 * on the same discipline).
 *
 * Defensive, not algorithmic: MAX_STORED_CANDIDATES bounds how many ranked
 * candidates get persisted for inspection so one unusually broad-recall
 * submission can't produce an unbounded row — it has no effect on which
 * candidates the pipeline itself ranks, retrieves, or reports as evidence.
 */
const MAX_STORED_CANDIDATES = 200;

/**
 * documentIdentityId/reportDeviceKey/reportId are all optional here (unlike
 * a normal repository insert) because this is called from
 * app/api/academic-evidence/route.ts — BEFORE a report id or document
 * identity exists (see that route's own comment on why). The row is created
 * with those three null and linked later by linkAcademicSearchRunDiagnosticsToReport,
 * once app/api/reports/route.ts's deferred callback knows both. This two-step
 * shape (record now, link later) exists specifically so the raw diagnostic
 * content itself — candidates, queries, provider errors, timings — never has
 * to round-trip through the client at all: only a bare numeric id does. See
 * that route's own header comment for the full rationale.
 */
export type RecordAcademicSearchRunDiagnosticsParams = {
  status: AcademicSearchStatus;
  stats: AcademicSearchRunStats;
  queries: AcademicSearchQuery[] | null;
  candidates: AcademicSearchCandidate[] | null;
  retrievalDiagnostics: AcademicSearchRetrievalDiagnostic[] | null;
};

/** Inserts one unlinked diagnostics row and returns its id — the only thing app/api/academic-evidence/route.ts ever sends back to the client. */
export async function recordAcademicSearchRunDiagnostics(client: Client, params: RecordAcademicSearchRunDiagnosticsParams): Promise<number> {
  const boundedCandidates = params.candidates ? params.candidates.slice(0, MAX_STORED_CANDIDATES) : null;
  const result = await client.execute({
    sql: `INSERT INTO academic_search_run_diagnostics
            (document_identity_id, report_device_key, report_id, status, total_latency_ms, stats_json, queries_json, candidates_json, retrieval_diagnostics_json)
          VALUES (NULL, NULL, NULL, ?,?,?,?,?,?)`,
    args: [
      params.status,
      params.stats.totalLatencyMs,
      JSON.stringify(params.stats),
      params.queries ? JSON.stringify(params.queries) : null,
      boundedCandidates ? JSON.stringify(boundedCandidates) : null,
      params.retrievalDiagnostics ? JSON.stringify(params.retrievalDiagnostics) : null,
    ],
  });
  return Number(result.lastInsertRowid);
}

export type LinkAcademicSearchRunDiagnosticsParams = {
  documentIdentityId: string | null;
  reportDeviceKey: string;
  reportId: string;
};

/**
 * Called from app/api/reports/route.ts's deferred save callback — the first
 * point where a report id and (usually) a document identity actually exist.
 * A no-op (0 rows affected, not an error) if `id` doesn't correspond to a
 * real unlinked row — e.g. a stale/forged id a client sent — since this must
 * never be able to fail a report save.
 */
export async function linkAcademicSearchRunDiagnosticsToReport(client: Client, id: number, params: LinkAcademicSearchRunDiagnosticsParams): Promise<void> {
  await client.execute({
    sql: `UPDATE academic_search_run_diagnostics SET document_identity_id = ?, report_device_key = ?, report_id = ? WHERE id = ? AND report_device_key IS NULL AND report_id IS NULL`,
    args: [params.documentIdentityId, params.reportDeviceKey, params.reportId, id],
  });
}

export type AcademicSearchRunDiagnosticsRow = {
  id: number;
  documentIdentityId: string | null;
  reportDeviceKey: string | null;
  reportId: string | null;
  status: AcademicSearchStatus;
  totalLatencyMs: number;
  stats: AcademicSearchRunStats;
  queries: AcademicSearchQuery[] | null;
  candidates: AcademicSearchCandidate[] | null;
  retrievalDiagnostics: AcademicSearchRetrievalDiagnostic[] | null;
  createdAt: string;
};

type RawRow = {
  id: number;
  document_identity_id: string | null;
  report_device_key: string | null;
  report_id: string | null;
  status: string;
  total_latency_ms: number;
  stats_json: string;
  queries_json: string | null;
  candidates_json: string | null;
  retrieval_diagnostics_json: string | null;
  created_at: string;
};

const COLUMNS =
  "id, document_identity_id, report_device_key, report_id, status, total_latency_ms, stats_json, queries_json, candidates_json, retrieval_diagnostics_json, created_at";

function toRow(raw: RawRow): AcademicSearchRunDiagnosticsRow {
  return {
    id: Number(raw.id),
    documentIdentityId: raw.document_identity_id,
    reportDeviceKey: raw.report_device_key,
    reportId: raw.report_id,
    status: raw.status as AcademicSearchStatus,
    totalLatencyMs: Number(raw.total_latency_ms),
    stats: JSON.parse(raw.stats_json),
    queries: raw.queries_json ? JSON.parse(raw.queries_json) : null,
    candidates: raw.candidates_json ? JSON.parse(raw.candidates_json) : null,
    retrievalDiagnostics: raw.retrieval_diagnostics_json ? JSON.parse(raw.retrieval_diagnostics_json) : null,
    createdAt: raw.created_at,
  };
}

/** Every diagnostics run captured for one document identity, most recent first — the "has this exact submission event been analyzed before, and what did the pipeline see" view. */
export async function findAcademicSearchRunDiagnosticsByDocumentIdentityId(client: Client, documentIdentityId: string): Promise<AcademicSearchRunDiagnosticsRow[]> {
  const result = await client.execute({
    sql: `SELECT ${COLUMNS} FROM academic_search_run_diagnostics WHERE document_identity_id = ? ORDER BY id DESC`,
    args: [documentIdentityId],
  });
  return (result.rows as unknown as RawRow[]).map(toRow);
}

/** The diagnostics run captured for one specific saved report, if any. */
export async function findAcademicSearchRunDiagnosticsByReport(client: Client, reportDeviceKey: string, reportId: string): Promise<AcademicSearchRunDiagnosticsRow | undefined> {
  const result = await client.execute({
    sql: `SELECT ${COLUMNS} FROM academic_search_run_diagnostics WHERE report_device_key = ? AND report_id = ? ORDER BY id DESC LIMIT 1`,
    args: [reportDeviceKey, reportId],
  });
  const raw = result.rows[0] as unknown as RawRow | undefined;
  return raw ? toRow(raw) : undefined;
}

/** Most recent diagnostics runs across every account — the developer dashboard's overview feed. */
export async function findRecentAcademicSearchRunDiagnostics(client: Client, limit = 50): Promise<AcademicSearchRunDiagnosticsRow[]> {
  const result = await client.execute({
    sql: `SELECT ${COLUMNS} FROM academic_search_run_diagnostics ORDER BY id DESC LIMIT ?`,
    args: [limit],
  });
  return (result.rows as unknown as RawRow[]).map(toRow);
}
