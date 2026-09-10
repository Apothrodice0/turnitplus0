import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSelectiveCorpusShadowEnabled } from "./flag";
import { getSelectiveCorpusDiagnosticsDir } from "./config";
import { runSelectiveCorpusShadow } from "./shadow";
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
 * NEVER THROWS.
 */
export async function runSelectiveCorpusShadowEvaluation(params: {
  reportId: string;
  rawText: string;
  authoritativeUnifiedSimilarity: UnifiedSimilarityResult | null;
}): Promise<SelectiveCorpusShadowResult> {
  if (!isSelectiveCorpusShadowEnabled()) {
    return { state: "DISABLED", evaluatorVersion: "selective-corpus-shadow-v1" };
  }
  try {
    const result = runSelectiveCorpusShadow({
      canonicalSubmissionText: params.rawText,
      authoritative: params.authoritativeUnifiedSimilarity
        ? {
            unifiedScore: params.authoritativeUnifiedSimilarity.unifiedScore,
            matchedPositions: params.authoritativeUnifiedSimilarity.matchedPositions,
          }
        : null,
    });

    // PARTIAL means the packed artifact lost one or more shards AFTER it passed
    // initialization — the discovery index is now incomplete. Surface it in the
    // server log even when no diagnostics dir is configured, so the degradation
    // is not invisible (still telemetry-only — the authoritative score is
    // unaffected either way).
    if (result.state === "PARTIAL") {
      console.warn(
        `selective-corpus shadow: DEGRADED index for report=${params.reportId} — ${result.degradedDetail ?? "packed shards unavailable at query time"}`,
      );
    }

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
    return {
      state: "FAILED",
      evaluatorVersion: "selective-corpus-shadow-v1",
      failureCode: "UNEXPECTED",
      failureMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
