import type { SimilarityReport } from "./report-types";
import {
  compactUnifiedSimilarityForPersistence,
  tryExpandUnifiedSimilarityFromPersistence,
  type PersistedUnifiedSimilarity,
} from "./unified-similarity-persistence";
import {
  compactEvidenceInterpretationForPersistence,
  expandEvidenceInterpretationFromPersistence,
  type PersistedEvidenceInterpretation,
} from "./evidence-interpretation/persistence";
import { resolveCompactPersistenceWrites, type CompactPersistenceWriteOptions } from "./report-compact-persistence-flag";

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
 * ONLY in the two codecs this file composes — never in matcher, scoring, or UI
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
 */

/** `SimilarityReport` as it may sit in `payload_json`: the same fields, but `unifiedSimilarity` and `evidenceInterpretation` may be in their compact persisted forms. */
export type PersistedSimilarityReport = Omit<SimilarityReport, "unifiedSimilarity" | "evidenceInterpretation"> & {
  unifiedSimilarity?: PersistedUnifiedSimilarity;
  evidenceInterpretation?: PersistedEvidenceInterpretation;
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
 */
export function encodeReportForPersistence(report: SimilarityReport, options?: CompactPersistenceWriteOptions): PersistedSimilarityReport {
  const compactWrites = resolveCompactPersistenceWrites(options);
  return {
    ...report,
    ...(report.unifiedSimilarity ? { unifiedSimilarity: compactUnifiedSimilarityForPersistence(report.unifiedSimilarity, { compactWrites }) } : {}),
    ...(report.evidenceInterpretation
      ? { evidenceInterpretation: compactEvidenceInterpretationForPersistence(report.evidenceInterpretation, { compactWrites }) }
      : {}),
  };
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

  if (source.unifiedSimilarity) {
    const expansion = tryExpandUnifiedSimilarityFromPersistence(source.unifiedSimilarity);
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
