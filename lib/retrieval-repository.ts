import type { Client } from "@libsql/client";
import type { RetrievalStatus } from "./retrieval-types";

/**
 * Phase E6C: the source-retrieval repository. Records the audit trail of
 * actually fetching a candidate's content — separate from
 * lib/discovery-repository.ts's discovery_attempts (which only records
 * whether a provider found a candidate at all) and from
 * lib/provenance-evidence.ts (which records interpreted *evidence*, not the
 * raw retrieval attempt itself — see lib/retrieval-correspondence-bridge.ts
 * for the function that creates both from one retrieval). Honest functions,
 * matching every other repository in this codebase: throws rather than
 * swallowing a failure.
 */

/** Independent of any retriever's own maxExtractedTextLength (which bounds what the correspondence engine sees, in memory) — this bounds what actually gets written to the database, deliberately much smaller, so this table can never become a mirror of retrieved pages. */
export const MAX_STORED_EXCERPT_LENGTH = 5_000;

export type SourceRetrieval = {
  id: number;
  sourceId: string;
  originalUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  contentType: string | null;
  retrievedAt: string;
  rawSha256: string | null;
  canonicalSha256: string | null;
  extractedTextExcerpt: string | null;
  extractorVersion: string | null;
  status: RetrievalStatus;
  errorMessage: string | null;
  createdAt: string;
};

type RawRetrievalRow = {
  id: number;
  source_id: string;
  original_url: string;
  final_url: string | null;
  http_status: number | null;
  content_type: string | null;
  retrieved_at: string;
  raw_sha256: string | null;
  canonical_sha256: string | null;
  extracted_text_excerpt: string | null;
  extractor_version: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
};

const RETRIEVAL_COLUMNS =
  "id, source_id, original_url, final_url, http_status, content_type, retrieved_at, raw_sha256, canonical_sha256, extracted_text_excerpt, extractor_version, status, error_message, created_at";

function toSourceRetrieval(row: RawRetrievalRow): SourceRetrieval {
  return {
    id: Number(row.id),
    sourceId: row.source_id,
    originalUrl: row.original_url,
    finalUrl: row.final_url,
    httpStatus: row.http_status,
    contentType: row.content_type,
    retrievedAt: row.retrieved_at,
    rawSha256: row.raw_sha256,
    canonicalSha256: row.canonical_sha256,
    extractedTextExcerpt: row.extracted_text_excerpt,
    extractorVersion: row.extractor_version,
    status: row.status as RetrievalStatus,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

export type CreateSourceRetrievalParams = {
  sourceId: string;
  originalUrl: string;
  finalUrl?: string | null;
  httpStatus?: number | null;
  contentType?: string | null;
  retrievedAt: string;
  rawSha256?: string | null;
  canonicalSha256?: string | null;
  /** Truncated to MAX_STORED_EXCERPT_LENGTH before being written — see this module's own header comment. */
  extractedText?: string | null;
  extractorVersion?: string | null;
  status: RetrievalStatus;
  errorMessage?: string | null;
};

export async function createSourceRetrieval(client: Client, params: CreateSourceRetrievalParams): Promise<SourceRetrieval> {
  const excerpt = params.extractedText ? params.extractedText.slice(0, MAX_STORED_EXCERPT_LENGTH) : null;
  const result = await client.execute({
    sql: `INSERT INTO source_retrievals
            (source_id, original_url, final_url, http_status, content_type, retrieved_at, raw_sha256, canonical_sha256, extracted_text_excerpt, extractor_version, status, error_message, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      params.sourceId,
      params.originalUrl,
      params.finalUrl ?? null,
      params.httpStatus ?? null,
      params.contentType ?? null,
      params.retrievedAt,
      params.rawSha256 ?? null,
      params.canonicalSha256 ?? null,
      excerpt,
      params.extractorVersion ?? null,
      params.status,
      params.errorMessage ?? null,
    ],
  });
  const id = Number(result.lastInsertRowid);
  const row = await client.execute({ sql: `SELECT ${RETRIEVAL_COLUMNS} FROM source_retrievals WHERE id = ?`, args: [id] });
  const raw = row.rows[0] as unknown as RawRetrievalRow | undefined;
  if (!raw) throw new Error(`createSourceRetrieval: row ${id} was not found immediately after insert`);
  return toSourceRetrieval(raw);
}

/** Every retrieval attempt ever made for one candidate source, in the order they happened. */
export async function findSourceRetrievalsForSource(client: Client, sourceId: string): Promise<SourceRetrieval[]> {
  const result = await client.execute({
    sql: `SELECT ${RETRIEVAL_COLUMNS} FROM source_retrievals WHERE source_id = ? ORDER BY id ASC`,
    args: [sourceId],
  });
  return (result.rows as unknown as RawRetrievalRow[]).map(toSourceRetrieval);
}
