/**
 * 100k-scale architecture, slice 2E — the single server-side gate for routing
 * real document-analysis archive matching through the server DB-backed matcher
 * (lib/archive-corpus-matching.ts via lib/archive-server-analysis.ts /
 * app/api/archive/match) instead of the browser's static packed index
 * (app/similarity-worker.ts).
 *
 * Read fresh on every call (no caching) so a flag flip takes effect without a
 * restart — the exact shape lib/corpus-source-matching-flag.ts /
 * lib/archive-cosource.ts's isArchiveCosourceExpansionEnabled() already use.
 * Absent / anything but the exact string "true" => OFF (the browser worker
 * stays the engine).
 *
 * Deliberately its own tiny file, never re-exported from the server analysis
 * module: the browser runtime switch (lib/archive-analysis-runtime.ts) must
 * learn this ONLY through GET /api/archive/match, never by importing anything
 * that reads process.env.
 */
export function isArchiveServerSideEnabled(): boolean {
  return process.env.ARCHIVE_SERVER_SIDE_ENABLED === "true";
}
