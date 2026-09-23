import { existsSync, readFileSync } from "node:fs";
import {
  validateImportedSimilarityEvidencePackage,
  type ImportedSimilarityEvidencePackage,
  type RejectedUnit,
} from "./package";
import { IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH } from "./materialized-path";

/**
 * Internal-only configuration for the imported-similarity-evidence channel.
 * No customer-facing setting exists or is planned — this is a server
 * environment variable naming an external, versioned package file (see
 * ./package.ts), following the same null-collapsing "unset/blank -> null,
 * never throw" convention lib/selective-corpus/config.ts already uses for
 * its own data-root path getters.
 */
const PACKAGE_PATH_ENV_VAR = "IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH";

/**
 * Resolution order (hosted build-time materialization —
 * scripts/materialize-imported-similarity-evidence.mjs):
 *   1. An explicit IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH override — set
 *      unconditionally, e.g. for local development against a hand-placed
 *      file. Always wins, exactly as before this change.
 *   2. Otherwise, the fixed build-time-materialized path
 *      (./materialized-path.ts) — but ONLY when a file actually exists
 *      there. This is what lets a hosted deployment activate a package with
 *      just the two build-time pointer vars
 *      (IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY /
 *      _SHA256) and no separate runtime PATH var to keep in sync. Checking
 *      existence (not just "materialization was configured") means an
 *      unconfigured/failed materialization is indistinguishable from "no
 *      package" — never a path pointing at nothing.
 *   3. Otherwise null — today's exact no-package behavior, unchanged.
 * The extra existsSync() call only runs when the explicit override is
 * absent, mirrors the same "cheap enough to call unconditionally, no
 * caching" discipline this function already had.
 */
export function importedSimilarityEvidencePackagePath(): string | null {
  const explicit = process.env[PACKAGE_PATH_ENV_VAR];
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  if (existsSync(IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH)) {
    return IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH;
  }
  return null;
}

export function isImportedSimilarityEvidenceConfigured(): boolean {
  return importedSimilarityEvidencePackagePath() !== null;
}

export type ImportedSimilarityEvidenceLoadState =
  | { status: "not_configured" }
  | { status: "loaded"; package: ImportedSimilarityEvidencePackage; rejectedUnits: RejectedUnit[] }
  | { status: "failed"; reason: string };

// Process-lifetime memoization, keyed by the configured path — a real
// package load involves a filesystem read + full validation and every
// caller of resolvePrimarySimilaritySummary would otherwise pay that cost.
// Mirrors this codebase's existing per-process caching convention (e.g.
// lib/selective-corpus's artifact cache) rather than re-reading on every
// request; resetImportedSimilarityEvidencePackageCacheForTest() exists for
// tests that need to swap packages mid-run.
let cache: { path: string; state: ImportedSimilarityEvidenceLoadState } | null = null;

/**
 * Loads (or returns the cached load of) the configured package. NEVER
 * throws: any I/O error, JSON parse error, or validation failure collapses
 * to `{ status: "failed" }` — fail closed, no imported evidence scoring —
 * exactly like every other "absence is a normal outcome" stage of this
 * pipeline (see lib/report-primary-similarity.ts's own header comment for
 * the same discipline elsewhere in this codebase).
 */
export function loadImportedSimilarityEvidencePackage(): ImportedSimilarityEvidenceLoadState {
  const path = importedSimilarityEvidencePackagePath();
  if (!path) return { status: "not_configured" };
  if (cache && cache.path === path) return cache.state;

  let state: ImportedSimilarityEvidenceLoadState;
  try {
    const raw = JSON.parse(readImportedSimilarityEvidencePackageFile(path)) as unknown;
    const result = validateImportedSimilarityEvidencePackage(raw);
    state = result.ok
      ? { status: "loaded", package: result.package, rejectedUnits: result.rejectedUnits }
      : { status: "failed", reason: result.reason };
  } catch (err) {
    state = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  if (state.status === "failed") {
    console.error(
      `imported-similarity-evidence: package at "${path}" failed to load/validate (${state.reason}) — the imported evidence channel is disabled (fail closed, no score impact).`,
    );
  } else if (state.status === "loaded" && state.rejectedUnits.length > 0) {
    console.error(
      `imported-similarity-evidence: package at "${path}" loaded with ${state.rejectedUnits.length} rejected unit(s) — those units are excluded, the rest of the package still scores normally.`,
      state.rejectedUnits,
    );
  }
  cache = { path, state };
  return state;
}

/**
 * Reads the resolved package file's raw text for
 * loadImportedSimilarityEvidencePackage() below. Split into two call sites —
 * rather than one `readFileSync(path, "utf8")` on the generic resolved
 * `path` — so the hosted, build-materialized case keeps a literal reference
 * to IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH directly at its
 * own readFileSync call: the same statically-analyzable form the
 * existsSync() check above already uses without tripping Turbopack's
 * output-file-tracing warning ("Dynamic filesystem access causes tracing of
 * the whole project" — confirmed via a real Next 16.3.2 Turbopack build to
 * fire specifically when the fs call's argument is an opaque local variable
 * rather than a literal/imported-constant reference it can resolve). The
 * explicit-override branch stays genuinely dynamic (an arbitrary env-supplied
 * path) — expected, and scoped to local development only per this file's own
 * precedence-order comment above, never part of a hosted deployment, so it
 * needs no next.config.ts outputFileTracingIncludes entry and is safe to opt
 * out of tracing with the ignore-comment syntax Turbopack's own warning
 * documents.
 */
function readImportedSimilarityEvidencePackageFile(path: string): string {
  if (path === IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH) {
    return readFileSync(IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH, "utf8");
  }
  return readFileSync(/*turbopackIgnore: true*/ path, "utf8");
}

export function resetImportedSimilarityEvidencePackageCacheForTest(): void {
  cache = null;
}
