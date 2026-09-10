/**
 * Evidence Interpretation Layer — report-/evidence-level public surface.
 *
 * PURE EXPLANATION over ALREADY-VERIFIED evidence. Nothing here re-runs the
 * matcher / STRICT_SPAN / FAMILY_GUARD / co-source attribution /
 * computeUnifiedSimilarity, changes a matched position or a similarity number,
 * or produces an adjusted score. Selective Corpus is ONE producer that feeds
 * this layer — see ./adapters.ts.
 */
export {
  EVIDENCE_INTERPRETATION_VERSION,
  EVIDENCE_INTERPRETATION_KINDS,
  DEFERRED_INTERNAL_KINDS,
  TONE_BY_KIND,
  KIND_PRECEDENCE,
  moreSpecificKind,
  type EvidenceInterpretationKind,
  type EvidenceInterpretationConfidence,
  type EvidenceInterpretationTone,
  type SameWorkRelationship,
} from "./kinds";

export {
  interpretVerifiedEvidence,
  type VerifiedSpan,
  type EvidenceSpanInterpretation,
  type InterpretationSourceInput,
  type InterpretationInput,
  type InterpretationResult,
} from "./interpret";

export {
  type NormalizedSourceType,
  type NormalizedEvidenceProducer,
  type NormalizedSourceLabelParts,
  type NormalizedVerifiedSource,
  type NormalizedVerifiedEvidence,
  positionsToSpans,
  sourcePositions,
  safeHostname,
} from "./normalized-evidence";

export {
  mapHistoricalMatchToSameWorkRelationship,
  SAME_WORK_RELATIONSHIP_DORMANT_FOR_HISTORICAL_EVIDENCE_V1,
} from "./same-work";

export {
  normalizeArchiveEvidence,
  normalizeScholarlyEvidence,
  normalizePriorSubmissionEvidence,
  normalizeSelectiveCorpusEvidence,
  normalizeUserSuppliedReferenceEvidence,
} from "./adapters";

export {
  buildReportEvidenceInterpretation,
  normalizeReportEvidence,
  type ReportEvidenceInterpretation,
  type ReportEvidenceSource,
  type ReportEvidenceNamedSource,
  type ReportEvidencePassage,
  type BuildReportEvidenceInterpretationOptions,
} from "./build-report-interpretation";

export {
  type ReportExtractionCompleteness,
  type ReportExtractionDiagnostic,
  unknownExtractionDiagnostic,
  extractionDiagnosticFromCounts,
  plainTextExtractionDiagnostic,
  skippedUnitCount,
  sanitizeExtractionDiagnostic,
} from "./extraction";

export {
  resolveReportCompletion,
  type ReportCompletion,
  type ReportCompletionState,
  type SelectiveCorpusBranchState,
  type UserSuppliedReferenceBranchState,
  type ResolveReportCompletionInput,
} from "./completion";
