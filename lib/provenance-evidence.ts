import type { Client } from "@libsql/client";
import { type EvidenceType, type EvidencePayloadByType } from "./provenance-evidence-types";

/**
 * Phase E4: the evidence-record repository. Every function here is honest
 * (throws on failure rather than swallowing errors), matching the
 * convention established in lib/document-identity.ts, lib/document-family.ts,
 * and lib/provenance-registry.ts. Nothing here is called from any live route
 * — this is inert, directly testable infrastructure, exactly as
 * lib/provenance-registry.ts started out in Phase E1.
 *
 * Deliberately no update or delete function exists in this file.
 * provenance_evidence is append-only: if a previously-recorded fact changes,
 * the caller records a NEW evidence record with a later observedAt; the old
 * row is never modified or removed. This is enforced by omission (there is
 * no SQL UPDATE/DELETE anywhere below), not by a database-level trigger —
 * consistent with this schema's existing "no CHECK constraints, validity
 * enforced at the TS application layer" convention.
 */

export type ProvenanceEvidence<T extends EvidenceType = EvidenceType> = {
  id: number;
  sourceId: string;
  evidenceType: T;
  payload: EvidencePayloadByType[T];
  observedAt: string;
  createdAt: string;
};

type RawEvidenceRow = {
  id: number;
  source_id: string;
  evidence_type: string;
  payload_json: string;
  observed_at: string;
  created_at: string;
};

function toProvenanceEvidence(row: RawEvidenceRow): ProvenanceEvidence {
  return {
    id: Number(row.id),
    sourceId: row.source_id,
    evidenceType: row.evidence_type as EvidenceType,
    payload: JSON.parse(row.payload_json),
    observedAt: row.observed_at,
    createdAt: row.created_at,
  };
}

const EVIDENCE_COLUMNS = "id, source_id, evidence_type, payload_json, observed_at, created_at";

export type CreateProvenanceEvidenceParams<T extends EvidenceType = EvidenceType> = {
  sourceId: string;
  evidenceType: T;
  payload: EvidencePayloadByType[T];
  /** When this fact was actually observed (e.g. when a URL was fetched) — independent of createdAt (when this row was written). Defaults to now if omitted. */
  observedAt?: string;
};

/**
 * Appends one evidence record for a source. There is no dedup check and no
 * uniqueness constraint: recording the same fact twice (or a contradicting
 * fact later) is expected and safe — see this module's own header comment,
 * and lib/provenance-verification-policy.ts, which is responsible for
 * interpreting a source's full evidence history, including duplicates and
 * superseding facts, not this function.
 */
export async function createProvenanceEvidence<T extends EvidenceType>(
  client: Client,
  params: CreateProvenanceEvidenceParams<T>,
): Promise<ProvenanceEvidence<T>> {
  const observedAt = params.observedAt ?? new Date().toISOString();
  const result = await client.execute({
    sql: `INSERT INTO provenance_evidence (source_id, evidence_type, payload_json, observed_at, created_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [params.sourceId, params.evidenceType, JSON.stringify(params.payload), observedAt],
  });
  const id = Number(result.lastInsertRowid);
  const row = await client.execute({
    sql: `SELECT ${EVIDENCE_COLUMNS} FROM provenance_evidence WHERE id = ?`,
    args: [id],
  });
  const raw = row.rows[0] as unknown as RawEvidenceRow | undefined;
  if (!raw) throw new Error(`createProvenanceEvidence: row ${id} was not found immediately after insert`);
  return toProvenanceEvidence(raw) as ProvenanceEvidence<T>;
}

/**
 * Every evidence record for a source, in chronological order (by observedAt,
 * then id as a stable tiebreaker for equal timestamps) — this ordering is
 * what makes the result usable directly as a source's evidence history, and
 * is also what lib/provenance-verification-policy.ts's pure functions expect
 * (though they re-sort defensively rather than trusting caller order — see
 * that module's header comment).
 */
export async function findEvidenceForSource(client: Client, sourceId: string): Promise<ProvenanceEvidence[]> {
  const result = await client.execute({
    sql: `SELECT ${EVIDENCE_COLUMNS} FROM provenance_evidence WHERE source_id = ? ORDER BY observed_at ASC, id ASC`,
    args: [sourceId],
  });
  return (result.rows as unknown as RawEvidenceRow[]).map(toProvenanceEvidence);
}

/** Every evidence record of one type for a source, in the same chronological order as findEvidenceForSource. */
export async function findEvidenceByType<T extends EvidenceType>(
  client: Client,
  sourceId: string,
  evidenceType: T,
): Promise<ProvenanceEvidence<T>[]> {
  const result = await client.execute({
    sql: `SELECT ${EVIDENCE_COLUMNS} FROM provenance_evidence WHERE source_id = ? AND evidence_type = ? ORDER BY observed_at ASC, id ASC`,
    args: [sourceId, evidenceType],
  });
  return (result.rows as unknown as RawEvidenceRow[]).map((row) => toProvenanceEvidence(row) as ProvenanceEvidence<T>);
}
