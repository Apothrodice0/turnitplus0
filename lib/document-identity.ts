import { createHash, randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { canonicalizeText } from "./canonical-text";

/**
 * Phase A: document identity capability. Computes and stores who submitted
 * a document (if known) and its two hashes. This module is deliberately
 * inert with respect to the rest of the product — nothing here changes a
 * similarity score, an AI score, or report output. See db/schema.ts's
 * document_identities table for the storage shape and rationale.
 */

export type DocumentIdentityRow = {
  id: string;
  accountId: string | null;
  title: string | null;
  author: string | null;
  rawSha256: string;
  canonicalSha256: string;
  createdAt: string;
};

type RawDocumentIdentityRow = {
  id: string;
  account_id: string | null;
  title: string | null;
  author: string | null;
  raw_sha256: string;
  canonical_sha256: string;
  created_at: string;
};

function toDocumentIdentityRow(row: RawDocumentIdentityRow): DocumentIdentityRow {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    author: row.author,
    rawSha256: row.raw_sha256,
    canonicalSha256: row.canonical_sha256,
    createdAt: row.created_at,
  };
}

/** Hash of the exact, unmodified submitted text. Independent of, and not a replacement for, lib/ingest.ts's documents.provenance_sha256. */
export function rawSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash of the canonicalized text (see lib/canonical-text.ts) — stable across harmless formatting differences, distinct from rawSha256. */
export function canonicalSha256(text: string): string {
  return createHash("sha256").update(canonicalizeText(text), "utf8").digest("hex");
}

export type CreateDocumentIdentityParams = {
  /** null for anonymous submissions — never omit, so callers make the anonymous case explicit. */
  accountId: string | null;
  /** null when no real title is available. Never invent one (e.g. from a filename) at the call site if the product hasn't captured one. */
  title: string | null;
  /** null until a real author input exists in the product. Never populate with a placeholder. */
  author: string | null;
  /** The exact text as submitted/extracted, before any normalization. */
  rawText: string;
};

/**
 * Inserts one document identity row and returns its id + both hashes. Always
 * inserts — this function does not deduplicate against prior rows (the same
 * document may legitimately recur across or within accounts; see the
 * same-account/other-account queries below for reading that back).
 */
export async function createDocumentIdentity(
  client: Client,
  params: CreateDocumentIdentityParams,
): Promise<{ id: string; rawSha256: string; canonicalSha256: string }> {
  const id = randomUUID();
  const raw = rawSha256(params.rawText);
  const canonical = canonicalSha256(params.rawText);
  await client.execute({
    sql: `INSERT INTO document_identities (id, account_id, title, author, raw_sha256, canonical_sha256, created_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [id, params.accountId, params.title, params.author, raw, canonical],
  });
  return { id, rawSha256: raw, canonicalSha256: canonical };
}

/** Every document identity row with this exact raw hash, across all accounts. */
export async function findDocumentIdentitiesByRawHash(client: Client, rawHash: string, limit = 50): Promise<DocumentIdentityRow[]> {
  const result = await client.execute({
    sql: `SELECT id, account_id, title, author, raw_sha256, canonical_sha256, created_at
          FROM document_identities WHERE raw_sha256 = ? ORDER BY created_at ASC LIMIT ?`,
    args: [rawHash, limit],
  });
  return (result.rows as unknown as RawDocumentIdentityRow[]).map(toDocumentIdentityRow);
}

/** Every document identity row with this exact canonical hash, across all accounts. */
export async function findDocumentIdentitiesByCanonicalHash(client: Client, canonicalHash: string, limit = 50): Promise<DocumentIdentityRow[]> {
  const result = await client.execute({
    sql: `SELECT id, account_id, title, author, raw_sha256, canonical_sha256, created_at
          FROM document_identities WHERE canonical_sha256 = ? ORDER BY created_at ASC LIMIT ?`,
    args: [canonicalHash, limit],
  });
  return (result.rows as unknown as RawDocumentIdentityRow[]).map(toDocumentIdentityRow);
}

/** Every document identity row belonging to one account, most recent first. */
export async function findDocumentIdentitiesByAccount(client: Client, accountId: string, limit = 50): Promise<DocumentIdentityRow[]> {
  const result = await client.execute({
    sql: `SELECT id, account_id, title, author, raw_sha256, canonical_sha256, created_at
          FROM document_identities WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`,
    args: [accountId, limit],
  });
  return (result.rows as unknown as RawDocumentIdentityRow[]).map(toDocumentIdentityRow);
}

/**
 * Same-account check (Phase A, Hard Rule #1 groundwork): "has this account
 * submitted this same document before?", answered by canonical-hash equality
 * within one account. INERT — nothing calls this from the live analysis or
 * report path yet; it exists so the capability can be exercised and tested
 * ahead of being wired into SELF exclusion in a later phase.
 */
export async function findPriorSubmissionsForAccount(
  client: Client,
  accountId: string,
  canonicalHash: string,
): Promise<DocumentIdentityRow[]> {
  const result = await client.execute({
    sql: `SELECT id, account_id, title, author, raw_sha256, canonical_sha256, created_at
          FROM document_identities WHERE account_id = ? AND canonical_sha256 = ? ORDER BY created_at ASC`,
    args: [accountId, canonicalHash],
  });
  return (result.rows as unknown as RawDocumentIdentityRow[]).map(toDocumentIdentityRow);
}
