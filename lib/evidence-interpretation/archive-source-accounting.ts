import type { SimilarityReport, SourceMatch } from "@/lib/report-types";

/**
 * GOLD GAP — how many verified Archive sources a report's Archive evidence
 * came from, and which words each listed one owns.
 *
 * The Archive scorer (lib/archive-similarity-scoring.ts) admits sources, scores
 * the union of their verified positions, and attributes every scored position
 * to exactly one admitted source (aggregateSimilaritySources). `report.sources`
 * lists at most the display cap of those sources, each with its attributed word
 * count, and — on reports made since this module — the attributed positions
 * themselves (`attributedRanges`) plus the number of contributing sources
 * (`archiveVerifiedSourceCount`). Those fields travel through the client like
 * `archiveMatchedPositions` does, so they are checked here against the report
 * before anything is shown:
 *
 *   "per-source" — every listed source has well-formed ranges inside the
 *                  Archive union, no position is listed under two sources, and
 *                  each source's range size equals its matchedWords. Each
 *                  listed source gets its own card with exactly its own words;
 *                  union words owned by unlisted (display-capped) sources go
 *                  to one "not listed individually" card.
 *   "aggregate"  — anything else with Archive positions (every report made
 *                  before attributedRanges existed): one Archive card holding
 *                  the union, named for the number of verified sources rather
 *                  than for one of them.
 *   "none"       — no Archive positions.
 *
 * Nothing here changes a matched position, the union, or the score.
 */

export type ArchiveListedSource = {
  name: string;
  type: SourceMatch["type"];
  /** sorted, distinct, inside the Archive union, owned by this source alone */
  positions: number[];
};

export type ArchiveSourceAccounting =
  | { mode: "none" }
  | {
      mode: "per-source";
      listed: ArchiveListedSource[];
      /** union positions owned by verified sources the display cap left out */
      unlistedPositions: number[];
      /** verified contributing sources, listed or not */
      verifiedSourceCount: number;
      /** false when the report does not say how many sources it left out: verifiedSourceCount is then a lower bound */
      verifiedSourceCountIsExact: boolean;
    }
  | {
      mode: "aggregate";
      unionPositions: number[];
      verifiedSourceCount: number;
      verifiedSourceCountIsExact: boolean;
    };

function archiveUnion(report: SimilarityReport): number[] {
  const wordCount = Number.isInteger(report.wordCount) && report.wordCount > 0 ? report.wordCount : 0;
  const positions = Array.isArray(report.archiveMatchedPositions) ? report.archiveMatchedPositions : [];
  return [...new Set(positions.filter((p) => Number.isInteger(p) && p >= 0 && (wordCount === 0 || p < wordCount)))].sort((a, b) => a - b);
}

function listedPositions(source: SourceMatch, union: ReadonlySet<number>, claimed: Set<number>): number[] | null {
  const ranges = source.attributedRanges;
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const positions: number[] = [];
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) return null;
    const [start, end] = range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
    if (positions.length + (end - start + 1) > union.size) return null;
    for (let p = start; p <= end; p += 1) {
      if (!union.has(p) || claimed.has(p)) return null;
      claimed.add(p);
      positions.push(p);
    }
  }
  if (source.matchedWords !== undefined && source.matchedWords !== positions.length) return null;
  return positions.sort((a, b) => a - b);
}

function reportedSourceCount(report: SimilarityReport): number | null {
  const count = report.archiveVerifiedSourceCount;
  return Number.isInteger(count) && (count as number) >= 0 ? (count as number) : null;
}

export function archiveSourceAccounting(report: SimilarityReport): ArchiveSourceAccounting {
  const union = archiveUnion(report);
  if (union.length === 0) return { mode: "none" };
  const sources = Array.isArray(report.sources) ? report.sources : [];
  const unionSet = new Set(union);
  const reported = reportedSourceCount(report);

  const claimed = new Set<number>();
  const listed: ArchiveListedSource[] = [];
  for (const source of sources) {
    const positions = listedPositions(source, unionSet, claimed);
    if (!positions) {
      listed.length = 0;
      break;
    }
    listed.push({ name: source.name, type: source.type, positions });
  }
  if (listed.length > 0 && listed.length === sources.length) {
    const unlistedPositions = union.filter((p) => !claimed.has(p));
    // Words outside every listed card belong to at least one more source.
    const minimum = listed.length + (unlistedPositions.length > 0 ? 1 : 0);
    const exact = reported !== null && reported >= minimum && (unlistedPositions.length > 0 || reported === listed.length);
    return {
      mode: "per-source",
      listed,
      unlistedPositions,
      verifiedSourceCount: exact ? (reported as number) : minimum,
      verifiedSourceCountIsExact: exact,
    };
  }

  // Aggregate: the listed names are verified sources, each with the words
  // attributed to it. When those add up to the union, every contributing
  // source is listed; when they fall short, at least one more contributed.
  const listedWords = sources.length > 0 && sources.every((s) => Number.isInteger(s.matchedWords))
    ? sources.reduce((total, s) => total + (s.matchedWords as number), 0)
    : null;
  let verifiedSourceCount = Math.max(1, sources.length);
  let verifiedSourceCountIsExact = false;
  if (reported !== null && reported >= verifiedSourceCount) {
    verifiedSourceCount = reported;
    verifiedSourceCountIsExact = true;
  } else if (listedWords !== null && listedWords === union.length) {
    verifiedSourceCountIsExact = true;
  } else if (listedWords !== null && listedWords < union.length) {
    verifiedSourceCount = sources.length + 1;
  }
  return { mode: "aggregate", unionPositions: union, verifiedSourceCount, verifiedSourceCountIsExact };
}

/** "10 verified Archive sources" / "at least 11 verified Archive sources". */
export function archiveSourceCountLabel(count: number, exact: boolean): string {
  return `${exact ? "" : "at least "}${count} verified Archive source${count === 1 ? "" : "s"}`;
}
