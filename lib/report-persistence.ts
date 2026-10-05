import type { SimilarityReport } from "./report-types";
import {
  compactUnifiedSimilarityForPersistence,
  tryExpandUnifiedSimilarityFromPersistence,
  POSITION_ARRAY_KEYS,
  type PersistedUnifiedSimilarity,
} from "./unified-similarity-persistence";
import {
  compactEvidenceInterpretationForPersistence,
  expandEvidenceInterpretationFromPersistence,
  type PersistedEvidenceInterpretation,
} from "./evidence-interpretation/persistence";
import { resolveCompactPersistenceWrites, resolveCompactPositionWrites, type CompactPersistenceWriteOptions } from "./report-compact-persistence-flag";
import {
  compactPositionsForPersistence,
  expandPositionsFromPersistence,
  isFormatMarkedPositions,
  type PersistedPositions,
} from "./position-runs-persistence";
import { persistedPayloadSize } from "./report-transport-limits";

/**
 * C2 — THE report persistence boundary.
 *
 *   runtime report ──encodeReportForPersistence──▶ persisted report ──JSON.stringify──▶ payload_json
 *   payload_json ──JSON.parse──▶ persisted report ──tryDecodeReportFromPersistence──▶ runtime report
 *
 * Every size check that decides whether a report may be persisted measures the
 * ENCODED form (what actually lands in `payload_json`), and every reader that
 * hands a stored report to anything that understands the public shape (GET,
 * SSR first paint, admin readers) decodes it first. Compaction knowledge lives
 * ONLY in the codecs this file composes — never in matcher, scoring, or UI
 * code — so the customer-facing report is unaware persistence is compact.
 *
 * Both codecs are lossless and versioned; both accept every legacy row
 * (uncompressed `contributions` array, full `evidenceInterpretation`)
 * permanently, so no migration exists or is needed. Encoding never drops an
 * interpretation: anything not exactly representable is persisted in its
 * original shape and, if that is too large, the CALLER's size check rejects the
 * whole report — a persisted score is never separated from its explanation.
 *
 * R2 — TWO SAFETY PROPERTIES ON TOP OF THAT:
 *
 *  1. READS FAIL CLOSED. A persisted `evidenceInterpretation` that cannot be
 *     decoded (an unsupported compact version, a corrupt table) used to be
 *     silently removed, so GET / SSR / admin served the score with no cards and
 *     no highlights as if the report had never been explained. The decoder now
 *     returns a structured failure instead, and every reader must refuse to serve
 *     the report as a normal one. "Interpretation absent" (a legacy / pre-Report-V2
 *     row) stays a valid, distinct case.
 *  2. COMPACT WRITES ARE A ROLLOUT GATE. Encoding only produces compact forms when
 *     REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED is "true" (default OFF) — see
 *     lib/report-compact-persistence-flag.ts. DECODING always understands both
 *     forms, whatever the flag says.
 *
 * COMPACT POSITIONS — a third lossless, versioned encoding at this same boundary
 * (lib/position-runs-persistence.ts), under its own write gate
 * (REPORT_COMPACT_POSITIONS_WRITE_ENABLED, default OFF): the matched-word
 * position arrays — `unifiedSimilarity`'s, and the report's own
 * `archiveMatchedPositions` — persisted as exact run-length ranges instead of
 * one number per matched word, so the persisted size no longer grows with how
 * much of the document matched. Decoding returns the identical arrays. A compact
 * position list that cannot be expanded exactly makes the report unreadable for
 * EVERY viewer: those positions are the credited evidence itself, so there is no
 * "serve it without them" outcome. Because readers are still sent the expanded
 * arrays, a report the ranges alone would admit must also be servable — see
 * MAX_SERVED_REPORT_BYTES / encodeReportJsonForPersistence.
 */

/** `SimilarityReport` as it may sit in `payload_json`: the same fields, but `unifiedSimilarity`, `evidenceInterpretation` and `archiveMatchedPositions` may be in their compact persisted forms. */
export type PersistedSimilarityReport = Omit<SimilarityReport, "unifiedSimilarity" | "evidenceInterpretation" | "archiveMatchedPositions"> & {
  unifiedSimilarity?: PersistedUnifiedSimilarity;
  evidenceInterpretation?: PersistedEvidenceInterpretation;
  archiveMatchedPositions?: PersistedPositions;
};

/**
 * Returns a COPY of `report` in its persisted form. Never mutates the input,
 * never throws (each codec falls back to the original shape on any doubt).
 *
 * The compact forms are produced only when compact writes are enabled (R2 write
 * gate, default OFF); otherwise the report is persisted in the legacy shape —
 * `contributions` as the plain array, `evidenceInterpretation` in full — plus the
 * older, already-shipped `previousUploadPositions` elision. Pass `compactWrites`
 * to pin the mode (a caller that measures and then writes resolves it once).
 *
 * Independently, when compact POSITION writes are enabled (their own gate,
 * default OFF; `compactPositions` pins it) the position arrays are persisted as
 * run-length ranges: `unifiedSimilarity`'s through its codec, and
 * `archiveMatchedPositions` here. Only a real array is ever replaced, and only
 * by a form proven to expand back to it.
 */
export function encodeReportForPersistence(report: SimilarityReport, options?: CompactPersistenceWriteOptions): PersistedSimilarityReport {
  const compactWrites = resolveCompactPersistenceWrites(options);
  const compactPositions = resolveCompactPositionWrites(options);
  return {
    ...report,
    ...(report.unifiedSimilarity
      ? { unifiedSimilarity: compactUnifiedSimilarityForPersistence(report.unifiedSimilarity, { compactWrites, compactPositions }) }
      : {}),
    ...(report.evidenceInterpretation
      ? { evidenceInterpretation: compactEvidenceInterpretationForPersistence(report.evidenceInterpretation, { compactWrites }) }
      : {}),
    ...(compactPositions && Array.isArray(report.archiveMatchedPositions)
      ? { archiveMatchedPositions: compactPositionsForPersistence(report.archiveMatchedPositions) }
      : {}),
  };
}

/**
 * COMPACT POSITIONS SERVING BOUND — the most a report admitted ONLY because its
 * positions are stored as ranges may weigh when it is SERVED: the decoded report,
 * which is what GET and the SSR first paint send, in UTF-8 bytes.
 *
 * With arrays, the persisted ceiling also bounded what a reader is sent: GET and
 * SSR re-expand the position lists (and the interpretation's positionsByKind), and
 * an admitted report was served at ~4 MB at most. Ranges cut that link — a
 * 200,000-word exact resubmission stores at ~1.4 MB but is served at ~5.2 MB, past
 * the 4.5 MB response-body limit Vercel documents for a function response that is
 * not streamed. Until serving is shown not to be bound by that limit, such a report
 * is refused exactly as it was before ranges (413), never saved and then
 * unopenable. A report whose ARRAY form fits the persisted ceiling is never subject
 * to this: it was accepted before ranges existed, and still is.
 */
export const MAX_SERVED_REPORT_BYTES = 4_000_000;

/** UTF-8 bytes of `report` as a reader is sent it (its decoded, runtime shape). Server-only. */
export function servedReportBytes(report: SimilarityReport): number {
  return Buffer.byteLength(JSON.stringify(report), "utf8");
}

/**
 * THE `payload_json` text for `report`, for a writer that then checks it against
 * `ceiling` (app/api/reports/route.ts's persisted-size checks): exactly
 * `JSON.stringify(encodeReportForPersistence(report))`, except for the one report
 * compact positions would newly admit while it cannot be served within
 * MAX_SERVED_REPORT_BYTES — for that one the ARRAY form is returned, which is over
 * `ceiling`, so the caller's existing check refuses it (413) as it always did.
 * Nothing the array form admits is ever refused, and with compact position writes
 * off this is the plain encoding.
 */
export function encodeReportJsonForPersistence(report: SimilarityReport, options: CompactPersistenceWriteOptions & { ceiling: number }): string {
  const compactWrites = resolveCompactPersistenceWrites(options);
  const compactPositions = resolveCompactPositionWrites(options);
  const json = JSON.stringify(encodeReportForPersistence(report, { compactWrites, compactPositions }));
  if (!compactPositions || persistedPayloadSize(json) > options.ceiling) return json;
  const arrays = JSON.stringify(encodeReportForPersistence(report, { compactWrites, compactPositions: false }));
  if (persistedPayloadSize(arrays) <= options.ceiling) return json;
  return servedReportBytes(report) <= MAX_SERVED_REPORT_BYTES ? json : arrays;
}

/**
 * SQL test, on the stored payload column `payloadColumn`, for "this row holds at least one compact position list" — the
 * only rows storedRowExceedsServingBound below can say yes for. Lets a writer skip reading back the payload of every other
 * row (everything written with the compact-positions gate OFF).
 */
export function storesCompactPositionsSql(payloadColumn: string): string {
  const paths = ["$.archiveMatchedPositions", ...POSITION_ARRAY_KEYS.map((key) => `$.unifiedSimilarity.${key}`)];
  return `(${paths.map((p) => `json_type(${payloadColumn}, '${p}') = 'object'`).join(" OR ")})`;
}

/**
 * COMPACT POSITIONS SERVING BOUND for a write that MERGES into a row that is already stored — an AI result: the AI-result
 * route (app/api/reports/[id]/ai-retry/route.ts), and POST /api/reports' merge onto a report the Selective Corpus finalizer
 * made terminal. `payloadJson` is the row exactly as that write would leave it.
 *
 * True when that row is one only its compact position lists admit — written out with its position lists as arrays it would
 * be over `ceiling` — AND the report a reader is sent would be over MAX_SERVED_REPORT_BYTES. It is the rule
 * encodeReportJsonForPersistence applies when a report is written whole, applied to the merged row, so attaching an AI
 * result can never turn a report that was served within the bound into one that is not (that is how a report served at
 * ~3.77 MB became ~4.06 MB). A row with no compact position list — every row written with the gate OFF — is never subject
 * to it, exactly as before ranges.
 *
 * The array form is the stored text with each compact list replaced by the array it stands for, measured in the persisted
 * unit; the served size is servedReportBytes of the decoded row, the same measure the writers use. Never throws: a row that
 * cannot be parsed or decoded is not this check's to judge — every reader refuses it on its own.
 */
export function storedRowExceedsServingBound(payloadJson: string, ceiling: number): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const row = parsed as { archiveMatchedPositions?: unknown; unifiedSimilarity?: Record<string, unknown> };
  const unified = typeof row.unifiedSimilarity === "object" && row.unifiedSimilarity !== null ? row.unifiedSimilarity : {};
  const compactLists = [row.archiveMatchedPositions, ...POSITION_ARRAY_KEYS.map((key) => unified[key])].filter(isFormatMarkedPositions);
  if (compactLists.length === 0) return false;
  let arrayFormUnits = persistedPayloadSize(payloadJson);
  for (const list of compactLists) {
    const expansion = expandPositionsFromPersistence(list);
    if (expansion.status !== "expanded") return false;
    arrayFormUnits += JSON.stringify(expansion.value).length - JSON.stringify(list).length;
  }
  if (arrayFormUnits <= ceiling) return false;
  const decoded = tryDecodeReportFromPersistence(parsed);
  return decoded.ok && servedReportBytes(decoded.report) > MAX_SERVED_REPORT_BYTES;
}

/**
 * Bounded, customer-content-free reasons a persisted report cannot be decoded
 * safely. Deliberately coarse: enough for an operator to tell "this instance is
 * older than the writer" from "this row is damaged", never a decoder internal.
 */
export type ReportPersistenceFailureReason =
  /** a compact form whose `format` / `formatVersion` this reader does not support (typically a newer writer during a rolling deploy) */
  | "unsupported_compact_format"
  /** a persisted `evidenceInterpretation` that is malformed or does not reconcile with its own counts */
  | "corrupt_evidence_interpretation"
  /** `unifiedSimilarity.contributions` (admin/internal diagnostics) that is malformed — only fatal when the viewer receives contributions */
  | "corrupt_contributions"
  /** a compact matched-position list (`unifiedSimilarity`'s, or `archiveMatchedPositions`) that is malformed or does not add up to its own count — fatal for every viewer */
  | "corrupt_matched_positions"
  /** the parsed payload is not even a JSON object */
  | "invalid_persisted_report";

export type ReportDecodeOptions = {
  /**
   * Whether this reader will SERVE `unifiedSimilarity.contributions`. Default `true`
   * (fail closed). Contributions are admin/internal diagnostics — the customer
   * explanation is `evidenceInterpretation` — so a reader that strips them for
   * non-admins anyway passes `false` and a damaged `contributions` no longer makes
   * a customer report unavailable (it is replaced by `[]`, the value a non-admin
   * receives regardless). A reader that DOES serve them (an admin session, the
   * developer inspector) must leave this `true`: it then gets a failure rather than
   * a fabricated `[]` presented as "no contributions".
   */
  requireContributions?: boolean;
};

export type ReportDecodeResult =
  | { ok: true; report: SimilarityReport }
  | { ok: false; reason: ReportPersistenceFailureReason };

/** Thrown by the strict decoder / admin readers. `reason` is a bounded value, safe to log; the message carries nothing else. */
export class ReportPersistenceDecodeError extends Error {
  readonly reason: ReportPersistenceFailureReason;
  constructor(reason: ReportPersistenceFailureReason) {
    super(`persisted report cannot be decoded safely (${reason})`);
    this.name = "ReportPersistenceDecodeError";
    this.reason = reason;
  }
}

/** The closed shape of the one server-side log line a decode problem produces — no report content, ids, text or provenance can be expressed by it. */
type ReportPersistenceUnreadableEvent = {
  event: "report_persistence_unreadable";
  reason: ReportPersistenceFailureReason;
  /** the decoder's own enumerated code (e.g. UNSUPPORTED_FORMAT_VERSION, COUNT_MISMATCH) */
  detail: string;
  outcome: "refused" | "served_without_contributions";
};

const DECODER_DETAIL_PATTERN = /^[A-Z][A-Z_]{0,47}$/;

function logUnreadable(reason: ReportPersistenceFailureReason, detail: string, outcome: ReportPersistenceUnreadableEvent["outcome"]): void {
  try {
    const event: ReportPersistenceUnreadableEvent = {
      event: "report_persistence_unreadable",
      reason,
      detail: DECODER_DETAIL_PATTERN.test(detail) ? detail : "UNKNOWN",
      outcome,
    };
    console.error(JSON.stringify(event));
  } catch {
    // Best-effort observation only; never interrupts the read.
  }
}

const isUnsupportedFormat = (detail: string): boolean => detail.startsWith("UNSUPPORTED_FORMAT");

/** The one refusal a position list that cannot be expanded produces, logged like every other (decoder code only, never content). */
function refuseUnreadablePositions(detail: string): { ok: false; reason: ReportPersistenceFailureReason } {
  const reason: ReportPersistenceFailureReason = isUnsupportedFormat(detail) ? "unsupported_compact_format" : "corrupt_matched_positions";
  logUnreadable(reason, detail, "refused");
  return { ok: false, reason };
}

/**
 * A stored `archiveMatchedPositions` as the array it stands for. A value with no
 * `format` marker — the array every earlier row holds, or nothing — is left
 * exactly as it is (`expanded: false`); the compact form is expanded; one that
 * cannot be expanded exactly is refused.
 */
function expandArchiveMatchedPositions(
  stored: unknown,
): { ok: true; expanded: false } | { ok: true; expanded: true; value: number[] } | { ok: false; reason: ReportPersistenceFailureReason } {
  if (!isFormatMarkedPositions(stored)) return { ok: true, expanded: false };
  const expansion = expandPositionsFromPersistence(stored);
  return expansion.status === "unreadable" ? refuseUnreadablePositions(expansion.reason) : { ok: true, expanded: true, value: expansion.value };
}

/**
 * `archiveMatchedPositions` of a parsed `payload_json`, as the array every
 * scorer takes. For the internal readers that feed a stored report's own fields
 * straight back into scoring without decoding the whole report (the deferred
 * Selective Corpus finalizer, the self-heal): the same rule as the decoder
 * below, except that a value that cannot be expanded THROWS
 * (ReportPersistenceDecodeError), so the caller's existing failure handling
 * leaves the row untouched instead of scoring it without its archive evidence.
 */
export function readPersistedArchiveMatchedPositions(persisted: { archiveMatchedPositions?: unknown }): number[] | undefined {
  const expansion = expandArchiveMatchedPositions(persisted.archiveMatchedPositions);
  if (!expansion.ok) throw new ReportPersistenceDecodeError(expansion.reason);
  return expansion.expanded ? expansion.value : (persisted.archiveMatchedPositions as number[] | undefined);
}

/**
 * Decodes a parsed `payload_json` to the exact runtime/public shape —
 * `unifiedSimilarity` fully expanded, `evidenceInterpretation` expanded, and no
 * compact marker or tuple anywhere — or reports, structurally, that it cannot be
 * done SAFELY. Never throws for a malformed payload; never mutates its input. A
 * legacy row (no compact form anywhere) is a true no-op apart from
 * `previousUploadPositions` normalisation, exactly as before this change.
 *
 * `ok: false` means: DO NOT serve this report as a normal report. There is no
 * "decode what you can and continue" outcome for the customer-visible
 * explanation: a score whose persisted interpretation cannot be reconstructed is
 * never returned without it, the interpretation is never removed to make the
 * decode succeed, and nothing is recomputed. (Every failure is logged, reason
 * only — see ReportPersistenceUnreadableEvent.)
 */
export function tryDecodeReportFromPersistence(persisted: unknown, options: ReportDecodeOptions = {}): ReportDecodeResult {
  const requireContributions = options.requireContributions ?? true;
  if (typeof persisted !== "object" || persisted === null || Array.isArray(persisted)) {
    logUnreadable("invalid_persisted_report", "NOT_AN_OBJECT", "refused");
    return { ok: false, reason: "invalid_persisted_report" };
  }
  const source = persisted as PersistedSimilarityReport;
  const decoded = { ...source } as Record<string, unknown>;

  // The customer-visible explanation first: it decides whether the report may be served at all.
  if (source.evidenceInterpretation !== undefined) {
    const expansion = expandEvidenceInterpretationFromPersistence(source.evidenceInterpretation);
    if (expansion.status === "unreadable") {
      const reason: ReportPersistenceFailureReason = isUnsupportedFormat(expansion.reason) ? "unsupported_compact_format" : "corrupt_evidence_interpretation";
      logUnreadable(reason, expansion.reason, "refused");
      return { ok: false, reason };
    }
    decoded.evidenceInterpretation = expansion.value;
  }

  // The credited positions next: like the explanation, a report is never served with them missing, short or guessed.
  const archivePositions = expandArchiveMatchedPositions(source.archiveMatchedPositions);
  if (!archivePositions.ok) return archivePositions;
  if (archivePositions.expanded) decoded.archiveMatchedPositions = archivePositions.value;

  if (source.unifiedSimilarity) {
    const expansion = tryExpandUnifiedSimilarityFromPersistence(source.unifiedSimilarity);
    if (expansion.status === "positions-unreadable") return refuseUnreadablePositions(expansion.reason);
    decoded.unifiedSimilarity = expansion.value;
    if (expansion.status === "contributions-unreadable") {
      const reason: ReportPersistenceFailureReason = isUnsupportedFormat(expansion.reason) ? "unsupported_compact_format" : "corrupt_contributions";
      if (requireContributions) {
        logUnreadable(reason, expansion.reason, "refused");
        return { ok: false, reason };
      }
      // Customer-safe: the explanation above is intact and the reader never serves contributions (`[]` is what it sends anyway).
      logUnreadable(reason, expansion.reason, "served_without_contributions");
    }
  }

  return { ok: true, report: decoded as unknown as SimilarityReport };
}

/**
 * STRICT decode: the report, or a thrown ReportPersistenceDecodeError. For callers
 * (scripts, tests, internal readers) that cannot serve a fallback — an unreadable
 * report can never be obtained by accident, unlike the pre-R2 decoder that returned
 * a report with the interpretation silently removed. Defaults to
 * `requireContributions: true`.
 */
export function decodeReportFromPersistence(persisted: PersistedSimilarityReport | SimilarityReport, options?: ReportDecodeOptions): SimilarityReport {
  const result = tryDecodeReportFromPersistence(persisted, options);
  if (!result.ok) throw new ReportPersistenceDecodeError(result.reason);
  return result.report;
}

/**
 * R2 — whether a report's CUSTOMER-visible explanation can be decoded, judged from ONLY the
 * serialized `evidenceInterpretation` value rather than the whole `payload_json`.
 *
 * For a reader that must decide "may this report's score be shown as a normal, explained
 * one?" but deliberately never loads the report body — the room occupant poll
 * (lib/reports-repo.ts's findRoomOccupant, every few seconds, scalars through SQL
 * json_extract). It re-implements NO decoding rule: the value is handed to
 * tryDecodeReportFromPersistence, the very function owner GET and the SSR report page call,
 * with the same customer options (`requireContributions: false` — a room summary never serves
 * contributions, so admin-only contributions damage stays moot here exactly as it does for a
 * non-admin GET). The two can therefore never disagree about the interpretation.
 *
 * `interpretationJson` is the JSON text of `$.evidenceInterpretation`, or `null` when the
 * caller has established that nothing was persisted that could fail to decode — absent, JSON
 * null, or a plain legacy object with no `format` key, i.e. exactly what
 * expandEvidenceInterpretationFromPersistence returns untouched. A caller must over-supply,
 * never under-supply: anything that MIGHT be undecodable (a compact form, an unknown `format`,
 * a non-object) has to be passed in. A failure is logged by the decoder (reason only, never
 * content), like every other read.
 */
export function isEvidenceInterpretationCustomerReadable(interpretationJson: string | null): boolean {
  if (interpretationJson === null) return true;
  let interpretation: unknown;
  try {
    interpretation = JSON.parse(interpretationJson);
  } catch {
    logUnreadable("corrupt_evidence_interpretation", "NOT_JSON", "refused");
    return false;
  }
  return tryDecodeReportFromPersistence({ evidenceInterpretation: interpretation }, { requireContributions: false }).ok;
}
