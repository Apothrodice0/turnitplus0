import type { Client } from "@libsql/client";
import type { DiscoveryAttemptStatus, DiscoveryProviderType, DiscoveryPurpose, RawProviderResult } from "./discovery-types";

/**
 * Phase E6A: the discovery-attempt repository. Records the audit trail of
 * asking a provider for candidates — "what provider did we ask, when,
 * using which signal, what did it return" (this phase's own task
 * description, section 12) — never the deduplicated/ranked candidate list
 * alone, and never anything from the provenance tables (see
 * db/schema.ts's own comment on discovery_attempts). Honest functions,
 * matching every other repository in this codebase: throws rather than
 * swallowing a failure.
 */

export type DiscoveryAttempt = {
  id: number;
  requestId: string;
  documentIdentityId: string | null;
  purpose: DiscoveryPurpose;
  providerId: string;
  providerType: DiscoveryProviderType;
  queriesUsed: string[];
  status: DiscoveryAttemptStatus;
  resultCount: number;
  rawResults: RawProviderResult[] | null;
  errorMessage: string | null;
  requestedAt: string;
  respondedAt: string | null;
  createdAt: string;
};

type RawAttemptRow = {
  id: number;
  request_id: string;
  document_identity_id: string | null;
  purpose: string;
  provider_id: string;
  provider_type: string;
  queries_used_json: string;
  status: string;
  result_count: number;
  raw_results_json: string | null;
  error_message: string | null;
  requested_at: string;
  responded_at: string | null;
  created_at: string;
};

const ATTEMPT_COLUMNS =
  "id, request_id, document_identity_id, purpose, provider_id, provider_type, queries_used_json, status, result_count, raw_results_json, error_message, requested_at, responded_at, created_at";

function toDiscoveryAttempt(row: RawAttemptRow): DiscoveryAttempt {
  return {
    id: Number(row.id),
    requestId: row.request_id,
    documentIdentityId: row.document_identity_id,
    purpose: row.purpose as DiscoveryPurpose,
    providerId: row.provider_id,
    providerType: row.provider_type as DiscoveryProviderType,
    queriesUsed: JSON.parse(row.queries_used_json),
    status: row.status as DiscoveryAttemptStatus,
    resultCount: Number(row.result_count),
    rawResults: row.raw_results_json ? JSON.parse(row.raw_results_json) : null,
    errorMessage: row.error_message,
    requestedAt: row.requested_at,
    respondedAt: row.responded_at,
    createdAt: row.created_at,
  };
}

export type RecordDiscoveryAttemptParams = {
  requestId: string;
  documentIdentityId?: string | null;
  purpose: DiscoveryPurpose;
  providerId: string;
  providerType: DiscoveryProviderType;
  queriesUsed: string[];
  status: DiscoveryAttemptStatus;
  resultCount: number;
  rawResults?: RawProviderResult[] | null;
  errorMessage?: string | null;
  requestedAt: string;
  respondedAt?: string | null;
};

export async function recordDiscoveryAttempt(client: Client, params: RecordDiscoveryAttemptParams): Promise<DiscoveryAttempt> {
  const result = await client.execute({
    sql: `INSERT INTO discovery_attempts
            (request_id, document_identity_id, purpose, provider_id, provider_type, queries_used_json, status, result_count, raw_results_json, error_message, requested_at, responded_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      params.requestId,
      params.documentIdentityId ?? null,
      params.purpose,
      params.providerId,
      params.providerType,
      JSON.stringify(params.queriesUsed),
      params.status,
      params.resultCount,
      params.rawResults ? JSON.stringify(params.rawResults) : null,
      params.errorMessage ?? null,
      params.requestedAt,
      params.respondedAt ?? null,
    ],
  });
  const id = Number(result.lastInsertRowid);
  const row = await client.execute({ sql: `SELECT ${ATTEMPT_COLUMNS} FROM discovery_attempts WHERE id = ?`, args: [id] });
  const raw = row.rows[0] as unknown as RawAttemptRow | undefined;
  if (!raw) throw new Error(`recordDiscoveryAttempt: row ${id} was not found immediately after insert`);
  return toDiscoveryAttempt(raw);
}

/** Every provider attempt made for one discovery run, in the order they were made. */
export async function findDiscoveryAttemptsForRequest(client: Client, requestId: string): Promise<DiscoveryAttempt[]> {
  const result = await client.execute({
    sql: `SELECT ${ATTEMPT_COLUMNS} FROM discovery_attempts WHERE request_id = ? ORDER BY id ASC`,
    args: [requestId],
  });
  return (result.rows as unknown as RawAttemptRow[]).map(toDiscoveryAttempt);
}

/** Every discovery attempt ever made for a document identity, across every discovery run — the full discovery history for one document. */
export async function findDiscoveryAttemptsForDocumentIdentity(client: Client, documentIdentityId: string): Promise<DiscoveryAttempt[]> {
  const result = await client.execute({
    sql: `SELECT ${ATTEMPT_COLUMNS} FROM discovery_attempts WHERE document_identity_id = ? ORDER BY id ASC`,
    args: [documentIdentityId],
  });
  return (result.rows as unknown as RawAttemptRow[]).map(toDiscoveryAttempt);
}
