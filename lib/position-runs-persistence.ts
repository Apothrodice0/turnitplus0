import { MAX_REPORT_SAVE_REQUEST_BYTES } from "./report-transport-limits";

/**
 * Lossless, versioned COMPACT PERSISTENCE representation of a matched-word
 * POSITION ARRAY — `unifiedSimilarity.matchedPositions` and its exclusive
 * per-channel subsets, and the report's `archiveMatchedPositions`.
 *
 * WHY: every one of those is a sorted array of word indexes, persisted as one
 * JSON number per matched word (~6-7 characters each on a long document). They
 * are the only part of `payload_json` that grows with the AMOUNT of matched
 * text: a 100,000-word document that matches at 60 % carried ~350,000
 * characters in each array, and a whole-document match of a 150,000-word
 * document put the persisted report over MAX_REPORT_SAVE_REQUEST_BYTES on the
 * positions alone — the save was refused (413) because the result was strong,
 * not because the document was large. Matched text is contiguous, so the same
 * array is a short list of runs.
 *
 * FORMAT (compact v1): `runs` is a flat list of `gap, length` pairs. Reading
 * left to right with a cursor that starts at 0, each pair is one maximal run of
 * consecutive positions: it starts `gap` words after the cursor, covers
 * `length` positions, and leaves the cursor just past its end. `count` is the
 * number of positions (the expanded array's length). So `[3,4,5,6,10]` is
 * `{ count: 5, runs: [3, 4, 3, 1] }` — a run of 4 from 3 (the cursor is then 7),
 * then, 3 words on, a run of 1.
 *
 * NOTHING IS DERIVED: the expansion is the same numbers in the same order. It
 * does not depend on the report's text, tokenizer, scoring code or any other
 * field, so a later change to any of those cannot change a stored row.
 *
 * VERIFY-THEN-COMPACT: compactPositionsForPersistence returns the compact form
 * only after proving `expand(compact(x))` is element-for-element `x` AND that it
 * is actually smaller. Anything else — an array that is not strictly ascending
 * non-negative safe integers (a client-relayed array is not trusted to be), a
 * short array the marker would outweigh — is persisted exactly as it was.
 *
 * READ SAFETY: a plain array (every pre-existing row, permanently, no
 * migration) is returned untouched. A compact value that is an unknown
 * version, malformed, non-canonical, or does not add up to its own `count` is
 * `unreadable`; the caller must FAIL CLOSED (lib/report-persistence.ts) — these
 * are the credited positions the score is made of, so they are never guessed,
 * emptied or truncated.
 *
 * PERSISTENCE-ONLY, and a WRITE GATE (lib/report-compact-persistence-flag.ts's
 * REPORT_COMPACT_POSITIONS_WRITE_ENABLED, default OFF) decides whether a writer
 * produces it. This module only encodes and decodes; it reads no flag.
 */

/** Marker shared by every compact persistence format in this codebase. A legacy position list is an array and has no `format` key. */
export const COMPACT_POSITIONS_FORMAT = "compact" as const;
export const COMPACT_POSITIONS_FORMAT_VERSION = 1 as const;

/**
 * The most positions a compact value may declare. A position is a word index
 * of the report's own text, and that text travels inside a payload capped at
 * MAX_REPORT_SAVE_REQUEST_BYTES, so no report has more words than this. It
 * bounds the work and memory a damaged row can ask a reader for; a longer
 * array is simply not compacted.
 */
export const MAX_COMPACT_POSITION_COUNT = MAX_REPORT_SAVE_REQUEST_BYTES;

export type CompactPositions = {
  format: typeof COMPACT_POSITIONS_FORMAT;
  formatVersion: typeof COMPACT_POSITIONS_FORMAT_VERSION;
  /** How many positions the runs expand to. */
  count: number;
  /** Flat `gap, length` pairs — see FORMAT above. */
  runs: number[];
};

/** What may sit where a position array is persisted: the legacy array or compact v1. */
export type PersistedPositions = number[] | CompactPositions;

export function isCompactPositions(value: unknown): value is CompactPositions {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { format?: unknown }).format === COMPACT_POSITIONS_FORMAT
  );
}

/**
 * Whether a persisted position list carries a `format` marker at all — compact
 * v1, or a later family this reader does not know. A reader hands exactly these
 * to expandPositionsFromPersistence (which expands the first and refuses the
 * second) and leaves every unmarked value — the array all earlier rows hold —
 * to the handling it always had.
 */
export function isFormatMarkedPositions(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { format?: unknown }).format !== undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Builds the compact form, or null when `positions` is not a strictly ascending list of non-negative safe integers. Does NOT verify. */
function buildCompactPositions(positions: readonly number[]): CompactPositions | null {
  const runs: number[] = [];
  let cursor = 0;
  let index = 0;
  while (index < positions.length) {
    const start = positions[index];
    // `cursor` is one past the previous run, so anything below it is a repeat or out of order.
    if (!isCount(start) || start < cursor) return null;
    let end = start;
    index += 1;
    while (index < positions.length && positions[index] === end + 1) {
      end += 1;
      index += 1;
    }
    if (!Number.isSafeInteger(end + 1)) return null;
    runs.push(start - cursor, end - start + 1);
    cursor = end + 1;
  }
  return { format: COMPACT_POSITIONS_FORMAT, formatVersion: COMPACT_POSITIONS_FORMAT_VERSION, count: positions.length, runs };
}

export type PositionsExpansion =
  | { status: "expanded"; value: number[] }
  | { status: "unreadable"; reason: string };

function expandCompactPositions(compact: CompactPositions): PositionsExpansion {
  if (compact.formatVersion !== COMPACT_POSITIONS_FORMAT_VERSION) return { status: "unreadable", reason: "UNSUPPORTED_FORMAT_VERSION" };
  const { count, runs } = compact;
  if (!isCount(count) || count > MAX_COMPACT_POSITION_COUNT || !Array.isArray(runs) || runs.length % 2 !== 0) {
    return { status: "unreadable", reason: "MALFORMED" };
  }
  // The total is settled before anything is allocated, so a damaged row can never make a reader build more than `count` positions.
  let total = 0;
  for (let pair = 0; pair < runs.length; pair += 2) {
    const gap = runs[pair];
    const length = runs[pair + 1];
    if (!isCount(gap) || !isCount(length) || length === 0) return { status: "unreadable", reason: "BAD_RUN" };
    // Two runs with nothing between them are one run: only the canonical form is ever written.
    if (pair > 0 && gap === 0) return { status: "unreadable", reason: "NON_CANONICAL" };
    total += length;
    if (total > count) return { status: "unreadable", reason: "COUNT_MISMATCH" };
  }
  if (total !== count) return { status: "unreadable", reason: "COUNT_MISMATCH" };

  const value = new Array<number>(count);
  let cursor = 0;
  let next = 0;
  for (let pair = 0; pair < runs.length; pair += 2) {
    const start = cursor + runs[pair];
    const end = start + runs[pair + 1];
    if (!Number.isSafeInteger(end)) return { status: "unreadable", reason: "BAD_RUN" };
    for (let position = start; position < end; position += 1) {
      value[next] = position;
      next += 1;
    }
    cursor = end;
  }
  return { status: "expanded", value };
}

function isElementwiseEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Returns the compact v1 form ONLY when it provably reconstructs `positions`
 * exactly and is smaller as JSON (the unit every persisted-size check uses);
 * otherwise returns `positions` itself. Never mutates, never throws, never
 * drops or reorders a position.
 */
export function compactPositionsForPersistence(positions: number[]): PersistedPositions {
  if (!Array.isArray(positions) || positions.length === 0 || positions.length > MAX_COMPACT_POSITION_COUNT) return positions;
  try {
    const compact = buildCompactPositions(positions);
    if (!compact) return positions;
    const roundTrip = expandCompactPositions(compact);
    if (roundTrip.status !== "expanded" || !isElementwiseEqual(roundTrip.value, positions)) return positions;
    return JSON.stringify(compact).length < JSON.stringify(positions).length ? compact : positions;
  } catch {
    return positions;
  }
}

/**
 * The position array a persisted value stands for. A plain array is returned
 * as it is (the legacy form — never copied, validated or reordered, exactly as
 * before this codec existed); compact v1 is expanded; a compact value that
 * cannot be expanded exactly, or any other non-array, is `unreadable`.
 */
export function expandPositionsFromPersistence(persisted: unknown): PositionsExpansion {
  if (Array.isArray(persisted)) return { status: "expanded", value: persisted as number[] };
  if (isCompactPositions(persisted)) return expandCompactPositions(persisted);
  return { status: "unreadable", reason: isFormatMarkedPositions(persisted) ? "UNSUPPORTED_FORMAT" : "MALFORMED" };
}
