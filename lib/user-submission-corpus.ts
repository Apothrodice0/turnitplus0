import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { tokens, grams, gramHash, informativeGram, containment } from "./similarity-core";
import { canonicalizeText } from "./canonical-text";
import { canonicalSha256, findDocumentIdentitiesByRawHash, findPriorSubmissionsForAccount } from "./document-identity";
import { buildReportAdmissionAccountPrefix } from "./corpus-admission-source-ref";
import { bumpCorpusMatchGeneration } from "./corpus-match-generation";

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
 * (findCandidateCorpusRepresentations) never SELECTs an account_id/email
 * column, so there is none it could leak even by mistake. Only the explicitly
 * account-scoped functions (findSubmissionReferencesForAccount,
 * findAccountSubmissionForCanonicalHash) join through
 * document_identities.account_id and return it, and only for the account the
 * caller already supplies. admissionEligibilitySql's arm-1 maturity-exemption
 * check (developer_corpus_maturity_exemptions, below) does join
 * document_identities, but only inside a boolean EXISTS — same discipline as
 * isRepresentationActivelyPromoted/isRepresentationEligibleForMatching:
 * never returns the account id itself.
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

/**
 * Phase A — 7-day corpus maturity. Every TurnitPlus corpus backing waits this
 * many full days before it can contribute plagiarism evidence to the
 * production similarity score. Frozen in code, no env var. Folded into
 * lib/report-historical-match.ts's SNAPSHOT_MATCHER_VERSION config digest so a
 * change to this value — or its introduction — invalidates every snapshot
 * computed under the previous activation-less policy, exactly as a thresholds
 * change does.
 *
 * Backing-level maturity T0 (immutable, one per backing):
 *   submission-reference backing -> corpus_submission_references.created_at
 *   admission-promotion backing  -> corpus_admission_decisions.created_at
 *                                    WHERE decisions.id = promotions.decision_id
 *   legacy representation        -> corpus_document_representations.first_seen_at
 * A backing is mature INCLUSIVELY at T0 + CORPUS_ACTIVATION_DELAY_DAYS <= asOf,
 * i.e. T0 <= (asOf - CORPUS_ACTIVATION_DELAY_DAYS) == corpusMaturityCutoff(asOf).
 */
export const CORPUS_ACTIVATION_DELAY_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/**
 * A Date rendered as SQLite's own `CURRENT_TIMESTAMP` text shape
 * ('YYYY-MM-DD HH:MM:SS', UTC, second precision) so it is directly, index-
 * friendly comparable against a `created_at` / `first_seen_at` column with no
 * SQL date function on the column side.
 */
export function sqliteUtcTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * The single maturity cutoff for one matching/snapshot resolution taken `asOf`
 * a logical instant: a backing is mature iff its immutable T0 <= this string.
 * Derived exactly once per resolution and threaded through eligibility, the
 * maturity-crossing snapshot check, and the snapshot currentness decision so
 * no two queries in one resolution can disagree on a boundary.
 */
export function corpusMaturityCutoff(asOf: Date): string {
  return sqliteUtcTimestamp(new Date(asOf.getTime() - CORPUS_ACTIVATION_DELAY_DAYS * MS_PER_DAY));
}

/**
 * Phase A — 7-day corpus maturity. The intent a caller of the shared
 * admission-eligibility predicate is expressing. Three, mutually exclusive:
 *
 *   "MATCHING" — the DEFAULT for every consumer. The representation is being
 *     considered as plagiarism evidence, so the 7-day maturity gate is ALWAYS
 *     enforced. A caller that does not inject an explicit `maturityCutoff`
 *     still gets one (derived from `asOf ?? new Date()` — see
 *     resolveMaturityCutoff); omitting the argument can NOT silently disable
 *     the policy, and any future matching call site is protected by default.
 *
 *   "ADMISSION_DEDUP" — the corpus-admission gate deliberately inspecting
 *     stored representations regardless of age, so it does not re-admit
 *     content already present in the corpus. This is the ONLY sanctioned
 *     maturity bypass for ADMISSION purposes and it never contributes to a
 *     similarity score. Used at exactly one production call site:
 *     lib/corpus-admission-gate.ts's computeEvaluationCore family/redundancy
 *     lookup. Any new use must be an equally deliberate, non-scoring
 *     admission-side decision.
 *
 *   "ARCHIVE" — lib/archive-corpus-matching.ts's matchAgainstArchiveCorpus,
 *     ONLY. A representation is eligible under this mode iff it has a row in
 *     archive_document_representations — no maturity term is ever emitted,
 *     by design: the built-in archive's real-world pre-existence is already
 *     established at seed time (its own corpus_version/build date), and
 *     `first_seen_at` on the underlying corpus_document_representations row
 *     is NOT a reliable proxy for that once a representation is REUSED —
 *     lib/archive-corpus-seed.ts's seedArchiveDocument dedupes by canonical
 *     hash, so a byte-identical representation created moments ago by an
 *     ordinary, unrelated, still-immature user submission would otherwise be
 *     backdating-blind and wait out the same 7 days the archive itself is
 *     exempt from. This mode answers a narrower, different question than
 *     MATCHING ("is this representation part of the built-in archive," not
 *     "has enough time passed") and must never be used for anything that
 *     feeds a similarity score outside the archive's own matching path.
 */
export type CorpusEligibilityMode = "MATCHING" | "ADMISSION_DEDUP" | "ARCHIVE";

/**
 * The ONE place the "matching is safe by default" rule is implemented.
 * MATCHING => always a cutoff string: the caller's injected one (production's
 * single logical clock, or a test's frozen `asOf`), else derived from
 * `asOf ?? new Date()`. ADMISSION_DEDUP / ARCHIVE => null (both are
 * deliberate, narrowly-scoped bypasses — see CorpusEligibilityMode).
 */
export function resolveMaturityCutoff(
  mode: CorpusEligibilityMode,
  opts: { maturityCutoff?: string; asOf?: Date },
): string | null {
  if (mode === "ADMISSION_DEDUP" || mode === "ARCHIVE") return null;
  return opts.maturityCutoff ?? corpusMaturityCutoff(opts.asOf ?? new Date());
}

/**
 * Developer corpus-maturity exemption (drizzle/0047,
 * developer_corpus_maturity_exemptions) — live DB read, always current, no
 * caching. "ADMISSION_DEDUP" and "ARCHIVE" never emit a maturity term at all
 * (see CorpusEligibilityMode), so the exemption list is moot for both —
 * skipped entirely, matching resolveMaturityCutoff's own mode short-circuit
 * (and sparing "ARCHIVE" callers, e.g. every matchAgainstArchiveCorpus call,
 * a wholly unnecessary DB round trip).
 * Returns each exempt account's admission-source_ref prefix via
 * buildReportAdmissionAccountPrefix — the ONE place that format is built —
 * ready to bind as a JSON array for admissionEligibilitySql's arm-2
 * exemption check (json_each(?)).
 */
async function resolveExemptAccountPrefixes(client: Client, mode: CorpusEligibilityMode): Promise<string[]> {
  if (mode === "ADMISSION_DEDUP" || mode === "ARCHIVE") return [];
  const result = await client.execute("SELECT user_id FROM developer_corpus_maturity_exemptions");
  return (result.rows as unknown as { user_id: string }[]).map((row) => buildReportAdmissionAccountPrefix(row.user_id));
}

/**
 * Format-tolerant UTC parse of a stored timestamp. `report_historical_match_
 * snapshots.computed_at` is written as an ISO string ('…T…Z') by
 * getOrComputeHistoricalMatchSnapshot; a `CURRENT_TIMESTAMP` default would be
 * 'YYYY-MM-DD HH:MM:SS' (space, no zone). Both are UTC — normalize the latter
 * so `new Date` does not read it as local time.
 */
export function parseSqliteUtc(value: string): Date {
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(iso);
}

/**
 * Max shingle rows per bulk-INSERT batch() call, for both bulk shingle
 * writers — recordCorpusShingles below and lib/corpus-admission-gate.ts's
 * accepted-shingle write.
 *
 * WHY THIS EXISTS. Each writer hands client.batch()/tx.batch() an ARRAY of
 * single-row statements (`INSERT … VALUES (?,?,?,CURRENT_TIMESTAMP)`, 3 binds
 * each), executed one statement at a time. The SQL variable limit is
 * therefore NOT the constraint — no statement ever binds more than 3
 * variables regardless of document size, and a >32,766-shingle write already
 * runs today (tests/user-submission-matching-maxdf.test.mjs case H). The
 * limit that DOES scale with document size is the batch() payload itself:
 *
 *   - on the libSQL/Turso HTTP path a batch() is ONE Hrana pipeline request,
 *     and both its request body AND its response grow linearly with the
 *     statement count — a max-size document (maxExtractedChars = 2,000,000 →
 *     ~330k informative 5-grams) is otherwise a single multi-megabyte
 *     request whose ~330k-result response exceeds libsql-server's default
 *     10 MiB response ceiling, failing indexing for a large but perfectly
 *     legitimate document;
 *   - on every path it also caps how many statement/result objects the
 *     serverless function holds in memory at once.
 *
 * WHY 8,000. A deliberately conservative round number: at 8,000
 * three-text-column rows a batch() request/response is well under 1 MB, a
 * max-size document is ~42 bounded batches, and the wall-clock cost versus
 * one unbounded batch is negligible (measured: ~28.3 s vs ~28.4 s for 330k
 * rows in one transaction). It also happens to sit a comfortable ~3x under
 * SQLITE_MAX_VARIABLE_NUMBER (32,766) if this is ever rewritten as a
 * multi-row `VALUES (?,?,?),(?,?,?),…` statement — but that is a bonus, not
 * the reason: today's single-row-statement shape can never approach that
 * limit.
 *
 * Chunking never weakens atomicity: a caller that needs the whole shingle
 * set written atomically (lib/corpus-admission-promotion.ts's
 * indexPromotionAtomically) passes an open Transaction as `client`, and
 * Transaction.batch() appends to that one open transaction — N bounded
 * batch() calls commit or roll back exactly as one unbounded call would.
 */
export const CORPUS_SHINGLE_WRITE_BATCH_ROWS = 8_000;

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
  /**
   * Overrides first_seen_at (CURRENT_TIMESTAMP by default) with a caller-
   * supplied SQLite-UTC timestamp — see sqliteUtcTimestamp. The ONLY
   * sanctioned use is seeding a representation whose real-world age predates
   * this row's own creation (e.g. lib/archive-corpus-seed.ts backdating a
   * built-in archive document to its actual corpus-version build date, never
   * to "now" and never to fabricate an age it doesn't have) — this directly
   * feeds admissionEligibilitySql's maturity term (r.first_seen_at <=
   * cutoff), so an honest value here is what lets genuinely pre-existing
   * content skip an unearned 7-day wait, not a way to bypass the gate for
   * new content. undefined (every existing caller) reproduces today's exact
   * CURRENT_TIMESTAMP behavior with a byte-identical SQL statement.
   */
  firstSeenAt?: string;
};

/** Inserts one representation row. Does not deduplicate itself — callers check findReusableRepresentationByCanonicalHash first (see indexDocumentSubmissionIntoCorpus, the orchestrator that does this correctly). */
export async function createReusableDocumentRepresentation(
  client: Client,
  params: CreateReusableDocumentRepresentationParams,
): Promise<CorpusDocumentRepresentation> {
  const id = randomUUID();
  const canonicalHash = canonicalSha256(params.canonicalText);
  const wordCount = tokens(params.canonicalText).length;
  if (params.firstSeenAt === undefined) {
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
  } else {
    await client.execute({
      sql: `INSERT INTO corpus_document_representations
            (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at)
            VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      args: [
        id,
        canonicalHash,
        params.canonicalText,
        wordCount,
        params.language ?? null,
        params.canonicalizationVersion ?? CANONICALIZATION_VERSION,
        params.extractorVersion ?? null,
        params.firstSeenAt,
      ],
    });
  }
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
  /** True iff an 'indexed' corpus_admission_promotions row exists for this representation whose own accepted_representation is not revoked — same EXISTS check this query's own eligibility filter already runs, exposed as a column so lib/user-submission-matching.ts can distinguish this from a real submission reference without a second query. See lib/corpus-admission-promotion.ts's own header comment. */
  isActivelyPromoted: boolean;
};

/**
 * Developer/test-only diagnostics for query-time high-frequency shingle
 * pruning (below). Populated in place when findCandidateCorpusRepresentations
 * is handed a `diagnostics` sink — never part of any return value, never
 * reachable from a similarity report, and carrying no corpus identifiers
 * (only counts and one boolean). See lib/user-submission-matching.ts's own
 * maxCandidateShingleDocumentFrequency comment and
 * tests/user-submission-matching-maxdf.test.mjs.
 */
export type CandidateDiscoveryDiagnostics = {
  /** Informative query shingles supplied (before any pruning). */
  inputShingleCount: number;
  /** Query shingles actually searched on (== input when pruning is disabled, nothing was common enough to drop, or the low-information fallback abandoned pruning). */
  survivingShingleCount: number;
  /** inputShingleCount - survivingShingleCount. Always 0 when fallbackUsed is true (the fallback abandons pruning rather than pruning less). */
  highDfPrunedCount: number;
  /** True when fewer than minDiscriminativeShingles would have survived, so pruning was ABANDONED for this query and the complete original shingle set was searched (see applyHighFrequencyShinglePruning). */
  fallbackUsed: boolean;
  /** The maxDF ceiling actually applied, or null when pruning was disabled (options.maxDocumentFrequency undefined). */
  appliedMaxDocumentFrequency: number | null;
};

/**
 * Query-time high-frequency ("maxDF") shingle pruning for corpus candidate
 * DISCOVERY — the 10k+-representation scale hardening for
 * findCandidateCorpusRepresentations below.
 *
 * PROBLEM (measured): every academic document shares a few hundred
 * common-register / boilerplate informative 5-grams ("participants were
 * randomly assigned to", "the results of this study suggest", …). At a
 * handful of representations these are harmless. At ~8k+ eligible
 * representations they appear in thousands of them each, which means (a) the
 * candidate GROUP BY has to scan and aggregate a posting list per common
 * hash spanning most of the corpus — an 8k-representation corpus already
 * pushes findCandidateCorpusRepresentations past
 * USER_SUBMISSION_MATCH_THRESHOLDS.dbQueryTimeoutMs — and (b) a genuinely
 * copied source (which shares maybe 40 highly distinctive shingles with the
 * query) is out-ranked in `ORDER BY shared DESC LIMIT n` by unrelated
 * documents that merely share more boilerplate, so it never reaches
 * verification at all.
 *
 * FIX: drop, for candidate discovery only, any query shingle carried by
 * more than `maxDocumentFrequency` MATCH-ELIGIBLE representations. A
 * genuinely distinctive copied passage is a contiguous run of low-DF
 * shingles (only the source has that exact phrasing) and is completely
 * unaffected; boilerplate is exactly what gets removed.
 *
 * NOT verification-affecting: lib/user-submission-matching.ts recomputes
 * computeDocumentCorrespondence from full canonical text for every surviving
 * candidate, so passages, matched-word union and the final unified score are
 * byte-identical to an unpruned run for every candidate that survives — and
 * the only representations that fail to survive are ones sharing solely
 * common-register shingles, which computeDocumentCorrespondence's own
 * containment / distinctive-passage / generic-academic-register gates
 * already refuse to accept as a match.
 *
 * WHAT "DF" MEANS HERE — DF(hash, requester) = the number of DISTINCT
 * representations that contain the hash AND are eligible to participate in
 * matching FOR THIS REQUESTER. It is the exact, WHOLE
 * admissionEligibilitySql predicate the candidate query itself applies,
 * including its optional per-account exclusion:
 *   - not raw shingle rows: corpus_document_shingles'
 *     ux_...(representation_id, fingerprint_version, shingle_hash) UNIQUE
 *     index makes at most one row per representation per (version, hash), so
 *     a repeated phrase inside one document can never inflate its DF;
 *   - not a count that includes revoked/deactivated-only representations;
 *   - not a count that includes representations backed ONLY by the
 *     requester's OWN admission promotion(s) — the candidate query excludes
 *     those for this requester (excludeAccountId, via
 *     buildReportAdmissionAccountPrefix), so counting them here would let a
 *     requester's own re-uploads falsely prune a legitimate cross-account
 *     source that shares the same passage. options.excludeAccountId is
 *     threaded in and bound into admissionEligibilitySql identically to
 *     findCandidateCorpusRepresentations — never a second rule.
 *   - null excludeAccountId => plain global eligibility (every existing
 *     non-account-scoped caller is unchanged).
 *
 * DF MEASUREMENT — the part that has to stay cheap:
 *
 *   BOUNDED ELIGIBLE POSTING-LIST PROBE. For each query hash, walk
 *   idx_corpus_document_shingles_hash for that shingle_hash, applying the
 *   eligibility predicate per posting, and stop after `maxDf + 1` ELIGIBLE
 *   representations have been counted (inner `LIMIT ?`). "> maxDf eligible
 *   representations?" is the only question, so `maxDf + 1` is the whole
 *   answer — no wider cap, no rankable DF beyond it.
 *     - a common hash with thousands of representations eligible for this
 *       requester costs ~maxDf eligibility checks and stops — O(maxDf) per
 *       hash, INDEPENDENT of corpus size;
 *     - a rare hash costs one check per representation that has it (<= maxDf);
 *     - the one unbounded case is a hash sitting in thousands of
 *       representations that are ALL ineligible FOR THIS REQUESTER
 *       (revoked-only, or backed only by the requester's own promotions)
 *       and almost no eligible one: the walk cannot reach `maxDf + 1`
 *       eligible and scans that hash's whole posting list. That requires
 *       thousands of documents all sharing one specific informative 5-gram
 *       and all ineligible for the same requester — an operationally
 *       implausible state (the admission gate's per-hash dedup and quality
 *       screening make it hard for one account to promote dozens of
 *       near-identical documents) — and dbQueryTimeoutMs still bounds it
 *       (degrades to a recomputed-later partial, never a false negative).
 *   Measured (work/maxdf, synthetic): probe ~0.11 s global / ~0.61 s
 *   account-aware, two-pass total ~1.1 s, at 11.8M shingle rows / 8k
 *   representations + 2,000 ACTIVE representations from ONE account all
 *   sharing the requester's copied passage (the same-account stress), every
 *   representation eligible via condition 3 (the worst case for the
 *   per-posting check — never short-circuits on the cheap condition-1
 *   submission-reference EXISTS a real corpus hits first). The SAME corpus's
 *   unpruned candidate query is ~5 s (would time out); pruning takes the
 *   whole pass to ~1.1 s even under that stress, ~0.15-0.6 s on a realistic
 *   corpus. A plain `COUNT(*) ... GROUP BY shingle_hash` was measured first
 *   and rejected (touches every posting of every common hash, scaled with
 *   the corpus: ~1.4 s at 2k representations, and over-counts
 *   ineligible representations); an eligibility-JOINED `GROUP BY` was ~9 s
 *   at 8k.
 *
 * The hash list is passed to SQLite as a single json_each(?) bind value, so
 * this pass carries no per-hash SQL-variable cost of its own and cannot
 * approach SQLITE_MAX_VARIABLE_NUMBER regardless of query size. It is still
 * chunked at `chunkSize` (bounded result sets, one json_each array per
 * chunk); each hash lands in exactly one chunk.
 *
 * LOW-INFORMATION FALLBACK — a document written almost entirely in common
 * register can have nearly every shingle prunable. When fewer than
 * `minDiscriminativeShingles` shingles would survive, pruning is ABANDONED
 * for that query: the complete original query shingle set is used, i.e.
 * exactly the search an unpruned run would have run. This can never
 * manufacture a NO_HISTORICAL_MATCH that a full search would not also
 * produce. Diagnostics record fallbackUsed = true and highDfPrunedCount = 0
 * (nothing was pruned).
 */
export async function applyHighFrequencyShinglePruning(
  client: Client,
  shingleHashes: Set<string>,
  options: {
    fingerprintVersion: string;
    /** undefined disables pruning entirely — returns `shingleHashes` unchanged with no DB call. */
    maxDocumentFrequency: number | undefined;
    minDiscriminativeShingles: number;
    chunkSize: number;
    /**
     * The requester's own account id, forwarded verbatim from
     * findCandidateCorpusRepresentations. When present, DF counts only
     * representations eligible FOR THIS REQUESTER — the same account-aware
     * admissionEligibilitySql the candidate query applies: a representation
     * backed ONLY by this account's own admission promotion(s) is not
     * counted (it would be excluded from candidate discovery anyway), so it
     * cannot inflate a hash's DF and falsely prune a legitimate
     * cross-account source. Passed through buildReportAdmissionAccountPrefix
     * exactly as findCandidateCorpusRepresentations does — never a second
     * account-exclusion rule.
     */
    excludeAccountId?: string;
    /**
     * Phase A — 7-day corpus maturity. "MATCHING" (default) => the DF probe
     * counts a shingle only against representations the candidate query would
     * also treat as mature and eligible. "ADMISSION_DEDUP" => no maturity gate.
     * Forwarded verbatim from findCandidateCorpusRepresentations.
     */
    eligibilityMode?: CorpusEligibilityMode;
    /**
     * The already-resolved maturity cutoff for this resolution (MATCHING mode),
     * forwarded verbatim from findCandidateCorpusRepresentations so the probe
     * and the candidate query share ONE logical clock. When absent in MATCHING
     * mode it is derived from `asOf ?? new Date()` — never treated as "gate off".
     */
    maturityCutoff?: string;
    /** Fallback clock for MATCHING mode when no explicit maturityCutoff is threaded in. */
    asOf?: Date;
    /**
     * The already-resolved developer corpus-maturity exemption list (JSON
     * array of buildReportAdmissionAccountPrefix(...) strings), forwarded
     * verbatim from findCandidateCorpusRepresentations so the probe and the
     * candidate query can never disagree on which accounts are exempt mid-
     * resolution — same "one clock" discipline as maturityCutoff. When
     * absent it is resolved fresh here (a direct call, or a test).
     */
    exemptAccountPrefixesJson?: string;
    diagnostics?: CandidateDiscoveryDiagnostics;
  },
): Promise<Set<string>> {
  const hashList = [...shingleHashes];
  const writeDiagnostics = (surviving: number, fallbackUsed: boolean, appliedMaxDf: number | null) => {
    if (!options.diagnostics) return;
    options.diagnostics.inputShingleCount = hashList.length;
    options.diagnostics.survivingShingleCount = surviving;
    options.diagnostics.highDfPrunedCount = hashList.length - surviving;
    options.diagnostics.fallbackUsed = fallbackUsed;
    options.diagnostics.appliedMaxDocumentFrequency = appliedMaxDf;
  };

  if (options.maxDocumentFrequency === undefined || hashList.length === 0) {
    writeDiagnostics(hashList.length, false, null);
    return shingleHashes;
  }
  const maxDf = options.maxDocumentFrequency;
  // "> maxDf ELIGIBLE representations?" is the only question, so the
  // per-hash posting-list walk stops after maxDf + 1 eligible ones.
  const probeLimit = Math.trunc(maxDf) + 1;
  // Account-aware eligibility — the SAME derivation and helper
  // findCandidateCorpusRepresentations uses (never a second rule). null =>
  // global eligibility; a prefix => a representation backed ONLY by that
  // account's own admission promotion(s) does not count toward DF, matching
  // the candidate query's own account exclusion exactly.
  const excludeAccountPrefix = options.excludeAccountId ? buildReportAdmissionAccountPrefix(options.excludeAccountId) : null;
  const eligibilityMode: CorpusEligibilityMode = options.eligibilityMode ?? "MATCHING";
  const maturityCutoff = resolveMaturityCutoff(eligibilityMode, options);
  const exemptAccountPrefixesJson = options.exemptAccountPrefixesJson ?? JSON.stringify(await resolveExemptAccountPrefixes(client, eligibilityMode));
  const eligibilitySql = admissionEligibilitySql(eligibilityMode);

  const eligibleDocumentFrequency = new Map<string, number>();
  for (const hash of hashList) eligibleDocumentFrequency.set(hash, 0);
  for (let offset = 0; offset < hashList.length; offset += options.chunkSize) {
    const chunk = hashList.slice(offset, offset + options.chunkSize);
    // json_each(?) carries the whole chunk as ONE bind value. Per hash, the
    // inner query walks idx_corpus_document_shingles_hash, applies the exact
    // account-aware + maturity-aware admissionEligibilitySql predicate per
    // posting, and stops after maxDf + 1 ELIGIBLE representations. Anonymous
    // ?, bound in textual order: fingerprint_version, then
    // admissionEligibilityBindArgs (account-prefix ×3 for ADMISSION_DEDUP, or
    // cutoff + account-prefix ×3 + cutoff + exempt-json + cutoff for MATCHING —
    // see that function's own doc comment), then LIMIT, then the json_each array.
    const result = await client.execute({
      sql: `SELECT j.value AS shingle_hash,
                   (SELECT COUNT(*) FROM (
                      SELECT 1
                      FROM corpus_document_shingles s
                      JOIN corpus_document_representations r ON r.id = s.representation_id
                      WHERE s.fingerprint_version = ?
                        AND s.shingle_hash = j.value
                        AND ${eligibilitySql}
                      LIMIT ?
                    )) AS eligible_document_frequency
            FROM json_each(?) j`,
      args: [options.fingerprintVersion, ...admissionEligibilityBindArgs(excludeAccountPrefix, eligibilityMode, maturityCutoff, exemptAccountPrefixesJson), probeLimit, JSON.stringify(chunk)],
    });
    for (const row of result.rows as unknown as { shingle_hash: string; eligible_document_frequency: number | bigint }[]) {
      eligibleDocumentFrequency.set(String(row.shingle_hash), Number(row.eligible_document_frequency));
    }
  }

  const discriminative = hashList.filter((hash) => (eligibleDocumentFrequency.get(hash) ?? 0) <= maxDf);
  if (discriminative.length >= options.minDiscriminativeShingles || discriminative.length === hashList.length) {
    writeDiagnostics(discriminative.length, false, maxDf);
    return new Set(discriminative);
  }

  // Low-information fallback: abandon pruning for this query and search on
  // the complete original shingle set — exactly what an unpruned run does.
  writeDiagnostics(hashList.length, true, maxDf);
  return shingleHashes;
}

/**
 * "Which historical reusable document representations have matching
 * passages with this submission?" (this phase's own task description,
 * section 11) — representation-level only. This query never joins to
 * document_identities, corpus_submission_references (beyond the existence
 * check below), or users, so it structurally cannot return an account id or
 * email; a future E8B relationship classifier (SELF / PRIOR_SUBMISSION /
 * CROSS_ACCOUNT) would resolve ownership separately, only for
 * representations this function already identified as candidates. No live
 * comparison happens here — this only reads the already-recorded shingle
 * index.
 *
 * Eligibility is source-aware (lib/corpus-admission-promotion.ts's own
 * header comment has the full argument) — a representation is a candidate
 * if ANY of:
 *   1. a real submission reference exists (corpus_submission_references —
 *      always eligible, there is no revocation concept for those), OR
 *   2. an 'indexed' promotion exists whose own
 *      corpus_admission_accepted_representations row is not revoked
 *      (deliberately NOT "does THIS promotion say active" — a
 *      representation can be promoted by more than one decision, an exact
 *      canonical duplicate, so deactivating any single decision's
 *      fingerprint must never hide a representation another still-active
 *      source also backs) — same-account self-match fix: when the caller
 *      supplies excludeAccountId (options.excludeAccountId below), this
 *      condition additionally requires that backing's own decision belong
 *      to a DIFFERENT account, not merely a different report — a
 *      representation backed only by prior admissions from the account
 *      currently being evaluated cannot satisfy this condition through any
 *      of its own account's reports, while a second, independent backing
 *      from any OTHER account still can — see admissionEligibilitySql's own
 *      comment for the full argument, OR
 *   3. no promotion with link_type = 'NEW_CONTENT_REPRESENTATION' exists
 *      for it at all — i.e. this representation was never CREATED by the
 *      promotion pipeline in the first place (a legacy/pre-existing/
 *      built-in corpus row seeded some other way). Condition 3 is what
 *      keeps such rows permanently eligible: nothing in this system has
 *      ever "deactivated" them, so nothing should ever be able to hide
 *      them. It does NOT rescue a representation the promotion pipeline
 *      genuinely created and fully deactivated — for that row, condition 3
 *      is false precisely because its own NEW_CONTENT_REPRESENTATION
 *      promotion row does exist (durable, never deleted), which is exactly
 *      why conditions 1/2 are the ones deciding its fate instead.
 */
/**
 * The exact admission-side eligibility predicate for ONE representation
 * (correlated on `r.id` — every caller of this fragment must alias
 * corpus_document_representations as `r`) — the single source of truth for
 * "does this representation have an active, eligible backing," shared by
 * findCandidateCorpusRepresentations' own batch WHERE clause,
 * isRepresentationEligibleForMatching's single-row check, and
 * applyHighFrequencyShinglePruning's DF probe, so all three can never
 * diverge. Three conditions (see this file's own header comment above
 * findCandidateCorpusRepresentations); condition 2 carries the account-level
 * self-match refinement, and Phase A adds a per-backing 7-day maturity gate to
 * all three arms in "MATCHING" mode — the default for all three consumers.
 * Only the corpus-admission gate's redundancy lookup passes "ADMISSION_DEDUP"
 * to inspect immature stored content (see CorpusEligibilityMode and
 * admissionEligibilitySql's own `mode` doc below):
 *   1. a real submission reference exists — untouched by excludeAccountId;
 *      Phase A: its corpus_submission_references.created_at must be mature.
 *      A completely separate identity system from
 *      admission-promotion (see lib/report-historical-match.ts's own
 *      SELF/PRIOR_SUBMISSION path, which already has its own, unrelated
 *      self-exclusion via documentIdentityId) — this fix does not touch it.
 *   2. an 'indexed' promotion exists whose own accepted_representation is
 *      not revoked, AND — when excludeAccountId is supplied — whose own
 *      decision's source_ref does not belong to that account, AND (Phase A)
 *      whose own decision's created_at is mature. `ar` (joined via
 *      p.accepted_representation_id) supplies ONLY revocation state; the
 *      decision is joined via p.decision_id and supplies BOTH source_ref and
 *      the immutable maturity T0. A
 *      representation backed only by admissions from the account currently
 *      being evaluated is therefore NOT eligible through this condition,
 *      REGARDLESS of which of that account's own reports created each
 *      backing; a second, independent active backing from any OTHER
 *      account still is (this is exactly why the check lives inside this
 *      EXISTS, correlated per-backing, rather than as an outer filter on
 *      the representation as a whole — a representation with two backings,
 *      one from this account and one from another, must still satisfy this
 *      condition via the other account's own backing).
 *   3. no promotion with link_type = 'NEW_CONTENT_REPRESENTATION' exists
 *      for it at all (a legacy/pre-existing row) — no self-match is possible
 *      for a row nothing in this pipeline ever created. Phase A: it must
 *      ALSO have r.first_seen_at mature, so a freshly-seeded legacy row
 *      still waits the full 7-day window (old legacy rows have a first_seen_at
 *      long in the past and stay eligible).
 * excludeAccountId is compared via a plain substr/exact-equality prefix
 * check against d.source_ref, never SQL LIKE (no wildcard-injection risk
 * from an account id containing `%`/`_`) and never by parsing the OTHER
 * side — buildReportAdmissionAccountPrefix (lib/corpus-admission-source-
 * ref.ts) is the ONE place this exact `report-upload:account=X:device=`
 * prefix format is built, reused here so this can never drift from
 * buildReportAdmissionSourceRef's own encoding. The prefix's own trailing
 * `:device=` delimiter is what makes this collision-safe for accounts whose
 * ids share a prefix (e.g. "abc" vs "abc123") — see that helper's own
 * comment for why. This can only ever exclude backings from ONE account,
 * never a broader class of content or every backing of a shared
 * representation.
 */
/**
 * Phase A — 7-day corpus maturity. In "MATCHING" mode (the default for every
 * consumer) each backing arm additionally requires its own immutable T0 <= the
 * caller-supplied maturity cutoff (asOf - CORPUS_ACTIVATION_DELAY_DAYS), and
 * the legacy arm requires `r.first_seen_at <= cutoff` so a freshly-seeded
 * representation with neither backing type also waits the full window (old
 * legacy rows have a first_seen_at long in the past and stay eligible). In
 * "ADMISSION_DEDUP" mode NO maturity term is emitted (see CorpusEligibilityMode)
 * — the exact pre-Phase-A predicate.
 *
 * ADMISSION arm — the join to `d` moves from `ar.decision_id` to
 * `p.decision_id`. `ar` supplies ONLY revocation state (`ar.revoked_at`); the
 * promotion's OWN decision supplies BOTH the account-exclusion `source_ref`
 * AND the immutable maturity T0 (`d.created_at`). This is deliberate:
 * corpus_admission_accepted_representations is canonical-SHA unique
 * (first-accepted-sample-wins), so its `created_at` is frozen to the first
 * decision and a later backing deduped onto that same AR would inherit an
 * older age; corpus_admission_decisions has one immutable row per evaluation.
 * For every promotion the current staging path creates
 * (stageCorpusAdmissionPromotionForDecision / runCorpusAdmissionPromotionSweep
 * both join `ar.decision_id = d.id`), `p.decision_id == ar.decision_id`, so
 * `d.source_ref` — and therefore the account-exclusion predicate — is
 * byte-identical to the previous `d ON d.id = ar.decision_id` form.
 *
 * Developer corpus-maturity exemption (drizzle/0047,
 * developer_corpus_maturity_exemptions) — a per-account, admin-managed
 * override of ONLY the maturity term, never the account self-exclusion
 * predicate above, and never emitted at all outside "MATCHING" mode (moot in
 * "ADMISSION_DEDUP" since no maturity term is emitted there either):
 *   arm 1 (submission-reference): OR'd with a plain correlated EXISTS join
 *     from sr.document_identity_id -> document_identities.account_id -> the
 *     exemptions table — a clean FK, no string parsing needed.
 *   arm 2 (admission-promotion): the owning account is embedded in
 *     d.source_ref (buildReportAdmissionAccountPrefix's own format, "the ONE
 *     place this exact format is built" — see corpus-admission-source-ref.ts).
 *     Never re-derive that format inline in SQL: the caller precomputes one
 *     prefix per currently-exempt account via buildReportAdmissionAccountPrefix
 *     (resolveExemptAccountPrefixes below), binds them as ONE json array, and
 *     the SQL below does the SAME substr-prefix-equality check the account-
 *     exclusion predicate above already uses (never LIKE) over json_each(?).
 *   arm 3 (legacy representation): no owner is recoverable, so no exemption
 *     term applies — unaffected.
 *
 * The `?` placeholders appear in a FIXED textual order — bind them via
 * admissionEligibilityBindArgs, never inline.
 *
 * "ARCHIVE" mode (lib/archive-corpus-matching.ts's matchAgainstArchiveCorpus,
 * ONLY) is a completely separate, narrower predicate — NOT arms 1/2/3 above,
 * and no maturity term of any kind — see CorpusEligibilityMode's own
 * comment for why first_seen_at cannot be trusted as a maturity proxy once a
 * representation is reused by seedArchiveDocument's canonical-hash dedup.
 * Eligibility is exactly "does this representation have an
 * archive_document_representations row" — no fingerprint_version filter is
 * needed here because the caller's own shingle-hash JOIN (in
 * findCandidateCorpusRepresentations) already scopes every candidate to the
 * requested fingerprint_version before this predicate ever runs.
 */
function admissionEligibilitySql(mode: CorpusEligibilityMode): string {
  if (mode === "ARCHIVE") {
    return `EXISTS (SELECT 1 FROM archive_document_representations adr WHERE adr.representation_id = r.id)`;
  }
  const emitMaturityTerms = mode === "MATCHING";
  const arm1Maturity = emitMaturityTerms
    ? ` AND (sr.created_at <= ? OR EXISTS (
        SELECT 1 FROM document_identities di
        JOIN developer_corpus_maturity_exemptions dcme ON dcme.user_id = di.account_id
        WHERE di.id = sr.document_identity_id
      ))`
    : "";
  const arm2Maturity = emitMaturityTerms
    ? ` AND (d.created_at <= ? OR EXISTS (
        SELECT 1 FROM json_each(?) exempt WHERE substr(d.source_ref, 1, length(exempt.value)) = exempt.value
      ))`
    : "";
  const arm3Maturity = emitMaturityTerms ? " AND r.first_seen_at <= ?" : "";
  return `(
    EXISTS (SELECT 1 FROM corpus_submission_references sr WHERE sr.representation_id = r.id${arm1Maturity})
    OR EXISTS (
      SELECT 1 FROM corpus_admission_promotions p
      JOIN corpus_admission_accepted_representations ar ON ar.id = p.accepted_representation_id
      JOIN corpus_admission_decisions d ON d.id = p.decision_id
      WHERE p.representation_id = r.id AND p.status = 'indexed' AND ar.revoked_at IS NULL
        AND (? IS NULL OR substr(d.source_ref, 1, length(?)) != ?)${arm2Maturity}
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM corpus_admission_promotions p2
        WHERE p2.representation_id = r.id AND p2.link_type = 'NEW_CONTENT_REPRESENTATION'
      )${arm3Maturity}
    )
  )`;
}

/**
 * Positional bind values for admissionEligibilitySql(mode), in the exact `?`
 * order of the fragment:
 *   ARCHIVE:         []                                                                (no placeholders at all)
 *   ADMISSION_DEDUP: [prefix, prefix, prefix]                                        (arm 2 only)
 *   MATCHING:        [cutoff, prefix, prefix, prefix, cutoff, exemptJson, cutoff]
 *                     arm1    ── arm 2 account-exclusion ──  arm2  arm2-exempt  arm3
 *
 * MATCHING mode with a null cutoff is unreachable through resolveMaturityCutoff
 * — the explicit throw is a tripwire so a future refactor can never emit a
 * MATCHING query whose maturity binds are silently missing. exemptAccountPrefixesJson
 * is a JSON array of buildReportAdmissionAccountPrefix(...) strings (possibly
 * "[]") — see resolveExemptAccountPrefixes.
 */
function admissionEligibilityBindArgs(
  excludeAccountPrefix: string | null,
  mode: CorpusEligibilityMode,
  maturityCutoff: string | null,
  exemptAccountPrefixesJson: string,
): (string | null)[] {
  if (mode === "ARCHIVE") {
    return [];
  }
  if (mode === "ADMISSION_DEDUP") {
    return [excludeAccountPrefix, excludeAccountPrefix, excludeAccountPrefix];
  }
  if (maturityCutoff === null) {
    throw new Error("admissionEligibilityBindArgs: MATCHING mode requires a resolved maturityCutoff");
  }
  return [maturityCutoff, excludeAccountPrefix, excludeAccountPrefix, excludeAccountPrefix, maturityCutoff, exemptAccountPrefixesJson, maturityCutoff];
}

export async function findCandidateCorpusRepresentations(
  client: Client,
  shingleHashes: Set<string>,
  options: {
    fingerprintVersion?: string;
    minSharedShingles?: number;
    limit?: number;
    excludeAccountId?: string;
    /**
     * Query-time high-frequency shingle pruning ceiling for candidate
     * DISCOVERY only (see applyHighFrequencyShinglePruning's own comment and
     * lib/user-submission-matching.ts's maxCandidateShingleDocumentFrequency).
     * A query shingle present in MORE than this many MATCH-ELIGIBLE
     * representations (for this fingerprint_version;
     * revoked/deactivated-only representations excluded) is dropped before
     * the candidate GROUP BY. undefined (the default) disables pruning
     * entirely — the DB query below is then byte-identical, and every
     * existing caller keeps its exact prior behavior and cost.
     */
    maxDocumentFrequency?: number;
    /** Low-information fallback floor — consulted only when maxDocumentFrequency is set. Below it, pruning is abandoned and the full original shingle set is searched. Default 24. See applyHighFrequencyShinglePruning. */
    minDiscriminativeShingles?: number;
    /**
     * Phase A — 7-day corpus maturity. "MATCHING" (the DEFAULT) enforces the
     * 7-day gate on every candidate — an ordinary matching caller that omits
     * every maturity argument still gets it, derived from `asOf ?? new Date()`.
     * "ADMISSION_DEDUP" is the single deliberate bypass (corpus-admission
     * gate's redundancy lookup — never a similarity score). See
     * CorpusEligibilityMode.
     */
    eligibilityMode?: CorpusEligibilityMode;
    /**
     * MATCHING mode only. The already-resolved cutoff string
     * (asOf - CORPUS_ACTIVATION_DELAY_DAYS) — production's single logical clock,
     * threaded down from getOrComputeHistoricalMatchSnapshot. When omitted it
     * is derived from `asOf ?? new Date()`; it is NEVER interpreted as "gate
     * off". Resolved ONCE here and forwarded verbatim to the DF probe so
     * discovery, pruning and selection share one instant.
     */
    maturityCutoff?: string;
    /** Fallback clock for MATCHING mode when no explicit maturityCutoff is threaded in. Tests inject/freeze it. */
    asOf?: Date;
    /** Developer/test diagnostics sink for the pruning step — populated in place, never returned. */
    diagnostics?: CandidateDiscoveryDiagnostics;
  } = {},
): Promise<CandidateCorpusRepresentation[]> {
  const fingerprintVersion = options.fingerprintVersion ?? CORPUS_FINGERPRINT_VERSION;
  const minSharedShingles = options.minSharedShingles ?? 1;
  const limit = options.limit ?? 50;
  const excludeAccountPrefix = options.excludeAccountId ? buildReportAdmissionAccountPrefix(options.excludeAccountId) : null;
  const eligibilityMode: CorpusEligibilityMode = options.eligibilityMode ?? "MATCHING";
  // Resolved ONCE for the whole call — the DF probe below is handed this exact
  // string (not asOf), so pruning and candidate selection can never straddle a
  // maturity boundary.
  const maturityCutoff = resolveMaturityCutoff(eligibilityMode, options);
  const exemptAccountPrefixesJson = JSON.stringify(await resolveExemptAccountPrefixes(client, eligibilityMode));
  const eligibilitySql = admissionEligibilitySql(eligibilityMode);
  const eligibilityArgs = () => admissionEligibilityBindArgs(excludeAccountPrefix, eligibilityMode, maturityCutoff, exemptAccountPrefixesJson);
  if (shingleHashes.size === 0) return [];

  type RawSharedRow = { representation_id: string; shared: number | bigint; canonical_sha256: string; word_count: number; is_actively_promoted: number | bigint };

  // SQLite/libSQL binds at most 32766 parameters per statement
  // (SQLITE_MAX_VARIABLE_NUMBER). A large submission can produce far more
  // informative shingles than that, so the shingle-hash lookup is chunked
  // whenever the hash list alone would approach that ceiling: each chunk's
  // per-representation COUNT(*) is summed back together before the
  // shared-shingle threshold, ordering, and limit are applied in memory.
  // is_actively_promoted and admissionEligibilitySql() are both correlated
  // on r.id alone, so a representation's value for them is identical in
  // every chunk it appears in. The common case (a single chunk) runs the
  // exact same one query as before, with HAVING / ORDER BY / LIMIT still
  // applied server-side — no behavioral or performance change for it.
  const SHINGLE_IN_CHUNK_SIZE = 20_000;

  // Query-time high-frequency shingle pruning (candidate DISCOVERY only —
  // see applyHighFrequencyShinglePruning). options.maxDocumentFrequency
  // undefined => effectiveHashes === shingleHashes and no DB call is made
  // here, so the search below is exactly what every prior build ran. The DF
  // probe binds each chunk as one json_each value (no per-hash SQL
  // variable), so the same 20,000 ceiling is reused only to keep its result
  // sets bounded, consistently with the candidate query below.
  const effectiveHashes = await applyHighFrequencyShinglePruning(client, shingleHashes, {
    fingerprintVersion,
    maxDocumentFrequency: options.maxDocumentFrequency,
    minDiscriminativeShingles: options.minDiscriminativeShingles ?? 24,
    chunkSize: SHINGLE_IN_CHUNK_SIZE,
    // Account-aware DF: the DF probe must count only representations the
    // candidate query below would also consider eligible for this requester.
    excludeAccountId: options.excludeAccountId,
    // Phase A: the DF probe must apply the SAME maturity gate the candidate
    // query does — same mode, same already-resolved cutoff string (one clock),
    // so an immature representation cannot inflate a shingle's document
    // frequency any more than it could become a candidate.
    eligibilityMode,
    maturityCutoff: maturityCutoff ?? undefined,
    exemptAccountPrefixesJson,
    diagnostics: options.diagnostics,
  });
  if (effectiveHashes.size === 0) return [];

  const hashList = [...effectiveHashes];
  const isActivelyPromotedCase = `CASE WHEN EXISTS (
              SELECT 1 FROM corpus_admission_promotions p
              JOIN corpus_admission_accepted_representations ar ON ar.id = p.accepted_representation_id
              WHERE p.representation_id = r.id AND p.status = 'indexed' AND ar.revoked_at IS NULL
            ) THEN 1 ELSE 0 END AS is_actively_promoted`;

  let sharedRows: RawSharedRow[];
  if (hashList.length <= SHINGLE_IN_CHUNK_SIZE) {
    const placeholders = hashList.map(() => "?").join(",");
    const sharedResult = await client.execute({
      sql: `SELECT s.representation_id AS representation_id, COUNT(*) AS shared, r.canonical_sha256 AS canonical_sha256, r.word_count AS word_count,
              ${isActivelyPromotedCase}
            FROM corpus_document_shingles s
            JOIN corpus_document_representations r ON r.id = s.representation_id
            WHERE s.fingerprint_version = ? AND s.shingle_hash IN (${placeholders})
              AND ${eligibilitySql}
            GROUP BY s.representation_id
            HAVING COUNT(*) >= ?
            ORDER BY shared DESC
            LIMIT ?`,
      args: [fingerprintVersion, ...hashList, ...eligibilityArgs(), minSharedShingles, limit],
    });
    sharedRows = sharedResult.rows as unknown as RawSharedRow[];
  } else {
    const accumulatorById = new Map<string, RawSharedRow>();
    for (let offset = 0; offset < hashList.length; offset += SHINGLE_IN_CHUNK_SIZE) {
      const chunk = hashList.slice(offset, offset + SHINGLE_IN_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      const chunkResult = await client.execute({
        sql: `SELECT s.representation_id AS representation_id, COUNT(*) AS shared, r.canonical_sha256 AS canonical_sha256, r.word_count AS word_count,
                ${isActivelyPromotedCase}
              FROM corpus_document_shingles s
              JOIN corpus_document_representations r ON r.id = s.representation_id
              WHERE s.fingerprint_version = ? AND s.shingle_hash IN (${placeholders})
                AND ${eligibilitySql}
              GROUP BY s.representation_id`,
        args: [fingerprintVersion, ...chunk, ...eligibilityArgs()],
      });
      for (const raw of chunkResult.rows as unknown as RawSharedRow[]) {
        const prior = accumulatorById.get(raw.representation_id);
        if (prior) prior.shared = Number(prior.shared) + Number(raw.shared);
        else accumulatorById.set(raw.representation_id, { ...raw, shared: Number(raw.shared) });
      }
    }
    sharedRows = [...accumulatorById.values()]
      .filter((row) => Number(row.shared) >= minSharedShingles)
      .sort((a, b) =>
        Number(b.shared) - Number(a.shared) ||
        (a.representation_id < b.representation_id ? -1 : a.representation_id > b.representation_id ? 1 : 0),
      )
      .slice(0, limit);
  }
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

  // The search was conducted over effectiveHashes (== shingleHashes unless
  // high-DF pruning removed some), and `shared` counts only those, so the
  // containment denominator must match the same set — otherwise a pruned
  // run would report an artificially low containment (shared over an
  // un-pruned target). No downstream consumer reads this field on a pruned
  // run anyway (lib/user-submission-matching.ts recomputes containment from
  // full text via computeDocumentCorrespondence), but keeping it internally
  // consistent avoids a confusing diagnostic.
  const targetCount = effectiveHashes.size;
  return sharedRows.map((row) => {
    const shared = Number(row.shared);
    const candidateTotal = totalsById.get(row.representation_id) ?? 0;
    return {
      representationId: row.representation_id,
      canonicalSha256: row.canonical_sha256,
      wordCount: Number(row.word_count),
      sharedShingleCount: shared,
      containment: containment(shared, targetCount, candidateTotal),
      isActivelyPromoted: Number(row.is_actively_promoted) === 1,
    };
  });
}

/**
 * Standalone single-representation form of the same EXISTS check
 * findCandidateCorpusRepresentations' own query already runs inline — for
 * lib/user-submission-matching.ts's defensive exact-canonical-hash addition,
 * which builds a CandidateCorpusRepresentation from
 * findReusableRepresentationByCanonicalHash (a different, simpler lookup
 * with no promotion-awareness of its own) rather than from this file's own
 * candidate-search query. Boolean-only, same discipline as
 * summarizeSubmissionOwnership — never returns decision_id, source_ref, or
 * any other corpus-admission-domain identifier.
 */
export async function isRepresentationActivelyPromoted(client: Client, representationId: string): Promise<boolean> {
  const result = await client.execute({
    sql: `SELECT EXISTS (
            SELECT 1 FROM corpus_admission_promotions p
            JOIN corpus_admission_accepted_representations ar ON ar.id = p.accepted_representation_id
            WHERE p.representation_id = ? AND p.status = 'indexed' AND ar.revoked_at IS NULL
          ) AS is_actively_promoted`,
    args: [representationId],
  });
  const row = result.rows[0] as unknown as { is_actively_promoted: number | bigint } | undefined;
  return row !== undefined && Number(row.is_actively_promoted) === 1;
}

/**
 * Self-match fix: standalone single-representation form of
 * admissionEligibilitySql (shared, never a second implementation) — for
 * lib/user-submission-matching.ts's own defensive exact-canonical-hash
 * fallback. That fallback builds a candidate from
 * findReusableRepresentationByCanonicalHash directly — a plain hash lookup
 * with NO eligibility awareness of its own (it is also used by lib/corpus-
 * admission-promotion.ts's own find-or-create dedup logic, where
 * eligibility is irrelevant) — completely bypassing
 * findCandidateCorpusRepresentations' own WHERE clause. A byte-identical
 * self-upload of a just-promoted document is exactly an exact-hash match,
 * so leaving that fallback ungated would make excludeAccountId a no-op for
 * the precise scenario it exists to close. Boolean-only, same discipline as
 * summarizeSubmissionOwnership/isRepresentationActivelyPromoted — never
 * returns decision_id, source_ref, account id, or any other corpus-
 * admission-domain identifier.
 */
export async function isRepresentationEligibleForMatching(
  client: Client,
  representationId: string,
  options: {
    excludeAccountId?: string;
    /**
     * Phase A — 7-day corpus maturity. "MATCHING" (the DEFAULT) applies the
     * same 7-day gate findCandidateCorpusRepresentations does; omitting a
     * cutoff derives it from `asOf ?? new Date()`, never "gate off".
     * "ADMISSION_DEDUP" is the single deliberate bypass. See CorpusEligibilityMode.
     */
    eligibilityMode?: CorpusEligibilityMode;
    /** MATCHING mode: the already-resolved cutoff (production's single logical clock). Omitted => derived from `asOf ?? new Date()`. */
    maturityCutoff?: string;
    /** Fallback clock for MATCHING mode when no explicit maturityCutoff is threaded in. */
    asOf?: Date;
  } = {},
): Promise<boolean> {
  const excludeAccountPrefix = options.excludeAccountId ? buildReportAdmissionAccountPrefix(options.excludeAccountId) : null;
  const eligibilityMode: CorpusEligibilityMode = options.eligibilityMode ?? "MATCHING";
  const maturityCutoff = resolveMaturityCutoff(eligibilityMode, options);
  const exemptAccountPrefixesJson = JSON.stringify(await resolveExemptAccountPrefixes(client, eligibilityMode));
  const result = await client.execute({
    sql: `SELECT ${admissionEligibilitySql(eligibilityMode)} AS eligible FROM corpus_document_representations r WHERE r.id = ?`,
    args: [...admissionEligibilityBindArgs(excludeAccountPrefix, eligibilityMode, maturityCutoff, exemptAccountPrefixesJson), representationId],
  });
  const row = result.rows[0] as unknown as { eligible: number | bigint } | undefined;
  return row !== undefined && Number(row.eligible) === 1;
}

/**
 * Idempotent (INSERT OR IGNORE) — safe to call more than once for the same
 * representation/version, matching lib/document-family.ts's
 * recordDocumentIdentityShingles convention.
 *
 * Shingle rows are written in bounded batches of CORPUS_SHINGLE_WRITE_BATCH_ROWS
 * so a very large representation (up to ~330k informative shingles for a
 * max-size document) can never produce one oversized batch() request. When
 * `client` is an open Transaction (the indexPromotionAtomically path) every
 * batch appends to that one transaction, so the full write commits or rolls
 * back exactly as a single batch would.
 *
 * On the best-effort, non-transactional indexDocumentSubmissionIntoCorpus
 * path each batch is its own implicit transaction, so a mid-run failure can
 * leave the representation with only SOME of its batches. INSERT OR IGNORE
 * makes that recoverable: that caller re-invokes recordCorpusShingles for a
 * reused representation on every retry, and this function then simply fills
 * the missing rows and no-ops the rest.
 */
export async function recordCorpusShingles(
  client: Client,
  representationId: string,
  canonicalText: string,
  fingerprintVersion: string = CORPUS_FINGERPRINT_VERSION,
  shingleSize: number = DEFAULT_SHINGLE_SIZE,
): Promise<{ shingleCount: number }> {
  const hashes = corpusShingleHashes(canonicalText, shingleSize);
  const hashList = [...hashes];
  for (let offset = 0; offset < hashList.length; offset += CORPUS_SHINGLE_WRITE_BATCH_ROWS) {
    const chunk = hashList.slice(offset, offset + CORPUS_SHINGLE_WRITE_BATCH_ROWS);
    const statements = chunk.map((hash) => ({
      sql: "INSERT OR IGNORE INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
      args: [representationId, hash, fingerprintVersion],
    }));
    await client.batch(statements, "write");
  }
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
 *      (EXACT_CANONICAL_DUPLICATE), or creates one (NEW_CONTENT_REPRESENTATION)
 *      — this phase's own task description, section 6 — and in BOTH cases
 *      (re-)runs the full INSERT-OR-IGNORE shingle write, so a retry after a
 *      partially-written shingle set self-heals it (see the inline comment)
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
    // Self-heal the shingle set on reuse. This function is non-transactional
    // by design (see its header), and recordCorpusShingles writes in bounded
    // batches (CORPUS_SHINGLE_WRITE_BATCH_ROWS) — so a prior attempt that
    // created the representation but failed partway through its shingle
    // batches would leave corpus_document_shingles under-populated, and a
    // retry reuses that representation here and would otherwise never
    // re-shingle it, leaving it permanently short. Re-running the full
    // shingle write is safe and cheap: recordCorpusShingles is INSERT OR
    // IGNORE against ux_corpus_document_shingles_representation_version_hash,
    // so it fills exactly the missing rows, never duplicates an existing one,
    // and every INSERT is a no-op in the common case where the representation
    // was already fully shingled by an earlier submission.
    await recordCorpusShingles(client, representation.id, canonicalText);
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

  // Corpus-match generation bump: a newly indexed submission reference is an
  // "eligibility ADDED" event exactly like a promotion reaching 'indexed' —
  // it can turn a report that currently has a cached NO_HISTORICAL_MATCH
  // into a real SELF/PRIOR_SUBMISSION match, and that report's snapshot does
  // not reference this representation yet, so only the global generation
  // counter can invalidate it (a targeted per-representation search cannot
  // find what is missing). Runs for both a brand-new representation and an
  // EXACT_CANONICAL_DUPLICATE (the new reference changes ownership counting
  // for the shared representation). Not wrapped in a transaction here — this
  // function's callers already treat it as best-effort eventual-consistency
  // indexing; an extra bump on a partial failure only costs a harmless
  // recompute. This is the same counter and the same one-statement UPDATE
  // lib/corpus-admission-promotion.ts and lib/corpus-admission-admin-actions.ts
  // use, never a second mechanism.
  await bumpCorpusMatchGeneration(client);

  return { status: "INDEXED", linkType, representationId: representation.id, submissionReferenceId: reference.id };
}
