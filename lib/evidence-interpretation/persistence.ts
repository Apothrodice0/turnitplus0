import { jsonValuesEqual } from "../json-values-equal";
import { resolveCompactPersistenceWrites, type CompactPersistenceWriteOptions } from "../report-compact-persistence-flag";
import type { EvidenceInterpretationKind } from "./kinds";
import type {
  ReportEvidenceInterpretation,
  ReportEvidenceNamedSource,
  ReportEvidencePassage,
  ReportEvidenceSource,
} from "./report-payload-types";

/**
 * C2 — lossless, versioned COMPACT PERSISTENCE representation of a report's
 * `evidenceInterpretation`.
 *
 * WHY: the interpretation is per-passage boilerplate (repeated enum strings and
 * key names, one full card object per source, and `positionsByKind` — every
 * matched word index a second time). On fragment-heavy reports it was the
 * largest single block of `payload_json` and the first thing to hit the
 * whole-report persistence ceiling (MAX_REPORT_SAVE_REQUEST_BYTES). Nothing in
 * it needs to be persisted in that shape: everything below is either kept
 * verbatim or exactly re-derivable from other kept data.
 *
 * PERSISTENCE-ONLY. The runtime / public / customer shape
 * (`ReportEvidenceInterpretation`) is unchanged. `compact…` is applied only
 * immediately before a report is serialised into `payload_json`; `expand…` only
 * immediately after `payload_json` is parsed, at the read boundaries. Every
 * consumer in between (view model, highlighter, tests) still sees the exact v1
 * shape, and no compact tuple / format marker ever reaches a customer response.
 *
 * WHAT IS KEPT VERBATIM (nothing is inferred from builder code, so a later
 * change to the builder / tokenizer / kind table cannot change a stored row):
 *   - version, matchedWordCount, deferredKindsFolded, countsByKind
 *   - every passage's wordStart / wordEnd / excerpt / source association
 *   - every distinct passage `interpretation` object ({kind, confidence, tone})
 *   - every distinct card "shape" (label, sourceType, link, doi, year and the
 *     card `interpretation`) plus each card's id / contributionPercent /
 *     matchedWords / namedSources
 *
 * WHAT IS RE-DERIVED at expansion (each is a pure function of kept data):
 *   - passage `id`        = the passage's index in `passages`
 *   - passage `sourceIds` = the kept source indexes mapped to card ids, in order
 *   - card `passageRefs`  = ids of the passages that list the card
 *   - `positionsByKind`   = the passages' [wordStart..wordEnd] ranges bucketed by
 *                           their kind (it is a disjoint partition of exactly the
 *                           passage ranges; it has no production consumer, only
 *                           reconciliation tests read it)
 *
 * VERIFY-THEN-COMPACT: `compactEvidenceInterpretationForPersistence` only
 * returns the compact form after PROVING `expand(compact(x))` deep-equals `x`.
 * Any interpretation that is not exactly representable (unknown extra fields,
 * a passage naming an unknown card, hand-built partitions, …) is persisted in
 * its ORIGINAL shape instead — never lossy, never dropped.
 *
 * READ SAFETY: the reader accepts the legacy full shape (every pre-existing row,
 * permanently, no migration) and compact v1. An unknown `format`/`formatVersion`,
 * a malformed table, or an expansion that does not reconcile with the kept
 * countsByKind is `unreadable`. The caller must then FAIL CLOSED — it must not
 * serve the report as a normal, explained one (R2: a score whose explanation was
 * persisted but cannot be reconstructed must never be shown as if it had none;
 * see tryDecodeReportFromPersistence in lib/report-persistence.ts).
 *
 * WRITE GATE (R2): compaction is an opt-in WRITE (lib/report-compact-persistence-
 * flag.ts, default OFF). This module only reads, and always reads both forms.
 */

/** Marker shared by every compact persistence format in this codebase. A legacy interpretation has no `format` key. */
export const COMPACT_PERSISTENCE_FORMAT = "compact" as const;
export const COMPACT_EVIDENCE_INTERPRETATION_FORMAT_VERSION = 1 as const;

type PassageInterpretation = ReportEvidencePassage["interpretation"];
type SourceShape = Pick<ReportEvidenceSource, "label" | "sourceType" | "link" | "doi" | "year" | "interpretation">;

/** [id, shapeIndex, contributionPercent, matchedWords, namedSources?] */
export type CompactEvidenceSourceTuple =
  | [id: string, shapeIndex: number, contributionPercent: number, matchedWords: number]
  | [id: string, shapeIndex: number, contributionPercent: number, matchedWords: number, namedSources: ReportEvidenceNamedSource[]];

/** [wordStart, wordEnd, passageInterpretationIndex, excerpt, ...sourceIndexes] */
export type CompactEvidencePassageTuple = [wordStart: number, wordEnd: number, interpretationIndex: number, excerpt: string, ...sourceIndexes: number[]];

export type CompactEvidenceInterpretation = {
  format: typeof COMPACT_PERSISTENCE_FORMAT;
  formatVersion: typeof COMPACT_EVIDENCE_INTERPRETATION_FORMAT_VERSION;
  /** ReportEvidenceInterpretation.version, verbatim (unrelated to formatVersion). */
  version: string;
  matchedWordCount: number;
  deferredKindsFolded: boolean;
  /** verbatim — its key order also fixes the key order of the re-derived positionsByKind. */
  countsByKind: ReportEvidenceInterpretation["countsByKind"];
  passageInterpretations: PassageInterpretation[];
  sourceShapes: SourceShape[];
  sources: CompactEvidenceSourceTuple[];
  passages: CompactEvidencePassageTuple[];
};

/** What may sit under `evidenceInterpretation` in a persisted row: the legacy full shape or compact v1. */
export type PersistedEvidenceInterpretation = ReportEvidenceInterpretation | CompactEvidenceInterpretation;

export function isCompactEvidenceInterpretation(value: unknown): value is CompactEvidenceInterpretation {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { format?: unknown }).format === COMPACT_PERSISTENCE_FORMAT
  );
}

// ── compact ───────────────────────────────────────────────────────────────
function internIndex(table: unknown[], seen: Map<string, number>, value: unknown): number | null {
  const key = JSON.stringify(value);
  if (key === undefined) return null;
  const existing = seen.get(key);
  if (existing !== undefined) return existing;
  const next = table.length;
  table.push(value);
  seen.set(key, next);
  return next;
}

/** Builds the compact form, or null when this interpretation is not representable. Does NOT verify. */
function buildCompact(interpretation: ReportEvidenceInterpretation): CompactEvidenceInterpretation | null {
  if (
    !interpretation ||
    typeof interpretation !== "object" ||
    !Array.isArray(interpretation.sources) ||
    !Array.isArray(interpretation.passages) ||
    typeof interpretation.version !== "string" ||
    typeof interpretation.countsByKind !== "object" ||
    interpretation.countsByKind === null
  ) {
    return null;
  }

  const sourceIndexById = new Map<string, number>();
  for (let index = 0; index < interpretation.sources.length; index += 1) {
    const id = interpretation.sources[index]?.id;
    if (typeof id !== "string" || sourceIndexById.has(id)) return null;
    sourceIndexById.set(id, index);
  }

  const passageInterpretations: PassageInterpretation[] = [];
  const passageInterpretationIndex = new Map<string, number>();
  const passages: CompactEvidencePassageTuple[] = [];
  for (let id = 0; id < interpretation.passages.length; id += 1) {
    const passage = interpretation.passages[id];
    if (!passage || passage.id !== id || !Array.isArray(passage.sourceIds) || typeof passage.excerpt !== "string") return null;
    const sourceIndexes: number[] = [];
    for (const sourceId of passage.sourceIds) {
      const sourceIndex = sourceIndexById.get(sourceId);
      if (sourceIndex === undefined) return null;
      sourceIndexes.push(sourceIndex);
    }
    const interpretationIndex = internIndex(passageInterpretations, passageInterpretationIndex, passage.interpretation);
    if (interpretationIndex === null) return null;
    passages.push([passage.wordStart, passage.wordEnd, interpretationIndex, passage.excerpt, ...sourceIndexes]);
  }

  const sourceShapes: SourceShape[] = [];
  const sourceShapeIndex = new Map<string, number>();
  const sources: CompactEvidenceSourceTuple[] = [];
  for (const card of interpretation.sources) {
    const shape: SourceShape = {
      label: card.label,
      sourceType: card.sourceType,
      link: card.link,
      doi: card.doi,
      year: card.year,
      interpretation: card.interpretation,
    };
    const shapeIndex = internIndex(sourceShapes, sourceShapeIndex, shape);
    if (shapeIndex === null) return null;
    sources.push(
      card.namedSources !== undefined
        ? [card.id, shapeIndex, card.contributionPercent, card.matchedWords, card.namedSources]
        : [card.id, shapeIndex, card.contributionPercent, card.matchedWords],
    );
  }

  return {
    format: COMPACT_PERSISTENCE_FORMAT,
    formatVersion: COMPACT_EVIDENCE_INTERPRETATION_FORMAT_VERSION,
    version: interpretation.version,
    matchedWordCount: interpretation.matchedWordCount,
    deferredKindsFolded: interpretation.deferredKindsFolded,
    countsByKind: interpretation.countsByKind,
    passageInterpretations,
    sourceShapes,
    sources,
    passages,
  };
}

/**
 * Returns the compact v1 form when — and only when — compact writes are enabled
 * AND it provably reconstructs `interpretation` exactly; otherwise returns
 * `interpretation` itself (the legacy shape, still a valid persisted form).
 * Never mutates, never throws, never drops anything.
 *
 * R2 write gate: with compact writes off (the default, see
 * lib/report-compact-persistence-flag.ts) this is the identity function, so no
 * compact interpretation is written until the fleet is known to read it.
 */
export function compactEvidenceInterpretationForPersistence(
  interpretation: ReportEvidenceInterpretation,
  options?: CompactPersistenceWriteOptions,
): PersistedEvidenceInterpretation {
  if (!resolveCompactPersistenceWrites(options)) return interpretation;
  try {
    const compact = buildCompact(interpretation);
    if (!compact) return interpretation;
    const roundTrip = expandEvidenceInterpretationFromPersistence(compact);
    if (roundTrip.status !== "expanded" || !jsonValuesEqual(roundTrip.value, interpretation)) return interpretation;
    return compact;
  } catch {
    return interpretation;
  }
}

// ── expand ────────────────────────────────────────────────────────────────
class UnreadableCompactError extends Error {}
function unreadable(reason: string): never {
  throw new UnreadableCompactError(reason);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function expandCompact(compact: CompactEvidenceInterpretation): ReportEvidenceInterpretation {
  if (compact.formatVersion !== COMPACT_EVIDENCE_INTERPRETATION_FORMAT_VERSION) unreadable("UNSUPPORTED_FORMAT_VERSION");
  if (
    typeof compact.version !== "string" ||
    typeof compact.deferredKindsFolded !== "boolean" ||
    !isSafeNonNegativeInteger(compact.matchedWordCount) ||
    typeof compact.countsByKind !== "object" ||
    compact.countsByKind === null ||
    Array.isArray(compact.countsByKind) ||
    !Array.isArray(compact.passageInterpretations) ||
    !Array.isArray(compact.sourceShapes) ||
    !Array.isArray(compact.sources) ||
    !Array.isArray(compact.passages)
  ) {
    unreadable("MALFORMED");
  }

  const kinds = Object.keys(compact.countsByKind) as EvidenceInterpretationKind[];
  const positionsByKind = Object.fromEntries(kinds.map((kind) => [kind, [] as number[]])) as Record<EvidenceInterpretationKind, number[]>;

  // 1) sources -> ids (needed to resolve passage source indexes)
  const sourceIds: string[] = [];
  for (const tuple of compact.sources as unknown[]) {
    if (!Array.isArray(tuple) || typeof tuple[0] !== "string") unreadable("MALFORMED_SOURCE");
    sourceIds.push(tuple[0]);
  }

  // 2) passages: ids, source ids, positions, and each card's passageRefs — all from kept data
  const passageRefsBySource: number[][] = sourceIds.map(() => []);
  let expandedPositionCount = 0;
  const passages: ReportEvidencePassage[] = [];
  for (let id = 0; id < compact.passages.length; id += 1) {
    const tuple = compact.passages[id];
    if (!Array.isArray(tuple) || tuple.length < 4) unreadable("MALFORMED_PASSAGE");
    const [wordStart, wordEnd, interpretationIndex, excerpt, ...sourceIndexes] = tuple;
    if (!isSafeNonNegativeInteger(wordStart) || !isSafeNonNegativeInteger(wordEnd) || wordEnd < wordStart) unreadable("MALFORMED_PASSAGE_RANGE");
    if (typeof excerpt !== "string") unreadable("MALFORMED_PASSAGE_EXCERPT");
    if (!isSafeNonNegativeInteger(interpretationIndex) || interpretationIndex >= compact.passageInterpretations.length) unreadable("BAD_PASSAGE_INTERPRETATION_INDEX");
    const passageInterpretation = compact.passageInterpretations[interpretationIndex];
    const bucket = positionsByKind[passageInterpretation?.kind as EvidenceInterpretationKind];
    if (!bucket) unreadable("UNKNOWN_PASSAGE_KIND");

    // Bounded: a corrupt range must never balloon into billions of positions.
    expandedPositionCount += wordEnd - wordStart + 1;
    if (expandedPositionCount > compact.matchedWordCount) unreadable("POSITION_OVERFLOW");
    for (let position = wordStart; position <= wordEnd; position += 1) bucket.push(position);

    const passageSourceIds: string[] = [];
    for (const sourceIndex of sourceIndexes) {
      if (!isSafeNonNegativeInteger(sourceIndex) || sourceIndex >= sourceIds.length) unreadable("BAD_PASSAGE_SOURCE_INDEX");
      passageSourceIds.push(sourceIds[sourceIndex]);
      const refs = passageRefsBySource[sourceIndex];
      if (refs[refs.length - 1] !== id) refs.push(id);
    }
    passages.push({ id, wordStart, wordEnd, excerpt, sourceIds: passageSourceIds, interpretation: passageInterpretation });
  }

  // 3) the kept counts must reconcile with what the passages re-derive
  for (const kind of kinds) {
    if (positionsByKind[kind].length !== compact.countsByKind[kind]) unreadable("COUNT_MISMATCH");
  }

  // 4) cards
  const sources: ReportEvidenceSource[] = [];
  for (let index = 0; index < compact.sources.length; index += 1) {
    const [id, shapeIndex, contributionPercent, matchedWords, namedSources] = compact.sources[index] as [
      string,
      number,
      number,
      number,
      ReportEvidenceNamedSource[]?,
    ];
    if (!isSafeNonNegativeInteger(shapeIndex) || shapeIndex >= compact.sourceShapes.length) unreadable("BAD_SOURCE_SHAPE_INDEX");
    const shape = compact.sourceShapes[shapeIndex];
    if (typeof shape !== "object" || shape === null) unreadable("MALFORMED_SOURCE_SHAPE");
    sources.push({
      id,
      label: shape.label,
      sourceType: shape.sourceType,
      link: shape.link,
      doi: shape.doi,
      year: shape.year,
      contributionPercent,
      matchedWords,
      interpretation: shape.interpretation,
      passageRefs: passageRefsBySource[index],
      ...(namedSources !== undefined ? { namedSources } : {}),
    });
  }

  return {
    version: compact.version,
    positionsByKind,
    countsByKind: compact.countsByKind,
    matchedWordCount: compact.matchedWordCount,
    sources,
    passages,
    deferredKindsFolded: compact.deferredKindsFolded,
  };
}

export type EvidenceInterpretationExpansion =
  /** compact v1 → the exact runtime shape. */
  | { status: "expanded"; value: ReportEvidenceInterpretation }
  /** not compact (every pre-existing row) — returned untouched, no copy. */
  | { status: "legacy"; value: ReportEvidenceInterpretation }
  /** compact but unknown/corrupt — the caller must NOT invent an interpretation. */
  | { status: "unreadable"; reason: string };

/**
 * The single reader for a persisted `evidenceInterpretation`. Total: never
 * throws, never mutates its input. A legacy value is a strict no-op.
 *
 * "Persisted but not decodable" is `unreadable`, never silently legacy: an
 * absent value (undefined / null) is the only "no interpretation" case. A value
 * that is not an object, or that carries a `format` marker this reader does not
 * know (a future compact family), is unreadable — it is neither a legacy
 * interpretation (which has no `format` key) nor compact v1.
 */
export function expandEvidenceInterpretationFromPersistence(persisted: unknown): EvidenceInterpretationExpansion {
  if (persisted === undefined || persisted === null) {
    return { status: "legacy", value: persisted as unknown as ReportEvidenceInterpretation };
  }
  if (typeof persisted !== "object" || Array.isArray(persisted)) return { status: "unreadable", reason: "NOT_AN_INTERPRETATION" };
  if (!isCompactEvidenceInterpretation(persisted)) {
    if ((persisted as { format?: unknown }).format !== undefined) return { status: "unreadable", reason: "UNSUPPORTED_FORMAT" };
    return { status: "legacy", value: persisted as ReportEvidenceInterpretation };
  }
  try {
    return { status: "expanded", value: expandCompact(persisted) };
  } catch (error) {
    return { status: "unreadable", reason: error instanceof UnreadableCompactError ? error.message : "EXPANSION_FAILED" };
  }
}
