import type { SimilarityReport } from "./report-types";
import {
  compactUnifiedSimilarityForPersistence,
  expandUnifiedSimilarityFromPersistence,
  type PersistedUnifiedSimilarity,
} from "./unified-similarity-persistence";
import {
  compactEvidenceInterpretationForPersistence,
  expandEvidenceInterpretationFromPersistence,
  type PersistedEvidenceInterpretation,
} from "./evidence-interpretation/persistence";

/**
 * C2 — THE report persistence boundary.
 *
 *   runtime report ──encodeReportForPersistence──▶ persisted report ──JSON.stringify──▶ payload_json
 *   payload_json ──JSON.parse──▶ persisted report ──decodeReportFromPersistence──▶ runtime report
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
 */

/** `SimilarityReport` as it may sit in `payload_json`: the same fields, but `unifiedSimilarity` and `evidenceInterpretation` may be in their compact persisted forms. */
export type PersistedSimilarityReport = Omit<SimilarityReport, "unifiedSimilarity" | "evidenceInterpretation"> & {
  unifiedSimilarity?: PersistedUnifiedSimilarity;
  evidenceInterpretation?: PersistedEvidenceInterpretation;
};

/**
 * Returns a COPY of `report` in its persisted form. Never mutates the input,
 * never throws (each codec falls back to the original shape on any doubt).
 */
export function encodeReportForPersistence(report: SimilarityReport): PersistedSimilarityReport {
  return {
    ...report,
    ...(report.unifiedSimilarity ? { unifiedSimilarity: compactUnifiedSimilarityForPersistence(report.unifiedSimilarity) } : {}),
    ...(report.evidenceInterpretation ? { evidenceInterpretation: compactEvidenceInterpretationForPersistence(report.evidenceInterpretation) } : {}),
  };
}

/**
 * Returns a COPY of a parsed `payload_json` in the exact runtime/public shape:
 * `unifiedSimilarity` fully expanded, `evidenceInterpretation` expanded, and no
 * compact marker or tuple anywhere. A legacy row (no compact form anywhere) is a
 * true no-op apart from `previousUploadPositions` normalisation, exactly as
 * before this change. Never mutates its input.
 *
 * UNKNOWN / CORRUPT compact `evidenceInterpretation` (an unsupported
 * formatVersion, a malformed table, a partition that does not reconcile with its
 * own counts) is REMOVED from the result — never guessed — and logged (reason
 * only, no report content). That is the same "no interpretation" shape a
 * pre-Report-V2 report already has.
 */
export function decodeReportFromPersistence(persisted: PersistedSimilarityReport | SimilarityReport): SimilarityReport {
  const decoded = { ...persisted } as Record<string, unknown>;
  if (persisted.unifiedSimilarity) {
    decoded.unifiedSimilarity = expandUnifiedSimilarityFromPersistence(persisted.unifiedSimilarity as PersistedUnifiedSimilarity);
  }
  if (persisted.evidenceInterpretation !== undefined) {
    const expansion = expandEvidenceInterpretationFromPersistence(persisted.evidenceInterpretation);
    if (expansion.status === "unreadable") {
      delete decoded.evidenceInterpretation;
      console.error(`persisted evidenceInterpretation is unreadable (${expansion.reason}); serving none`);
    } else {
      decoded.evidenceInterpretation = expansion.value;
    }
  }
  return decoded as unknown as SimilarityReport;
}
