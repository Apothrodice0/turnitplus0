import type { SimilarityReport, ReportHistoricalSubmissionMatch } from "@/lib/report-types";
import { primarySimilarityScore } from "@/lib/report-types";
import {
  buildReportEvidenceInterpretation,
  resolveReportCompletion,
  unknownExtractionDiagnostic,
  type SelectiveCorpusBranchState,
  type ReportExtractionDiagnostic,
  type BuildReportEvidenceInterpretationOptions,
} from "@/lib/evidence-interpretation";

/**
 * Report V2 wiring — turn the already-FINAL authoritative SimilarityReport into
 * its additive `evidenceInterpretation` / `reportCompletion` / `extractionDiagnostic`
 * fields.
 *
 * PURE. EXPLANATION ONLY. This never participates in scoring: it reads the
 * authoritative `unifiedSimilarity` / `archiveMatchedPositions` /
 * server-verified `externalAcademicEvidence` / text the pipeline already
 * finalised and produces a disjoint interpretation partition of exactly those
 * matched positions. It changes no matched position and no similarity number.
 *
 * SERVER AUTHORITY: on save / recompute, the server calls this with its OWN
 * final report (and, where it has it, `historicalSubmissionMatch`) and
 * OVERWRITES whatever the client sent. `stripClientEvidenceInterpretation`
 * removes any client-supplied value first — the same trust boundary
 * `externalAcademicEvidence` gets (client value dropped, server value forced).
 *
 * POSSIBLE_SAME_WORK stays dormant for historical evidence — see
 * lib/evidence-interpretation/same-work.ts. No text/account/device heuristic.
 */

export const CLIENT_UNTRUSTED_EVIDENCE_INTERPRETATION_KEYS = [
  "evidenceInterpretation",
  "reportCompletion",
  "extractionDiagnostic",
] as const;

/** Drop any client-supplied interpretation/completion/extraction values so the
 *  server value is the only one that can survive a save. Returns a shallow copy. */
export function stripClientEvidenceInterpretation<T extends Partial<SimilarityReport>>(report: T): T {
  const copy: T = { ...report };
  for (const k of CLIENT_UNTRUSTED_EVIDENCE_INTERPRETATION_KEYS) {
    delete (copy as Record<string, unknown>)[k];
  }
  return copy;
}

export type ReportEvidenceInterpretationWiringOptions = {
  /** admin-gated on the ordinary GET — a server caller that still has it passes
   *  it. Same-work is dormant regardless, so this only affects nothing today,
   *  but it is threaded for the future explicit-version signal. */
  historicalSubmissionMatch?: ReportHistoricalSubmissionMatch | null;
  /** Selective Corpus branch state — pass `null` (the default) when that branch
   *  did NOT run as a report search (it is a flag-OFF shadow today). Pass
   *  "PARTIAL"/"COMPLETED" only when it is genuinely a configured report branch. */
  selectiveCorpusBranch?: SelectiveCorpusBranchState | null;
  /** candidate sources identified but whose text could not be verified. 0 until
   *  a real signal is threaded (retrieval diagnostics are server-only today). */
  unverifiedCandidateCount?: number;
  /** a SERVER-TRUSTED extraction diagnostic, when one exists. Absent -> UNKNOWN
   *  (never inferred to EXTRACTION_PARTIAL). A client-supplied value is ignored. */
  serverExtractionDiagnostic?: ReportExtractionDiagnostic | null;
  /** Selective Corpus admitted-source spans when that channel is a real report
   *  evidence producer (not on SimilarityReport today). */
  selectiveCorpusAdmittedSources?: BuildReportEvidenceInterpretationOptions["selectiveCorpusAdmittedSources"];
};

/**
 * Returns a shallow copy of `report` with `evidenceInterpretation`,
 * `reportCompletion` and `extractionDiagnostic` set from server-known evidence.
 * Any pre-existing (client) value is replaced.
 */
export function withEvidenceInterpretation<T extends SimilarityReport>(
  report: T,
  opts: ReportEvidenceInterpretationWiringOptions = {},
): T {
  const base = stripClientEvidenceInterpretation(report);

  const extractionDiagnostic: ReportExtractionDiagnostic =
    opts.serverExtractionDiagnostic ?? unknownExtractionDiagnostic();

  const evidenceInterpretation = buildReportEvidenceInterpretation(base as SimilarityReport, {
    historicalSubmissionMatch: opts.historicalSubmissionMatch,
    selectiveCorpusAdmittedSources: opts.selectiveCorpusAdmittedSources,
  });

  const reportCompletion = resolveReportCompletion({
    // Only claim the academic branch ran if the report actually carries its
    // status (COMPLETE_*/FAILED). Absent -> null (not run / not configured).
    academicSearch: report.academicEvidenceStatus ?? null,
    selectiveCorpus: opts.selectiveCorpusBranch ?? null,
    extraction: extractionDiagnostic,
    unverifiedCandidateCount: opts.unverifiedCandidateCount ?? 0,
    verifiedSimilarityPercent: primarySimilarityScore(report),
  });

  return {
    ...(base as T),
    evidenceInterpretation,
    reportCompletion,
    extractionDiagnostic,
  };
}
