import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { isSelectiveCorpusShadowEnabled } from "./flag";
import { getSelectiveCorpusDiagnosticsDir } from "./config";
import { runSelectiveCorpusShadow } from "./shadow";
import { logSelectiveCorpusShadowTelemetry } from "./shadow-telemetry";
import type { UnifiedSimilarityResult } from "../unified-similarity";
import type { SelectiveCorpusShadowResult } from "./types";

/**
 * Selective Corpus V1 SHADOW slice — the deferred evaluator entry point,
 * called from lib/report-shadow-evaluations.ts alongside the PMC-coverage
 * shadow.
 *
 * IMMEDIATE no-op unless SELECTIVE_CORPUS_SHADOW_ENABLED === "true": returns
 * before reading the artifact-path env var, opening a file, or tokenising.
 * When on, runs the shadow mechanism and — FOR LOCAL DEVELOPMENT ONLY — writes
 * a bounded diagnostics JSON if SELECTIVE_CORPUS_DIAGNOSTICS_DIR is set. There
 * is NO DB read or write here: this slice's telemetry sink is a local file,
 * never a migration.
 *
 * PRODUCTION TELEMETRY: exactly one structured "selective_corpus_shadow"
 * event (see shadow-telemetry.ts) is logged per terminal result, covering
 * every state including DISABLED — this replaces the older PARTIAL-only,
 * reportId-bearing console.warn (reportId is deliberately not carried into
 * the new event; see shadow-telemetry.ts's privacy-allowlist rationale).
 *
 * NEVER THROWS.
 */
export async function runSelectiveCorpusShadowEvaluation(params: {
  reportId: string;
  rawText: string;
  authoritativeUnifiedSimilarity: UnifiedSimilarityResult | null;
  /**
   * AUTHORITATIVE PROMOTION — narrow internal bypass, threaded straight
   * through to runSelectiveCorpusShadow. See that function's own
   * RunSelectiveCorpusShadowParams doc comment for exactly what it does and
   * does not bypass, and which two callers may ever set it true (the
   * deferred finalizer and the recovery sweep, both in
   * lib/selective-corpus-authoritative.ts). Absent/false for every ordinary
   * caller — byte-identical to before this parameter existed.
   */
  requiredForAuthoritativePendingReport?: boolean;
}): Promise<SelectiveCorpusShadowResult> {
  if (!isSelectiveCorpusShadowEnabled() && !params.requiredForAuthoritativePendingReport) {
    const disabled: SelectiveCorpusShadowResult = { state: "DISABLED", evaluatorVersion: "selective-corpus-shadow-v1" };
    logSelectiveCorpusShadowTelemetry(disabled, 0);
    return disabled;
  }
  const tStart = performance.now();
  try {
    const result = await runSelectiveCorpusShadow({
      canonicalSubmissionText: params.rawText,
      authoritative: params.authoritativeUnifiedSimilarity
        ? {
            unifiedScore: params.authoritativeUnifiedSimilarity.unifiedScore,
            matchedPositions: params.authoritativeUnifiedSimilarity.matchedPositions,
          }
        : null,
      requiredForAuthoritativePendingReport: params.requiredForAuthoritativePendingReport,
    });
    logSelectiveCorpusShadowTelemetry(result, performance.now() - tStart);

    const dir = getSelectiveCorpusDiagnosticsDir();
    if (dir) {
      try {
        mkdirSync(dir, { recursive: true });
        // no personal identifiers, paths, hashes, or fingerprint data — only
        // the aggregate shadow result + an opaque report id.
        writeFileSync(
          join(dir, `${params.reportId}.selective-corpus-shadow.json`),
          JSON.stringify({ reportId: params.reportId, generatedAt: new Date().toISOString(), result }, null, 2),
        );
      } catch {
        /* diagnostics are best-effort — a write failure never affects anything */
      }
    }
    return result;
  } catch (err) {
    const failed: SelectiveCorpusShadowResult = {
      state: "FAILED",
      evaluatorVersion: "selective-corpus-shadow-v1",
      failureCode: "UNEXPECTED",
      failureMessage: err instanceof Error ? err.message : String(err),
    };
    logSelectiveCorpusShadowTelemetry(failed, performance.now() - tStart);
    return failed;
  }
}
