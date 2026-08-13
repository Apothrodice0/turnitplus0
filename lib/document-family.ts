import { randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { containment, gramHash, grams, informativeGram, tokens } from "./similarity-core";
import { createDocumentIdentity, findDocumentIdentitiesByCanonicalHash, type CreateDocumentIdentityParams } from "./document-identity";
import { DEFAULT_DOCUMENT_FAMILY_THRESHOLDS, type DocumentFamilyThresholds } from "./document-family-config";

/**
 * Phase B/C: document families/versions. This module answers "do these
 * document identities appear to represent the same underlying document?" —
 * nothing here is a similarity score, an AI score, plagiarism evidence, or a
 * provenance classification (SELF/PRIOR_SUBMISSION is decided in
 * lib/document-relationship.ts, one layer up; VERIFIED_SOURCE does not exist
 * anywhere yet). As of Phase C, captureDocumentIdentityAndFamily() below IS
 * wired into the live save-report path (app/api/reports/route.ts), via
 * lib/run-after-response.ts so it never delays that route's response — see
 * that file and captureDocumentIdentityAndFamily's own comment for how.
 */

export type FamilyMatchType = "SEED" | "EXACT_CANONICAL_MATCH" | "STRONG_TEXT_MATCH";

export type DocumentFamilyRow = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type DocumentFamilyMemberRow = {
  id: number;
  familyId: string;
  documentIdentityId: string;
  matchType: FamilyMatchType;
  matchedAgainstIdentityId: string | null;
  evidenceScore: number | null;
  createdAt: string;
};

export type FamilyForIdentity = {
  family: DocumentFamilyRow;
  matchType: FamilyMatchType;
  evidenceScore: number | null;
};

export type CandidateRelationship = {
  documentIdentityId: string;
  matchType: "EXACT_CANONICAL_MATCH" | "STRONG_TEXT_MATCH";
  /** 0..1. Always 1 for EXACT_CANONICAL_MATCH; a measured containment for STRONG_TEXT_MATCH. */
  evidenceScore: number;
  /** The family this candidate already belongs to, if any — null means no family exists for it yet. */
  existingFamilyId: string | null;
};

type RawFamilyRow = { id: string; created_at: string; updated_at: string };
type RawMemberRow = {
  id: number;
  family_id: string;
  document_identity_id: string;
  match_type: string;
  matched_against_identity_id: string | null;
  evidence_score: number | null;
  created_at: string;
};

function toFamilyRow(row: RawFamilyRow): DocumentFamilyRow {
  return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toMemberRow(row: RawMemberRow): DocumentFamilyMemberRow {
  return {
    id: Number(row.id),
    familyId: row.family_id,
    documentIdentityId: row.document_identity_id,
    matchType: row.match_type as FamilyMatchType,
    matchedAgainstIdentityId: row.matched_against_identity_id,
    evidenceScore: row.evidence_score,
    createdAt: row.created_at,
  };
}

// --- Fingerprinting (Required Behavior #2) ---------------------------------

/**
 * The set of distinct *informative* shingle hashes for a document's text.
 * Reuses the exact tokenization/shingling/hashing primitives the corpus
 * builder and the live similarity worker already use (lib/similarity-core.ts)
 * — this module does not invent a second shingling scheme. informativeGram()
 * filtering means generic/common phrasing never contributes a shingle, which
 * is most of why short common text and moderately-similar-but-unrelated
 * documents don't manufacture false family relationships (see
 * tests/document-family.test.mjs).
 */
export function documentShingleHashes(text: string, shingleSize: number): Set<string> {
  const words = tokens(text);
  const hashes = new Set<string>();
  for (const gram of grams(words, shingleSize)) {
    if (!informativeGram(gram)) continue;
    hashes.add(gramHash(gram));
  }
  return hashes;
}

/**
 * Computes and stores the shingle fingerprint for one document identity, and
 * updates its unique_shingle_count. Idempotent (INSERT OR IGNORE on the
 * (document_identity_id, shingle_hash) unique index) — safe to call more
 * than once for the same identity. NOT called automatically by
 * createDocumentIdentity(); callers (tests, or a future wiring decision)
 * invoke this explicitly with the same raw text that was used to compute
 * that identity's hashes.
 */
export async function recordDocumentIdentityShingles(
  client: Client,
  documentIdentityId: string,
  rawText: string,
  thresholds: DocumentFamilyThresholds = DEFAULT_DOCUMENT_FAMILY_THRESHOLDS,
): Promise<{ uniqueShingleCount: number }> {
  const hashes = documentShingleHashes(rawText, thresholds.shingleSize);
  const statements: InStatement[] = [...hashes].map((hash) => ({
    sql: "INSERT OR IGNORE INTO document_identity_shingles (document_identity_id, shingle_hash, created_at) VALUES (?,?,CURRENT_TIMESTAMP)",
    args: [documentIdentityId, hash],
  }));
  statements.push({
    sql: "UPDATE document_identities SET unique_shingle_count = ? WHERE id = ?",
    args: [hashes.size, documentIdentityId],
  });
  await client.batch(statements, "write");
  return { uniqueShingleCount: hashes.size };
}

// --- Family CRUD (Required Behavior #6/#7) ----------------------------------

export async function createFamily(client: Client): Promise<DocumentFamilyRow> {
  const id = randomUUID();
  await client.execute({
    sql: "INSERT INTO document_families (id, created_at, updated_at) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    args: [id],
  });
  const result = await client.execute({ sql: "SELECT id, created_at, updated_at FROM document_families WHERE id = ?", args: [id] });
  return toFamilyRow(result.rows[0] as unknown as RawFamilyRow);
}

export async function findFamilyForIdentity(client: Client, documentIdentityId: string): Promise<FamilyForIdentity | null> {
  const result = await client.execute({
    sql: `SELECT dfm.match_type, dfm.evidence_score, df.id AS family_id, df.created_at AS family_created_at, df.updated_at AS family_updated_at
          FROM document_family_members dfm
          JOIN document_families df ON df.id = dfm.family_id
          WHERE dfm.document_identity_id = ?`,
    args: [documentIdentityId],
  });
  const row = result.rows[0] as unknown as
    | { match_type: string; evidence_score: number | null; family_id: string; family_created_at: string; family_updated_at: string }
    | undefined;
  if (!row) return null;
  return {
    family: { id: row.family_id, createdAt: row.family_created_at, updatedAt: row.family_updated_at },
    matchType: row.match_type as FamilyMatchType,
    evidenceScore: row.evidence_score,
  };
}

export type AttachIdentityToFamilyParams = {
  familyId: string;
  documentIdentityId: string;
  matchType: FamilyMatchType;
  matchedAgainstIdentityId: string | null;
  evidenceScore: number | null;
};

/** An identity belongs to at most one family — the unique index on document_identity_id rejects a second attach attempt for an already-assigned identity. */
export async function attachIdentityToFamily(client: Client, params: AttachIdentityToFamilyParams): Promise<DocumentFamilyMemberRow> {
  await client.execute({
    sql: `INSERT INTO document_family_members (family_id, document_identity_id, match_type, matched_against_identity_id, evidence_score, created_at)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [params.familyId, params.documentIdentityId, params.matchType, params.matchedAgainstIdentityId, params.evidenceScore],
  });
  await client.execute({
    sql: "UPDATE document_families SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    args: [params.familyId],
  });
  const result = await client.execute({
    sql: `SELECT id, family_id, document_identity_id, match_type, matched_against_identity_id, evidence_score, created_at
          FROM document_family_members WHERE family_id = ? AND document_identity_id = ?`,
    args: [params.familyId, params.documentIdentityId],
  });
  return toMemberRow(result.rows[0] as unknown as RawMemberRow);
}

export type FamilyMember = DocumentFamilyMemberRow & {
  accountId: string | null;
  title: string | null;
  canonicalSha256: string;
};

export async function findFamilyMembers(client: Client, familyId: string): Promise<FamilyMember[]> {
  const result = await client.execute({
    sql: `SELECT dfm.id, dfm.family_id, dfm.document_identity_id, dfm.match_type, dfm.matched_against_identity_id, dfm.evidence_score, dfm.created_at,
                 di.account_id, di.title, di.canonical_sha256
          FROM document_family_members dfm
          JOIN document_identities di ON di.id = dfm.document_identity_id
          WHERE dfm.family_id = ?
          ORDER BY dfm.created_at ASC`,
    args: [familyId],
  });
  type RawRow = RawMemberRow & { account_id: string | null; title: string | null; canonical_sha256: string };
  return (result.rows as unknown as RawRow[]).map((row) => ({
    ...toMemberRow(row),
    accountId: row.account_id,
    title: row.title,
    canonicalSha256: row.canonical_sha256,
  }));
}

// --- Candidate detection (Required Behavior #1/#2/#8) -----------------------

/**
 * Finds other document identities that appear to represent the same
 * document as `documentIdentityId`, classified per Required Behavior #8:
 *  - EXACT_CANONICAL_MATCH: identical canonical_sha256 (Required Behavior #1)
 *    — the strongest possible relationship, always evidenceScore 1.
 *  - STRONG_TEXT_MATCH: canonical hashes differ, but shingle-set containment
 *    against the fingerprint recorded by recordDocumentIdentityShingles
 *    meets thresholds.strongTextMatchContainment (Required Behavior #2).
 * Account identity is never consulted (Required Behavior #4): two identities
 * from different accounts with the same or strongly related text are
 * candidates just like two from the same account. Title/author are never
 * consulted either (Required Behavior #3/#10): this function only compares
 * hashes and shingle sets.
 * A candidate with no shingle fingerprint recorded (unique_shingle_count is
 * NULL/0, e.g. it was created via the live save path where fingerprinting
 * isn't wired in) can still be found via EXACT_CANONICAL_MATCH, but can never
 * surface as a STRONG_TEXT_MATCH source or target.
 */
export async function findCandidateRelatedIdentities(
  client: Client,
  documentIdentityId: string,
  thresholds: DocumentFamilyThresholds = DEFAULT_DOCUMENT_FAMILY_THRESHOLDS,
): Promise<CandidateRelationship[]> {
  const targetResult = await client.execute({
    sql: "SELECT canonical_sha256, unique_shingle_count FROM document_identities WHERE id = ?",
    args: [documentIdentityId],
  });
  const target = targetResult.rows[0] as unknown as { canonical_sha256: string; unique_shingle_count: number | null } | undefined;
  if (!target) return [];

  const exactMatches = await findDocumentIdentitiesByCanonicalHash(client, target.canonical_sha256, 200);
  const exactIds = new Set<string>();
  const candidates: CandidateRelationship[] = [];
  for (const row of exactMatches) {
    if (row.id === documentIdentityId) continue;
    exactIds.add(row.id);
    candidates.push({ documentIdentityId: row.id, matchType: "EXACT_CANONICAL_MATCH", evidenceScore: 1, existingFamilyId: null });
  }

  const targetShingleCount = target.unique_shingle_count ?? 0;
  if (targetShingleCount > 0) {
    const sharedResult = await client.execute({
      sql: `SELECT s2.document_identity_id AS candidate_id, COUNT(*) AS shared
            FROM document_identity_shingles s1
            JOIN document_identity_shingles s2
              ON s1.shingle_hash = s2.shingle_hash AND s2.document_identity_id != s1.document_identity_id
            WHERE s1.document_identity_id = ?
            GROUP BY s2.document_identity_id`,
      args: [documentIdentityId],
    });
    const sharedRows = sharedResult.rows as unknown as { candidate_id: string; shared: number | bigint }[];
    const candidateIds = sharedRows.map((row) => row.candidate_id).filter((id) => !exactIds.has(id));

    if (candidateIds.length > 0) {
      const placeholders = candidateIds.map(() => "?").join(",");
      const countsResult = await client.execute({
        sql: `SELECT id, unique_shingle_count FROM document_identities WHERE id IN (${placeholders})`,
        args: candidateIds,
      });
      const countsById = new Map(
        (countsResult.rows as unknown as { id: string; unique_shingle_count: number | null }[])
          .map((row) => [row.id, row.unique_shingle_count ?? 0]),
      );
      for (const row of sharedRows) {
        if (exactIds.has(row.candidate_id)) continue;
        const candidateCount = countsById.get(row.candidate_id) ?? 0;
        const score = containment(Number(row.shared), targetShingleCount, candidateCount);
        if (score >= thresholds.strongTextMatchContainment) {
          candidates.push({ documentIdentityId: row.candidate_id, matchType: "STRONG_TEXT_MATCH", evidenceScore: score, existingFamilyId: null });
        }
      }
    }
  }

  for (const candidate of candidates) {
    const existing = await findFamilyForIdentity(client, candidate.documentIdentityId);
    candidate.existingFamilyId = existing?.family.id ?? null;
  }

  candidates.sort((left, right) => {
    if (left.matchType !== right.matchType) return left.matchType === "EXACT_CANONICAL_MATCH" ? -1 : 1;
    const leftHasFamily = left.existingFamilyId ? 1 : 0;
    const rightHasFamily = right.existingFamilyId ? 1 : 0;
    if (leftHasFamily !== rightHasFamily) return rightHasFamily - leftHasFamily;
    return right.evidenceScore - left.evidenceScore;
  });
  return candidates;
}

// --- Orchestration -----------------------------------------------------------

export type ResolveFamilyResult = {
  familyId: string | null;
  matchType: FamilyMatchType | null;
  candidates: CandidateRelationship[];
};

/**
 * Idempotent: if `documentIdentityId` already belongs to a family, returns it
 * without any writes. Otherwise finds candidates and either joins the best
 * candidate's existing family, or creates a new family seeded with the best
 * candidate and this identity. Returns familyId=null/matchType=null
 * (NO_MATCH, Required Behavior #8's third category) when no candidate meets
 * either threshold — no family is created in that case.
 */
export async function resolveFamilyForIdentity(
  client: Client,
  documentIdentityId: string,
  thresholds: DocumentFamilyThresholds = DEFAULT_DOCUMENT_FAMILY_THRESHOLDS,
): Promise<ResolveFamilyResult> {
  const existing = await findFamilyForIdentity(client, documentIdentityId);
  if (existing) {
    return { familyId: existing.family.id, matchType: existing.matchType, candidates: [] };
  }

  const candidates = await findCandidateRelatedIdentities(client, documentIdentityId, thresholds);
  if (candidates.length === 0) {
    return { familyId: null, matchType: null, candidates };
  }

  const best = candidates[0];

  if (best.existingFamilyId) {
    await attachIdentityToFamily(client, {
      familyId: best.existingFamilyId,
      documentIdentityId,
      matchType: best.matchType,
      matchedAgainstIdentityId: best.documentIdentityId,
      evidenceScore: best.evidenceScore,
    });
    return { familyId: best.existingFamilyId, matchType: best.matchType, candidates };
  }

  const family = await createFamily(client);
  await attachIdentityToFamily(client, {
    familyId: family.id,
    documentIdentityId: best.documentIdentityId,
    matchType: "SEED",
    matchedAgainstIdentityId: null,
    evidenceScore: null,
  });
  await attachIdentityToFamily(client, {
    familyId: family.id,
    documentIdentityId,
    matchType: best.matchType,
    matchedAgainstIdentityId: best.documentIdentityId,
    evidenceScore: best.evidenceScore,
  });
  return { familyId: family.id, matchType: best.matchType, candidates };
}

export type CaptureResult = {
  documentIdentityId: string;
  familyId: string | null;
  matchType: FamilyMatchType | null;
};

/**
 * Phase C: the full activation pipeline — create the identity (Phase A),
 * fingerprint it, and resolve its family (Phase B) — composed into one call.
 * This is what app/api/reports/route.ts now calls (via
 * lib/run-after-response.ts, so it never delays that route's response).
 *
 * Deliberately propagates errors rather than swallowing them: Phase A's
 * createDocumentIdentity() and Phase B's resolveFamilyForIdentity() are both
 * "honest" functions that throw on failure, and this composition keeps that
 * property so the *caller* decides whether a failure is fatal or best-effort
 * — exactly as app/api/reports/route.ts already did for createDocumentIdentity
 * alone in Phase A. Do not add a try/catch here; add it at the call site.
 */
export async function captureDocumentIdentityAndFamily(
  client: Client,
  params: CreateDocumentIdentityParams,
  thresholds: DocumentFamilyThresholds = DEFAULT_DOCUMENT_FAMILY_THRESHOLDS,
): Promise<CaptureResult> {
  const created = await createDocumentIdentity(client, params);
  await recordDocumentIdentityShingles(client, created.id, params.rawText, thresholds);
  const resolved = await resolveFamilyForIdentity(client, created.id, thresholds);
  return { documentIdentityId: created.id, familyId: resolved.familyId, matchType: resolved.matchType };
}
