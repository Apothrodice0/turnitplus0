import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { tokens, grams, gramHash, informativeGram, containment } from "./similarity-core";
import { canonicalizeText } from "./canonical-text";
import { canonicalSha256, findDocumentIdentitiesByRawHash, findPriorSubmissionsForAccount } from "./document-identity";

/**
 * Phase E8A: the user submission history corpus — storage/indexing only.
 * Not wired into live scoring, matching, or POST /api/reports (this phase's
 * own task description, sections 15/24 — see that route for where a future
 * phase would call indexDocumentSubmissionIntoCorpus, and why it does not
 * yet). document_identities (Phase A) already records one row per
 * submission event with both hashes; this module adds the layer that was
 * always missing — the deduplicated, reusable canonical text itself, plus a
 * versioned shingle index over it — because hashes alone cannot support a
 * future passage-level comparison (this phase's own task description,
 * section 3).
 *
 * Three tables (db/schema.ts has the full column-level rationale):
 *   corpus_document_representations — one row per distinct canonical_sha256
 *   corpus_submission_references    — one row per indexed submission event,
 *                                      linking document_identities -> a
 *                                      representation, never duplicating
 *                                      account_id
 *   corpus_document_shingles        — one row per informative shingle of a
 *                                      representation's own canonical_text,
 *                                      tagged with fingerprint_version
 *
 * Account isolation is structural, not a convention to remember: every
 * function that returns representation-level data for candidate matching
 * (findCandidateCorpusRepresentations) never joins to document_identities or
 * users at all, so there is no account_id/email column it could leak even by
 * mistake. Only the explicitly account-scoped functions
 * (findSubmissionReferencesForAccount, findAccountSubmissionForCanonicalHash)
 * join through document_identities.account_id, and only for the account the
 * caller already supplies.
 *
 * This module never imports lib/provenance-verification-workflow.ts and
 * never creates a VERIFIED_SOURCE — see this phase's own task description,
 * section 22. It also never imports lib/report-types.ts, app/similarity-worker.ts,
 * or any scoring-path file — see tests/user-submission-corpus.test.mjs's
 * structural checks, matching every prior phase's own convention.
 */

export const CANONICALIZATION_VERSION = "canonical-text-v1";
export const CORPUS_FINGERPRINT_VERSION = "corpus-shingle-v1";
const DEFAULT_SHINGLE_SIZE = 5;

export type LinkType = "EXACT_CANONICAL_DUPLICATE" | "NEW_CONTENT_REPRESENTATION";

export type CorpusDocumentRepresentation = {
  id: string;
  canonicalSha256: string;
  canonicalText: string;
  wordCount: number;
  language: string | null;
  canonicalizationVersion: string;
  extractorVersion: string | null;
  firstSeenAt: string;
  createdAt: string;
};

type RawRepresentationRow = {
  id: string;
  canonical_sha256: string;
  canonical_text: string;
  word_count: number;
  language: string | null;
  canonicalization_version: string;
  extractor_version: string | null;
  first_seen_at: string;
  created_at: string;
};

function toRepresentation(row: RawRepresentationRow): CorpusDocumentRepresentation {
  return {
    id: row.id,
    canonicalSha256: row.canonical_sha256,
    canonicalText: row.canonical_text,
    wordCount: Number(row.word_count),
    language: row.language,
    canonicalizationVersion: row.canonicalization_version,
    extractorVersion: row.extractor_version,
    firstSeenAt: row.first_seen_at,
    createdAt: row.created_at,
  };
}

/** The same shingling primitives lib/document-family.ts's documentShingleHashes already uses (lib/similarity-core.ts) — no second shingling algorithm. Applied here to a representation's own canonical_text, not raw submitted text. */
export function corpusShingleHashes(canonicalText: string, shingleSize: number = DEFAULT_SHINGLE_SIZE): Set<string> {
  const words = tokens(canonicalText);
  const hashes = new Set<string>();
  for (const gram of grams(words, shingleSize)) {
    if (!informativeGram(gram)) continue;
    hashes.add(gramHash(gram));
  }
  return hashes;
}

export type CreateReusableDocumentRepresentationParams = {
  canonicalText: string;
  language?: string | null;
  canonicalizationVersion?: string;
  extractorVersion?: string | null;
};

/** Inserts one representation row. Does not deduplicate itself — callers check findReusableRepresentationByCanonicalHash first (see indexDocumentSubmissionIntoCorpus, the orchestrator that does this correctly). */
export async function createReusableDocumentRepresentation(
  client: Client,
  params: CreateReusableDocumentRepresentationParams,
): Promise<CorpusDocumentRepresentation> {
  const id = randomUUID();
  const canonicalHash = canonicalSha256(params.canonicalText);
  const wordCount = tokens(params.canonicalText).length;
  await client.execute({
    sql: `INSERT INTO corpus_document_representations
          (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at)
          VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [
      id,
      canonicalHash,
      params.canonicalText,
      wordCount,
      params.language ?? null,
      params.canonicalizationVersion ?? CANONICALIZATION_VERSION,
      params.extractorVersion ?? null,
    ],
  });
  const result = await client.execute({
    sql: `SELECT id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at
          FROM corpus_document_representations WHERE id = ?`,
    args: [id],
  });
  return toRepresentation(result.rows[0] as unknown as RawRepresentationRow);
}

export async function findReusableRepresentationByCanonicalHash(client: Client, canonicalHash: string): Promise<CorpusDocumentRepresentation | null> {
  const result = await client.execute({
    sql: `SELECT id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at
          FROM corpus_document_representations WHERE canonical_sha256 = ?`,
    args: [canonicalHash],
  });
  const row = result.rows[0] as unknown as RawRepresentationRow | undefined;
  return row ? toRepresentation(row) : null;
}

/**
 * Resolves by exact raw (byte-for-byte) hash — a stricter, different lookup
 * than the canonical one above: it answers "has this exact submitted text,
 * with no formatting tolerance at all, already been indexed," by going
 * through document_identities (which is what actually records raw_sha256)
 * and following any submission reference already recorded for it. Returns
 * every distinct representation reached this way (ordinarily one, since a
 * single raw hash canonicalizes to a single canonical hash).
 */
export async function findReusableRepresentationByRawHash(client: Client, rawHash: string): Promise<CorpusDocumentRepresentation[]> {
  const identities = await findDocumentIdentitiesByRawHash(client, rawHash);
  if (identities.length === 0) return [];
  const placeholders = identities.map(() => "?").join(",");
  const result = await client.execute({
    sql: `SELECT DISTINCT r.id, r.canonical_sha256, r.canonical_text, r.word_count, r.language, r.canonicalization_version, r.extractor_version, r.first_seen_at, r.created_at
          FROM corpus_document_representations r
          JOIN corpus_submission_references sr ON sr.representation_id = r.id
          WHERE sr.document_identity_id IN (${placeholders})`,
    args: identities.map((i) => i.id),
  });
  return (result.rows as unknown as RawRepresentationRow[]).map(toRepresentation);
}

/**
 * Phase E8B addition (additive read-only query, no schema change — see
 * lib/user-submission-matching.ts's own header comment): fetches one
 * representation's full row, including canonical_text, by its own id. E8A
 * never needed this (its own callers always already had a canonical hash to
 * look up by); the matcher needs it to load a shingle-search candidate's
 * actual text for local passage comparison.
 */
export async function findRepresentationById(client: Client, representationId: string): Promise<CorpusDocumentRepresentation | null> {
  const result = await client.execute({
    sql: `SELECT id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at
          FROM corpus_document_representations WHERE id = ?`,
    args: [representationId],
  });
  const row = result.rows[0] as unknown as RawRepresentationRow | undefined;
  return row ? toRepresentation(row) : null;
}

export type CorpusSubmissionReference = {
  id: number;
  representationId: string;
  documentIdentityId: string;
  linkType: LinkType;
  createdAt: string;
};

type RawSubmissionReferenceRow = {
  id: number;
  representation_id: string;
  document_identity_id: string;
  link_type: string;
  created_at: string;
};

function toSubmissionReference(row: RawSubmissionReferenceRow): CorpusSubmissionReference {
  return {
    id: Number(row.id),
    representationId: row.representation_id,
    documentIdentityId: row.document_identity_id,
    linkType: row.link_type as LinkType,
    createdAt: row.created_at,
  };
}

/** Idempotent (INSERT OR IGNORE on the document_identity_id unique index) — safe to call more than once for the same submission, matching lib/document-family.ts's recordDocumentIdentityShingles convention. */
export async function recordSubmissionReference(
  client: Client,
  params: { representationId: string; documentIdentityId: string; linkType: LinkType },
): Promise<CorpusSubmissionReference> {
  await client.execute({
    sql: `INSERT OR IGNORE INTO corpus_submission_references (representation_id, document_identity_id, link_type, created_at)
          VALUES (?,?,?,CURRENT_TIMESTAMP)`,
    args: [params.representationId, params.documentIdentityId, params.linkType],
  });
  const result = await client.execute({
    sql: `SELECT id, representation_id, document_identity_id, link_type, created_at
          FROM corpus_submission_references WHERE document_identity_id = ?`,
    args: [params.documentIdentityId],
  });
  return toSubmissionReference(result.rows[0] as unknown as RawSubmissionReferenceRow);
}

export type SubmissionReferenceForAccount = CorpusSubmissionReference & {
  title: string | null;
  canonicalSha256: string;
};

/**
 * Account-scoped by construction: the caller supplies accountId, and the
 * query only ever returns that account's own submission references. This is
 * the storage-layer answer to "which of my own submissions are already in
 * the corpus" (this phase's own task description, section 10) — no live
 * SELF-exclusion decision is made here, only the lookup capability.
 */
export async function findSubmissionReferencesForAccount(client: Client, accountId: string, limit = 100): Promise<SubmissionReferenceForAccount[]> {
  const result = await client.execute({
    sql: `SELECT sr.id, sr.representation_id, sr.document_identity_id, sr.link_type, sr.created_at, di.title, di.canonical_sha256
          FROM corpus_submission_references sr
          JOIN document_identities di ON di.id = sr.document_identity_id
          WHERE di.account_id = ?
          ORDER BY sr.created_at DESC
          LIMIT ?`,
    args: [accountId, limit],
  });
  type RawRow = RawSubmissionReferenceRow & { title: string | null; canonical_sha256: string };
  return (result.rows as unknown as RawRow[]).map((row) => ({
    ...toSubmissionReference(row),
    title: row.title,
    canonicalSha256: row.canonical_sha256,
  }));
}

/**
 * "Has this account already submitted this exact document/version?" (this
 * phase's own task description, section 10), resolved at the representation
 * level (not just document_identities' own findPriorSubmissionsForAccount,
 * which only proves the hash recurred — this also returns the reusable
 * representation a future E8B SELF-exclusion decision would need). Reuses
 * findPriorSubmissionsForAccount (Phase A) rather than re-querying
 * document_identities directly.
 */
export async function findAccountSubmissionForCanonicalHash(
  client: Client,
  accountId: string,
  canonicalHash: string,
): Promise<{ representation: CorpusDocumentRepresentation; submissionReferences: CorpusSubmissionReference[] } | null> {
  const priorIdentities = await findPriorSubmissionsForAccount(client, accountId, canonicalHash);
  if (priorIdentities.length === 0) return null;
  const representation = await findReusableRepresentationByCanonicalHash(client, canonicalHash);
  if (!representation) return null;

  const placeholders = priorIdentities.map(() => "?").join(",");
  const result = await client.execute({
    sql: `SELECT id, representation_id, document_identity_id, link_type, created_at
          FROM corpus_submission_references WHERE document_identity_id IN (${placeholders})`,
    args: priorIdentities.map((i) => i.id),
  });
  const submissionReferences = (result.rows as unknown as RawSubmissionReferenceRow[]).map(toSubmissionReference);
  return { representation, submissionReferences };
}

export type SubmissionOwnershipSummary = {
  hasSameAccountSubmission: boolean;
  /** A bounded count only — never which accounts. See lib/user-submission-matching.ts's own account-safety comment for why this function exists and how its result is used. */
  otherAccountSubmissionCount: number;
};

/**
 * Phase E8B addition (additive read-only query, no schema change): the one
 * function allowed to look at which accounts submitted a representation —
 * and it never returns an account id, only a same-account boolean and an
 * other-accounts count. excludeDocumentIdentityId lets a caller exclude the
 * current submission's own just-recorded reference (if any) from both the
 * same-account check and the count, so a document does not appear to be its
 * own historical match.
 */
export async function summarizeSubmissionOwnership(
  client: Client,
  representationId: string,
  options: { accountId: string | null; excludeDocumentIdentityId?: string | null },
): Promise<SubmissionOwnershipSummary> {
  const result = await client.execute({
    sql: `SELECT di.account_id AS account_id
          FROM corpus_submission_references sr
          JOIN document_identities di ON di.id = sr.document_identity_id
          WHERE sr.representation_id = ?
            AND (? IS NULL OR sr.document_identity_id != ?)`,
    args: [representationId, options.excludeDocumentIdentityId ?? null, options.excludeDocumentIdentityId ?? null],
  });
  const accountIds = (result.rows as unknown as { account_id: string | null }[]).map((row) => row.account_id);
  const distinctOtherAccounts = new Set(
    accountIds.filter((id): id is string => id !== null && id !== options.accountId),
  );
  const hasSameAccountSubmission = options.accountId !== null && accountIds.includes(options.accountId);
  return { hasSameAccountSubmission, otherAccountSubmissionCount: distinctOtherAccounts.size };
}

export type CandidateCorpusRepresentation = {
  representationId: string;
  canonicalSha256: string;
  wordCount: number;
  sharedShingleCount: number;
  containment: number;
};

/**
 * "Which historical reusable document representations have matching
 * passages with this submission?" (this phase's own task description,
 * section 11) — representation-level only. This query never joins to
 * document_identities, corpus_submission_references, or users, so it
 * structurally cannot return an account id or email; a future E8B
 * relationship classifier (SELF / PRIOR_SUBMISSION / CROSS_ACCOUNT) would
 * resolve ownership separately, only for representations this function
 * already identified as candidates. No live comparison happens here — this
 * only reads the already-recorded shingle index.
 */
export async function findCandidateCorpusRepresentations(
  client: Client,
  shingleHashes: Set<string>,
  options: { fingerprintVersion?: string; minSharedShingles?: number; limit?: number } = {},
): Promise<CandidateCorpusRepresentation[]> {
  const fingerprintVersion = options.fingerprintVersion ?? CORPUS_FINGERPRINT_VERSION;
  const minSharedShingles = options.minSharedShingles ?? 1;
  const limit = options.limit ?? 50;
  if (shingleHashes.size === 0) return [];

  const hashList = [...shingleHashes];
  const placeholders = hashList.map(() => "?").join(",");
  const sharedResult = await client.execute({
    sql: `SELECT s.representation_id AS representation_id, COUNT(*) AS shared, r.canonical_sha256 AS canonical_sha256, r.word_count AS word_count
          FROM corpus_document_shingles s
          JOIN corpus_document_representations r ON r.id = s.representation_id
          WHERE s.fingerprint_version = ? AND s.shingle_hash IN (${placeholders})
          GROUP BY s.representation_id
          HAVING COUNT(*) >= ?
          ORDER BY shared DESC
          LIMIT ?`,
    args: [fingerprintVersion, ...hashList, minSharedShingles, limit],
  });
  type RawSharedRow = { representation_id: string; shared: number | bigint; canonical_sha256: string; word_count: number };
  const sharedRows = sharedResult.rows as unknown as RawSharedRow[];
  if (sharedRows.length === 0) return [];

  // containment() needs each candidate's own total shingle count under this
  // fingerprint_version — a second, bounded query for exactly the candidate
  // ids already found, the same two-step pattern
  // lib/document-family.ts's findCandidateRelatedIdentities already uses.
  const candidateIds = sharedRows.map((row) => row.representation_id);
  const candidatePlaceholders = candidateIds.map(() => "?").join(",");
  const countsResult = await client.execute({
    sql: `SELECT representation_id, COUNT(*) AS total
          FROM corpus_document_shingles
          WHERE fingerprint_version = ? AND representation_id IN (${candidatePlaceholders})
          GROUP BY representation_id`,
    args: [fingerprintVersion, ...candidateIds],
  });
  const totalsById = new Map(
    (countsResult.rows as unknown as { representation_id: string; total: number | bigint }[]).map((row) => [row.representation_id, Number(row.total)]),
  );

  const targetCount = shingleHashes.size;
  return sharedRows.map((row) => {
    const shared = Number(row.shared);
    const candidateTotal = totalsById.get(row.representation_id) ?? 0;
    return {
      representationId: row.representation_id,
      canonicalSha256: row.canonical_sha256,
      wordCount: Number(row.word_count),
      sharedShingleCount: shared,
      containment: containment(shared, targetCount, candidateTotal),
    };
  });
}

/** Idempotent (INSERT OR IGNORE) — safe to call more than once for the same representation/version, matching lib/document-family.ts's recordDocumentIdentityShingles convention. */
export async function recordCorpusShingles(
  client: Client,
  representationId: string,
  canonicalText: string,
  fingerprintVersion: string = CORPUS_FINGERPRINT_VERSION,
  shingleSize: number = DEFAULT_SHINGLE_SIZE,
): Promise<{ shingleCount: number }> {
  const hashes = corpusShingleHashes(canonicalText, shingleSize);
  const statements = [...hashes].map((hash) => ({
    sql: "INSERT OR IGNORE INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
    args: [representationId, hash, fingerprintVersion],
  }));
  if (statements.length > 0) await client.batch(statements, "write");
  return { shingleCount: hashes.size };
}

export type IndexDocumentSubmissionResult =
  | { status: "INDEXED"; linkType: LinkType; representationId: string; submissionReferenceId: number }
  | { status: "SKIPPED_ANONYMOUS"; documentIdentityId: string }
  | { status: "SKIPPED_ALREADY_INDEXED"; documentIdentityId: string; representationId: string };

/**
 * The callable server-side indexing function this phase's own task
 * description (section 15) asks for — NOT called from POST /api/reports.
 * Takes an already-created document_identities row (created today by
 * lib/document-family.ts's captureDocumentIdentityAndFamily, live in the
 * save-report path) plus the same raw text used to create it, and:
 *   1. verifies the supplied text's canonical hash matches the identity's
 *      own stored canonical_sha256 (fails loudly on mismatch rather than
 *      silently indexing the wrong content)
 *   2. reuses an existing representation on an exact canonical match
 *      (EXACT_CANONICAL_DUPLICATE), or creates + shingles a new one
 *      (NEW_CONTENT_REPRESENTATION) — this phase's own task description,
 *      section 6
 *   3. records the submission reference
 *
 * Anonymous submissions (document_identities.account_id is null) are
 * deliberately SKIPPED, not indexed under an invented identity — this
 * phase's own task description, section 12's option B, chosen explicitly:
 * SELF classification fundamentally needs a stable account, and an
 * anonymous submission has none the corpus layer can rely on later. This is
 * a documented, reversible choice, not a silent one — see this file's
 * module-level comment and the E8A report's own "anonymous-user handling"
 * section.
 */
export async function indexDocumentSubmissionIntoCorpus(
  client: Client,
  params: { documentIdentityId: string; rawText: string },
): Promise<IndexDocumentSubmissionResult> {
  const identityResult = await client.execute({
    sql: "SELECT id, account_id, canonical_sha256 FROM document_identities WHERE id = ?",
    args: [params.documentIdentityId],
  });
  const identity = identityResult.rows[0] as unknown as { id: string; account_id: string | null; canonical_sha256: string } | undefined;
  if (!identity) throw new Error(`indexDocumentSubmissionIntoCorpus: no document_identities row for id ${params.documentIdentityId}`);

  if (identity.account_id === null) {
    return { status: "SKIPPED_ANONYMOUS", documentIdentityId: params.documentIdentityId };
  }

  const existingReference = await client.execute({
    sql: "SELECT representation_id FROM corpus_submission_references WHERE document_identity_id = ?",
    args: [params.documentIdentityId],
  });
  const existingRow = existingReference.rows[0] as unknown as { representation_id: string } | undefined;
  if (existingRow) {
    return { status: "SKIPPED_ALREADY_INDEXED", documentIdentityId: params.documentIdentityId, representationId: existingRow.representation_id };
  }

  const canonicalText = canonicalizeText(params.rawText);
  const computedHash = canonicalSha256(params.rawText);
  if (computedHash !== identity.canonical_sha256) {
    throw new Error(
      `indexDocumentSubmissionIntoCorpus: supplied rawText's canonical hash (${computedHash}) does not match document_identities.canonical_sha256 (${identity.canonical_sha256}) for ${params.documentIdentityId} — refusing to index mismatched text.`,
    );
  }

  const existingRepresentation = await findReusableRepresentationByCanonicalHash(client, computedHash);
  let representation: CorpusDocumentRepresentation;
  let linkType: LinkType;
  if (existingRepresentation) {
    representation = existingRepresentation;
    linkType = "EXACT_CANONICAL_DUPLICATE";
  } else {
    representation = await createReusableDocumentRepresentation(client, { canonicalText });
    await recordCorpusShingles(client, representation.id, canonicalText);
    linkType = "NEW_CONTENT_REPRESENTATION";
  }

  const reference = await recordSubmissionReference(client, {
    representationId: representation.id,
    documentIdentityId: params.documentIdentityId,
    linkType,
  });

  return { status: "INDEXED", linkType, representationId: representation.id, submissionReferenceId: reference.id };
}
