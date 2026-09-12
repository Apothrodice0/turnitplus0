import {
  PMC_WINNOW_WINDOW,
  PMC_SHINGLE_SIZE,
  PMC_MIN_PERSISTED_DF,
  PMC_MAX_QUERY_FINGERPRINTS,
  PMC_STAGE_A_TOP_K,
  PMC_STAGE_A_MAX_POSTING_ROWS,
  PMC_STAGE_A_MAX_CANDIDATES,
} from "../pmc-coverage/constants";
import { DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../document-correspondence";

/**
 * Selective Corpus V1 SHADOW slice — frozen version constants and hard bounds.
 *
 * This slice is a SECOND instance of the PMC-coverage shadow pattern
 * (lib/pmc-coverage/) pointed at a different corpus. It differs in ONE way:
 * the artifact is a set of packed shard FILES on disk loaded from a
 * configurable path (lib/selective-corpus/config.ts), never a Turso table and
 * never a deployment-bundled asset — see storage-architecture.md.
 *
 * The Stage A fingerprint algorithm is byte-identical to PMC coverage's
 * (winnow w=15 over the production 5-gram hash stream), so the values are
 * re-exported from lib/pmc-coverage/constants.ts rather than re-declared —
 * a divergence there must not silently create a second calibration here.
 *
 * The Stage B admission pipeline is the one validated across the
 * mixed-fulltext-index / minority-evidence-admission / strict-span-family-final
 * / co-source-attribution benchmarks: the UNMODIFIED
 * lib/academic-search/comparator.ts compareSubmissionToExternalText, then
 * STRICT_SPAN, then FAMILY_GUARD, then co-source attribution. None of those
 * thresholds are tunable here.
 */

// ── Stage A (fingerprint discovery — NEVER scores) ─────────────────────────
export const SELECTIVE_CORPUS_WINNOW_WINDOW = PMC_WINNOW_WINDOW; // 15
export const SELECTIVE_CORPUS_SHINGLE_SIZE = PMC_SHINGLE_SIZE; // 5
export const SELECTIVE_CORPUS_STOP_DF = PMC_MIN_PERSISTED_DF; // 13 — global DF stop threshold
export const SELECTIVE_CORPUS_MAX_QUERY_FINGERPRINTS = PMC_MAX_QUERY_FINGERPRINTS; // 4096
export const SELECTIVE_CORPUS_STAGE_A_TOP_K = PMC_STAGE_A_TOP_K; // 20
export const SELECTIVE_CORPUS_STAGE_A_MAX_POSTING_ROWS = PMC_STAGE_A_MAX_POSTING_ROWS; // 60000
export const SELECTIVE_CORPUS_STAGE_A_MAX_CANDIDATES = PMC_STAGE_A_MAX_CANDIDATES; // 2000

/** Fingerprint namespace — distinct from PMC's so the two corpora's hashes
 *  never collide in a shared cache or diagnostic. Bump on any winnow/shingle
 *  change. */
export const SELECTIVE_CORPUS_FINGERPRINT_VERSION = "selective-corpus-fp-w15-s5-v1";

// ── Stage B admission (all FROZEN — see the benchmark chain) ───────────────
/** STRICT_SPAN evidence admission (minority-evidence-admission run, policy E). */
export const SELECTIVE_CORPUS_STRICT_SPAN = {
  minMatchedWords: 60,
  minLongestContiguousSpan: 25,
} as const;

/** FAMILY_GUARD — a dominant verified span repeated across >= 3 indexed docs is
 *  shared-family boilerplate and cannot by itself attribute the match to one
 *  source (strict-span-family-final run, frozen sha256 01deb1e0…). */
export const SELECTIVE_CORPUS_FAMILY_GUARD = {
  dominantSpanFamilyDocThreshold: 3,
  additionalSourceSpecificWords: 25,
  /** 0.6 — the existing lib/document-correspondence.ts strongContainmentThreshold. */
  spanContainmentFraction: DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.strongContainmentThreshold,
  stopFractionBoilerplate: 0.5,
  minSpanFingerprints: 3,
} as const;

/** Co-source span attribution (co-source-attribution run, rule sha256 ff3a4d00…).
 *  containmentSlackWords = the shingle size (edge fuzz of a match boundary). */
export const SELECTIVE_CORPUS_CO_SOURCE = {
  containmentSlackWords: SELECTIVE_CORPUS_SHINGLE_SIZE, // 5
  retainMinMatchedWords: 60,
  retainMinLongestSpan: 25,
} as const;

// ── Hard bounds on the whole deferred evaluation ──────────────────────────
/** Wall-clock budget. On expiry the shadow returns state "TIMEOUT" — it never
 *  throws into the report flow. */
export const SELECTIVE_CORPUS_TIME_BUDGET_MS = 6_000;

/** Candidate source texts held in the loader's LRU cache. Bounds RSS: the
 *  loader NEVER holds the whole 119 MB corpus. */
export const SELECTIVE_CORPUS_SOURCE_TEXT_LRU = 64;

/**
 * Hot packed shards held resident by the file-backed reader
 * (lib/selective-corpus/shard-reader.ts). At most this many shards' decoded
 * postings are in RAM at once — the packed index is NEVER fully deserialised.
 *
 * Default 128. Measured on the V1 9,443-doc / 256-shard artifact: a single
 * report's ~600 winnowed query fingerprints touch ≤ 128 distinct shards, so a
 * 128-shard LRU holds a whole report's working set with **no eviction** →
 * Stage A p95 ≈ 3.5 ms after the first report, ~38 MB resident. Smaller values
 * thrash (LRU 32 → p95 ~106 ms, 52 shard reads/report); 256 is identical to
 * 128 for V1 (never more than ~128 shards touched). At 100k docs the shard
 * count and per-report shard fan-out both grow — see storage-architecture.md.
 *
 * Overridable per process with SELECTIVE_CORPUS_HOT_SHARD_LRU (measurement).
 */
export const SELECTIVE_CORPUS_HOT_SHARD_LRU = (() => {
  const n = Number.parseInt(process.env.SELECTIVE_CORPUS_HOT_SHARD_LRU ?? "", 10);
  return Number.isFinite(n) && n >= 1 && n <= 256 ? n : 128;
})();

/** This shadow evaluator's own version — a diagnostic freshness key. */
export const SELECTIVE_CORPUS_SHADOW_EVALUATOR_VERSION = "selective-corpus-shadow-v1";

/**
 * Default cooldown before a TRANSIENT shard-read failure (see
 * shard-reader.ts's SelectiveCorpusShardFailureCode) may be retried. PERSISTENT
 * failure codes (MISSING / UNREADABLE / CORRUPT / INTEGRITY_MISMATCH) ignore
 * this entirely and are remembered for the reader's whole lifetime, unchanged
 * from before simulated-remote-storage support. Not currently reachable from
 * any real adapter (only the local filesystem adapter exists in production;
 * a remote-like adapter that can raise SelectiveCorpusTransientStorageError is
 * test-only, see lib/selective-corpus/testing/). Tests inject their own
 * clock + cooldown for determinism rather than waiting on a real timer.
 */
export const SELECTIVE_CORPUS_TRANSIENT_RETRY_COOLDOWN_MS = 2_000;

/**
 * The frozen corpus identity digest the artifact MUST carry BY DEFAULT. A
 * loaded corpus-version.json whose corpusIdentityDigest differs => the loader
 * fails closed with code "WRONG_DIGEST", UNLESS the caller explicitly passed
 * loadSelectiveCorpusArtifact()'s `expectedDigest` test/regression seam (see
 * artifact.ts) — which no production code path (shadow.ts's env-var-driven
 * local/vercel-blob branches) ever does. Bump only alongside a deliberately
 * re-validated corpus rebuild.
 *
 * This is the PRODUCTION-CLEAN "production-v1" build (9,234 bulk documents,
 * zero Track_C regression fixtures) — see build-report.json under
 * D:/TurnitPlusTemp/selective-corpus-production-v1/run-20260912-023011/.
 */
export const SELECTIVE_CORPUS_EXPECTED_DIGEST =
  "4fcfdd6fbc25f133d376fb9bdecc5a48a3f703c357406710bd40bed389efccd6";

/**
 * The OLDER "bulk-v1" dev/regression digest — a fixture-INCLUSIVE build (9,211
 * bulk + 232 Track_C regression fixture documents) still used deliberately by
 * Track_C/regression tests that need the fixture population resolvable via
 * SELECTIVE_CORPUS_FIXTURE_PATH. Reachable ONLY by tests that pass it as
 * loadSelectiveCorpusArtifact()'s explicit `expectedDigest` option — never by
 * an environment variable, user input, or any Vercel Blob production code
 * path. NOT the production expected digest.
 */
export const SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST =
  "5a234fa33fa9403059a14726bb169703444614c3aca7bb08fb20d37f6646581a";

export const SELECTIVE_CORPUS_VERSION = "selective-corpus-v1";
