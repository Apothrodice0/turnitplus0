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
import type { SuppliedReferenceVerifiedEvidence } from "@/lib/user-supplied-references";

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
  // USER-SUPPLIED REFERENCES V1 — the safe verified evidence + channel state are
  // recomputed server-side from the supplied reference TEXT (the one thing the
  // client legitimately provides, and only via the save request's
  // `userSuppliedReferences` sibling — never inside `payload`). Any in-payload
  // copy of the input array or the verified output is dropped here.
  "userSuppliedReferenceEvidence",
  "userSuppliedReferenceChannel",
  "userSuppliedReferences",
  // V1.1 — the internal carry-forward guard is server-set only; a client value
  // here is dropped (and it is stripped again from every outbound response).
  "userSuppliedReferenceGuard",
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
  /**
   * USER-SUPPLIED REFERENCES V1 — the SERVER-VERIFIED per-reference evidence
   * (lib/user-supplied-references.ts). The caller passes ALL references (so the
   * failed ones ride onto the report for completeness/UI); only the ADMITTED
   * ones with real verified passages feed the interpretation + the position
   * partition. A client-authored value is never accepted here.
   */
  userSuppliedReferenceEvidence?: readonly SuppliedReferenceVerifiedEvidence[] | null;
  userSuppliedReferenceChannel?: SimilarityReport["userSuppliedReferenceChannel"] | null;
  /** V1.1 — the internal carry-forward guard to stamp onto the output (server-set only). */
  userSuppliedReferenceGuard?: SimilarityReport["userSuppliedReferenceGuard"] | null;
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

  // USER-SUPPLIED REFERENCES V1 — the SERVER-VERIFIED evidence, or (when the
  // caller passed none) whatever the base report already carried (GET recompute
  // re-passes the persisted value; a POST always passes the fresh verification).
  const referenceEvidence: readonly SuppliedReferenceVerifiedEvidence[] =
    opts.userSuppliedReferenceEvidence ?? base.userSuppliedReferenceEvidence ?? [];
  const referenceChannel = opts.userSuppliedReferenceChannel ?? base.userSuppliedReferenceChannel ?? null;
  const admittedReferences = referenceEvidence
    .filter((r) => r.admitted && (r.verifiedPassages?.length ?? 0) > 0)
    .map((r) => ({ key: r.key, safeLabel: r.safeLabel, verifiedPassages: r.verifiedPassages }));

  const evidenceInterpretation = buildReportEvidenceInterpretation(base as SimilarityReport, {
    historicalSubmissionMatch: opts.historicalSubmissionMatch,
    selectiveCorpusAdmittedSources: opts.selectiveCorpusAdmittedSources,
    userSuppliedReferences: admittedReferences,
  });

  const reportCompletion = resolveReportCompletion({
    // Only claim the academic branch ran if the report actually carries its
    // status (COMPLETE_*/FAILED). Absent -> null (not run / not configured).
    academicSearch: report.academicEvidenceStatus ?? null,
    selectiveCorpus: opts.selectiveCorpusBranch ?? null,
    extraction: extractionDiagnostic,
    unverifiedCandidateCount: opts.unverifiedCandidateCount ?? 0,
    userSuppliedReference: referenceChannel ? referenceChannel.state : null,
    verifiedSimilarityPercent: primarySimilarityScore(report),
  });

  // The guard is SERVER-SET ONLY (it is on the strip list, so `base` never
  // carries one). The POST resave path and the GET recompute both pass the
  // resolved guard through `opts`.
  const referenceGuard = opts.userSuppliedReferenceGuard ?? null;

  return {
    ...(base as T),
    evidenceInterpretation,
    reportCompletion,
    extractionDiagnostic,
    ...(referenceEvidence.length > 0 ? { userSuppliedReferenceEvidence: [...referenceEvidence] } : {}),
    ...(referenceChannel ? { userSuppliedReferenceChannel: referenceChannel } : {}),
    ...(referenceGuard && referenceEvidence.length > 0 ? { userSuppliedReferenceGuard: referenceGuard } : {}),
  };
}

/**
 * AUTHORITATIVE PROMOTION — refreshes ONLY reportCompletion's selectiveCorpus
 * signal from the report's own persisted selectiveCorpusAuthoritativeStatus.
 * Called at RESPONSE time (GET / SSR first paint), never at write time: the
 * deferred finalizer's own CAS-guarded terminal write
 * (persistSelectiveCorpusAuthoritativeFinalization) deliberately touches only
 * unifiedSimilarity / its own generation+flag snapshot / the status marker
 * itself — never reportCompletion/evidenceInterpretation — so a report's
 * persisted reportCompletion still reflects whatever selectiveCorpusBranch
 * was true at the ORIGINAL pending-branch save (always null there, since the
 * search had not run yet). This is the one place that goes stale without a
 * response-time refresh; nothing else about reportCompletion needs one.
 *
 * PURE, no DB access, no score/matched-position change. Every other input is
 * read straight off the report's own already-persisted fields — the SAME
 * primary sources withEvidenceInterpretation itself reads (academicEvidenceStatus,
 * extractionDiagnostic, userSuppliedReferenceChannel, primarySimilarityScore)
 * — so this reproduces exactly what a fresh withEvidenceInterpretation call
 * would have computed had the real terminal selectiveCorpusBranch been known
 * at save time, without re-deriving evidenceInterpretation or touching
 * anything score-related. unverifiedCandidateCount has no such primary field
 * on SimilarityReport (see ReportEvidenceInterpretationWiringOptions's own
 * comment on it), so it is the one signal carried forward from the already-
 * persisted reportCompletion.signals — the exact value that produced it.
 *
 * No-op when there is no persisted reportCompletion to refresh (a pre-Report-V2
 * report), when the marker is absent (historical/non-authoritative — never
 * touched), still "pending" (no terminal branch to report yet — the
 * customer-facing similarityStatus="pending" mechanism is what matters there),
 * or when the signal is already correct.
 */
export function refreshSelectiveCorpusCompletionSignal(report: SimilarityReport): void {
  if (!report.reportCompletion) return;
  const selectiveCorpusBranch: SelectiveCorpusBranchState | null =
    report.selectiveCorpusAuthoritativeStatus === "completed"
      ? "COMPLETED"
      : report.selectiveCorpusAuthoritativeStatus === "incomplete"
        ? "PARTIAL"
        : null;
  if (selectiveCorpusBranch === null) return;
  if (report.reportCompletion.signals.selectiveCorpus === selectiveCorpusBranch) return;
  report.reportCompletion = resolveReportCompletion({
    academicSearch: report.academicEvidenceStatus ?? null,
    selectiveCorpus: selectiveCorpusBranch,
    extraction: report.extractionDiagnostic ?? unknownExtractionDiagnostic(),
    unverifiedCandidateCount: report.reportCompletion.signals.unverifiedCandidateCount,
    userSuppliedReference: report.userSuppliedReferenceChannel ? report.userSuppliedReferenceChannel.state : null,
    verifiedSimilarityPercent: primarySimilarityScore(report),
  });
}
