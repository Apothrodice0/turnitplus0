import { randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import {
  isValidProvenanceTransition,
  type ProvenanceState,
  type SourceProviderType,
} from "./provenance-types";

/**
 * Phase E1: the provenance registry's repository layer. Every function here
 * is honest (throws on failure rather than swallowing errors) — matching
 * the convention established in lib/document-identity.ts and
 * lib/document-family.ts, so a caller decides whether a failure is fatal or
 * best-effort. Nothing here is called from any live route yet: this is
 * inert, directly testable infrastructure, exactly as Phase B's
 * lib/document-family.ts started out before Phase C activated it.
 */

export type ProvenanceSource = {
  id: string;
  provenanceState: ProvenanceState;
  sourceType: SourceProviderType;
  canonicalUrl: string | null;
  externalIdentifier: string | null;
  title: string | null;
  author: string | null;
  publisher: string | null;
  publicationDate: string | null;
  retrievedAt: string | null;
  contentHash: string | null;
  verificationMethod: string | null;
  verificationNotes: string | null;
  documentIdentityId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProvenanceEvent = {
  id: number;
  sourceId: string;
  previousState: ProvenanceState | null;
  newState: ProvenanceState;
  reason: string | null;
  evidence: string | null;
  createdAt: string;
};

type RawProvenanceSourceRow = {
  id: string;
  provenance_state: string;
  source_type: string;
  canonical_url: string | null;
  external_identifier: string | null;
  title: string | null;
  author: string | null;
  publisher: string | null;
  publication_date: string | null;
  retrieved_at: string | null;
  content_hash: string | null;
  verification_method: string | null;
  verification_notes: string | null;
  document_identity_id: string | null;
  created_at: string;
  updated_at: string;
};

type RawProvenanceEventRow = {
  id: number;
  source_id: string;
  previous_state: string | null;
  new_state: string;
  reason: string | null;
  evidence: string | null;
  created_at: string;
};

function toProvenanceSource(row: RawProvenanceSourceRow): ProvenanceSource {
  return {
    id: row.id,
    provenanceState: row.provenance_state as ProvenanceState,
    sourceType: row.source_type as SourceProviderType,
    canonicalUrl: row.canonical_url,
    externalIdentifier: row.external_identifier,
    title: row.title,
    author: row.author,
    publisher: row.publisher,
    publicationDate: row.publication_date,
    retrievedAt: row.retrieved_at,
    contentHash: row.content_hash,
    verificationMethod: row.verification_method,
    verificationNotes: row.verification_notes,
    documentIdentityId: row.document_identity_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProvenanceEvent(row: RawProvenanceEventRow): ProvenanceEvent {
  return {
    id: Number(row.id),
    sourceId: row.source_id,
    previousState: row.previous_state as ProvenanceState | null,
    newState: row.new_state as ProvenanceState,
    reason: row.reason,
    evidence: row.evidence,
    createdAt: row.created_at,
  };
}

const SOURCE_COLUMNS = `id, provenance_state, source_type, canonical_url, external_identifier, title, author,
       publisher, publication_date, retrieved_at, content_hash, verification_method, verification_notes,
       document_identity_id, created_at, updated_at`;

export type CreateProvenanceSourceParams = {
  /** The source's starting state — not defaulted, so a caller must decide deliberately (e.g. OBSERVED_SUBMISSION vs UNKNOWN vs CANDIDATE_SOURCE). */
  provenanceState: ProvenanceState;
  sourceType: SourceProviderType;
  canonicalUrl?: string | null;
  externalIdentifier?: string | null;
  title?: string | null;
  author?: string | null;
  publisher?: string | null;
  publicationDate?: string | null;
  retrievedAt?: string | null;
  contentHash?: string | null;
  verificationMethod?: string | null;
  verificationNotes?: string | null;
  documentIdentityId?: string | null;
  /** Recorded on the genesis provenance_events row as `reason`; e.g. "created from a user submission" or "manually entered candidate source". */
  reason?: string | null;
  evidence?: string | null;
};

/**
 * Creates a provenance_sources row and its genesis provenance_events row
 * (previous_state = null) atomically via client.batch. This is the only way
 * a source is ever created — there is no path that inserts a source without
 * also recording how it started.
 */
export async function createProvenanceSource(client: Client, params: CreateProvenanceSourceParams): Promise<ProvenanceSource> {
  const id = randomUUID();
  const insertSource: InStatement = {
    sql: `INSERT INTO provenance_sources
            (id, provenance_state, source_type, canonical_url, external_identifier, title, author,
             publisher, publication_date, retrieved_at, content_hash, verification_method, verification_notes,
             document_identity_id, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [
      id,
      params.provenanceState,
      params.sourceType,
      params.canonicalUrl ?? null,
      params.externalIdentifier ?? null,
      params.title ?? null,
      params.author ?? null,
      params.publisher ?? null,
      params.publicationDate ?? null,
      params.retrievedAt ?? null,
      params.contentHash ?? null,
      params.verificationMethod ?? null,
      params.verificationNotes ?? null,
      params.documentIdentityId ?? null,
    ],
  };
  const insertEvent: InStatement = {
    sql: `INSERT INTO provenance_events (source_id, previous_state, new_state, reason, evidence, created_at)
          VALUES (?,NULL,?,?,?,CURRENT_TIMESTAMP)`,
    args: [id, params.provenanceState, params.reason ?? null, params.evidence ?? null],
  };
  await client.batch([insertSource, insertEvent], "write");

  const created = await findProvenanceSourceById(client, id);
  if (!created) throw new Error(`createProvenanceSource: row ${id} was not found immediately after insert`);
  return created;
}

/**
 * Represents a TurnitPlus account's own submission as OBSERVED_SUBMISSION
 * provenance (Required Behavior, Phase E1 section 5). Deliberately has no
 * `accountId` parameter at all — account identity must never be exposed as
 * source provenance, so there is no field here for it to leak through. Does
 * not read or modify document_identities; the caller supplies the id it
 * already has (e.g. from lib/document-identity.ts's createDocumentIdentity).
 */
export async function createObservedSubmissionProvenance(
  client: Client,
  params: { documentIdentityId: string; title?: string | null; contentHash?: string | null },
): Promise<ProvenanceSource> {
  return createProvenanceSource(client, {
    provenanceState: "OBSERVED_SUBMISSION",
    sourceType: "user_submission",
    documentIdentityId: params.documentIdentityId,
    title: params.title ?? null,
    contentHash: params.contentHash ?? null,
    reason: "observed as a TurnitPlus account submission",
  });
}

export async function findProvenanceSourceById(client: Client, id: string): Promise<ProvenanceSource | null> {
  const result = await client.execute({
    sql: `SELECT ${SOURCE_COLUMNS} FROM provenance_sources WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0] as unknown as RawProvenanceSourceRow | undefined;
  return row ? toProvenanceSource(row) : null;
}

/** The most recently created provenance_sources row for a document identity, or null if none exists. Nothing in this schema enforces at most one — see this file's own header comment and lib/document-identity.ts's precedent of not deduplicating at insert time. */
export async function findProvenanceSourceForDocumentIdentity(client: Client, documentIdentityId: string): Promise<ProvenanceSource | null> {
  const result = await client.execute({
    sql: `SELECT ${SOURCE_COLUMNS} FROM provenance_sources WHERE document_identity_id = ? ORDER BY created_at ASC, rowid ASC`,
    args: [documentIdentityId],
  });
  const rows = result.rows as unknown as RawProvenanceSourceRow[];
  const last = rows.at(-1);
  return last ? toProvenanceSource(last) : null;
}

/**
 * Phase E6D: every provenance_sources row ever created for a document
 * identity, not just the most recent — a document can legitimately have
 * several (one per discovered candidate), where
 * findProvenanceSourceForDocumentIdentity above only ever returns the
 * latest. Added for lib/source-discovery-workflow.ts's idempotency check
 * (does this document already have a source matching a newly-discovered
 * candidate's URL/identifier, from an earlier workflow run) — a pure,
 * additive read function, no schema or behavior change to any existing
 * caller.
 */
export async function findProvenanceSourcesForDocumentIdentity(client: Client, documentIdentityId: string): Promise<ProvenanceSource[]> {
  const result = await client.execute({
    sql: `SELECT ${SOURCE_COLUMNS} FROM provenance_sources WHERE document_identity_id = ? ORDER BY created_at ASC, rowid ASC`,
    args: [documentIdentityId],
  });
  return (result.rows as unknown as RawProvenanceSourceRow[]).map(toProvenanceSource);
}

/** Full, ordered event history for one source — the record of every state it has ever held and when. */
export async function findProvenanceEventsForSource(client: Client, sourceId: string): Promise<ProvenanceEvent[]> {
  const result = await client.execute({
    sql: `SELECT id, source_id, previous_state, new_state, reason, evidence, created_at
          FROM provenance_events WHERE source_id = ? ORDER BY id ASC`,
    args: [sourceId],
  });
  return (result.rows as unknown as RawProvenanceEventRow[]).map(toProvenanceEvent);
}

export type TransitionProvenanceStateParams = {
  sourceId: string;
  toState: ProvenanceState;
  reason?: string | null;
  evidence?: string | null;
};

/**
 * Moves a source to a new state, validated against
 * lib/provenance-types.ts's transition graph, and atomically records the
 * transition as a new provenance_events row (client.batch: the
 * provenance_sources UPDATE and the provenance_events INSERT happen
 * together or not at all). Throws — does not silently no-op — for an
 * unknown source or an invalid transition, consistent with this module's
 * "honest functions" convention.
 *
 * `extraStatements` (Phase E5): optional additional statements executed in
 * the SAME atomic batch as the state transition — added so a caller (e.g.
 * lib/provenance-verification-workflow.ts's decision-recording functions)
 * can make a verification-decision row and its corresponding state
 * transition succeed or fail together, without this function needing to
 * know anything about what a "verification decision" is. Existing callers
 * are unaffected: the parameter defaults to an empty array, and the return
 * shape only gains an additional `extraResults` field (each extra
 * statement's own ResultSet, in the order given — e.g. `extraResults[0]
 * .lastInsertRowid` for an INSERT), which callers that destructure only
 * `{ source, event }` never observe.
 */
export async function transitionProvenanceState(
  client: Client,
  params: TransitionProvenanceStateParams,
  extraStatements: InStatement[] = [],
): Promise<{ source: ProvenanceSource; event: ProvenanceEvent; extraResults: Awaited<ReturnType<Client["batch"]>> }> {
  const current = await findProvenanceSourceById(client, params.sourceId);
  if (!current) throw new Error(`transitionProvenanceState: no provenance_sources row ${params.sourceId}`);

  const from = current.provenanceState;
  const to = params.toState;
  if (!isValidProvenanceTransition(from, to)) {
    throw new Error(`transitionProvenanceState: ${from} -> ${to} is not an allowed provenance transition`);
  }

  const updateSource: InStatement = {
    sql: `UPDATE provenance_sources SET provenance_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [to, params.sourceId],
  };
  const insertEvent: InStatement = {
    sql: `INSERT INTO provenance_events (source_id, previous_state, new_state, reason, evidence, created_at)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [params.sourceId, from, to, params.reason ?? null, params.evidence ?? null],
  };
  const results = await client.batch([updateSource, insertEvent, ...extraStatements], "write");

  const updated = await findProvenanceSourceById(client, params.sourceId);
  if (!updated) throw new Error(`transitionProvenanceState: row ${params.sourceId} disappeared after update`);
  const events = await findProvenanceEventsForSource(client, params.sourceId);
  const event = events.at(-1);
  if (!event) throw new Error(`transitionProvenanceState: genesis/transition event missing for ${params.sourceId}`);
  return { source: updated, event, extraResults: results.slice(2) };
}

export type ProvenanceMetadataUpdate = Partial<{
  canonicalUrl: string | null;
  externalIdentifier: string | null;
  title: string | null;
  author: string | null;
  publisher: string | null;
  publicationDate: string | null;
  retrievedAt: string | null;
  contentHash: string | null;
  verificationMethod: string | null;
  verificationNotes: string | null;
}>;

const METADATA_COLUMN_BY_KEY: Record<keyof ProvenanceMetadataUpdate, string> = {
  canonicalUrl: "canonical_url",
  externalIdentifier: "external_identifier",
  title: "title",
  author: "author",
  publisher: "publisher",
  publicationDate: "publication_date",
  retrievedAt: "retrieved_at",
  contentHash: "content_hash",
  verificationMethod: "verification_method",
  verificationNotes: "verification_notes",
};

/**
 * Updates non-state metadata fields (a corrected title, added verification
 * notes, and so on) without touching provenance_state and without recording
 * a provenance_events row — Phase E1's history requirement is specifically
 * about state *transitions* (section 3), not general field edits. Use
 * transitionProvenanceState for anything that changes provenance_state.
 */
export async function updateProvenanceSourceMetadata(client: Client, sourceId: string, update: ProvenanceMetadataUpdate): Promise<ProvenanceSource> {
  const keys = Object.keys(update) as (keyof ProvenanceMetadataUpdate)[];
  if (keys.length === 0) {
    const existing = await findProvenanceSourceById(client, sourceId);
    if (!existing) throw new Error(`updateProvenanceSourceMetadata: no provenance_sources row ${sourceId}`);
    return existing;
  }
  const assignments = keys.map((key) => `${METADATA_COLUMN_BY_KEY[key]} = ?`).join(", ");
  const args = keys.map((key) => update[key] ?? null);
  await client.execute({
    sql: `UPDATE provenance_sources SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [...args, sourceId],
  });
  const updated = await findProvenanceSourceById(client, sourceId);
  if (!updated) throw new Error(`updateProvenanceSourceMetadata: row ${sourceId} disappeared after update`);
  return updated;
}

/** Every source currently in a given state — e.g. all VERIFIED_SOURCE rows. */
export async function findProvenanceSourcesByState(client: Client, state: ProvenanceState, limit = 100): Promise<ProvenanceSource[]> {
  const result = await client.execute({
    sql: `SELECT ${SOURCE_COLUMNS} FROM provenance_sources WHERE provenance_state = ? ORDER BY updated_at DESC LIMIT ?`,
    args: [state, limit],
  });
  return (result.rows as unknown as RawProvenanceSourceRow[]).map(toProvenanceSource);
}
