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
