/**
 * PMC OA scholarly-coverage SHADOW slice — the single gate.
 *
 * Read fresh on every call (no caching) so a flip takes effect without a
 * restart — the exact shape lib/archive-server-flag.ts's isArchiveServerSideEnabled()
 * uses. Absent / anything but the exact string "true" => OFF.
 *
 * OFF is an IMMEDIATE no-op: lib/pmc-coverage-shadow.ts's
 * runPmcCoverageShadowEvaluation returns before opening a connection, running a
 * query, tokenizing, or touching pmc_coverage_shadow_evaluations. Production
 * scoring never depends on this being on — the authoritative
 * unifiedSimilarity.unifiedScore is identical whether it is on or off.
 */
export function isPmcCoverageShadowEnabled(): boolean {
  return process.env.PMC_COVERAGE_SHADOW_ENABLED === "true";
}
