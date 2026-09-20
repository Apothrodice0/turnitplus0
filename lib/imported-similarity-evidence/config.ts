import { readFileSync } from "node:fs";
import {
  validateImportedSimilarityEvidencePackage,
  type ImportedSimilarityEvidencePackage,
  type RejectedUnit,
} from "./package";

/**
 * Internal-only configuration for the imported-similarity-evidence channel.
 * No customer-facing setting exists or is planned — this is a server
 * environment variable naming an external, versioned package file (see
 * ./package.ts), following the same null-collapsing "unset/blank -> null,
 * never throw" convention lib/selective-corpus/config.ts already uses for
 * its own data-root path getters.
 */
const PACKAGE_PATH_ENV_VAR = "IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH";

export function importedSimilarityEvidencePackagePath(): string | null {
  const value = process.env[PACKAGE_PATH_ENV_VAR];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
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

export function resetImportedSimilarityEvidencePackageCacheForTest(): void {
  cache = null;
}
