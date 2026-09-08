import type { ArchiveScoringMatchingParameters } from "../archive-similarity-scoring";

/**
 * PMC OA scholarly-coverage SHADOW slice — frozen version constants and hard
 * bounds. Everything the two-stage matcher and the deferred evaluator need to
 * stay deterministic, bounded, and independently re-versionable.
 *
 * Storage/loader decision: a Turso-backed dedicated PMC shadow corpus
 * (pmc_coverage_documents / pmc_document_fingerprints / pmc_hash_df_bands,
 * drizzle/0053) — no deployment-bundled asset, no cold-start bulk load, the
 * same slice-2B pattern the live 321-doc archive already uses. See DESIGN.md
 * under D:\TurnitPlusTemp\pmc-server-matcher\ for the validated prototype.
 */

/** Winnow-ALGORITHM generation for the Stage A fingerprint set. Bump on any
 *  change to window / shingle-size / hash / trim. Deliberately distinct from
 *  ARCHIVE_COMPACT_FINGERPRINT_VERSION (that is window 85 over the built-in
 *  archive) so the two corpora's fingerprint namespaces never collide. */
export const PMC_COMPACT_FINGERPRINT_VERSION = "pmc-compact-fp-w15-v1";

/** Schleimer/Wilkerson/Aiken winnow window over the production 5-gram hash
 *  stream. w=15 => density ~2/16, ~8x fewer postings than the full 5-gram
 *  index, and any verbatim run >= w+4 = 19 words shares >= 1 selected
 *  fingerprint. Validated end-to-end at recall@20 = 1.00 (>= 20 copied words)
 *  in the prototype. */
export const PMC_WINNOW_WINDOW = 15;

/** 5-gram size for every PMC index structure (fingerprints, DF bands, Stage B
 *  verification) — the shipped similarity shingle size. */
export const PMC_SHINGLE_SIZE = 5;

/** DF-POLICY generation for pmc_hash_df_bands. Bump on a threshold / bucketing
 *  change. Part of the table's primary key, so a policy change builds a new
 *  generation beside the old rows. Distinct from PMC_COMPACT_FINGERPRINT_VERSION. */
export const PMC_DF_BAND_POLICY_VERSION = "pmc-df-band-v1";

/** Exact DF is stored for MIN_PERSISTED_DF..PMC_DF_BAND_MAX; the overflow bucket
 *  means ">= PMC_DF_BAND_MAX + 1". Mirrors lib/archive-df-bands.ts. */
export const PMC_DF_BAND_MAX = 20;
export const PMC_DF_BAND_OVERFLOW_BUCKET = PMC_DF_BAND_MAX + 1; // 21
/** Persist a df-band row only for DF >= this. Ship value = the scorer's stop
 *  threshold (6) is well below 13, so every persisted row is unambiguously a
 *  stop hash and the 7..12 band is resolved by the scorer at scoring time (no
 *  FTS phrase index in phase 1). */
export const PMC_MIN_PERSISTED_DF = 13;

/**
 * Stage B matching parameters — the prototype's validated
 * risk-calibration.json (archive-v5 EXP2) values. Stage B IIS the UNMODIFIED
 * lib/archive-similarity-scoring.ts scoreAgainstArchive run over the <= 20
 * retrieved candidates; these are its matchingParameters. maximumDocumentFrequency
 * (6) is also the pmc_hash_df_bands stop threshold.
 */
export const PMC_MATCHING_PARAMETERS: Required<
  Pick<
    ArchiveScoringMatchingParameters,
    | "minimumMatchedWords"
    | "maximumDocumentFrequency"
    | "minimumSourceContribution"
    | "maximumContributingSources"
    | "sourceWeighting"
  >
> = {
  minimumMatchedWords: 5,
  maximumDocumentFrequency: 6,
  minimumSourceContribution: 0.25,
  maximumContributingSources: 10,
  sourceWeighting: "raw",
};

// ── Hard bounds ────────────────────────────────────────────────────────────

/** Stage A returns at most this many candidates to Stage B. The prototype's
 *  recall@20 = 1.00 (>= 20 words) / recall@5 = 1.00 (>= 50 words) was measured
 *  at exactly this K. */
export const PMC_STAGE_A_TOP_K = 20;

/** Explicit ceiling on winnowed submission fingerprints actually queried. A
 *  pathologically long submission is deterministically trimmed to its
 *  numerically-lowest-hash PMC_MAX_QUERY_FINGERPRINTS before any DB read. */
export const PMC_MAX_QUERY_FINGERPRINTS = 4096;

/** Winnowed submission fingerprints per `fingerprint_hash IN (...)` chunk. */
export const PMC_FINGERPRINT_QUERY_CHUNK = 400;

/** Defensive ceiling on total posting rows Stage A will tally in one
 *  evaluation. With the DF-band stop set removing every 5-gram of DF >= 13, a
 *  surviving query fingerprint fans out to at most ~12 documents, so this is
 *  never reached for the 1k-doc shadow slice — it bounds the scan if the corpus
 *  later grows. Exceeding it => status stays a real value, evaluation_truncated = 1. */
export const PMC_STAGE_A_MAX_POSTING_ROWS = 60_000;

/** Defensive ceiling on distinct candidate documents Stage A will hold in its
 *  tally map. Exceeding it => evaluation_truncated = 1 (top-K still taken from
 *  what was tallied). */
export const PMC_STAGE_A_MAX_CANDIDATES = 2_000;

/** Wall-clock budget for the whole deferred evaluation. On expiry the evaluator
 *  writes a FAILED row (error_code UNEXPECTED) and returns — it never throws
 *  into the report flow. */
export const PMC_EVALUATOR_TIME_BUDGET_MS = 4_000;

/** Cooldown before a FAILED row is retried on a later report view — frozen in
 *  code, no env var. Mirrors lib/corpus-duplicate-suppression-shadow.ts. */
export const PMC_FAILED_RETRY_COOLDOWN_SQL = "-15 minutes";

/** The deferred PMC coverage evaluator's own version — the UPSERT conflict key
 *  alongside report_id. Bump to force a full re-evaluation of every row. */
export const PMC_COVERAGE_SHADOW_EVALUATOR_VERSION = "pmc-coverage-shadow-v1";
