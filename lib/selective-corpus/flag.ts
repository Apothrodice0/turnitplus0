/**
 * Selective Corpus V1 SHADOW slice — the single gate.
 *
 * Read fresh on every call (no caching) so a flip takes effect without a
 * restart — the exact shape lib/pmc-coverage/flag.ts and
 * lib/archive-server-flag.ts use. Absent / anything but the exact string
 * "true" => OFF.
 *
 * OFF is an IMMEDIATE no-op: lib/selective-corpus/shadow.ts's
 * runSelectiveCorpusShadowEvaluation returns state "DISABLED" before it reads
 * the artifact path env var, opens a file, tokenises, or loads a shard.
 * Production scoring never depends on this being on — the authoritative
 * unifiedScore is byte-for-byte identical whether it is on or off.
 */
export function isSelectiveCorpusShadowEnabled(): boolean {
  return process.env.SELECTIVE_CORPUS_SHADOW_ENABLED === "true";
}

/**
 * Selective Corpus V4 AUTHORITATIVE promotion — the second, independent gate.
 * Read fresh on every call, same convention as isSelectiveCorpusShadowEnabled.
 * Default/unset/anything but the exact string "true" => OFF (no authoritative
 * V4 behavior of any kind — every existing report continues to score exactly
 * as it does today).
 *
 * Deliberately NEVER overloads SELECTIVE_CORPUS_SHADOW_ENABLED: that flag
 * governs whether the shadow evaluator runs *at all* (purely for telemetry);
 * this one governs whether an already-running evaluation's verified result is
 * additionally allowed to reach the authoritative unified-similarity
 * computation. See effectiveSelectiveCorpusAuthoritativeEnabled below for the
 * actual creation-time gate a report is scored against — this raw flag alone
 * is not sufficient, since authoritative mode requires the shadow evaluator to
 * genuinely run too.
 */
export function isSelectiveCorpusAuthoritativeEnabled(): boolean {
  return process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED === "true";
}

/**
 * The ONE creation-time gate a NEW report must be evaluated against to decide
 * whether it is created as authoritative-pending — see
 * app/api/reports/route.ts's own call site. Deliberately requires BOTH flags:
 * authoritative=true with shadow=false must never mark a report pending,
 * because nothing would ever be capable of actually running Stage A+B for it
 * (the ordinary shadow evaluator itself no-ops on shadow=false, and there
 * would be no verified evidence to ever finalize with) — that combination is
 * a configuration mismatch, not a valid pending state, and must fall back to
 * today's pre-V4 authoritative behavior with zero customer impact.
 *
 * This function's result must be evaluated exactly ONCE, at report-creation
 * time, and its outcome persisted (selectiveCorpusAuthoritativeStatus) rather
 * than re-derived later — a later deferred/recovery worker must never re-call
 * this function to decide policy for an already-pending report; it uses the
 * persisted marker plus requiredForAuthoritativePendingReport instead (see
 * lib/selective-corpus-authoritative.ts), specifically so a live flag flip
 * after creation can never strand or silently reinterpret an in-flight report.
 */
export function effectiveSelectiveCorpusAuthoritativeEnabled(): boolean {
  return isSelectiveCorpusAuthoritativeEnabled() && isSelectiveCorpusShadowEnabled();
}
