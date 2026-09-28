// Type-only bridge from lib/corpus-admission-archive-explorer.ts to the
// "use client" explorer components. `export type` is erased at build time,
// so no server module (node:crypto via lib/user-submission-corpus.ts) is ever
// bundled into the client — only the shapes the admin API routes serialize.
// Kept on ONE line so tests/corpus-admission-privacy.test.mjs's import scan sees it.
export type { ArchiveExplorerActivityEvent, ArchiveExplorerActivityKind, ArchiveExplorerCardMetrics, ArchiveExplorerDetail, ArchiveExplorerFacets, ArchiveExplorerGrowthDay, ArchiveExplorerListResult, ArchiveExplorerListRow, ArchiveExplorerSort, ArchiveExplorerSourceClass, ArchiveExplorerState, ArchiveExplorerSummary } from "@/lib/corpus-admission-archive-explorer";
