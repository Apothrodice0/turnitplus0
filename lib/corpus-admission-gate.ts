import { randomUUID } from "node:crypto";
import type { Client, Transaction, InStatement, ResultSet } from "@libsql/client";
import { canonicalizeText } from "./canonical-text";
import { canonicalSha256 } from "./document-identity";
import { corpusShingleHashes, findCandidateCorpusRepresentations, CORPUS_SHINGLE_WRITE_BATCH_ROWS } from "./user-submission-corpus";
import { containment } from "./similarity-core";
import { validateCorpusCandidateFile, type CorpusFileValidationResult } from "./corpus-file-validation";
import { extractCorpusCandidateText, type CorpusExtractionResult } from "./corpus-text-extraction";
import { computeCorpusFeatureVector, type CorpusFeatureVector } from "./corpus-quality-signals";
import { computeCorpusQualityScore, type CorpusQualityComponentScores, type CorpusQualityScoreResult } from "./corpus-quality-model";
import { evaluateCorpusHardGates } from "./corpus-hard-gates";
import { resolveCorpusArticleFamily, isCorpusLengthCompatible, DEFAULT_CORPUS_FAMILY_THRESHOLDS, type CorpusFamilyCandidate, type CorpusFamilyResolution } from "./corpus-admission-family";
import { decideCorpusAdmission, computeCorpusValueScore } from "./corpus-admission-policy";
import type {
  CorpusAdmissionDecision,
  CorpusAdmissionLimits,
  CorpusAdmissionReasonCode,
  CorpusConsentEvidence,
  CorpusHardGateCode,
  CorpusSupportedFormat,
} from "./corpus-admission-types";
import { DEFAULT_CORPUS_ADMISSION_LIMITS } from "./corpus-admission-types";

/**
 * The only DB-touching module in the corpus-admission-gate feature.
 * Orchestrates file validation -> isolated extraction -> quality scoring
 * -> hard gates -> "first accepted sample wins" family resolution ->
 * decision -> persistence.
 *
 * Structurally never imports lib/user-submission-corpus.ts's 4 WRITE
 * functions (createReusableDocumentRepresentation, recordCorpusShingles,
 * recordSubmissionReference, indexDocumentSubmissionIntoCorpus) — only its
 * two READ functions (corpusShingleHashes, findCandidateCorpusRepresentations)
 * are imported, for family/near-duplicate lookups against the real corpus.
 * See tests/corpus-admission-privacy.test.mjs's structural self-check.
 *
 * corpus_admission_decisions never receives raw text: the feature vector,
 * component scores, and reason codes are persisted, but canonical_text
 * lives ONLY in corpus_admission_content_store, written exactly when
 * dryRun===false AND decision==="ACCEPT" AND retention rights are resolved
 * — never otherwise. corpus_admission_accepted_representations /
 * corpus_admission_accepted_shingles (the durable "first accepted sample
 * wins" registry added to fix the verification pass's confirmed
 * concurrency defect) hold ONLY the derived fingerprint (hash, word count,
 * shingle hashes) — never raw text either.
 *
 * corpus_admission_accepted_representations.revoked_at (drizzle/0032):
 * findAcceptedFamilyCandidates and findAcceptedRepresentationByHash both
 * filter WHERE revoked_at IS NULL, and the table's own UNIQUE index on
 * canonical_sha256 is a PARTIAL index over the same condition — so once a
 * row is marked revoked, it stops participating in "first accepted sample
 * wins" matching AND stops occupying its canonical_sha256's uniqueness
 * slot, letting a later, independently authorized submission of the same
 * or overlapping content be evaluated fresh and become canonical in its
 * place. This module never sets revoked_at itself — it only ever reads it.
 * Nothing in this codebase sets it yet: accepted corpus content is durable
 * by policy (a consent change or report/account deletion never sets it —
 * see lib/corpus-admission-report-integration.ts's own header comment),
 * and this column is reserved for a future, explicitly admin-triggered
 * removal flow that has not been built.
 *
 * CONCURRENCY / IDEMPOTENCY STRATEGY (fixes the confirmed defect: family
 * resolution previously only checked the real corpus tables, which a real
 * ACCEPT never writes into, so two independent evaluations of the same new
 * content — sequential OR concurrent — could both reach ACCEPT):
 *
 *   1. A cheap, non-transactional PRE-CHECK (as before, extended to also
 *      query corpus_admission_accepted_representations/_shingles, not just
 *      the real corpus tables) rejects the common case — most candidates —
 *      without ever taking a write lock.
 *   2. Only when the pre-check finds no family match AND the tentative
 *      decision is ACCEPT does this module open a real SQLite write
 *      transaction (client.transaction("write")) and, INSIDE it, RE-CHECK
 *      both exact-hash and near-duplicate shingle containment against
 *      corpus_admission_accepted_representations/_shingles before
 *      inserting — closing the exact race window the pre-check alone
 *      cannot close.
 *   3. corpus_admission_accepted_representations.canonical_sha256 carries a
 *      DB-level UNIQUE constraint — the actual, ultimate atomicity
 *      primitive. Even if the in-transaction re-check somehow missed a
 *      genuine duplicate (it shouldn't, but defense in depth matters for a
 *      cross-process guarantee), the INSERT itself cannot violate
 *      uniqueness; a UNIQUE-constraint failure here is caught and treated
 *      as "lost the race," never rethrown as an internal error.
 *   4. SQLITE_BUSY (two write transactions genuinely colliding) is retried
 *      with backoff, opening a genuinely FRESH connection — via the
 *      caller-supplied openConnection factory — on every single attempt,
 *      never reusing one across a retry. Confirmed empirically (cross-
 *      process verification session) that retrying on the SAME connection
 *      does not reliably recover once truly separate OS processes contend
 *      for this local sqlite3 file — matching the pre-existing
 *      room-occupancy precedent in app/api/reports/route.ts
 *      (insertReportWithRoomCheck's own header comment: "only retrying with
 *      a fresh connection actually recovers it"). openConnection is
 *      REQUIRED whenever dryRun is not true (evaluateCorpusAdmissionCandidate
 *      and reEvaluateCorpusAdmissionCandidate both fail fast, before doing
 *      any extraction or DB work, if it is missing) — there is no fallback
 *      to reusing the caller's own `client` for this module's write paths,
 *      because that fallback is exactly what cross-process testing proved
 *      unsafe. Taking a factory rather than a raw URL keeps credentials
 *      (e.g. a remote database's auth token) at the caller's composition
 *      root; this module never constructs a connection string itself.
 *   5. dryRun===true performs ZERO database writes of any kind, including
 *      decision/audit rows — the CLI's own JSON report file is the sole
 *      dry-run record. Nothing durable exists for the atomic-dedup registry
 *      to protect during a dry run in the first place.
 */

/**
 * Caller-supplied, called to obtain a genuinely fresh database connection
 * for every write-retry attempt in the accept-transaction and decision-row
 * paths (see this module's own header comment, point 4). A factory rather
 * than a raw URL so credentials (e.g. a remote database's auth token) stay
 * at the caller's composition root — this module never constructs a
 * connection string itself. May return synchronously or a Promise; called
 * fresh on every attempt, never memoized here.
 */
export type CorpusAdmissionConnectionFactory = () => Client | Promise<Client>;

export type CorpusAdmissionDecisionRecord = {
  id: string;
  runId: string | null;
  sourceRef: string;
  policyVersion: string;
  decision: CorpusAdmissionDecision;
  reasonCodes: CorpusAdmissionReasonCode[];
  hardGatePassed: boolean;
  hardGateFailureCodes: CorpusHardGateCode[];
  detectedFormat: CorpusSupportedFormat | null;
  extractedWordCount: number | null;
  detectedLanguage: string | null;
  languageConfidence: number | null;
  canonicalSha256: string | null;
  extractorVersion: string | null;
  contentStoreId: string | null;
  /** Set exactly when a durable fingerprint row was written (a real, non-dry-run ACCEPT that won the race) or reused (re-evaluation). Null for REVIEW/REJECT, dry runs, and races this evaluation lost. */
  acceptedRepresentationId: string | null;
  qualityScore: number | null;
  qualityModelVersion: string | null;
  componentScores: CorpusQualityComponentScores | null;
  featureVector: CorpusFeatureVector | null;
  featureVectorVersion: string | null;
  corpusValueScore: number | null;
  corpusValueModelVersion: string | null;
  familyRelation: CorpusFamilyResolution["relation"];
  familyMatchedSourceRef: string | null;
  familyContainment: number | null;
  consentMetadata: CorpusConsentEvidence;
  dryRun: boolean;
  /**
   * The candidate's own shingle hashes (opaque hash strings only — never
   * raw text), present whenever canonical text was computed regardless of
   * decision. Exists so a batch caller (tools/corpus-admission-dry-run.ts)
   * can build an in-process "already ACCEPTed this run" registry for
   * in-batch family resolution without this module ever exposing raw
   * text — a hash set carries no more information than
   * corpus_document_shingles itself already would.
   */
  shingleHashes: Set<string> | null;
};

/** One entry in a caller-maintained, never-persisted in-batch registry (tools/corpus-admission-dry-run.ts) — see CorpusAdmissionDecisionRecord.shingleHashes for why only hashes, never text, cross this boundary. */
export type CorpusInBatchFamilyEntry = { sourceRef: string; canonicalSha256: string; wordCount: number; shingleHashes: Set<string> };

/** Minimal structural interface satisfied by both @libsql/client's Client and Transaction — every query in this module only ever needs `.execute({sql, args})`, so family-lookup helpers can run against either a plain connection (pre-check) or an open write transaction (in-transaction re-check) without duplicating the query logic. */
type SqlExecutor = { execute(stmt: InStatement): Promise<ResultSet> };

export const CORPUS_ADMISSION_FINGERPRINT_VERSION = "corpus-admission-accepted-shingle-v1";

type InternalEvaluationInput = {
  sourceRef: string;
  runId: string | null;
  fileValidation: CorpusFileValidationResult;
  extraction: CorpusExtractionResult | null;
  consent: CorpusConsentEvidence;
  dryRun: boolean;
  inBatchFamilyCandidates: CorpusInBatchFamilyEntry[];
  limits: CorpusAdmissionLimits;
  /** Set only by reEvaluateCorpusAdmissionCandidate — an already-existing content-store row to reuse (never re-written, never duplicated) if this evaluation still ends in ACCEPT with resolved retention. */
  existingContentStoreId: string | null;
  /** Set only by reEvaluateCorpusAdmissionCandidate — an already-existing accepted-representation row (same canonical_sha256) to reuse rather than attempting a fresh insert, which would otherwise collide with the row this same content already owns. */
  existingAcceptedRepresentationId: string | null;
  /** Required whenever dryRun is false — validated by a fail-fast check in the public entry functions before this type is ever constructed. Null only ever occurs on the dryRun===true path, which never reads this field. */
  openConnection: CorpusAdmissionConnectionFactory | null;
};

function sharedHashCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const hash of smaller) if (larger.has(hash)) shared += 1;
  return shared;
}

function retentionResolvedFor(consent: CorpusConsentEvidence): boolean {
  return consent.kind === "PER_USER_CONSENT" ? consent.consented === true : consent.provenance.retentionRightsResolved === true;
}

function retentionBasisFor(consent: CorpusConsentEvidence): string {
  return consent.kind === "PER_USER_CONSENT" ? "CONSENT_GRANTED" : consent.provenance.retentionBasis;
}

function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}

function isAcceptedHashUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /SQLITE_CONSTRAINT/i.test(err.message) && /ux_corpus_admission_accepted_representations_canonical_sha256|corpus_admission_accepted_representations\.canonical_sha256/i.test(err.message);
}

/**
 * Deterministic upper bound on how many accepted-representation family
 * candidates findAcceptedFamilyCandidates returns (C-3). Matches the default
 * `limit` of its real-corpus sibling findCandidateCorpusRepresentations
 * (lib/user-submission-corpus.ts): computeEvaluationCore concatenates the
 * two candidate lists into one familyCandidates array and consumes them
 * identically. resolveCorpusArticleFamily (lib/corpus-admission-family.ts)
 * only ever acts on the single candidate that matters — the exact-canonical-
 * hash one, or the highest ACTUAL containment among LENGTH-COMPATIBLE ones.
 * findAcceptedFamilyCandidates computes actual containment for the whole
 * family-relevant set (exact-hash + every length-compatible row — see its
 * step 1b) and only THEN ranks and caps at 50, by exactly that priority
 * (step 3): exact hash, length-compatibility, actual containment, raw
 * shared, id. Nothing correctness-affecting is truncated before containment
 * is known, so a length-incompatible candidate the resolver would discard
 * can never evict a length-compatible one it would act on — no matter how
 * many unrelated large documents embed the submission's text.
 */
export const MAX_ACCEPTED_FAMILY_CANDIDATES = 50;

/** libSQL/SQLite bind at most 32,766 parameters per statement; a large submission can exceed that in informative shingles alone, so every shingle-hash / representation-id IN(...) list below is chunked (C-2). */
const ACCEPTED_SHINGLE_IN_CHUNK_SIZE = 20_000;

/**
 * Queries corpus_admission_accepted_representations/_shingles for exact and
 * near-duplicate family candidates — the durable, cross-process analog of
 * findCandidateCorpusRepresentations (lib/user-submission-corpus.ts),
 * scoped to this feature's own staging registry rather than the real
 * corpus. Accepts either a plain Client (the non-transactional pre-check)
 * or an open Transaction (the in-transaction re-check) via the shared
 * SqlExecutor shape, so the exact same query logic backs both.
 *
 * C-2/C-3 hardening. Every SQL IN(...) list is chunked so a submission with
 * more informative shingles than SQLite's 32,766 SQLITE_MAX_VARIABLE_NUMBER
 * can never throw "too many SQL variables":
 *   1. shared-shingle COUNT per accepted representation (chunked over the
 *      submission's shingle hashes; each representation's count summed
 *      across every chunk).
 *   1b. FAMILY-RELEVANT partition — keep only the rows resolveCorpusArticleFamily
 *      can actually act on: the exact-canonical-hash row (EXACT_DUPLICATE)
 *      plus every LENGTH-COMPATIBLE row (the only rows eligible for
 *      EDITED_VERSION — the resolver itself `continue`s past every
 *      length-incompatible one). Both tests use step-1 data only
 *      (canonical_sha256, word_count). This is the provably-safe bound the
 *      removed raw-shared pre-cap was not: it can never drop an
 *      EXACT_DUPLICATE or any EDITED_VERSION-capable candidate, no matter
 *      how many unrelated much-larger documents embed the submission's text
 *      (measured: computing ACTUAL containment for every one of ~2.5k
 *      matching representations / ~10M shingle rows took ~17s).
 *   2. total shingle COUNT per family-relevant candidate (chunked), giving
 *      each its ACTUAL containment.
 *   3. rank by exactly the priority resolveCorpusArticleFamily itself
 *      applies — exact canonical hash, then length-compatibility (its own
 *      lengthCompatibilityFloor), then actual containment DESC, then raw
 *      shared DESC, then id ASC — and take the top MAX_ACCEPTED_FAMILY_CANDIDATES.
 *
 * Returns BOTH:
 *   - candidates: the family-relevant top-50, for resolveCorpusArticleFamily.
 *   - corpusValueContainmentLowerBound: a PROVEN lower bound on the true
 *     max containment across EVERY matching accepted representation
 *     (length-incompatible ones included), for computeEvaluationCore's
 *     bestContainmentAgainstCorpus -> computeCorpusValueScore. It is
 *     `max over all matching reps of  shared_rep / min(targetCount, word_count_rep - 4)`
 *     — `word_count_rep - 4` is the exact number of 5-gram positions in the
 *     representation's text and is therefore a proven upper bound on its
 *     distinct informative shingle count, so this quotient can never exceed
 *     the representation's real containment. Computed from step-1 data only
 *     (cheap). It is EXACT whenever the dominating representation's
 *     informative-shingle density is ~1 (which includes exact/near-exact
 *     containment and every representation at least as large as the
 *     submission); it can under-shoot only for a length-incompatible
 *     representation that is word-count-large but informative-shingle-sparse
 *     (heavy tables/references/boilerplate) AND only moderately contained
 *     (~0.5-0.7) — in which case a pre-change REVIEW (LOW_CORPUS_VALUE) may
 *     become an ACCEPT. It never over-estimates, so it never produces a
 *     spurious REVIEW. Exact preservation would require the ~17s
 *     all-representation total-shingle scan above.
 *
 * `target` (the submission's own word count + canonical hash) is supplied
 * by every production call site; when omitted (defensive/legacy callers)
 * the family-relevant partition keeps everything and the ranking falls back
 * to actual-containment-then-shared with no length awareness — still never
 * the pre-C-3 unbounded IN(...) behavior. corpusValueContainmentLowerBound
 * needs no target.
 *
 * Exported for regression testing only — same convention as
 * _runThroughAcceptSerializationQueueForTesting / CORPUS_ADMISSION_FINGERPRINT_VERSION.
 */
export type FindAcceptedFamilyCandidatesResult = {
  candidates: CorpusFamilyCandidate[];
  corpusValueContainmentLowerBound: number;
};

export async function findAcceptedFamilyCandidates(
  exec: SqlExecutor,
  shingleHashes: Set<string>,
  /** Excludes one accepted-representation id from the results — set to a candidate's own existing row during re-evaluation, so it is never treated as a duplicate of itself. */
  excludeAcceptedRepresentationId: string | null = null,
  target?: { wordCount: number; canonicalSha256: string },
): Promise<FindAcceptedFamilyCandidatesResult> {
  const EMPTY: FindAcceptedFamilyCandidatesResult = { candidates: [], corpusValueContainmentLowerBound: 0 };
  if (shingleHashes.size === 0) return EMPTY;
  const hashList = [...shingleHashes];
  const targetCount = shingleHashes.size;

  type SharedRow = { id: string; shared: number; canonicalSha256: string; wordCount: number; sourceRef: string };
  type RawRow = { id: string; shared: number | bigint; canonical_sha256: string; word_count: number | bigint; source_ref: string };

  // --- Step 1: shared-shingle COUNT per accepted representation ------------
  const sharedById = new Map<string, SharedRow>();
  for (let offset = 0; offset < hashList.length; offset += ACCEPTED_SHINGLE_IN_CHUNK_SIZE) {
    const chunk = hashList.slice(offset, offset + ACCEPTED_SHINGLE_IN_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const res = await exec.execute({
      sql: `SELECT s.accepted_representation_id AS id, COUNT(*) AS shared, r.canonical_sha256 AS canonical_sha256, r.word_count AS word_count, d.source_ref AS source_ref
            FROM corpus_admission_accepted_shingles s
            JOIN corpus_admission_accepted_representations r ON r.id = s.accepted_representation_id
            JOIN corpus_admission_decisions d ON d.id = r.decision_id
            WHERE s.fingerprint_version = ? AND s.shingle_hash IN (${placeholders})
              AND (? IS NULL OR s.accepted_representation_id != ?)
              AND r.revoked_at IS NULL
            GROUP BY s.accepted_representation_id`,
      args: [CORPUS_ADMISSION_FINGERPRINT_VERSION, ...chunk, excludeAcceptedRepresentationId, excludeAcceptedRepresentationId],
    });
    for (const raw of res.rows as unknown as RawRow[]) {
      const prior = sharedById.get(raw.id);
      if (prior) prior.shared += Number(raw.shared);
      else sharedById.set(raw.id, { id: raw.id, shared: Number(raw.shared), canonicalSha256: raw.canonical_sha256, wordCount: Number(raw.word_count), sourceRef: raw.source_ref });
    }
  }
  if (sharedById.size === 0) return EMPTY;

  // --- corpus-value: proven containment lower bound over EVERY matching rep,
  // any length (step-1 data only) — see this function's own header comment.
  // containment(shared, targetCount, word_count - 4) uses `word_count - 4`
  // (the exact 5-gram position count = proven upper bound on the rep's
  // distinct informative shingle count) as the source-side denominator, so
  // the result never exceeds the rep's true containment.
  let corpusValueContainmentLowerBound = 0;
  for (const row of sharedById.values()) {
    const lb = containment(row.shared, targetCount, Math.max(1, row.wordCount - 4));
    if (lb > corpusValueContainmentLowerBound) corpusValueContainmentLowerBound = lb;
  }

  // --- Family-relevant partition (mathematically safe pruning) ------------
  // resolveCorpusArticleFamily can ONLY act on a candidate that is either
  //   (a) the exact canonical-hash match  -> EXACT_DUPLICATE, or
  //   (b) LENGTH-COMPATIBLE with the submission AND has containment >= the
  //       edited-version floor  -> EDITED_VERSION.
  // Both (a) and (b)'s length gate are decidable from step-1 data alone
  // (canonical_sha256 and word_count are on every row). A length-incompatible
  // non-exact row is discarded by resolveCorpusArticleFamily's own
  // `isCorpusLengthCompatible(...) continue` — it can never change the family
  // decision no matter its containment — so it is dropped here BEFORE the
  // (potentially large) per-candidate total-shingle lookup. This is the
  // provably-safe bound the removed raw-shared pre-cap was not: it cannot
  // discard an EXACT_DUPLICATE or any EDITED_VERSION-capable candidate.
  //
  // Length-incompatible non-exact rows are dropped from `candidates` here
  // (they can never change resolveCorpusArticleFamily's result), but their
  // corpus-value contribution is preserved via corpusValueContainmentLowerBound
  // computed above — so computeEvaluationCore still sees them.
  const lengthFloor = DEFAULT_CORPUS_FAMILY_THRESHOLDS.lengthCompatibilityFloor.value;
  const familyRelevant = [...sharedById.values()].filter((row) =>
    !target ||
    row.canonicalSha256 === target.canonicalSha256 ||
    isCorpusLengthCompatible(target.wordCount, row.wordCount, lengthFloor),
  );
  if (familyRelevant.length === 0) return { candidates: [], corpusValueContainmentLowerBound };

  // --- Step 2: total shingle COUNT per family-relevant candidate, chunked -
  const relevantIds = familyRelevant.map((row) => row.id);
  const totalById = new Map<string, number>();
  for (let offset = 0; offset < relevantIds.length; offset += ACCEPTED_SHINGLE_IN_CHUNK_SIZE) {
    const chunk = relevantIds.slice(offset, offset + ACCEPTED_SHINGLE_IN_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const res = await exec.execute({
      sql: `SELECT accepted_representation_id AS id, COUNT(*) AS total
            FROM corpus_admission_accepted_shingles
            WHERE fingerprint_version = ? AND accepted_representation_id IN (${placeholders})
            GROUP BY accepted_representation_id`,
      args: [CORPUS_ADMISSION_FINGERPRINT_VERSION, ...chunk],
    });
    for (const row of res.rows as unknown as { id: string; total: number | bigint }[]) totalById.set(row.id, Number(row.total));
  }

  // --- Step 3: rank by resolveCorpusArticleFamily's own priority, then cap -
  const ranked = familyRelevant.map((row) => {
    const total = totalById.get(row.id) ?? 0;
    return {
      candidate: {
        sourceRef: row.sourceRef,
        canonicalSha256: row.canonicalSha256,
        wordCount: row.wordCount,
        containment: containment(row.shared, targetCount, total),
      } satisfies CorpusFamilyCandidate,
      id: row.id,
      shared: row.shared,
      exact: target ? row.canonicalSha256 === target.canonicalSha256 : false,
      lengthCompatible: target ? isCorpusLengthCompatible(target.wordCount, row.wordCount, lengthFloor) : true,
    };
  });

  ranked.sort((a, b) =>
    (b.exact ? 1 : 0) - (a.exact ? 1 : 0) ||
    (b.lengthCompatible ? 1 : 0) - (a.lengthCompatible ? 1 : 0) ||
    b.candidate.containment - a.candidate.containment ||
    b.shared - a.shared ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return {
    candidates: ranked.slice(0, MAX_ACCEPTED_FAMILY_CANDIDATES).map((r) => r.candidate),
    corpusValueContainmentLowerBound,
  };
}

/** Exact-hash-only lookup (no shingle scan needed) — used inside the write transaction as the first, cheapest re-check. */
async function findAcceptedRepresentationByHash(exec: SqlExecutor, canonicalSha256: string): Promise<{ id: string; decisionId: string; sourceRef: string } | null> {
  const result = await exec.execute({
    sql: `SELECT r.id AS id, r.decision_id AS decision_id, d.source_ref AS source_ref
          FROM corpus_admission_accepted_representations r
          JOIN corpus_admission_decisions d ON d.id = r.decision_id
          WHERE r.canonical_sha256 = ? AND r.revoked_at IS NULL`,
    args: [canonicalSha256],
  });
  const row = result.rows[0] as unknown as { id: string; decision_id: string; source_ref: string } | undefined;
  return row ? { id: row.id, decisionId: row.decision_id, sourceRef: row.source_ref } : null;
}

// ============================================================================
// Feature-vector / quality / hard-gate / pre-check family resolution
// (shared by every call site, transactional or not)
// ============================================================================

type EvaluationCore = {
  featureVector: CorpusFeatureVector | null;
  quality: CorpusQualityScoreResult | null;
  canonicalText: string | null;
  canonicalHash: string | null;
  ownShingleHashes: Set<string> | null;
  hardGate: ReturnType<typeof evaluateCorpusHardGates>;
  family: CorpusFamilyResolution;
  corpusValueScoreResult: ReturnType<typeof computeCorpusValueScore>;
  classification: ReturnType<typeof decideCorpusAdmission>;
};

async function computeEvaluationCore(client: Client, input: InternalEvaluationInput): Promise<EvaluationCore> {
  const { fileValidation, extraction } = input;

  let featureVector: CorpusFeatureVector | null = null;
  let quality: CorpusQualityScoreResult | null = null;
  let canonicalText: string | null = null;
  let canonicalHash: string | null = null;
  let ownShingleHashes: Set<string> | null = null;

  if (extraction && extraction.ok) {
    featureVector = computeCorpusFeatureVector(extraction.rawText);
    quality = computeCorpusQualityScore(featureVector);
    canonicalText = canonicalizeText(extraction.rawText);
    canonicalHash = canonicalSha256(extraction.rawText);
    ownShingleHashes = corpusShingleHashes(canonicalText);
  }

  const hardGate = evaluateCorpusHardGates({
    fileValidation,
    extraction,
    wordCount: featureVector?.linguisticQuality.wordCount ?? null,
    detectedLanguage: featureVector?.linguisticQuality.detectedLanguage ?? null,
    languageConfidence: featureVector?.linguisticQuality.languageConfidence ?? null,
    consent: input.consent,
  });

  let family: CorpusFamilyResolution = { relation: "NONE" };
  let bestContainmentAgainstCorpus: number | null = null;

  if (hardGate.passed && canonicalHash !== null && featureVector !== null && ownShingleHashes !== null) {
    const [realCandidates, accepted] = await Promise.all([
      ownShingleHashes.size > 0 ? findCandidateCorpusRepresentations(client, ownShingleHashes) : Promise.resolve([]),
      findAcceptedFamilyCandidates(client, ownShingleHashes, input.existingAcceptedRepresentationId, { wordCount: featureVector.linguisticQuality.wordCount, canonicalSha256: canonicalHash }),
    ]);
    const acceptedCandidates = accepted.candidates;
    const inBatchCandidates: CorpusFamilyCandidate[] = input.inBatchFamilyCandidates.map((entry) => ({
      sourceRef: entry.sourceRef,
      canonicalSha256: entry.canonicalSha256,
      wordCount: entry.wordCount,
      containment: containment(sharedHashCount(ownShingleHashes as Set<string>, entry.shingleHashes), (ownShingleHashes as Set<string>).size, entry.shingleHashes.size),
    }));
    const familyCandidates: CorpusFamilyCandidate[] = [
      ...realCandidates.map((r) => ({ sourceRef: r.representationId, canonicalSha256: r.canonicalSha256, wordCount: r.wordCount, containment: r.containment })),
      ...acceptedCandidates,
      ...inBatchCandidates,
    ];

    family = resolveCorpusArticleFamily({ canonicalSha256: canonicalHash, wordCount: featureVector.linguisticQuality.wordCount }, familyCandidates);
    // bestContainmentAgainstCorpus folds in findAcceptedFamilyCandidates'
    // corpusValueContainmentLowerBound — a proven lower bound on the true
    // max containment across EVERY matching accepted representation,
    // length-incompatible ones included (see that function's own header
    // comment for why the length-incompatible reps are absent from
    // `candidates` yet still accounted for here).
    const candidateMax = familyCandidates.length > 0 ? familyCandidates.reduce((max, c) => Math.max(max, c.containment), 0) : 0;
    const anyContribution = familyCandidates.length > 0 || accepted.corpusValueContainmentLowerBound > 0;
    bestContainmentAgainstCorpus = anyContribution ? Math.max(candidateMax, accepted.corpusValueContainmentLowerBound) : null;
  }

  const corpusValueScoreResult = computeCorpusValueScore(bestContainmentAgainstCorpus);
  const classification = decideCorpusAdmission({
    hardGate,
    format: fileValidation.ok ? fileValidation.format : null,
    family,
    quality,
    featureVector,
    corpusValueScore: corpusValueScoreResult.corpusValueScore,
  });

  return { featureVector, quality, canonicalText, canonicalHash, ownShingleHashes, hardGate, family, corpusValueScoreResult, classification };
}

function buildRecord(params: {
  id: string;
  input: InternalEvaluationInput;
  core: EvaluationCore;
  contentStoreId: string | null;
  acceptedRepresentationId: string | null;
  decisionOverride?: { decision: CorpusAdmissionDecision; reasonCodes: CorpusAdmissionReasonCode[]; family: CorpusFamilyResolution };
}): CorpusAdmissionDecisionRecord {
  const { input, core } = params;
  const decision = params.decisionOverride?.decision ?? core.classification.decision;
  const reasonCodes = params.decisionOverride?.reasonCodes ?? core.classification.reasonCodes;
  const family = params.decisionOverride?.family ?? core.family;
  const familyMatchedSourceRef = family.relation === "NONE" ? null : family.matchedSourceRef;
  const familyContainment = family.relation === "EDITED_VERSION" ? family.containment : null;

  return {
    id: params.id,
    runId: input.runId,
    sourceRef: input.sourceRef,
    policyVersion: core.classification.policyVersion,
    decision,
    reasonCodes,
    hardGatePassed: core.hardGate.passed,
    hardGateFailureCodes: core.hardGate.failureCodes,
    detectedFormat: input.fileValidation.ok ? input.fileValidation.format : null,
    extractedWordCount: core.featureVector?.linguisticQuality.wordCount ?? null,
    detectedLanguage: core.featureVector?.linguisticQuality.detectedLanguage ?? null,
    languageConfidence: core.featureVector?.linguisticQuality.languageConfidence ?? null,
    canonicalSha256: core.canonicalHash,
    extractorVersion: input.extraction?.ok ? input.extraction.extractorVersion : null,
    contentStoreId: params.contentStoreId,
    acceptedRepresentationId: params.acceptedRepresentationId,
    qualityScore: core.quality?.qualityScore ?? null,
    qualityModelVersion: core.quality?.qualityModelVersion ?? null,
    componentScores: core.quality?.componentScores ?? null,
    featureVector: core.featureVector,
    featureVectorVersion: core.featureVector?.featureVectorVersion ?? null,
    corpusValueScore: core.corpusValueScoreResult.corpusValueScore,
    corpusValueModelVersion: core.corpusValueScoreResult.corpusValueModelVersion,
    familyRelation: family.relation,
    familyMatchedSourceRef,
    familyContainment,
    consentMetadata: input.consent,
    dryRun: input.dryRun,
    shingleHashes: core.ownShingleHashes,
  };
}

async function insertDecisionRow(
  exec: SqlExecutor,
  decisionId: string,
  input: InternalEvaluationInput,
  core: EvaluationCore,
  contentStoreId: string | null,
  decisionOverride?: { decision: CorpusAdmissionDecision; reasonCodes: CorpusAdmissionReasonCode[]; family: CorpusFamilyResolution },
): Promise<void> {
  const decision = decisionOverride?.decision ?? core.classification.decision;
  const reasonCodes = decisionOverride?.reasonCodes ?? core.classification.reasonCodes;
  const family = decisionOverride?.family ?? core.family;
  const familyMatchedSourceRef = family.relation === "NONE" ? null : family.matchedSourceRef;
  const familyContainment = family.relation === "EDITED_VERSION" ? family.containment : null;

  await exec.execute({
    sql: `INSERT INTO corpus_admission_decisions
      (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
       detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
       content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
       corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
       consent_metadata, dry_run, created_at)
      VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,CURRENT_TIMESTAMP)`,
    args: [
      decisionId,
      input.runId,
      input.sourceRef,
      core.classification.policyVersion,
      decision,
      JSON.stringify(reasonCodes),
      core.hardGate.passed ? 1 : 0,
      JSON.stringify(core.hardGate.failureCodes),
      input.fileValidation.ok ? input.fileValidation.format : null,
      core.featureVector?.linguisticQuality.wordCount ?? null,
      core.featureVector?.linguisticQuality.detectedLanguage ?? null,
      core.featureVector?.linguisticQuality.languageConfidence ?? null,
      core.canonicalHash,
      input.extraction?.ok ? input.extraction.extractorVersion : null,
      contentStoreId,
      core.quality?.qualityScore ?? null,
      core.quality?.qualityModelVersion ?? null,
      core.quality ? JSON.stringify(core.quality.componentScores) : null,
      core.featureVector ? JSON.stringify(core.featureVector) : null,
      core.featureVector?.featureVectorVersion ?? null,
      core.corpusValueScoreResult.corpusValueScore,
      core.corpusValueScoreResult.corpusValueModelVersion,
      family.relation,
      familyMatchedSourceRef,
      familyContainment,
      JSON.stringify(input.consent),
      input.dryRun ? 1 : 0,
    ],
  });
}

const MAX_ACCEPT_BUSY_RETRIES = 10;

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
}

/**
 * In-process-only serialization for the accept-transaction critical section.
 * Confirmed empirically (this session): this project's local-file libSQL
 * driver does not reliably recover a losing concurrent WRITE transaction by
 * retrying on the same connection — even 25 retries with generous backoff
 * still hit SQLITE_BUSY on commit under N genuinely-concurrent, all-write
 * transactions in one process (the codebase's own lib/reports-db.ts header
 * comment documents the same underlying finding for a different feature:
 * "only retrying with a fresh connection actually recovers it"). Rather than
 * open a second connection per retry (this module only ever receives one
 * Client from its caller, with no portable way to derive a fresh connection
 * to the same database from it), same-process contention is eliminated at
 * the source: only one accept-transaction critical section ever runs at a
 * time per process. This is purely a same-process scheduling optimization —
 * it is NOT the mechanism that makes concurrent admission safe. Correctness
 * across processes (where this queue does not exist) still rests entirely on
 * the in-transaction re-check plus the database-level UNIQUE constraint on
 * accepted canonical_sha256, exactly as it would if this queue were deleted.
 */
let acceptSerializationQueue: Promise<unknown> = Promise.resolve();
function serializeAcceptCriticalSection<T>(fn: () => Promise<T>): Promise<T> {
  const result = acceptSerializationQueue.then(fn, fn);
  acceptSerializationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Test-only direct access to the same-process serialization queue, so its resilience to a failed critical section (the queue's continuation must always resolve, never propagate a rejection into the chain itself) can be proven directly rather than reproduced indirectly through a real DB failure. */
export function _runThroughAcceptSerializationQueueForTesting<T>(fn: () => Promise<T>): Promise<T> {
  return serializeAcceptCriticalSection(fn);
}

/**
 * The atomic phase — only entered when the pre-check found no family match
 * and the tentative decision is ACCEPT. Opens a real write transaction,
 * re-checks exact + near-duplicate family membership against
 * corpus_admission_accepted_representations/_shingles (item 5's "protect
 * concurrent near-duplicates, not only identical hashes"), and either
 * inserts the new accepted-representation + shingles + content-store +
 * decision rows atomically, or — if another request won the race, detected
 * either by the re-check query or by the UNIQUE-constraint insert failing —
 * returns a normal REJECT/*_ALREADY_REPRESENTED record referencing the
 * winner. Never throws for a lost race; only genuine unexpected DB errors
 * propagate.
 */
async function acceptWithAtomicDedup(input: InternalEvaluationInput, core: EvaluationCore): Promise<CorpusAdmissionDecisionRecord> {
  return serializeAcceptCriticalSection(() => acceptWithAtomicDedupCriticalSection(input, core));
}

/**
 * Confirmed empirically (cross-process verification session): retrying
 * client.transaction("write") on the SAME connection does not reliably
 * recover from SQLITE_BUSY once genuinely separate OS processes contend for
 * this local-file libSQL/SQLite database — observed both as BUSY on the
 * transaction's own first write statement and as "cannot commit transaction
 * - SQL statements in progress" at commit time, across independent
 * `node --import tsx` child processes racing real accept-transactions
 * against the same file. This exactly matches an already-documented finding
 * elsewhere in this codebase (lib/reports-db.ts's own header comment, from
 * insertReportWithRoomCheck's cross-request room-occupancy race: "only
 * retrying with a fresh connection actually recovers it"). input.openConnection
 * is required whenever this function is reachable at all (it is only ever
 * called on the dryRun===false path, and the public entry functions fail
 * fast before this point if it is missing) — every attempt below calls it
 * fresh and closes what it returns before the next attempt, never reusing a
 * connection across a BUSY retry, and never falling back to the plain
 * `client` parameter for its own write attempts (that fallback is exactly
 * what cross-process testing proved unsafe). This is a database-connection/
 * retry-strategy fix, not a lock: nothing here coordinates across attempts
 * or processes except the database itself (its file-level BEGIN IMMEDIATE
 * lock — see this module's own transaction-type documentation in
 * tests/corpus-admission-cross-process.test.mjs).
 */
async function acceptWithAtomicDedupCriticalSection(input: InternalEvaluationInput, core: EvaluationCore): Promise<CorpusAdmissionDecisionRecord> {
  const canonicalHash = core.canonicalHash as string;
  const canonicalText = core.canonicalText as string;
  const ownShingleHashes = core.ownShingleHashes as Set<string>;
  const wordCount = core.featureVector!.linguisticQuality.wordCount;
  const extraction = input.extraction!;
  const openConnection = input.openConnection;
  if (!openConnection) {
    throw new Error("acceptWithAtomicDedupCriticalSection: openConnection is required — this indicates an internal invariant was violated (a non-dry-run evaluation reached the accept path without one), not a caller error, since evaluateCorpusAdmissionCandidate/reEvaluateCorpusAdmissionCandidate must already have failed fast on this.");
  }

  for (let attempt = 1; attempt <= MAX_ACCEPT_BUSY_RETRIES; attempt += 1) {
    const activeClient: Client = await openConnection();
    await activeClient.execute("PRAGMA foreign_keys = ON");

    let tx: Transaction | undefined;
    try {
      tx = await activeClient.transaction("write");
    } catch (err) {
      activeClient.close();
      if (isSqliteBusyError(err) && attempt < MAX_ACCEPT_BUSY_RETRIES) {
        await backoff(attempt);
        continue;
      }
      throw err;
    }

    try {
      // Re-check INSIDE the transaction — closes the race window between
      // the pre-check and now. Skips this entirely (reuses the existing
      // row) when re-evaluating already-accepted content under its own
      // canonical hash.
      if (input.existingAcceptedRepresentationId === null) {
        const exactMatch = await findAcceptedRepresentationByHash(tx, canonicalHash);
        if (exactMatch) {
          await tx.rollback();
          const record = buildRecord({
            id: randomUUID(),
            input,
            core,
            contentStoreId: null,
            acceptedRepresentationId: null,
            decisionOverride: {
              decision: "REJECT",
              reasonCodes: ["DUPLICATE_ALREADY_REPRESENTED"],
              family: { relation: "EXACT_DUPLICATE", matchedSourceRef: exactMatch.sourceRef },
            },
          });
          await insertDecisionRow(activeClient, record.id, input, core, null, {
            decision: record.decision,
            reasonCodes: record.reasonCodes,
            family: { relation: "EXACT_DUPLICATE", matchedSourceRef: exactMatch.sourceRef },
          });
          return record;
        }

        // In-transaction re-check only needs the family verdict — corpus
        // value is never (re-)computed here — so the corpusValueContainmentLowerBound
        // half of the result is intentionally ignored.
        const { candidates: nearDupCandidates } = await findAcceptedFamilyCandidates(tx, ownShingleHashes, null, { wordCount, canonicalSha256: canonicalHash });
        const nearDupFamily = resolveCorpusArticleFamily({ canonicalSha256: canonicalHash, wordCount }, nearDupCandidates);
        if (nearDupFamily.relation === "EDITED_VERSION") {
          await tx.rollback();
          const record = buildRecord({
            id: randomUUID(),
            input,
            core,
            contentStoreId: null,
            acceptedRepresentationId: null,
            decisionOverride: { decision: "REJECT", reasonCodes: ["EDITED_VERSION_ALREADY_REPRESENTED"], family: nearDupFamily },
          });
          await insertDecisionRow(activeClient, record.id, input, core, null, {
            decision: record.decision,
            reasonCodes: record.reasonCodes,
            family: nearDupFamily,
          });
          return record;
        }
      }

      // IDs generated up front, decisions row inserted FIRST — both
      // corpus_admission_accepted_representations.decision_id and
      // corpus_admission_content_store.decision_id carry an enforced FK
      // back to it (unlike corpus_admission_decisions.content_store_id,
      // deliberately not FK-enforced for exactly this reason: it can
      // reference a content-store row that does not exist yet at insert
      // time).
      const decisionId = randomUUID();
      const acceptedRepresentationId = input.existingAcceptedRepresentationId ?? randomUUID();
      const retentionResolved = retentionResolvedFor(input.consent);
      const contentStoreId = input.existingContentStoreId ?? (retentionResolved ? randomUUID() : null);

      await insertDecisionRow(tx, decisionId, input, core, contentStoreId);

      if (input.existingAcceptedRepresentationId === null) {
        await tx.execute({
          sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, created_at)
                VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`,
          args: [acceptedRepresentationId, decisionId, canonicalHash, wordCount, CORPUS_ADMISSION_FINGERPRINT_VERSION],
        });
        // Bounded batches (CORPUS_SHINGLE_WRITE_BATCH_ROWS — see its own
        // comment): a very large accepted representation must not produce one
        // oversized batch() request. Every chunk is a tx.batch() on the open
        // accept-transaction, so the whole shingle write commits or rolls
        // back with the decision / accepted_representation rows exactly as a
        // single batch would. Rows are unique by construction (a fresh
        // acceptedRepresentationId + a Set of hashes), so plain INSERT is
        // kept; a rolled-back retry regenerates acceptedRepresentationId.
        const shingleHashList = [...ownShingleHashes];
        for (let offset = 0; offset < shingleHashList.length; offset += CORPUS_SHINGLE_WRITE_BATCH_ROWS) {
          const chunk = shingleHashList.slice(offset, offset + CORPUS_SHINGLE_WRITE_BATCH_ROWS);
          await tx.batch(chunk.map((hash) => ({
            sql: "INSERT INTO corpus_admission_accepted_shingles (accepted_representation_id, shingle_hash, fingerprint_version, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
            args: [acceptedRepresentationId, hash, CORPUS_ADMISSION_FINGERPRINT_VERSION],
          })));
        }
      }

      if (input.existingContentStoreId === null && contentStoreId !== null) {
        await tx.execute({
          sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
                VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
          args: [contentStoreId, decisionId, canonicalHash, canonicalText, extraction.ok ? extraction.extractorVersion : null, retentionBasisFor(input.consent)],
        });
      }

      await tx.commit();

      return buildRecord({ id: decisionId, input, core, contentStoreId, acceptedRepresentationId });
    } catch (err) {
      await tx.rollback().catch(() => {});

      if (isAcceptedHashUniqueViolation(err)) {
        // Lost the race at the very last moment — the re-check above
        // should normally catch this first, but the UNIQUE constraint is
        // the authoritative backstop for a cross-process guarantee. Look
        // up the actual winner (outside the aborted transaction) and
        // return a normal REJECT record referencing it — never rethrow.
        const winner = await findAcceptedRepresentationByHash(activeClient, canonicalHash);
        const record = buildRecord({
          id: randomUUID(),
          input,
          core,
          contentStoreId: null,
          acceptedRepresentationId: null,
          decisionOverride: {
            decision: "REJECT",
            reasonCodes: ["DUPLICATE_ALREADY_REPRESENTED"],
            family: { relation: "EXACT_DUPLICATE", matchedSourceRef: winner?.sourceRef ?? "unknown" },
          },
        });
        await insertDecisionRow(activeClient, record.id, input, core, null, {
          decision: record.decision,
          reasonCodes: record.reasonCodes,
          family: { relation: "EXACT_DUPLICATE", matchedSourceRef: winner?.sourceRef ?? "unknown" },
        });
        return record;
      }

      if (isSqliteBusyError(err) && attempt < MAX_ACCEPT_BUSY_RETRIES) {
        await backoff(attempt);
        continue;
      }
      throw err;
    } finally {
      tx?.close();
      activeClient.close();
    }
  }
  throw new Error("acceptWithAtomicDedup: exhausted retries without resolving");
}

/**
 * A non-ACCEPT decision row (REJECT/REVIEW straight from the pre-check, no
 * transaction involved) is still a single write against the same contended
 * database file — under real cross-process load it can hit SQLITE_BUSY just
 * as the accept transaction can. Gets the identical fresh-connection-per-
 * retry treatment as acceptWithAtomicDedupCriticalSection, for the same
 * reason (see that function's own comment) — openConnection is called fresh
 * on every attempt, with no fallback to any other connection.
 */
async function insertDecisionRowWithRetry(openConnection: CorpusAdmissionConnectionFactory, decisionId: string, input: InternalEvaluationInput, core: EvaluationCore, contentStoreId: string | null): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ACCEPT_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await openConnection();
    try {
      await attemptClient.execute("PRAGMA foreign_keys = ON");
      await insertDecisionRow(attemptClient, decisionId, input, core, contentStoreId);
      return;
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_ACCEPT_BUSY_RETRIES) {
        await backoff(attempt);
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }
}

async function runCorpusAdmissionEvaluation(client: Client, input: InternalEvaluationInput): Promise<CorpusAdmissionDecisionRecord> {
  const core = await computeEvaluationCore(client, input);

  // dry-run: zero database writes of any kind, including decision rows —
  // the CLI's own JSON report file is the sole dry-run record.
  if (input.dryRun) {
    return buildRecord({ id: randomUUID(), input, core, contentStoreId: null, acceptedRepresentationId: null });
  }

  if (!input.openConnection) {
    throw new Error("runCorpusAdmissionEvaluation: openConnection is required for a non-dry-run evaluation — this indicates an internal invariant was violated, since evaluateCorpusAdmissionCandidate/reEvaluateCorpusAdmissionCandidate must already have failed fast on this.");
  }

  if (core.classification.decision !== "ACCEPT") {
    const decisionId = randomUUID();
    await insertDecisionRowWithRetry(input.openConnection, decisionId, input, core, null);
    return buildRecord({ id: decisionId, input, core, contentStoreId: null, acceptedRepresentationId: null });
  }

  return acceptWithAtomicDedup(input, core);
}

export type EvaluateCorpusAdmissionCandidateParams = {
  sourceRef: string;
  runId?: string | null;
  filename: string;
  bytes: Buffer;
  consent: CorpusConsentEvidence;
  /** Required, no implicit default — every call site must state its intent explicitly. */
  dryRun: boolean;
  /** Candidates already ACCEPTed earlier in the same CLI batch (never persisted) — see tools/corpus-admission-dry-run.ts. Purely a performance optimization now that corpus_admission_accepted_representations provides a durable, cross-process guarantee; correctness no longer depends on this being supplied. */
  inBatchFamilyCandidates?: CorpusInBatchFamilyEntry[];
  limits?: CorpusAdmissionLimits;
  /**
   * REQUIRED whenever dryRun is not true — omitting it throws immediately,
   * before any file validation or extraction is attempted. See this
   * module's own header comment (point 4) and CorpusAdmissionConnectionFactory
   * for why there is no fallback to reusing `client` for this module's
   * write-retry paths: cross-process testing proved that fallback unsafe,
   * so it was removed rather than kept as a degraded default. Never called
   * at all during a dry run.
   */
  openConnection?: CorpusAdmissionConnectionFactory;
};

export async function evaluateCorpusAdmissionCandidate(
  client: Client,
  params: EvaluateCorpusAdmissionCandidateParams,
): Promise<CorpusAdmissionDecisionRecord> {
  if (params.dryRun !== true && !params.openConnection) {
    throw new Error(
      "evaluateCorpusAdmissionCandidate: openConnection is required whenever dryRun is not true. " +
        "Pass a factory that returns a fresh database connection (e.g. () => createClient({ url: ... })) " +
        "so write retries never depend on reusing a single connection, which is not safe across processes. " +
        "There is no fallback — pass dryRun:true instead if this evaluation genuinely need not write.",
    );
  }

  const limits = params.limits ?? DEFAULT_CORPUS_ADMISSION_LIMITS;
  const fileValidation = validateCorpusCandidateFile({ filename: params.filename, bytes: params.bytes }, limits);
  const extraction = fileValidation.ok ? await extractCorpusCandidateText(fileValidation.format, params.bytes, limits) : null;

  return runCorpusAdmissionEvaluation(client, {
    sourceRef: params.sourceRef,
    runId: params.runId ?? null,
    fileValidation,
    extraction,
    consent: params.consent,
    dryRun: params.dryRun,
    inBatchFamilyCandidates: params.inBatchFamilyCandidates ?? [],
    limits,
    existingContentStoreId: null,
    existingAcceptedRepresentationId: null,
    openConnection: params.openConnection ?? null,
  });
}

export type ReEvaluateCorpusAdmissionCandidateParams = {
  decisionId: string;
  runId?: string | null;
  /** Overrides the retained consent/provenance metadata for this re-evaluation; defaults to what the original decision recorded. */
  consent?: CorpusConsentEvidence;
  inBatchFamilyCandidates?: CorpusInBatchFamilyEntry[];
  limits?: CorpusAdmissionLimits;
  /** REQUIRED — reEvaluateCorpusAdmissionCandidate always runs with dryRun:false internally. See EvaluateCorpusAdmissionCandidateParams.openConnection. */
  openConnection: CorpusAdmissionConnectionFactory;
};

type RetainedCandidateRow = {
  source_ref: string;
  detected_format: string | null;
  consent_metadata: string;
  content_store_id: string;
  canonical_text: string;
  canonical_sha256: string;
  extractor_version: string | null;
  accepted_representation_id: string | null;
};

/**
 * Re-applies the (possibly newer) admission policy to an already-retained
 * candidate's canonical text WITHOUT calling the extractor again — reads
 * canonical_text from corpus_admission_content_store (never from
 * corpus_admission_decisions, which has no such column) and writes a NEW
 * decision row. Only reachable for a decision whose content was actually
 * retained (dryRun===false, ACCEPT, resolved retention at the time it was
 * first evaluated) — a decision with no content-store row cannot be
 * re-evaluated this way at all, by construction: this function throws
 * rather than silently falling back to anything.
 */
export async function reEvaluateCorpusAdmissionCandidate(
  client: Client,
  params: ReEvaluateCorpusAdmissionCandidateParams,
): Promise<CorpusAdmissionDecisionRecord> {
  if (!params.openConnection) {
    throw new Error(
      "reEvaluateCorpusAdmissionCandidate: openConnection is required — this function always evaluates with dryRun:false internally, so a fresh-connection factory for write retries must always be supplied. There is no fallback.",
    );
  }

  const limits = params.limits ?? DEFAULT_CORPUS_ADMISSION_LIMITS;

  const result = await client.execute({
    sql: `SELECT d.source_ref, d.detected_format, d.consent_metadata, d.content_store_id,
                 c.canonical_text, c.canonical_sha256, c.extractor_version,
                 ar.id AS accepted_representation_id
          FROM corpus_admission_decisions d
          JOIN corpus_admission_content_store c ON c.id = d.content_store_id
          LEFT JOIN corpus_admission_accepted_representations ar ON ar.canonical_sha256 = c.canonical_sha256
          WHERE d.id = ?`,
    args: [params.decisionId],
  });
  const row = result.rows[0] as unknown as RetainedCandidateRow | undefined;
  if (!row) {
    throw new Error(`reEvaluateCorpusAdmissionCandidate: no retained content found for decision ${params.decisionId} — this candidate was never accepted with resolved retention, or this is a dry-run decision, so it cannot be re-evaluated without re-extracting.`);
  }

  const fileValidation: CorpusFileValidationResult = { ok: true, format: row.detected_format as CorpusSupportedFormat };
  const extraction: CorpusExtractionResult = { ok: true, rawText: row.canonical_text, extractorVersion: row.extractor_version ?? "unknown" };
  const consent: CorpusConsentEvidence = params.consent ?? (JSON.parse(row.consent_metadata) as CorpusConsentEvidence);

  return runCorpusAdmissionEvaluation(client, {
    sourceRef: row.source_ref,
    runId: params.runId ?? null,
    fileValidation,
    extraction,
    consent,
    dryRun: false,
    inBatchFamilyCandidates: params.inBatchFamilyCandidates ?? [],
    limits,
    existingContentStoreId: row.content_store_id,
    existingAcceptedRepresentationId: row.accepted_representation_id,
    openConnection: params.openConnection,
  });
}
