/**
 * Selective Corpus V1 SHADOW slice — artifact location config.
 *
 * LOCAL DEVELOPMENT / TESTING ONLY. There is NO hard-coded personal absolute
 * path in product code — the path is injected through an env var, and every
 * consumer (lib/selective-corpus/artifact.ts, shadow.ts) treats a missing path
 * as "shadow corpus unavailable" and continues normally.
 *
 * Production storage is deliberately NOT wired here — see
 * storage-architecture.md for the object-store / cache design that keeps the
 * 26 MB packed index and 119 MB source text out of the Vercel deployment.
 */

/** Directory containing corpus-version.json, packed/ (256 shards + docmap.tsv
 *  + stopset.bin) and raw/. null => shadow corpus unavailable. */
export function getSelectiveCorpusArtifactPath(): string | null {
  const p = process.env.SELECTIVE_CORPUS_ARTIFACT_PATH;
  return p && p.trim().length > 0 ? p.trim() : null;
}

/** Optional extra directory for regression FIXTURE source texts (prior
 *  selective-corpus-v1 families/<fam>/<docId>.txt). Only consulted when a
 *  docmap rawId begins "fixture:". null in every non-regression context. */
export function getSelectiveCorpusFixturePath(): string | null {
  const p = process.env.SELECTIVE_CORPUS_FIXTURE_PATH;
  return p && p.trim().length > 0 ? p.trim() : null;
}

/** Optional local directory for shadow diagnostics JSON. null => the shadow
 *  computes its result object and returns it WITHOUT writing anything (the
 *  production shape — no DB, no file). Set only in local dev/regression. */
export function getSelectiveCorpusDiagnosticsDir(): string | null {
  const p = process.env.SELECTIVE_CORPUS_DIAGNOSTICS_DIR;
  return p && p.trim().length > 0 ? p.trim() : null;
}

export type SelectiveCorpusStorageMode = "local" | "vercel-blob";

/**
 * Runtime storage-mode selector. "vercel-blob" ONLY on the exact literal
 * match; absent, "local", or any typo/unrecognized value preserves today's
 * LOCAL default exactly — the same fail-safe-default convention
 * lib/selective-corpus/flag.ts uses ("anything but the exact string => the
 * safe default"). Selecting "vercel-blob" here does not by itself do
 * anything — see shadow.ts, which additionally requires
 * getSelectiveCorpusBlobPrefix() and always loads with
 * integrityMode: "integrity-required" in that mode; it never silently falls
 * back to local storage if the Blob configuration is incomplete.
 */
export function getSelectiveCorpusStorageMode(): SelectiveCorpusStorageMode {
  return process.env.SELECTIVE_CORPUS_STORAGE_MODE === "vercel-blob" ? "vercel-blob" : "local";
}

/** Fixed, server-configured corpus prefix for vercel-blob mode (e.g.
 *  "selective-corpus/v1") — never derived from user/manuscript input. null
 *  when unset/blank; a caller in vercel-blob mode must treat that as a
 *  fail-closed misconfiguration (ARTIFACT_UNAVAILABLE), never a silent
 *  fallback to local storage. */
export function getSelectiveCorpusBlobPrefix(): string | null {
  const p = process.env.SELECTIVE_CORPUS_BLOB_PREFIX;
  return p && p.trim().length > 0 ? p.trim() : null;
}
