/**
 * R2 — the server-side gate for WRITING C2 compact persisted reports
 * (lib/report-persistence.ts): the compact `evidenceInterpretation` and the
 * compact `unifiedSimilarity.contributions`.
 *
 * WHY A WRITE GATE: application versions overlap during a rolling deploy and
 * share one Turso DB. A pre-C2 reader that meets a compact row does not
 * understand it. Reader support must therefore be deployed EVERYWHERE before any
 * compact row exists:
 *
 *   PHASE 1  deploy this code everywhere, flag OFF (the default) — every
 *            instance can READ legacy and compact/1, none WRITES compact/1.
 *   PHASE 2  once the whole fleet runs a compact-aware reader, set the flag to
 *            "true" — new persisted reports begin using compact/1.
 *   STOP     set it back to anything else — future writes are legacy again;
 *            rows already written compact stay readable by every current reader.
 *
 * This gate governs WRITES ONLY. The decoder (lib/report-persistence.ts) ALWAYS
 * understands legacy and compact/1, whatever this returns — turning the flag off
 * can never make an existing compact row unreadable. It does NOT make a pre-C2
 * binary understand rows already written compact: rolling the APPLICATION back to
 * a pre-C2 build after compact writes were enabled is not safe.
 *
 * Deliberately NOT gated (already shipped before C2, readable by the deployed
 * fleet): the older `previousUploadPositions` elision
 * (previousUploadPositionsEncoding, lib/unified-similarity-persistence.ts).
 *
 * Read fresh on every call (no caching), the exact shape
 * lib/archive-server-flag.ts / lib/corpus-source-matching-flag.ts use. Absent /
 * anything but the exact string "true" => OFF. Server-only, no customer UI, and
 * deliberately its own tiny file so nothing browser-side imports process.env.
 */
export const REPORT_COMPACT_PERSISTENCE_WRITE_FLAG = "REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED" as const;

export function isReportCompactPersistenceWriteEnabled(): boolean {
  return process.env.REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED === "true";
}

/**
 * The SECOND, independent write gate: compact matched-word POSITION arrays
 * (lib/position-runs-persistence.ts) — `unifiedSimilarity.matchedPositions` and
 * its per-channel subsets, and the report's `archiveMatchedPositions`.
 *
 * Its own flag, not REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED, for the very
 * reason that gate exists: that one is already open where the C2 readers are
 * deployed, and a build from before this codec does not understand a position
 * list that is not an array. The same two phases apply, separately:
 *
 *   PHASE 1  deploy this code everywhere, this flag OFF (the default) — every
 *            instance can READ arrays and compact positions, none WRITES them.
 *   PHASE 2  once no instance (and no rollback target) predates this reader,
 *            set the flag to "true".
 *   STOP     anything else — future writes are arrays again; rows already
 *            written compact stay readable by every current reader.
 *
 * WRITES ONLY, exactly like the gate above: the decoders always understand both
 * forms. Rolling the application back to a build without this reader after the
 * flag was on is not safe.
 */
export const REPORT_COMPACT_POSITIONS_WRITE_FLAG = "REPORT_COMPACT_POSITIONS_WRITE_ENABLED" as const;

export function isReportCompactPositionsWriteEnabled(): boolean {
  return process.env.REPORT_COMPACT_POSITIONS_WRITE_ENABLED === "true";
}

/**
 * Every persistence WRITE codec / boundary takes this optional override. Omitted
 * (the production case) means "whatever the flag says right now"; a caller that
 * measures a size and then writes (the authoritative finalizer) resolves it ONCE
 * and passes the same value to both, so what it measured is what it persists.
 * The two gates are resolved independently of each other.
 */
export type CompactPersistenceWriteOptions = {
  compactWrites?: boolean;
  compactPositions?: boolean;
};

export function resolveCompactPersistenceWrites(options?: CompactPersistenceWriteOptions): boolean {
  return options?.compactWrites ?? isReportCompactPersistenceWriteEnabled();
}

export function resolveCompactPositionWrites(options?: CompactPersistenceWriteOptions): boolean {
  return options?.compactPositions ?? isReportCompactPositionsWriteEnabled();
}
